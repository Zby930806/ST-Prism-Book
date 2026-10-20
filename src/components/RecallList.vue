<script setup lang="ts">
/**
 * 召回段落列表:快捷回复栏的召回速览和楼层面板共用。
 * 条目底色可由外层用 --bbs-recall-item-bg、--bbs-recall-badge-bg 调整(楼层面板里的卡片层级不同)。
 */
import type { RecallPeekItem } from '@/memory/vector/recallView';

defineProps<{ items: RecallPeekItem[] }>();
</script>

<template>
  <ol class="bbs-recall-list">
    <li v-for="it in items" :key="it.key">
      <div class="bbs-recall-list-meta">
        <span class="bbs-recall-list-source">{{ it.source }}</span>
        <span v-if="it.storyTime">{{ it.storyTime }}</span>
        <span class="bbs-recall-list-tier" :class="`is-${it.tier}`">{{ it.tierLabel }}</span>
      </div>
      <p class="bbs-recall-list-preview">{{ it.preview }}</p>
    </li>
  </ol>
</template>

<style scoped>
.bbs-recall-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-recall-list li {
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-recall-item-bg, var(--bbs-bg));
  border: 1px solid var(--bbs-line);
}
.bbs-recall-list-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-muted);
}
.bbs-recall-list-source {
  font-weight: 600;
  color: var(--bbs-accent);
}
.bbs-recall-list-tier {
  margin-left: auto;
  padding: 0 6px;
  border-radius: var(--bbs-radius-sm);
  font-size: var(--bbs-fs-badge);
  font-weight: 600;
  line-height: 18px;
  color: var(--bbs-ink-soft);
  background: var(--bbs-recall-badge-bg, var(--bbs-surface-2));
}
.bbs-recall-list-tier.is-full {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-recall-list-preview {
  margin: 0;
  font-size: var(--bbs-fs-sm);
  line-height: 1.65;
  color: var(--bbs-ink);
  overflow-wrap: anywhere;
}
</style>
