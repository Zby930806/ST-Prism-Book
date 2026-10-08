<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import OutlinePlanner from '@/pages/outline/index.vue';
import { outlineState } from '@/outline/store';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { addSummary, appendOpToLatestLeaf, deleteLeafAt, deleteSummary, deleteSummarySubtrees, editLeafAt, editPlan, editSummary, invalidateSummaryAncestors } from '@/memory/apply';
import { apiSettings } from '@/api/settings';
import { batchBackfill, batchState, cancelBatchBackfill, engineState, floorBackfillState, isAiFloor, resummarizeNow, summarizeFloor, summarizeSelected, syncHiddenNow } from '@/memory/engine';
import { estimateInjectionTokenBreakdown, refreshInjection, type ViewNode } from '@/memory/inject';
import { compactTimeLabel, formatRange, splitTimeLabel } from '@/memory/timeTag';
import { relativeTimeLabel, weekdayLabel } from '@/memory/timeRel';
import { compatibilityState, convertLegacyMemory, derivedMeta, memory, memoryWriteIssue, recomputeDerived } from '@/memory/store';
import type { SceneFocus } from '@/memory/types';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import SummaryNode from './SummaryNode.vue';
import SummaryPager from './SummaryPager.vue';
import { summaryErrorPresentation } from './errorPresentation';
const summaryFailure = computed(() => summaryErrorPresentation(engineState.lastError));
import { arrayPage, createSummaryIndex, PENDING_PAGE_SIZE, SUMMARY_PAGE_SIZE, treePage, walkExpanded } from './view';
import { SUMMARY_CTX, type SummaryRow } from './ctx';

/* 兼容报告是最近一次加载/检查时的快照，不作为实时摘要计数。 */
const convertConfirmOpen = ref(false);
const conversionPending = ref(false);
const conversionError = ref('');
const conversionBusy = computed(() => conversionPending.value || compatibilityState.converting);
const editingBlocked = computed(() => compatibilityState.mode !== 'ready' || conversionBusy.value);
let chatEpoch = 0;
let pageActive = true;
function captureChat() {
  const ctx = getContext();
  return { chat: ctx?.chat, metadata: ctx?.chatMetadata, id: ctx?.getCurrentChatId?.(), epoch: chatEpoch };
}
type ChatSnapshot = ReturnType<typeof captureChat>;
let conversionChat: ChatSnapshot | null = null;
function isSameChat(snapshot: ChatSnapshot): boolean {
  const current = captureChat();
  return pageActive && snapshot.epoch === current.epoch && snapshot.chat === current.chat
    && snapshot.metadata === current.metadata && snapshot.id === current.id;
}
function allowMemoryEdit(): boolean {
  const issue = memoryWriteIssue();
  if (!issue && !conversionPending.value) return true;
  toast(issue || '正在本地转换旧记忆，请等待保存结果。', 'warning');
  return false;
}
function openConversionConfirm() {
  if (conversionBusy.value || engineState.running) return;
  // 重新核对当前聊天，不能以另一聊天留下的报告打开确认。
  memoryWriteIssue();
  if (compatibilityState.mode !== 'convert') return;
  conversionChat = captureChat();
  conversionError.value = '';
  convertConfirmOpen.value = true;
}
async function confirmConversion() {
  if (conversionBusy.value || engineState.running) return;
  const target = conversionChat;
  if (!target || !isSameChat(target)) {
    convertConfirmOpen.value = false;
    toast('聊天已切换，请在目标聊天重新确认转换。', 'warning');
    return;
  }
  conversionPending.value = true;
  conversionError.value = '';
  try {
    await convertLegacyMemory();
    // store 负责原聊天的保存保护；页面不把旧任务结果应用到新聊天。
    if (!isSameChat(target)) return;
    recomputeDerived();
    refreshInjection();
    convertConfirmOpen.value = false;
    toast('旧记忆已本地转换并保存，已保留备份、刷新摘要与注入；未调用 AI，无需重建。', 'success');
  } catch (error) {
    if (!isSameChat(target)) return;
    conversionError.value = error instanceof Error ? error.message : String(error);
    toast('本地转换未确认成功：' + conversionError.value + ' 请先导出聊天核对，不要重建或反复转换。', 'error');
    convertConfirmOpen.value = false;
  } finally {
    conversionPending.value = false;
  }
}
function closeMemoryEditors() {
  closeComposer();
  cancelPlanEdit();
  cancelFocusEdit();
  cancelEdit();
  closeImportHistory();
  batchConfirmOpen.value = false;
  rebuildConfirmOpen.value = false;
  mergeConfirmOpen.value = false;
  deleteConfirmOpen.value = false;
  exitSelectMode();
}
// ModalMask/ConfirmDialog 会 Teleport，不能只依靠外层 fieldset 禁用。
watch(editingBlocked, blocked => { if (blocked) closeMemoryEditors(); });

// 打开摘要页时强制重算一次派生:未摘要楼层等派生缓存只在特定事件刷新,
// 边聊边攒的新 AI 楼可能没触发刷新,进页先对齐一次,避免列表漏楼。
onMounted(() => recomputeDerived());

// 切聊天:重置临时视图态(展开/搜索/选择),避免上个聊天的残留跨聊天带过来。
const resetViewStates = () => {
  chatEpoch++;
  convertConfirmOpen.value = false;
  conversionChat = null;
  conversionError.value = '';
  closeMemoryEditors();
  resummaryHint.value = '';
  if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
  expanded.value = new Set();
  searchQuery.value = '';
  searchOpen.value = false;
  summaryPage.value = 1;
  pendingPage.value = 1;
  showInjectionEstimate.value = false;
  planPages.value = { plan: 1, suspense: 1 };
  closeImportHistory();
  exitSelectMode();
};
let offChatChanged: (() => void) | null = null;
onMounted(() => {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (es && et?.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, resetViewStates);
    offChatChanged = () => es.off?.(et.CHAT_CHANGED, resetViewStates);
  }
});
onUnmounted(() => {
  pageActive = false;
  chatEpoch++;
  offChatChanged?.();
  if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
});

// 触屏判定:用于跳过弹窗自动聚焦(移动端自动聚焦会弹出输入法挡住界面)。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* ============ 计划 / 悬念(顶部两区)============
 * 原先「悬念簿」把计划和悬念混在一栏;现拆成两个平级区,各自折叠、各自计数,
 * 语义更清晰(计划=角色的打算,悬念=未解的谜团),也和下方「摘要」并列成三区。 */
const newKind = ref<'plan' | 'suspense'>('plan');
const newContent = ref('');
const newTargetTime = ref(''); // 手动添加计划时的可选目标时间(故事内时间)
// 手动添加是低频操作:用弹窗承载,平时只露一个小「+」按钮,不占版面。
const composerOpen = ref(false);
const contentInput = ref<HTMLTextAreaElement | null>(null);
// 从对应区的「+」进入:预选好类型省一步(弹窗内仍可切换)。
function openComposer(kind: 'plan' | 'suspense') {
  if (!allowMemoryEdit()) return;
  if (!hasLeaf.value) return;
  newKind.value = kind;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = true;
  // 仅在非触屏自动聚焦:移动端自动聚焦会立刻弹出输入法,挡住弹窗、体验差。
  if (!isTouch) void nextTick(() => contentInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
// 计划/悬念只展示「进行中」。点删除即移除——不再有「了结/已了结」概念。
const openPlans = computed(() => memory.plans.filter(p => p.status === 'open'));
// 按类型拆两栏:非 suspense 归计划(含旧数据 kind 缺省的情况),suspense 归悬念。
const plansOnly = computed(() => openPlans.value.filter(p => p.kind !== 'suspense'));
const suspenses = computed(() => openPlans.value.filter(p => p.kind === 'suspense'));
const hasLeaf = computed(() => derivedMeta.hasLeaf);

/* —— 折叠 ——
 * 两区各自攒多了都会把下方摘要顶远,故各自可折叠。标题行兼作折叠开关。
 * 折叠态是本机视图偏好(同 activePage 那类临时导航态),走 localStorage、不进 apiSettings——
 * 跨设备同步它没意义,且不该污染真·设置。 */
const PLAN_COLLAPSE_KEY = 'bbs.ui.planCollapsed.v1';
const SUSPENSE_COLLAPSE_KEY = 'bbs.ui.suspenseCollapsed.v1';
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const plansCollapsed = ref(loadCollapsed(PLAN_COLLAPSE_KEY));
const suspenseCollapsed = ref(loadCollapsed(SUSPENSE_COLLAPSE_KEY));
function toggleFold(kind: 'plan' | 'suspense') {
  if (kind === 'plan') {
    plansCollapsed.value = !plansCollapsed.value;
    persistCollapsed(PLAN_COLLAPSE_KEY, plansCollapsed.value);
  } else {
    suspenseCollapsed.value = !suspenseCollapsed.value;
    persistCollapsed(SUSPENSE_COLLAPSE_KEY, suspenseCollapsed.value);
  }
}
// 计划区始终含创作规划入口，可以独立折叠；悬念无条目时仍强制展开。
const plansShown = computed(() => !plansCollapsed.value);
const suspenseFoldable = computed(() => suspenses.value.length > 0);
const suspenseShown = computed(() => !suspenseCollapsed.value || !suspenseFoldable.value);

// 两区渲染配置:结构同构、仅类型/文案/计数色不同,用配置驱动一套模板避免两处漂移。
const planPages = ref({ plan: 1, suspense: 1 });
const foldGroups = computed(() => [
  {
    kind: 'plan' as const, title: '计划', items: plansOnly.value,
    foldable: true, shown: plansShown.value,
    empty: '还没有普通剧情计划。摘要时会自动记下角色的打算,也可在此手动添加；创作规划在上方独立管理。',
  },
  {
    kind: 'suspense' as const, title: '悬念', items: suspenses.value,
    foldable: suspenseFoldable.value, shown: suspenseShown.value,
    empty: '还没有悬念。故事里埋下的谜团、未解之事会记在这里。',
  },
]);

// 叶子 id → 创建楼层。计划 id 形如 `plan:${叶子id}#${序号}`,由此反查创建该计划/悬念
// 时所在楼层(与摘要列表的 #楼层 同源)。手动添加的计划挂在最新叶子上,显示其楼层。
const leafFloor = computed(() => {
  const m = new Map<string, number>();
  for (const l of derivedMeta.leaves) m.set(l.id, l.msgIndex);
  return m;
});
function planFloor(planId: string): number | undefined {
  const leafId = planId.replace(/^plan:/, '').replace(/#\d+$/, '');
  return leafFloor.value.get(leafId);
}

function addPlan() {
  if (!allowMemoryEdit()) return;
  const content = newContent.value.trim();
  if (!content) return;
  // 创建时间用当前已知故事时间(没有就留空);目标时间仅计划可填,用户填了才带上
  const createdTime = memory.state.time?.trim() || undefined;
  const targetTime = newKind.value === 'plan' ? newTargetTime.value.trim() || undefined : undefined;
  if (!appendOpToLatestLeaf({ plans: { add: [{ kind: newKind.value, content, createdTime, targetTime }] } })) return;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = false;
}
function removePlan(id: string) {
  if (!allowMemoryEdit()) return;
  appendOpToLatestLeaf({ plans: { remove: [id] } });
}

/* —— 编辑计划/悬念(弹窗)—— */
const editingPlan = ref<{ id: string; kind: 'plan' | 'suspense'; content: string; createdTime: string; targetTime: string } | null>(null);
function openPlanEdit(p: { id: string; kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }) {
  if (!allowMemoryEdit()) return;
  editingPlan.value = {
    id: p.id,
    kind: p.kind,
    content: p.content,
    createdTime: p.createdTime ?? '',
    targetTime: p.targetTime ?? '',
  };
}
function cancelPlanEdit() {
  editingPlan.value = null;
}
function savePlanEdit() {
  if (!allowMemoryEdit()) return;
  const e = editingPlan.value;
  if (!e || !e.content.trim()) return;
  editPlan(e.id, {
    content: e.content,
    createdTime: e.createdTime,
    // 目标时间仅计划有意义;悬念保持空
    targetTime: e.kind === 'plan' ? e.targetTime : '',
  });
  refreshInjection();
  editingPlan.value = null;
}

/* —— 眼下局势卡(编辑弹窗)——
 * 覆盖型单对象:手动编辑=整卡替换;清空=写 null(场面落幕)。
 * 与手动计划同机制:追加到最新叶子的 delta,重放后生效。 */
const focus = computed(() => memory.state.sceneFocus);
const editingFocus = ref<{ situation: string; participants: string; tension: string; pendingBeat: string } | null>(null);
function openFocusEdit() {
  if (!allowMemoryEdit()) return;
  const f = focus.value;
  editingFocus.value = {
    situation: f?.situation ?? '',
    participants: (f?.participants ?? []).join('、'),
    tension: f?.tension ?? '',
    pendingBeat: f?.pendingBeat ?? '',
  };
}
function cancelFocusEdit() {
  editingFocus.value = null;
}
function saveFocusEdit() {
  if (!allowMemoryEdit()) return;
  const e = editingFocus.value;
  if (!e || !e.situation.trim()) return;
  const participants = e.participants.split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
  const card: SceneFocus = { situation: e.situation.trim(), participants };
  if (e.tension.trim()) card.tension = e.tension.trim();
  if (e.pendingBeat.trim()) card.pendingBeat = e.pendingBeat.trim();
  if (!appendOpToLatestLeaf({ sceneFocus: card })) return;
  refreshInjection();
  editingFocus.value = null;
}
function clearFocus() {
  if (!allowMemoryEdit()) return;
  if (!appendOpToLatestLeaf({ sceneFocus: null })) return;
  refreshInjection();
}

/* ============ 未摘要楼层 ============
 * derivedMeta.pendingFloors = AI 楼且无有效叶子,由旧到新;此处倒序展示(新楼在前)。 */
const pendingFloors = computed(() => [...derivedMeta.pendingFloors].sort((a, b) => b - a));
const pendingPage = ref(1);
const pendingWindow = computed(() => arrayPage(pendingFloors.value, pendingPage.value, PENDING_PAGE_SIZE));
watch(() => pendingWindow.value.page, page => { pendingPage.value = page; });
const summarizingFloor = computed<number | null>(() => {
  // derivedMeta.rev 让切聊天后的 computed 重新核对当前 chatId。
  void derivedMeta.rev;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  return floorBackfillState.running && floorBackfillState.chatId === chatId
    ? floorBackfillState.floor
    : null;
});
function summarizeOne(floor: number) {
  if (!allowMemoryEdit()) return;
  if (engineState.running || summarizingFloor.value !== null) return;
  // 任务状态由 engine 的 floorBackfillState 维护;页面卸载/重开不会丢失。
  void summarizeFloor(floor);
}

/* ============ 批量补摘 ============
 * 把所有未摘楼层按先后顺序执行完整单楼摘要；前楼提交后再读取下一楼的状态。
 * 先弹确认(显示待摘楼数),执行中显示进度 + 可取消(楼层边界生效)。
 * 运行状态读 engine 的 batchState 单例(非组件本地 ref):关掉棱镜宝书窗口再重开,
 * 进度条与取消按钮能恢复——因为任务在 engine 里继续跑,关窗不取消。 */
const batchConfirmOpen = ref(false);
const rebuildConfirmOpen = ref(false);
function openRebuildConfirm() {
  if (!allowMemoryEdit() || engineState.running) return;
  rebuildConfirmOpen.value = true;
}
function rebuildChatMemory() {
  if (!allowMemoryEdit()) return;
  rebuildConfirmOpen.value = false;
  if (!engineState.running) void batchBackfill({ regenerate: true });
}

function openBatchConfirm() {
  if (!allowMemoryEdit()) return;
  if (engineState.running || !pendingFloors.value.length) return;
  batchConfirmOpen.value = true;
}
function runBatchBackfill() {
  if (!allowMemoryEdit()) return;
  batchConfirmOpen.value = false;
  if (engineState.running) return;
  // 不 await:任务在 engine 里跑,状态走 batchState 单例;UI 只读它,不依赖本函数停留
  void batchBackfill({
    // 由旧到新补;pendingFloors 是倒序展示用,这里传升序更稳(引擎内部也会再过滤排序)
    floors: [...derivedMeta.pendingFloors].sort((a, b) => a - b),
  });
}

/* ============ 立即总结 ============
 * 手动触发一次「检测是否达阈值 → 达到就总结(可连锁多层)」。结果用一句临时提示反馈。 */
const resummaryRunning = ref(false);
const resummaryHint = ref('');
let resummaryHintTimer: ReturnType<typeof setTimeout> | null = null;

// 总结节奏:实际约每「保留最近 AI 消息数 + 每次总结 AI 消息数」楼总结一次——
// 最近 keepRecent 条发全文不摘,更早的摘成叶子,叶子攒够 leafBatchThreshold 条压一次总结。
// 阈值关闭(<2)时不显示节奏句。
const resummaryEvery = computed(() => (Math.max(0, apiSettings.keepRecent) + apiSettings.leafBatchThreshold + apiSettings.leafKeepRecent) * 2);
const showCadence = computed(() => apiSettings.leafBatchThreshold >= 2);

// 估算涉及引擎的全量注入选择，仅在用户需要时计算，避免进入/滑动阅读页额外构造全树。
const showInjectionEstimate = ref(false);
// 纯前端估算当前实际注入量。derivedMeta.rev 补上 chat/is_system 这类非 Vue 响应式数据的刷新信号。
const injectionTokenEstimate = computed(() => {
  void derivedMeta.rev;
  const estimate = estimateInjectionTokenBreakdown();
  return {
    summary: estimate.summary.toLocaleString(),
    other: estimate.other.toLocaleString(),
  };
});

async function doResummarize() {
  if (!allowMemoryEdit()) return;
  if (resummaryRunning.value || engineState.running) return;
  resummaryRunning.value = true;
  resummaryHint.value = '';
  try {
    const made = await resummarizeNow();
    // 有报错优先显示错误(如未指派总结渠道);否则按生成条数给反馈
    if (engineState.lastError) {
      resummaryHint.value = '';
    } else if (made > 0) {
      resummaryHint.value = `已生成 ${made} 条总结`;
    } else {
      // 未达阈值:补一句动态节奏,告诉用户大概每多少楼总结一次
      const cadence = showCadence.value ? `,约每 ${resummaryEvery.value} 楼总结一次` : '';
      resummaryHint.value = `当前没有达到总结阈值的摘要${cadence}`;
    }
  } finally {
    resummaryRunning.value = false;
    if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
    if (resummaryHint.value) resummaryHintTimer = setTimeout(() => (resummaryHint.value = ''), 4000);
  }
}

/* ============ 摘要列表(下方)============ */
/**
 * 平铺展示行:搜索(全森林命中平铺)与选择(根 + 复选框)两视图用。
 * 默认视图按展开结果平铺分页，由 SummaryNode 渲染单张卡片。
 */
interface DisplayRow extends SummaryRow {
  isChild: boolean; // 搜索命中的深层(已压缩)节点:只读,不给编辑/删除键
}

/**
 * 完整森林视图(byId):所有**有效**叶子(stale=false)+ 全部压缩节点。
 * ⚠️ 必须走 derivedMeta 而非直接扫 chat:chat 非 reactive,UI 要变更须经 derivedMeta。
 * 展开(取 comp 的 childIds)与搜索(遍历全部节点,含已压缩的深层)都从这里取。
 */
const byId = computed<Map<string, ViewNode>>(() => {
  const m = new Map<string, ViewNode>();
  for (const l of derivedMeta.leaves) {
    if (l.stale) continue;
    m.set(l.id, {
      id: l.id, kind: 'leaf', level: 0, text: l.text,
      timeStart: l.timeStart, timeEnd: l.timeEnd, timeLabel: l.timeLabel,
      createdAt: l.createdAt, childIds: [], msgIndex: l.msgIndex, active: l.active,
    });
  }
  for (const s of memory.summaries) {
    m.set(s.id, {
      id: s.id, kind: 'comp', level: s.level, text: s.text,
      timeStart: s.timeStart, timeEnd: s.timeEnd, timeLabel: s.timeLabel,
      createdAt: s.createdAt, childIds: s.childIds ?? [],
      msgIndex: s.imported ? (s.importedFloorEnd ?? -1) : -1,
      active: s.imported === true,
      atomic: s.imported === true,
      floorStart: s.importedFloorStart,
      floorEnd: s.importedFloorEnd,
    });
  }
  return m;
});

// 楼层范围在数据变化时计算一次；搜索、排序、选择复用同一索引。
const summaryIndex = computed(() => createSummaryIndex(byId.value));
function nodeFloors(n: ViewNode, _map: Map<string, ViewNode>): [number, number] {
  return summaryIndex.value.floors(n);
}

/** ViewNode → 展示行核心字段(供卡片渲染) */
function toRow(n: ViewNode, map: Map<string, ViewNode>): SummaryRow {
  const [lo, hi] = nodeFloors(n, map);
  return {
    key: `${n.kind}:${n.id}`,
    id: n.id,
    kind: n.kind,
    level: n.level,
    text: n.text,
    timeStart: n.timeStart,
    timeEnd: n.timeEnd,
    timeLabel: n.timeLabel,
    floorLo: lo,
    floorHi: hi,
    msgIndex: n.kind === 'leaf' ? n.msgIndex : undefined,
    stale: false,
    imported: n.atomic === true,
  };
}

/** 根节点(倒序:楼层越靠后越在上面),供默认视图与选择视图。 */
const rootNodes = computed(() => summaryIndex.value.roots);

/* ---- 视图态:展开 / 搜索 / 选择(三者互斥,均为临时 UI 态,不持久化) ---- */
const expanded = ref<Set<string>>(new Set()); // 已展开的 comp id
const searchQuery = ref('');
// 搜索框默认收起,点工具行放大镜才展开——平时不占版面。收起即清空搜索词。
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
const summaryPage = ref(1);
const summaryList = ref<HTMLElement | null>(null);
const treeWindow = computed(() => treePage(summaryIndex.value, expanded.value, summaryPage.value));
watch([searchQuery, selectMode], () => { summaryPage.value = 1; });
function changeSummaryPage(page: number) {
  summaryPage.value = page;
  void nextTick(() => summaryList.value?.scrollIntoView?.({ block: 'start' }));
}
function revealNode(id: string) {
  let position = 0;
  for (const row of walkExpanded(rootNodes.value, summaryIndex.value.children, expanded.value)) {
    if (row.node.id === id) { changeSummaryPage(Math.floor(position / SUMMARY_PAGE_SIZE) + 1); return; }
    position++;
  }
}

/* ---- 导入旧总结:第一版只接收粘贴文本 + 从 #0 起的覆盖截止楼层。 ---- */
const importHistoryOpen = ref(false);
const importHistoryText = ref('');
const importHistoryFloor = ref(0);
const importHistoryMaxFloor = ref(0);

function closeImportHistory() {
  importHistoryOpen.value = false;
}

function openImportHistory() {
  if (!allowMemoryEdit()) return;
  if (memory.summaries.some(s => s.imported)) {
    toast('当前聊天已有一条导入历史;请直接编辑或删除后重导', 'warning');
    return;
  }
  const chat = getContext()?.chat ?? [];
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) {
    toast('当前聊天没有可接管的 AI 剧情楼层', 'warning');
    return;
  }
  importHistoryText.value = '';
  importHistoryMaxFloor.value = lastAi;
  importHistoryFloor.value = lastAi;
  importHistoryOpen.value = true;
}

async function saveImportedHistory() {
  if (!allowMemoryEdit()) return;
  const text = importHistoryText.value.trim();
  const floor = Number(importHistoryFloor.value);
  if (!text) {
    toast('请先粘贴旧总结正文', 'warning');
    return;
  }
  if (!Number.isInteger(floor) || floor < 0 || floor > importHistoryMaxFloor.value) {
    toast(`覆盖截止楼层应在 #0 - #${importHistoryMaxFloor.value} 之间`, 'warning');
    return;
  }
  const chat = getContext()?.chat ?? [];
  if (!isAiFloor(chat[floor])) {
    toast('覆盖截止楼层必须是一条 AI 剧情楼层,避免把尚未回应的用户消息一起隐藏', 'warning');
    return;
  }
  if (memory.summaries.some(s => s.imported)) {
    toast('当前聊天已有导入历史,没有重复导入', 'warning');
    return;
  }
  // 不静默覆盖棱镜宝书已经做过的逐楼摘要:重叠时两套叙事会同时进入上下文,应由用户先处理边界。
  const overlap = derivedMeta.leaves.some(l => !l.stale && l.msgIndex <= floor);
  if (overlap) {
    toast('所选范围内已有棱镜宝书摘要;请缩小截止楼层,或先删除重叠摘要', 'warning');
    return;
  }

  const existingTimes = [
    ...memory.summaries.map(s => s.createdAt),
    ...derivedMeta.leaves.filter(l => !l.stale).map(l => l.createdAt),
  ].filter(Number.isFinite);
  const createdAt = (existingTimes.length ? Math.min(...existingTimes) : Date.now()) - 1;
  addSummary({
    text,
    level: 2,
    auto: false,
    childIds: [],
    imported: true,
    importedFloorStart: 0,
    importedFloorEnd: floor,
    createdAt,
  });
  closeImportHistory();
  recomputeDerived();
  await syncHiddenNow(true);
  toast(`已导入旧总结,接管 #0 - #${floor}`, 'success');
}

const searching = computed(() => searchQuery.value.trim().length > 0);

function openSearch() {
  searchOpen.value = true;
  // 非触屏自动聚焦;触屏不聚焦避免立刻弹输入法(与添加计划弹窗同款取舍)
  if (!isTouch) void nextTick(() => searchInput.value?.focus());
}
function closeSearch() {
  searchOpen.value = false;
  searchQuery.value = '';
}
function toggleSearch() {
  if (searchOpen.value) closeSearch();
  else openSearch();
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

/** 搜索索引只随内容重建；关键词变更不再逐行转换时间/递归求范围。 */
const searchIndex = computed(() => [...byId.value.values()].map(node => ({
  node,
  text: (node.text + '\n' + rowTime(toRow(node, byId.value))).toLowerCase(),
})));
const searchNodes = computed(() => {
  if (!searching.value) return [];
  const query = searchQuery.value.trim().toLowerCase();
  const floor = /^#?\d+$/.test(query) ? Number(query.replace(/^#/, '')) : null;
  return searchIndex.value.filter(({ node, text }) => {
    if (text.includes(query)) return true;
    const [lo, hi] = summaryIndex.value.floors(node);
    return floor !== null && lo >= 0 && floor >= lo && floor <= hi;
  }).map(hit => hit.node).sort((a, b) => nodeFloors(b, byId.value)[1] - nodeFloors(a, byId.value)[1]);
});
const rootIds = computed(() => new Set(rootNodes.value.map(n => n.id)));
const flatWindow = computed(() => arrayPage(searching.value ? searchNodes.value : rootNodes.value, summaryPage.value));
const activeWindow = computed(() => searching.value || selectMode.value ? flatWindow.value : treeWindow.value);
watch(() => activeWindow.value.page, page => { summaryPage.value = page; });
/** 仅转换当前页；默认树视图不额外转换全量根列表。 */
const visibleRows = computed<DisplayRow[]>(() => {
  if (!searching.value && !selectMode.value) return [];
  return flatWindow.value.items.map(n => ({ ...toRow(n, byId.value), isChild: !rootIds.value.has(n.id) }));
});

/** 搜索命中文本切片:把 text 按命中词切成 [{t, hit}] 片段,模板用 span 渲染(不走 v-html,防 XSS)。 */
function highlightParts(text: string): Array<{ t: string; hit: boolean }> {
  const q = searchQuery.value.trim();
  if (!q || !searching.value) return [{ t: text, hit: false }];
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const parts: Array<{ t: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx < 0) { parts.push({ t: text.slice(i), hit: false }); break; }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return parts.length ? parts : [{ t: text, hit: false }];
}

/* ---- 选择模式:进出、勾选、连续性约束、合并 ---- */
function enterSelectMode() {
  if (!allowMemoryEdit()) return;
  selectMode.value = true;
  selectedIds.value = new Set();
  expanded.value = new Set(); // 折叠所有展开,只操作根
}
function exitSelectMode() {
  selectMode.value = false;
  selectedIds.value = new Set();
}
function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

/** 根是否已全部勾选(驱动「全选 / 取消全选」文案) */
const allSelected = computed(() => {
  const roots = rootNodes.value;
  return roots.length > 0 && roots.every(n => selectedIds.value.has(n.id));
});
/** 全选 / 取消全选切换:全选时写入全部根 id;已全选则清空。 */
function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(rootNodes.value.map(n => n.id));
  }
}

/** 选中项在根序列(倒序)里的位置索引,升序排列 */
const selectedRootIndexes = computed<number[]>(() => {
  const roots = rootNodes.value;
  const idxs: number[] = [];
  roots.forEach((n, i) => { if (selectedIds.value.has(n.id)) idxs.push(i); });
  return idxs;
});
/** 是否可合并:选中 ≥2 且在根序列里连续(无跳选) */
const canMerge = computed(() => {
  const idxs = selectedRootIndexes.value;
  if (idxs.length < 2) return false;
  for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) return false;
  return true;
});
/** 选中项覆盖的楼层范围与将生成的层级(供操作条展示) */
const selectionSummary = computed(() => {
  const map = byId.value;
  const picked = rootNodes.value.filter(n => selectedIds.value.has(n.id));
  if (!picked.length) return { count: 0, floorLo: -1, floorHi: -1, level: 1 };
  let lo = Infinity, hi = -Infinity, maxLevel = 0;
  for (const n of picked) {
    const [a, b] = nodeFloors(n, map);
    if (a >= 0) lo = Math.min(lo, a);
    if (b >= 0) hi = Math.max(hi, b);
    maxLevel = Math.max(maxLevel, n.level);
  }
  return {
    count: picked.length,
    floorLo: lo === Infinity ? -1 : lo,
    floorHi: hi === -Infinity ? -1 : hi,
    level: maxLevel + 1,
  };
});

const mergeConfirmOpen = ref(false);
const merging = ref(false);
function openMergeConfirm() {
  if (!allowMemoryEdit()) return;
  if (!canMerge.value || merging.value || engineState.running) return;
  mergeConfirmOpen.value = true;
}
async function runMerge() {
  if (!allowMemoryEdit()) return;
  mergeConfirmOpen.value = false;
  if (!canMerge.value || merging.value) return;
  // 按根序列升序(即楼层旧→新)传给引擎;引擎内部还会再排一次
  const idxs = [...selectedRootIndexes.value].sort((a, b) => a - b);
  const ids = idxs.map(i => rootNodes.value[i].id);
  merging.value = true;
  try {
    const res = await summarizeSelected(ids);
    if (res.made > 0) {
      exitSelectMode();
    } else if (res.error) {
      // 失败时保留选择。早退分支(未生效/正忙/不连续等)不走引擎的 try/catch,
      // 不会写 engineState.lastError,故这里主动弹 toast,避免「无事发生、无报错」。
      toast(res.error, 'warning');
    }
  } finally {
    merging.value = false;
  }
}

/** 删除统计按整棵选中子树计算:选中总结时,其收纳的下层摘要也属于删除范围。 */
const selectionDeleteSummary = computed(() => {
  const map = byId.value;
  const visited = new Set<string>();
  let leaves = 0, summaries = 0, imported = 0;
  const stack = [...selectedIds.value];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = map.get(id);
    if (!node) continue;
    if (node.kind === 'leaf') { leaves++; continue; }
    summaries++;
    if (node.atomic) { imported++; continue; }
    for (const childId of node.childIds) stack.push(childId);
  }
  return { leaves, summaries, imported };
});

const deleteConfirmOpen = ref(false);
const deleting = ref(false);
function openDeleteConfirm() {
  if (!allowMemoryEdit()) return;
  if (!selectionSummary.value.count || deleting.value || merging.value || engineState.running) return;
  deleteConfirmOpen.value = true;
}
async function runDeleteSelected() {
  if (!allowMemoryEdit()) return;
  deleteConfirmOpen.value = false;
  if (!selectionSummary.value.count || deleting.value) return;
  // 先快照 id：删除第一棵子树后根序列会立即变化，不能再从响应式列表逐项读取。
  const ids = [...selectedIds.value];
  deleting.value = true;
  try {
    const result = deleteSummarySubtrees(ids);
    refreshInjection();
    if (result.imported > 0) await syncHiddenNow(true);
    exitSelectMode();
    const parts = [
      result.leaves ? `${result.leaves} 条摘要` : '',
      result.summaries ? `${result.summaries} 条总结` : '',
    ].filter(Boolean);
    toast(parts.length ? `已删除${parts.join('、')}` : '所选内容已不存在', parts.length ? 'success' : 'warning');
  } finally {
    deleting.value = false;
  }
}

/** 行的展示时间:新数据用 timeStart/timeEnd 合成并压缩;旧数据回退到已固化的 timeLabel(也压缩一次) */
function rowTime(r: SummaryRow): string {
  if (r.timeStart || r.timeEnd) return formatRange(r.timeStart, r.timeEnd);
  return r.timeLabel ? compactTimeLabel(r.timeLabel) : '';
}
/** 行的相对时间前缀(如「昨天·周三」):仅叶子(单楼摘要)显示;总结跨多楼、相对时间无意义,返回空串 */
function rowRelative(r: SummaryRow): string {
  if (r.kind !== 'leaf') return '';
  const event = r.timeEnd || r.timeStart || (r.timeLabel ? splitTimeLabel(r.timeLabel).end : '') || '';
  // 周几并入相对前缀(标准公历带年份才有);与注入端口径一致
  return [relativeTimeLabel(event, derivedMeta.latestStoryTime), weekdayLabel(event)].filter(Boolean).join('·');
}

// 当前时间:优先读正文标签实时算出的「故事内最新时间」(不受最新楼是否已摘影响);
// 取不到再回退派生的 state.time(老数据/无标签场景)。修掉「最新楼未摘时显示旧时间」的问题。
const currentTime = computed(() => derivedMeta.latestStoryTime || memory.state.time);
/** 当前时间的周几(仅标准公历带年份才有);展示用 */
const currentWeekday = computed(() => weekdayLabel(currentTime.value));

function levelLabel(level: number, imported = false): string {
  if (imported) return '导入历史';
  if (level === 0) return '摘要';
  return `总结L${level}`;
}
/** 楼层范围标签:单楼 #5,跨楼 #0 - #10 */
function floorLabel(r: SummaryRow): string {
  if (r.floorLo < 0) return '—';
  return r.floorLo === r.floorHi ? `#${r.floorLo}` : `#${r.floorLo} - #${r.floorHi}`;
}

async function onDelete(r: SummaryRow) {
  if (!allowMemoryEdit()) return;
  if (r.kind === 'leaf') {
    if (!confirm('删除这条摘要?它带来的物品、计划、时间地点变化会按剩余摘要重新计算(可能回退);包含它的总结也会一并删除。原文楼层仍保持隐藏。')) return;
    if (typeof r.msgIndex === 'number') deleteLeafAt(r.msgIndex);
  } else {
    if (r.imported) {
      if (!confirm('删除这条导入历史?它接管的旧楼层会重新显示并回到待摘要状态;原世界书内容不受影响。')) return;
      invalidateSummaryAncestors(r.id);
      recomputeDerived();
      await syncHiddenNow(true);
      return;
    }
    if (!confirm('删除这条总结?被它收纳的下层摘要会重新展开,物品/计划等不受影响。')) return;
    deleteSummary(r.id);
  }
  refreshInjection();
}

/* ============ 编辑弹窗 ============
 * 叶子:可改「故事内时间」+ 正文;总结:只压文本,故只改正文。
 * nested = 该节点已被某条总结收纳:编辑它不影响上层总结文本(总结只压快照),
 * 弹窗里提示用户「上层总结不会跟着变」,免得改完发现总结里旧信息还在、以为没保存上。 */
type Editing =
  | { kind: 'leaf'; msgIndex: number; text: string; timeStart: string; timeEnd: string; nested: boolean }
  | { kind: 'comp'; compId: string; level: number; text: string; imported: boolean; nested: boolean };
const editing = ref<Editing | null>(null);

/** 该 id 是否已被任何总结的 childIds 收纳(= 展开视图里的深层行) */
function isNested(id: string): boolean {
  return memory.summaries.some(s => (s.childIds ?? []).includes(id));
}

function openEdit(r: SummaryRow) {
  if (!allowMemoryEdit()) return;
  if (r.kind === 'leaf' && typeof r.msgIndex === 'number') {
    // 旧数据无 timeStart/timeEnd 时,从已固化的 timeLabel 拆出起止填入
    const fb = !r.timeStart && !r.timeEnd ? splitTimeLabel(r.timeLabel) : {};
    editing.value = {
      kind: 'leaf',
      msgIndex: r.msgIndex,
      text: r.text,
      timeStart: r.timeStart ?? fb.start ?? '',
      timeEnd: r.timeEnd ?? fb.end ?? '',
      nested: isNested(r.id),
    };
  } else if (r.kind === 'comp') {
    editing.value = { kind: 'comp', compId: r.id, level: r.level, text: r.text, imported: r.imported === true, nested: isNested(r.id) };
  }
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  if (!allowMemoryEdit()) return;
  const e = editing.value;
  if (!e) return;
  if (e.kind === 'leaf') editLeafAt(e.msgIndex, e.text, e.timeStart, e.timeEnd);
  else editSummary(e.compId, e.text);
  refreshInjection();
  editing.value = null;
}

// 注入单张卡片所需的状态、helper 与动作；SummaryNode 不再递归。
provide(SUMMARY_CTX, {
  byId, expanded, selectMode, searching, selectedIds,
  toggleExpand, toggleSelect, openEdit, onDelete, revealNode,
  childCount: n => summaryIndex.value.childCount(n),
  nodeFloors, toRow, levelLabel, floorLabel, rowTime, rowRelative, highlightParts,
});
// 概览仅取当前响应式记忆；兼容报告是历史快照，不参与实时计数。
const liveLeafCount = computed(() => derivedMeta.leaves.filter(leaf => !leaf.stale).length);
</script>

<template>
  <section class="bbs-page bbs-summary-page">
    <PageHeader title="故事记忆" eyebrow="STORY ARCHIVE / 摘要" description="故事向前，来路留在这里。" />
    <section class="bbs-overview" aria-label="当前聊天实时概览">
      <div class="bbs-overview-head">
        <span class="bbs-overview-caption">本篇记录</span>
        <span class="bbs-overview-status" :class="{ 'is-protected': editingBlocked }">{{ conversionBusy ? '转换保存中' : compatibilityState.mode === 'ready' ? '记忆可用' : compatibilityState.mode === 'convert' ? '待本地转换' : '写入保护中' }}</span>
      </div>
      <dl class="bbs-overview-stats">
        <div><dt>逐楼摘要</dt><dd>{{ editingBlocked ? '—' : liveLeafCount }}</dd></div>
        <div><dt>上层总结</dt><dd>{{ editingBlocked ? '—' : memory.summaries.length }}</dd></div>
        <div><dt>阅读入口</dt><dd>{{ editingBlocked ? '—' : rootNodes.length }}</dd></div>
        <div class="bbs-overview-pending"><dt>待补录</dt><dd>{{ editingBlocked ? '—' : pendingFloors.length }}</dd></div>
      </dl>
      <div class="bbs-backfill-entry">
        <p>{{ editingBlocked ? '先核对下方兼容说明，再继续编辑。' : pendingFloors.length ? '有缺失楼层，只补录，不重建。' : '已记录的故事，无需重新摘要。' }}</p>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="editingBlocked || engineState.running || batchState.running || !pendingFloors.length" title="调用 AI 补齐缺失摘要及状态；不覆盖已有摘要，不是手动补写" @click="openBatchConfirm"><Icon name="plus" />补录摘要（AI）</button>
      </div>
    </section>
    <aside class="bbs-compatibility" :class="{ 'bbs-compatibility-warning': compatibilityState.mode !== 'ready' }" aria-label="旧记忆兼容状态" aria-live="polite">
      <h2 v-if="compatibilityState.mode !== 'ready'" class="bbs-title bbs-title-sub">{{ compatibilityState.mode === 'convert' ? '旧记忆兼容 · 待本地转换' : '旧记忆兼容 · 保护中' }}</h2>
      <details v-if="compatibilityState.mode === 'ready'" class="bbs-compatibility-ready">
        <summary>旧版记忆已兼容<span>无需重建</span></summary>
        <p>已按兼容格式读取本聊天已有摘要及 L1 / L2 等上层总结（如有），不需要因升级重新摘要或重建。</p>
        <p class="bbs-field-hint">最近一次加载／兼容检查报告：{{ compatibilityState.leaves }} 条逐楼摘要、{{ compatibilityState.summaries }} 条上层总结。这是检查时快照，不是实时数量；当前内容以下方列表为准。</p>
      </details>
      <template v-else-if="compatibilityState.mode === 'convert'">
        <p>检测到可本地转换的旧格式；转换不调用 AI，也不是重新摘要。确认后会备份旧记忆元数据，保留原摘要与上层总结，再尝试保存聊天。</p>
        <p class="bbs-field-hint">最近一次检查：待转换旧摘要 {{ compatibilityState.conversion.length }} 条、已识别逐楼摘要 {{ compatibilityState.leaves }} 条、上层总结 {{ compatibilityState.summaries }} 条（非实时数量）。请先导出聊天备份；转换前暂停补摘、重建、总结、导入等编辑。</p>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="conversionBusy || engineState.running" @click="openConversionConfirm">{{ conversionBusy ? '正在本地转换并保存…' : '确认本地转换…' }}</button>
        <p v-if="engineState.running" class="bbs-field-hint">请先等待当前摘要任务结束，再进行转换。</p>
      </template>
      <template v-else>
        <p>无法确认旧记忆可安全写入，已暂停补摘、重建、总结、导入及其他编辑入口。原始数据保留，未按空记忆覆盖。</p>
        <ul v-if="compatibilityState.issues.length">
          <li v-for="(issue, index) in compatibilityState.issues" :key="index">{{ issue }}</li>
        </ul>
        <p v-else>兼容检查尚未给出可安全写入的结论。</p>
        <p>建议先使用酒馆的导出聊天功能备份，再核对以上原因。不要通过重建或导入覆盖来解除保护。</p>
      </template>
      <p v-if="conversionBusy" role="status">转换／保存尚未结束，请勿重复提交或切换聊天；隐藏确认窗口不会取消已经开始的保存。</p>
      <p v-if="conversionError" class="bbs-compatibility-error" role="alert">本地转换未确认成功：{{ conversionError }} 请先导出聊天并核对保存结果，不要重建或反复转换。</p>
    </aside>
    <ConfirmDialog
      v-model:open="convertConfirmOpen"
      title="本地转换旧记忆"
      confirm-text="备份并本地转换"
      :busy="conversionBusy || engineState.running"
      busy-text="请等待当前操作完成…"
      @confirm="confirmConversion"
    >
      此操作仅转换当前聊天的旧存储格式，不调用 AI，不重写摘要正文；保留摘要、L1 / L2 等上层总结，并在聊天元数据中备份旧记录。升级不需要重建。
      请先额外导出聊天备份。转换需要保存聊天和元数据，保存可能失败；若提示失败，请导出并核对磁盘中的实际结果，不要直接重试或重建。保存期间请勿切换聊天。继续？
    </ConfirmDialog>
    <fieldset class="bbs-memory-editors" :disabled="editingBlocked" aria-label="本聊天记忆编辑">

    <details class="bbs-reader-context">
      <summary><span class="bbs-context-icon"><Icon name="plans" /></span><span>当前局势与计划<small>{{ focus?.situation || '查看此刻的场景与未竟之事' }}</small></span><Icon name="chevron" class="bbs-context-chevron" /></summary>
      <div class="bbs-reader-context-body">
    <!-- ===== 眼下局势卡:当前场面快照(覆盖型;省略=不动,清空=落幕) ===== -->
    <div class="bbs-fold-section">
      <div class="bbs-section-head">
        <div><span class="bbs-section-kicker">01 / 此刻</span><h2 class="bbs-title bbs-title-sub">眼下局势</h2><p class="bbs-section-description">当前场面的快照，随故事进展更新。</p></div>
        <!-- 无卡时:铅笔留在区块头;有卡时:编辑/清空收进卡头操作区 -->
        <span v-if="!focus" class="bbs-focus-acts">
          <button
            class="bbs-add-mini"
            type="button"
            :disabled="!hasLeaf"
            :title="hasLeaf ? '手动编写局势卡' : '需先有摘要才能手动编写'" :aria-label="hasLeaf ? '手动编写局势卡' : '需先有摘要才能手动编写'"
            @click="openFocusEdit"
          >
            <Icon name="edit" />
          </button>
        </span>
      </div>
      <!-- 与角色卡同构:左色条 + 头行(在场者 + 记时 + 操作区)+ 主文 + 彩色分类小标签字段表 -->
      <article v-if="focus" class="bbs-focus">
        <div class="bbs-focus-head">
          <span class="bbs-focus-names" :class="{ 'is-empty': !focus.participants.length }">
            {{ focus.participants.length ? focus.participants.join('、') : '眼下局势' }}
          </span>
          <span v-if="focus.updatedTime" class="bbs-focus-time">记于 {{ focus.updatedTime }}</span>
          <span class="bbs-focus-acts">
            <button
              class="bbs-plan-act"
              type="button"
              :disabled="!hasLeaf"
              :title="hasLeaf ? '手动修改局势卡' : '需先有摘要才能手动修改'" :aria-label="hasLeaf ? '手动修改局势卡' : '需先有摘要才能手动修改'"
              @click="openFocusEdit"
            >
              <Icon name="edit" />
            </button>
            <button
              class="bbs-plan-act bbs-plan-del"
              type="button"
              :disabled="!hasLeaf"
              title="清空局势卡(场面落幕)" aria-label="清空局势卡(场面落幕)"
              @click="clearFocus"
            >
              <Icon name="close" />
            </button>
          </span>
        </div>
        <p class="bbs-focus-situation">{{ focus.situation }}</p>
        <dl v-if="focus.currentFocus || focus.tension || focus.pendingBeat" class="bbs-focus-fields">
          <div v-if="focus.currentFocus" class="bbs-focus-field">
            <!-- currentFocus 已废弃:仅旧数据仍带值时才展示,不再提示记录 -->
            <dt>焦点</dt>
            <dd>{{ focus.currentFocus }}</dd>
          </div>
          <div v-if="focus.tension" class="bbs-focus-field f-tension">
            <dt>张力</dt>
            <dd>{{ focus.tension }}</dd>
          </div>
          <div v-if="focus.pendingBeat" class="bbs-focus-field f-next">
            <dt>将至</dt>
            <dd>{{ focus.pendingBeat }}</dd>
          </div>
        </dl>
      </article>
      <p v-else class="bbs-plan-empty">{{ hasLeaf ? '还没有局势卡。场面实质变化时摘要会自动更新，也可用右上角铅笔手动编写。' : '先生成一条摘要，再手动编写局势卡；场面变化也会在摘要时自动记录。' }}</p>
    </div>

    <!-- 当前状态 -->
    <div v-if="currentTime || memory.state.location" class="bbs-state">
      <div v-if="currentTime" class="bbs-state-item">
        <span class="bbs-state-key">时间</span>
        <span class="bbs-state-val">{{ currentTime }}<template v-if="currentWeekday"> ({{ currentWeekday }})</template></span>
      </div>
      <div v-if="memory.state.location" class="bbs-state-item">
        <span class="bbs-state-key">地点</span>
        <span class="bbs-state-val">{{ memory.state.location }}</span>
      </div>
    </div>

    <!-- 局势卡编辑弹窗 -->
    <ModalMask v-if="!editingBlocked" :open="!!editingFocus" @close="cancelFocusEdit">
      <div v-if="editingFocus" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑局势卡">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">眼下局势卡</span>
          <button class="bbs-summary-act" type="button" title="关闭" aria-label="关闭" @click="cancelFocusEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">局面(一句话)</span>
          <textarea v-model="editingFocus.situation" class="bbs-input bbs-modal-textarea" rows="2" placeholder="如「午后同居日常,她情绪有点低落」/「潜行中,刚被巡逻队发现」"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">在场参与者(顿号分隔)</span>
          <input v-model="editingFocus.participants" class="bbs-input" type="text" placeholder="如 主角、阿黛尔" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">互动张力(可选,高门槛)</span>
          <input v-model="editingFocus.tension" class="bbs-input" type="text" placeholder="仅明确且持续的社交张力,如 冷战/尴尬" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">即将发生(可选,禁预测)</span>
          <input v-model="editingFocus.pendingBeat" class="bbs-input" type="text" placeholder="仅正文明确预告/约定的事" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelFocusEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingFocus.situation.trim()" @click="saveFocusEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 计划 / 悬念:顶部两区,各自折叠计数 ===== -->
    <!-- 结构同构、配置驱动(foldGroups):标题行兼折叠开关,右侧「+」独立(disabled 时不响应,不误触折叠) -->
    <section class="bbs-planning" aria-label="进行中的计划与悬念">
      <div class="bbs-planning-intro"><span class="bbs-section-kicker">02 / 未竟之事</span><p class="bbs-section-description">计划中可管理角色的打算，也可根据剧情和你的输入生成创作规划。创作规划是未来方向，不是已发生的事实；悬念保留尚未揭晓的线索。</p></div>
      <div class="bbs-planning-grid">
        <div v-for="g in foldGroups" :key="g.kind" class="bbs-fold-section">
          <div class="bbs-section-head">
            <button
              class="bbs-fold-head"
              type="button"
              :class="{ 'is-static': !g.foldable }"
              :disabled="!g.foldable"
              :aria-expanded="g.shown"
              :title="g.foldable ? (g.shown ? `收起${g.title}` : `展开${g.title}`) : ''" :aria-label="g.foldable ? (g.shown ? `收起${g.title}` : `展开${g.title}`) : ''"
              @click="toggleFold(g.kind)"
            >
              <Icon v-if="g.foldable" name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': !g.shown }" />
              <h2 class="bbs-title bbs-title-sub">{{ g.title }}</h2>
              <span class="bbs-fold-count">{{ g.items.length }}</span>
              <span v-if="g.kind === 'plan' && outlineState.active" class="bbs-outline-count">创作规划 {{ outlineState.active.content.chapters.length }} 阶段</span>
            </button>
            <button
              class="bbs-add-mini"
              type="button"
              :disabled="!hasLeaf"
              :title="hasLeaf ? `手动添加${g.title}` : '需先有摘要才能手动添加'" :aria-label="hasLeaf ? `手动添加${g.title}` : '需先有摘要才能手动添加'"
              @click="openComposer(g.kind)"
            >
              <Icon name="plus" />
            </button>
          </div>

          <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height;reduced-motion 下瞬切(见样式) -->
          <div class="bbs-fold-wrap" :class="{ 'is-collapsed': !g.shown }" :inert="!g.shown" :aria-hidden="!g.shown">
            <div v-if="g.shown" class="bbs-fold-inner">
              <OutlinePlanner v-if="g.kind === 'plan'" :disabled="editingBlocked" />
              <div v-if="g.items.length" class="bbs-plan-group">
                <div v-for="p in arrayPage(g.items, planPages[g.kind]).items" :key="p.id" class="bbs-plan">
                  <div class="bbs-plan-head">
                    <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? '悬念' : '计划' }}</span>
                    <span v-if="planFloor(p.id) !== undefined" class="bbs-plan-floor">#{{ planFloor(p.id) }}</span>
                    <span class="bbs-plan-acts">
                      <button class="bbs-plan-act" type="button" :title="`编辑${g.title}`" :aria-label="`编辑${g.title}`" @click="openPlanEdit(p)"><Icon name="edit" /></button>
                      <button class="bbs-plan-act bbs-plan-del" type="button" :title="`删除${g.title}`" :aria-label="`删除${g.title}`" @click="removePlan(p.id)"><Icon name="close" /></button>
                    </span>
                  </div>
                  <p class="bbs-plan-content">{{ p.content }}</p>
                  <!-- 故事内时间:立于(创建时间)/ 目标(目标时间),任一存在才显示 -->
                  <div v-if="p.createdTime || p.targetTime" class="bbs-plan-times">
                    <span v-if="p.createdTime" class="bbs-plan-time">立于 {{ p.createdTime }}</span>
                    <span v-if="p.targetTime" class="bbs-plan-time bbs-plan-time-target">目标 {{ p.targetTime }}</span>
                  </div>
                </div>
              </div>
              <p v-else class="bbs-plan-empty">{{ g.empty }}<span v-if="!hasLeaf" class="bbs-empty-prerequisite">手动添加需先有一条摘要。</span></p>
              <SummaryPager :page="arrayPage(g.items, planPages[g.kind]).page" :total="g.items.length" :size="SUMMARY_PAGE_SIZE" :label="g.title" @update:page="planPages[g.kind] = $event" />
            </div>
          </div>
        </div>

      </div>
    </section>

      </div>
    </details>

    <!-- 分章分隔:两侧细线 + 居中金色菱形(古籍分章鱼尾标记),比普通 hr 更明确地隔开两区 -->
    <div class="bbs-divider" role="separator" aria-hidden="true">
      <span class="bbs-divider-mark"></span>
    </div>

    <div v-if="batchState.running" class="bbs-pending bbs-job-progress" role="status" aria-live="polite">
        <span class="bbs-batch-progress">
          <span class="bbs-pending-spin"></span>
          记忆处理中 {{ batchState.done }}/{{ batchState.total }}
          <button class="bbs-batch-cancel" type="button" :disabled="batchState.cancelRequested" @click="cancelBatchBackfill">
            {{ batchState.cancelRequested ? '停止中…' : '取消' }}
          </button>
        </span>
    </div>

    <!-- 未摘要楼层:只列楼层号,点一下单独补摘那一楼;楼层多时可「批量补摘」 -->
    <section v-if="pendingFloors.length" class="bbs-pending bbs-backfill" aria-label="普通补摘">
      <div class="bbs-pending-head">
        <span class="bbs-pending-label" :data-count="pendingFloors.length">
          <Icon name="summary" />未摘要楼层
        </span>
        <!-- 批量补摘:把全部未摘楼层逐楼串行补完(完整更新状态);批量进行中显示进度+取消 -->
        <button
          v-if="!batchState.running"
          class="bbs-btn bbs-btn-sm bbs-batch-btn"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null"
          title="按楼序逐一补完摘要和状态（每楼单独请求）" aria-label="按楼序逐一补完摘要和状态（每楼单独请求）"
          @click="openBatchConfirm"
        >
          <Icon name="plans" />批量补摘
        </button>

      </div>
      <p class="bbs-backfill-description">点楼层号补摘该楼，或批量按楼序处理。每楼一次 AI 请求，包含摘要与状态更新。</p>
      <div class="bbs-pending-chips">
        <button
          v-for="f in pendingWindow.items"
          :key="f"
          class="bbs-pending-chip"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null || batchState.running"
          :title="`对楼层 #${f} 生成摘要`" :aria-label="`对楼层 #${f} 生成摘要`"
          @click="summarizeOne(f)"
        >
          <span v-if="summarizingFloor === f" class="bbs-pending-spin"></span>
          <template v-else>#{{ f }}</template>
        </button>
      </div>
    </section>

    <SummaryPager :page="pendingWindow.page" :total="pendingWindow.total" :size="PENDING_PAGE_SIZE" label="待补录楼层" @update:page="pendingPage = $event" />

    <!-- 批量补摘确认弹窗 -->
    <ConfirmDialog
      v-if="!editingBlocked"
      v-model:open="batchConfirmOpen"
      title="补录摘要（AI 批量补摘）"
      confirmText="开始"
      @confirm="runBatchBackfill"
    >
      共 {{ pendingFloors.length }} 个未摘楼层,将按楼序逐楼生成完整摘要和人物、物品、计划等状态（每楼一次请求）。
      过程中可随时取消(会在当前楼完成后停下)。继续?
    </ConfirmDialog>

    <!-- ===== 摘要 ===== -->
    <div class="bbs-section-head bbs-reading-head">
      <div class="bbs-summary-heading">
        <h2 class="bbs-title bbs-title-sub">故事脉络</h2>
        <button class="bbs-btn bbs-btn-sm bbs-estimate-toggle" type="button" :aria-expanded="showInjectionEstimate" @click="showInjectionEstimate = !showInjectionEstimate">{{ showInjectionEstimate ? '收起注入量估算' : '按需估算注入量' }}</button>
        <div v-if="showInjectionEstimate" class="bbs-token-estimate" title="按 UTF-8 字节数估算,不会请求后端">
          <span>摘要注入 ≈ {{ injectionTokenEstimate.summary }} tokens</span>
          <span>其他注入 ≈ {{ injectionTokenEstimate.other }} tokens</span>
        </div>
      </div>
      <div class="bbs-summary-tools" role="group" aria-label="摘要阅读与整理工具">
        <!-- 搜索:点放大镜展开搜索框(平时收起不占版面);已展开则收起并清空 -->
        <button
          v-if="!selectMode"
          class="bbs-add-mini"
          type="button"
          :class="{ 'is-on': searchOpen }"
          :disabled="!rootNodes.length"
          :title="searchOpen ? '收起搜索' : '搜索摘要'" :aria-label="searchOpen ? '收起搜索' : '搜索摘要'"
          @click="toggleSearch"
        >
          <Icon name="search" /><span class="bbs-btn-label">搜索</span>
        </button>
        <!-- 选择模式:进/出。选择态下换成「完成」,并隐藏立即总结(避免与合并撞车) -->
        <!-- 窄屏使用带中文名称的双列工具栏，避免只靠图标辨认操作。 -->
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="!rootNodes.length || searching"
          title="勾选连续的多条摘要,手动合并成一条总结" aria-label="勾选连续的多条摘要,手动合并成一条总结"
          @click="enterSelectMode"
        >
          <Icon name="checklist" /><span class="bbs-btn-label">多选</span>
        </button>
        <button
          v-else
          class="bbs-btn bbs-btn-sm"
          type="button"
          title="退出多选" aria-label="退出多选"
          @click="exitSelectMode"
        >
          <Icon name="close" /><span class="bbs-btn-label">完成</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="engineState.running"
          title="粘贴并导入使用棱镜宝书之前的旧总结" aria-label="粘贴并导入使用棱镜宝书之前的旧总结"
          @click="openImportHistory"
        >
          <Icon name="download" />
          <span class="bbs-btn-label">导入旧总结</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm bbs-btn-primary bbs-resummary-btn"
          type="button"
          :disabled="resummaryRunning || engineState.running"
          title="检测摘要是否达到总结阈值,达到则立即总结一次" aria-label="检测摘要是否达到总结阈值,达到则立即总结一次"
          @click="doResummarize"
        >
          <span v-if="resummaryRunning" class="bbs-pending-spin"></span>
          <Icon v-else name="bolt" />
          <span class="bbs-btn-label">立即总结</span>
        </button>
      </div>
    </div>
    <p v-if="resummaryHint" class="bbs-resummary-hint">{{ resummaryHint }}</p>

    <!-- 搜索框:点工具行放大镜才展开(选择模式下不显示,两态互斥)。搜全森林(含已压缩的深层节点) -->
    <div v-if="!selectMode && searchOpen && rootNodes.length" class="bbs-search">
      <Icon name="search" class="bbs-search-icon" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="bbs-input bbs-search-input"
        type="text"
        aria-label="搜索摘要正文、时间或楼层号"
        placeholder="搜索正文 / 时间 / #楼层号"
        @keydown.esc.stop="closeSearch"
      />
      <button class="bbs-search-clear" type="button" :title="searching ? '清空' : '收起搜索'" :aria-label="searching ? '清空' : '收起搜索'" @click="searching ? (searchQuery = '') : closeSearch()">
        <Icon name="close" />
      </button>
    </div>

    <div v-if="engineState.lastError" class="bbs-summary-failure" role="alert">
      <p class="bbs-error">{{ summaryFailure.title }}</p>
      <p v-if="summaryFailure.help" class="bbs-field-hint">{{ summaryFailure.help }}</p>
      <details v-if="summaryFailure.details">
        <summary>查看校验原因</summary>
        <p class="bbs-field-hint">{{ summaryFailure.details }}</p>
      </details>
    </div>

    <p v-if="searching" class="bbs-result-note" role="status">找到 {{ searchNodes.length }} 条匹配（包含已收纳的下层摘要）</p>
    <p v-else-if="selectMode" class="bbs-result-note">多选整理 · 翻页保留勾选，全选覆盖所有页；合并需连续，删除总结将同时删除其下层内容。</p>
    <p v-else-if="rootNodes.length" class="bbs-result-note">{{ rootNodes.length }} 个阅读入口</p>
    <div ref="summaryList" tabindex="-1"></div>
    <SummaryPager :page="activeWindow.page" :total="activeWindow.total" :size="SUMMARY_PAGE_SIZE" label="摘要" @update:page="changeSummaryPage" />
    <!-- 展开结果平铺后统一分页；整页最多 20 张摘要卡片，无递归组件/折叠 DOM。 -->
    <div v-if="!searching && !selectMode && rootNodes.length" class="bbs-summary-list">
      <SummaryNode v-for="r in treeWindow.items" :key="`${r.node.kind}:${r.node.id}`" :node="r.node" :depth="r.depth" :parent-id="r.parentId" />
    </div>

    <!-- 搜索 / 选择视图:平铺列表(无逐层展开)。搜索命中含已压缩的深层节点 -->
    <div
      v-else-if="visibleRows.length"
      class="bbs-summary-list"
      :class="{ 'is-selecting': selectMode }"
    >
      <article
        v-for="r in visibleRows"
        :key="r.key"
        class="bbs-summary-card"
        :class="{ 'is-deep': r.level > 0, 'is-stale': r.stale, 'is-child': r.isChild, 'is-selected': selectMode && selectedIds.has(r.id) }"
        :role="selectMode ? 'checkbox' : undefined"
        :aria-checked="selectMode ? selectedIds.has(r.id) : undefined"
        :tabindex="selectMode ? 0 : undefined"
        @click="selectMode && toggleSelect(r.id)"
        @keydown.enter.prevent="selectMode && toggleSelect(r.id)"
        @keydown.space.prevent="selectMode && toggleSelect(r.id)"
      >
        <!-- 选择模式:复选框仅作视觉状态,点整卡即可勾选(label 不再包 input,避免双触发) -->
        <span v-if="selectMode" class="bbs-summary-check" aria-hidden="true">
          <input
            class="bbs-checkbox"
            type="checkbox"
            :checked="selectedIds.has(r.id)"
            tabindex="-1"
            @click.stop
          />
        </span>
        <div class="bbs-summary-main">
          <header class="bbs-summary-meta">
            <!-- 总结:层级标签 + 范围药丸 + 相对时间(留题首行)+ 绝对时间(窄屏换行) -->
            <template v-if="r.kind === 'comp'">
              <span class="bbs-summary-badge">{{ levelLabel(r.level, r.imported) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">({{ rowRelative(r) }})</span>
              <span v-if="rowTime(r)" class="bbs-summary-time">{{ rowTime(r) }}</span>
            </template>
            <!-- 摘要:相对时间 + 楼层号都做成等高小标签(盒子居中,免去 CJK 基线下沉),绝对时间作题首文本(窄屏换行) -->
            <template v-else>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">{{ rowRelative(r) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowTime(r)" class="bbs-summary-dateline">{{ rowTime(r) }}</span>
            </template>
            <span v-if="r.stale" class="bbs-summary-stale">待更新</span>
            <!-- 操作键:编辑对任何命中行开放(结构安全;叶子改完向量自动重 embed,总结不进向量库);
                 删除仅根行(删深层会级联删祖先总结链);选择模式无操作 -->
            <span v-if="!selectMode" class="bbs-summary-acts">
              <button
                class="bbs-summary-act"
                type="button"
                :title="r.imported ? '编辑导入历史' : r.kind === 'comp' ? '编辑总结' : '编辑摘要'" :aria-label="r.imported ? '编辑导入历史' : r.kind === 'comp' ? '编辑总结' : '编辑摘要'"
                @click="openEdit(r)"
              >
                <Icon name="edit" />
              </button>
              <button
                v-if="!r.isChild"
                class="bbs-summary-act bbs-summary-del"
                type="button"
                :title="r.imported ? '删除导入历史' : r.kind === 'comp' ? '删除总结(下层会展开)' : '删除摘要'" :aria-label="r.imported ? '删除导入历史' : r.kind === 'comp' ? '删除总结(下层会展开)' : '删除摘要'"
                @click="onDelete(r)"
              >
                <Icon name="trash" />
              </button>
            </span>
          </header>
          <p class="bbs-summary-text">
            <template v-for="(seg, i) in highlightParts(r.text)" :key="i">
              <mark v-if="seg.hit" class="bbs-hit">{{ seg.t }}</mark>
              <template v-else>{{ seg.t }}</template>
            </template>
          </p>
        </div>
      </article>
    </div>
    <!-- 搜索无结果:与「还没有摘要」区分 -->
    <div v-else-if="searching" class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="search" /></span>
      <h3>没有找到匹配的摘要</h3><p>「{{ searchQuery.trim() }}」暂无匹配。换个关键词，或输入 #楼层号试试。</p><button class="bbs-btn" type="button" @click="closeSearch">清除搜索，返回阅读</button>
    </div>
    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="summary" /></span>
      <h3>{{ editingBlocked ? '记忆已进入保护状态' : '从第一条摘要开始' }}</h3><p>{{ editingBlocked ? '请先核对上方兼容说明。这不代表原聊天没有记忆，请勿用重建或导入覆盖来解除保护。' : pendingFloors.length ? '上方已有待补摘楼层，点楼层号即可生成摘要。你也可以等待对话累积到设定楼层后自动生成。' : '对话累积到设定楼层后会自动生成摘要；已有旧总结可通过阅读工具栏导入。' }}</p>
    </div>

    <SummaryPager :page="activeWindow.page" :total="activeWindow.total" :size="SUMMARY_PAGE_SIZE" label="摘要" @update:page="changeSummaryPage" />

    <!-- 选择模式底部操作条:显示已选统计 + 全选/删除/合并。sticky 在页面底部 -->
    <div v-if="selectMode" class="bbs-select-bar" role="group" aria-label="已选摘要操作">
      <span class="bbs-select-info">
        <template v-if="selectionSummary.count">
          已选 {{ selectionSummary.count }} 条
          <template v-if="selectionSummary.floorLo >= 0">
            · 覆盖 {{ selectionSummary.floorLo === selectionSummary.floorHi ? `#${selectionSummary.floorLo}` : `#${selectionSummary.floorLo} - #${selectionSummary.floorHi}` }}
          </template>
          · 生成 {{ levelLabel(selectionSummary.level) }}
        </template>
        <template v-else>勾选连续的多条摘要合并</template>
      </span>
      <span v-if="selectionSummary.count >= 2 && !canMerge" class="bbs-select-warn">需选连续的摘要</span>
      <!-- 全选/取消全选:列表长时免逐条点;文案随 allSelected 切换 -->
      <button
        class="bbs-btn bbs-btn-sm"
        type="button"
        :disabled="!rootNodes.length || deleting"
        :title="allSelected ? '取消全选' : '全选全部根摘要'" :aria-label="allSelected ? '取消全选' : '全选全部根摘要'"
        @click="toggleSelectAll"
      >
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
      <button
        class="bbs-btn bbs-btn-sm bbs-btn-danger"
        type="button"
        :disabled="!selectionSummary.count || deleting || merging || engineState.running"
        title="删除所选条目及其收纳的下层摘要" aria-label="删除所选条目及其收纳的下层摘要"
        @click="openDeleteConfirm"
      >
        <span v-if="deleting" class="bbs-pending-spin"></span>
        <Icon v-else name="trash" />
        删除所选
      </button>
      <button
        class="bbs-btn bbs-btn-sm bbs-btn-primary"
        type="button"
        :disabled="!canMerge || merging || deleting || engineState.running"
        title="将连续选中的摘要合并为上层总结"
        aria-label="将连续选中的摘要合并为上层总结"
        @click="openMergeConfirm"
      >
        <span v-if="merging" class="bbs-pending-spin"></span>
        <Icon v-else name="plans" />
        合并总结
      </button>
    </div>

    <details v-if="hasLeaf" class="bbs-maintenance">
      <summary><Icon name="bolt" /><span>高级维护 · 重建记忆<small>危险操作，日常补摘无需使用</small></span><Icon name="chevron" /></summary>
      <div class="bbs-maintenance-body">
      <p class="bbs-maintenance-warning">重建会重新调用 AI，并覆盖手动修改。请先导出聊天备份。</p>
      <button class="bbs-btn bbs-btn-danger" type="button" :disabled="engineState.running" @click="openRebuildConfirm">重建本聊天记忆</button>
      <span class="bbs-field-hint">升级无需重建。仅在确需重新摘要时使用：会调用 AI，并覆盖手动修改。</span>
      </div>
    </details>
    <ConfirmDialog v-if="!editingBlocked" v-model:open="rebuildConfirmOpen" title="重建本聊天记忆" tone="danger" confirmText="按楼序重建" @confirm="rebuildChatMemory">
      升级无需重建；兼容读取或本地转换即可沿用旧摘要和上层总结。本操作会调用 AI，覆盖手改摘要及相关状态。
      将按先后顺序重新摘要本聊天的有效 AI 楼层（不处理番外、导入历史和跨聊天继承种子），每楼一次请求，失败可能重试，可能产生较多费用。请先备份聊天，并在完成前不要切换聊天或编辑正文。
      每楼成功后替换该楼原摘要及附带状态更新（包含该楼手动修改，请先备份），相关上层总结会失效并按阈值重建。失败或取消会停止，已成功的楼层保留新结果，尚未成功的保留旧结果；不会删除剧情原文。继续？
    </ConfirmDialog>

    <!-- 合并确认弹窗 -->
    <ConfirmDialog
      v-if="!editingBlocked"
      v-model:open="mergeConfirmOpen"
      title="合并总结"
      confirmText="合并"
      @confirm="runMerge"
    >
      将把选中的 {{ selectionSummary.count }} 条摘要合并成一条 {{ levelLabel(selectionSummary.level) }}(无视自动总结阈值)。
      原摘要会被收纳进新总结、从列表收起(数据不删,可删掉新总结还原)。继续?
    </ConfirmDialog>

    <!-- 批量删除确认:选中总结代表整段历史,会连同其收纳的下层节点永久删除。 -->
    <ConfirmDialog
      v-if="!editingBlocked"
      v-model:open="deleteConfirmOpen"
      :title="allSelected ? '清空全部摘要' : '删除所选摘要'"
      confirmText="删除"
      confirmIcon="trash"
      tone="danger"
      @confirm="runDeleteSelected"
    >
      将永久删除所选 {{ selectionSummary.count }} 个条目所代表的全部内容
      ({{ selectionDeleteSummary.leaves }} 条逐楼摘要、{{ selectionDeleteSummary.summaries }} 条总结)。
      选中的总结所收纳的下层摘要也会一并删除；逐楼摘要带来的物品、计划、时间地点等状态会按剩余摘要重新计算，原文楼层仍保持隐藏。
      <template v-if="selectionDeleteSummary.imported">导入历史覆盖的原文楼层会重新显示。</template>
      此操作无法撤销，继续?
    </ConfirmDialog>

    <!-- ===== 导入旧总结弹窗 ===== -->
    <ModalMask v-if="!editingBlocked" :open="importHistoryOpen" @close="closeImportHistory">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="导入旧总结">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">导入旧总结</span>
          <button class="bbs-summary-act" type="button" title="关闭" aria-label="关闭" @click="closeImportHistory"><Icon name="close" /></button>
        </header>
        <p class="bbs-field-hint bbs-import-note">
          把使用棱镜宝书之前写在世界书等位置的剧情总结粘贴到这里。只导入叙事正文,不会自动生成物品、计划或角色状态。
        </p>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">旧总结正文</span>
          <textarea
            v-model="importHistoryText"
            class="bbs-input bbs-modal-textarea"
            rows="10"
            placeholder="粘贴按时间顺序整理好的旧剧情总结…"
          ></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">覆盖截止楼层(含)</span>
          <input
            v-model.number="importHistoryFloor"
            class="bbs-input"
            type="number"
            min="0"
            :max="importHistoryMaxFloor"
          />
          <span class="bbs-field-hint">导入内容将代表 #0 - #{{ importHistoryFloor }}；这些楼层不再重复补摘。当前最后一个 AI 楼层为 #{{ importHistoryMaxFloor }}。</span>
        </label>
        <p class="bbs-field-hint bbs-import-warning">
          导入后请停用世界书里的原总结条目,避免主模型同时收到两份重复内容。原世界书不会被本操作修改。
        </p>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeImportHistory">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importHistoryText.trim()" @click="saveImportedHistory">导入</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 添加计划 / 悬念弹窗 ===== -->
    <ModalMask v-if="!editingBlocked" :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="添加计划或悬念">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">添加计划 / 悬念</span>
          <button class="bbs-summary-act" type="button" title="关闭" aria-label="关闭" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">类型</span>
          <div class="bbs-kind-toggle">
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'plan' }" @click="newKind = 'plan'">计划</button>
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'suspense' }" @click="newKind = 'suspense'">悬念</button>
          </div>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">内容</span>
          <textarea
            ref="contentInput"
            v-model="newContent"
            class="bbs-input bbs-modal-textarea"
            rows="3"
            placeholder="描述这条计划或悬念…"
            @keydown.enter.exact.prevent="addPlan"
          ></textarea>
        </label>
        <!-- 目标时间仅「计划」可填,可选;悬念一般无目标时间故不显示 -->
        <label v-if="newKind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">目标时间(可选)</span>
          <input
            v-model="newTargetTime"
            class="bbs-input"
            type="text"
            placeholder="如 放学后 / 1988/10/1;模糊或留空都可"
          />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newContent.trim()" @click="addPlan">添加</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 编辑计划 / 悬念弹窗 ===== -->
    <ModalMask v-if="!editingBlocked" :open="!!editingPlan" @close="cancelPlanEdit">
      <div v-if="editingPlan" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑计划或悬念">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑{{ editingPlan.kind === 'suspense' ? '悬念' : '计划' }}</span>
          <button class="bbs-summary-act" type="button" title="关闭" aria-label="关闭" @click="cancelPlanEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">内容</span>
          <textarea v-model="editingPlan.content" class="bbs-input bbs-modal-textarea" rows="3"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">创建时间(可选)</span>
          <input v-model="editingPlan.createdTime" class="bbs-input" type="text" placeholder="故事内时间,如 1988/9/29" />
        </label>
        <label v-if="editingPlan.kind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">目标时间(可选)</span>
          <input v-model="editingPlan.targetTime" class="bbs-input" type="text" placeholder="如 放学后 / 1988/10/1;模糊或留空都可" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelPlanEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingPlan.content.trim()" @click="savePlanEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 编辑弹窗 ===== -->
    <ModalMask v-if="!editingBlocked" :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" :aria-label="editing.kind === 'comp' ? '编辑总结' : '编辑摘要'">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">
            {{ editing.kind === 'comp' ? `编辑${levelLabel(editing.level, editing.imported)}` : `编辑摘要 · 楼层 #${editing.msgIndex}` }}
          </span>
          <button class="bbs-summary-act" type="button" title="关闭" aria-label="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <!-- 已被总结收纳的节点:提醒上层总结不会跟着变。叶子才提向量召回(总结不进向量库) -->
        <p v-if="editing.nested" class="bbs-field-hint bbs-nested-hint">
          {{ editing.kind === 'leaf'
            ? '这条已被上层总结收纳:改动会用于向量召回,但上层总结的文本不会自动更新;若总结里也有同样的错误,请一并编辑。'
            : '这条已被更上层总结收纳:改动不会同步到上层总结;若上层里也有同样的错误,请一并编辑。' }}
        </p>
        <!-- 时间仅叶子可编辑(起止两端);总结只压文本,无时间字段 -->
        <div v-if="editing.kind === 'leaf'" class="bbs-modal-field bbs-time-pair">
          <label class="bbs-time-col">
            <span class="bbs-modal-label">起始时间</span>
            <input v-model="editing.timeStart" class="bbs-input" type="text" placeholder="如 1988/9/29 21:00" />
          </label>
          <label class="bbs-time-col">
            <span class="bbs-modal-label">结束时间</span>
            <input v-model="editing.timeEnd" class="bbs-input" type="text" placeholder="如 1988/9/29 21:30" />
          </label>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">{{ editing.kind === 'comp' ? (editing.imported ? '导入历史正文' : '总结正文') : '摘要正文' }}</span>
          <textarea v-model="editing.text" class="bbs-input bbs-modal-textarea" rows="8"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>
    </fieldset>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.bbs-memory-editors {
  display: flex;
  flex-direction: column;
  flex: 1 0 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.bbs-compatibility {
  flex: 0 0 auto;
  margin-bottom: 14px;
  padding: 12px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: 8px;
  color: var(--bbs-ink-soft);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.bbs-compatibility p { margin: 8px 0 0; }
.bbs-compatibility ul { margin: 8px 0; padding-left: 20px; }
.bbs-compatibility .bbs-btn { margin-top: 10px; }
.bbs-compatibility-warning { border-color: var(--bbs-warning); }
.bbs-compatibility-error { color: var(--bbs-danger); }
/* 起止时间:两个输入框并排,各占一半 */
.bbs-time-pair {
  display: flex;
  gap: 10px;
}
.bbs-time-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bbs-import-note,
.bbs-import-warning {
  margin-bottom: 14px;
}
.bbs-import-warning {
  color: var(--bbs-warning);
}
/* 编辑已被总结收纳的节点时的提醒 */
.bbs-nested-hint {
  margin-bottom: 14px;
  color: var(--bbs-warning);
}
/* .bbs-section-head / .bbs-add-mini 已提升为 base.css 全局原子(摘要、场景共用) */

/* —— 悬念簿折叠开关 ——
 * 标题行整体可点:左箭头 + 标题 + 金色计数标。无框透明,贴着 section-head 的左缘,
 * 不喧宾夺主——折叠是辅助操作,标题仍是主体。 */
.bbs-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
/* 无可折叠(零条目)时退化为普通标题:不是按钮观感、光标默认 */
.bbs-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右——像「合上这一章」。
   描边继承 currentColor(muted),hover 整行才点亮强调色。 */
.bbs-fold-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbs-fold-head:hover:not(.is-static) .bbs-fold-caret,
.bbs-fold-head:focus-visible .bbs-fold-caret {
  color: var(--bbs-accent);
}
/* 计数标:金底描边小药丸,呼应账册「结尾计数」,始终显示;收拢时尤其有用——点明藏了多少条。
   margin-top:2px —— 标题是 CJK 大字,基线偏低,小药丸按行盒居中会偏上,下压 2px 才视觉对齐。 */
.bbs-fold-count {
  flex: 0 0 auto;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 9px;
  font-variant-numeric: tabular-nums;
}
/* 两区平级并列:靠间距 + 各自标题分隔即可;更重的鱼尾分章线留给「账目区 ↔ 摘要」那道界 */
.bbs-fold-section + .bbs-fold-section {
  margin-top: 22px;
}

/* —— 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height —— */
.bbs-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
}
.bbs-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
/* min-height:0 + overflow:hidden 才能让 0fr 真正压到零高(否则子项最小内容高顶开) */
.bbs-fold-inner {
  min-height: 0;
  overflow: hidden;
}

.bbs-kind-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 3px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius-sm);
}
.bbs-kind {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-kind.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: none;
}
.bbs-plan-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}
/* 卡片竖排:标签行在上(类型药丸 + 右侧小删除键),内容占满整宽在下 */
.bbs-plan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
/* 标签行:类型药丸靠左,删除键推到最右 */
.bbs-plan-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 类型标签:小药丸,用颜色区分计划/悬念 */
.bbs-plan-kind {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
}
.bbs-plan-kind.plan {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-plan-kind.suspense {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* 楼层号:创建该计划/悬念时所在楼层,描边定位标签;与摘要列表 #楼层 同款观感 */
.bbs-plan-floor {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
/* 动作组(编辑/删除)推到最右;平时低调,桌面 hover/聚焦该卡才浮现 */
.bbs-plan-acts {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.bbs-plan:hover .bbs-plan-acts,
.bbs-plan:focus-within .bbs-plan-acts {
  opacity: 1;
}
/* 单个动作键:小而 muted */
.bbs-plan-act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-plan-act:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-plan-del:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
/* 内容:独占整宽,自然换行 */
.bbs-plan-content {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* 计划时间:立于/目标 两枚小标签,描边低调,目标用强调色区分 */
.bbs-plan-times {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-plan-time {
  font-size: 11px;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
}
.bbs-plan-time-target {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-plan-empty {
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--bbs-ink-muted);
}

/* —— 当前状态 —— */
.bbs-state {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-top: 12px;
}
.bbs-state-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0; /* 允许本项在 wrap 容器内收缩,收缩额度由下面两个子项分配 */
}
.bbs-state-key {
  font-size: 11px;
  color: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 8px;
  /* 药丸固宽:长地名会把整项撑超宽,默认 flex-shrink:1 会连这枚标签一起压扁
     (内距被吃、「地点」二字竖排)。让它不参与收缩,超出的宽度全由右侧值消化 */
  flex: none;
  white-space: nowrap;
}
.bbs-state-val {
  font-size: 14px;
  color: var(--bbs-ink);
  min-width: 0;
  word-break: break-word;
}

.bbs-error {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--bbs-danger);
}

/* —— 立即总结按钮:摘要标题右侧的次级操作,小一号,带图标 —— */
.bbs-resummary-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* 复用未摘要楼层的旋转环(.bbs-pending-spin),此处微调尺寸贴合按钮文字 */
.bbs-resummary-btn .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-resummary-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}

/* —— 未摘要楼层:待办面板,用强调色描边的卡片框起来,提示「这些楼还没摘」 —— */
.bbs-pending {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
}
/* 标题行:标签靠左,批量补摘按钮/进度推到右侧 */
.bbs-pending-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-pending-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-accent);
}
/* 批量补摘按钮:推到标题行最右,小一号带图标 */
.bbs-batch-btn {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  font-size: 12px;
}
/* 批量进行中的进度块:旋转环 + 进度文字 + 取消键 */
.bbs-batch-progress {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
}
.bbs-batch-progress .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-batch-cancel {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.bbs-batch-cancel:hover:not(:disabled) {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-batch-cancel:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 标签后跟一枚计数小点,强化「有 N 楼待办」 */
.bbs-pending-label::after {
  content: attr(data-count);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bbs-pending-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-pending-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-pending-chip:hover:not(:disabled) {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-pending-chip:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 生成中:小旋转环替代楼层号 */
.bbs-pending-spin {
  width: 13px;
  height: 13px;
  border: 2px solid var(--bbs-line-strong);
  border-top-color: var(--bbs-accent);
  border-radius: 50%;
  animation: bbs-pending-rot 0.7s linear infinite;
}
@keyframes bbs-pending-rot {
  to {
    transform: rotate(360deg);
  }
}

/* —— 眼下局势卡:与角色卡同构——左色条 + 头行(在场者+记时+操作区)+ 主文 + 分类标签字段表 —— */
.bbs-focus-acts {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
}
.bbs-focus {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden; /* 让左色条贴着圆角边缘 */
}
/* 左缘一道金色条:与角色卡「在场」色条同款 */
.bbs-focus::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
/* 头行:在场者名字 + 记时小标 + 操作区(靠右,桌面 hover 才浮现,同角色卡) */
.bbs-focus-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bbs-focus-names {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  min-width: 0;
  word-break: break-word;
}
.bbs-focus-names.is-empty {
  font-weight: 400;
  color: var(--bbs-ink-muted);
}
.bbs-focus-time {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
@media (hover: hover) {
  .bbs-focus .bbs-focus-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-focus:hover .bbs-focus-acts,
  .bbs-focus-acts:focus-within {
    opacity: 1;
  }
}
/* 局面:主文,类比角色卡的正文段 */
.bbs-focus-situation {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* 字段表:与角色卡同款「彩色类别标签 + 内容」对齐行 */
.bbs-focus-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-focus-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-focus-field dt {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  padding: 1px 0;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
  /* 默认中性(旧数据焦点行沿用),具体类别下方各自染色 */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-focus-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 张力:暖色标签——正在持续的关系气压,与「会变的即时状态」同级醒目 */
.bbs-focus-field.f-tension dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-focus-field.f-tension dd {
  color: var(--bbs-ink);
}
/* 将至:强调金标签——正文明确预告的下一拍,是关键前瞻信息 */
.bbs-focus-field.f-next dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-focus-field.f-next dd {
  color: var(--bbs-ink);
}

/* —— 分章分隔:计划/悬念 与 摘要 两区之间的明确界线 —— */
/* 两侧细线在中间断开,嵌一枚金色小菱形——古籍分章的鱼尾标记,呼应纸墨主题 */
.bbs-divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 26px 0;
}
.bbs-divider::before,
.bbs-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--bbs-line-strong);
}
.bbs-divider-mark {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
  background: var(--bbs-accent);
  border-radius: 1px;
}

/* —— 摘要区工具行:标题右侧「选择 / 立即总结」并排 —— */
.bbs-summary-heading {
  min-width: 0;
}
.bbs-token-estimate {
  margin: 3px 0 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  color: var(--bbs-ink-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bbs-summary-tools {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.bbs-summary-tools .bbs-btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* 搜索切换键激活态:点亮强调色,呼应「正在搜索」 */
.bbs-summary-tools .bbs-add-mini.is-on {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}

/* —— 搜索框:放大镜内嵌左侧,清空键在右;整行圆角与输入一致 —— */
.bbs-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-top: 12px;
}
.bbs-search-icon {
  position: absolute;
  left: 11px;
  color: var(--bbs-ink-muted);
  pointer-events: none;
  font-size: 15px;
}
.bbs-search-input {
  /* 左留放大镜位、右留清空键位 */
  padding-left: 34px;
  padding-right: 34px;
}
.bbs-search-clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-search-clear:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}

/* —— 搜索命中高亮:强调色淡底,不改字色保证可读 —— */
.bbs-hit {
  background: var(--bbs-accent-soft);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

/* —— 摘要列表 —— */
.bbs-summary-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
}
/* 卡片视觉(.bbs-summary-card / meta / 标签 / 展开条 / 收起条)已提到 base.css 全局,
   供 SummaryNode.vue 与本页平铺列表共用(scoped 不跨组件)。此处只留本页专属:选择模式 + 底部操作条。 */

/* 选择模式:卡片左侧腾出复选框列,横向布局;整卡可点,指针提示可点 */
.bbs-summary-list.is-selecting .bbs-summary-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  /* 键盘聚焦可见(role=checkbox 时 tabindex=0) */
  outline: none;
}
.bbs-summary-list.is-selecting .bbs-summary-card:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 1px;
}
.bbs-summary-list.is-selecting .bbs-summary-card:hover:not(.is-selected) {
  border-color: var(--bbs-line-strong);
}
.bbs-summary-card.is-selected {
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-summary-check {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding-top: 2px;
  /* 不抢点击:整卡已负责 toggle,复选框仅视觉状态 */
  pointer-events: none;
}
.bbs-summary-check .bbs-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--bbs-accent);
}
/* 选择模式下 main 占满剩余宽 */
.bbs-summary-list.is-selecting .bbs-summary-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* 展开开关(.bbs-expand-bar)、收起条(.bbs-collapse-footer)、展开态左缘(.is-expanded)
   均在 base.css,供 SummaryNode.vue 共用。 */

/* —— 选择模式底部操作条:sticky 贴底,强调色描边突出 —— */
.bbs-select-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
}
.bbs-select-info {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink-soft);
  font-variant-numeric: tabular-nums;
}
.bbs-select-warn {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-radius: var(--bbs-radius-sm);
  padding: 2px 8px;
}
.bbs-select-bar .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-select-bar .bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-select-bar .bbs-btn-danger:hover:not(:disabled) {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

.bbs-empty {
  flex: 1;
}

/* —— 编辑弹窗:外壳样式已提到 base.css 通用,这里只补本页专用的 textarea —— */
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}

/* ============ 触屏:悬念簿动作键常显但低调(摘要卡片动作键在 base.css 处理) ============ */
@media (hover: none) {
  .bbs-plan-acts {
    opacity: 1;
  }
  /* 触达区略放大到 ~32px(够点),图标维持小巧 */
  .bbs-plan-act {
    width: 32px;
    height: 32px;
    font-size: 15px;
  }
}

/* ============ 减弱动效:悬念簿箭头与收展瞬切(摘要展开动效在 SummaryNode/base.css) ============ */
@media (prefers-reduced-motion: reduce) {
  .bbs-fold-caret,
  .bbs-fold-wrap {
    transition: none;
  }
}

/* ============ 窄屏:类型切换撑满、状态条整齐 ============ */
@media (max-width: 640px) {
  /* 添加弹窗里的类型切换:计划 | 悬念 各占一半,撑满整行 */
  .bbs-kind-toggle {
    width: 100%;
  }
  .bbs-kind {
    flex: 1;
  }

  /* 时间/地点:窄屏整齐堆叠成两行,长地点不再把行挤乱 */
  .bbs-state {
    flex-direction: column;
    gap: 8px;
  }

  /* 摘要题首窄屏排布:绝对时间(纯文本)较长,会把相对时间+楼层标签挤满首行、把操作键顶到第二行。
     用 order 把绝对时间排到末尾并 flex-basis:100% 独占一行,首行只留「相对时间标签 + 楼层标签 + 操作键」。 */
  .bbs-summary-dateline,
  .bbs-summary-time {
    order: 99;
    flex-basis: 100%;
  }

}

/* 阅读器：纸面、细线和文字层级，避免每个信息块都变成带框表单。 */
.bbs-summary-page :deep(.prism-page-header) { margin-bottom:16px; }
.bbs-summary-page :deep(.prism-page-description) { margin-top:5px; }
.bbs-summary-page { height:auto; min-height:100%; min-width:0; max-width:860px; margin:0 auto; color:var(--bbs-ink); overflow-wrap:anywhere; }
.bbs-overview { margin:0 0 10px; padding:17px 20px; border:0; border-radius:14px; background:var(--bbs-surface); box-shadow:0 2px 12px -8px #00000020; }
.bbs-overview-head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.bbs-overview-caption { font-size:11px; color:var(--bbs-ink-muted); letter-spacing:.08em; }
.bbs-overview-status { font-size:10px; color:var(--bbs-ink-soft); }
.bbs-overview-status::before { content:''; display:inline-block; width:5px; height:5px; margin:0 6px 1px 0; border-radius:50%; background:var(--bbs-accent); }
.bbs-overview-status.is-protected { color:var(--bbs-warning); }
.bbs-overview-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin:10px 0; }
.bbs-overview-stats > div { display:flex; flex-direction:column; min-width:0; }
.bbs-overview-stats dd { order:-1; margin:0 0 3px; font:500 27px/1.2 var(--bbs-font-reading); font-variant-numeric:tabular-nums; }
.bbs-overview-stats dt { font-size:10px; color:var(--bbs-ink-muted); }
.bbs-overview-pending dd { color:var(--bbs-accent); }
.bbs-backfill-entry { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:8px; border-top:1px solid var(--bbs-line); }
.bbs-backfill-entry p { font-size:11px; line-height:1.7; margin:0; color:var(--bbs-ink-muted); }
.bbs-backfill-entry .bbs-btn { flex-shrink:0; min-height:40px; font-size:11px; padding:7px 11px; border-radius:8px; }
.bbs-compatibility { margin:0 0 7px; padding:0 3px; border:0; background:transparent; border-radius:0; }
.bbs-compatibility-ready summary { display:flex; align-items:center; gap:9px; padding:8px 0; font-size:10px; font-weight:400; color:var(--bbs-ink-muted); list-style:none; cursor:pointer; }
.bbs-compatibility-ready summary::before { content:'✓'; color:var(--bbs-accent); font-size:11px; }
.bbs-compatibility-ready summary span { margin-left:auto; font-size:10px; }
.bbs-compatibility-ready summary::after { content:'›'; font-size:15px; }
.bbs-compatibility-ready[open] summary::after { transform:rotate(90deg); }
.bbs-compatibility-ready p { font-size:12px; line-height:1.8; }
.bbs-compatibility-warning { padding:16px; border:1px solid var(--bbs-warning); border-radius:10px; background:var(--bbs-warning-soft); }
.bbs-compatibility-warning p { font-size:12px; line-height:1.9; }
.bbs-compatibility-ready summary:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:3px; }
.bbs-reader-context { margin-bottom:17px; border-top:1px solid var(--bbs-line); border-bottom:1px solid var(--bbs-line); }
.bbs-reader-context > summary { display:flex; align-items:center; gap:12px; padding:12px 0; cursor:pointer; list-style:none; font-size:13px; color:var(--bbs-ink); }
.bbs-reader-context summary::-webkit-details-marker,.bbs-compatibility-ready summary::-webkit-details-marker { display:none; }
.bbs-reader-context > summary > span:nth-child(2) { min-width:0; flex:1; }
.bbs-reader-context > summary small { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:4px; font-size:11px; font-weight:400; color:var(--bbs-ink-muted); }
.bbs-context-icon { font-size:18px; color:var(--bbs-accent); }
.bbs-context-chevron { color:var(--bbs-ink-muted); transform:rotate(-90deg); }
.bbs-reader-context[open] > summary .bbs-context-chevron { transform:rotate(0); }
.bbs-reader-context-body { padding:10px 0 20px; }
.bbs-reader-context-body .bbs-section-kicker,.bbs-reader-context-body .bbs-section-description { display:none; }
.bbs-section-head { align-items:center; gap:14px; margin-bottom:12px; }
.bbs-section-kicker { display:block; font:500 9px/1.5 var(--bbs-font-sans); letter-spacing:.18em; color:var(--bbs-accent); margin-bottom:5px; }
.bbs-section-description { color:var(--bbs-ink-muted); font-size:11px; margin:5px 0 0; }
.bbs-title-sub { font-family:var(--bbs-font-reading); font-size:21px; font-weight:600; letter-spacing:.05em; }
.bbs-focus,.bbs-plan { border:0; border-radius:8px; background:var(--bbs-surface); box-shadow:none; }
.bbs-focus { border-left:2px solid var(--bbs-accent); padding:14px 16px; }
.bbs-focus-head { flex-wrap:wrap; gap:6px; }
.bbs-focus-situation { font-size:14px; line-height:1.9; }
.bbs-focus-time,.bbs-plan-times { font-size:10px; color:var(--bbs-ink-muted); }
.bbs-focus-acts { margin-left:auto; }
.bbs-focus-field { grid-template-columns:32px minmax(0,1fr); }
.bbs-focus-fields dd { font-size:12px; }
.bbs-planning { margin-top:20px; }
.bbs-planning-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:22px; }
.bbs-plan { padding:12px; margin-top:8px; }
.bbs-plan-kind { font-size:10px; }
.bbs-state { background:transparent; padding:12px 0; border:0; }
.bbs-state-key { font-size:10px; }
.bbs-state-val { font-size:12px; }
.bbs-divider { display:none; }
.bbs-reading-head { display:flex; align-items:flex-end; flex-wrap:wrap; gap:12px; margin:0 0 10px; }
.bbs-summary-heading { min-width:0; flex:1; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
.bbs-summary-heading .bbs-token-estimate { flex-basis:100%; }
.bbs-estimate-toggle { margin-top:0; padding:0; min-height:32px; border:0; background:transparent; font-size:10px; color:var(--bbs-ink-muted); text-decoration:underline; text-underline-offset:3px; }
.bbs-summary-tools { display:flex; flex-wrap:wrap; gap:4px; padding:0; background:transparent; border:0; }
.bbs-summary-tools .bbs-btn,.bbs-summary-tools .bbs-add-mini { min-height:40px; height:auto; width:auto; padding:7px 11px; border:0; border-radius:7px; font-size:11px; background:var(--bbs-surface-2); color:var(--bbs-ink-soft); }
.bbs-summary-tools .bbs-resummary-btn { color:var(--bbs-accent); background:var(--bbs-accent-soft); }
.bbs-btn-label { display:inline; }
.bbs-result-note { color:var(--bbs-ink-muted); font-size:10px; margin:14px 0 0; }
.bbs-summary-list { display:block; margin:0; }
.bbs-summary-page :deep(.bbs-summary-card) { margin:0; padding:22px 0; border:0; border-bottom:1px solid var(--bbs-line); border-radius:0; background:transparent; box-shadow:none; gap:10px; }
.bbs-summary-page :deep(.bbs-summary-card.is-deep) { margin:14px 0 0; padding:18px 20px; background:var(--bbs-surface); border:0; border-radius:10px; }
.bbs-summary-page :deep(.bbs-summary-card.is-child) { padding-left:17px; border-left:1px solid var(--bbs-line); margin-left:5px; }
.bbs-summary-page :deep(.bbs-summary-main) { min-width:0; flex:1; }
.bbs-summary-page :deep(.bbs-summary-meta) { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:7px; }
.bbs-summary-page :deep(.bbs-summary-badge) { border-radius:4px; background:var(--bbs-accent-soft); color:var(--bbs-accent); font-size:10px; padding:3px 7px; font-weight:600; }
.bbs-summary-page :deep(.bbs-summary-loc) { padding:0; border:0; background:transparent; color:var(--bbs-ink-muted); font:400 10px/1.5 var(--bbs-font-mono); }
.bbs-summary-page :deep(.bbs-summary-rel) { color:var(--bbs-ink-soft); font-size:11px; }
.bbs-summary-page :deep(.bbs-summary-text) { margin:0; font-size:14px; line-height:2; letter-spacing:.025em; color:var(--bbs-ink); overflow-wrap:anywhere; }
.bbs-summary-page :deep(.bbs-summary-acts) { flex:0 0 auto; margin-left:auto; opacity:1; gap:0; }
.bbs-summary-page :deep(.bbs-summary-act) { width:36px; height:36px; font-size:12px; border:0; background:transparent; color:var(--bbs-ink-muted); }
.bbs-summary-page :deep(.bbs-summary-act:hover) { color:var(--bbs-accent); background:var(--bbs-accent-soft); }
.bbs-summary-page :deep(.bbs-summary-time),.bbs-summary-page :deep(.bbs-summary-dateline) { font-size:10px; color:var(--bbs-ink-muted); }
.bbs-summary-page :deep(.bbs-expand-bar) { min-height:40px; margin-top:10px; padding:7px 0 0; border-top:1px solid var(--bbs-line); font-size:11px; color:var(--bbs-accent); }
.bbs-summary-list.is-selecting .bbs-summary-card.is-selected { background:var(--bbs-accent-soft); }
.bbs-summary-check { flex:0 0 auto; }
.bbs-select-bar { background:var(--bbs-surface); border-color:var(--bbs-line); box-shadow:none; padding-bottom:max(12px,env(safe-area-inset-bottom)); }
.bbs-select-info { line-height:1.7; }
.bbs-empty { padding:35px 10px; border:0; background:transparent; }
.bbs-empty h3 { font:500 18px/1.7 var(--bbs-font-reading); }
.bbs-empty p { font-size:12px; line-height:1.9; }
.bbs-maintenance { margin-top:28px; border-top:1px solid var(--bbs-line); }
.bbs-maintenance summary { display:flex; align-items:center; gap:10px; padding:16px 0; font-size:11px; color:var(--bbs-ink-muted); cursor:pointer; list-style:none; }
.bbs-maintenance summary::-webkit-details-marker { display:none; }
.bbs-maintenance summary > span { flex:1; min-width:0; }
.bbs-maintenance summary small { display:block; font-size:10px; margin-top:4px; }
.bbs-maintenance-body { padding:16px; border-radius:8px; background:var(--bbs-danger-soft); }
.bbs-maintenance-warning { color:var(--bbs-danger); font-size:12px; line-height:1.8; }
.bbs-summary-page :deep(button:focus-visible),.bbs-summary-page summary:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:3px; }
.bbs-modal { min-width:0; overflow-wrap:anywhere; }
@media(max-width:640px) {
 .bbs-overview { padding:12px 16px; }
 .bbs-overview-stats dd { font-size:26px; }
 .bbs-backfill-entry { gap:7px; }
 .bbs-backfill-entry p { font-size:10px; }
 .bbs-backfill-entry .bbs-btn { font-size:10px; padding:7px 9px; }
 .bbs-reading-head { display:block; }
 .bbs-summary-tools { margin-top:10px; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; }
 .bbs-summary-tools .bbs-btn,.bbs-summary-tools .bbs-add-mini { justify-content:center; padding:6px 3px; gap:4px; font-size:10px; white-space:nowrap; }
 .bbs-summary-tools .bbs-btn-label { display:inline; }
 .bbs-planning-grid { grid-template-columns:minmax(0,1fr); gap:20px; }
 .bbs-focus-time { flex-basis:100%; order:3; }
 .bbs-summary-page :deep(.bbs-summary-text) { font-size:14px; line-height:1.95; }
 .bbs-summary-page :deep(.bbs-summary-dateline),.bbs-summary-page :deep(.bbs-summary-time) { flex-basis:100%; order:9; }
 .bbs-summary-page :deep(.bbs-summary-card.is-deep) { padding:16px; }
 .bbs-select-bar { flex-wrap:wrap; gap:8px; padding:12px; }
 .bbs-select-info,.bbs-select-warn { flex-basis:100%; }
 .bbs-time-pair { flex-direction:column; }
 .bbs-time-col { min-width:0; width:100%; }
}
.bbs-summary-failure { min-width: 0; overflow-wrap: anywhere; }
.bbs-planning .bbs-fold-head { flex-wrap:wrap; min-height:44px; }
.bbs-outline-count { min-width:0; font-size:10px; font-weight:400; color:var(--bbs-accent); white-space:normal; }
.bbs-summary-failure details { margin-block: 8px; }
.bbs-summary-failure summary { cursor: pointer; font-size: 13px; }
</style>
