/**
 * 世界书建议的生成与生命周期：手动生成、自动建议、切换聊天。
 * 自动建议默认关闭；打开后每隔 N 个新的 AI 楼层，在正文生成结束后运行一次。安静生成、代写、试运行和切换聊天不触发；
 * 有待审核的建议时暂停，不堆积新的请求；失败不自动重试（再新增 N 个 AI 楼层后才会再运行）。
 * 所有建议都要用户在世界书页确认后才写入。
 */
import { reactive } from 'vue';
import { requestCompletion } from '@/api/client';
import { ApiError, apiFailure, describeFailure, looksLikeUnfinishedJson } from '@/api/errors';
import { engineActiveHere } from '@/api/settings';
import { getContext, type STContext } from '@/st/context';
import { toast } from '@/st/toast';
import { isDeepSeekModel } from '@/memory/prompts';
import { messageHash } from '@/notes/source';
import { resolveWorldbookChannel, worldbookApiPath, worldbookSettings } from './settings';
import { hostApiIssue, loadBook, refreshWorldHost, worldHost, type BookBindings } from './host';
import { commitBatch, loadWorldbookData, setCursor, worldbookState, worldbookWriteIssue } from './store';
import { captureChat, makeRange, newAiFloors, planRead, rangeCurrent, sameChat, totalAiFloors } from './source';
import { buildWorldbookContext, type BookSnapshot, type ContextStats } from './context';
import { parseWorldbookReply, WorldbookProtocolError } from './protocol';
import { missingBookMessage, writerState } from './writer';
import type { DroppedAction, SuggestionBatch } from './types';

export const worldbookRun = reactive({
  busy: false,
  /** 正在运行的是自动建议。 */
  auto: false,
  /** 已收到的回复字数（流式输出时）。 */
  received: 0,
  status: '',
  error: '',
  errorDetail: '',
  /** 正文正在生成，这期间不能生成建议。 */
  storyBusy: false,
  /** 自动建议没有运行或没有完成的原因。 */
  autoNote: '',
  lastStats: null as ContextStats | null,
  /** 最近一次生成中被丢弃的动作（没有采用任何建议时也能看到原因）。 */
  lastDropped: [] as DroppedAction[],
});

let controller: AbortController | undefined;
let runId = 0;
let generationBusy = false, autoAllowed = false, rendered = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let unbind: (() => void) | undefined;
/** 自动建议失败时的 AI 楼层总数；再新增 interval 个 AI 楼层前不再自动运行。 */
let autoFailure: { chatId: string; aiTotal: number } | null = null;

/** 默认写入目标：聊天绑定的世界书，没有时用角色主世界书。 */
export function defaultTarget(bindings: BookBindings = worldHost.bindings): string {
  return bindings.chat || bindings.charPrimary || '';
}
export function currentTarget(): string {
  return worldbookState.target ?? defaultTarget();
}
/** 写入目标不可用的原因；可用时返回空串。 */
export function targetIssue(name = currentTarget()): string {
  if (!name) return '还没有写入目标：当前聊天没有绑定世界书，角色也没有主世界书。请在「写入目标」中选择一本，或新建一本并绑定到当前聊天。';
  if (worldHost.names && !worldHost.names.includes(name)) return worldbookState.target
    ? '所选的世界书「' + name + '」不存在：可能已被删除或改名。请在「写入目标」中重新选择。'
    : '默认的世界书「' + name + '」不存在：可能已被删除或改名。请在「写入目标」中选择一本，或在酒馆中重新绑定。';
  return '';
}
/** 当前聊天启用的其他世界书（只读参考，不含写入目标）。 */
export function referenceBooks(target = currentTarget(), bindings: BookBindings = worldHost.bindings): string[] {
  const list = [bindings.chat, bindings.charPrimary, ...bindings.charAux, ...bindings.global, bindings.persona].filter(Boolean);
  return [...new Set(list)].filter(name => name !== target && (!worldHost.names || worldHost.names.includes(name)));
}

/** 批次依据的楼层是否已被改写、重抽或删除。 */
export function batchStale(batch: SuggestionBatch, ctx: STContext | null = getContext()): boolean {
  void worldbookState.revision;
  return !rangeCurrent(batch.source, ctx);
}
/** 待审核的建议数（不含已失效的批次）。导航角标和自动建议的暂停判断用它。 */
export function pendingCount(): number {
  void worldbookState.revision;
  const ctx = getContext();
  let count = 0;
  for (const batch of worldbookState.batches) {
    const pending = batch.suggestions.filter(s => s.status === 'pending').length;
    if (pending && !batchStale(batch, ctx)) count += pending;
  }
  return count;
}

export function cancelSuggestions(): void {
  const wasBusy = worldbookRun.busy;
  ++runId; controller?.abort(); controller = undefined;
  worldbookRun.busy = false; worldbookRun.auto = false; worldbookRun.received = 0;
  if (wasBusy) worldbookRun.status = '已取消，没有生成新的建议。';
}

function failureText(error: unknown, phase: string): { message: string; detail: string } {
  if (phase === 'request' || error instanceof ApiError) {
    const view = describeFailure(error, '生成建议没有完成，请检查世界书使用的 API 后重试', worldbookApiPath());
    const extra = error instanceof ApiError && error.kind === 'truncated' ? '也可以在「读取范围」中减少楼层数或字数。' : '';
    return { message: view.message + extra + '已有的建议和世界书没有变化。', detail: view.detail };
  }
  if (error instanceof WorldbookProtocolError) return { message: error.message, detail: '' };
  return { message: (error instanceof Error ? error.message : '生成建议没有完成。').slice(0, 300), detail: '' };
}

/** 生成一批建议。返回是否完成（没有建议也算完成）。 */
export async function generateSuggestions(opts: { auto?: boolean } = {}): Promise<boolean> {
  if (worldbookRun.busy) return false;
  const auto = opts.auto === true;
  if (!auto) { worldbookRun.error = ''; worldbookRun.errorDetail = ''; }
  worldbookRun.status = '';
  worldbookState.pruneNotice = '';
  let own = 0, phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  try {
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
    if (generationBusy) throw new Error('正文正在生成，结束后再生成建议。');
    const ctx = getContext();
    if (!ctx?.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const hostIssue = hostApiIssue(); if (hostIssue) throw new Error(hostIssue);
    const storage = worldbookWriteIssue(); if (storage) throw new Error(storage);
    const channel = resolveWorldbookChannel();
    await refreshWorldHost();
    const book = currentTarget();
    const tIssue = targetIssue(book); if (tIssue) throw new Error(tIssue);
    const identity = captureChat(ctx);
    const target = await loadBook(book);
    if (!target) throw new Error(missingBookMessage(book));
    const references: BookSnapshot[] = [];
    for (const name of referenceBooks(book)) {
      try { const data = await loadBook(name); if (data) references.push({ name, data }); } catch { /* 参考书读不到时跳过 */ }
    }
    if (!sameChat(identity)) throw new Error('聊天已经切换，没有生成。');
    const plan = planRead(ctx, worldbookState.cursor, worldbookSettings.read, { allowReread: !auto, floorText: worldbookSettings.read.maxChars });
    if (!plan) throw new Error(auto ? '没有新的楼层。' : '当前聊天还没有可以读取的正文。');
    const range = makeRange(ctx, plan.floors[0], plan.floors[plan.floors.length - 1]);
    const permission = worldbookSettings.permission;
    const built = buildWorldbookContext({ ctx, target: { name: book, data: target }, references, plan, read: worldbookSettings.read, permission, contentBoundary: !isDeepSeekModel(channel.model) });
    const ctrl = new AbortController(); controller = ctrl; own = ++runId;
    Object.assign(worldbookRun, { busy: true, auto, received: 0, lastStats: built.stats, lastDropped: [] });
    const modeText = plan.mode === 'first' ? '（本聊天第一次读取，从最近的楼层开始）' : plan.mode === 'reread' ? '（没有新楼层，重新读取最近的楼层）' : '';
    worldbookRun.status = (auto ? '自动建议：' : '') + '正在读取第 ' + range.from + '–' + range.to + ' 楼（' + plan.floors.length + ' 层）并生成建议' + modeText + '…';
    const current = () => own === runId && !ctrl.signal.aborted && sameChat(identity) && rangeCurrent(range);
    phase = 'request';
    const reply = await requestCompletion(channel, built.messages, { signal: ctrl.signal, onDelta: text => { if (own === runId) worldbookRun.received = text.length; } });
    if (!current()) {
      if (own === runId) worldbookRun.status = '聊天或依据的楼层已经变化，这次的结果没有采用。';
      return false;
    }
    if (looksLikeUnfinishedJson(reply)) throw apiFailure('truncated', '回复不完整（JSON 写到一半就结束了），多半是输出达到了长度上限', '请调大该 API 的「最大输出」。');
    phase = 'parse';
    const result = parseWorldbookReply(reply, { data: target, permission, range: { from: range.from, to: range.to }, fullUids: built.fullUids });
    phase = 'save';
    const cursor = { floor: range.to, hash: messageHash(ctx.chat[range.to]) };
    if (!current()) { if (own === runId) worldbookRun.status = '聊天或依据的楼层已经变化，这次的结果没有采用。'; return false; }
    if (result.suggestions.length) {
      await commitBatch({ id: crypto.randomUUID(), createdAt: Date.now(), auto, book, permission, source: range, suggestions: result.suggestions, dropped: result.dropped }, cursor);
    } else {
      await setCursor(cursor);
    }
    if (own !== runId || !sameChat(identity)) return true;
    worldbookRun.lastDropped = result.suggestions.length ? [] : result.dropped;
    const writes = result.suggestions.filter(s => s.kind !== 'flag').length, flags = result.suggestions.length - writes;
    const droppedText = result.dropped.length ? '另有 ' + result.dropped.length + ' 条不符合要求，已丢弃。' : '';
    const remainText = plan.remaining ? '还有 ' + plan.remaining + ' 层新楼层没有读取，可再次生成继续。' : '';
    const cutText = built.stats.truncatedFloors.length
      ? '第 ' + built.stats.truncatedFloors.join('、') + ' 楼超过单层上限（' + worldbookSettings.read.maxChars + ' 字），后半段没有读取；可在「读取范围」中调高「正文字数上限」。'
      : '';
    worldbookRun.status = (auto ? '自动建议：' : '') + (result.suggestions.length
      ? '读取了第 ' + range.from + '–' + range.to + ' 楼，生成 ' + (writes ? writes + ' 条建议' : '') + (writes && flags ? '、' : '') + (flags ? flags + ' 条提醒' : '') + '，请在下方审核。'
      : '读取了第 ' + range.from + '–' + range.to + ' 楼，没有需要写入的新设定。') + droppedText + remainText + cutText;
    autoFailure = null; worldbookRun.autoNote = '';
    if (auto && result.suggestions.length) toast('世界书有 ' + result.suggestions.length + ' 条新建议待审核，可在宝书的「世界书」页查看。', 'info');
    return true;
  } catch (error) {
    if (own && own !== runId) return false;
    const failure = failureText(error, phase);
    if (auto) {
      const ctx = getContext();
      if (ctx?.getCurrentChatId()) autoFailure = { chatId: String(ctx.getCurrentChatId()), aiTotal: totalAiFloors(ctx) };
      worldbookRun.autoNote = '自动建议没有完成：' + failure.message + ' 再新增 ' + worldbookSettings.auto.interval + ' 个 AI 楼层后会再次运行，也可以手动生成。';
      worldbookRun.status = '';
      console.warn('[棱镜宝书] 自动世界书建议没有完成（不影响正文）', error);
    } else {
      worldbookRun.error = failure.message; worldbookRun.errorDetail = failure.detail; worldbookRun.status = '';
    }
    return false;
  } finally {
    if (!own || own === runId) { worldbookRun.busy = false; worldbookRun.auto = false; controller = undefined; }
  }
}

/**
 * 自动建议是否运行；不运行时 note 说明原因（空串表示不需要提示）。
 * 只有失败的说明存进 worldbookRun.autoNote；暂停、配置问题由页面按当前状态显示，处理后即消失。
 */
export function evaluateAuto(ctx: STContext | null = getContext()): { run: boolean; note: string } {
  const interval = worldbookSettings.auto.interval;
  if (!worldbookSettings.auto.enabled || !ctx?.getCurrentChatId() || !engineActiveHere()) return { run: false, note: '' };
  if (worldbookRun.busy || generationBusy || writerState.busy) return { run: false, note: '' };
  const storage = worldbookWriteIssue(); if (storage) return { run: false, note: '自动建议没有运行：' + storage };
  const pending = pendingCount();
  if (pending) return { run: false, note: autoPauseNote(pending) };
  if (newAiFloors(ctx, worldbookState.cursor) < interval) return { run: false, note: '' };
  if (autoFailure && autoFailure.chatId === String(ctx.getCurrentChatId()) && totalAiFloors(ctx) - autoFailure.aiTotal < interval) return { run: false, note: worldbookRun.autoNote };
  const issue = hostApiIssue() || (() => { try { resolveWorldbookChannel(); return ''; } catch (e) { return e instanceof Error ? e.message : '世界书 API 不可用。'; } })() || targetIssue();
  if (issue) return { run: false, note: '自动建议没有运行：' + issue };
  return { run: true, note: '' };
}
export function autoPauseNote(pending: number): string {
  return '有 ' + pending + ' 条建议待审核，自动建议暂停；处理完后，在下一次正文生成结束时继续。';
}

/** 正文生成结束后调用：满足条件时运行一次自动建议。 */
export async function maybeAutoSuggest(): Promise<boolean> {
  await refreshWorldHost();
  const decision = evaluateAuto();
  if (!decision.run) return false;
  return generateSuggestions({ auto: true });
}

export function bindWorldbookLifecycle(): void {
  if (unbind) return;
  const ctx = getContext(); if (!ctx) return;
  loadWorldbookData(); void refreshWorldHost();
  const handlers: Array<[string, (...args: any[]) => void]> = [];
  const on = (name: string, fn: (...args: any[]) => void) => { const event = ctx.eventTypes?.[name]; if (event) { ctx.eventSource.on(event, fn); handlers.push([event, fn]); } };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  on('CHAT_CHANGED', () => {
    clearTimer(); cancelSuggestions(); generationBusy = false; autoAllowed = false; rendered = false; autoFailure = null;
    Object.assign(worldbookRun, { storyBusy: false, status: '', error: '', errorDetail: '', autoNote: '', lastStats: null, lastDropped: [] });
    loadWorldbookData(); void refreshWorldHost();
  });
  on('GENERATION_STARTED', (type: unknown, _options: unknown, dryRun?: boolean) => {
    if (dryRun || type === 'quiet' || type === 'impersonate') return;
    clearTimer(); generationBusy = true; worldbookRun.storyBusy = true; rendered = false;
    autoAllowed = type == null || ['normal', 'regenerate', 'swipe', 'continue'].includes(String(type));
  });
  on('CHARACTER_MESSAGE_RENDERED', (_floor: unknown, type: unknown) => { if (autoAllowed && type !== 'quiet' && type !== 'impersonate' && type !== 'first_message') rendered = true; });
  on('GENERATION_STOPPED', () => { clearTimer(); generationBusy = false; worldbookRun.storyBusy = false; autoAllowed = false; rendered = false; });
  on('GENERATION_ENDED', () => {
    const eligible = autoAllowed && rendered; autoAllowed = false; rendered = false; generationBusy = false; worldbookRun.storyBusy = false;
    if (!eligible || !worldbookSettings.auto.enabled) return;
    const source = getContext(); if (!source) return;
    const chatId = source.getCurrentChatId(), count = source.chat.length;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      const now = getContext();
      if (now && now.chat === source.chat && now.getCurrentChatId() === chatId && now.chat.length === count) void maybeAutoSuggest();
    }, 800);
  });
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED']) on(event, () => { worldbookState.revision++; });
  on('WORLDINFO_UPDATED', () => { worldHost.revision++; });
  on('WORLDINFO_SETTINGS_UPDATED', () => { void refreshWorldHost(); });
  unbind = () => {
    clearTimer(); cancelSuggestions();
    for (const [event, fn] of handlers) ctx.eventSource.off?.(event, fn);
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', unbindWorldbookLifecycle, { once: true });
}
export function unbindWorldbookLifecycle(): void {
  unbind?.(); unbind = undefined;
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', unbindWorldbookLifecycle);
}
