<script setup lang="ts">
/**
 * 空状态：图标、标题、说明，可在默认插槽放操作按钮。接口说明见 polish-20261009/ui-components-api.md。
 * compact：单行紧凑版，用于页面中次要区块的「暂无」，不占大块空白。
 * 说明含强调或链接时用 text 插槽代替 text 参数。
 * 样式在 base.css 的 .bbs-empty（记录类页面另见 .bbs-ledger .bbs-empty）。
 */
import Icon from '@/components/Icon.vue';

defineProps<{
  icon: string;
  title: string;
  text?: string;
  compact?: boolean;
}>();
</script>

<template>
  <div class="bbs-empty" :class="{ 'is-compact': compact }">
    <span class="bbs-empty-icon" aria-hidden="true"><Icon :name="icon" /></span>
    <div v-if="compact" class="bbs-empty-body">
      <h3>{{ title }}</h3>
      <p v-if="text || $slots.text"><slot name="text">{{ text }}</slot></p>
    </div>
    <template v-else>
      <h3>{{ title }}</h3>
      <p v-if="text || $slots.text"><slot name="text">{{ text }}</slot></p>
    </template>
    <slot />
  </div>
</template>
