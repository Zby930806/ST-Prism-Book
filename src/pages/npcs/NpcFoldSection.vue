<script setup lang="ts">
/**
 * 角色页的可折叠区块（生活小档案、信息差）：共享组件 FoldSection 加上本页的区块外框、标题字号与投放说明。
 * 有条目时标题行带条目数与行尾箭头，内容区收展、收起时 inert；没有条目时整块缩成一行：标题 +「暂无」+ 一句说明 + 操作键。
 * 仅本地记录等提醒用警告色，有无条目都显示。有条目时内容区顶部显示 note（如投放规则），其下为列表。
 * 折叠状态由父组件保存（各自的 localStorage 键），这里只发出 toggle。
 */
import FoldSection from '@/components/FoldSection.vue';

const props = defineProps<{
  title: string;
  count: number;
  /** 有条目时才可折叠 */
  foldable: boolean;
  collapsed: boolean;
  /** 仅本地记录等提醒（警告色）；优先于 emptyHint 显示 */
  warning?: string;
  /** 没有条目时标题行里的一句说明 */
  emptyHint?: string;
  /** 有条目时内容区顶部的说明 */
  note?: string;
  sectionClass?: string;
}>();
const emit = defineEmits<{ (e: 'toggle'): void }>();
</script>

<template>
  <FoldSection
    class="bbs-protagonist-section bbs-life-section"
    :class="sectionClass"
    :title="title"
    :count="count"
    :foldable="foldable"
    :open="!props.collapsed"
    :warning="warning"
    :empty-hint="emptyHint"
    @update:open="emit('toggle')"
  >
    <template #title><h2 class="bbs-life-title">{{ title }}</h2></template>
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    <p v-if="note" class="bbs-field-hint">{{ note }}</p>
    <slot />
  </FoldSection>
</template>

<style scoped>
.bbs-protagonist-section { margin-bottom: 26px; }
.bbs-life-section { padding-bottom: 20px; border-bottom: 1px solid var(--bbs-line); }
.bbs-life-section.is-empty { margin-bottom: 18px; padding-bottom: 12px; }
.bbs-life-title { margin: 0; font-size: 14px; font-weight: 650; color: var(--bbs-ink); }
</style>
