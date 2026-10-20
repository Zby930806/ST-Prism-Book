<script setup lang="ts">
/**
 * 行式折叠区：标题行（标题、条目数、行尾箭头）+ 右侧操作键 + 可收展的内容区。
 * 摘要页「计划 / 悬念」与角色页「生活小档案 / 信息差」共用（审查 V-04 的统一画法）。
 * - 可折叠时：从标题到箭头整片是同一个按钮（最小高 44px），点击发出 update:open；箭头收起朝下、展开朝上。
 * - 不可折叠（默认 count 为 0）时：标题 +「暂无」+ 说明，不显示箭头和内容区。
 *   说明默认与标题同行，放不下或窄屏（≤480px）换到下一行；hintBelow 时总在下一行。
 * - 内容区用 grid 0fr/1fr 收展，高度随内容；收起时 inert，Tab 与读屏都不进入。
 * 标题元素可用 title 插槽换成页面自己的标题（插槽内容沿用页面的 scoped 样式）；操作键放 actions 插槽。
 */
import Icon from '@/components/Icon.vue';
import { computed, useId } from 'vue';

const props = withDefaults(defineProps<{
  title: string;
  /** 条目数，显示在标题旁 */
  count: number;
  /** 是否展开（只在可折叠时起作用；展开状态由页面保存） */
  open: boolean;
  /** 不可折叠（没有条目）时标题行里的说明 */
  emptyHint?: string;
  /** 提醒（警告色，如「仅供棱镜宝书记录」）：有无条目都显示，优先于 emptyHint；可折叠时排在标题行下方 */
  warning?: string;
  /** 是否可折叠，默认 count > 0（如信息差只有已结案条目时也要可折叠） */
  foldable?: boolean;
  /** 说明总排在标题行下方（窄栏布局用） */
  hintBelow?: boolean;
}>(), {
  // 布尔参数不传时 Vue 会当作 false；显式给 undefined 默认值，才能按 count 推断是否可折叠
  foldable: undefined,
});
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const isFoldable = computed(() => props.foldable ?? props.count > 0);
const hint = computed(() => props.warning || (isFoldable.value ? '' : props.emptyHint || ''));
const bodyId = useId();
</script>

<template>
  <div class="bbs-fold" :class="{ 'is-empty': !isFoldable }">
    <div class="bbs-fold-row">
      <button
        v-if="isFoldable"
        class="bbs-fold-head"
        type="button"
        :aria-expanded="open"
        :aria-controls="bodyId"
        :title="(open ? '收起' : '展开') + title"
        @click="emit('update:open', !open)"
      >
        <slot name="title"><h2 class="bbs-fold-title">{{ title }}</h2></slot>
        <span class="bbs-fold-count">{{ count }}</span>
        <Icon name="chevron" class="bbs-fold-caret" :class="{ 'is-open': open }" />
      </button>
      <div v-else class="bbs-fold-head is-static">
        <slot name="title"><h2 class="bbs-fold-title">{{ title }}</h2></slot>
        <span class="bbs-fold-none">暂无</span>
      </div>
      <span v-if="hint" class="bbs-fold-hint" :class="{ 'is-warning': !!warning, 'is-below': hintBelow || isFoldable }">{{ hint }}</span>
      <div v-if="$slots.actions" class="bbs-fold-actions"><slot name="actions" /></div>
    </div>
    <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height;reduced-motion 下瞬切 -->
    <div v-if="isFoldable" :id="bodyId" class="bbs-fold-wrap" :class="{ 'is-collapsed': !open }" :inert="!open" :aria-hidden="!open">
      <div class="bbs-fold-inner"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.bbs-fold { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bbs-fold-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }

/* 标题按钮：标题、条目数到行尾箭头整片可点；无框透明 */
.bbs-fold-head {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
/* 没有条目：普通标题行，与操作键同高 */
.bbs-fold-head.is-static {
  flex: 0 1 auto;
  min-height: var(--bbs-icon-btn);
  cursor: default;
}
.bbs-fold-title { margin: 0; font-size: 14px; font-weight: 650; color: var(--bbs-ink); }

/* 条目数：中性小标，收起时点明藏了多少条 */
.bbs-fold-count {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--bbs-radius-xs);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-size: var(--bbs-fs-badge);
  font-variant-numeric: tabular-nums;
}
.bbs-fold-none { font-size: var(--bbs-fs-meta); color: var(--bbs-ink-muted); }

/* 箭头在行尾:收起朝下,展开朝上;悬停或键盘聚焦整行时变强调色 */
.bbs-fold-caret {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-fold-caret.is-open { transform: rotate(180deg); }
.bbs-fold-head:hover:not(.is-static) .bbs-fold-caret,
.bbs-fold-head:focus-visible .bbs-fold-caret { color: var(--bbs-accent); }

/* 说明 / 提醒：默认与标题同行，放不下换行；可折叠或 hintBelow 时总在下一行 */
.bbs-fold-hint {
  flex: 1 1 150px;
  min-width: 0;
  font-size: var(--bbs-fs-meta);
  line-height: 1.7;
  color: var(--bbs-ink-muted);
  overflow-wrap: anywhere;
}
.bbs-fold-hint.is-warning { color: var(--bbs-warning); }
.bbs-fold-hint.is-below { order: 99; flex-basis: 100%; }

.bbs-fold-actions { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; margin-left: auto; }

/* 可收展容器:min-height:0 + overflow:hidden 才能让 0fr 真正压到零高 */
.bbs-fold-wrap { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 0.24s ease; }
.bbs-fold-wrap.is-collapsed { grid-template-rows: 0fr; }
.bbs-fold-inner { min-height: 0; overflow: hidden; }

@media (max-width: 480px) {
  .bbs-fold-hint { order: 99; flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .bbs-fold-caret, .bbs-fold-wrap { transition: none; }
}
</style>
