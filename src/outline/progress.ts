/**
 * 规划推进条件检查:判断当前阶段的推进条件是否已在正文中满足。
 *
 * 只读:不改大纲、不切阶段、不写记忆;结果存在内存里,只作提示,阶段仍由用户手动切换。
 * 手动检查随时可用;自动检查默认关,开启后每隔 N 个 AI 楼检查一次。都用规划的 API。
 * 生成期间聊天、大纲或当前阶段变了,迟到的结果丢弃。
 */
import { reactive } from 'vue';
import { requestCompletion, type ChatMsg } from '@/api/client';
import { describeFailure } from '@/api/errors';
import { engineActiveHere } from '@/api/settings';
import { getContext, type STContext } from '@/st/context';
import { toast } from '@/st/toast';
import { cleanBody } from '@/memory/timeTag';
import { extractJsonObject } from '@/memory/json';
import { isAiFloor } from '@/memory/engine';
import { OUTLINE_PROGRESS_PROMPT } from './prompt';
import { outlineSettings, resolveOutlineChannel } from './settings';
import { outlineSourceCurrent, outlineState, outlineStorageCurrent } from './store';
import type { OutlineActive } from './types';

export interface ProgressVerdict {
  met: boolean;
  reason: string;
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
});

let controller: AbortController | undefined;
let runId = 0;
/** 自动检查的计数起点:同一聊天、同一大纲同一阶段内,AI 楼数比起点多出 interval 才检查 */
let baseline: { key: string; aiCount: number } | null = null;

function resetProgress(): void {
  ++runId;
  controller?.abort();
  controller = undefined;
  Object.assign(outlineProgress, { busy: false, outlineId: '', chapter: -1, met: null, reason: '', floor: -1, auto: false, dismissed: false, error: '', errorDetail: '' });
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

/** 核对请求:当前阶段(目标、要点、推进条件) + 最近 6 条正文与用户原话。 */
export function buildProgressContext(ctx: STContext, active: OutlineActive): ChatMsg[] {
  const chapter = active.content.chapters[active.currentChapter];
  if (!chapter) throw new Error('当前没有进行中的规划阶段。');
  const stage = `[当前规划阶段：第 ${active.currentChapter + 1} / ${active.content.chapters.length} 阶段 · ${chapter.title}]\n`
    + `阶段目标：${chapter.goal}\n剧情要点（计划，不代表已发生）：\n${chapter.beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    + `推进条件：${chapter.exitCriteria}`;
  const rows: string[] = [];
  let budget = 10000;
  const recent = ctx.chat.map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.extra?.bbs_internal_notice && !m.extra?.bbs_omit && (!m.is_system || m.extra?.bbs_hidden))
    .slice(-6);
  for (const { m, i } of [...recent].reverse()) {
    const body = cleanBody(m.mes ?? '');
    if (!body) continue;
    const row = `第${i}楼 ${m.is_user ? '用户' : '正文'}：\n${clip(body, Math.min(3000, budget))}`;
    if (budget - row.length < 0 && rows.length) break;
    budget -= row.length;
    rows.unshift(row);
  }
  return [
    { role: 'system', content: OUTLINE_PROGRESS_PROMPT },
    { role: 'user', content: `${stage}\n\n[最近正文与用户原话，按楼层排序]\n${rows.join('\n\n') || '（无）'}` },
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

/**
 * 检查一次。auto=true 时静默跳过前置条件不满足的情况(比如规划 API 没配好),不显示错误;
 * 满足时弹一次提示。手动检查把原因写进 outlineProgress.error。
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
  try { channel = resolveOutlineChannel(); } catch (error) { return fail(error instanceof Error ? error.message : '规划 API 不可用。'); }

  const chat = ctx.chat, chatId = ctx.getCurrentChatId(), outlineId = active.id, chapter = active.currentChapter;
  const floor = chat.length - 1;
  const own = ++runId;
  const ctrl = new AbortController();
  controller = ctrl;
  outlineProgress.busy = true;
  outlineProgress.error = '';
  outlineProgress.errorDetail = '';
  const current = () => {
    const now = getContext();
    return own === runId && !ctrl.signal.aborted && !!now && now.chat === chat && now.getCurrentChatId?.() === chatId
      && outlineState.active?.id === outlineId && outlineState.active.currentChapter === chapter;
  };
  try {
    const raw = await requestCompletion(channel, buildProgressContext(ctx, active), { signal: ctrl.signal });
    if (!current()) return false;
    const verdict = parseProgressReply(raw);
    Object.assign(outlineProgress, { outlineId, chapter, met: verdict.met, reason: verdict.reason, floor, auto, dismissed: false });
    if (auto && verdict.met) toast('规划当前阶段的推进条件可能已满足，可在「摘要 → 当前局势与计划」中切换阶段。', 'info');
    return true;
  } catch (error) {
    if (!current()) return false;
    if (!auto) {
      const view = describeFailure(error, '推进条件检查没有完成', outlineSettings.apiMode === 'notes' ? '札记 → 独立 API 设置（规划目前复用札记的 API）' : '计划 → 规划 API 设置');
      outlineProgress.error = view.message;
      outlineProgress.errorDetail = view.detail;
    } else {
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

function aiCount(ctx: STContext): number {
  return ctx.chat.reduce((n, m) => n + (isAiFloor(m) ? 1 : 0), 0);
}

/** 回复到达后按间隔决定要不要自动检查。第一次只记起点,不立刻检查。 */
export function maybeAutoCheckProgress(): void {
  if (!outlineSettings.progressCheck.auto) { baseline = null; return; }
  const ctx = getContext();
  const active = activeStage();
  if (!ctx || !active) return;
  const key = `${ctx.getCurrentChatId?.() ?? ''}|${active.id}|${active.currentChapter}`;
  const count = aiCount(ctx);
  if (!baseline || baseline.key !== key) { baseline = { key, aiCount: count }; return; }
  if (count - baseline.aiCount < outlineSettings.progressCheck.interval) return;
  baseline = { key, aiCount: count };
  void checkOutlineProgress({ auto: true });
}

let bound = false;
/** 启动链调用一次:回复到达时考虑自动检查;切换聊天时清空结果。 */
export function bindOutlineProgress(): void {
  if (bound) return;
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx.eventTypes) return;
  const received = ctx.eventTypes.MESSAGE_RECEIVED;
  const changed = ctx.eventTypes.CHAT_CHANGED;
  if (received) ctx.eventSource.on(received, () => { try { maybeAutoCheckProgress(); } catch { /* 检查是辅助功能,失败不影响回复 */ } });
  if (changed) ctx.eventSource.on(changed, () => { resetProgress(); baseline = null; });
  bound = true;
}
