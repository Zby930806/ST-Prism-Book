<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import BrandMark from '@/components/BrandMark.vue';
import { useDialogFocus } from '@/composables/useDialogFocus';
import { PLUGIN_VERSION } from '@/version';
import NavBar from '@/components/NavBar.vue';
import FloatingOrb from '@/components/FloatingOrb.vue';
import { getPage } from '@/pages/registry';
import { closeBook, cycleTheme, lastOpenedAt, modalHost, THEMES, ui } from '@/state/ui';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

// 题首主题按钮:显示「下一个」主题的图标与名,点击即切换到它
const nextTheme = computed(() => {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  return THEMES[(i + 1) % THEMES.length];
});

// 是否窄屏(移动端):用于 nav 'auto' 的方向判定 + 抽屉手势开关。
// matchMedia 变化 Vue 不会自动追踪,用 ref 桥接成响应式。
const isNarrow = window.matchMedia('(max-width: 640px)');
const narrowFlag = ref(isNarrow.matches);
const onMq = (e: MediaQueryListEvent) => (narrowFlag.value = e.matches);
onMounted(() => isNarrow.addEventListener('change', onMq));
onUnmounted(() => isNarrow.removeEventListener('change', onMq));

const navPlacement = computed<'top' | 'bottom'>(() => {
  if (ui.navPosition === 'top') return 'top';
  if (ui.navPosition === 'bottom') return 'bottom';
  return narrowFlag.value ? 'bottom' : 'top';
});

const current = computed(() => getPage(ui.activePage));
const bodyEl = ref<HTMLElement | null>(null);
const windowEl = ref<HTMLElement | null>(null);
const { onDialogKeydown } = useDialogFocus(windowEl, () => ui.open, closeBook);
watch(() => ui.activePage, async () => { await nextTick(); bodyEl.value?.scrollTo({ top: 0 }); });

// —— 遮罩点击关闭:仅当按下与松开都在遮罩本身。
// 避免:1) 移动端打开手势的合成 click 穿透秒关;2) 窗内按下拖到窗外误关。
let pressedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressedOnOverlay = e.target === e.currentTarget;
}

function onOverlayClick(e: MouseEvent) {
  const justOpened = performance.now() - lastOpenedAt < 350;
  if (!justOpened && pressedOnOverlay && e.target === e.currentTarget) closeBook();
  pressedOnOverlay = false;
}

// —— 移动端:下滑关闭抽屉 ——
const dragY = ref(0); // 当前下拉位移(px)
const dragging = ref(false);
let startY = 0;
let activePointer: number | null = null;
const CLOSE_THRESHOLD = 110; // 超过此位移松手即关闭

function onHandleDown(e: PointerEvent) {
  if (!narrowFlag.value) return;
  activePointer = e.pointerId;
  startY = e.clientY;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  // 只跟随向下的位移
  dragY.value = Math.max(0, e.clientY - startY);
}

function onHandleUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragY.value > CLOSE_THRESHOLD) {
    closeBook();
  }
  dragY.value = 0;
}

// 抽屉跟手样式:拖动时禁用过渡,松手时回弹有过渡
const windowStyle = computed(() => {
  if (!narrowFlag.value || dragY.value === 0) return undefined;
  return {
    transform: `translateY(${dragY.value}px)`,
    transition: dragging.value ? 'none' : undefined,
  };
});
</script>

<template>
  <div class="bbs-root" :data-theme="ui.theme">
    <!-- 弹窗 Teleport 宿主:.bbs-root 直接子级,在 .bbs-body 滚动容器之外。
         各页弹窗 Teleport 到此,避开 iOS「可滚动祖先内 fixed 后代定位错乱」(详见 state/ui.ts)。 -->
    <div ref="modalHost"></div>
    <!-- 悬浮球:留在 shadow 内才能用 --bbs-* 主题变量;自身 position:fixed 贴边,不受 host 影响 -->
    <FloatingOrb v-if="ui.showOrb" />
    <Transition name="bbs-fade">
      <div
        v-if="ui.open"
        class="bbs-overlay"
        @pointerdown="onOverlayPointerDown"
        @click="onOverlayClick"
        tabindex="-1"
      >
        <!-- 窗口常驻于遮罩内(不独立 v-if、不嵌套 Transition):
             嵌套 Transition 在父子 v-if 同时翻转时,子的 leave 不会触发(实测窗口直接随父被移除,
             无任何动画)。改由遮罩 Transition 的 class 作后代选择器驱动窗口的进出场动画
             (见 <style> 里 .bbs-fade-enter-from/.bbs-fade-leave-to 下的 .bbs-window)。 -->
        <div ref="windowEl" class="bbs-window" tabindex="-1" @keydown="onDialogKeydown" :style="windowStyle" role="dialog" aria-modal="true" aria-label="棱镜宝书">
            <!-- 移动端抓手:可下滑关闭 -->
            <div
              v-if="navPlacement !== 'top' || narrowFlag"
              class="bbs-grabber"
              @pointerdown="onHandleDown"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
            >
              <span class="bbs-grabber-bar"></span>
            </div>

            <!-- 题首 -->
            <header class="bbs-head">
              <div class="bbs-brand"><BrandMark :size="32" /><div class="bbs-brand-copy"><span class="bbs-brand-name">棱镜宝书</span><span class="bbs-brand-tagline">PRISM BOOK</span></div></div>
              <div class="bbs-head-actions">
                <span class="bbs-version">{{ PLUGIN_VERSION }}</span>
                <button class="bbs-icon-btn" type="button" :title="`切换主题:${nextTheme.label}`" :aria-label="`切换主题:${nextTheme.label}`" @click="cycleTheme">
                  <Icon :name="nextTheme.icon" />
                </button>
                <button class="bbs-icon-btn" type="button" title="关闭棱镜宝书" aria-label="关闭棱镜宝书" @click="closeBook">
                  <Icon name="close" />
                </button>
              </div>
            </header>

            <NavBar v-if="navPlacement === 'top'" placement="top" :narrow="narrowFlag" />

            <main ref="bodyEl" class="bbs-body" :aria-label="current.label">
              <Transition name="bbs-page" mode="out-in">
                <component :is="current.component" :key="current.id" />
              </Transition>
            </main>

            <NavBar v-if="navPlacement === 'bottom'" placement="bottom" :narrow="narrowFlag" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* —— 移动端抓手:桌面隐藏 —— */
.bbs-grabber {
  display: none;
}

.bbs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  background: var(--bbs-surface);
  border-bottom: 1px solid var(--bbs-line);
  flex: 0 0 auto;
}

.bbs-brand-name {
  font-weight: 650;
  font-size: 18px;
  letter-spacing: -0.01em;
  color: var(--bbs-ink);
}

.bbs-head-actions {
  display: flex;
  gap: 8px;
}
.bbs-icon-btn {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-icon-btn:hover {
  color: var(--bbs-ink);
  background: var(--bbs-line-strong);
}
.bbs-icon-btn:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}

/* —— 过渡:遮罩淡入淡出,窗口靠遮罩的过渡 class 联动(见下) —— */
.bbs-fade-enter-active,
.bbs-fade-leave-active {
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-fade-enter-from,
.bbs-fade-leave-to {
  opacity: 0;
}

/* 窗口进出场:由遮罩 Transition 的 class 作后代选择器驱动(窗口自身不再套 Transition——
   父子 v-if 同时翻转时子 Transition 的 leave 不触发,实测窗口会无动画直接被移除)。
   进出场两端同款 transform → 对称。PC 微升+略放大；触屏和窄屏仅切换可见状态。 */
.bbs-fade-enter-from .bbs-window,
.bbs-fade-leave-to .bbs-window {
  opacity: 0;
  transform: translateY(16px) scale(0.985);
}

.bbs-page-enter-active,
.bbs-page-leave-active {
  transition:
    opacity 0.13s var(--bbs-ease),
    transform 0.13s var(--bbs-ease);
}
.bbs-page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.bbs-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 窗口过渡:进出场(transform+opacity)与拖动回弹(transform)共用;
   拖动跟手时由内联 style 的 transition:none 覆盖,松手回弹再走这条。 */
.bbs-window {
  transition:
    transform var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}

/* ============ 移动端:保留抓手与真实下拉手势 ============ */
@media (max-width: 640px) {
  .bbs-grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    cursor: grab;
    touch-action: none;
  }
  .bbs-grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--bbs-radius-pill);
    background: var(--bbs-line-strong);
  }
  .bbs-head {
    padding: 4px 16px 12px;
  }
}

.bbs-brand{display:flex;align-items:center;gap:12px;min-width:0}.bbs-brand-copy{display:flex;flex-direction:column;gap:2px;min-width:0}.bbs-brand-tagline{font-size:10px;letter-spacing:.06em;color:var(--bbs-ink-muted)}.bbs-brand-tagline span{margin:0 4px;color:var(--bbs-ink-muted)}.bbs-head-actions{align-items:center}.bbs-version{font-family:var(--bbs-font-mono);font-size:10px;color:var(--bbs-ink-muted);border:1px solid var(--bbs-line);border-radius:var(--bbs-radius-pill);padding:3px 8px;margin-right:6px}
@media(max-width:640px){.bbs-brand{gap:7px}.bbs-brand :deep(img){width:40px;height:40px}.bbs-brand-name{font-size:17px}.bbs-brand-tagline{font-size:9px;letter-spacing:0}.bbs-version{display:none}.bbs-head-actions{gap:5px}.bbs-icon-btn{width:38px;height:38px}.bbs-head{background:var(--bbs-bg);padding:0 14px 10px;}.bbs-grabber{height:20px}}
/* 移动端不再滑动整张长内容页或延迟退场；不覆盖 windowStyle 的拖动位移。
   桌面减少动效同样直接到终态，避免 0.001ms 的循环/延迟仍被调度。 */
@media (max-width: 640px), (hover: none) and (pointer: coarse), (prefers-reduced-motion: reduce) {
  .bbs-window,
  .bbs-icon-btn,
  .bbs-fade-enter-active,
  .bbs-fade-leave-active,
  .bbs-page-enter-active,
  .bbs-page-leave-active {
    transition: none;
  }
  .bbs-fade-enter-from,
  .bbs-fade-leave-to,
  .bbs-fade-enter-from .bbs-window,
  .bbs-fade-leave-to .bbs-window,
  .bbs-page-enter-from,
  .bbs-page-leave-to {
    opacity: 1;
    transform: none;
  }
}
/* 轻量书脊式题首：品牌退后，让当前阅读内容成为视觉重心。 */
.bbs-head { padding: 16px 28px; background: var(--bbs-bg); border-bottom: 1px solid var(--bbs-line); }
.bbs-brand { gap: 9px; }
.bbs-brand-copy { flex-direction: row; align-items: baseline; gap: 12px; }
.bbs-brand-name { font-size: 16px; font-weight: 650; letter-spacing: .04em; }
.bbs-brand-tagline { font-size: 9px; letter-spacing: .16em; }
.bbs-icon-btn { background: transparent; border-radius: 50%; width: 40px; height: 40px; font-size: 17px; }
.bbs-icon-btn:hover { background: var(--bbs-surface-2); }
.bbs-version { border: 0; }
@media(max-width:640px) {
  .bbs-head { padding: 0 16px 9px; border-bottom: 0; }
  .bbs-brand-copy { gap: 9px; }
  .bbs-brand-name { font-size: 15px; }
  .bbs-brand-tagline { font-size: 8px; letter-spacing: .13em; }
  .bbs-grabber { height: 18px; }
  .bbs-grabber-bar { width: 30px; height: 3px; opacity: .65; }
}
</style>
