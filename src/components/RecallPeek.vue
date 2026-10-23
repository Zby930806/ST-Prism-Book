<script setup lang="ts">
/**
 * 召回速览:从快捷回复栏的「召回」按钮弹出,无需打开宝书即可查看上次召回的内容。
 * 只读 recallDebug(上次召回的快照,切聊天时清空)。点外面、按 Esc、再点按钮或打开宝书都会关掉;
 * 用 Esc 或关闭键关掉时,焦点回到「召回」按钮。
 */
import EmptyState from '@/components/EmptyState.vue';
import IconButton from '@/components/IconButton.vue';
import RecallList from '@/components/RecallList.vue';
import { useBackLayer } from '@/composables/useBackLayer';
import { recallDebug } from '@/memory/vector/debug';
import { recalledItems, recallPhase, recallStatusText } from '@/memory/vector/recallView';
import { recallButtonRect } from '@/recallQuickReply';
import { ui } from '@/state/ui';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

const panel = ref<HTMLElement | null>(null);
const pos = ref({ left: 8, bottom: 96, width: 360 });

const items = computed(() => recalledItems(recallDebug));
const phase = computed(() => recallPhase(recallDebug));
const statusText = computed(() => recallStatusText(recallDebug));
const timeText = computed(() => {
  if (!recallDebug.at) return '';
  const t = new Date(recallDebug.at);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
});

/**
 * 贴着按钮上沿弹出。按钮不在或被隐藏(快捷回复栏被收起、按钮收进了 QR助手的菜单)时,
 * 改贴着输入框上沿居中;输入框也找不到时放在屏幕下方居中。
 */
function place(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(520, vw - 16);
  const rect = recallButtonRect();
  const form = rect ? null : document.getElementById('send_form')?.getBoundingClientRect();
  const left = rect ? Math.min(Math.max(8, rect.left), vw - width - 8) : Math.round((vw - width) / 2);
  const anchorTop = rect?.top ?? (form && form.height > 0 ? form.top : 0);
  const bottom = anchorTop > 0 ? Math.max(8, vh - anchorTop + 8) : 96;
  pos.value = { left, bottom, width };
}

/** 关闭速览。restoreFocus:焦点在速览里时(键盘操作)送回「召回」按钮;点外面关闭时不抢焦点。 */
function close(restoreFocus = false): void {
  const root = panel.value?.getRootNode() as Document | ShadowRoot | undefined;
  const active = root?.activeElement ?? null;
  const focusInside = !!panel.value && !!active && panel.value.contains(active);
  ui.recallPeekOpen = false;
  if (restoreFocus && focusInside) document.getElementById('bbs-qr-recall')?.focus({ preventScroll: true });
}
function onPointerDown(e: PointerEvent): void {
  const path = e.composedPath();
  if (panel.value && path.includes(panel.value)) return;
  // 点按钮由按钮自己开关,这里不抢;QR助手菜单里的「召回」项(data-dom-id 指向按钮)同样算按钮
  const btn = document.getElementById('bbs-qr-recall');
  if (btn && path.includes(btn)) return;
  if (path.some(node => node instanceof HTMLElement && node.dataset.domId === 'bbs-qr-recall')) return;
  close();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close(true);
}
function unbind(): void {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', place);
}

watch(
  () => ui.recallPeekOpen,
  open => {
    unbind();
    if (!open) return;
    place();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    void nextTick(() => panel.value?.focus({ preventScroll: true }));
  },
  { immediate: true },
);
// 打开宝书时收起速览,两层不叠在一起
watch(
  () => ui.open,
  open => {
    if (open) close();
  },
);
onUnmounted(unbind);
// 返回键先收起速览
useBackLayer(() => ui.recallPeekOpen, () => close(true));
</script>

<template>
  <div
    v-if="ui.recallPeekOpen"
    ref="panel"
    class="bbs-recall-peek"
    role="dialog"
    aria-label="上次召回"
    tabindex="-1"
    :style="{ left: `${pos.left}px`, bottom: `${pos.bottom}px`, width: `${pos.width}px` }"
  >
    <header class="bbs-recall-peek-head">
      <span class="bbs-recall-peek-title">上次召回<template v-if="phase === 'done'"> · {{ items.length }} 段</template></span>
      <span v-if="timeText" class="bbs-recall-peek-time">{{ timeText }}</span>
      <IconButton class="bbs-recall-peek-close" icon="close" size="sm" label="关闭" @click="close(true)" />
    </header>
    <div class="bbs-recall-peek-body">
      <EmptyState v-if="phase === 'none'" compact icon="bookmark" title="暂无召回记录" text="生成回复前自动召回，结果显示在此处。" />
      <p v-else class="bbs-recall-peek-status" :class="`is-${phase}`">{{ statusText }}</p>
      <RecallList v-if="items.length" :items="items" />
      <!-- 注入原文:行式折叠(与设置页等处的折叠行同一种),每次打开速览都是收起状态 -->
      <details v-if="phase === 'done' && recallDebug.injectedText" class="bbs-disclosure bbs-recall-peek-raw-fold">
        <summary>注入原文</summary>
        <pre class="bbs-recall-peek-raw">{{ recallDebug.injectedText }}</pre>
      </details>
      <p class="bbs-recall-peek-hint">检索问题和评分过程见「设置 → 记忆与召回 → 召回调试」。</p>
    </div>
  </div>
</template>

<style scoped>
.bbs-recall-peek {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  max-height: min(60vh, 520px);
  border: 1px solid var(--bbs-line-strong, var(--bbs-line));
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  color: var(--bbs-ink);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  outline: none;
  overflow: hidden;
}
.bbs-recall-peek-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 14px;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-recall-peek-title {
  font-size: var(--bbs-fs-body);
  font-weight: 600;
}
.bbs-recall-peek-time {
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
.bbs-recall-peek-close {
  margin-left: auto;
}
.bbs-recall-peek-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbs-recall-peek-status {
  margin: 0;
  font-size: var(--bbs-fs-sm);
  line-height: 1.7;
  color: var(--bbs-ink-soft);
}
.bbs-recall-peek-status.is-failed {
  color: var(--bbs-danger);
}
/* 折叠行在小弹层里收紧一些:字号与正文说明同级,行高仍不低于点按尺寸 */
.bbs-recall-peek-raw-fold > summary {
  min-height: var(--bbs-control-h-sm);
  padding: 4px 0;
  font-size: var(--bbs-fs-sm);
  font-weight: 500;
  color: var(--bbs-ink-soft);
}
.bbs-recall-peek-raw {
  margin: 4px 0 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-bg);
  border: 1px solid var(--bbs-line);
  font: var(--bbs-fs-meta)/1.65 var(--bbs-font-sans);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink-soft);
}
.bbs-recall-peek-hint {
  margin: 0;
  font-size: var(--bbs-fs-meta);
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}
@media (max-width: 640px), (pointer: coarse) {
  .bbs-recall-peek-raw-fold > summary {
    min-height: 40px;
  }
}
</style>
