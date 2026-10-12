<script setup lang="ts">
// 标题栏和默认悬浮球用的小狐狸标志：PrismFox 的小狐狸（坐姿），取自「双人成行」预设脚本里的悬浮宠物。
// 图片以 data URI 内嵌在 foxSprite.ts，不依赖单独的图片文件；颜色固定，换主题也保持本色。
import { FOX_SIT } from './foxSprite';

withDefaults(defineProps<{ size?: number; decorative?: boolean }>(), { size: 44, decorative: true });
</script>
<template>
  <span class="prism-brand-mark" :style="{ width: `${size}px`, height: `${size}px` }"
    :role="decorative ? undefined : 'img'" :aria-hidden="decorative ? true : undefined"
    :aria-label="decorative ? undefined : '棱镜宝书'">
    <img :src="FOX_SIT" alt="" draggable="false" />
  </span>
</template>
<style scoped>
.prism-brand-mark { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; user-select: none; pointer-events: none; }
.prism-brand-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
