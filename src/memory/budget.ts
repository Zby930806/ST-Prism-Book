import { apiSettings } from '@/api/settings';
import { LEDGER_PROTOCOL } from './ledgerProtocol';

/** 仅约束棱镜宝书自己的注入正文,不是模型 tokenizer 的精确计费。 */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3.35);
}
export type BudgetSlot = 'history' | 'state' | 'timeTag' | 'recall' | 'ledger';
const shares: Record<Exclude<BudgetSlot, 'ledger'>, number> = { history: 0.45, state: 0.35, timeTag: 0.05, recall: 0.15 };
export function slotBudget(slot: BudgetSlot): number {
  const raw = Number(apiSettings.memoryBudgetTokens);
  if (raw === 0) return Infinity;
  const total = Number.isFinite(raw) ? Math.max(2000, Math.min(50000, Math.floor(raw))) : 6000;
  // 从状态份额预留不可拆的只读协议,不挤掉时间协议,也不额外突破总预算。
  const ledger = estimateTokens(LEDGER_PROTOCOL);
  if (slot === 'ledger') return ledger;
  return Math.max(0, Math.floor(total * shares[slot]) - (slot === 'state' ? ledger : 0));
}
export const BUDGET_NOTICE = '[部分记忆因注入预算未展示;未展示不代表不存在,不可据此断言。]';
/** 按完整语义单元选择,绝不切断台词、否定条件或变量 JSON。 */
export function fitMemoryUnits(units: string[], slot: BudgetSlot, prefix = '', suffix = '', newestFirst = false): { text: string; indices: number[] } {
  const limit = slotBudget(slot);
  const render = (ids: number[], omitted: boolean) => [prefix, ...ids.map(i => units[i]), omitted ? BUDGET_NOTICE : '', suffix].filter(Boolean).join('\n\n');
  const all = units.map((_, i) => i);
  const full = render(all, false);
  if (!units.length) return { text: '', indices: [] };
  if (estimateTokens(full) <= limit) return { text: full, indices: all };
  const indices: number[] = [];
  for (const i of newestFirst ? [...all].reverse() : all) {
    const candidate = [...indices, i].sort((a, b) => a - b);
    if (estimateTokens(render(candidate, true)) <= limit) indices.push(i);
  }
  indices.sort((a, b) => a - b);
  const text = render(indices, true);
  return { text: estimateTokens(text) <= limit ? text : '', indices };
}
/** 时间标签指令是一个不可拆的协议;超出份额时整块不注入。 */
export function fitTimeTagPrompt(text: string): string {
  return estimateTokens(text) <= slotBudget('timeTag') ? text : '';
}
