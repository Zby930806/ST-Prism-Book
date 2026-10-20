/**
 * 摘要列表的多选：进出多选、勾选、全选、相邻性约束，以及「合并总结」「删除所选」两个操作与确认框状态。
 * 由 index.vue 创建，多选操作条（SummarySelectBar）与卡片（经 SUMMARY_CTX）共用。
 */
import { deleteSummarySubtrees } from '@/memory/apply';
import { engineState, summarizeSelected, syncHiddenNow } from '@/memory/engine';
import { refreshInjection, type ViewNode } from '@/memory/inject';
import { toast } from '@/st/toast';
import { computed, ref, type ComputedRef } from 'vue';

export function useSummarySelection(opts: {
  /** 根节点（倒序：楼层越靠后越在上面） */
  rootNodes: ComputedRef<ViewNode[]>;
  byId: ComputedRef<Map<string, ViewNode>>;
  nodeFloors: (n: ViewNode, map: Map<string, ViewNode>) => [number, number];
  allowMemoryEdit: () => boolean;
  /** 进入多选时调用（列表据此收起所有展开，只操作根） */
  onEnter: () => void;
}) {
  const { rootNodes, byId, nodeFloors, allowMemoryEdit } = opts;
  const selectMode = ref(false);
  const selectedIds = ref<Set<string>>(new Set());

  function enterSelectMode() {
    if (!allowMemoryEdit()) return;
    selectMode.value = true;
    selectedIds.value = new Set();
    opts.onEnter();
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

  /** 根是否已全部勾选（驱动「全选 / 取消全选」文案） */
  const allSelected = computed(() => {
    const roots = rootNodes.value;
    return roots.length > 0 && roots.every(n => selectedIds.value.has(n.id));
  });
  /** 全选 / 取消全选切换：全选时写入全部根 id；已全选则清空。 */
  function toggleSelectAll() {
    if (allSelected.value) {
      selectedIds.value = new Set();
    } else {
      selectedIds.value = new Set(rootNodes.value.map(n => n.id));
    }
  }

  /** 选中项在根序列（倒序）里的位置索引，升序排列 */
  const selectedRootIndexes = computed<number[]>(() => {
    const roots = rootNodes.value;
    const idxs: number[] = [];
    roots.forEach((n, i) => { if (selectedIds.value.has(n.id)) idxs.push(i); });
    return idxs;
  });
  /** 是否可合并：选中 ≥2 且在根序列里连续（无跳选） */
  const canMerge = computed(() => {
    const idxs = selectedRootIndexes.value;
    if (idxs.length < 2) return false;
    for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) return false;
    return true;
  });
  /** 选中项覆盖的楼层范围与将生成的层级（供操作条展示） */
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
    // 按根序列升序（即楼层旧→新）传给引擎；引擎内部还会再排一次
    const idxs = [...selectedRootIndexes.value].sort((a, b) => a - b);
    const ids = idxs.map(i => rootNodes.value[i].id);
    merging.value = true;
    try {
      const res = await summarizeSelected(ids);
      if (res.made > 0) {
        exitSelectMode();
      } else if (res.error) {
        // 失败时保留选择。早退分支（未生效/正忙/不连续等）不走引擎的 try/catch，
        // 不会写 engineState.lastError，故这里主动弹 toast，避免「无事发生、无报错」。
        toast(res.error, 'warning');
      }
    } finally {
      merging.value = false;
    }
  }

  /** 删除统计按整棵选中子树计算：选中总结时，其收纳的下层摘要也属于删除范围。 */
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

  /** 只读保护开启或切换聊天时：关掉两个确认框并退出多选。 */
  function closeAll() {
    mergeConfirmOpen.value = false;
    deleteConfirmOpen.value = false;
    exitSelectMode();
  }

  return {
    selectMode, selectedIds, enterSelectMode, exitSelectMode, toggleSelect,
    allSelected, toggleSelectAll, canMerge, selectionSummary, selectionDeleteSummary,
    mergeConfirmOpen, merging, openMergeConfirm, runMerge,
    deleteConfirmOpen, deleting, openDeleteConfirm, runDeleteSelected,
    closeAll,
  };
}

export type SummarySelection = ReturnType<typeof useSummarySelection>;
