<script setup lang="ts">
/**
 * 摘要页的整行折叠入口（「当前局势与计划」「创作规划」）：图标、标题（20px，与「摘要与总结」同级）、一行说明、右侧箭头。
 * 展开后的内容放默认插槽；两条相邻时共用一条分隔线。
 */
import Icon from '@/components/Icon.vue';

defineProps<{ icon: string; title: string; line: string }>();
</script>

<template>
  <details class="bbs-reader-context">
    <summary><span class="bbs-context-icon"><Icon :name="icon" /></span><span class="bbs-context-title">{{ title }}<small>{{ line }}</small></span><Icon name="chevron" class="bbs-context-chevron" /></summary>
    <div class="bbs-reader-context-body"><slot /></div>
  </details>
</template>

<style scoped>
.bbs-reader-context { margin:6px 0 20px; border-top:1px solid var(--bbs-line); border-bottom:1px solid var(--bbs-line); }
.bbs-reader-context > summary { display:flex; align-items:center; gap:12px; min-height:56px; padding:12px 0; cursor:pointer; list-style:none; font-size:14px; font-weight:600; color:var(--bbs-ink); }
.bbs-reader-context summary::-webkit-details-marker { display:none; }
.bbs-reader-context > summary:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:3px; }
.bbs-reader-context > summary > span:nth-child(2) { min-width:0; flex:1; }
.bbs-reader-context > summary small { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:3px; font-size:12px; font-weight:400; color:var(--bbs-ink-muted); }
.bbs-reader-context > summary:hover .bbs-context-chevron { color:var(--bbs-accent); }
.bbs-context-icon { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:10px; background:var(--bbs-accent-soft); font-size:17px; color:var(--bbs-accent); }
.bbs-context-chevron { color:var(--bbs-ink-muted); transform:rotate(-90deg); transition:transform var(--bbs-dur) var(--bbs-ease); }
.bbs-reader-context[open] > summary .bbs-context-chevron { transform:rotate(0); }
.bbs-reader-context-body { padding:8px 0 22px; }
/* 两条折叠行上下相接，共用一条分隔线。 */
.bbs-reader-context + .bbs-reader-context { margin-top:-20px; border-top:0; }
/* 标题与「摘要与总结」同级。 */
.bbs-context-title { min-width:0; flex:1; font:600 20px/1.5 var(--bbs-font-reading); letter-spacing:.04em; }
.bbs-context-title small { font-family:var(--bbs-font-sans); letter-spacing:0; }
</style>
