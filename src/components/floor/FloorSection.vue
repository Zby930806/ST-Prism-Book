<script setup lang="ts">
/**
 * 楼层面板抽屉里的一个分区:图标 + 标题 + 分隔线,可带一行说明,内容放默认插槽。
 * 变动分组(DeltaGroups)、记录冲突(FloorConflicts)、召回(FloorRecall)共用,三处标题与层级一致。
 * 分区本身不再是一张卡片(避免「卡中卡中卡」),只有条目保留一层底色。
 */
import Icon from '@/components/Icon.vue';

defineProps<{
  icon: string;
  title: string;
  /** warning:标题图标用警告色(记录冲突) */
  tone?: 'warning';
  /** 标题下的一行说明 */
  note?: string;
  /** danger:说明用危险色(召回失败) */
  noteTone?: 'danger';
}>();
</script>

<template>
  <section class="bbs-fp-group" :class="tone ? `is-${tone}` : undefined">
    <span class="bbs-fp-gtitle"><Icon :name="icon" class="bbs-fp-gicon" /><span class="bbs-fp-gname">{{ title }}</span></span>
    <p v-if="note" class="bbs-fp-recall-status" :class="{ 'is-failed': noteTone === 'danger' }">{{ note }}</p>
    <slot />
  </section>
</template>

<style scoped>
.bbs-fp-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* 分区标题:描边图标 + 名称 + 延伸到行尾的细线 */
.bbs-fp-gtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--bbs-fs-meta);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bbs-ink-soft);
}
.bbs-fp-gtitle::after {
  content: '';
  flex: 1 1 auto;
  min-width: 12px;
  height: 1px;
  margin-left: 4px;
  background: var(--bbs-line);
}
.bbs-fp-gname {
  min-width: 0;
  overflow-wrap: anywhere;
}
.bbs-fp-gicon {
  color: var(--bbs-accent);
  font-size: 15px;
}
.bbs-fp-group.is-warning .bbs-fp-gicon {
  color: var(--bbs-warning);
}
.bbs-fp-recall-status {
  margin: 0;
  font-size: var(--bbs-fs-meta);
  line-height: 1.6;
  color: var(--bbs-ink-soft);
}
.bbs-fp-recall-status.is-failed {
  color: var(--bbs-danger);
}
</style>
