import { reactive, watch } from 'vue';
import { requestCompletion } from '@/api/client';
import { ApiError, apiFailure, describeFailure, looksLikeUnfinishedJson, partialReply } from '@/api/errors';
import { engineActiveHere } from '@/api/settings';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { buildOutlineContext, type OutlineChapterCount } from './context';
import { outlineArrangements, outlineWorldInfo } from './sources';
import { parseOutlineReply } from './protocol';
import { outlineApiPath, outlineSettings, resolveOutlineChannel } from './settings';
import { loadOutline, outlineState, outlineWriteIssue, outlineSourceCurrent, outlineStorageCurrent, commitGeneratedOutline } from './store';
import { captureOutlineSource, outlineInputUnchanged, sameOutlineChat } from './source';
import { renderOutlineGuidance } from './injection';
import { OUTLINE_LIMITS } from './limits';
import { addRefinementContext, buildDiscussionContext, discussionReply, visibleDiscussionText, type DiscussionTarget, type OutlineRefinement } from './discussionContext';
import { DISCUSSION_LIMITS, discussionRoom, discussionState, loadOutlineDiscussion, discussionWriteIssue, appendDiscussionTurn } from './discussionStore';

export const OUTLINE_INJECT_KEY = 'prism_book_outline_current';
/**
 * draftWarnings：生成草稿时对模型回复做的调整（截断超长文字、舍弃多余字段或条目、阶段数与要求不符），
 * 只记在内存里，随这份草稿在编辑器中显示；草稿被替换、切换聊天或刷新页面后不再显示。
 */
export const outlineRun = reactive({ busy: false, draft: '', error: '', errorDetail: '', status: '', draftWarnings: null as { draftId: string; items: string[] } | null });
let controller: AbortController | undefined;
let runId = 0;
let generationBusy = false;
let stillCurrent: (() => boolean) | undefined;
let unbind: (() => void) | undefined;
export const discussionRun = reactive({ busy: false, error: '', errorDetail: '', status: '' });
let discussionController: AbortController | undefined;
let discussionRunId = 0;
let discussionCurrent: (() => boolean) | undefined;

/** 出错时告诉用户该去哪里改：复用札记时改札记的 API，专用模式改规划 API。 */
function outlineSettingsPath(): string {
  return outlineApiPath(!!outlineState.active);
}

/** ApiError 已是分类后的说明，可以展示；其它请求异常可能带上游原文，只给通用说明。 */
function requestFailure(error: unknown, fallback: string, tail: string): { error: string; detail: string } {
  const view = describeFailure(error, fallback, outlineSettingsPath());
  const extra = error instanceof ApiError && error.kind === 'truncated' && tail.includes('大纲') ? '也可以减少规划阶段数。' : '';
  return { error: view.message + extra + tail, detail: view.detail };
}

export function cancelOutlineDiscussion(): void {
  ++discussionRunId; discussionController?.abort(); discussionController = undefined; discussionCurrent = undefined;
  discussionRun.busy = false; discussionRun.status = '已取消，讨论记录和大纲都没有变动。';
}
/** 参考明确选择的版本，绝不默认把新草稿当成正在使用的规划。 */
export function captureOutlineRefinement(target: DiscussionTarget): OutlineRefinement {
  if (!['draft', 'active', 'none'].includes(target)) throw new Error('讨论参考类型无效，请重新选择。');
  const issue = outlineWriteIssue() || discussionWriteIssue();
  if (issue) throw new Error(issue);
  const record = target === 'draft' ? outlineState.draft : target === 'active' ? outlineState.active : null;
  if (target !== 'none' && !record) throw new Error('所选参考大纲已不存在，请重新选择。');
  return {
    reference: record ? JSON.parse(JSON.stringify(record.content)) : null,
    referenceLabel: target === 'draft' ? '已保存草稿' : target === 'active' ? '已确认规划' : '无参考大纲',
    messages: discussionState.messages.map(m => ({ ...m })),
  };
}
/** 讨论回复写到一半被截断时仍可保存，末尾标明，长度不超过存储上限。 */
function cutDiscussionReply(partial: string, error: ApiError): string {
  const note = error.kind === 'truncated' ? '\n\n（回复在这里被截断：输出达到了长度上限。）' : '\n\n（回复在这里被中断，没有写完。）';
  const answer = visibleDiscussionText(partial.slice(0, 100000));
  return answer.slice(0, DISCUSSION_LIMITS.answer - note.length) + note;
}
/** 读取世界书（可取消；读取失败时不带世界书）。 */
function readWorldInfo(ctx: NonNullable<ReturnType<typeof getContext>>, signal: AbortSignal): Promise<string> {
  return new Promise<string>(resolve => {
    signal.addEventListener('abort', () => resolve(''), { once: true });
    outlineWorldInfo(ctx).then(resolve, () => resolve(''));
  });
}
export async function sendOutlineDiscussion(question: string, target: DiscussionTarget): Promise<boolean> {
  if (discussionRun.busy || outlineRun.busy) return false;
  discussionRun.error = ''; discussionRun.errorDetail = ''; discussionRun.status = '';
  let own = 0, phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  const askedAt = Date.now();
  try {
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再讨论大纲。');
    if (!question.trim() || question.length > DISCUSSION_LIMITS.question) throw new Error(`讨论问题须为1～${DISCUSSION_LIMITS.question}字符。`);
    const room = discussionRoom(discussionState.messages);
    if (room.full) throw new Error(`讨论已经满${DISCUSSION_LIMITS.rounds}轮。请先删除最早的一轮或清空讨论再继续；大纲不会被清除。`);
    if (question.length > room.question) {
      throw new Error(`讨论记录已有 ${room.used} 字，加上本轮问题和最长 ${DISCUSSION_LIMITS.answer} 字的回答会超过 ${DISCUSSION_LIMITS.total} 字的上限。请缩短问题，或先删除最早的一轮、清空讨论。`);
    }
    const ctx = getContext(); if (!ctx?.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const reference = captureOutlineRefinement(target);
    const channel = resolveOutlineChannel(), source = captureOutlineSource(ctx);
    const revision = outlineState.revision, discussionRevision = discussionState.revision;
    const ctrl = new AbortController(); discussionController = ctrl; own = ++discussionRunId;
    discussionRun.busy = true; discussionRun.status = '正在读取世界书…';
    const current = () => own === discussionRunId && !ctrl.signal.aborted && outlineInputUnchanged(source, true)
      && outlineState.revision === revision && outlineStorageCurrent() && discussionState.revision === discussionRevision && engineActiveHere();
    discussionCurrent = current;
    // 与生成规划相同：带上世界书（常驻条目与最近正文触发的条目）和札记中仍要落实的安排。读完再核对一次。
    const worldInfo = await readWorldInfo(ctx, ctrl.signal);
    if (!current()) {
      if (own === discussionRunId) discussionRun.status = '聊天、正文或大纲已经变化，这次没有发送。';
      return false;
    }
    const input = buildDiscussionContext(ctx, question, reference, { worldInfo, arrangements: outlineArrangements() });
    discussionRun.status = '正在输入…';
    phase = 'request';
    let answer: string | undefined;
    try {
      const raw = await requestCompletion(channel, input, { signal: ctrl.signal });
      if (!current()) {
        if (own === discussionRunId) discussionRun.status = '聊天、正文或大纲已经变化，这条回复没有采用。';
        return false;
      }
      phase = 'parse'; answer = discussionReply(raw);
    } catch (error) {
      const partial = partialReply(error);
      if (!partial || !current()) throw error;
      // 只剩思考、没有可见回答时,按原来的截断错误说明。
      try { answer = cutDiscussionReply(partial, error as ApiError); } catch { throw error; }
      phase = 'parse';
    }
    phase = 'save'; await appendDiscussionTurn(question.trim(), answer, discussionRevision, source, { question: askedAt, answer: Date.now() });
    if (own !== discussionRunId || !sameOutlineChat(source)) return false;
    discussionRun.status = '已保存这一轮讨论，规划未改动。采纳时使用「生成草稿」，确认加入计划后生效。';
    return true;
  } catch (error) {
    if (own && own !== discussionRunId) return false;
    if (phase === 'request') {
      const failure = requestFailure(error, '讨论没有完成，请检查规划 API 后重试', '原有讨论没有变化。');
      discussionRun.error = failure.error; discussionRun.errorDetail = failure.detail;
    } else discussionRun.error = error instanceof Error ? error.message.slice(0, 250) : '讨论没有完成，请重试。';
    discussionRun.status = '';
    return false;
  } finally {
    if (!own || own === discussionRunId) { discussionRun.busy = false; discussionController = undefined; discussionCurrent = undefined; }
  }
}

export function cancelOutline(): void {
  ++runId; controller?.abort(); controller = undefined; stillCurrent = undefined;
  outlineRun.busy = false; outlineRun.draft = ''; outlineRun.status = '已取消生成，现有草稿和规划都没有变动。';
}
export function buildOutlineInjection(): string {
  if (!engineActiveHere() || outlineState.saving || !outlineStorageCurrent()) return '';
  const active = outlineState.active;
  if (!active?.enabled || !outlineSourceCurrent(active)) return '';
  try { return renderOutlineGuidance(active); }
  catch { outlineRun.status = '当前阶段太长，没有发给正文；请精简后重新确认。'; return ''; }
}
/** 正在生效的规划参考的正文是否还在；从「在」变为「不在」时提示一次（换了规划、重新启用或切换聊天不算）。 */
let sourceWatch: { key: string; current: boolean } | null = null;
function noticeSourceChange(): void {
  const ctx = getContext(), active = outlineState.active;
  if (!ctx || !active?.enabled || active.currentChapter >= active.content.chapters.length || outlineState.saving || !outlineStorageCurrent()) { sourceWatch = null; return; }
  const key = `${ctx.getCurrentChatId?.() ?? ''}|${active.id}|${active.sourceFloor}|${active.sourceHash}`;
  const current = outlineSourceCurrent(active);
  if (sourceWatch?.key === key && sourceWatch.current && !current && engineActiveHere()) {
    toast('规划参考的正文有改动，已暂停注入；可在「摘要 → 创作规划」中核对后重新启用。', 'warning');
  }
  sourceWatch = { key, current };
}
export function refreshOutlineInjection(): void {
  noticeSourceChange();
  getContext()?.setExtensionPrompt?.(OUTLINE_INJECT_KEY, buildOutlineInjection(), 1, 0, false, 0);
}
export async function generateOutline(brief: string, chapterCount = 6, refinement?: OutlineRefinement): Promise<void> {
  return runOutlineGeneration(brief, chapterCount, refinement);
}

/** 一键生成存进草稿的「创作要求」:说明这份草稿的来历,重新生成时也能看出不是手写要求。 */
export const AUTO_OUTLINE_BRIEF = '一键生成：未填写创作要求，由模型根据角色卡、世界书和当前剧情自行规划。';

/** 一键生成:不填创作要求,由模型根据角色卡、世界书、记忆和最近剧情自行规划 3～6 个阶段;结果同样先存为草稿。 */
export async function generateOutlineAuto(): Promise<void> {
  return runOutlineGeneration(AUTO_OUTLINE_BRIEF, 'auto');
}

async function runOutlineGeneration(brief: string, chapterCount: OutlineChapterCount, refinement?: OutlineRefinement): Promise<void> {
  if (outlineRun.busy || discussionRun.busy || discussionState.saving) return;
  outlineRun.error = ''; outlineRun.errorDetail = ''; outlineRun.status = ''; outlineRun.draft = '';
  let own = 0;
  let phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  const auto = chapterCount === 'auto';
  try {
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再生成大纲。');
    if (!brief.trim() || brief.length > 8000) throw new Error('请填写1～8000字的创作要求。');
    if (!auto && (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 12)) throw new Error('大纲阶段数须为1～12。');
    const ctx = getContext(); if (!ctx?.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const issue = outlineWriteIssue(); if (issue) throw new Error(issue);
    const channel = resolveOutlineChannel();
    const source = captureOutlineSource(ctx), revision = outlineState.revision;
    const discussionRevision = discussionState.revision;
    const ctrl = new AbortController(); controller = ctrl; own = ++runId;
    outlineRun.busy = true;
    const current = () => own === runId && !ctrl.signal.aborted && outlineInputUnchanged(source, true) &&
      outlineState.revision === revision && engineActiveHere()
      && (!refinement || (discussionState.revision === discussionRevision && !discussionWriteIssue()));
    stillCurrent = current;
    outlineRun.status = '正在读取世界书…';
    // 世界书读取是异步的:读完先核对聊天、正文和大纲没变,再拼请求。读取失败时不带世界书,照常生成;取消时不等读取结束。
    const worldInfo = await readWorldInfo(ctx, ctrl.signal);
    if (!current()) {
      if (own === runId) outlineRun.status = '正文、聊天或大纲已经变化，这次没有生成。';
      return;
    }
    const baseInput = buildOutlineContext(ctx, auto ? '' : brief.trim(), chapterCount, { worldInfo, arrangements: outlineArrangements() });
    const input = refinement ? addRefinementContext(baseInput, refinement) : baseInput;
    outlineRun.status = outlineSettings.apiMode === 'notes' ? '正在用札记的 API 生成大纲草稿…' : '正在用规划专用 API 生成大纲草稿…';
    phase = 'request';
    // 大纲协议只接受完整的单个 JSON;截断的回复一律按截断说明,不拿半截内容拼凑。
    const reply = await requestCompletion(channel, input, {
      signal: ctrl.signal, onDelta: text => { if (current()) outlineRun.draft = text.slice(0, OUTLINE_LIMITS.reply); },
    });
    if (!current()) {
      if (own === runId) outlineRun.status = '正文、聊天或大纲已经变化，这次生成的结果没有采用。';
      return;
    }
    // 拿不到结束原因的服务商:JSON 写到一半就结束,按截断处理,而不是笼统的格式错误。
    if (looksLikeUnfinishedJson(reply)) {
      throw apiFailure('truncated', '大纲回复不完整（JSON 写到一半就结束了），多半是输出达到了长度上限', '请调大该 API 的「最大输出」。');
    }
    phase = 'parse';
    const { content, warnings } = parseOutlineReply(reply);
    // 一键生成只建议 3～6 个阶段,模型给出其他合法数量(1～12)也照常采用;指定数量不一致时照常存为草稿,并提示。
    if (!auto && content.chapters.length !== chapterCount) warnings.unshift(`要求 ${chapterCount} 个阶段，实际 ${content.chapters.length} 个。`);
    phase = 'save';
    const draftId = crypto.randomUUID();
    await commitGeneratedOutline({ id: draftId, createdAt: Date.now(), sourceFloor: source.floor,
      sourceHash: source.hash, brief: brief.trim(), content }, revision);
    if (own === runId && sameOutlineChat(source)) {
      outlineRun.draftWarnings = warnings.length ? { draftId, items: warnings } : null;
      outlineRun.status = warnings.length
        ? `草稿已保存，模型的回复有 ${warnings.length} 处不合要求，已自动调整（见草稿上方的说明），请核对。确认加入计划后才会生效，现在正文用的规划没有变。`
        : '草稿已保存。核对修改后确认加入计划才会生效，现在正文用的规划没有变。';
    }
  } catch (error) {
    if (own && own !== runId) return;
    if (phase === 'request' || error instanceof ApiError) {
      const failure = requestFailure(error, '大纲生成没有完成，请检查所选规划 API 后重试', '现有大纲没有被替换。');
      outlineRun.error = failure.error; outlineRun.errorDetail = failure.detail;
    } else outlineRun.error = (error instanceof Error ? error.message : '').slice(0, 250);
    outlineRun.status = '';
  } finally {
    if (!own || own === runId) { outlineRun.busy = false; outlineRun.draft = ''; controller = undefined; stillCurrent = undefined; }
  }
}

export function bindOutlineLifecycle(): void {
  if (unbind) return;
  const ctx = getContext(); if (!ctx) return;
  loadOutline(); loadOutlineDiscussion(); refreshOutlineInjection();
  let observed = captureOutlineSource(ctx);
  const handlers: Array<[string, (...args: any[]) => void]> = [];
  const on = (name: string, fn: (...args: any[]) => void) => {
    const event = ctx.eventTypes[name]; if (event) { ctx.eventSource.on(event, fn); handlers.push([event, fn]); }
  };
  on('CHAT_CHANGED', () => {
    cancelOutline(); cancelOutlineDiscussion(); generationBusy = false; loadOutline(); loadOutlineDiscussion();
    const now = getContext(); if (now) observed = captureOutlineSource(now);
    outlineRun.status = ''; outlineRun.error = ''; outlineRun.errorDetail = ''; outlineRun.draftWarnings = null; discussionRun.status = ''; discussionRun.error = ''; discussionRun.errorDetail = ''; refreshOutlineInjection();
  });
  on('GENERATION_STARTED', (type: unknown, _options: unknown, dryRun?: boolean) => {
    if (dryRun || type === 'quiet' || type === 'impersonate') return;
    if (outlineRun.busy) cancelOutline();
    if (discussionRun.busy) cancelOutlineDiscussion();
    generationBusy = true; refreshOutlineInjection();
  });
  on('GENERATION_ENDED', () => { generationBusy = false; refreshOutlineInjection(); });
  on('GENERATION_STOPPED', () => { generationBusy = false; });
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT']) on(event, () => {
    if (outlineRun.busy && stillCurrent && !stillCurrent()) cancelOutline();
    if (discussionRun.busy && discussionCurrent && !discussionCurrent()) cancelOutlineDiscussion();
    // revision驱动UI重算来源状态；普通追加正文不改已确认大纲的前缀指纹。
    // 摘要附加托管标记、隐藏已摘要楼层不属于正文修改，不打断生成。
    if (!outlineInputUnchanged(observed, true)) {
      outlineState.revision++;
      const now = getContext(); if (now) observed = captureOutlineSource(now);
    }
    refreshOutlineInjection();
  });
  const stop = watch(() => [outlineState.revision, outlineState.saving, engineActiveHere()], () => {
    if (!engineActiveHere() && outlineRun.busy) cancelOutline();
    if (discussionRun.busy && discussionCurrent && !discussionCurrent()) cancelOutlineDiscussion();
    refreshOutlineInjection();
  }, { flush: 'sync' });
  unbind = () => {
    cancelOutline(); cancelOutlineDiscussion(); stop(); generationBusy = false;
    for (const [event, fn] of handlers) ctx.eventSource.off?.(event, fn);
    ctx.setExtensionPrompt?.(OUTLINE_INJECT_KEY, '', 1, 0, false, 0);
  };
  window.addEventListener('pagehide', unbindOutlineLifecycle, { once: true });
}
export function unbindOutlineLifecycle(): void {
  unbind?.(); unbind = undefined;
  window.removeEventListener('pagehide', unbindOutlineLifecycle);
}
