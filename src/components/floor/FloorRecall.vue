<script setup lang="ts">
/**
 * 生成本楼前的召回:来源楼层、故事时间、注入全文还是摘要、内容预览。
 * 从 FloorPanel.vue 拆出,行为不变。记录写入见 memory/vector/floorRecall.ts,显示文案见 recallView.ts。
 */
import FloorSection from './FloorSection.vue';
import RecallList from '@/components/RecallList.vue';
import type { FloorRecallView } from '@/memory/vector/recallView';

defineProps<{ recall: FloorRecallView }>();
</script>

<template>
  <FloorSection
    class="bbs-fp-recall"
    icon="bookmark"
    :title="recall.items.length ? `召回 · ${recall.items.length} 段` : '召回'"
    :note="recall.statusText"
    :note-tone="recall.phase === 'failed' ? 'danger' : undefined"
  >
    <RecallList v-if="recall.items.length" :items="recall.items" />
  </FloorSection>
</template>

<style scoped>
/* 与变动分区同一层级:列表条目用抬起面(surface,与变动条一致),徽标用次级面(surface-2) */
.bbs-fp-recall {
  margin-top: 14px;
  --bbs-recall-item-bg: var(--bbs-surface);
  --bbs-recall-badge-bg: var(--bbs-surface-2);
}
</style>
