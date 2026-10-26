<script setup lang="ts">
/**
 * 摘要页：组合各区块——概览（含补摘、全部重新摘要入口）、旧记忆兼容、全部重新摘要未完成提示、未摘要楼层与批量补摘、
 * 当前局势与计划、创作规划、页脚；
 * 本文件负责「摘要与总结」列表：工具行、搜索、多选合并与删除、单条编辑与删除。
 * 页面级状态（只读保护、旧记忆转换、批量补摘、关闭弹窗与切聊天重置）在 pageCtx.ts。
 */
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import PageHeader from '@/components/PageHeader.vue';
import { apiSettings } from '@/api/settings';
import { deleteLeafAt, deleteSummary, invalidateSummaryAncestors } from '@/memory/apply';
import { estimateTokens } from '@/memory/budget';
import { continuityNoteText } from '@/memory/continuity';
import { engineState, resummarizeNow, resummaryHold, syncHiddenNow } from '@/memory/engine';
import { estimateInjectionTokenBreakdown, refreshInjection, type ViewNode } from '@/memory/inject';
import { derivedMeta, memory, recomputeDerived } from '@/memory/store';
import { recallDebug } from '@/memory/vector/debug';
import { buildConfirmedInjection } from '@/notes/service';
import { buildOutlineInjection } from '@/outline/service';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, nextTick, onUnmounted, provide, ref, watch } from 'vue';
import BatchBackfillDialog from './BatchBackfillDialog.vue';
import CompatibilityNotice from './CompatibilityNotice.vue';
import OutlineSection from './OutlineSection.vue';
import PendingFloors from './PendingFloors.vue';
import RebuildDialog from './RebuildDialog.vue';
import RebuildNotice from './RebuildNotice.vue';
import SituationSection from './SituationSection.vue';
import SummaryEditDialog from './SummaryEditDialog.vue';
import SummaryFooter from './SummaryFooter.vue';
import SummaryNode from './SummaryNode.vue';
import SummaryOverview from './SummaryOverview.vue';
import SummaryPager from './SummaryPager.vue';
import SummarySelectBar from './SummarySelectBar.vue';
import { SUMMARY_CTX, type SummaryRow } from './ctx';
import { summaryErrorPresentation } from './errorPresentation';
import { floorLabel, levelLabel, rowRelative, rowTime } from './labels';
import { createSummaryPage, SUMMARY_PAGE } from './pageCtx';
import { useSummarySelection } from './selection';
import { arrayPage, createSummaryIndex, SUMMARY_PAGE_SIZE, treePage, walkExpanded } from './view';

const page = createSummaryPage();
provide(SUMMARY_PAGE, page);
const { editingBlocked, allowMemoryEdit, hasLeaf, isTouch, pendingFloors } = page;
const summaryFailure = computed(() => summaryErrorPresentation(engineState.lastError, engineState.lastFailure));

/* ============ 立即总结 ============
 * 手动触发一次「检测是否达阈值 → 达到就总结(可连锁多层)」。结果用一句临时提示反馈。 */
const resummaryRunning = ref(false);
const resummaryHint = ref('');
let resummaryHintTimer: ReturnType<typeof setTimeout> | null = null;

// 总结节奏:每条 AI 回复都会摘要(与保留窗口无关);逐楼摘要攒够「每次总结数 + 保留摘要数」条时,合并最旧的「每次总结数」条。
// 每轮约 2 楼(用户 + AI),所以首次约在 (每次总结数 + 保留摘要数)×2 楼前后,之后约每 每次总结数×2 楼一次。
// 阈值关闭(<2)时不显示节奏句。
const resummaryFirst = computed(() => (apiSettings.leafBatchThreshold + Math.max(0, apiSettings.leafKeepRecent)) * 2);
const resummaryEvery = computed(() => apiSettings.leafBatchThreshold * 2);
const showCadence = computed(() => apiSettings.leafBatchThreshold >= 2);

// 估算涉及引擎的全量注入选择，仅在用户需要时计算，避免进入/滑动阅读页额外构造全树。
const showInjectionEstimate = ref(false);
// 纯前端估算当前实际注入量。derivedMeta.rev 补上 chat/is_system 这类非 Vue 响应式数据的刷新信号。
// 除摘要与状态外,召回(按上一次召回的内容)、札记安排、创作规划和连续性提醒各走自己的注入,分别列出。
const injectionTokenEstimate = computed(() => {
  void derivedMeta.rev;
  const estimate = estimateInjectionTokenBreakdown();
  const tokens = (text: string) => (text ? estimateTokens(text) : 0);
  const recall = tokens(recallDebug.injectedText);
  const notes = tokens(buildConfirmedInjection());
  const outline = tokens(buildOutlineInjection());
  const continuity = tokens(continuityNoteText());
  return {
    summary: estimate.summary.toLocaleString(),
    other: estimate.other.toLocaleString(),
    recall: recall.toLocaleString(),
    showRecall: apiSettings.vector.enabled || recall > 0,
    notes: notes ? notes.toLocaleString() : '',
    outline: outline ? outline.toLocaleString() : '',
    continuity: continuity ? continuity.toLocaleString() : '',
    total: (estimate.summary + estimate.other + recall + notes + outline + continuity).toLocaleString(),
  };
});

// 总结因截断等原因失败后暂停自动重发:只在当前聊天显示,与上方的失败提示重复时不再显示
const holdShown = computed(() => {
  void derivedMeta.rev; // 切换聊天后重新核对
  return resummaryHold.active
    && resummaryHold.chatId === (getContext()?.getCurrentChatId?.() ?? '')
    && engineState.lastError !== resummaryHold.message;
});

// 没有摘要时的说明:每条 AI 回复在发送下一条消息时摘要(开启「回复结束后立即摘要」时在回复结束后)
const emptyText = computed(() => {
  const timing = !apiSettings.autoSummaryEnabled
    ? '自动摘要已关闭（设置 → 摘要设置），可用上方的「补摘」手动生成'
    : apiSettings.summarizeOnReplyEnd
      ? '每条 AI 回复会在回复结束后自动摘要（已开启「回复结束后立即摘要」）'
      : '每条 AI 回复会在发送下一条消息时自动摘要（开启「回复结束后立即摘要」时在回复结束后）';
  return pendingFloors.value.length
    ? `上方列出了尚未摘要的楼层，点击楼层号即可生成。${timing}。`
    : `${timing}；已有的旧总结可在页面底部的「导入旧总结」中导入。`;
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
      // 未达阈值:补一句节奏,告诉用户大概什么时候合并
      const cadence = showCadence.value ? `；首次约在第 ${resummaryFirst.value} 楼前后合并，之后约每 ${resummaryEvery.value} 楼合并一次` : '';
      resummaryHint.value = `摘要数量尚未达到合并条件${cadence}。`;
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
      ...(l.lite ? { lite: true } : {}),
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
    lite: n.lite === true,
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
const summaryPage = ref(1);
const summaryList = ref<HTMLElement | null>(null);
// 多选：勾选、合并、删除所选（进入多选时收起所有展开，只操作根）
const selection = useSummarySelection({ rootNodes, byId, nodeFloors, allowMemoryEdit, onEnter: () => { expanded.value = new Set(); } });
const { selectMode, selectedIds, enterSelectMode, exitSelectMode, toggleSelect } = selection;
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

/* 删除单条摘要/总结:先弹插件确认框(文案与原来的浏览器确认框相同),确认后按当时的数据删除。 */
const pendingDelete = ref<SummaryRow | null>(null);
const deleteRowCopy = computed(() => {
  const r = pendingDelete.value;
  if (!r) return { title: '', text: '' };
  if (r.kind === 'leaf') return { title: '删除摘要', text: '删除这条摘要？它记下的物品、计划、时间地点等变化会按剩下的摘要重新计算，包含它的总结也会一起删除。原楼层保持隐藏。' };
  if (r.imported) return { title: '删除导入的旧总结', text: '删除这条导入的旧总结？它覆盖的楼层会重新显示，并变回待摘要。世界书不受影响。' };
  return { title: '删除总结', text: '删除这条总结？它合并的摘要会重新显示，物品、计划等不受影响。' };
});
function onDelete(r: SummaryRow) {
  if (!allowMemoryEdit()) return;
  pendingDelete.value = r;
}
async function confirmDeleteRow() {
  const r = pendingDelete.value;
  pendingDelete.value = null;
  if (!r || !allowMemoryEdit()) return;
  if (r.kind === 'leaf') {
    // 确认框打开期间楼层可能变动:按摘要 id 找回它现在所在的楼层,找不到就不删。
    const leaf = derivedMeta.leaves.find(l => l.id === r.id && !l.stale);
    if (!leaf) { toast('这条摘要已不存在，未删除。', 'warning'); return; }
    deleteLeafAt(leaf.msgIndex);
  } else {
    if (!memory.summaries.some(s => s.id === r.id)) { toast('这条总结已不存在，未删除。', 'warning'); return; }
    if (r.imported) {
      invalidateSummaryAncestors(r.id);
      recomputeDerived();
      await syncHiddenNow(true);
      return;
    }
    deleteSummary(r.id);
  }
  refreshInjection();
}

/* 编辑单条摘要 / 总结：弹窗在 SummaryEditDialog，卡片的编辑键经 SUMMARY_CTX 调到这里。 */
const editDialog = ref<InstanceType<typeof SummaryEditDialog> | null>(null);
function openEdit(r: SummaryRow) {
  editDialog.value?.open(r);
}

// 注入单张卡片所需的状态、helper 与动作；SummaryNode 不再递归。
provide(SUMMARY_CTX, {
  byId, expanded, selectMode, searching, selectedIds,
  toggleExpand, toggleSelect, openEdit, onDelete, revealNode,
  childCount: n => summaryIndex.value.childCount(n),
  nodeFloors, toRow, levelLabel, floorLabel, rowTime, rowRelative, highlightParts,
});

// 只读保护开启或切换聊天时：关闭本列表的编辑弹窗、确认框和多选。
page.onCloseEditors(() => {
  pendingDelete.value = null;
  selection.closeAll();
});
// 切换聊天：重置展开、搜索、分页等临时视图态，避免上个聊天的残留带过来。
page.onReset(() => {
  resummaryHint.value = '';
  if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
  expanded.value = new Set();
  searchQuery.value = '';
  searchOpen.value = false;
  summaryPage.value = 1;
  showInjectionEstimate.value = false;
  exitSelectMode();
});
onUnmounted(() => {
  if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
});
</script>

<template>
  <section class="bbs-page bbs-summary-page">
    <PageHeader icon="summary" title="摘要" description="每层楼生成摘要，摘要达到一定数量时进一步总结，并注入正文。" />

    <SummaryOverview />
    <CompatibilityNotice />

    <div v-if="engineState.lastError" class="bbs-callout is-danger bbs-summary-failure" role="alert">
      <strong class="bbs-callout-title">{{ summaryFailure.title }}</strong>
      <span v-if="summaryFailure.help" class="bbs-callout-help">{{ summaryFailure.help }}</span>
      <details v-if="summaryFailure.details">
        <summary>{{ summaryFailure.detailsLabel }}</summary>
        <p>{{ summaryFailure.details }}</p>
      </details>
    </div>

    <fieldset class="bbs-memory-editors" :disabled="editingBlocked" aria-label="本聊天记忆编辑">
    <RebuildNotice />
    <PendingFloors />
    <BatchBackfillDialog />
    <RebuildDialog />
    <SituationSection />
    <OutlineSection />

    <!-- ===== 摘要 ===== -->
    <div class="bbs-section-head bbs-reading-head">
      <div class="bbs-summary-heading">
        <h2 class="bbs-title bbs-title-sub">摘要与总结</h2>
        <button class="bbs-btn bbs-btn-sm bbs-estimate-toggle" type="button" :aria-expanded="showInjectionEstimate" @click="showInjectionEstimate = !showInjectionEstimate">{{ showInjectionEstimate ? '收起估算' : '估算注入量' }}</button>
        <div v-if="showInjectionEstimate" class="bbs-token-estimate" title="按字数粗略估算，不请求接口">
          <span>摘要注入 ≈ {{ injectionTokenEstimate.summary }} tokens</span>
          <span>其他注入 ≈ {{ injectionTokenEstimate.other }} tokens（当前状态、只读账本说明、时间标签提示词）</span>
          <span v-if="injectionTokenEstimate.showRecall">召回注入（上一次）≈ {{ injectionTokenEstimate.recall }} tokens</span>
          <span v-if="injectionTokenEstimate.notes">札记安排 ≈ {{ injectionTokenEstimate.notes }} tokens</span>
          <span v-if="injectionTokenEstimate.outline">创作规划 ≈ {{ injectionTokenEstimate.outline }} tokens</span>
          <span v-if="injectionTokenEstimate.continuity">连续性提醒 ≈ {{ injectionTokenEstimate.continuity }} tokens</span>
          <span class="bbs-token-total">合计 ≈ {{ injectionTokenEstimate.total }} tokens</span>
          <span v-if="injectionTokenEstimate.showRecall" class="bbs-token-note">召回每轮不同，这里按上一次召回实际注入的内容估算。</span>
        </div>
      </div>
      <div class="bbs-summary-tools" role="group" aria-label="摘要整理工具">
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :class="{ 'is-on': searchOpen }"
          :disabled="!rootNodes.length"
          :aria-expanded="searchOpen"
          :title="searchOpen ? '收起搜索' : '搜索摘要'"
          @click="toggleSearch"
        >
          <Icon name="search" /><span class="bbs-btn-label">搜索</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="!rootNodes.length || searching"
          title="勾选相邻的摘要，合并为一条总结"
          @click="enterSelectMode"
        >
          <Icon name="checklist" /><span class="bbs-btn-label">多选</span>
        </button>
        <button
          v-else
          class="bbs-btn bbs-btn-sm"
          type="button"
          title="退出多选"
          @click="exitSelectMode"
        >
          <Icon name="close" /><span class="bbs-btn-label">完成</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm bbs-btn-primary bbs-resummary-btn"
          type="button"
          :disabled="resummaryRunning || engineState.running || !hasLeaf"
          :title="hasLeaf ? '摘要达到数量时立即合并为总结' : '暂无摘要，无法总结'"
          @click="doResummarize"
        >
          <span v-if="resummaryRunning" class="bbs-spin"></span>
          <Icon v-else name="bolt" />
          <span class="bbs-btn-label">立即总结</span>
        </button>
      </div>
    </div>
    <p v-if="resummaryHint" class="bbs-resummary-hint">{{ resummaryHint }}</p>
    <div v-if="holdShown" class="bbs-callout is-warning bbs-resummary-hold" role="status">
      <strong class="bbs-callout-title">总结已暂停自动重试</strong>
      <span class="bbs-callout-help">上次合并这批摘要时失败：{{ resummaryHold.message }} 修改总结所用的渠道、模型或最大输出之前，不再自动重发同一批，以免每楼重复扣费；调整后会照常自动总结，也可以点「重试总结」立即再试。</span>
      <button class="bbs-btn bbs-btn-sm" type="button" :disabled="resummaryRunning || engineState.running" @click="doResummarize">重试总结</button>
    </div>

    <!-- 搜索框:点工具行放大镜才展开(选择模式下不显示,两态互斥)。搜全森林(含已压缩的深层节点) -->
    <div v-if="!selectMode && searchOpen && rootNodes.length" class="bbs-search">
      <Icon name="search" class="bbs-search-icon" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="bbs-input bbs-search-input"
        type="text"
        aria-label="搜索摘要内容、时间或楼层号"
        placeholder="搜索内容、时间或 #楼层号"
        @keydown.esc.stop="closeSearch"
      />
      <button class="bbs-search-clear" type="button" :title="searching ? '清空' : '收起搜索'" :aria-label="searching ? '清空' : '收起搜索'" @click="searching ? (searchQuery = '') : closeSearch()">
        <Icon name="close" />
      </button>
    </div>

    <p v-if="searching" class="bbs-result-note" role="status">找到 {{ searchNodes.length }} 条（含已合并进总结的摘要）</p>
    <p v-else-if="selectMode" class="bbs-result-note">翻页时勾选会保留，「全选」包括所有页。合并只能选相邻的条目；删除总结会连带删除它合并的摘要。</p>
    <p v-else-if="rootNodes.length" class="bbs-result-note">共 {{ rootNodes.length }} 条</p>
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
            <template v-if="r.kind === 'comp'">
              <span class="bbs-summary-badge">{{ levelLabel(r.level, r.imported) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">({{ rowRelative(r) }})</span>
              <span v-if="rowTime(r)" class="bbs-summary-time">{{ rowTime(r) }}</span>
            </template>
            <template v-else>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">{{ rowRelative(r) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowTime(r)" class="bbs-summary-dateline">{{ rowTime(r) }}</span>
              <span v-if="r.lite" class="bbs-summary-lite" title="批量补摘时与相邻楼层合并生成，只有摘要和时间，未记录状态">简要</span>
            </template>
            <span v-if="r.stale" class="bbs-summary-stale">待更新</span>
            <!-- 操作键:编辑对任何命中行开放(结构安全;叶子改完向量自动重 embed,总结不进向量库);
                 删除仅根行(删深层会级联删祖先总结链);选择模式无操作 -->
            <span v-if="!selectMode" class="bbs-summary-acts">
              <IconButton icon="edit" :label="r.imported ? '编辑导入的旧总结' : r.kind === 'comp' ? '编辑总结' : '编辑摘要'" @click="openEdit(r)" />
              <IconButton v-if="!r.isChild" icon="trash" tone="danger" :label="r.imported ? '删除导入的旧总结' : r.kind === 'comp' ? '删除总结（下层会重新显示）' : '删除摘要'" @click="onDelete(r)" />
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
    <EmptyState v-else-if="searching" icon="search" title="没有找到匹配的摘要" :text="`没有和「${searchQuery.trim()}」匹配的内容。请更换关键词，或输入 #楼层号。`">
      <button class="bbs-btn" type="button" @click="closeSearch">清除搜索</button>
    </EmptyState>
    <EmptyState
      v-else
      icon="summary"
      :title="editingBlocked ? '记忆处于只读保护' : '暂无摘要'"
      :text="editingBlocked ? '请先查看上方说明。这不表示聊天没有记忆，请勿用全部重新摘要或导入解除保护。' : emptyText"
    />

    <SummaryPager :page="activeWindow.page" :total="activeWindow.total" :size="SUMMARY_PAGE_SIZE" label="摘要" @update:page="changeSummaryPage" />

    <SummarySelectBar :sel="selection" :has-roots="rootNodes.length > 0" />

    <!-- 删除单条摘要/总结的确认 -->
    <ConfirmDialog
      v-if="!editingBlocked"
      :open="!!pendingDelete"
      :title="deleteRowCopy.title"
      confirm-text="删除"
      confirm-icon="trash"
      tone="danger"
      @update:open="v => { if (!v) pendingDelete = null; }"
      @confirm="confirmDeleteRow"
    >
      {{ deleteRowCopy.text }}
    </ConfirmDialog>

    <SummaryEditDialog ref="editDialog" />
    </fieldset>

    <SummaryFooter />
  </section>
</template>

<style scoped>
/* 阅读器：纸面、细线和文字层级，避免每个信息块都变成带框表单。 */
.bbs-summary-page {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 860px;
  min-height: 100%;
  margin: 0 auto;
  color: var(--bbs-ink);
  overflow-wrap: anywhere;
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
/* —— 立即总结按钮:摘要工具行的最后一项,尺寸与配色见下方工具行规则 —— */
.bbs-resummary-btn {
  flex: 0 0 auto;
}
.bbs-resummary-btn .bbs-spin {
  width: 12px;
  height: 12px;
}
.bbs-resummary-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}

/* —— 摘要区工具行:标题右侧「搜索 / 多选 / 立即总结」并排 —— */
.bbs-summary-heading {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.bbs-token-estimate {
  display: flex;
  flex-direction: column;
  flex-basis: 100%;
  gap: 1px;
  margin: 3px 0 0;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.bbs-token-total {
  color: var(--bbs-ink-soft);
  font-weight: 600;
}
.bbs-token-note {
  margin-top: 2px;
}
/* 总结暂停自动重试:沿用共享提示条,按钮另起一行 */
.bbs-resummary-hold {
  margin-top: 10px;
}
.bbs-resummary-hold .bbs-btn {
  align-self: flex-start;
  margin-top: 6px;
}
.bbs-summary-tools {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbs-summary-tools .bbs-btn-sm {
  gap: 6px;
}
/* 搜索切换键激活态:点亮强调色,呼应「正在搜索」 */
.bbs-summary-tools .bbs-btn.is-on {
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

/* —— 摘要列表 ——
   卡片外框与卡片里的题首、标签、正文、操作键、展开条都在 base.css(SummaryNode.vue、本页平铺列表、楼层面板共用);
   本页只写阅读式平铺的外框(下方「摘要列表」一节,:deep)和选择模式。 */

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

/* 展开开关(.bbs-expand-bar)、展开态左缘(.is-expanded)均在 base.css,供 SummaryNode.vue 共用。 */

/* 空状态画法在 base.css；这里只让它占满剩余高度。 */
.bbs-empty {
  flex: 1;
}

/* 摘要失败提示：沿用共享提示条。 */
.bbs-summary-failure { min-width:0; overflow-wrap:anywhere; }

/* 区块标题：本页 20px，比「局势与计划」的小节标题大一档；字体、字距与标题行在 base.css。 */
.bbs-title-sub { font-size:20px; }

/* 摘要列表：标题行、工具行、阅读式平铺的摘要条目。 */
.bbs-reading-head { display:flex; align-items:flex-end; flex-wrap:wrap; gap:12px; margin:8px 0 10px; }
.bbs-estimate-toggle { margin-top:0; padding:0 4px; min-height:32px; border:0; background:transparent; font-size:12px; color:var(--bbs-ink-muted); text-decoration:underline; text-underline-offset:3px; }
.bbs-summary-tools .bbs-btn { min-height:38px; height:auto; width:auto; padding:7px 12px; border:0; border-radius:8px; font-size:12px; background:var(--bbs-surface-2); color:var(--bbs-ink-soft); }
.bbs-summary-tools .bbs-btn:hover:where(:not(:disabled)) { color:var(--bbs-accent); background:var(--bbs-accent-soft); }
.bbs-summary-tools .bbs-resummary-btn { color:var(--bbs-accent); background:var(--bbs-accent-soft); }
.bbs-summary-tools .bbs-resummary-btn:disabled { color:var(--bbs-ink-soft); background:var(--bbs-surface-2); opacity:.55; }
.bbs-result-note { color:var(--bbs-ink-muted); font-size:12px; margin:12px 0 0; }
.bbs-summary-page :deep(.bbs-summary-card) { margin:0; padding:20px 0; border:0; border-bottom:1px solid var(--bbs-line); border-radius:0; background:transparent; box-shadow:none; gap:10px; }
.bbs-summary-page :deep(.bbs-summary-card.is-deep) { margin:14px 0 0; padding:18px 20px; background:var(--bbs-surface); border:1px solid var(--bbs-line); border-radius:12px; }
.bbs-summary-page :deep(.bbs-summary-card.is-child) { padding-left:17px; border-left:1px solid var(--bbs-line); margin-left:5px; }
.bbs-summary-page :deep(.bbs-summary-main) { min-width:0; flex:1; }
/* 平铺条目底色透明，选中时需在这里重新点亮。 */
.bbs-summary-list.is-selecting .bbs-summary-card.is-selected { background:var(--bbs-accent-soft); }

.bbs-summary-page :deep(button:focus-visible),.bbs-summary-page summary:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:3px; }

/* ============ 窄屏 ============ */
@media(max-width:640px) {
 .bbs-reading-head { display:block; }
 .bbs-summary-tools { margin-top:10px; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
 .bbs-summary-tools .bbs-btn { justify-content:center; padding:6px 3px; gap:4px; font-size:12px; white-space:nowrap; }
 .bbs-summary-page :deep(.bbs-summary-card.is-deep) { padding:16px; }
}
</style>
