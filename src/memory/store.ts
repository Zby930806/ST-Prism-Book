import { apiSettings, currentCharKey } from '@/api/settings';
import { getContext, type STMessage } from '@/st/context';
import { reactive } from 'vue';
import { convertedForest, inspectCompatibility, isRecord, legacyLeafIssue, type CompatibilityReport } from './compatibility';
import { deriveMemory, getLeaf, leafValid } from './apply';
import { isAiFloor, pendingAiFloors } from './engine';
import { initialStoryTime, latestStoryTime } from './timeTag';
import type { BaibaiMemory, LeafExtra, MemSummary, VarTemplate, VarTier } from './types';
import { createEmptyMemory, MEMORY_KEY, MEMORY_VERSION, normalizeTemplate } from './types';

/**
 * 响应式记忆镜像。
 * 真源:① 压缩节点森林 = chat_metadata[MEMORY_KEY].summaries;② 叶子 = chat 各消息 extra.bbs_leaf。
 * state / items / plans 是从 chat 重放出的派生缓存,供 Vue 渲染。
 */
export const memory = reactive<BaibaiMemory>(createEmptyMemory());

export const compatibilityState = reactive<CompatibilityReport & { converting: boolean }>({
  mode: 'ready', leaves: 0, summaries: 0, issues: [], conversion: [], converting: false,
});
let checkedChat: STMessage[] | undefined;
let checkedMetadata: unknown;
let checkedRaw: unknown;
let checkedChatId: string | undefined;
export function checkCompatibility(): void {
  const ctx = getContext();
  checkedChat = ctx?.chat;
  checkedMetadata = ctx?.chatMetadata;
  checkedChatId = ctx?.getCurrentChatId?.();
  const raw = (ctx?.chatMetadata as Record<string, unknown> | undefined)?.[MEMORY_KEY];
  checkedRaw = raw;
  Object.assign(compatibilityState, inspectCompatibility(raw, checkedChat ?? []));
}
/** 缓存只属于本次加载的聊天；切换聊天不能沿用另一聊天的兼容结论。 */
export function memoryWriteIssue(): string {
  const ctx = getContext();
  const raw = (ctx?.chatMetadata as Record<string, unknown> | undefined)?.[MEMORY_KEY];
  if (checkedChat !== ctx?.chat || checkedMetadata !== ctx?.chatMetadata || checkedChatId !== ctx?.getCurrentChatId?.() || checkedRaw !== raw) checkCompatibility();
  if (compatibilityState.converting) return '正在本地转换旧记忆，请稍候。';
  // 宿主翻页/编辑会原地改消息，引用缓存不能代表分页归属仍成立。
  // 这里只复查叶子；不能在合法删楼事务清理祖先前把暂时孤儿的树误判为损坏。
  if (compatibilityState.mode === 'ready' && ctx?.chat?.some(m => legacyLeafIssue(m?.extra?.bbs_leaf, m))) checkCompatibility();
  if (compatibilityState.mode === 'ready') return '';
  return compatibilityState.mode === 'convert'
    ? '检测到旧版记忆，请在摘要页确认本地转换；不需要重新摘要，也不会调用模型。'
    : '旧记忆保护中：' + compatibilityState.issues.join('；') + '。请先备份并核对，勿全量重建。';
}
export function assertMemoryWritable(): void {
  const issue = memoryWriteIssue();
  if (issue) throw new Error(issue);
}

/** 用户确认后才转换；备份旧元数据，保持原摘要/ID/状态/未知字段，不请求模型。 */
export async function convertLegacyMemory(): Promise<void> {
  const ctx = getContext();
  if (!ctx || !ctx.getCurrentChatId?.()) throw new Error('请先打开聊天');
  if (compatibilityState.converting) throw new Error('转换已在进行');
  checkCompatibility();
  if (compatibilityState.mode !== 'convert') throw new Error('当前旧记忆不能安全自动转换');
  if (typeof ctx.saveChat !== 'function' || typeof ctx.saveMetadata !== 'function') throw new Error('宿主缺少可靠保存接口，未修改数据');
  const meta = ctx.chatMetadata as Record<string, unknown>;
  const sourceChat = ctx.chat;
  const sourceId = ctx.getCurrentChatId();
  const stillHere = () => {
    const current = getContext();
    return current?.chat === sourceChat && current?.chatMetadata === meta && current?.getCurrentChatId?.() === sourceId;
  };
  const requireSameChat = () => { if (!stillHere()) throw new Error('转换期间已切换聊天，停止后续保存；请返回原聊天核对备份。'); };
  const raw = meta[MEMORY_KEY] as Record<string, unknown>;
  const backupKey = 'prism_book_legacy_backup';
  if (meta[backupKey] !== undefined) throw new Error('已有旧格式备份，先核对上次转换结果；不会覆盖备份');
  const original = JSON.parse(JSON.stringify(raw));
  const plan: CompatibilityReport['conversion'] = JSON.parse(JSON.stringify(compatibilityState.conversion));
  const operations = plan.map(op => ({ message: ctx.chat[op.floor], extra: ctx.chat[op.floor].extra, leaf: JSON.parse(JSON.stringify(op.leaf)) as LeafExtra }));
  compatibilityState.converting = true;
  try {
    meta[backupKey] = original;
    // 先将旧格式备份单独落盘，失败则不动任何叶子。
    await ctx.saveMetadata();
    requireSameChat();
    for (const op of operations) op.message.extra = { ...op.extra, bbs_leaf: op.leaf };
    meta[MEMORY_KEY] = { ...raw, version: MEMORY_VERSION, summaries: convertedForest(raw) };
    // 一次完整聊天保存先持久化叶子和备份，然后等待元数据保存；不使用不受等待的防抖迁移。
    await ctx.saveChat();
    requireSameChat();
    await ctx.saveMetadata();
    requireSameChat();
  } catch (error) {
    for (const op of operations) op.message.extra = op.extra;
    meta[MEMORY_KEY] = raw;
    // 备份保留，避免未知磁盘状态下重试覆盖；原元数据从未丢弃。
    throw new Error('转换保存未确认成功，已恢复内存中的原记录并保留备份。请先导出聊天核对，不要重建。' + String(error));
  } finally {
    compatibilityState.converting = false;
    if (stillHere()) loadMemory();
  }
}


/**
 * 给页面读的派生元信息(chat 非 reactive,UI 必须经此 reactive 通道):
 *  - hasLeaf:是否有任一有效叶子(无则禁用手动添加)。
 *  - leaves:供 summary 页展示的叶子列表(含陈旧标记)。
 */
export interface LeafView {
  id: string;
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string; // 旧数据回退
  createdAt: number;
  msgIndex: number;
  active: boolean; // 所在消息已隐藏(is_system)
  stale: boolean; // 正文已变、尚未重摘
}
export const derivedMeta = reactive<{ hasLeaf: boolean; leaves: LeafView[]; pendingFloors: number[]; latestStoryTime: string; rev: number }>({
  hasLeaf: false,
  leaves: [],
  pendingFloors: [],
  // 故事内最新时间:从正文标签实时读(不依赖是否已摘),供摘要页展示与相对时间参照
  latestStoryTime: '',
  // 递增版本号:每次 recomputeDerived 都 +1。chat 非 reactive,楼内面板等外部视图读它即可
  // 追踪「派生已重算」——无论重算由 ST 事件、主界面摘要、还是楼内编辑触发,都能统一刷新。
  rev: 0,
});

function scalarText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

function optText(v: unknown): string | undefined {
  return scalarText(v) || undefined;
}

/** 重放 chat 得到 state/items/plans,原地写回;并刷新 derivedMeta */
export function recomputeDerived(): void {
  const ctx = getContext();
  if (memoryWriteIssue()) {
    const empty = createEmptyMemory();
    for (const key of ['state', 'protagonist', 'items', 'plans', 'scenes', 'npcs', 'itemLog', 'lifeDetails', 'vars'] as const) Object.assign(memory, { [key]: empty[key] });
    Object.assign(derivedMeta, { hasLeaf: false, leaves: [], pendingFloors: [], latestStoryTime: '', rev: derivedMeta.rev + 1 });
    return;
  }
  // 欢迎页(未进入任何聊天)getCurrentChatId 为空,但 chat 里可能残留上次的 #0,
  // 不属于任何聊天的楼层不该被判为「未摘要」,故此时视作无 chat。
  const chat = ctx?.getCurrentChatId?.() ? ctx.chat ?? null : null;
  const d = deriveMemory(chat);
  memory.state.time = d.state.time;
  memory.state.location = d.state.location;
  memory.state.locationPath = d.state.locationPath;
  memory.state.sceneFocus = d.state.sceneFocus;
  // 年龄(age+ageTime 锚点对)也在 protagonist 上,漏拷会让 UI/注入永远读不到主角年龄
  for (const key of ['gender', 'age', 'ageTime', 'identity', 'appearance', 'outfit', 'condition'] as const) {
    memory.protagonist[key] = d.protagonist[key];
  }
  memory.items.splice(0, memory.items.length, ...d.items);
  memory.plans.splice(0, memory.plans.length, ...d.plans);
  memory.scenes.splice(0, memory.scenes.length, ...d.scenes);
  memory.npcs.splice(0, memory.npcs.length, ...d.npcs);
  memory.itemLog.splice(0, memory.itemLog.length, ...d.itemLog);
  memory.lifeDetails.splice(0, memory.lifeDetails.length, ...d.lifeDetails);
  // vars 是 JSON 对象:清空后按派生结果重填(不换 reactive 引用,保持页面响应式绑定)
  for (const k of Object.keys(memory.vars)) delete memory.vars[k];
  Object.assign(memory.vars, d.vars);

  // derivedMeta:扫 chat 收集叶子(含陈旧)
  const leaves: LeafView[] = [];
  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      const m = chat[i];
      if (m?.extra?.bbs_omit) continue; // 番外楼:不进摘要页叶子列表
      const leaf = getLeaf(m);
      if (!leaf) continue;
      const valid = leafValid(m);
      leaves.push({
        id: leaf.id,
        text: scalarText(leaf.text),
        timeStart: optText(leaf.timeStart),
        timeEnd: optText(leaf.timeEnd),
        timeLabel: optText(leaf.timeLabel),
        createdAt: typeof leaf.createdAt === 'number' ? leaf.createdAt : Date.now(),
        msgIndex: i,
        active: m.is_system === true,
        stale: !valid,
      });
    }
  }
  derivedMeta.leaves = leaves;
  derivedMeta.hasLeaf = leaves.some(l => !l.stale);
  derivedMeta.latestStoryTime = latestStoryTime(chat) || (chat ? initialStoryTime() : '');
  // 待摘要楼层(AI 楼且无有效叶子),供摘要页「未摘要楼层」列表逐楼补摘
  derivedMeta.pendingFloors = chat ? pendingAiFloors(chat) : [];
  derivedMeta.rev++; // 通知外部视图(楼内面板)派生已刷新
}

/* ============ 落盘:叶子在 chat 文件,森林在 metadata ============ */

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 防抖落盘叶子(写进 chat 文件)。合并连续多楼摘要为一次 saveChat。 */
export function scheduleLeafFlush(): void {
  assertMemoryWritable();
  const ctx = getContext();
  if (!ctx?.saveChat) return;
  if (flushTimer) clearTimeout(flushTimer);
  const sourceChat = ctx.chat;
  const sourceMetadata = ctx.chatMetadata;
  const sourceId = ctx.getCurrentChatId?.();
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const current = getContext();
    // 宿主保存函数可能读取全局当前聊天，不能让上一聊天的定时器落到新聊天。
    if (current?.chat !== sourceChat || current?.chatMetadata !== sourceMetadata ||
        current?.getCurrentChatId?.() !== sourceId || memoryWriteIssue()) return;
    void ctx.saveChat();
  }, 1500);
}

/** 立即落盘(切聊天/卸载前调用,避免丢未落盘叶子) */
export function flushLeavesNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (memoryWriteIssue()) return;
  const ctx = getContext();
  void ctx?.saveChat?.();
}

/**
 * 把森林(压缩节点)+ **仅 chat 层**变量模板写回 chat_metadata 并持久化。
 * 全局/角色层的模板不在这里(它们存 extension_settings,由 replaceVarsTemplate 落盘)。叶子也不在这里。
 */
export function saveMemory() {
  assertMemoryWritable();
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  const snapshot: { version: number; summaries: MemSummary[]; varsTemplate: VarTemplate } = {
    ...((ctx.chatMetadata as Record<string, unknown>)[MEMORY_KEY] as Record<string, unknown> ?? {}),
    version: MEMORY_VERSION,
    summaries: JSON.parse(JSON.stringify(memory.summaries)),
    varsTemplate: JSON.parse(JSON.stringify(memory.varTemplates.chat)),
  };
  (ctx.chatMetadata as Record<string, unknown>)[MEMORY_KEY] = snapshot;
  checkedRaw = snapshot; // 本次受保护写入，避免在编辑事务中途重新判定森林
  ctx.saveMetadataDebounced?.();
}

/* ============ 载入 / 保存 ============ */

function cleanSummaryNode(s: MemSummary, idx: number): MemSummary {
  return {
    ...s, // 沿用旧扩展字段，不能因换品牌静默丢失
    id: s.id,
    text: s.text,
    level: typeof s.level === 'number' ? s.level : 1,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    auto: s.auto !== false,
    timeStart: optText(s.timeStart),
    timeEnd: optText(s.timeEnd),
    timeLabel: optText(s.timeLabel),
    childIds: [...s.childIds],
    imported: s.imported === true ? true : undefined,
    importedFloorStart:
      s.imported === true && Number.isFinite(s.importedFloorStart) && (s.importedFloorStart as number) >= 0
        ? Math.floor(s.importedFloorStart as number)
        : undefined,
    importedFloorEnd:
      s.imported === true && Number.isFinite(s.importedFloorEnd) && (s.importedFloorEnd as number) >= 0
        ? Math.floor(s.importedFloorEnd as number)
        : undefined,
  };
}

function assignForest(target: BaibaiMemory, summaries: MemSummary[], varTemplates: Record<VarTier, VarTemplate>) {
  target.version = MEMORY_VERSION;
  target.summaries = summaries.map(cleanSummaryNode);
  target.varTemplates = varTemplates;
}

/** 读三层变量模板(chat 来自传入的 chatMetadata 原始值;global/char 来自 settings)。 */
function loadVarTemplates(rawChatTemplate: unknown): Record<VarTier, VarTemplate> {
  const key = currentCharKey();
  return {
    global: normalizeTemplate(apiSettings.varsGlobalTemplate),
    char: key ? normalizeTemplate(apiSettings.varsTemplateByChar[key]) : { json: {}, meaning: '', rule: '' },
    chat: normalizeTemplate(rawChatTemplate),
  };
}

/** 从当前聊天载入森林 + 三层变量模板 + 重算派生(必要时迁移) */
export function loadMemory() {
  checkCompatibility();
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  const raw = meta?.[MEMORY_KEY];
  const data = isRecord(raw) ? raw : undefined;
  const templates = loadVarTemplates(data?.varsTemplate);
  // 无法确认的格式留在原始存储里；绝不清理/覆盖成空森林，也不自动迁移。
  assignForest(memory, compatibilityState.mode === 'ready' && Array.isArray(data?.summaries)
    ? data.summaries as MemSummary[] : [], templates);
  recomputeDerived();
}

/**
 * 替换某一层的变量模板(供变量页编辑器保存):写回对应存储 → 更新内存 → 重算派生。
 *  - global → apiSettings.varsGlobalTemplate(跨设备同步);
 *  - char → apiSettings.varsTemplateByChar[avatar](无当前角色则忽略,UI 已禁用);
 *  - chat → chatMetadata(经 saveMemory)。
 * 模板变化只改「初始状态」,历史命令照旧重放(所以改初始值会影响整条聊天的当前值)。
 * 注:注入刷新由调用方(页面)负责 refreshInjection —— store 不引 inject 避免循环依赖。
 */
export function replaceVarsTemplate(tier: VarTier, tpl: VarTemplate): void {
  assertMemoryWritable();
  const norm = normalizeTemplate(tpl);
  memory.varTemplates[tier] = norm;
  if (tier === 'global') {
    apiSettings.varsGlobalTemplate = norm;
  } else if (tier === 'char') {
    const key = currentCharKey();
    if (key) {
      if (Object.keys(norm.json).length || norm.meaning.trim() || norm.rule.trim()) apiSettings.varsTemplateByChar[key] = norm;
      else delete apiSettings.varsTemplateByChar[key]; // 清空则移除键,不留空壳
    }
  } else {
    saveMemory(); // chat 层写 chatMetadata
  }
  recomputeDerived();
}

/** 监听聊天切换:切走前 flush 未落盘叶子,切来后重载 */
export function bindChatLifecycle() {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
    flushLeavesNow();
    loadMemory();
  });
  // 首次载入
  loadMemory();
}
