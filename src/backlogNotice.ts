/**
 * 「本次生成已拦截」提示消息的善后。提示由 memory/engine.ts 的 handleGenerationIntercept 用 /sendas 插入，
 * normalizeBacklogNotices 给它打上 extra.bbs_internal_notice='backlog' 与 bbs_omit=true。
 *
 * 1. 自动删除：缺摘要的楼层全部补齐（holesExceptLast 为空）、没有摘要在进行时，用酒馆的 /cut 删除
 *    聊天末尾连续的提示消息。/cut 会逐条删除并保存聊天，删除事件让摘要、隐藏、楼层面板等照常刷新。
 *    - 只删末尾的：提示后面已有发言或正文时，删除会改变后面楼层的编号，留给用户手动删除。
 *    - 规划草稿、已确认的规划依据的楼层或导入旧总结的楼层范围包含这条提示时不删，免得这些记录失效或错位。
 *    - 以下情况先等一等，结束后再删：宝书窗口开着（页面里可能有没保存的编辑）、正文正在生成、
 *      酒馆正在编辑消息或处于删除模式、楼层面板正在编辑、札记或规划正在生成。
 *    - 只删带标记、正文仍是提示原文的消息（用户改写过内容的不动）。
 * 2. 发给正文模型前过滤：生成拦截器拿到的消息列表是这次请求用的副本，从里面去掉这类提示，
 *    即使提示还留在聊天里（中间的旧提示、来不及删除时），正文模型也看不到。不改聊天本身。
 */
import { watch } from 'vue';
import { engineActiveHere } from '@/api/settings';
import { batchState, currentSummaryPromise, engineState, floorBackfillState, holesExceptLast } from '@/memory/engine';
import { derivedMeta, memory, memoryWriteIssue } from '@/memory/store';
import { notesRun } from '@/notes/service';
import { discussionRun, outlineRun } from '@/outline/service';
import { outlineSourceCurrent, outlineState } from '@/outline/store';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { ui } from '@/state/ui';

/** 提示正文里的固定句（与 engine.ts 的 BACKLOG_NOTICE_SENTINEL 相同）。 */
export const BACKLOG_NOTICE_SENTINEL = '本次生成已拦截';

/** 带标记、正文仍是提示原文的拦截提示。 */
export function isMarkedBacklogNotice(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false;
  const msg = m as Partial<STMessage>;
  return !msg.is_user && msg.extra?.bbs_internal_notice === 'backlog'
    && typeof msg.mes === 'string' && msg.mes.includes(BACKLOG_NOTICE_SENTINEL);
}

/** 聊天末尾连续的拦截提示的楼层号（由小到大）；最后一条不是提示时为空。 */
export function trailingBacklogNotices(chat: STMessage[]): number[] {
  const out: number[] = [];
  for (let i = chat.length - 1; i >= 0 && isMarkedBacklogNotice(chat[i]); i--) out.unshift(i);
  return out;
}

/** 依据楼层的记录：楼层号大于等于提示的楼层号时，删除提示会让它失效或错位。 */
export interface FloorAnchor {
  floor: number;
  kind: 'outline-draft' | 'outline-active' | 'imported';
}

export interface CleanupInput {
  chat: STMessage[];
  /** 末尾 AI 楼层之前还没有摘要的楼层数 */
  holes: number;
  /** 需要先等一等的原因；空串表示可以删除 */
  busy: string;
  anchors: FloorAnchor[];
}

export type CleanupPlan =
  | { action: 'none' }
  | { action: 'wait'; reason: string }
  | { action: 'delete'; floors: number[]; kept: number[]; keptReason: string }
  | { action: 'keep'; kept: number[]; keptReason: string };

const ANCHOR_TEXT: Record<FloorAnchor['kind'], string> = {
  'outline-draft': '规划草稿是在这条提示出现之后保存的，删除提示后草稿需要重新保存才能启用',
  'outline-active': '已确认的规划是在这条提示出现之后启用的，删除提示后规划需要重新确认',
  imported: '导入的旧总结覆盖的楼层范围包含这条提示，删除提示会让范围错位',
};

/** 决定这次能删哪些提示（纯函数，便于测试）。 */
export function planBacklogCleanup(input: CleanupInput): CleanupPlan {
  const notices = trailingBacklogNotices(input.chat);
  if (!notices.length) return { action: 'none' };
  if (input.holes > 0) return { action: 'wait', reason: '还有楼层没有摘要' };
  if (input.busy) return { action: 'wait', reason: input.busy };
  const blocking = input.anchors.filter(a => Number.isInteger(a.floor) && a.floor >= notices[0]);
  const limit = blocking.reduce((max, a) => Math.max(max, a.floor), -1);
  const floors = notices.filter(f => f > limit);
  const kept = notices.filter(f => f <= limit);
  const keptReason = [...new Set(blocking.map(a => ANCHOR_TEXT[a.kind]))].join('；');
  return floors.length ? { action: 'delete', floors, kept, keptReason } : { action: 'keep', kept, keptReason };
}

/** 生成前从发给正文模型的消息副本里去掉拦截提示；返回去掉的条数。 */
export function stripBacklogNoticesFromPrompt(promptChat: unknown): number {
  if (!Array.isArray(promptChat) || !engineActiveHere()) return 0;
  let removed = 0;
  for (let i = promptChat.length - 1; i >= 0; i--) {
    if (!isMarkedBacklogNotice(promptChat[i])) continue;
    promptChat.splice(i, 1);
    removed++;
  }
  return removed;
}

/* ============ 运行时：判断时机、执行删除 ============ */

/** 停止操作后等这么久再判断（合并连续的摘要、重算）。 */
const SETTLE_MS = 800;
/** 宝书窗口刚关上：尽快判断，赶在用户发下一条消息之前。 */
const CLOSE_MS = 80;
/** 酒馆这边的忙碌状态没有事件可等，隔一会儿再看。 */
const RETRY_MS = 1500;

let bound = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let rerun = false;
/** 已经提示过「没有自动删除」的提示消息（每条只提示一次）。 */
const announced = new WeakSet<object>();
/** 删除失败过的提示消息，不再自动重试。 */
const failed = new WeakSet<object>();

function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function insideHost(el: Element, selector: string): boolean {
  for (let node: Element | null = el; node;) {
    if (node.matches?.(selector)) return true;
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

/** 酒馆或聊天里的面板正在做不能被打断的事：返回原因，空串表示空闲。 */
function hostBusyReason(): string {
  if (typeof document === 'undefined') return '';
  if (document.body?.dataset?.generating === 'true') return '正文正在生成';
  if (document.getElementById('curEditTextarea') || document.querySelector('.reasoning_edit_textarea')) return '正在编辑消息';
  const deleteBar = document.getElementById('dialogue_del_mes');
  if (deleteBar && deleteBar.style.display && deleteBar.style.display !== 'none') return '处于删除消息模式';
  if (document.getElementById('form_sheld')?.classList.contains('isExecutingCommandsFromChatInput')) return '正在执行斜杠命令';
  // 删除消息会重建楼层面板：有面板处于编辑状态（出现输入框）时先等
  for (const host of Array.from(document.querySelectorAll('.bbs-fp-host'))) {
    if (host.shadowRoot?.querySelector('textarea, input')) return '楼层面板正在编辑';
  }
  const active = deepActiveElement();
  if (active && insideHost(active, '.bbs-notes-host') && active.matches('textarea, input, [contenteditable="true"]')) return '札记卡片正在编辑';
  return '';
}

/** 棱镜宝书自己正在做、会被删除消息打断的事。 */
function pluginBusyReason(): string {
  if (ui.open) return '宝书窗口开着';
  if (engineState.running || batchState.running || floorBackfillState.running || currentSummaryPromise()) return '摘要正在进行';
  if (notesRun.busy) return '札记正在生成';
  if (outlineRun.busy) return '规划草稿正在生成';
  if (discussionRun.busy) return '规划讨论正在等待回复';
  return '';
}

function currentAnchors(): FloorAnchor[] {
  const anchors: FloorAnchor[] = [];
  const draft = outlineState.draft;
  if (draft && outlineSourceCurrent(draft)) anchors.push({ floor: draft.sourceFloor, kind: 'outline-draft' });
  const active = outlineState.active;
  if (active && outlineSourceCurrent(active)) anchors.push({ floor: active.sourceFloor, kind: 'outline-active' });
  for (const s of memory.summaries) {
    if (s.imported && Number.isFinite(s.importedFloorEnd)) anchors.push({ floor: Math.floor(s.importedFloorEnd as number), kind: 'imported' });
  }
  return anchors;
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void runBacklogCleanup();
  }, ms);
}

function announceKept(chat: STMessage[], floors: number[], reason: string): void {
  const fresh = floors.map(f => chat[f]).filter(m => m && !announced.has(m));
  if (!fresh.length) return;
  for (const m of fresh) announced.add(m);
  toast(`缺摘要的楼层已补齐，聊天末尾的拦截提示没有自动删除：${reason}。如不需要，可在聊天中手动删除；这条提示不会发给正文模型。`, 'info');
}

/** 删除聊天末尾的这些提示；删除前再核对一次仍是同一批提示、仍在末尾。 */
async function deleteTrailing(ctx: STContext, chat: STMessage[], floors: number[]): Promise<boolean> {
  const first = floors[0];
  const last = floors[floors.length - 1];
  const targets = floors.map(f => chat[f]);
  if (last !== chat.length - 1 || targets.some(m => !isMarkedBacklogNotice(m) || failed.has(m))) return false;
  const exec = ctx.executeSlashCommandsWithOptions;
  try {
    if (typeof exec === 'function') {
      // /cut 的范围包含两端；逐条删除后保存聊天
      await exec(first === last ? `/cut ${first}` : `/cut ${first}-${last}`);
    } else if (typeof ctx.deleteMessage === 'function') {
      for (let i = last; i >= first; i--) await ctx.deleteMessage(i);
      await ctx.saveChat?.();
    } else {
      return false;
    }
  } catch (error) {
    for (const m of targets) failed.add(m);
    toast(`拦截提示没有自动删除（${error instanceof Error ? error.message : String(error)}）。可在聊天中手动删除；这条提示不会发给正文模型。`, 'warning');
    return false;
  }
  const now = getContext()?.chat ?? [];
  const remaining = targets.filter(m => now.includes(m));
  if (remaining.length) {
    for (const m of remaining) failed.add(m);
    toast(`有 ${remaining.length} 条拦截提示没有自动删除，可在聊天中手动删除；这些提示不会发给正文模型。`, 'warning');
    return false;
  }
  toast(`缺摘要的楼层已补齐，已删除聊天末尾的 ${targets.length} 条「${BACKLOG_NOTICE_SENTINEL}」提示。`, 'success');
  return true;
}

/** 判断一次并在条件满足时删除。返回本次的结论（测试与排查用）。 */
export async function runBacklogCleanup(): Promise<'skip' | CleanupPlan['action']> {
  if (running) { rerun = true; return 'skip'; }
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.() || !engineActiveHere() || memoryWriteIssue()) return 'skip';
  const chat = ctx.chat ?? [];
  if (!trailingBacklogNotices(chat).length) return 'none';
  const hostBusy = hostBusyReason();
  const plan = planBacklogCleanup({ chat, holes: holesExceptLast(chat).length, busy: hostBusy || pluginBusyReason(), anchors: currentAnchors() });
  if (plan.action === 'wait') {
    // 酒馆的忙碌状态没有可监听的结束信号，过一会儿再看；其余情况等对应的状态变化再判断
    if (hostBusy && plan.reason === hostBusy) schedule(RETRY_MS);
    return 'wait';
  }
  if (plan.action === 'none') return 'none';
  if (plan.kept.length) announceKept(chat, plan.kept, plan.keptReason);
  if (plan.action === 'keep') return 'keep';
  running = true;
  try {
    await deleteTrailing(ctx, chat, plan.floors);
  } finally {
    running = false;
    if (rerun) { rerun = false; schedule(SETTLE_MS); }
  }
  return 'delete';
}

/** 启动时调用一次：摘要、重算、窗口开关、生成结束等变化后重新判断。 */
export function bindBacklogNoticeCleanup(): void {
  if (bound) return;
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx.eventTypes) return;
  bound = true;
  watch(
    () => [derivedMeta.rev, engineState.running, batchState.running, floorBackfillState.running, notesRun.busy, outlineRun.busy, discussionRun.busy],
    () => schedule(SETTLE_MS),
  );
  watch(() => ui.open, open => schedule(open ? SETTLE_MS : CLOSE_MS));
  for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
    const event = ctx.eventTypes[name];
    if (event) ctx.eventSource.on(event, () => schedule(SETTLE_MS));
  }
  schedule(SETTLE_MS);
}
