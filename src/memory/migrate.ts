/**
 * 从旧版 Horae 迁移记忆数据。
 *
 * 关键事实:Horae 与棱镜宝书共用**同一批聊天文件的同一批消息对象**——Horae 把数据挂在
 * `chat[i].horae_meta`,棱镜宝书挂在 `chat[i].extra.bbs_leaf`,两者并存于同一条 msg 上。
 * 所以迁移直接读「当前打开聊天」的 `ctx.chat[i].horae_meta` 产出棱镜宝书数据,不跨文件。
 * 范式照搬 carryover.ts:读源 → 造叶子(挂 extra)+ 森林(写 metadata)+ 把最终状态单独存在叶子上。
 *
 * 模型映射(详见 memory 里的 horae-migration-feature):
 *  - 每个有叙事的 AI 楼 → 一片叶子;text = 该楼非摘要 events 的 summary 拼接。没有 events 的 AI 楼迁移后是待摘要楼层。
 *  - Horae 时间是**时间点**(每层一个),棱镜宝书是**时间段**:叶子 timeEnd = 本层时间点,
 *    timeStart = 上一已知时间点(段的左界);缺失则沿用上一已知值(carry-forward)。
 *  - Horae autoSummaries(带 range/depth、嵌套 mergedSummaries)→ 棱镜宝书森林 comp 节点:
 *    递归 flatten,depth→level,先处理子条目再处理父条目,childIds 只收已保留的子条目与范围内未被子条目覆盖的叶子;
 *    整棵子树都没有叶子的条目存为导入历史(保住总结文字,覆盖的楼层不再算待摘要)。
 *  - 物品/计划是 Horae 的**逐层快照**(非增量),按楼序折叠出最终态,整包存在最后一片叶子的 migratedDelta 上
 *    (不并入 delta:重新摘要这一楼时 delta 换成新结果,迁移来的状态仍保留;重建记忆时按正文重新推算后替换)。
 *  - 角色、好感、着装、关系等暂不迁移:Horae 的这些字段格式尚未核对,映射之前不转换(心情、RPG、自定义表格同样不迁移)。
 */

import { getContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { isAiFloor, syncHiddenNow } from './engine';
import { makeLeafId } from './apply';
import { assertMemoryWritable, memoryWriteIssue, memory, recomputeDerived } from './store';
import { inspectCompatibility } from './compatibility';
import { MEMORY_KEY, MEMORY_VERSION } from './types';
import type { ItemDelta, LeafExtra, MemSummary, StoredDelta } from './types';

/* ============ Horae 源数据形状(只取迁移用得到的字段) ============ */

interface HoraeTimestamp {
  story_date?: string;
  story_time?: string;
  absolute?: string;
}
interface HoraeEvent {
  level?: string;
  summary?: string;
  isSummary?: boolean;
  _summaryId?: string;
}
interface HoraeItemInfo {
  holder?: string;
  location?: string;
  description?: string;
}
interface HoraeAgendaItem {
  type?: string;
  date?: string;
  text?: string;
  done?: boolean;
}
interface HoraeSummaryEntry {
  id?: string;
  range?: [number, number];
  summaryText?: string;
  depth?: number;
  createdAt?: string;
  auto?: boolean;
  mergedSummaries?: HoraeSummaryEntry[];
}
interface HoraeMeta {
  timestamp?: HoraeTimestamp;
  scene?: { location?: string };
  items?: Record<string, HoraeItemInfo>;
  deletedItems?: string[];
  events?: HoraeEvent[];
  event?: HoraeEvent; // 旧格式:单个 event
  agenda?: HoraeAgendaItem[];
  deletedAgenda?: string[];
  _deletedAgendaTexts?: string[];
  _skipHorae?: boolean;
  autoSummaries?: HoraeSummaryEntry[];
}

/* ============ 小工具 ============ */

/** 取一条消息上的 horae_meta(可能没有) */
function horaeMeta(m: STMessage | undefined): HoraeMeta | undefined {
  return (m as unknown as { horae_meta?: HoraeMeta } | undefined)?.horae_meta;
}

/** 合成时间点字符串:date + time(各自可缺)。两者皆空 → ''。 */
function combineTime(ts: HoraeTimestamp | undefined): string {
  const d = (ts?.story_date ?? '').trim();
  const t = (ts?.story_time ?? '').trim();
  return [d, t].filter(Boolean).join(' ').trim();
}

/** 取一层的叙事文本:非摘要卡 events 的 summary 拼接(摘要卡 level='摘要'/isSummary 跳过)。 */
function narrativeOf(meta: HoraeMeta | undefined): string {
  if (!meta) return '';
  const events = meta.events ?? (meta.event ? [meta.event] : []);
  return events
    .filter(e => e && !e.isSummary && e.level !== '摘要')
    .map(e => (e.summary ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// Horae getItemBaseName 用的量词集合(剥「(量词)」后缀);保持与源一致。
const COUNTING_CLASSIFIERS = '个把条块张根口份枚只颗支件套双对碗杯盘盆串束扎';
const RE_QTY_PAREN = /[(（]\s*(\d+(?:\.\d+)?)\s*[a-zA-Z一-鿿]*\s*[)）]\s*$/; // (3) (3个) (500g)
const RE_PURE_CLASSIFIER = new RegExp(`[(（][${COUNTING_CLASSIFIERS}][)）]\\s*$`);
// 消耗/归零标记:出现即视为该物品已没
const RE_CONSUMED = /[(（](已消耗|已用完|已销毁|已銷毀|消耗殆尽|消耗殆盡|消耗|用尽|用盡|consumed|used\s*up|destroyed|depleted)[)）]/i;
const RE_ZERO = /[(（]\s*0\s*[a-zA-Z一-鿿]*\s*[)）]\s*$/;

/** 从 Horae 物品名解析出基础名 + 数量。数量编码在名字括号里(如「苹果(3)」)。 */
function parseHoraeItemName(raw: string): { name: string; qty?: number; consumed: boolean } {
  let name = String(raw ?? '').trim();
  if (RE_ZERO.test(name) || RE_CONSUMED.test(name)) return { name: name, consumed: true };
  let qty: number | undefined;
  const m = name.match(RE_QTY_PAREN);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) qty = n;
    name = name.replace(RE_QTY_PAREN, '').trim();
  }
  name = name.replace(RE_PURE_CLASSIFIER, '').trim();
  return { name, qty, consumed: false };
}

/* ============ 迁移计划(预览,纯只读) ============ */

export interface MigrationPlan {
  /** 禁止把保护态的空缓存当成可覆盖数据。 */
  blockedReason?: string;
  /** 是否检测到任何 Horae 数据 */
  hasData: boolean;
  /** 有叙事可建叶子的 AI 楼数 */
  leafFloors: number;
  /** 没有 Horae 记录、迁移后仍待摘要的 AI 楼数(补齐之前会拦截生成) */
  pendingFloors: number;
  /** 可迁移的总结(压缩节点)数 */
  summaryCount: number;
  /** 最终库存物品数 */
  itemCount: number;
  /** 未了结计划/悬念数 */
  planCount: number;
  /** 当前棱镜宝书是否已有森林数据(将被覆盖) */
  willOverwrite: boolean;
}

/** 把 chat 折叠成最终库存(逐层快照前向合并 + 处理删除/消耗)。 */
function foldFinalItems(chat: STMessage[]): ItemDelta[] {
  // 按基础名归并(Horae 同物可能换写法),保留最后一次出现的描述/地点。
  const byKey = new Map<string, ItemDelta>();
  const keyOf = (name: string) => name.trim().toLowerCase();

  for (let i = 0; i < chat.length; i++) {
    const meta = horaeMeta(chat[i]);
    if (!meta || meta._skipHorae) continue;

    if (meta.items) {
      for (const [rawName, info] of Object.entries(meta.items)) {
        const { name, qty, consumed } = parseHoraeItemName(rawName);
        if (!name) continue;
        const k = keyOf(name);
        if (consumed) {
          byKey.delete(k);
          continue;
        }
        const loc = (info?.location ?? '').trim();
        const desc = (info?.description ?? '').trim();
        const entry: ItemDelta = byKey.get(k) ?? { name };
        entry.name = name; // 以最新写法为准
        if (qty !== undefined) entry.qty = qty;
        if (desc) entry.desc = desc;
        if (loc) {
          entry.location = loc;
          entry.carried = false;
        }
        byKey.set(k, entry);
      }
    }
    // 显式删除
    for (const del of meta.deletedItems ?? []) {
      const { name } = parseHoraeItemName(del);
      byKey.delete(keyOf(name));
    }
  }
  return [...byKey.values()];
}

/** 把 chat 折叠成最终「未了结计划/悬念」。 */
function foldOpenPlans(chat: STMessage[]): StoredDelta['plans'] {
  const deleted = new Set<string>();
  const norm = (s: unknown) => String(s ?? '').trim();
  // 先收集所有删除标记(各层 deletedAgenda + chat[0]._deletedAgendaTexts)
  for (const m of chat) {
    const meta = horaeMeta(m);
    for (const d of meta?.deletedAgenda ?? []) if (norm(d)) deleted.add(norm(d));
    for (const d of meta?._deletedAgendaTexts ?? []) if (norm(d)) deleted.add(norm(d));
  }
  // 前向合并 agenda(按 text 去重,后出现的覆盖)
  const byText = new Map<string, HoraeAgendaItem>();
  for (const m of chat) {
    const meta = horaeMeta(m);
    for (const a of meta?.agenda ?? []) {
      const text = norm(a?.text);
      if (!text) continue;
      byText.set(text, a);
    }
  }
  const add: NonNullable<StoredDelta['plans']>['add'] = [];
  for (const [text, a] of byText) {
    if (a.done) continue;
    if (deleted.has(text)) continue;
    const kind = a.type === '悬念' || a.type === '懸念' ? 'suspense' : 'plan';
    add.push({ kind, content: text, createdTime: norm(a.date) || undefined });
  }
  return add.length ? { add } : undefined;
}

/** 递归 flatten Horae autoSummaries(嵌套 mergedSummaries),返回 [条目, 父id]。 */
function flattenHoraeSummaries(
  tops: HoraeSummaryEntry[],
): Array<{ entry: HoraeSummaryEntry; parentId: string | null }> {
  const out: Array<{ entry: HoraeSummaryEntry; parentId: string | null }> = [];
  const walk = (entry: HoraeSummaryEntry, parentId: string | null) => {
    if (!entry?.id) return;
    out.push({ entry, parentId });
    for (const child of entry.mergedSummaries ?? []) walk(child, entry.id);
  };
  for (const t of tops) walk(t, null);
  return out;
}

/** 各 AI 楼的「时间点」:本层没有时沿用上一已知值(carry-forward)。 */
function horaeFloorTimes(chat: STMessage[], aiFloors: number[]): Map<number, string> {
  const floorTime = new Map<number, string>();
  let lastKnown = '';
  for (const idx of aiFloors) {
    const t = combineTime(horaeMeta(chat[idx])?.timestamp);
    if (t) lastKnown = t;
    floorTime.set(idx, lastKnown);
  }
  return floorTime;
}

/**
 * Horae autoSummaries → 棱镜宝书森林节点。先处理子条目再处理父条目(flat 中父条目在前,倒序即后序),
 * childIds 只收已保留的子条目和范围内未被子条目覆盖的叶子,不留悬空引用。
 * 整棵子树都没有叶子的条目存为导入历史:保住总结文字,覆盖的楼层也不再算待摘要;没有有效范围的空条目跳过。
 */
function buildHoraeForest(
  chat: STMessage[],
  flat: Array<{ entry: HoraeSummaryEntry; parentId: string | null }>,
  leafIdByFloor: Map<number, string>,
  floorTime: Map<number, string>,
): MemSummary[] {
  const childEntriesByParent = new Map<string, HoraeSummaryEntry[]>();
  for (const { entry, parentId } of flat) {
    if (!parentId) continue;
    const list = childEntriesByParent.get(parentId) ?? [];
    list.push(entry);
    childEntriesByParent.set(parentId, list);
  }
  const base = Date.now();
  const kept = new Map<string, MemSummary>();
  for (let k = flat.length - 1; k >= 0; k--) {
    const { entry } = flat[k];
    const id = String(entry.id);
    if (kept.has(id)) continue;
    const level = normalizeDepth(entry.depth);
    const childEntries = childEntriesByParent.get(id) ?? [];
    const childRanges = childEntries.map(c => c.range).filter(Boolean) as [number, number][];
    // childIds:① 已保留的直接子条目 id(下层 comp 或导入历史);② 本范围内、未被任何子条目范围覆盖的叶子 id。
    const childIds: string[] = childEntries.map(c => String(c.id)).filter(cid => kept.has(cid));
    const range = entry.range;
    if (range) {
      for (let i = range[0]; i <= range[1]; i++) {
        const leafId = leafIdByFloor.get(i);
        if (!leafId) continue;
        if (childRanges.some(([a, b]) => i >= a && i <= b)) continue; // 已属某子条目
        childIds.push(leafId);
      }
    }
    const text = (entry.summaryText ?? '').trim();
    const common = { id, text, level, createdAt: base + k, auto: entry.auto !== false };
    if (childIds.length) {
      // 时间段:范围内首尾叶子的起止
      const { start, end } = rangeTimeSpan(range, floorTime, leafIdByFloor);
      kept.set(id, { ...common, timeStart: start || undefined, timeEnd: end || undefined, childIds });
      continue;
    }
    const validRange = !!range && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 0 && range[0] <= range[1] && range[1] < chat.length;
    if (!validRange || !text) continue; // 空壳且范围不明:跳过
    const { start, end } = floorSpanTime(range!, floorTime);
    kept.set(id, { ...common, timeStart: start || undefined, timeEnd: end || undefined, childIds: [], imported: true, importedFloorStart: range![0], importedFloorEnd: range![1] });
  }
  // 输出保持 flat 的原有次序(父条目在前)
  return flat.map(({ entry }) => kept.get(String(entry.id))).filter((s): s is MemSummary => !!s);
}

/** 导入历史(范围内没有叶子)的时间段:取范围内 AI 楼已知时间点的首尾。 */
function floorSpanTime(range: [number, number], floorTime: Map<number, string>): { start: string; end: string } {
  let start = '';
  let end = '';
  for (let i = range[0]; i <= range[1]; i++) {
    const t = floorTime.get(i) || '';
    if (t && !start) start = t;
    if (t) end = t;
  }
  return { start, end };
}

/** 导入历史覆盖的楼层(迁移后不再算待摘要)。 */
function importedFloors(summaries: MemSummary[]): Set<number> {
  const out = new Set<number>();
  for (const s of summaries) {
    if (!s.imported) continue;
    for (let i = s.importedFloorStart ?? 0; i <= (s.importedFloorEnd ?? -1); i++) out.add(i);
  }
  return out;
}

/** 聊天里是否有 Horae 的旧数据。 */
export function hasHoraeData(chat: STMessage[]): boolean {
  return chat.some(m => !!horaeMeta(m));
}

/**
 * 早先版本的迁移把最终物品、计划写在最后一片叶子的 delta 里(现在单独存在 migratedDelta),这类叶子无法可靠识别。
 * 只在「聊天有 Horae 数据、这一楼正是迁移时承载最终状态的那一楼、叶子正文仍是 Horae 的叙事、delta 带物品或计划新增」时
 * 判为可能,返回该楼层,供重新摘要前提示;否则返回 -1。
 */
export function legacyMigrationSeedFloor(chat: STMessage[]): number {
  if (!hasHoraeData(chat)) return -1;
  let floor = -1;
  for (let i = chat.length - 1; i >= 0 && floor < 0; i--) if (isAiFloor(chat[i]) && narrativeOf(horaeMeta(chat[i]))) floor = i;
  for (let i = chat.length - 1; i >= 0 && floor < 0; i--) if (isAiFloor(chat[i])) floor = i;
  if (floor < 0) return -1;
  const leaf = chat[floor]?.extra?.bbs_leaf as (LeafExtra & { migratedDelta?: StoredDelta }) | undefined;
  if (!leaf || leaf.migratedDelta) return -1;
  if ((typeof leaf.text === 'string' ? leaf.text.trim() : '') !== narrativeOf(horaeMeta(chat[floor]))) return -1;
  const delta = leaf.delta ?? {};
  return delta.items?.add?.length || delta.plans?.add?.length ? floor : -1;
}

/** 计算迁移计划(只读,不产生副作用),供 UI 预览与按钮启停。 */
export function computeMigrationPlan(): MigrationPlan {
  const blockedReason = memoryWriteIssue();
  if (blockedReason) return { hasData: false, leafFloors: 0, pendingFloors: 0, summaryCount: 0, itemCount: 0, planCount: 0, willOverwrite: false, blockedReason };
  const ctx = getContext();
  const chat = ctx?.getCurrentChatId?.() ? ctx?.chat ?? [] : [];

  const aiFloors: number[] = [];
  for (let i = 0; i < chat.length; i++) if (isAiFloor(chat[i])) aiFloors.push(i);
  // 按迁移的口径模拟建叶子(只用占位 id),算出迁移后仍待摘要的楼层
  const leafIdByFloor = new Map<number, string>();
  for (const i of aiFloors) if (narrativeOf(horaeMeta(chat[i]))) leafIdByFloor.set(i, 'preview-' + i);
  const leafFloors = leafIdByFloor.size;

  const tops = (chat[0] && horaeMeta(chat[0])?.autoSummaries) || [];
  const flat = flattenHoraeSummaries(tops);
  const summaryCount = flat.length;

  const items = foldFinalItems(chat);
  const plans = foldOpenPlans(chat);

  const hasData =
    leafFloors > 0 || summaryCount > 0 || items.length > 0 || !!plans?.add?.length;
  // 没有任何叙事、只有状态时,迁移会在最后一个 AI 楼挂一片空摘要承载状态
  if (hasData && !leafFloors && aiFloors.length) leafIdByFloor.set(aiFloors[aiFloors.length - 1], 'preview-seed');
  const covered = importedFloors(buildHoraeForest(chat, flat, leafIdByFloor, horaeFloorTimes(chat, aiFloors)));
  const pendingFloors = hasData ? aiFloors.filter(i => !leafIdByFloor.has(i) && !covered.has(i)).length : 0;

  return {
    hasData,
    leafFloors,
    pendingFloors,
    summaryCount,
    itemCount: items.length,
    planCount: plans?.add?.length ?? 0,
    willOverwrite: memory.summaries.length > 0 || hasAnyLeaf(chat),
  };
}

/** chat 上是否已有棱镜宝书叶子(用于「将覆盖」提示)。 */
function hasAnyLeaf(chat: STMessage[]): boolean {
  return chat.some(m => !!m?.extra?.bbs_leaf);
}

/* ============ 执行迁移 ============ */

/**
 * 把当前聊天里的 Horae 数据迁移成棱镜宝书数据。返回是否成功。
 * 直接写当前 chat 的消息 extra(叶子)与 chatMetadata(森林),落盘后刷新。
 */
export async function runHoraeMigration(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) {
    toast('酒馆上下文不可用，请刷新页面后再试。', 'error');
    return false;
  }
  if (!ctx.getCurrentChatId?.()) {
    toast('请先打开一个聊天再迁移。', 'warning');
    return false;
  }
  const sourceChat = ctx.chat;
  const meta = ctx.chatMetadata;
  const sourceId = ctx.getCurrentChatId();
  const stillHere = () => {
    const current = getContext();
    return current?.chat === sourceChat && current?.chatMetadata === meta && current?.getCurrentChatId?.() === sourceId;
  };
  const requireSource = () => {
    if (!stillHere()) throw new Error('迁移期间聊天归属已变化，停止后续操作');
    assertMemoryWritable();
  };
  let rollback: (() => void) | undefined;
  let persistenceStarted = false;
  try {
    requireSource(); // 在读计划/快照之前阻断保护态与 V2 待转换。
    if (!sourceChat?.length) {
      toast('这个聊天是空的，没有可以迁移的数据。', 'warning');
      return false;
    }
    if (!meta || typeof ctx.saveChat !== 'function') {
      throw new Error('宿主缺少可靠保存接口，未修改数据');
    }
    const plan = computeMigrationPlan();
    if (!plan.hasData) {
      toast('这个聊天里没有 Horae 的旧数据。', 'warning');
      return false;
    }
    // 在独立候选上造叶子/折叠状态。构造中途失败不触碰任何原消息。
    const chat: STMessage[] = JSON.parse(JSON.stringify(sourceChat));
    // ===== 1. 为每个有叙事的 AI 楼造叶子(时间点→时间段) =====
    // aiFloors:按楼序的 AI 楼索引;每层 timeEnd=本层时间点,timeStart=上一层时间点。
    const aiFloors: number[] = [];
    for (let i = 0; i < chat.length; i++) if (isAiFloor(chat[i])) aiFloors.push(i);

    // 先算每个 AI 楼的「时间点」(carry-forward:本层无则沿用上一已知)
    const floorTime = horaeFloorTimes(chat, aiFloors);

    // 楼 idx → 新建叶子 id(供森林 childIds 引用);仅有叙事的楼建叶子。
    const leafIdByFloor = new Map<number, string>();
    let prevTime = '';
    let lastLeafFloor = -1;
    for (let k = 0; k < aiFloors.length; k++) {
      const idx = aiFloors[k];
      const text = narrativeOf(horaeMeta(chat[idx]));
      const end = floorTime.get(idx) || '';
      // 段左界:上一已知时间点;首层用本层(start=end)。
      const start = prevTime || end;
      if (text) {
        const leaf: LeafExtra = {
          id: makeLeafId(),
          text,
          delta: {},
          timeStart: start || undefined,
          timeEnd: end || undefined,
          createdAt: Date.now() + k, // 单调递增,保证 tie-break 与楼序一致
          swipe: typeof chat[idx].swipe_id === 'number' ? chat[idx].swipe_id : 0,
          v: 1,
        };
        chat[idx].extra = { ...(chat[idx].extra ?? {}), bbs_leaf: leaf };
        leafIdByFloor.set(idx, leaf.id);
        lastLeafFloor = idx;
      }
      if (end) prevTime = end;
    }

    // ===== 2. 把最终状态(物品/计划/时间/地点)单独存在最后一片叶子的 migratedDelta 上 =====
    // 不并入 delta:重新摘要这一楼时 delta 换成新结果,迁移来的状态仍保留(重放时在 delta 之后施加)。
    // 若没有任何叙事叶子但有状态,造一条空文本叶子挂到最后一个 AI 楼承载它。
    const items = foldFinalItems(chat);
    const plans = foldOpenPlans(chat);
    const finalState = computeFinalState(chat);

    if (lastLeafFloor < 0 && aiFloors.length) {
      const idx = aiFloors[aiFloors.length - 1];
      const leaf: LeafExtra = {
        id: makeLeafId(),
        text: '',
        delta: {},
        timeEnd: floorTime.get(idx) || undefined,
        timeStart: floorTime.get(idx) || undefined,
        createdAt: Date.now() + aiFloors.length,
        swipe: typeof chat[idx].swipe_id === 'number' ? chat[idx].swipe_id : 0,
        v: 1,
      };
      chat[idx].extra = { ...(chat[idx].extra ?? {}), bbs_leaf: leaf };
      leafIdByFloor.set(idx, leaf.id);
      lastLeafFloor = idx;
    }

    if (lastLeafFloor >= 0) {
      const seedLeaf = chat[lastLeafFloor].extra!.bbs_leaf as LeafExtra & { migratedDelta?: StoredDelta };
      const migrated: StoredDelta = {};
      if (items.length) migrated.items = { add: items };
      if (plans) migrated.plans = plans;
      if (finalState.time) migrated.time = finalState.time;
      if (finalState.location) migrated.location = finalState.location;
      if (Object.keys(migrated).length) seedLeaf.migratedDelta = migrated;
    }

    // ===== 3. 重建森林(autoSummaries → comp 节点;整棵子树没有叶子的存为导入历史) =====
    const tops = (chat[0] && horaeMeta(chat[0])?.autoSummaries) || [];
    const newSummaries = buildHoraeForest(chat, flattenHoraeSummaries(tops), leafIdByFloor, floorTime);

    // 完整候选通过检查后才一次同步安装；保存分步等待，不声称磁盘原子性。
    const oldRaw = meta[MEMORY_KEY];
    const hadRaw = Object.prototype.hasOwnProperty.call(meta, MEMORY_KEY);
    const candidate = {
      ...(oldRaw as Record<string, unknown> | undefined),
      version: MEMORY_VERSION,
      summaries: newSummaries,
    };
    const report = inspectCompatibility(candidate, chat);
    if (report.mode !== 'ready') throw new Error('迁移候选不完整：' + report.issues.join('；'));
    const operations = [...leafIdByFloor.keys()].map(idx => ({
      message: sourceChat[idx],
      hadExtra: Object.prototype.hasOwnProperty.call(sourceChat[idx], 'extra'),
      original: sourceChat[idx].extra,
      candidate: chat[idx].extra,
    }));
    const oldSummaries = [...memory.summaries];
    const candidateState = JSON.stringify({ extras: operations.map(op => op.candidate), raw: candidate, summaries: newSummaries });
    requireSource(); // 首次修改前再检查。
    rollback = () => {
      // 不覆盖其他编辑，也不把旧聊天森林装进已经切换的全局缓存。
      if (!stillHere() || meta[MEMORY_KEY] !== candidate ||
          operations.some(op => op.message.extra !== op.candidate) ||
          JSON.stringify({ extras: operations.map(op => op.message.extra), raw: meta[MEMORY_KEY], summaries: memory.summaries }) !== candidateState) return;
      for (const op of operations) {
        if (op.hadExtra) op.message.extra = op.original;
        else delete op.message.extra;
      }
      if (hadRaw) meta[MEMORY_KEY] = oldRaw;
      else delete meta[MEMORY_KEY];
      memory.summaries.splice(0, memory.summaries.length, ...oldSummaries);
      recomputeDerived();
    };
    for (const op of operations) op.message.extra = op.candidate;
    meta[MEMORY_KEY] = candidate;
    memory.summaries.splice(0, memory.summaries.length, ...newSummaries);
    recomputeDerived();
    requireSource();
    persistenceStarted = true;
    await ctx.saveChat();
    requireSource();
    if (typeof ctx.saveMetadata === 'function') {
      await ctx.saveMetadata();
      requireSource();
    }
    // 保存已确认后，隐藏刷新失败不撤销已保存的迁移。
    rollback = undefined;
    await syncHiddenNow();
    requireSource();

    const covered = importedFloors(newSummaries);
    const pendingAfter = aiFloors.filter(i => !leafIdByFloor.has(i) && !covered.has(i)).length;
    toast(
      `迁移完成：摘要 ${leafIdByFloor.size} 层，总结 ${newSummaries.length} 条，物品 ${items.length} 个，计划悬念 ${plans?.add?.length ?? 0} 条。`
        + (pendingAfter ? `另有 ${pendingAfter} 层没有 Horae 记录，需要在摘要页补摘，补齐之前会拦截生成。` : ''),
      pendingAfter ? 'warning' : 'success',
    );
    return true;
  } catch (e) {
    try { rollback?.(); } catch (restoreError) { console.error('[棱镜宝书] 恢复迁移内存失败:', restoreError); }
    const warning = persistenceStarted ? '；保存可能已部分完成，请返回原聊天核对，未执行磁盘回滚' : '';
    toast(`迁移失败：${e instanceof Error ? e.message : String(e)}${warning}`, 'error');
    console.error('[棱镜宝书] Horae 迁移失败:', e);
    return false;
  }
}

/** 规整 depth → 棱镜宝书 level(≥1)。 */
function normalizeDepth(depth: unknown): number {
  const n = typeof depth === 'number' ? depth : parseInt(String(depth ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** 某 comp 范围内的时间段:取范围内有叶子的最早起始与最晚结束。 */
function rangeTimeSpan(
  range: [number, number] | undefined,
  floorTime: Map<number, string>,
  leafIdByFloor: Map<number, string>,
): { start: string; end: string } {
  if (!range) return { start: '', end: '' };
  let start = '';
  let end = '';
  for (let i = range[0]; i <= range[1]; i++) {
    if (!leafIdByFloor.has(i)) continue;
    const t = floorTime.get(i) || '';
    if (t && !start) start = t;
    if (t) end = t;
  }
  return { start, end };
}

/** 折叠出最终时间/地点(逐层前向覆盖)。 */
function computeFinalState(chat: STMessage[]): { time: string; location: string } {
  let time = '';
  let location = '';
  for (const m of chat) {
    const meta = horaeMeta(m);
    if (!meta || meta._skipHorae) continue;
    const t = combineTime(meta.timestamp);
    if (t) time = t;
    const loc = (meta.scene?.location ?? '').trim();
    if (loc) location = loc;
  }
  return { time, location };
}
