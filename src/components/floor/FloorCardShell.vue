<script setup lang="ts">
/**
 * 楼层卡片外壳:卡片头(锚点)+ 抽屉。从 FloorPanel.vue 拆出;楼层札记卡片(NotesCard)也可套用,两者头部与抽屉保持一致。
 *
 * - 头部:主区是一个按钮(Enter、空格可展开/收起,读屏播报展开状态);点按头部空白处同样切换。
 *   head 插槽的内容纵向排列(每个子元素一行),需要同行显示的内容请包在一个 span 里。
 *   caret 为 true 时主区右端显示展开箭头。右侧操作键放 actions 插槽,按钮上要写 @click.stop,避免同时触发展开。
 *   主区最小高 32px(手机与触屏 40px),没有操作键时也便于点按。
 * - 抽屉:grid 0fr↔1fr 高度过渡(内容常驻不脱流,无闪烁);收起时 inert,里面的按钮和输入框不会被 Tab 选中。
 * - 外观类:卡片根节点带 .bbs-summary-card .bbs-fp-card,展开时加 .is-expanded;调用方写的 class 合并到根节点。
 */
import Icon from '@/components/Icon.vue';

const props = defineProps<{
  expanded: boolean;
  /** 抽屉的 id(每个 shadow 内唯一,头部 aria-controls 指向它) */
  drawerId: string;
  /** 主区右端显示展开箭头 */
  caret?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:expanded', value: boolean): void }>();

function toggle(): void {
  emit('update:expanded', !props.expanded);
}
</script>

<template>
  <article class="bbs-summary-card bbs-fp-card" :class="{ 'is-expanded': expanded }">
    <!-- 主区按钮的点击(含键盘 Enter、空格触发的点击)冒泡到头部统一切换;头部空白处也可点 -->
    <header class="bbs-fp-head" @click="toggle">
      <button class="bbs-fp-head-main" type="button" :aria-expanded="expanded" :aria-controls="drawerId">
        <span class="bbs-fp-head-content"><slot name="head" /></span>
        <Icon v-if="caret" name="chevron" class="bbs-fp-caret" :class="{ 'is-open': expanded }" />
      </button>
      <slot name="actions" />
    </header>

    <div class="bbs-fp-drawer" :class="{ 'is-open': expanded }">
      <!-- 收起时 inert:里面的按钮和输入框不会被 Tab 选中,读屏也不读 -->
      <div :id="drawerId" class="bbs-fp-drawer-inner" :inert="!expanded" :aria-hidden="!expanded">
        <div class="bbs-fp-drawer-body">
          <slot />
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* 外层卡用 --bbs-bg(页面底色),与主界面「页面底 → surface 卡片 → surface-2 次级块」的层次一致:
   楼层面板即一块「迷你页面」。收起态收窄内边距,展开态恢复常规 padding。 */
.bbs-fp-card {
  background: var(--bbs-bg);
  padding: 9px 12px;
}
/* 展开态的下边距一半让给抽屉内边距(见下),视觉上仍是 12px */
.bbs-fp-card.is-expanded {
  padding: 12px 14px 6px;
}

/* 卡片头:左侧主区 + 右侧操作键 */
.bbs-fp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-wrap: nowrap;
}
/* 主区按钮:去掉按钮外观,只保留可聚焦与焦点环;纵向撑满头部,点按区域与头部同高 */
.bbs-fp-head-main {
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 0;
  min-height: var(--bbs-control-h-sm);
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bbs-fp-head-content {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
}
/* 展开箭头:收起时朝右,展开时朝下 */
.bbs-fp-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transform: rotate(-90deg);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-caret.is-open {
  transform: none;
}
.bbs-fp-head-main:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
  border-radius: var(--bbs-radius-sm);
}
.bbs-fp-card.is-expanded .bbs-fp-head {
  margin-bottom: 8px;
}

/* 抽屉 */
.bbs-fp-drawer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-drawer.is-open {
  grid-template-rows: 1fr;
}
/* 抽屉向左右外扩 6px、内容再缩回 6px:裁剪框比内容宽一圈,贴边控件的焦点环(外扩 5px)不被裁掉 */
.bbs-fp-drawer-inner {
  min-height: 0;
  margin: 0 -6px;
  overflow: hidden;
}
.bbs-fp-drawer-body {
  padding: 4px 6px 6px;
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity var(--bbs-dur) var(--bbs-ease),
    transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-drawer.is-open .bbs-fp-drawer-body {
  opacity: 1;
  transform: none;
}

@media (max-width: 640px), (pointer: coarse) {
  .bbs-fp-head-main {
    min-height: 40px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bbs-fp-drawer,
  .bbs-fp-drawer-body,
  .bbs-fp-caret {
    transition: none;
  }
}
</style>
