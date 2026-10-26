import { NpcLocationEvidenceError, validateNpcLocationEvidence } from './npcLocationEvidence';
import { NpcRenameError, validateNpcRenames } from './npcRename';
import { extractJsonObject } from './json';
import { knowledgeEntryProblem, knowledgeNames } from './knowledge';
import type { EvidenceDropReason } from './sourceEvidence';
import type { StoredDelta, SummaryDelta } from './types';

/**
 * 只校验结果合同，不从摘要关键词反推人物/物品/计划变更。
 * 篇幅不在这里拒收：字数要求写在提示词里，模型数不准字数，写超了照常保存，不因此让整楼失败。
 *
 * 前几次尝试：任何一处不合格都整份拒绝，错误写明具体条目和原因（声明了什么、实际有什么、哪个编号不存在），
 * 由调用方附原因重试。最后一次尝试（传 onDroppedEvidence）：只去掉不合格的那几项更新、保留原记录，
 * 摘要和其余状态照常保存，去掉了哪些交给回调；缺 summary、JSON 无法解析这类整份不能用的结果仍整份拒绝。
 */
export class SummaryResponseError extends Error {}

const stateKeys = ['location', 'locationPath', 'sceneFocus', 'protagonist', 'items', 'scenes', 'npcs', 'plans', 'lifeDetails', 'secrets', 'knowledge', 'vars'] as const;
type StateKey = typeof stateKeys[number];
const groups = ['items', 'scenes', 'npcs', 'plans', 'lifeDetails', 'secrets'] as const;
type GroupKey = typeof groups[number];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStateKey = (k: unknown): k is StateKey => typeof k === 'string' && (stateKeys as readonly string[]).includes(k);

/** 各分组允许的操作(与写入时的清洗一致)。 */
const ALLOWED_OPS: Record<GroupKey, readonly string[]> = {
  items: ['add', 'update', 'remove'],
  npcs: ['add', 'update', 'rename', 'remove'],
  scenes: ['add', 'update', 'reparent'],
  plans: ['add', 'update', 'resolve'],
  secrets: ['add', 'update', 'resolve'],
  lifeDetails: ['add', 'update', 'archive', 'remove'],
};

/** 状态字段给用户看的名字(提示和楼层面板用)。 */
export const STATE_LABELS: Record<StateKey, string> = {
  location: '地点', locationPath: '地点路径', sceneFocus: '局势', protagonist: '主角档案', items: '物品', scenes: '场景',
  npcs: '角色', plans: '计划悬念', lifeDetails: '生活档案', secrets: '信息差', knowledge: '了解清单', vars: '变量',
};

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

/** 去掉某项更新的原因:missing=没给原话或缺少必填内容;mismatch=原话与本楼正文对不上;invalid=编号、字段或结构不符合要求。 */
export type DroppedReason = EvidenceDropReason;

/** 没写入的更新属于哪一类。 */
export type DroppedKind =
  | 'location' | 'condition' | 'rename' | 'item' | 'scene' | 'npc' | 'plan' | 'lifeDetail' | 'secret' | 'knowledge'
  | 'vars' | 'stateChanges' | 'format';

/**
 * 没有写入的更新,原记录保持不变:最后一次尝试中不合格而去掉的项,以及任何一次都只跳过的无效变量命令。
 * name:角色名(主角为 protagonist)、物品名、计划编号、改名「旧 → 新」或状态字段名;detail:一句具体说明。
 */
export interface DroppedEvidence {
  kind: DroppedKind;
  name: string;
  reason: DroppedReason;
  detail?: string;
}

const GROUP_KIND: Record<GroupKey, DroppedKind> = { items: 'item', scenes: 'scene', npcs: 'npc', plans: 'plan', lifeDetails: 'lifeDetail', secrets: 'secret' };

/** 去掉的这一项属于哪个状态字段(用于不重复报告 stateChanges)。 */
function stateKeyOfDrop(d: DroppedEvidence): string {
  switch (d.kind) {
    case 'location': case 'npc': case 'rename': return 'npcs';
    case 'condition': return d.name === 'protagonist' ? 'protagonist' : 'npcs';
    case 'item': return 'items';
    case 'scene': return 'scenes';
    case 'plan': return 'plans';
    case 'lifeDetail': return 'lifeDetails';
    case 'secret': return 'secrets';
    case 'knowledge': return 'knowledge';
    case 'vars': return 'vars';
    case 'format': return d.name;
    default: return '';
  }
}

/**
 * 宽松解析去掉定位后,清掉因此只剩名字的 update 条目和空分组,让其余内容照常通过后面的字段校验。
 * add 只剩名字时保留:角色本楼确实登场,定位对不上只是不记位置,不能连角色一起丢掉。
 * 只处理被去掉过内容的对象,原本就只写了名字的条目不动。
 */
function pruneTouched(parsed: Record<string, unknown>, touched: Set<object>): void {
  if (!record(parsed.npcs)) return;
  const values = parsed.npcs.update;
  if (Array.isArray(values)) {
    const kept = values.filter(entry => !(record(entry) && touched.has(entry) && Object.keys(entry).every(k => k === 'name')));
    if (kept.length) parsed.npcs.update = kept;
    else delete parsed.npcs.update;
  }
  if (!Object.keys(parsed.npcs).length) delete parsed.npcs;
}

const preview = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return Array.from(one).length > 24 ? Array.from(one).slice(0, 24).join('') + '…' : one;
};
const idOf = (entry: unknown): string => {
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry).trim();
  if (!record(entry)) return '';
  for (const k of ['id', 'ref', 'planId', 'detailId', 'secretId']) {
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/** 本楼之前可引用的条目数:未了结计划 p、生活档案 d、未结案信息差 s。只用于把编号错误写清楚。 */
export interface RefCounts { plans?: number; lifeDetails?: number; secrets?: number }

function refRange(prefix: string, n: number | undefined): string {
  if (n === undefined) return '';
  return n > 0 ? `（当前可用 ${prefix}1–${prefix}${n}）` : '（当前没有可引用的条目）';
}

/** 被写入时的清洗去掉的一条操作:给提示用的名字。 */
function entryLabel(key: GroupKey, op: string, entry: unknown): string {
  if (typeof entry === 'string') return preview(entry);
  if (!record(entry)) return '';
  if (key === 'scenes') {
    const path = op === 'reparent' ? entry.node : entry.path;
    if (Array.isArray(path)) return path.filter(p => typeof p === 'string' && p.trim()).join(' / ');
    return typeof path === 'string' ? path.trim() : '';
  }
  if (key === 'npcs' && op === 'rename') return `${typeof entry.from === 'string' ? entry.from : ''} → ${typeof entry.to === 'string' ? entry.to : ''}`;
  if (key === 'plans' || key === 'secrets' || key === 'lifeDetails') {
    if (op !== 'add') return idOf(entry);
    const text = key === 'lifeDetails' ? entry.text : entry.content;
    return typeof text === 'string' ? preview(text) : '';
  }
  return typeof entry.name === 'string' ? entry.name.trim() : '';
}

/** 被写入时的清洗去掉的一条操作:原因(写给模型重试,也写给用户看)。 */
function entryProblem(key: GroupKey, op: string, entry: unknown, refs: RefCounts): { reason: DroppedReason; detail: string } {
  const text = (k: string) => record(entry) && typeof entry[k] === 'string' && !!(entry[k] as string).trim();
  const missingId = () => !idOf(entry);
  switch (key) {
    case 'items':
      return { reason: 'missing', detail: '缺少物品名称 name' };
    case 'npcs':
      return op === 'rename' ? { reason: 'invalid', detail: 'from、to 须是不同的非空名字' } : { reason: 'missing', detail: '缺少角色名 name' };
    case 'scenes': {
      if (op === 'reparent') return { reason: 'missing', detail: '缺少 node 或 newPath' };
      const path = record(entry) ? entry.path : undefined;
      const hasPath = Array.isArray(path) ? path.some(p => typeof p === 'string' && p.trim()) : typeof path === 'string' && !!path.trim();
      if (!hasPath) return { reason: 'missing', detail: '缺少完整地理路径 path' };
      return { reason: 'missing', detail: op === 'add' ? '新地点必须写描述 desc' : 'desc 必须是字符串（清除描述填空字符串）' };
    }
    case 'plans':
      if (op === 'add') return { reason: 'missing', detail: '缺少内容 content' };
      if (missingId()) return { reason: 'missing', detail: '缺少编号 id' };
      if (op === 'update' && record(entry)) {
        if (!text('content')) return { reason: 'missing', detail: `${idOf(entry)} 缺少调整后的完整内容 content（只改期限也要写出内容）` };
        if ('targetTime' in entry && entry.targetTime !== null && typeof entry.targetTime !== 'string') return { reason: 'invalid', detail: `${idOf(entry)} 的 targetTime 必须是字符串；撤销期限填空字符串` };
      }
      return { reason: 'invalid', detail: `编号 ${idOf(entry)} 不存在${refRange('p', refs.plans)}` };
    case 'lifeDetails':
      if (op === 'add') return { reason: 'missing', detail: '缺少内容 text' };
      if (missingId()) return { reason: 'missing', detail: '缺少编号 id' };
      return { reason: 'invalid', detail: `编号 ${idOf(entry)} 不存在${refRange('d', refs.lifeDetails)}` };
    case 'secrets':
      if (op === 'add') return { reason: 'missing', detail: '缺少内容 content' };
      if (missingId()) return { reason: 'missing', detail: '缺少编号 id' };
      if (op === 'update' && record(entry) && !text('content') && entry.knownBy === undefined && entry.unaware === undefined) {
        return { reason: 'missing', detail: `${idOf(entry)} 没有写要更新的内容或名单` };
      }
      return { reason: 'invalid', detail: `编号 ${idOf(entry)} 不存在${refRange('s', refs.secrets)}` };
  }
}

/** 一项没写入的内容,写给用户看的「哪一项」和「为什么」。 */
export function describeDropped(d: DroppedEvidence, userName = '主角'): { what: string; why: string } {
  const who = d.name === 'protagonist' ? userName : d.name || '某个角色';
  const generic = d.reason === 'missing' ? '缺少必填内容' : d.reason === 'mismatch' ? '给出的原句与本楼正文对不上' : '编号或字段不符合要求';
  const quote = d.reason === 'missing' ? '没有给出正文原句' : d.reason === 'mismatch' ? '给出的原句与本楼正文对不上' : '';
  switch (d.kind) {
    case 'location': return { what: `${who}的位置`, why: quote || '同一角色本楼定位了不止一次，或缺少角色名' };
    case 'condition': return { what: `${who}的伤情`, why: d.detail || quote || '伤情片段的编号或写法不符合要求' };
    case 'rename': return { what: `改名「${d.name}」`, why: d.detail || generic };
    case 'item': return { what: d.name ? `物品「${d.name}」` : '一项物品变化', why: d.detail || generic };
    case 'scene': return { what: d.name ? `地点「${d.name}」` : '一项地点变化', why: d.detail || generic };
    case 'npc': return { what: d.name ? `角色「${d.name}」` : '一项角色变化', why: d.detail || generic };
    case 'plan': return { what: d.name ? `计划悬念 ${d.name}` : '一项计划悬念变化', why: d.detail || generic };
    case 'lifeDetail': return { what: d.name ? `生活档案「${d.name}」` : '一项生活档案变化', why: d.detail || generic };
    case 'secret': return { what: d.name ? `信息差 ${d.name}` : '一项信息差变化', why: d.detail || generic };
    case 'knowledge': return { what: d.name ? `了解清单「${d.name}」` : '一项了解清单变化', why: d.detail || generic };
    case 'vars': return { what: '变量命令', why: d.detail || '命令无效，已跳过' };
    case 'stateChanges': return { what: `${isStateKey(d.name) ? STATE_LABELS[d.name] : d.name}的更新`, why: d.detail || '清单里声明了，但没有给出有效更新' };
    // 结构问题:状态字段用中文名,包在 delta/updates 里的整块写明是哪一块
    case 'format': return {
      what: isStateKey(d.name) ? `${STATE_LABELS[d.name]}的更新` : d.name === 'delta' || d.name === 'updates' ? `包在 ${d.name} 里的更新` : d.name || '一项更新',
      why: d.detail || generic,
    };
    default: return { what: d.name || '一项更新', why: d.detail || generic };
  }
}

/** 读叶子上记下的「没写入的内容」(旧叶子没有;格式不对的条目跳过)。 */
export function leafDropped(leaf: unknown): DroppedEvidence[] {
  const list = record(leaf) && Array.isArray(leaf.dropped) ? leaf.dropped : [];
  return list.flatMap(v => {
    if (!record(v) || typeof v.kind !== 'string' || typeof v.name !== 'string') return [];
    const reason: DroppedReason = v.reason === 'missing' || v.reason === 'mismatch' ? v.reason : 'invalid';
    return [{ kind: v.kind as DroppedKind, name: v.name, reason, ...(typeof v.detail === 'string' && v.detail ? { detail: v.detail } : {}) }];
  });
}

export function parseSummaryResponse(raw: string, options: {
  sourceContent?: string;
  /** 未附来源编号/提示的原消息，每条独立匹配，不允许跨消息拼接。 */
  sourceTexts?: readonly string[];
  /** 本楼之前的名册名字(校验 npcs.rename) */
  npcRoster?: readonly string[];
  /** 主角名;改名不能改成主角 */
  userName?: string;
  requireStateChanges: boolean;
  finalize: (delta: SummaryDelta) => StoredDelta;
  /** 本楼之前可引用的条目数;编号错误的提示据此写出可用范围 */
  refCounts?: RefCounts;
  /** 了解清单开启时传:提示词里展示了几条(k1–kN)。不传 = 功能关闭,模型输出的 knowledge 直接去掉 */
  knowledge?: { shown: number };
  /**
   * 最后一次尝试:不合格的更新只去掉这几项(保留原记录),其余照常保存,不再让整楼摘要失败;去掉了哪些交给它。
   * 不传时任何问题都整份拒绝,由调用方带着原因重试。
   */
  onDroppedEvidence?: (dropped: DroppedEvidence[]) => void;
  /** 任何一次尝试都只跳过、不影响保存的项(目前是无效的变量命令),整份通过后交给它,供保存后提示。 */
  onSkipped?: (skipped: DroppedEvidence[]) => void;
}): SummaryDelta & { summary: string } {
  const parsed = extractJsonObject<unknown>(raw);
  if (!record(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new SummaryResponseError('摘要结果必须是根对象，且包含非空字符串 summary。');
  }
  const summary = parsed.summary.trim();
  const lenient = !!options.onDroppedEvidence;
  const refs = options.refCounts ?? {};
  const dropped: DroppedEvidence[] = [];
  const touched = new Set<object>();
  // 状态更新包进了 delta/updates:前几次附原因重试;最后一次在根层没有同名字段时展开到根层
  for (const wrapper of ['delta', 'updates'] as const) {
    if (!(wrapper in parsed)) continue;
    if (!lenient) throw new SummaryResponseError('状态更新必须与 summary 并列放在根对象，不要包进 delta 或 updates。');
    const inner: unknown = parsed[wrapper];
    delete parsed[wrapper];
    if (!record(inner)) {
      dropped.push({ kind: 'format', name: wrapper, reason: 'invalid', detail: `${wrapper} 不是对象，其中的内容没有写入` });
      continue;
    }
    for (const [key, value] of Object.entries(inner) as [string, unknown][]) {
      if (key === 'summary') continue;
      if (key in parsed) dropped.push({ kind: 'format', name: key, reason: 'invalid', detail: `根层和 ${wrapper} 里各写了一份，只保留根层的` });
      else parsed[key] = value;
    }
  }
  // 伤情按 condition 整段覆盖,不接受片段补丁:模型照旧写法输出的 conditionPatch 不论放在哪里都直接去掉,
  // 不让整楼失败;同时给了 condition 的,以 condition 为准。
  (function stripConditionPatches(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(stripConditionPatches); return; }
    if (!record(value)) return;
    delete value.conditionPatch;
    Object.values(value).forEach(stripConditionPatches);
  })(parsed);
  if (record(parsed.npcs) && 'rename' in parsed.npcs) {
    const roster = options.npcRoster;
    if (!roster) throw new SummaryResponseError('npcs.rename 缺少本楼之前的名册，不能静默丢弃改名。');
    try {
      validateNpcRenames(parsed, {
        roster, userName: options.userName, sourceTexts: options.sourceTexts ?? options.sourceContent ?? '',
        ...(lenient ? { onDrop: d => { dropped.push({ kind: 'rename', name: d.from || d.to ? `${d.from} → ${d.to}` : 'npcs.rename', reason: d.reason, ...(d.detail ? { detail: d.detail } : {}) }); } } : {}),
      });
    } catch (error) {
      if (error instanceof NpcRenameError) throw new SummaryResponseError(error.message);
      throw error;
    }
  }
  try {
    validateNpcLocationEvidence(parsed, { strict: options.requireStateChanges, content: options.sourceContent, sourceTexts: options.sourceTexts,
      ...(lenient ? { onDrop: (name: string, reason: DroppedReason, entry: Record<string, unknown>) => { touched.add(entry); dropped.push({ kind: 'location', name, reason }); } } : {}) });
  }
  catch (error) {
    if (error instanceof NpcLocationEvidenceError) throw new SummaryResponseError(error.message);
    throw error;
  }
  if (touched.size) pruneTouched(parsed, touched);
  // 内置 add 是明确转入量；未知数量不能被派生层的历史兼容默认值变成“获得1”。
  // 不从名称或描述关键词猜交易方向；自定义旧模板和已存历史仍沿用原合同。最后一次尝试只去掉没有有效数量的那几条。
  if (options.requireStateChanges && record(parsed.items) && Array.isArray(parsed.items.add)) {
    const problems: string[] = [];
    const kept: unknown[] = [];
    parsed.items.add.forEach((entry, index) => {
      const qty = record(entry) ? entry.qty : undefined;
      const asNumber = typeof qty === 'number' ? qty : lenient && typeof qty === 'string' && qty.trim() ? Number(qty.trim()) : NaN;
      if (Number.isFinite(asNumber) && asNumber > 0) {
        if (record(entry) && typeof qty === 'string') entry.qty = asNumber;
        kept.push(entry);
        return;
      }
      const name = record(entry) && typeof entry.name === 'string' ? entry.name.trim() : typeof entry === 'string' ? entry.trim() : '';
      const absent = qty === undefined || qty === null || (typeof qty === 'string' && !qty.trim());
      const why = absent ? '缺少 qty' : typeof qty === 'string' ? 'qty 须填数字，不加引号' : 'qty 须是正数';
      problems.push(`items.add[${index}]${name ? `「${name}」` : ''}${why}`);
      if (lenient) dropped.push({ kind: 'item', name, reason: absent ? 'missing' : 'invalid', detail: absent ? '没有明确数量' : '数量不是正数' });
    });
    if (problems.length && !lenient) {
      throw new SummaryResponseError('items.add.qty 必须是明确的有限正数，表示本楼实际转入量，不是余额。先核对谁给谁；支付、赠出、归还不能记成获得。原库存或余额未知时不要为记录支出而新增物品，不得猜1；把交易保留在 summary。已知库存转出用 update 写剩余总量，全部转出用 remove。请重新核对事实并重写完整 JSON。问题条目：' + problems.join('；') + '。');
    }
    if (lenient && problems.length) {
      if (kept.length) parsed.items.add = kept;
      else delete parsed.items.add;
      if (!Object.keys(parsed.items).length) delete parsed.items;
    }
  }
  // 内置模板:生活档案的新增必须写明所属人物,主语不明宁可不记。只在解析新回复时检查,已存的旧数据缺省仍按主角重放。
  if (options.requireStateChanges && record(parsed.lifeDetails) && Array.isArray(parsed.lifeDetails.add)) {
    const problems: string[] = [];
    const kept: unknown[] = [];
    parsed.lifeDetails.add.forEach((entry, index) => {
      const text = record(entry) && typeof entry.text === 'string' ? entry.text.trim() : '';
      const subject = record(entry) && typeof entry.subject === 'string' ? entry.subject.trim() : '';
      if (!text || subject) { kept.push(entry); return; }
      problems.push(`lifeDetails.add[${index}]「${preview(text)}」缺少 subject`);
      if (lenient) dropped.push({ kind: 'lifeDetail', name: preview(text), reason: 'missing', detail: '没有写明所属人物' });
    });
    if (problems.length && !lenient) {
      throw new SummaryResponseError('lifeDetails.add 每条都必须写明所属人物 subject（主角填 user，其他人物填名册中的名字）；主语不明就不记。问题条目：' + problems.join('；') + '。');
    }
    if (lenient && problems.length) {
      if (kept.length) parsed.lifeDetails.add = kept;
      else delete parsed.lifeDetails.add;
      if (!Object.keys(parsed.lifeDetails).length) delete parsed.lifeDetails;
    }
  }
  // 了解清单:功能关闭时模型硬给也不收,清单里声明的一并去掉,不让整楼失败。
  // 开启时逐条核对编号、角色和内容(与固化时同一口径):前几次附原因重试,最后一次只去掉不合格的几条。
  if (!options.knowledge) {
    delete parsed.knowledge;
    if (Array.isArray(parsed.stateChanges)) parsed.stateChanges = parsed.stateChanges.filter(k => k !== 'knowledge');
  } else if ('knowledge' in parsed) {
    const group = parsed.knowledge;
    // 本楼新登场、更新到的角色和改名后的名字按固化后的 npcs 算,与 finalizeDelta 看到的名册一致
    const npcs = record(parsed.npcs) ? options.finalize({ npcs: parsed.npcs } as SummaryDelta).npcs : undefined;
    const ctx = { ...knowledgeNames(options.npcRoster ?? [], npcs), shownCount: options.knowledge.shown, userName: options.userName };
    const problems: string[] = [];
    if (!record(group)) {
      if (!lenient) throw new SummaryResponseError('knowledge 必须是包含 add、update、remove 操作数组的对象。');
      delete parsed.knowledge;
      dropped.push({ kind: 'knowledge', name: 'knowledge', reason: 'invalid', detail: '不是包含操作数组的对象' });
    } else {
      for (const op of Object.keys(group)) {
        const valid = ['add', 'update', 'remove'].includes(op);
        if (!valid || !Array.isArray(group[op])) {
          if (!lenient) throw new SummaryResponseError(`knowledge.${op} 不是合法操作数组；knowledge 只允许 add、update、remove，值为数组。`);
          if (!valid || group[op] == null) {
            delete group[op];
            if (!valid) dropped.push({ kind: 'knowledge', name: 'knowledge.' + op, reason: 'invalid', detail: '不是合法操作（只允许 add、update、remove）' });
            continue;
          }
          group[op] = [group[op]];
        }
        const kept: unknown[] = [];
        (group[op] as unknown[]).forEach((entry, index) => {
          const problem = knowledgeEntryProblem(op, entry, ctx);
          if (!problem) { kept.push(entry); return; }
          const text = record(entry) && typeof entry.text === 'string' ? entry.text : '';
          const label = op === 'add' ? preview(text) : idOf(entry);
          problems.push(`knowledge.${op}[${index}]${label && !problem.detail.includes(label) ? `「${label}」` : ''}${problem.detail}`);
          if (lenient) dropped.push({ kind: 'knowledge', name: label, reason: problem.reason, detail: problem.detail });
        });
        if (kept.length) group[op] = kept;
        else delete group[op];
      }
      if (!Object.keys(group).length) delete parsed.knowledge;
    }
    if (problems.length && !lenient) {
      const shown = problems.slice(0, 6).join('；') + (problems.length > 6 ? `；另有 ${problems.length - 6} 处` : '');
      throw new SummaryResponseError('了解清单含无效条目：' + shown + '。请按原因修正后重写完整 JSON；拿不准的条目可以不写。');
    }
  }
  // 分组结构与逐条清洗:写入时会被清洗掉的条目(缺名字、编号不存在、字段类型不对等)不能悄悄丢掉。
  // 前几次写明是哪一条、为什么,附原因重试;最后一次只去掉这几条。先整份清洗一次比对条数,
  // 对不上的操作再逐条试清洗找出是哪一条(清洗不跨条目,逐条结果与整组一致)。
  const build = () => {
    const next = { ...parsed, summary } as SummaryDelta & { summary: string };
    const conflicts = cleanConflicts(parsed.conflicts, options.sourceTexts ?? (options.sourceContent ? [options.sourceContent] : []));
    if (conflicts.length) next.conflicts = conflicts;
    else delete next.conflicts;
    return next;
  };
  let delta = build();
  let stored = options.finalize(delta);
  let pruned = false;
  const probe = (key: GroupKey, op: string, entry: unknown): boolean => {
    const single = options.finalize({ [key]: { [op]: [entry] } } as SummaryDelta) as Record<string, Record<string, unknown> | undefined>;
    const kept = single[key]?.[op];
    return Array.isArray(kept) && kept.length === 1;
  };
  if (options.requireStateChanges || 'stateChanges' in parsed) {
    const problems: string[] = [];
    for (const key of groups) {
      if (!(key in parsed)) continue;
      const group = parsed[key];
      if (!record(group)) {
        if (!lenient) throw new SummaryResponseError(key + ' 必须是包含操作数组的对象。');
        delete parsed[key];
        pruned = true;
        dropped.push({ kind: GROUP_KIND[key], name: key, reason: 'invalid', detail: '不是包含操作数组的对象' });
        continue;
      }
      const allowed = ALLOWED_OPS[key];
      const cleaned = (stored as Record<string, Record<string, unknown> | undefined>)[key];
      for (const op of Object.keys(group)) {
        if (!allowed.includes(op)) {
          if (!lenient) throw new SummaryResponseError(key + '.' + op + ' 不是合法操作数组，请使用模板规定的字段：' + key + ' 只允许 ' + allowed.join('、') + '，值为数组。');
          delete group[op];
          pruned = true;
          dropped.push({ kind: GROUP_KIND[key], name: key + '.' + op, reason: 'invalid', detail: '不是合法操作（只允许 ' + allowed.join('、') + '）' });
          continue;
        }
        if (!Array.isArray(group[op])) {
          if (!lenient) throw new SummaryResponseError(key + '.' + op + ' 不是合法操作数组，请使用模板规定的字段：' + key + ' 只允许 ' + allowed.join('、') + '，值为数组。');
          // 合法操作但写成了单个值:按一条处理,与写入时的清洗一致
          if (group[op] === null || group[op] === undefined) delete group[op];
          else group[op] = [group[op]];
          pruned = true;
          if (!(op in group)) continue;
        }
        const values = group[op] as unknown[];
        const keptCount = Array.isArray(cleaned?.[op]) ? (cleaned![op] as unknown[]).length : 0;
        if (values.length === keptCount) continue;
        const kept: unknown[] = [];
        values.forEach((entry, index) => {
          if (probe(key, op, entry)) { kept.push(entry); return; }
          const problem = entryProblem(key, op, entry, refs);
          const label = entryLabel(key, op, entry);
          problems.push(`${key}.${op}[${index}]${label && !problem.detail.includes(label) ? `「${label}」` : ''}${problem.detail}`);
          if (lenient) dropped.push({ kind: GROUP_KIND[key], name: label, reason: problem.reason, detail: problem.detail });
        });
        if (lenient) {
          if (kept.length) group[op] = kept;
          else delete group[op];
          pruned = true;
        }
      }
      if (lenient && !Object.keys(group).length) { delete parsed[key]; pruned = true; }
    }
    if (problems.length && !lenient) {
      const shown = problems.slice(0, 6).join('；') + (problems.length > 6 ? `；另有 ${problems.length - 6} 处` : '');
      throw new SummaryResponseError('状态更新含无效条目：' + shown + '。请按原因修正后重写完整 JSON；不能只保留摘要而丢弃操作。');
    }
  }
  // 同一短编号的不同写法在固化后归一，禁止一楼重复调整或边调整边结案。
  // 最后一次尝试:与 resolve 冲突的 update 去掉(保留 resolve);同一计划多次 update 只保留最后一次。
  if (pruned) { delta = build(); stored = options.finalize(delta); pruned = false; }
  const updatedPlans = stored.plans?.update ?? [];
  const resolvedIds = new Set((stored.plans?.resolve ?? []).map(r => typeof r === 'string' ? r : r.id));
  if (record(parsed.plans) && Array.isArray(parsed.plans.update)
      && (new Set(updatedPlans.map(p => p.id)).size !== updatedPlans.length || updatedPlans.some(p => resolvedIds.has(p.id)))) {
    const plans = parsed.plans;
    const stableId = (entry: unknown): string => options.finalize({ plans: { update: [entry] } } as SummaryDelta).plans?.update?.[0]?.id ?? '';
    const updates = plans.update as unknown[];
    const ids = updates.map(stableId);
    const last = new Map<string, number>();
    ids.forEach((id, i) => { if (id) last.set(id, i); });
    const problems: string[] = [];
    const kept: unknown[] = [];
    updates.forEach((entry, index) => {
      const id = ids[index];
      const ref = idOf(entry) || id;
      if (id && resolvedIds.has(id)) {
        problems.push(`${ref} 同时 update 和 resolve`);
        if (lenient) dropped.push({ kind: 'plan', name: ref, reason: 'invalid', detail: '同一楼既调整又了结，只保留了结' });
        return;
      }
      if (id && last.get(id) !== index) {
        problems.push(`${ref} update 了不止一次`);
        if (lenient) dropped.push({ kind: 'plan', name: ref, reason: 'invalid', detail: '同一楼调整了不止一次，只保留最后一次' });
        return;
      }
      kept.push(entry);
    });
    if (!lenient) {
      throw new SummaryResponseError('同一计划每楼只能 update 一次，且不可同时 update 与 resolve：' + [...new Set(problems)].join('；') + '。暂缓/改期用 update；明确完成、取消或失败才 resolve。');
    }
    if (kept.length) plans.update = kept;
    else delete plans.update;
    if (!Object.keys(plans).length) delete parsed.plans;
    delta = build();
    stored = options.finalize(delta);
  }
  // 变量命令:op 不合法的照常跳过(不让整楼失败),保存后提示跳过了几条
  const skipped: DroppedEvidence[] = [];
  if (Array.isArray(parsed.vars)) {
    const bad = parsed.vars.length - (stored.varOps?.length ?? 0);
    if (bad > 0) skipped.push({ kind: 'vars', name: 'vars', reason: 'invalid', detail: `变量命令 ${bad} 条无效，已跳过（op 只能是 set、assign、remove、add）` });
  }
  if (options.requireStateChanges || 'stateChanges' in parsed) {
    const declared = parsed.stateChanges;
    const declaredList: unknown[] = Array.isArray(declared) ? declared : [];
    // 变量:清单里写了 vars 且输出了 vars 数组就算已输出(其中无效的命令跳过并提示),不因命令全部无效让整楼失败
    const varsOutput = 'varOps' in stored || (Array.isArray(parsed.vars) && declaredList.includes('vars'));
    const actual = stateKeys.filter(k => (k === 'vars' ? varsOutput : k in stored));
    if (!lenient) {
      if (!Array.isArray(declared)) {
        throw new SummaryResponseError('必须填写 stateChanges 数组，列出实际输出的状态字段名；确实无变化才填 []。它不含 summary 和时间字段，不能代替具体更新。');
      }
      const unknown = declared.filter(k => !isStateKey(k));
      if (unknown.length) {
        throw new SummaryResponseError('stateChanges 含非法字段名 ' + unknown.map(k => JSON.stringify(k)).join('、') + '；只能填 ' + stateKeys.join('、') + '，不含 summary 和时间字段。');
      }
      const extra = declared.filter(k => !actual.includes(k as StateKey));
      const missing = actual.filter(k => !declared.includes(k));
      const duplicated = new Set(declared).size !== declared.length;
      if (extra.length || missing.length || duplicated) {
        throw new SummaryResponseError('stateChanges 与有效状态字段不一致：清单是 [' + declared.join(', ') + ']，实际有效输出的是 [' + actual.join(', ') + ']'
          + (extra.length ? '；' + extra.join('、') + ' 在清单里，但没有对应的有效更新' : '')
          + (missing.length ? '；' + missing.join('、') + ' 有更新，但没写进清单' : '')
          + (duplicated ? '；清单有重复项' : '')
          + '。请补齐对应更新或更正清单；写入 summary 不等于更新档案。');
      }
    } else {
      // 最后一次尝试:清单以实际有效字段为准;声明了却没有有效更新的写进提示(其他原因已报告的不重复)
      const covered = new Set(dropped.map(stateKeyOfDrop));
      for (const key of new Set(declaredList)) {
        if (isStateKey(key) && !actual.includes(key) && !covered.has(key)) {
          dropped.push({ kind: 'stateChanges', name: key, reason: 'missing', detail: `清单里声明了${STATE_LABELS[key]}的变化，但没有给出有效更新` });
        }
      }
      (delta as unknown as Record<string, unknown>).stateChanges = actual;
    }
  }
  // 整份通过校验后才报告:去掉的几项不会写入,原记录保持不变
  if (skipped.length) options.onSkipped?.(skipped);
  if (dropped.length) options.onDroppedEvidence!(dropped);
  return delta;
}
