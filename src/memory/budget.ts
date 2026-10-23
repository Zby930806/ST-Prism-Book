import { apiSettings } from '@/api/settings';
import { getContext } from '@/st/context';
import { chatShowsLedgerTags, LEDGER_PROTOCOL } from './ledgerProtocol';
import { formatRange, TIME_TAG_PROMPT, timeTagBaselineLine, timeTagPrompt } from './timeTag';
import { isAiFloor, resolveKeepStart } from './engine';
import { currentBundleHashes, currentVectorDb } from './vector/scope';

/** 仅约束棱镜宝书自己的注入正文,不是模型 tokenizer 的精确计费。 */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3.35);
}
export type BudgetSlot = 'history' | 'state' | 'timeTag' | 'recall' | 'ledger';

/**
 * 填写了「记忆注入预算」时各部分的份额(0 或无法识别 = 不限制,各部分都是 Infinity):
 *  1. 先按实际长度预留时间标签指令(开启自动摘要时)和只读账本说明(发给正文模型的消息里有旁注时)。
 *     时间指令的上限取「内置指令 + 当前主线时间基准行」与总额 5% 中较大者:内置指令总能放下,
 *     超出上限的自定义指令整段不发送(设置页会提示)。
 *  2. 剩余部分按 历史 45%、状态 40%、召回 15% 分配。状态的 40% 含原来的时间份额 5%:
 *     时间指令已单独预留,关闭自动摘要时也不再占用。向量记忆关闭或本聊天不召回时,召回的 15% 并入历史。
 */
export interface BudgetLayout {
  /** 规整后的总预算;0 = 不限制 */
  total: number;
  history: number;
  state: number;
  recall: number;
  /** 时间指令可用的上限(fitTimeTagPrompt 按它判断);实际预留见 timeTagReserved */
  timeTag: number;
  timeTagReserved: number;
  ledger: number;
  ledgerReserved: number;
  /** 本聊天这次生成前是否可能召回;否则召回份额已并入历史 */
  recallActive: boolean;
}
const SHARES = { history: 0.45, state: 0.4, recall: 0.15 } as const;
const TIME_TAG_SHARE = 0.05;

/** 填写的总预算(按 2000–50000 规整);0(默认)或无法识别的值都按不限制处理。 */
export function budgetTotal(): number {
  const raw = Number(apiSettings.memoryBudgetTokens);
  if (raw === 0 || !Number.isFinite(raw)) return 0;
  return Math.max(2000, Math.min(50000, Math.floor(raw)));
}

/**
 * 本聊天这次生成前会不会召回:与 vector/recall.ts 的跳过条件同口径(向量记忆关闭、群聊、
 * 没有带入的旧档且没有楼层被推出保留窗口、AI 楼数未达「开始召回的 AI 楼数」时都不召回)。
 * 取不到聊天时按会召回处理,不挪份额。
 */
export function recallMayRun(): boolean {
  if (!apiSettings.vector?.enabled) return false;
  const chat = getContext()?.chat;
  if (!chat) return true;
  if (!currentVectorDb()) return false;
  if (currentBundleHashes().length > 0) return true;
  if (resolveKeepStart(chat) === 0) return false;
  const min = Math.max(0, Math.floor(Number(apiSettings.vector.recall?.minAiFloors) || 0));
  return !(min > 0 && chat.filter(m => isAiFloor(m)).length < min);
}

/** 当前的份额分配;每次按最新的设置和聊天现算。 */
export function budgetLayout(): BudgetLayout {
  const total = budgetTotal();
  const ledger = estimateTokens(LEDGER_PROTOCOL);
  const recallActive = recallMayRun();
  if (!total) {
    return { total: 0, history: Infinity, state: Infinity, recall: Infinity, timeTag: Infinity, timeTagReserved: 0, ledger: Infinity, ledgerReserved: 0, recallActive };
  }
  const timeTag = Math.max(estimateTokens(TIME_TAG_PROMPT + timeTagBaselineLine()), Math.floor(total * TIME_TAG_SHARE));
  const timeTagActual = estimateTokens(timeTagPrompt());
  const timeTagReserved = apiSettings.autoSummaryEnabled && timeTagActual <= timeTag ? timeTagActual : 0;
  const ledgerReserved = chatShowsLedgerTags(getContext()?.chat) ? ledger : 0;
  const pool = Math.max(0, total - timeTagReserved - ledgerReserved);
  return {
    total,
    history: Math.floor(pool * (SHARES.history + (recallActive ? 0 : SHARES.recall))),
    state: Math.floor(pool * SHARES.state),
    recall: Math.floor(pool * SHARES.recall),
    timeTag,
    timeTagReserved,
    ledger,
    ledgerReserved,
    recallActive,
  };
}

export function slotBudget(slot: BudgetSlot): number {
  return budgetLayout()[slot];
}

export const BUDGET_NOTICE = '[部分记忆因注入预算未展示;未展示不代表不存在,不可据此断言。]';

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** 与 estimateTokens([...].filter(Boolean).join('\n\n')) 相同的结果,按各段字节数直接算,不拼接字符串。 */
function joinedTokens(lengths: number[]): number {
  let bytes = 0;
  let parts = 0;
  for (const n of lengths) {
    if (n <= 0) continue;
    bytes += n;
    parts++;
  }
  return Math.ceil((bytes + Math.max(0, parts - 1) * 2) / 3.35);
}

/**
 * 按完整语义单元选择,绝不切断台词、否定条件或变量 JSON。
 * newestFirst=false(状态块):按优先顺序逐条尝试,放不下的整条跳过;
 * newestFirst=true:从新到旧连续保留,遇到第一条放不下的就停,保证近期部分连续。
 */
export function fitMemoryUnits(units: string[], slot: BudgetSlot, prefix = '', suffix = '', newestFirst = false): { text: string; indices: number[] } {
  const limit = slotBudget(slot);
  if (!units.length) return { text: '', indices: [] };
  const render = (ids: number[], omitted: boolean) => [prefix, ...ids.map(i => units[i]), omitted ? BUDGET_NOTICE : '', suffix].filter(Boolean).join('\n\n');
  const all = units.map((_, i) => i);
  const sizes = units.map(byteLength);
  const fixed = [byteLength(prefix), byteLength(suffix)];
  if (joinedTokens([...fixed, ...sizes]) <= limit) return { text: render(all, false), indices: all };
  const notice = byteLength(BUDGET_NOTICE);
  const kept: number[] = [];
  const fits = (i: number) => joinedTokens([...fixed, notice, ...kept.map(k => sizes[k]), sizes[i]]) <= limit;
  if (newestFirst) {
    for (let i = units.length - 1; i >= 0 && fits(i); i--) kept.push(i);
  } else {
    for (const i of all) if (fits(i)) kept.push(i);
  }
  kept.sort((a, b) => a - b);
  const text = render(kept, true);
  return { text: estimateTokens(text) <= limit ? text : '', indices: kept };
}

/** 历史块的一个单元。 */
export interface HistoryUnit {
  text: string;
  /** 覆盖故事开头的最高层总结:不超过历史份额约 1/3 时优先保留 */
  opening?: boolean;
  /** 这一段的起止时间,用于在省略提示里写出缺失的时间段 */
  start?: string;
  end?: string;
}

/** 被省略的一段历史(下标 lo..hi,含两端)的提示:写出缺了哪段时间;时间都不知道时用通用说法。 */
function historyNotice(units: HistoryUnit[], lo: number, hi: number): string {
  if (hi < lo) return '';
  let start = '';
  let end = '';
  for (let i = lo; i <= hi && !start; i++) start = units[i].start?.trim() || units[i].end?.trim() || '';
  for (let i = hi; i >= lo && !end; i--) end = units[i].end?.trim() || units[i].start?.trim() || '';
  const range = formatRange(start, end);
  return range ? `[因注入预算未展示 ${hi - lo + 1} 段记忆(${range});未展示不代表不存在,不可据此断言。]` : BUDGET_NOTICE;
}

/**
 * 历史块按预算取舍(只在填写了预算、全部放不下时裁剪):
 *  - 覆盖故事开头的最高层总结先保留,前提是它不超过历史份额的约 1/3;
 *  - 其余单元从新到旧连续保留,遇到第一条放不下的就停,不在时间线中间留空洞;
 *  - 省略提示放在缺口处,写出被省略那段的时间范围。
 */
export function fitHistoryUnits(units: HistoryUnit[], prefix = '', suffix = ''): { text: string; indices: number[] } {
  const limit = slotBudget('history');
  if (!units.length) return { text: '', indices: [] };
  const n = units.length;
  const sizes = units.map(u => byteLength(u.text));
  const fixed = [byteLength(prefix), byteLength(suffix)];
  const all = units.map((_, i) => i);
  if (joinedTokens([...fixed, ...sizes]) <= limit) {
    return { text: [prefix, ...units.map(u => u.text), suffix].filter(Boolean).join('\n\n'), indices: all };
  }
  const pinned = units[0].opening && estimateTokens(units[0].text) <= limit / 3 ? [0] : [];
  const lowest = pinned.length;
  const pinnedBytes = pinned.map(i => sizes[i]);
  // 已保留的近期单元为 [start, n);逐个往前加
  let start = n;
  let recentBytes: number[] = [];
  while (start - 1 >= lowest) {
    const candidate = start - 1;
    const notice = historyNotice(units, lowest, candidate - 1);
    if (joinedTokens([...fixed, ...pinnedBytes, byteLength(notice), sizes[candidate], ...recentBytes]) > limit) break;
    recentBytes = [sizes[candidate], ...recentBytes];
    start = candidate;
  }
  const recent = all.slice(start);
  const notice = historyNotice(units, lowest, start - 1);
  const text = [prefix, ...pinned.map(i => units[i].text), notice, ...recent.map(i => units[i].text), suffix].filter(Boolean).join('\n\n');
  return { text: estimateTokens(text) <= limit ? text : '', indices: [...pinned, ...recent] };
}

/** 时间标签指令是一个不可拆的协议;超出上限时整块不注入。 */
export function fitTimeTagPrompt(text: string): string {
  return estimateTokens(text) <= slotBudget('timeTag') ? text : '';
}
