<script setup lang="ts">
/**
 * 统计行：数字在前、标签在后，行尾可带说明（note）或操作（aside 插槽）。接口说明见 polish-20261009/ui-components-api.md。
 * 样式在 base.css 的 .bbs-stat-row。
 */
defineProps<{
  items: { value: string | number; label: string; tone?: 'default' | 'accent' | 'warning' }[];
  /** 整行的读屏名称 */
  label?: string;
  /** 行尾说明，中性色小字 */
  note?: string;
}>();
</script>

<template>
  <div class="bbs-stat-row" :role="label ? 'group' : undefined" :aria-label="label">
    <span v-for="(it, i) in items" :key="i" class="bbs-stat"><strong class="bbs-stat-value" :class="it.tone && it.tone !== 'default' ? 'is-' + it.tone : undefined">{{ it.value }}</strong>{{ it.label }}</span>
    <span v-if="note" class="bbs-stat-note">{{ note }}</span>
    <span v-if="$slots.aside" class="bbs-stat-aside"><slot name="aside" /></span>
  </div>
</template>
