<script setup lang="ts">
/**
 * 生活小档案、信息差列表里的一条：正文、标签行（主题或知情情况、时效），操作（actions 插槽）。
 * 桌面：操作在正文右侧。手机：正文占满一行，标签与操作共用第二行，不再单独多出一行按钮。
 * variant：pinned 置顶（左缘警告色）、archive 沉降或已结案（虚线、次要色正文）。
 */
defineProps<{
  text: string;
  /** 标签行文字（主题、知情情况）；不给时不显示 */
  tag?: string;
  /** 时效（故事内到期时间）；空时不显示 */
  until?: string;
  variant?: string;
}>();
</script>

<template>
  <article class="bbs-life" :class="variant ? 'is-' + variant : undefined">
    <div class="bbs-life-main">
      <p class="bbs-life-text">{{ text }}</p>
      <div v-if="tag != null || until" class="bbs-life-meta">
        <span v-if="tag != null" class="bbs-life-tag">{{ tag }}</span>
        <span v-if="until" class="bbs-life-until">至 {{ until }}</span>
      </div>
    </div>
    <span class="bbs-npc-acts"><slot name="actions" /></span>
  </article>
</template>

<style scoped>
.bbs-life { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; column-gap: 12px; padding: 13px 0 13px 12px; border-bottom: 1px solid var(--bbs-line); border-left: 2px solid var(--bbs-line); }
.bbs-life:last-child { border-bottom: 0; }
.bbs-life.is-pinned { border-left-color: var(--bbs-warning); }
.bbs-life.is-archive { border-left-style: dashed; }
.bbs-life-main { min-width: 0; }
.bbs-life-text { margin: 0; font-size: 13px; line-height: 1.8; color: var(--bbs-ink); overflow-wrap: anywhere; }
.bbs-life.is-archive .bbs-life-text { color: var(--bbs-ink-muted); }
.bbs-life-meta { display: flex; flex-wrap: wrap; gap: 5px 9px; margin-top: 6px; min-width: 0; }
.bbs-life-tag, .bbs-life-until { max-width: 100%; font-size: 11px; line-height: 1.6; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-life-until { color: var(--bbs-warning); }
.bbs-npc-acts { display: inline-flex; align-items: center; gap: 2px; }
@media (max-width: 640px) {
  /* 正文独占第一行；标签行与操作键共用第二行（没有标签时操作键单独靠右）。 */
  .bbs-life { row-gap: 2px; }
  .bbs-life-main { display: contents; }
  .bbs-life-text { grid-column: 1 / -1; }
  .bbs-life-meta { grid-column: 1; align-self: center; margin-top: 0; }
  .bbs-npc-acts { grid-column: 2; grid-row: 2; justify-self: end; }
}
</style>
