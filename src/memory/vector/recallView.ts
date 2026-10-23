/**
 * 召回结果的显示逻辑:快捷回复栏的「召回」按钮、召回速览弹层和楼层面板共用。纯函数。
 * 上次召回读调试快照(recallDebug);楼层面板读存在消息里的召回记录(floorRecall.ts)。
 */
import { RECALL_DONE_OVER_BUDGET, RECALL_STOPPED, type RecallDebug } from './debug';
import type { FloorRecallRecord } from './floorRecall';

export type RecallPhase = 'none' | 'running' | 'done' | 'skipped' | 'failed';

export interface RecallPeekItem {
  key: string;
  /** 本聊天的楼层号「#120」,或旧档 */
  source: string;
  storyTime: string;
  tier: 'full' | 'brief';
  /** 注入的是全文还是摘要 */
  tierLabel: string;
  preview: string;
}

/** 召回走到了哪一步(只看状态文案,调试快照和楼层记录通用)。 */
export function recallPhase(d: { status: string }): RecallPhase {
  if (!d.status) return 'none';
  if (d.status.startsWith('进行中')) return 'running';
  if (d.status.startsWith('召回完成')) return 'done';
  if (d.status.startsWith('失败')) return 'failed';
  return 'skipped';
}

const tierLabel = (tier: 'full' | 'brief') => (tier === 'full' ? '全文' : '摘要');

/** 这次实际注入的几段(全文或摘要),按重排后的顺序;未达阈值被丢弃的不算。只在召回完成时有。 */
export function recalledItems(d: RecallDebug): RecallPeekItem[] {
  if (recallPhase(d) !== 'done') return [];
  return d.rerank
    .filter((h): h is typeof h & { tier: 'full' | 'brief' } => h.tier === 'full' || h.tier === 'brief')
    .map((h, i) => ({
      key: `${h.leafId}:${i}`,
      source: h.source || '旧档',
      storyTime: h.storyTime,
      tier: h.tier,
      tierLabel: tierLabel(h.tier),
      preview: h.preview,
    }));
}

/** 达到阈值、但放不进召回预算而没有注入的段数。 */
export function recallCutCount(d: RecallDebug): number {
  return recallPhase(d) === 'done' ? d.rerank.filter(h => h.tier === 'cut').length : 0;
}

const SKIP_REASONS: Array<[string, string]> = [
  ['未召回:楼层未达起召门槛或全在窗口内', '未召回：AI 楼数未达到「开始召回的 AI 楼数」，或相关内容仍在最近楼层的全文范围内。'],
  ['未召回:查询重写未产出 query', '未召回：查询重写没有生成检索问题。'],
  ['未召回:检索无候选', '未召回：没有检索到相关内容。'],
  ['未召回:已取消或保护状态变化', '未召回：召回已取消（例如切换了聊天）。'],
  [RECALL_STOPPED, '未召回：已停止生成，本次召回随之取消。'],
];

const RAISE_BUDGET = '可在「设置 → 注入设置」中调高「记忆注入预算」，或填 0 不限制。';

/** 去掉句末的句号,便于后面再接一句;避免出现「。。」。 */
function trimPeriod(text: string): string {
  return text.trim().replace(/[。.]+$/, '');
}

/** 召回完成时的说明:注入了几段,有没有因为预算没放进去的。 */
function doneSentence(base: string, count: number, cut: number): string {
  if (count) return `召回 ${count} 段，已注入本次生成。` + (cut ? `另有 ${cut} 段超出召回预算，未注入。` : '');
  if (base === RECALL_DONE_OVER_BUDGET) return `召回完成，达到阈值的${cut ? ` ${cut} 段` : '内容'}超出召回预算，本次未注入。${RAISE_BUDGET}`;
  return '召回完成，没有达到阈值的内容，本次未注入。';
}

/** 把状态文案和注入段数换成一句说明。 */
function statusSentence(status: string, count: number, cut = 0): string {
  const cached = status.endsWith('(复用缓存)');
  const base = cached ? status.slice(0, -'(复用缓存)'.length) : status;
  const cacheNote = cached ? '上下文与上次相同，复用了上次的结果。' : '';
  switch (recallPhase({ status })) {
    case 'none':
      return '当前聊天尚未召回。启用向量记忆后，每次生成回复前自动召回。';
    case 'running':
      return '正在召回，完成后开始生成回复；点酒馆的停止键可以取消。';
    case 'done':
      return doneSentence(base, count, cut) + cacheNote;
    case 'failed':
      return `召回失败：${trimPeriod(base.replace(/^失败[:：]\s*/, ''))}。本次生成未注入召回内容。`;
    default: {
      const known = SKIP_REASONS.find(([raw]) => base === raw);
      return (known ? known[1] : base.replace(':', '：')) + cacheNote;
    }
  }
}

/** 重排和索引方面的补充说明(召回完成或失败时才接在后面)。 */
function noteSentences(phase: RecallPhase, notes: { rerankIssue?: string; indexNote?: string }): string {
  if (phase !== 'done' && phase !== 'failed') return '';
  return [phase === 'done' ? notes.rerankIssue : '', notes.indexNote].filter(Boolean).join('');
}

/** 上次召回的一句说明。 */
export function recallStatusText(d: RecallDebug): string {
  const phase = recallPhase(d);
  if (phase === 'running' && (d.indexPending ?? 0) > 0) {
    return `正在补建向量索引（剩余 ${d.indexPending} 条），完成后召回并开始生成回复；点酒馆的停止键可以取消。`;
  }
  return statusSentence(d.status, recalledItems(d).length, recallCutCount(d)) + noteSentences(phase, d);
}

/** 快捷回复栏按钮上的字和悬停说明。 */
export function recallButtonLabel(d: RecallDebug): { text: string; title: string } {
  const phase = recallPhase(d);
  const title = recallStatusText(d);
  if (phase === 'none') return { text: '召回', title };
  if (phase === 'running') return { text: (d.indexPending ?? 0) > 0 ? '补索引中…' : '召回中…', title };
  if (phase === 'done') return { text: `召回 ${recalledItems(d).length}`, title: `${title}点击查看内容。` };
  return { text: phase === 'failed' ? '召回失败' : '未召回', title };
}

export interface FloorRecallView {
  phase: RecallPhase;
  statusText: string;
  items: RecallPeekItem[];
}

/** 楼层面板:生成本楼前的召回记录换成显示内容。没有记录返回 null。 */
export function floorRecallView(rec: FloorRecallRecord | null): FloorRecallView | null {
  if (!rec) return null;
  const phase = recallPhase(rec);
  const items = phase === 'done'
    ? rec.items.map((it, i) => ({ key: String(i), source: it.source, storyTime: it.storyTime, tier: it.tier, tierLabel: tierLabel(it.tier), preview: it.preview }))
    : [];
  const statusText = statusSentence(rec.status, items.length, phase === 'done' ? rec.cut ?? 0 : 0) + noteSentences(phase, rec);
  return { phase, statusText, items };
}
