<script setup lang="ts">
import Icon from './Icon.vue';
// 标题与默认入口统一使用项目书签图标，不依赖外部图片。
withDefaults(defineProps<{ size?: number; decorative?: boolean }>(), { size: 44, decorative: true });
</script>
<template>
  <span class="prism-brand-mark" :style="{ width: `${size}px`, height: `${size}px` }"
    :role="decorative ? undefined : 'img'" :aria-hidden="decorative ? true : undefined"
    :aria-label="decorative ? undefined : '棱镜宝书'">
    <Icon name="bookmark" :size="Math.round(size * 0.72)" />
  </span>
</template>
<style scoped>
.prism-brand-mark { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: var(--bbs-accent, currentColor); user-select: none; pointer-events: none; }
</style>