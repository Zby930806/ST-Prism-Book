<script setup lang="ts">
/**
 * 模型可搜索下拉（combobox）：输入框既是当前值也是过滤词，聚焦时弹出过滤后的模型列表。
 * 没有可选模型（还没拉取）时就是普通输入框。渠道弹窗与向量端点共用。
 * 键盘：↓/↑ 在列表中移动（列表收起时 ↓ 展开），Enter 选中高亮项，Esc 只收起列表、不关闭所在弹窗。
 */
import { computed, ref, useId } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  /** 已拉取到的模型列表 */
  options: string[];
  /** 没有可选模型时的占位文字 */
  placeholder: string;
  disabled?: boolean;
}>(), { disabled: false });
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const model = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
});
const menuOpen = ref(false);
const query = ref(''); // 聚焦后用户输入的过滤词;失焦时清空
/** 键盘或悬停高亮的选项序号；-1 表示没有高亮 */
const activeIndex = ref(-1);
// 过滤:有 query 按子串(大小写不敏感)过滤;为空则显示全部。性能上限 200 条,避免超长列表卡顿。
const filtered = computed<string[]>(() => {
  const q = query.value.trim().toLowerCase();
  const list = props.options;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
/** 列表实际显示：展开且有可选模型 */
const listShown = computed(() => menuOpen.value && props.options.length > 0);

const listId = useId();
const optionId = (i: number) => `${listId}-${i}`;

function openMenu() {
  query.value = '';
  activeIndex.value = -1;
  menuOpen.value = true;
}
function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  activeIndex.value = -1;
  menuOpen.value = true;
}
function pick(m: string) {
  model.value = m;
  menuOpen.value = false;
  query.value = '';
  activeIndex.value = -1;
}
// 失焦延迟关闭,让 option 的 mousedown/click 先生效
function closeSoon() {
  setTimeout(() => {
    menuOpen.value = false;
    query.value = '';
    activeIndex.value = -1;
  }, 150);
}
function scrollActiveIntoView(list: HTMLElement | null) {
  list?.querySelector<HTMLElement>('#' + CSS.escape(optionId(activeIndex.value)))?.scrollIntoView({ block: 'nearest' });
}
const listEl = ref<HTMLElement | null>(null);
function onKeydown(e: KeyboardEvent) {
  if (!props.options.length) return;
  const count = filtered.value.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!menuOpen.value) { openMenu(); return; }
    if (!count) return;
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = activeIndex.value < 0
      ? (delta > 0 ? 0 : count - 1)
      : (activeIndex.value + delta + count) % count;
    scrollActiveIntoView(listEl.value);
  } else if (e.key === 'Enter') {
    if (listShown.value && activeIndex.value >= 0 && activeIndex.value < count) {
      e.preventDefault();
      pick(filtered.value[activeIndex.value]);
    }
  } else if (e.key === 'Escape') {
    if (listShown.value) {
      // 只收起列表：不让 Esc 冒泡到弹窗或窗口，免得连同未保存的草稿一起关掉
      e.preventDefault();
      e.stopPropagation();
      menuOpen.value = false;
      activeIndex.value = -1;
    }
  }
}
</script>

<template>
  <div class="bbs-combo">
    <input
      v-model="model"
      class="bbs-input"
      :placeholder="options.length ? '搜索或输入模型名…' : placeholder"
      :disabled="disabled"
      :role="options.length ? 'combobox' : undefined"
      :aria-autocomplete="options.length ? 'list' : undefined"
      :aria-expanded="options.length ? listShown : undefined"
      :aria-controls="listShown ? listId : undefined"
      :aria-activedescendant="listShown && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      @focus="openMenu"
      @input="onInput"
      @blur="closeSoon"
      @keydown="onKeydown"
    />
    <!-- 自绘下拉三角(纯装饰,pointer-events:none → 点击穿透到输入框照常聚焦展开);仅在有可选模型时显示 -->
    <span v-if="options.length" class="bbs-combo-caret" :class="{ 'is-open': menuOpen }" aria-hidden="true" />
    <ul v-if="listShown" :id="listId" ref="listEl" class="bbs-combo-menu" role="listbox" aria-label="模型列表">
      <li v-if="!filtered.length" class="bbs-combo-empty" role="option" aria-disabled="true" aria-selected="false">没有匹配的模型</li>
      <li
        v-for="(m, i) in filtered"
        :id="optionId(i)"
        :key="m"
        class="bbs-combo-item"
        :class="{ 'is-active': m === modelValue, 'is-highlight': i === activeIndex }"
        role="option"
        :aria-selected="m === modelValue"
        @mouseenter="activeIndex = i"
        @mousedown.prevent="pick(m)"
      >
        {{ m }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* —— 模型可搜索 combobox —— */
.bbs-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbs-combo .bbs-input {
  width: 100%;
  padding-right: 26px; /* 给右侧自绘三角让位,文字不压到箭头 */
}
/* 自绘下拉三角:与原生 <select> 同款 SVG,贴右侧居中;展开时翻转。装饰元素不拦点击 */
.bbs-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbs-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 过滤菜单:绝对定位贴在输入框下方,限高滚动,长列表不撑爆弹窗 */
.bbs-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  box-shadow: var(--bbs-shadow);
}
/* 选项点按高度：桌面 32px，窄屏与触屏 40px */
.bbs-combo-item {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 9px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12.5px;
  color: var(--bbs-ink);
  cursor: pointer;
  word-break: break-all;
}
/* 键盘高亮与悬停同一画法 */
.bbs-combo-item:hover,
.bbs-combo-item.is-highlight {
  background: var(--bbs-surface-2);
}
.bbs-combo-item.is-active {
  color: var(--bbs-accent);
  font-weight: 600;
}
@media (max-width: 640px), (pointer: coarse) {
  .bbs-combo-item { min-height: 40px; }
}
.bbs-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
</style>
