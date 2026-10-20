<script setup lang="ts">
/**
 * 批量补摘确认弹窗：待补摘较多时可选「较早楼层合并摘要」，按当前数字显示请求次数。
 * 由概览的「补摘」打开时补全部；由「未摘要楼层」里的一段打开时只补这一段。
 */
import ModalShell from '@/components/ModalShell.vue';
import SegmentedControl from '@/components/SegmentedControl.vue';
import { computed } from 'vue';
import { useSummaryPage } from './pageCtx';

const BATCH_MODE_OPTIONS: { value: 'lite' | 'full'; label: string }[] = [
  { value: 'lite', label: '较早楼层合并摘要' },
  { value: 'full', label: '全部逐层摘要' },
];

const page = useSummaryPage();
const { editingBlocked } = page;
const { batchConfirmOpen, batchScope, batchFloors, batchCanMerge, batchMode, batchRecentInput, batchGroupInput, batchLiteText, runBatchBackfill } = page.batch;
const scopeLabel = computed(() => {
  const floors = batchFloors.value;
  if (!batchScope.value || !floors.length) return '';
  return floors.length > 1 ? `#${floors[0]}–#${floors[floors.length - 1]}` : `#${floors[0]}`;
});
</script>

<template>
  <ModalShell v-if="!editingBlocked" :open="batchConfirmOpen" :title="scopeLabel ? '补摘这一段' : '批量补摘'" class="bbs-batch-modal" @close="batchConfirmOpen = false">
    <p v-if="scopeLabel" class="bbs-field-hint bbs-batch-intro">补摘 {{ scopeLabel }} 这一段的 {{ batchFloors.length }} 层，按楼层顺序处理。可中途取消，在当前一步完成后停止。</p>
    <p v-else class="bbs-field-hint bbs-batch-intro">共有 {{ batchFloors.length }} 层楼没有摘要，按楼层顺序处理。可中途取消，在当前一步完成后停止。</p>
    <template v-if="batchCanMerge">
      <SegmentedControl v-model="batchMode" class="bbs-batch-toggle" :options="BATCH_MODE_OPTIONS" label="补摘方式" block />
      <template v-if="batchMode === 'lite'">
        <p class="bbs-field-hint bbs-batch-plan" role="status">{{ batchLiteText }}</p>
        <div class="bbs-batch-params">
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">逐层摘要的最近楼层数</span>
            <input v-model.number="batchRecentInput" class="bbs-input" type="number" min="0" step="1" />
          </label>
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">每次合并的楼层数（1–30）</span>
            <input v-model.number="batchGroupInput" class="bbs-input" type="number" min="1" max="30" step="1" />
          </label>
        </div>
        <p class="bbs-field-hint bbs-batch-warning">合并的楼层只生成摘要，不记录人物、物品、计划等状态；状态从逐层摘要的楼层开始记录。</p>
      </template>
      <p v-else class="bbs-field-hint bbs-batch-plan">每层请求一次 AI，记录摘要和人物、物品、计划等状态，共 {{ batchFloors.length }} 次请求。</p>
    </template>
    <p v-else class="bbs-field-hint bbs-batch-plan">按楼层顺序逐层生成摘要，并更新人物、物品、计划等状态，每层请求一次 AI。</p>
    <template #footer>
      <button class="bbs-btn" type="button" @click="batchConfirmOpen = false">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="runBatchBackfill">开始</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 批量补摘确认弹窗:方式切换、计划说明、两个数字并排 */
.bbs-batch-intro {
  margin-bottom: 12px;
}
.bbs-batch-toggle {
  margin-bottom: 10px;
}
.bbs-batch-plan {
  margin-bottom: 12px;
  color: var(--bbs-ink);
}
.bbs-batch-params {
  display: flex;
  gap: 10px;
}
.bbs-batch-params .bbs-modal-field {
  flex: 1 1 0;
  min-width: 0;
}
.bbs-batch-warning {
  margin-bottom: 14px;
  color: var(--bbs-warning);
}
@media (max-width: 640px) {
  .bbs-batch-params { flex-direction: column; }
}
</style>
