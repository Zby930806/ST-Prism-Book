<script setup lang="ts">
/**
 * 召回速览:从快捷回复栏的「召回」按钮弹出,无需打开宝书即可查看上次召回的内容。
 * 只读 recallDebug(上次召回的快照,切聊天时清空)。点外面、按 Esc、再点按钮或打开宝书都会关掉。
 */
import Icon from '@/components/Icon.vue';
import RecallList from '@/components/RecallList.vue';
import { recallDebug } from '@/memory/vector/debug';
import { recalledItems, recallPhase, recallStatusText } from '@/memory/vector/recallView';
import { recallButtonRect } from '@/recallQuickReply';
import { ui } from '@/state/ui';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

const panel = ref<HTMLElement | null>(null);
const showRaw = ref(false);
const pos = ref({ left: 8, bottom: 96, width: 360 });

const items = computed(() => recalledItems(recallDebug));
const phase = computed(() => recallPhase(recallDebug));
const statusText = computed(() => recallStatusText(recallDebug));
const timeText = computed(() => {
  if (!recallDebug.at) return '';
  const t = new Date(recallDebug.at);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
});

/** 贴着按钮上沿弹出;按钮不在(比如快捷回复栏被隐藏)就放在屏幕下方居中。 */
function place(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(520, vw - 16);
  const rect = recallButtonRect();
  const left = rect ? Math.min(Math.max(8, rect.left), vw - width - 8) : Math.round((vw - width) / 2);
  const bottom = rect && rect.top > 0 ? Math.max(8, vh - rect.top + 8) : 96;
  pos.value = { left, bottom, width };
}

function close(): void {
  ui.recallPeekOpen = false;
}
function onPointerDown(e: PointerEvent): void {
  const path = e.composedPath();
  if (panel.value && path.includes(panel.value)) return;
  // 点按钮由按钮自己开关,这里不抢
  const btn = document.getElementById('bbs-qr-recall');
  if (btn && path.includes(btn)) return;
  close();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
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
    showRaw.value = false;
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
      <button class="bbs-recall-peek-close" type="button" title="关闭" aria-label="关闭" @click="close"><Icon name="close" /></button>
    </header>
    <div class="bbs-recall-peek-body">
      <p class="bbs-recall-peek-status" :class="`is-${phase}`">{{ statusText }}</p>
      <RecallList v-if="items.length" :items="items" />
      <template v-if="phase === 'done' && recallDebug.injectedText">
        <button class="bbs-recall-peek-toggle" type="button" :aria-expanded="showRaw" @click="showRaw = !showRaw">
          <Icon name="chevron" class="bbs-recall-peek-caret" :class="{ 'is-open': showRaw }" />{{ showRaw ? '收起注入原文' : '查看注入原文' }}
        </button>
        <pre v-if="showRaw" class="bbs-recall-peek-raw">{{ recallDebug.injectedText }}</pre>
      </template>
      <p class="bbs-recall-peek-hint">检索问题和评分过程见「设置 → 向量记忆 → 上次召回详情」。</p>
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
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-recall-peek-title {
  font-size: 13.5px;
  font-weight: 600;
}
.bbs-recall-peek-time {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
.bbs-recall-peek-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
}
.bbs-recall-peek-close:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
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
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
}
.bbs-recall-peek-status.is-failed {
  color: var(--bbs-danger);
}
.bbs-recall-peek-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink-soft);
  font: 500 12px/1.6 var(--bbs-font-sans);
  cursor: pointer;
}
.bbs-recall-peek-toggle:hover {
  color: var(--bbs-accent);
}
.bbs-recall-peek-caret {
  transform: rotate(-90deg);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-recall-peek-caret.is-open {
  transform: none;
}
.bbs-recall-peek-raw {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-bg);
  border: 1px solid var(--bbs-line);
  font: 12px/1.65 var(--bbs-font-sans);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink-soft);
}
.bbs-recall-peek-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}
</style>
