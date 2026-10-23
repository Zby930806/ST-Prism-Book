/**
 * 规划推进条件检查:判断当前阶段的推进条件是否已在正文中满足。
 *
 * 不改大纲内容、不写记忆;结果存在内存里。默认只作提示,阶段由用户手动切换。
 * 手动检查随时可用;自动检查默认关,开启后每隔 N 个 AI 楼检查一次。都用规划的 API。
 * 另开「自动切换」时,自动检查判定满足即切到下一阶段;最后一个阶段不自动结束,手动检查仍只作提示。
 * 生成期间聊天、大纲或当前阶段变了,迟到的结果丢弃。
 * 检查材料:上次检查（或本阶段开始，记在内存里）以来的正文与用户原话，至少最近 max(6, 间隔×2) 条；
 * 在字数上限内从新到旧取原文，放不下的较早楼层改用逐楼摘要（只作辅助证据）。
 * 自动检查失败、或因规划 API 没填好而没有运行时，在规划卡片留一条说明（autoNote），下次检查成功后清除。
 */
import { reactive, watch } from 'vue';
import { requestCompletion, type ChatMsg } from '@/api/client';
import { describeFailure } from '@/api/errors';
import { engineActiveHere } from '@/api/settings';
import { getContext, type STContext } from '@/st/context';
import { toast } from '@/st/toast';
import { cleanBody } from '@/memory/timeTag';
import { extractJsonObject } from '@/memory/json';
import { isAiFloor } from '@/memory/engine';
import { getLeaf, leafValid } from '@/memory/apply';
import { OUTLINE_PROGRESS_PROMPT } from './prompt';
import { outlineApiPath, outlineSettings, resolveOutlineChannel } from './settings';
import { outlineSourceCurrent, outlineState, outlineStorageCurrent, setOutlineChapter } from './store';
import type { OutlineActive } from './types';

export interface ProgressVerdict {
  met: boolean;
  reason: string;
}

/** 最近一次自动切换:界面据此说明切换依据,并提供退回。 */
export interface ProgressAdvance {
  outlineId: string;
  from: number;
  to: number;
  title: string;
  reason: string;
  floor: number;
}

export const outlineProgress = reactive({
  busy: false,
  /** 结果对应的大纲与阶段;切换阶段或换大纲后不再显示 */
  outlineId: '',
  chapter: -1,
  met: null as boolean | null,
  reason: '',
  /** 检查时的最后一楼 */
  floor: -1,
  auto: false,
  /** 用户点了「忽略」 */
  dismissed: false,
  error: '',
  errorDetail: '',
  advanced: null as ProgressAdvance | null,
  /** 自动检查没有完成或没有运行的原因;下次检查成功后清除 */
  autoNote: '',
});

/** 检查材料的字数上限（按 JS 字符计）：原文合计、每层原文、较早楼层的逐楼摘要合计。 */
export const PROGRESS_LIMITS = Object.freeze({ text: 20000, perFloor: 3000, summaries: 6000, minMessages: 6 });

let controller: AbortController | undefined;
let runId = 0;
/** 自动检查的计数起点:同一聊天、同一大纲同一阶段内,AI 楼数比起点多出 interval 才检查 */
let baseline: { key: string; aiCount: number } | null = null;
/** 检查材料的起点(只记在内存里):本阶段开始时或上次检查时的最后一楼;刷新页面后从最近的 max(6, 间隔×2) 条开始。 */
let stageMark: { key: string; floor: number } | null = null;
const stageKey = (ctx: STContext, active: OutlineActive) => `${ctx.getCurrentChatId?.() ?? ''}|${active.id}|${active.currentChapter}`;

function resetProgress(): void {
  ++runId;
  controller?.abort();
  controller = undefined;
  stageMark = null;
  Object.assign(outlineProgress, { busy: false, outlineId: '', chapter: -1, met: null, reason: '', floor: -1, auto: false, dismissed: false, error: '', errorDetail: '', advanced: null, autoNote: '' });
}

/** 解析核对回复:必须是 {met: boolean, reason: string}。 */
export function parseProgressReply(raw: string): ProgressVerdict {
  const parsed = extractJsonObject<unknown>(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('推进条件检查的回复不是 JSON 对象。');
  const v = parsed as Record<string, unknown>;
  if (typeof v.met !== 'boolean') throw new Error('推进条件检查的回复缺少布尔值 met。');
  const reason = typeof v.reason === 'string' ? v.reason.replace(/\s+/g, ' ').trim() : '';
  return { met: v.met, reason: reason.slice(0, 200) };
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** 本次至少要看的最近消息条数：max(6, 自动检查间隔×2)。 */
export function progressMinMessages(interval = outlineSettings.progressCheck.interval): number {
  const n = Number.isFinite(interval) ? Math.floor(interval) : 3;
  return Math.max(PROGRESS_LIMITS.minMessages, n * 2);
}

/**
 * 核对请求:当前阶段(目标、要点、推进条件) + 检查材料。
 * since:上次检查或本阶段开始时的最后一楼（不知道时只看最近 minMessages 条）；材料为它之后的消息，且至少最近 minMessages 条。
 */
export function buildProgressContext(ctx: STContext, active: OutlineActive, opts: { since?: number; minMessages?: number } = {}): ChatMsg[] {
  const L = PROGRESS_LIMITS;
  const chapter = active.content.chapters[active.currentChapter];
  if (!chapter) throw new Error('当前没有进行中的规划阶段。');
  const stage = `[当前规划阶段：第 ${active.currentChapter + 1} / ${active.content.chapters.length} 阶段 · ${chapter.title}]\n`
    + `阶段目标：${chapter.goal}\n剧情要点（计划，不代表已发生）：\n${chapter.beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    + `推进条件：${chapter.exitCriteria}`;
  const eligible = ctx.chat.map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.extra?.bbs_internal_notice && !m.extra?.bbs_omit && (!m.is_system || m.extra?.bbs_hidden));
  const min = Math.max(1, opts.minMessages ?? L.minMessages);
  const sinceAt = opts.since === undefined ? eligible.length : eligible.findIndex(({ i }) => i > opts.since!);
  const from = Math.max(0, Math.min(sinceAt < 0 ? eligible.length : sinceAt, eligible.length - min));
  const candidates = eligible.slice(from);
  // 原文从新到旧放入；放不下的较早楼层改用逐楼摘要
  const rows: string[] = [];
  const older: number[] = [];
  let budget: number = L.text;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const { m, i } = candidates[k];
    const body = cleanBody(m.mes ?? '');
    if (!body) continue;
    if (budget <= 0) { older.unshift(k); continue; }
    const row = `第${i}楼 ${m.is_user ? '用户' : '正文'}：\n${clip(body, Math.min(L.perFloor, budget))}`;
    if (budget - row.length < 0 && rows.length) { older.unshift(k); budget = 0; continue; }
    budget -= row.length;
    rows.unshift(row);
  }
  const summaries: string[] = [];
  let summaryBudget: number = L.summaries;
  for (let n = older.length - 1; n >= 0; n--) {
    const { m, i } = candidates[older[n]];
    const leaf = leafValid(m) ? getLeaf(m) : undefined;
    const text = typeof leaf?.text === 'string' ? leaf.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    const row = `第${i}楼摘要：${text}`;
    if (row.length > summaryBudget) break;
    summaryBudget -= row.length + 1;
    summaries.unshift(row);
  }
  const summaryPart = summaries.length ? `[较早楼层的逐楼摘要：原文放不下时的压缩记录，只作辅助证据]\n${summaries.join('\n')}\n\n` : '';
  return [
    { role: 'system', content: OUTLINE_PROGRESS_PROMPT },
    { role: 'user', content: `${stage}\n\n${summaryPart}[本阶段最近的正文与用户原话，按楼层排序]\n${rows.join('\n\n') || '（无）'}` },
  ];
}

function activeStage(): OutlineActive | null {
  const active = outlineState.active;
  if (!active?.enabled || active.currentChapter >= active.content.chapters.length) return null;
  if (!outlineStorageCurrent() || !outlineSourceCurrent(active)) return null;
  return active;
}

/** 当前结果是否属于正在进行的阶段(切换阶段或换大纲后旧结果不显示)。 */
export function progressForCurrentStage(): boolean {
  const active = outlineState.active;
  return !!active && outlineProgress.outlineId === active.id && outlineProgress.chapter === active.currentChapter;
}

/** 最近一次自动切换是否还停在切换后的阶段(用户又换了阶段或换了大纲就不再显示)。 */
export function autoAdvanceForCurrentStage(): ProgressAdvance | null {
  const active = outlineState.active, advanced = outlineProgress.advanced;
  return active && advanced && advanced.outlineId === active.id && advanced.to === active.currentChapter ? advanced : null;
}

/** 自动检查判定满足且开了自动切换:切到下一阶段。最后一个阶段不自动结束规划;切换失败退回提示。 */
async function autoAdvance(active: OutlineActive, chapter: number, verdict: ProgressVerdict, floor: number): Promise<boolean> {
  const next = active.content.chapters[chapter + 1];
  if (!next) return false;
  try {
    await setOutlineChapter(chapter + 1);
  } catch (error) {
    console.warn('[棱镜宝书] 自动切换规划阶段失败(改为提示)', error);
    return false;
  }
  outlineProgress.advanced = { outlineId: active.id, from: chapter, to: chapter + 1, title: next.title, reason: verdict.reason, floor };
  toast(`推进条件已满足，规划已自动切换到第 ${chapter + 2} 阶段「${next.title}」。需要退回时，在「摘要 → 创作规划」中点「上一阶段」。`, 'success');
  return true;
}

/** 记下本阶段的检查起点:第一次见到这个阶段时为当时的最后一楼;之后每次检查完成时更新为检查时的最后一楼。 */
function markStage(ctx: STContext, active: OutlineActive, floor?: number): void {
  const key = stageKey(ctx, active);
  if (floor !== undefined) stageMark = { key, floor };
  else if (stageMark?.key !== key) stageMark = { key, floor: ctx.chat.length - 1 };
}

/**
 * 检查一次。auto=true 时前置条件不满足(规划暂停、没有聊天等)静默跳过;规划 API 没填好或请求失败时
 * 在 outlineProgress.autoNote 留一条说明,下次检查成功后清除。满足时弹一次提示。手动检查把原因写进 outlineProgress.error。
 */
export async function checkOutlineProgress(opts: { auto?: boolean } = {}): Promise<boolean> {
  const auto = opts.auto === true;
  if (outlineProgress.busy) return false;
  const ctx = getContext();
  const active = activeStage();
  const fail = (message: string): false => {
    if (!auto) { outlineProgress.error = message; outlineProgress.errorDetail = ''; }
    return false;
  };
  if (!ctx?.getCurrentChatId?.()) return fail('请先打开一个已保存的聊天。');
  if (!engineActiveHere()) return fail('当前角色没有启用棱镜宝书。');
  if (!active) return fail('没有正在生效的规划阶段：规划已暂停、已结束，或剧情改动后需要重新启用。');
  let channel;
  try { channel = resolveOutlineChannel(); } catch (error) {
    const message = error instanceof Error ? error.message : '规划 API 不可用。';
    if (auto) outlineProgress.autoNote = `自动检查推进条件没有运行：${message}`;
    return fail(message);
  }

  const chat = ctx.chat, chatId = ctx.getCurrentChatId(), outlineId = active.id, chapter = active.currentChapter;
  const criteria = active.content.chapters[chapter]?.exitCriteria;
  const floor = chat.length - 1;
  markStage(ctx, active);
  const since = stageMark?.key === stageKey(ctx, active) ? stageMark.floor : undefined;
  const own = ++runId;
  const ctrl = new AbortController();
  controller = ctrl;
  outlineProgress.busy = true;
  outlineProgress.error = '';
  outlineProgress.errorDetail = '';
  // 推进条件在请求期间被手动改过,结果按旧条件判断,同样丢弃
  const current = () => {
    const now = getContext();
    return own === runId && !ctrl.signal.aborted && !!now && now.chat === chat && now.getCurrentChatId?.() === chatId
      && outlineState.active?.id === outlineId && outlineState.active.currentChapter === chapter
      && outlineState.active.content.chapters[chapter]?.exitCriteria === criteria;
  };
  try {
    const input = buildProgressContext(ctx, active, { since: since !== undefined && since < floor ? since : undefined, minMessages: progressMinMessages() });
    const raw = await requestCompletion(channel, input, { signal: ctrl.signal });
    if (!current()) return false;
    const verdict = parseProgressReply(raw);
    Object.assign(outlineProgress, { outlineId, chapter, met: verdict.met, reason: verdict.reason, floor, auto, dismissed: false, autoNote: '' });
    markStage(ctx, active, floor);
    if (auto && verdict.met) {
      if (outlineSettings.progressCheck.autoAdvance && await autoAdvance(active, chapter, verdict, floor)) return true;
      toast(chapter + 1 >= active.content.chapters.length
        ? '规划最后一个阶段的推进条件可能已满足。规划不会自动结束，需要时在「摘要 → 创作规划」中点「结束规划」。'
        : '规划当前阶段的推进条件可能已满足，可在「摘要 → 创作规划」中切换阶段。', 'info');
    }
    return true;
  } catch (error) {
    if (!current()) return false;
    const view = describeFailure(error, '推进条件检查没有完成', outlineApiPath(true));
    if (!auto) {
      outlineProgress.error = view.message;
      outlineProgress.errorDetail = view.detail;
    } else {
      outlineProgress.autoNote = `自动检查推进条件没有完成：${view.message}到下一个检查间隔时会再次检查，也可点击「检查推进条件」手动检查。`;
      console.warn('[棱镜宝书] 自动检查推进条件失败(不影响正文)', error);
    }
    return false;
  } finally {
    if (own === runId) { outlineProgress.busy = false; controller = undefined; }
  }
}

/** 用户点「忽略」:这次结果不再提示,下一次检查照常。 */
export function dismissOutlineProgress(): void {
  outlineProgress.dismissed = true;
}

/** 推进条件被手动修改后:已有的检查结果按旧条件判断,清掉;正在进行的检查到达后也会因条件不同被丢弃。 */
export function clearOutlineProgressResult(): void {
  Object.assign(outlineProgress, { outlineId: '', chapter: -1, met: null, reason: '', floor: -1, auto: false, dismissed: false });
}

function aiCount(ctx: STContext): number {
  return ctx.chat.reduce((n, m) => n + (isAiFloor(m) ? 1 : 0), 0);
}

/** 回复到达后按间隔决定要不要自动检查。第一次只记起点,不立刻检查。 */
export function maybeAutoCheckProgress(): void {
  if (!outlineSettings.progressCheck.auto) { baseline = null; outlineProgress.autoNote = ''; return; }
  const ctx = getContext();
  const active = activeStage();
  if (!ctx || !active) return;
  markStage(ctx, active);
  const key = stageKey(ctx, active);
  const count = aiCount(ctx);
  if (!baseline || baseline.key !== key) { baseline = { key, aiCount: count }; return; }
  if (count - baseline.aiCount < outlineSettings.progressCheck.interval) return;
  baseline = { key, aiCount: count };
  void checkOutlineProgress({ auto: true });
}

let bound = false;
/** 启动链调用一次:回复到达时考虑自动检查;切换阶段时记下本阶段的检查起点;切换聊天时清空结果。 */
export function bindOutlineProgress(): void {
  if (bound) return;
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx.eventTypes) return;
  const received = ctx.eventTypes.MESSAGE_RECEIVED;
  const changed = ctx.eventTypes.CHAT_CHANGED;
  if (received) ctx.eventSource.on(received, () => { try { maybeAutoCheckProgress(); } catch { /* 检查是辅助功能,失败不影响回复 */ } });
  if (changed) ctx.eventSource.on(changed, () => { resetProgress(); baseline = null; });
  watch(() => [outlineState.active?.id, outlineState.active?.currentChapter], () => {
    const now = getContext(), active = outlineState.active;
    if (now?.chat && active && active.currentChapter < active.content.chapters.length) markStage(now, active);
  });
  bound = true;
}
