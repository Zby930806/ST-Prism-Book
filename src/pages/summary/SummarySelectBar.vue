<script setup lang="ts">
/** 多选操作条：已选统计 + 全选 / 删除所选 / 合并总结，以及「合并总结」「删除所选」两个确认框。sticky 贴在页面底部。 */
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import { engineState } from '@/memory/engine';
import { levelLabel } from './labels';
import { useSummaryPage } from './pageCtx';
import type { SummarySelection } from './selection';

const props = defineProps<{ sel: SummarySelection; hasRoots: boolean }>();
const { editingBlocked } = useSummaryPage();
const {
  selectMode, allSelected, toggleSelectAll, canMerge, selectionSummary, selectionDeleteSummary,
  mergeConfirmOpen, merging, openMergeConfirm, runMerge,
  deleteConfirmOpen, deleting, openDeleteConfirm, runDeleteSelected,
} = props.sel;
</script>

<template>
  <!-- 选择模式底部操作条:显示已选统计 + 全选/删除/合并。sticky 在页面底部 -->
  <div v-if="selectMode" class="bbs-select-bar" role="group" aria-label="已选摘要操作">
    <span class="bbs-select-info">
      <template v-if="selectionSummary.count">
        已选 {{ selectionSummary.count }} 条
        <template v-if="selectionSummary.floorLo >= 0">
          · 覆盖 {{ selectionSummary.floorLo === selectionSummary.floorHi ? `#${selectionSummary.floorLo}` : `#${selectionSummary.floorLo} – #${selectionSummary.floorHi}` }}
        </template>
        · 合并为 {{ levelLabel(selectionSummary.level) }}
      </template>
      <template v-else>勾选相邻的几条来合并</template>
    </span>
    <span v-if="selectionSummary.count >= 2 && !canMerge" class="bbs-select-warn">要选相邻的条目</span>
    <button
      class="bbs-btn bbs-btn-sm"
      type="button"
      :disabled="!hasRoots || deleting"
      :title="allSelected ? '取消全选' : '全选所有条目'" :aria-label="allSelected ? '取消全选' : '全选所有条目'"
      @click="toggleSelectAll"
    >
      {{ allSelected ? '取消全选' : '全选' }}
    </button>
    <button
      class="bbs-btn bbs-btn-sm bbs-btn-danger"
      type="button"
      :disabled="!selectionSummary.count || deleting || merging || engineState.running"
      title="删除选中的条目，连同它们合并的摘要"
      @click="openDeleteConfirm"
    >
      <span v-if="deleting" class="bbs-spin"></span>
      <Icon v-else name="trash" />
      删除所选
    </button>
    <button
      class="bbs-btn bbs-btn-sm bbs-btn-primary"
      type="button"
      :disabled="!canMerge || merging || deleting || engineState.running"
      title="把选中的相邻条目合并成上一层总结"
      @click="openMergeConfirm"
    >
      <span v-if="merging" class="bbs-spin"></span>
      <Icon v-else name="plans" />
      合并总结
    </button>
  </div>

  <!-- 合并确认弹窗 -->
  <ConfirmDialog
    v-if="!editingBlocked"
    v-model:open="mergeConfirmOpen"
    title="合并总结"
    confirmText="合并"
    @confirm="runMerge"
  >
    把选中的 {{ selectionSummary.count }} 条合并成一条{{ levelLabel(selectionSummary.level) }}（不受自动总结的数量限制）。
    原条目会收入新总结，不会删除；删除新总结即可还原。是否继续？
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
    将永久删除选中的 {{ selectionSummary.count }} 项（共 {{ selectionDeleteSummary.leaves }} 条逐楼摘要、{{ selectionDeleteSummary.summaries }} 条总结）。
    删除总结会连带删除它合并的摘要；逐楼摘要带来的物品、计划、时间地点等会按剩下的摘要重新计算，原楼层保持隐藏。
    <template v-if="selectionDeleteSummary.imported">导入的旧总结覆盖的楼层会重新显示。</template>
    删除后无法撤销，继续吗？
  </ConfirmDialog>
</template>

<style scoped>
/* —— 选择模式底部操作条:sticky 贴底 —— */
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
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-select-info {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.7;
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
.bbs-select-bar .bbs-spin {
  width: 12px;
  height: 12px;
}
@media (max-width: 640px) {
  .bbs-select-bar { gap: 8px; padding: 12px; }
  .bbs-select-info, .bbs-select-warn { flex-basis: 100%; }
}
</style>
