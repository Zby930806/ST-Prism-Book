/**
 * 楼层上的召回记录:生成这条回复前召回了什么,存在回复消息的 extra.bbs_recall 里,楼层面板据此显示。
 *
 * - 只在启用楼层面板时记录;只存显示要用的(来源、故事时间、全文/摘要、摘要预览),不存注入原文。
 * - 记录带生成时的 swipe 页码:ST 生成新 swipe 时会复制上一页的 extra,页码对不上就不显示(同 leafValid)。
 * - 归属:拦截器在召回结束后登记(armFloorRecall),这次生成的回复到达(MESSAGE_RECEIVED)时写入。
 *   要求同一聊天、同一生成类型、是最后一条消息且是真实 AI 楼,任一不符就不写,宁可缺记录也不写错楼。
 * - 已有楼层不补记录:旧回复生成时召回了什么已经无从得知。
 */
import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { memoryWriteIssue } from '../store';
import { isRealAiReply } from '../engine';
import { recallDebug, recallDebugWrites, snapshotRecallDebug, type RecallDebug } from './debug';
import { recalledItems, recallPhase } from './recallView';

export const FLOOR_RECALL_KEY = 'bbs_recall';
const MAX_ITEMS = 50;
// 登记后超过这么久还没等到回复,当作这次生成没产出消息(失败/中止),作废
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface FloorRecallItem {
  /** 本聊天的楼层号「#120」,或旧档 */
  source: string;
  storyTime: string;
  tier: 'full' | 'brief';
  preview: string;
}

export interface FloorRecallRecord {
  v: 1;
  /** 召回时刻(Date.now) */
  at: number;
  /** 生成这条回复时所在的 swipe 页码 */
  swipe: number;
  /** 状态文案,同 recallDebug.status */
  status: string;
  /** 实际注入的段落;没召回或失败时为空 */
  items: FloorRecallItem[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function msgSwipe(m: STMessage): number {
  return typeof m.swipe_id === 'number' ? m.swipe_id : 0;
}

/** 从调试快照生成楼层记录。 */
export function floorRecallFromDebug(d: RecallDebug, swipe: number): FloorRecallRecord {
  return {
    v: 1,
    at: d.at || Date.now(),
    swipe,
    status: d.status,
    items: recalledItems(d).map(({ source, storyTime, tier, preview }) => ({ source, storyTime, tier, preview })),
  };
}

/** 读某楼当前页的召回记录;没有、格式不对或属于别的 swipe 页时返回 null。 */
export function readFloorRecall(m: STMessage | undefined): FloorRecallRecord | null {
  if (!m) return null;
  const raw = m.extra?.[FLOOR_RECALL_KEY];
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.status !== 'string' || !raw.status) return null;
  const swipe = typeof raw.swipe === 'number' ? raw.swipe : 0;
  if (swipe !== msgSwipe(m)) return null;
  const items: FloorRecallItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : []) {
    if (!isRecord(it) || (it.tier !== 'full' && it.tier !== 'brief')) continue;
    items.push({
      source: typeof it.source === 'string' && it.source ? it.source : '旧档',
      storyTime: typeof it.storyTime === 'string' ? it.storyTime : '',
      tier: it.tier,
      preview: typeof it.preview === 'string' ? it.preview : '',
    });
  }
  return { v: 1, at: typeof raw.at === 'number' ? raw.at : 0, swipe, status: raw.status, items };
}

/* ============ 生成 → 回复的归属 ============ */

interface PendingRecall {
  chat: STMessage[];
  chatId: string | undefined;
  type: string;
  debug: RecallDebug;
  armedAt: number;
}
let pending: PendingRecall | null = null;

const typeOf = (type: unknown) => (typeof type === 'string' && type ? type : 'normal');

/**
 * 每次生成开始时调用,作废上一轮没用上的登记(比如上次生成失败、没产出回复)。
 * quiet/impersonate 不产生 AI 楼层,而且 quiet 可能在正文生成途中由别的插件发起,不能动登记。
 */
export function beginGenerationRecall(type: string | undefined): void {
  if (type === 'quiet' || type === 'impersonate') return;
  pending = null;
}

/** 召回结束后调用:召回确实跑过(快照写入计数变了)且已出结果,就登记给本次生成的回复。 */
export function armFloorRecall(type: string | undefined, writesBefore: number): void {
  if (recallDebugWrites() === writesBefore) return; // 没跑(未启用向量记忆等)
  const phase = recallPhase(recallDebug);
  if (phase === 'none' || phase === 'running') return;
  const ctx = getContext();
  if (!ctx) return;
  pending = { chat: ctx.chat, chatId: ctx.getCurrentChatId?.(), type: typeOf(type), debug: snapshotRecallDebug(), armedAt: Date.now() };
}

/** MESSAGE_RECEIVED:把登记的召回写到这条回复上。写入返回 true。 */
export function attachFloorRecall(messageId: unknown, type: unknown): boolean {
  const p = pending;
  if (!p) return false;
  if (Date.now() - p.armedAt > PENDING_TTL_MS) {
    pending = null;
    return false;
  }
  if (typeOf(type) !== p.type) return false; // 别的来源的消息(脚本插入等),继续等本次回复
  pending = null;
  const ctx = getContext();
  if (!ctx || ctx.chat !== p.chat || ctx.getCurrentChatId?.() !== p.chatId) return false;
  const idx = Number(messageId);
  if (!Number.isInteger(idx) || idx !== ctx.chat.length - 1) return false;
  const m = ctx.chat[idx];
  if (!isRealAiReply(m)) return false;
  if (!apiSettings.ui.showFloorPanel || memoryWriteIssue() || !engineActiveHere()) return false;
  m.extra = m.extra ?? {};
  m.extra[FLOOR_RECALL_KEY] = floorRecallFromDebug(p.debug, msgSwipe(m));
  return true;
}

let bound = false;
/** 启动链调用一次:监听回复到达。ST 在这之后保存聊天,记录随聊天落盘。 */
export function bindFloorRecall(): void {
  if (bound) return;
  const ctx = getContext();
  const name = ctx?.eventTypes?.MESSAGE_RECEIVED;
  if (!ctx?.eventSource || !name) return;
  ctx.eventSource.on(name, (id: unknown, type: unknown) => {
    try {
      attachFloorRecall(id, type);
    } catch (e) {
      console.warn('[棱镜宝书] 记录本楼召回失败(不影响回复)', e);
    }
  });
  bound = true;
}
