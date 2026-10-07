import { NpcLocationEvidenceError, validateNpcLocationEvidence } from './npcLocationEvidence';
import { extractJsonObject } from './json';
import { ConditionPatchError, materializeConditionPatches, type ConditionContext } from './conditionPatch';
import type { StoredDelta, SummaryDelta } from './types';

/** 只校验结果合同，不从摘要关键词反推人物/物品/计划变更。 */
export class SummaryResponseError extends Error {}

const stateKeys = ['location', 'locationPath', 'sceneFocus', 'protagonist', 'items', 'scenes', 'npcs', 'plans', 'lifeDetails', 'vars'] as const;
const groups = ['items', 'scenes', 'npcs', 'plans', 'lifeDetails'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseSummaryResponse(raw: string, options: {
  maxChars?: number;
  sourceContent?: string;
  conditionContext?: ConditionContext;
  requireStateChanges: boolean;
  finalize: (delta: SummaryDelta) => StoredDelta;
}): SummaryDelta & { summary: string } {
  const parsed = extractJsonObject<unknown>(raw);
  if (!record(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new SummaryResponseError('摘要结果必须是根对象，且包含非空字符串 summary。');
  }
  const summary = parsed.summary.trim();
  const length = Array.from(summary).length;
  if (options.maxChars && length > options.maxChars) {
    throw new SummaryResponseError(
      'summary 共 ' + length + ' 字符，超过 ' + options.maxChars + ' 字符上限（含标点）。请先删不影响后续的细节、合并重复约定，再用完整短句重写；保留关键条件、否定、说话人、因果路径与结果，不靠删虚词堆成电报。完整重写 JSON，不截断句子或删掉状态更新。',
    );
  }
  if ('delta' in parsed || 'updates' in parsed) {
    throw new SummaryResponseError('状态更新必须与 summary 并列放在根对象，不要包进 delta 或 updates。');
  }
  if ('conditionPatch' in parsed) throw new SummaryResponseError('conditionPatch 必须放在对应 protagonist 或 NPC 对象内。');
  const npcOps = record(parsed.npcs) ? parsed.npcs : {};
  const hasPatch = record(parsed.protagonist) && 'conditionPatch' in parsed.protagonist ||
    ['add', 'update'].some(op => {
      const entries = npcOps[op];
      return Array.isArray(entries) && entries.some(v => record(v) && 'conditionPatch' in v);
    });
  if (hasPatch && !options.conditionContext) throw new SummaryResponseError('conditionPatch 缺少本楼前状态，不能静默丢弃操作。');
  if (options.conditionContext) {
    try { materializeConditionPatches(parsed, options.conditionContext); }
    catch (error) {
      if (error instanceof ConditionPatchError) throw new SummaryResponseError(error.message);
      throw error;
    }
  }
  try { validateNpcLocationEvidence(parsed, { strict: options.requireStateChanges, content: options.sourceContent }); }
  catch (error) {
    if (error instanceof NpcLocationEvidenceError) throw new SummaryResponseError(error.message);
    throw error;
  }
  // 内置 add 是明确转入量；未知数量不能被派生层的历史兼容默认值变成“获得1”。
  // 不从名称或描述关键词猜交易方向；自定义旧模板和已存历史仍沿用原合同。
  if (options.requireStateChanges && record(parsed.items) && Array.isArray(parsed.items.add)) {
    for (const entry of parsed.items.add) {
      if (!record(entry) || typeof entry.qty !== 'number' || !Number.isFinite(entry.qty) || entry.qty <= 0) {
        throw new SummaryResponseError('items.add.qty 必须是明确的有限正数，表示本楼实际转入量，不是余额。先核对谁给谁；支付、赠出、归还不能记成获得。原库存或余额未知时不要为记录支出而新增物品，不得猜1；把交易保留在 summary。已知库存转出用 update 写剩余总量，全部转出用 remove。请重新核对事实并重写完整 JSON。');
      }
    }
  }
  const delta = { ...parsed, summary } as SummaryDelta & { summary: string };
  const stored = options.finalize(delta);
  for (const key of (options.requireStateChanges || 'stateChanges' in parsed) ? groups : []) {
    if (!(key in parsed)) continue;
    const group = parsed[key];
    if (!record(group)) throw new SummaryResponseError(key + ' 必须是包含操作数组的对象。');
    const cleaned = stored[key] as Record<string, unknown> | undefined;
    const allowed = key === 'items' || key === 'npcs' ? ['add', 'update', 'remove']
      : key === 'scenes' ? ['add', 'update', 'reparent']
      : key === 'plans' ? ['add', 'update', 'resolve'] : ['add', 'update', 'archive', 'remove'];
    for (const [op, values] of Object.entries(group)) {
      if (!allowed.includes(op) || !Array.isArray(values)) {
        throw new SummaryResponseError(key + '.' + op + ' 不是合法操作数组，请使用模板规定的字段。');
      }
      const kept = cleaned?.[op];
      if (values.length !== (Array.isArray(kept) ? kept.length : 0)) {
        throw new SummaryResponseError(key + '.' + op + ' 含无效条目，请核对必填名称、字段类型及当前编号；不能只保留摘要而丢弃操作。');
      }
    }
  }
  // 同一短编号的不同写法在固化后归一，禁止一楼重复调整或边调整边结案。
  const updatedPlans = stored.plans?.update ?? [];
  const resolvedIds = new Set((stored.plans?.resolve ?? []).map(r => typeof r === 'string' ? r : r.id));
  if (new Set(updatedPlans.map(p => p.id)).size !== updatedPlans.length || updatedPlans.some(p => resolvedIds.has(p.id))) {
    throw new SummaryResponseError('同一计划每楼只能 update 一次，且不可同时 update 与 resolve。暂缓/改期用 update；明确完成、取消或失败才 resolve。');
  }
  if (options.requireStateChanges || 'stateChanges' in parsed) {
    const declared = parsed.stateChanges;
    if (!Array.isArray(declared) || declared.some(k => typeof k !== 'string' || !(stateKeys as readonly string[]).includes(k))) {
      throw new SummaryResponseError('必须填写 stateChanges 数组，列出实际输出的状态字段名；确实无变化才填 []。它不含 summary 和时间字段，不能代替具体更新。');
    }
    const actual = stateKeys.filter(k => (k === 'vars' ? 'varOps' : k) in stored);
    if (new Set(declared).size !== declared.length || actual.length !== declared.length || actual.some(k => !declared.includes(k))) {
      throw new SummaryResponseError('stateChanges 与有效状态字段不一致，请补齐对应更新或更正清单；写入 summary 不等于更新档案。');
    }
  }
  return delta;
}
