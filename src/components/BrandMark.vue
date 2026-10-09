<script setup lang="ts">
// 标题栏和默认悬浮球用的小狐狸标志。内联 SVG，不依赖外部图片；颜色固定，换主题也保持狐狸本色。
withDefaults(defineProps<{ size?: number; decorative?: boolean }>(), { size: 44, decorative: true });
</script>
<template>
  <span class="prism-brand-mark" :style="{ width: `${size}px`, height: `${size}px` }"
    :role="decorative ? undefined : 'img'" :aria-hidden="decorative ? true : undefined"
    :aria-label="decorative ? undefined : '棱镜宝书'">
    <svg viewBox="0 0 64 64" :width="size" :height="size" fill="none" focusable="false">
      <path class="fox-head" d="M32 17C30 17 29.2 17.3 28 18L12 5.5Q9 4 9 7L11.6 24C8.5 27.5 6 32 4 38C10 46 22 54 32 58C42 54 54 46 60 38C58 32 55.5 27.5 52.4 24L55 7Q55 4 52 5.5L36 18C34.8 17.3 34 17 32 17Z" />
      <path class="fox-ear" d="M14.2 21.5L12.6 10.5L23.5 18.6C19.6 19.1 16.6 20.1 14.2 21.5Z" />
      <path class="fox-ear" d="M49.8 21.5L51.4 10.5L40.5 18.6C44.4 19.1 47.4 20.1 49.8 21.5Z" />
      <path class="fox-muzzle" d="M4 38C10 38 15 36 20 37C25 38 29 41 32 45C35 41 39 38 44 37C49 36 54 38 60 38C54 46 42 54 32 58C22 54 10 46 4 38Z" />
      <path class="fox-line" d="M32 17C30 17 29.2 17.3 28 18L12 5.5Q9 4 9 7L11.6 24C8.5 27.5 6 32 4 38C10 46 22 54 32 58C42 54 54 46 60 38C58 32 55.5 27.5 52.4 24L55 7Q55 4 52 5.5L36 18C34.8 17.3 34 17 32 17Z" />
      <ellipse class="fox-dark" cx="23" cy="31.5" rx="2.7" ry="3.3" />
      <ellipse class="fox-dark" cx="41" cy="31.5" rx="2.7" ry="3.3" />
      <circle class="fox-glint" cx="24" cy="30.3" r="0.95" />
      <circle class="fox-glint" cx="42" cy="30.3" r="0.95" />
      <path class="fox-dark" d="M28.6 50.2Q32 48.4 35.4 50.2Q33.6 53.6 32 53.8Q30.4 53.6 28.6 50.2Z" />
    </svg>
  </span>
</template>
<style scoped>
.prism-brand-mark { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; user-select: none; pointer-events: none; }
.prism-brand-mark svg { display: block; overflow: visible; }
.fox-head { fill: #E8823C; }
.fox-ear { fill: #3A2218; }
.fox-muzzle { fill: #FFF6EC; }
.fox-line { stroke: #B9581F; stroke-width: 2.4; stroke-linejoin: round; }
.fox-dark { fill: #2A1A14; }
.fox-glint { fill: #FFFFFF; }
</style>
