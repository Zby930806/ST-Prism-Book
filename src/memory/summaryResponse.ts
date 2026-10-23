import { NpcLocationEvidenceError, validateNpcLocationEvidence } from './npcLocationEvidence';
import { NpcRenameError, validateNpcRenames } from './npcRename';
import { extractJsonObject } from './json';
import { ConditionPatchError, materializeConditionPatches, type ConditionContext } from './conditionPatch';
import type { StoredDelta, SummaryDelta } from './types';

/**
 * 只校验结果合同，不从摘要关键词反推人物/物品/计划变更。
 * 篇幅不在这里拒收：字数要求写在提示词里，模型数不准字数，写超了照常保存，不因此让整楼失败。
 */
export class SummaryResponseError extends Error {}

const stateKeys = ['location', 'locationPath', 'sceneFocus', 'protagonist', 'items', 'scenes', 'npcs', 'plans', 'lifeDetails', 'secrets', 'vars'] as const;
const groups = ['items', 'scenes', 'npcs', 'plans', 'lifeDetails', 'secrets'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 引号和空白不参与原文比对(模型摘原句时常加减引号、换行)。 */
const squash = (s: string) => s.replace(/[\s「」『』“”"'‘’]/g, '');

/**
 * 正文与记录的矛盾:about/record/text 三项都要有,text 须能在本楼原文里连续找到;最多 3 条。
 * 不合格的条目直接丢掉,不让整楼摘要失败(矛盾只是提示,不是状态)。
 */
function cleanConflicts(value: unknown, sources: readonly string[]): NonNullable<SummaryDelta['conflicts']> {
  if (!Array.isArray(value) || !sources.length) return [];
  const pool = sources.map(squash);
  const out: NonNullable<SummaryDelta['conflicts']> = [];
  for (const raw of value) {
    if (!record(raw)) continue;
    const about = typeof raw.about === 'string' ? raw.about.trim() : '';
    const prior = typeof raw.record === 'string' ? raw.record.trim() : '';
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!about || !prior || !text) continue;
    const needle = squash(text);
    if (needle.length < 2 || !pool.some(p => p.includes(needle))) continue;
    out.push({ about: about.slice(0, 80), record: prior.slice(0, 200), text: text.slice(0, 200) });
    if (out.length >= 3) break;
  }
  return out;
}

/** 宽松解析时被去掉的更新:引文与正文对不上的角色位置或伤情,原记录保持不变。 */
export interface DroppedEvidence { kind: 'location' | 'condition'; name: string }

/**
 * 宽松解析去掉定位或伤情后,清掉只剩名字的角色条目和空分组,并同步 stateChanges,
 * 让其余内容照常通过后面的字段校验。
 */
function pruneEmptyAfterDrop(parsed: Record<string, unknown>): void {
  const emptied: string[] = [];
  if (record(parsed.protagonist) && !Object.keys(parsed.protagonist).length) { delete parsed.protagonist; emptied.push('protagonist'); }
  if (record(parsed.npcs)) {
    for (const op of ['add', 'update']) {
      const values = parsed.npcs[op];
      if (!Array.isArray(values)) continue;
      const kept = values.filter(entry => !record(entry) || Object.keys(entry).some(k => k !== 'name'));
      if (kept.length) parsed.npcs[op] = kept;
      else delete parsed.npcs[op];
    }
    if (!Object.keys(parsed.npcs).length) { delete parsed.npcs; emptied.push('npcs'); }
  }
  if (emptied.length && Array.isArray(parsed.stateChanges)) {
    parsed.stateChanges = parsed.stateChanges.filter(k => !emptied.includes(k as string));
  }
}

export function parseSummaryResponse(raw: string, options: {
  sourceContent?: string;
  /** 未附来源编号/提示的原消息，每条独立匹配，不允许跨消息拼接。 */
  sourceTexts?: readonly string[];
  conditionContext?: ConditionContext;
  /** 本楼之前的名册名字(校验 npcs.rename);缺省时取 conditionContext 的名册 */
  npcRoster?: readonly string[];
  /** 主角名;改名不能改成主角 */
  userName?: string;
  requireStateChanges: boolean;
  finalize: (delta: SummaryDelta) => StoredDelta;
  /**
   * 最后一次尝试:角色位置或伤情的引文仍与正文对不上时,只去掉这几项更新(保留原记录),其余照常保存,
   * 不再让整楼摘要失败;去掉了哪些交给它。不传时任何引文问题都整份拒绝,由调用方带着原因重试。
   */
  onDroppedEvidence?: (dropped: DroppedEvidence[]) => void;
}): SummaryDelta & { summary: string } {
  const parsed = extractJsonObject<unknown>(raw);
  if (!record(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new SummaryResponseError('摘要结果必须是根对象，且包含非空字符串 summary。');
  }
  const summary = parsed.summary.trim();
  if ('delta' in parsed || 'updates' in parsed) {
    throw new SummaryResponseError('状态更新必须与 summary 并列放在根对象，不要包进 delta 或 updates。');
  }
  const npcOps = record(parsed.npcs) ? parsed.npcs : {};
  const patchTargets = new Set<object>();
  if (record(parsed.protagonist)) patchTargets.add(parsed.protagonist);
  for (const op of ['add', 'update']) {
    const entries = npcOps[op];
    if (Array.isArray(entries)) for (const entry of entries) if (record(entry)) patchTargets.add(entry);
  }
  let hasPatch = false;
  function validatePatchPlacement(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(validatePatchPlacement); return; }
    if (!record(value)) return;
    if ('conditionPatch' in value) {
      if (!patchTargets.has(value)) throw new SummaryResponseError('conditionPatch 必须放在对应 protagonist 或 npcs.add/update 的角色对象内，不能放在物品、分组或嵌套字段中。');
      hasPatch = true;
    }
    Object.values(value).forEach(validatePatchPlacement);
  }
  validatePatchPlacement(parsed);
  if (hasPatch && !options.conditionContext) throw new SummaryResponseError('conditionPatch 缺少本楼前状态，不能静默丢弃操作。');
  // 改名先于伤情补丁校验:同一楼改名后的角色用新名字更新伤情,要能找回改名前的旧伤情片段。
  let renames = new Map<string, string>();
  if (record(npcOps) && 'rename' in npcOps) {
    const roster = options.npcRoster ?? options.conditionContext?.npcs.map(n => n.name);
    if (!roster) throw new SummaryResponseError('npcs.rename 缺少本楼之前的名册，不能静默丢弃改名。');
    try {
      renames = validateNpcRenames(parsed, { roster, userName: options.userName, sourceTexts: options.sourceTexts ?? options.sourceContent ?? '' });
    } catch (error) {
      if (error instanceof NpcRenameError) throw new SummaryResponseError(error.message);
      throw error;
    }
  }
  const dropped: DroppedEvidence[] = [];
  const lenient = !!options.onDroppedEvidence;
  if (options.conditionContext) {
    const ctx = options.conditionContext;
    const npcsAfterRename = renames.size
      ? ctx.npcs.map(n => ({ ...n, name: renames.get(n.name.trim().toLowerCase()) ?? n.name }))
      : ctx.npcs;
    try {
      materializeConditionPatches(parsed, { ...ctx, npcs: npcsAfterRename, sourceTexts: options.sourceTexts ?? ctx.sourceTexts },
        lenient ? { onDrop: who => dropped.push({ kind: 'condition', name: who }) } : {});
    }
    catch (error) {
      if (error instanceof ConditionPatchError) throw new SummaryResponseError(error.message);
      throw error;
    }
  }
  try {
    validateNpcLocationEvidence(parsed, { strict: options.requireStateChanges, content: options.sourceContent, sourceTexts: options.sourceTexts,
      ...(lenient ? { onDrop: (name: string) => dropped.push({ kind: 'location', name }) } : {}) });
  }
  catch (error) {
    if (error instanceof NpcLocationEvidenceError) throw new SummaryResponseError(error.message);
    throw error;
  }
  if (dropped.length) pruneEmptyAfterDrop(parsed);
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
  const conflicts = cleanConflicts(parsed.conflicts, options.sourceTexts ?? (options.sourceContent ? [options.sourceContent] : []));
  if (conflicts.length) delta.conflicts = conflicts;
  else delete delta.conflicts;
  const stored = options.finalize(delta);
  for (const key of (options.requireStateChanges || 'stateChanges' in parsed) ? groups : []) {
    if (!(key in parsed)) continue;
    const group = parsed[key];
    if (!record(group)) throw new SummaryResponseError(key + ' 必须是包含操作数组的对象。');
    const cleaned = stored[key] as Record<string, unknown> | undefined;
    const allowed = key === 'items' ? ['add', 'update', 'remove']
      : key === 'npcs' ? ['add', 'update', 'rename', 'remove']
      : key === 'scenes' ? ['add', 'update', 'reparent']
      : key === 'plans' || key === 'secrets' ? ['add', 'update', 'resolve'] : ['add', 'update', 'archive', 'remove'];
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
  // 整份通过校验后才报告:去掉的几项不会写入,原记录保持不变
  if (dropped.length) options.onDroppedEvidence!(dropped);
  return delta;
}
