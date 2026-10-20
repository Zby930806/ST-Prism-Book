<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 可选副标题：标题下方一行次要色小字（如端点的当前模型），收起时也显示 */
    meta?: string;
    /** 初始是否展开 */
    open?: boolean;
  }>(),
  { open: true },
);

const expanded = ref(props.open);

// 用 grid-template-rows 0fr<->1fr 做高度过渡,无需测量 scrollHeight,内容自适应。
</script>

<template>
  <section class="bbs-collapsible" :class="{ 'is-open': expanded }">
    <button class="bbs-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <!-- 有副标题时标题与副标题上下两行；没有时结构与原来相同 -->
      <span v-if="meta" class="bbs-collapsible-heading">
        <span class="bbs-collapsible-title">{{ title }}</span>
        <span class="bbs-collapsible-meta">{{ meta }}</span>
      </span>
      <span v-else class="bbs-collapsible-title">{{ title }}</span>
      <Icon name="chevron" class="bbs-collapsible-chevron" />
    </button>
    <div class="bbs-collapsible-outer" :inert="!expanded" :aria-hidden="!expanded">
      <div class="bbs-collapsible-inner">
        <div class="bbs-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbs-collapsible {
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden;
}

.bbs-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font-family: var(--bbs-font-sans);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible-head:hover {
  background: var(--bbs-surface-2);
}
.bbs-collapsible-head:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: -2px;
}
/* 副标题（meta）：标题下方一行次要色小字，长文字换行不截断 */
.bbs-collapsible-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin-right: 12px;
}
.bbs-collapsible-meta {
  font-size: var(--bbs-fs-meta);
  font-weight: 400;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
  overflow-wrap: anywhere;
}

.bbs-collapsible-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
/* 用直接子代 > 限定:嵌套 Collapsible 时,外层 .is-open 不得波及内层的 outer/chevron,
   否则内层会被外层钉死在展开态、永远收不起来。 */
.bbs-collapsible.is-open > .bbs-collapsible-head .bbs-collapsible-chevron {
  transform: rotate(180deg);
}

/* 高度过渡:grid 0fr -> 1fr */
.bbs-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible.is-open > .bbs-collapsible-outer {
  grid-template-rows: 1fr;
}
.bbs-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.bbs-collapsible-body {
  padding: 14px 16px;
  border-top: 1px solid var(--bbs-line);
}

/* 移动端:折叠区标题略小一号,与窄屏整体节奏更协调 */
@media (max-width: 640px) {
  .bbs-collapsible-head {
    font-size: 13px;
  }
}
</style>
