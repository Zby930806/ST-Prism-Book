<script setup lang="ts">
/**
 * 规划讨论：页面内是一张入口卡片，点开后是对话界面：桌面为居中大窗；手机上与宝书窗口一样是贴底的抽屉，
 * 顶部留出一截（不被系统状态栏挡住），可点返回、点上方空白处或按住顶部横条下拉关闭。
 * 对话界面在标题栏下选择参考的版本，底部输入；「生成草稿」从底部弹出设置面板，
 * 确认后按讨论生成草稿。讨论不修改规划，也不注入正文。
 * 对话界面 Teleport 到 modalHost（与其他弹窗相同，避开 iOS 滚动容器内的定位问题）。
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import BbsSelect from '@/components/BbsSelect.vue';
import { QIHENG_NAME } from '@/outline/qiheng';
import { QIHENG_AVATAR } from '@/outline/qihengAvatar';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import { useDialogFocus } from '@/composables/useDialogFocus';
import { useBackLayer } from '@/composables/useBackLayer';
import { engineActiveHere } from '@/api/settings';
import { getContext } from '@/st/context';
import { copyText } from '@/st/clipboard';
import { toast } from '@/st/toast';
import { modalHost } from '@/state/ui';
import { outlineState } from '@/outline/store';
import { discussionState, clearOutlineDiscussion, removeOldestDiscussionTurn, discussionRoom, DISCUSSION_LIMITS } from '@/outline/discussionStore';
import { captureOutlineSource, sameOutlineChat, type OutlineSource } from '@/outline/source';
import type { DiscussionTarget } from '@/outline/discussionContext';
import { discussionTimeLabel, discussionTranscript, plainPreview } from '@/outline/discussionView';
import { discussionRun, sendOutlineDiscussion, cancelOutlineDiscussion, captureOutlineRefinement, generateOutline, outlineRun, cancelOutline } from '@/outline/service';
import DiscussionMessages from './DiscussionMessages.vue';

const props = defineProps<{ disabled: boolean; unsaved: boolean; configurationIssue: string; apiDirty: boolean }>();
const emit = defineEmits<{ (e: 'view-draft'): void; (e: 'open-api'): void }>();

const MAX_ROUNDS = DISCUSSION_LIMITS.rounds;
// 发给规划模型的修订指令（提示词），不随界面文案改动。
const REFINE_INSTRUCTION = '根据所选大纲与讨论生成修订草稿。以讨论中用户最新明确意见为准，模型建议不等于已被采纳；保留未要求改动的合理内容与人物边界。没有现有大纲时按讨论整理初稿。不要把讨论当成剧情事实。';
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试。';
const ids = { title: useId(), sheet: useId(), entry: useId() };

const question = ref(''), target = ref<DiscussionTarget>('none'), stageCount = ref(6), refining = ref(false);
const error = ref(''), touchedTarget = ref(false);
const pendingQuestion = ref<{ text: string; at: number } | null>(null);
/** 按讨论生成草稿的结果：成功后提供「查看草稿」，失败或未采用时说明原因。 */
const result = ref<{ kind: 'ready' | 'error' | 'notice'; text: string; detail?: string } | null>(null);
let mounted = true;
onBeforeUnmount(() => { mounted = false; });

const rounds = computed(() => discussionState.messages.length / 2);
const lastAt = computed(() => discussionState.messages[discussionState.messages.length - 1]?.at);
const full = computed(() => rounds.value >= MAX_ROUNDS);
/** 发送前预留一条最长回答（8000 字）的空间：本轮问题最多还能写多长。 */
const room = computed(() => discussionRoom(discussionState.messages));
const totalChars = computed(() => room.value.used);
const record = computed(() => target.value === 'draft' ? outlineState.draft : target.value === 'active' ? outlineState.active : null);
const protectedData = computed(() => /只读|版本|格式/.test(discussionState.issue));
const locked = computed(() => props.disabled || discussionRun.busy || discussionState.saving || outlineRun.busy || protectedData.value);
const engineOn = computed(() => engineActiveHere());
const available = computed(() => !locked.value && engineOn.value && !props.configurationIssue);
const canSend = computed(() => available.value && !full.value && !!question.value.trim() && question.value.length <= room.value.question);
const canRefine = computed(() => available.value && rounds.value > 0);
const stageValid = computed(() => Number.isInteger(stageCount.value) && stageCount.value >= 1 && stageCount.value <= 12);
// 等待回复、生成草稿时仍可先写下一条；只读保护或页面锁定时不可输入。
const typingBlocked = computed(() => protectedData.value || (props.disabled && !discussionRun.busy && !outlineRun.busy));
const generatingDraft = computed(() => refining.value && outlineRun.busy);
const targetOptions = computed(() => [
  ...(outlineState.active ? [{ value: 'active' as const, label: '正在用的规划 · ' + outlineState.active.content.title }] : []),
  ...(outlineState.draft ? [{ value: 'draft' as const, label: '草稿 · ' + outlineState.draft.content.title }] : []),
  { value: 'none' as const, label: '不参考，先聊方向' },
]);
const roundsLabel = computed(() => !rounds.value ? '暂无讨论'
  : full.value ? `已满 ${MAX_ROUNDS} 轮` : rounds.value >= MAX_ROUNDS - 2 ? `${rounds.value} 轮讨论 · 上限 ${MAX_ROUNDS} 轮` : `${rounds.value} 轮讨论`);
const placeholder = computed(() => !engineOn.value ? '当前角色未启用棱镜宝书'
  : full.value ? `讨论已满 ${MAX_ROUNDS} 轮，删除最早的一轮或清空后可继续`
    : room.value.question <= 0 ? `讨论已接近 ${DISCUSSION_LIMITS.total} 字，删除最早的一轮或清空后可继续` : '输入想法或问题…');
const entryText = computed(() => {
  if (discussionRun.busy) return QIHENG_NAME + ' 正在输入…';
  if (generatingDraft.value) return '正在按讨论生成草稿…';
  const messages = discussionState.messages;
  return messages.length ? QIHENG_NAME + '：' + plainPreview(messages[messages.length - 1].content, 90) : '讨论仅用于构思，生成草稿后再确认生效。';
});
// 等待中的状态显示在等待气泡里；其余结果（保存、取消、清空）显示在列表末尾。
const listNote = computed(() => discussionRun.busy ? '' : discussionRun.status);

watch(() => [outlineState.active?.id, outlineState.draft?.id], () => {
  if (!touchedTarget.value) target.value = outlineState.active ? 'active' : outlineState.draft ? 'draft' : 'none';
  else if (target.value !== 'none' && !record.value) { target.value = 'none'; touchedTarget.value = false; }
}, { immediate: true });
watch(record, value => { stageCount.value = value?.content.chapters.length ?? 6; }, { immediate: true });
function pickTarget(value: DiscussionTarget) {
  target.value = value; touchedTarget.value = true;
}

/* —— 对话界面：打开、关闭、放大 —— */
const open = ref(false), maximized = ref(false);
const panelEl = ref<HTMLElement | null>(null);
const { onDialogKeydown } = useDialogFocus(panelEl, () => open.value, () => close());
// 返回键：草稿面板、更多操作菜单各算一层（在下方登记），都关掉后再关对话界面
useBackLayer(() => open.value, () => close());
function openPanel() { open.value = true; }
function close() {
  if (sheet.value) { closeSheet(); return; }
  closeMenu();
  open.value = false;
}
// 手机软键盘弹出时，按可见区域的高度摆放对话界面，输入栏不被键盘遮住。
const viewport = ref<{ top: number; height: number } | null>(null);
function syncViewport() {
  const vv = window.visualViewport;
  viewport.value = vv ? { top: vv.offsetTop, height: vv.height } : null;
}
watch(open, value => {
  const vv = window.visualViewport;
  if (!vv) return;
  if (value) { syncViewport(); vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); }
  else { vv.removeEventListener('resize', syncViewport); vv.removeEventListener('scroll', syncViewport); viewport.value = null; }
});
const maskStyle = computed(() => viewport.value ? { top: `${viewport.value.top}px`, height: `${viewport.value.height}px` } : undefined);

// 手机：按住顶部横条下拉，超过 110px 松手即关闭（与宝书窗口的抓手相同）
const dragY = ref(0), dragging = ref(false);
let dragStart = 0, dragPointer: number | null = null;
function onGrabDown(event: PointerEvent) {
  dragPointer = event.pointerId; dragStart = event.clientY; dragging.value = true;
  try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* 合成事件没有可捕获的指针 */ }
}
function onGrabMove(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== dragPointer) return;
  dragY.value = Math.max(0, event.clientY - dragStart);
}
function onGrabUp(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== dragPointer) return;
  dragging.value = false; dragPointer = null;
  const far = dragY.value > 110;
  dragY.value = 0;
  if (far) close();
}
const panelStyle = computed(() => dragY.value ? { transform: `translateY(${dragY.value}px)`, transition: dragging.value ? 'none' : undefined } : undefined);

/* —— 更多操作菜单 —— */
const menuOpen = ref(false);
const menuWrap = ref<HTMLElement | null>(null);
const moreButton = ref<InstanceType<typeof IconButton> | null>(null);
const moreEl = () => moreButton.value?.$el as HTMLElement | undefined;
function menuItems(): HTMLElement[] {
  return Array.from(menuWrap.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
}
function openMenu() {
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocMousedown, true);
  nextTick(() => menuItems()[0]?.focus());
}
function closeMenu(restoreFocus = false) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocMousedown, true);
  if (restoreFocus) moreEl()?.focus();
}
function onDocMousedown(event: MouseEvent) {
  if (menuWrap.value && event.composedPath().includes(menuWrap.value)) return;
  closeMenu();
}
function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
  if (event.key === 'Tab') { closeMenu(); return; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = menuItems();
  const index = items.indexOf(event.target as HTMLElement);
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown, true));
useBackLayer(() => menuOpen.value, () => closeMenu(true));

async function copyAll() {
  closeMenu(true);
  if (await copyText(discussionTranscript(discussionState.messages))) toast('已复制全部讨论。', 'success');
  else toast('复制失败：浏览器不允许访问剪贴板，请选中文字后手动复制。', 'warning');
}

/* —— 清空讨论：确认弹窗叠在对话界面之上 —— */
const clearOpen = ref(false);
let clearRequest: { source: OutlineSource; revision: number } | null = null;
function requestClear() {
  closeMenu(true);
  const ctx = getContext();
  if (locked.value || !rounds.value || !ctx?.getCurrentChatId()) return;
  clearRequest = { source: captureOutlineSource(ctx), revision: discussionState.revision };
  // 等菜单收起、焦点回到「更多操作」后再打开，关闭弹窗时焦点能回到这里。
  nextTick(() => { clearOpen.value = true; });
}
async function confirmClear() {
  const request = clearRequest;
  clearOpen.value = false; clearRequest = null;
  if (!request || locked.value) return;
  if (!sameOutlineChat(request.source) || request.revision !== discussionState.revision) {
    error.value = '讨论已有变化，请核对后重新清空。'; return;
  }
  try {
    await clearOutlineDiscussion(request.revision);
    if (mounted && sameOutlineChat(request.source)) {
      discussionRun.error = ''; discussionRun.errorDetail = ''; discussionRun.status = '讨论已清空。'; result.value = null;
    }
  } catch (cause) {
    if (mounted && sameOutlineChat(request.source)) error.value = errorText(cause);
  }
}

/* —— 删除最早的一轮：满 12 轮或接近字数上限时腾出空间，其余讨论保留；确认弹窗叠在对话界面之上 —— */
const trimOpen = ref(false);
let trimRequest: { source: OutlineSource; revision: number } | null = null;
function requestTrim() {
  closeMenu(true);
  const ctx = getContext();
  if (locked.value || !rounds.value || !ctx?.getCurrentChatId()) return;
  trimRequest = { source: captureOutlineSource(ctx), revision: discussionState.revision };
  nextTick(() => { trimOpen.value = true; });
}
async function confirmTrim() {
  const request = trimRequest;
  trimOpen.value = false; trimRequest = null;
  if (!request || locked.value) return;
  if (!sameOutlineChat(request.source) || request.revision !== discussionState.revision) {
    error.value = '讨论已有变化，请核对后重新操作。'; return;
  }
  try {
    await removeOldestDiscussionTurn(request.revision);
    if (mounted && sameOutlineChat(request.source)) {
      discussionRun.error = ''; discussionRun.errorDetail = ''; discussionRun.status = '已删除最早的一轮讨论。'; result.value = null;
    }
  } catch (cause) {
    if (mounted && sameOutlineChat(request.source)) error.value = errorText(cause);
  }
}

/* —— 发送：先显示待回复的问题；失败时把原文放回输入框 —— */
async function send() {
  if (!canSend.value) return;
  const ctx = getContext(); if (!ctx) return;
  const source = captureOutlineSource(ctx), text = question.value;
  error.value = ''; result.value = null;
  pendingQuestion.value = { text: text.trim(), at: Date.now() }; question.value = '';
  const saved = await sendOutlineDiscussion(text, target.value);
  if (!mounted) return;
  pendingQuestion.value = null;
  if (!saved && sameOutlineChat(source) && !question.value) question.value = text;
}

/* —— 生成草稿：底部面板即确认步骤，打开时记下聊天与版本，确认时核对 —— */
type SheetRequest = { source: OutlineSource; revision: number; discussionRevision: number };
const sheet = shallowRef<SheetRequest | null>(null);
const sheetError = ref('');
const sheetEl = ref<HTMLElement | null>(null);
const draftButton = ref<HTMLButtonElement | null>(null);
const snapshot = (ctx: NonNullable<ReturnType<typeof getContext>>): SheetRequest =>
  ({ source: captureOutlineSource(ctx), revision: outlineState.revision, discussionRevision: discussionState.revision });
const sheetWarning = computed(() => outlineState.draft
  ? '将替换当前草稿，确认启用前不会影响正文。' + (props.unsaved ? '草稿中未保存的修改也会被替换。' : '')
  : '生成的草稿需确认启用后才会影响正文。');
function openSheet() {
  if (!canRefine.value) return;
  const ctx = getContext(); if (!ctx?.getCurrentChatId()) return;
  closeMenu();
  sheetError.value = ''; result.value = null;
  sheet.value = snapshot(ctx);
  nextTick(() => sheetEl.value?.focus({ preventScroll: true }));
}
function closeSheet() {
  sheet.value = null; sheetError.value = '';
  nextTick(() => draftButton.value?.focus({ preventScroll: true }));
}
useBackLayer(() => !!sheet.value, closeSheet);
function onSheetKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation(); closeSheet();
}
function stepStage(delta: number) {
  const value = Number.isInteger(stageCount.value) ? stageCount.value : 6;
  stageCount.value = Math.min(12, Math.max(1, value + delta));
}
function clampStage() {
  const value = Math.round(Number(stageCount.value));
  stageCount.value = Number.isFinite(value) ? Math.min(12, Math.max(1, value)) : 6;
}
async function confirmRefine() {
  const request = sheet.value;
  if (!request || !canRefine.value || !stageValid.value) return;
  if (!sameOutlineChat(request.source)) { sheet.value = null; error.value = '聊天已切换，请在当前聊天重新操作。'; return; }
  if (request.revision !== outlineState.revision || request.discussionRevision !== discussionState.revision) {
    const ctx = getContext();
    sheet.value = ctx ? snapshot(ctx) : null;
    sheetError.value = '讨论或规划刚有变化，请核对后再次确认。';
    return;
  }
  let reference;
  try { reference = captureOutlineRefinement(target.value); }
  catch (cause) { sheetError.value = errorText(cause); return; }
  const count = stageCount.value, previousDraftId = outlineState.draft?.id;
  sheet.value = null; sheetError.value = ''; error.value = '';
  refining.value = true;
  nextTick(() => panelEl.value?.querySelector<HTMLElement>('.oc-bar .bbs-btn')?.focus({ preventScroll: true }));
  try {
    await generateOutline(REFINE_INSTRUCTION, count, reference);
    if (!mounted || !sameOutlineChat(request.source)) return;
    if (!outlineRun.error && outlineState.draft && outlineState.draft.id !== previousDraftId) {
      target.value = 'draft'; touchedTarget.value = true;
      result.value = { kind: 'ready', text: '草稿已生成，确认启用前不会影响正文。' };
    } else if (outlineRun.error) result.value = { kind: 'error', text: outlineRun.error, detail: outlineRun.errorDetail };
    else if (outlineRun.status) result.value = { kind: 'notice', text: outlineRun.status };
  } catch (cause) {
    if (mounted && sameOutlineChat(request.source)) error.value = errorText(cause);
  } finally { refining.value = false; }
}
function viewDraft() {
  open.value = false;
  emit('view-draft');
}
function openApi() {
  open.value = false;
  emit('open-api');
}

// 切聊天时清掉未发送的输入、面板与结果；普通新回复、草稿保存不清空正在输入的内容。
let chat = getContext() ? captureOutlineSource(getContext()!) : undefined;
watch(() => [outlineState.revision, discussionState.revision], () => {
  if (chat && sameOutlineChat(chat)) return;
  chat = getContext() ? captureOutlineSource(getContext()!) : undefined;
  question.value = ''; error.value = ''; touchedTarget.value = false; pendingQuestion.value = null;
  sheet.value = null; sheetError.value = ''; result.value = null; clearOpen.value = false; clearRequest = null;
  target.value = outlineState.active ? 'active' : outlineState.draft ? 'draft' : 'none';
});
</script>

<template>
  <section class="oc-entry" :aria-labelledby="ids.entry">
    <img class="oc-entry-avatar" :src="QIHENG_AVATAR" alt="" width="40" height="40" />
    <div class="oc-entry-main">
      <h4 :id="ids.entry" class="oc-entry-title">和 {{ QIHENG_NAME }} 讨论规划<span v-if="rounds" class="oc-entry-count">{{ rounds }} 轮{{ lastAt ? ' · ' + discussionTimeLabel(lastAt) : '' }}</span></h4>
      <p class="oc-entry-text">{{ entryText }}</p>
    </div>
    <button type="button" class="bbs-btn oc-entry-open" :class="{ 'bbs-btn-primary': !rounds }" @click="openPanel">{{ rounds ? '继续讨论' : '开始讨论' }}<Icon name="navigate" /></button>
  </section>

  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="oc">
      <div v-if="open" class="oc-mask" :style="maskStyle" @mousedown.self="close">
        <section ref="panelEl" class="oc-panel" :class="{ 'is-max': maximized }" :style="panelStyle" role="dialog" aria-modal="true"
          :aria-labelledby="ids.title" tabindex="-1" @keydown="onDialogKeydown">
          <div class="oc-grabber" aria-hidden="true" @pointerdown="onGrabDown" @pointermove="onGrabMove" @pointerup="onGrabUp" @pointercancel="onGrabUp"><span></span></div>
          <header class="oc-head" :inert="!!sheet">
            <IconButton icon="back" label="返回规划" @click="close" />
            <img class="oc-avatar" :src="QIHENG_AVATAR" alt="" width="38" height="38" />
            <div class="oc-titles">
              <h2 :id="ids.title">{{ QIHENG_NAME }}</h2>
              <p :class="{ 'is-typing': discussionRun.busy }">{{ discussionRun.busy ? '正在输入…' : '规划讨论' }}</p>
            </div>
            <IconButton class="oc-expand" :icon="maximized ? 'minimize' : 'maximize'" :label="maximized ? '还原窗口' : '放大窗口'" @click="maximized = !maximized" />
            <div ref="menuWrap" class="oc-more" @keydown="onMenuKeydown">
              <IconButton ref="moreButton" icon="more" label="更多操作" aria-haspopup="menu" :aria-expanded="menuOpen" @click="menuOpen ? closeMenu(true) : openMenu()" />
              <div v-if="menuOpen" class="oc-menu" role="menu" aria-label="更多操作">
                <button type="button" role="menuitem" class="oc-menu-item" :disabled="!rounds" @click="copyAll"><Icon name="copy" />复制全部讨论</button>
                <button type="button" role="menuitem" class="oc-menu-item" :disabled="locked || !rounds" @click="requestTrim"><Icon name="trash" />删除最早的一轮</button>
                <button type="button" role="menuitem" class="oc-menu-item is-danger" :disabled="locked || !rounds" @click="requestClear"><Icon name="trash" />清空讨论</button>
              </div>
            </div>
          </header>

          <div class="oc-context" :inert="!!sheet">
            <div class="oc-ref">
              <span class="oc-ref-label">参考</span>
              <div class="oc-ref-select"><BbsSelect :model-value="target" :options="targetOptions" aria-label="讨论参考的版本" @update:model-value="pickTarget" /></div>
            </div>
            <p class="oc-info"><Icon name="info" />讨论仅用于构思，生成草稿后再确认生效。</p>
          </div>

          <DiscussionMessages :inert="!!sheet" :messages="discussionState.messages" :pending="discussionRun.busy ? pendingQuestion : null"
            :busy="discussionRun.busy" :busy-text="discussionRun.status" :note="listNote" />

          <footer class="oc-foot" :inert="!!sheet">
            <div class="oc-alerts">
              <p v-if="!engineOn" class="bbs-callout is-warning">当前角色未启用棱镜宝书，讨论与生成草稿不可用。可在设置页顶部的总开关或角色设置中启用。</p>
              <div v-else-if="configurationIssue" class="bbs-callout is-warning oc-alert-row">
                <span>规划 API 不可用：{{ configurationIssue }}</span>
                <button type="button" class="bbs-btn bbs-btn-sm" @click="openApi">打开规划 API 设置</button>
              </div>
              <p v-if="discussionState.issue" class="bbs-callout is-danger" role="alert">{{ discussionState.issue }}</p>
              <div v-if="error || discussionRun.error" class="bbs-callout is-danger" role="alert">
                <p>{{ error || discussionRun.error }}</p>
                <details v-if="!error && discussionRun.errorDetail"><summary>技术细节</summary><p>{{ discussionRun.errorDetail }}</p></details>
              </div>
              <div v-if="result?.kind === 'error'" class="bbs-callout is-danger" role="alert">
                <p>{{ result.text }}</p>
                <details v-if="result.detail"><summary>技术细节</summary><p>{{ result.detail }}</p></details>
              </div>
              <p v-else-if="result?.kind === 'notice'" class="oc-hint" role="status">{{ result.text }}</p>
              <div v-else-if="result?.kind === 'ready'" class="bbs-callout is-success oc-alert-row" role="status">
                <span>{{ result.text }}</span>
                <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" @click="viewDraft">查看草稿</button>
              </div>
              <div v-if="full" class="bbs-callout is-warning oc-alert-row">
                <span>讨论已满 {{ MAX_ROUNDS }} 轮。删除最早的一轮或清空讨论后可继续；规划不受影响。</span>
                <span class="oc-alert-actions">
                  <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="requestTrim">删除最早的一轮</button>
                  <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="requestClear">清空讨论</button>
                </span>
              </div>
              <div v-else-if="room.question < DISCUSSION_LIMITS.question" class="bbs-callout is-warning oc-alert-row">
                <span>{{ room.question > 0
                  ? `讨论记录已有 ${totalChars} 字。为回答预留 ${DISCUSSION_LIMITS.answer} 字后，本轮问题最多还能写 ${room.question} 字（总上限 ${DISCUSSION_LIMITS.total} 字）。`
                  : `讨论记录已有 ${totalChars} 字，再加一轮会超过 ${DISCUSSION_LIMITS.total} 字的上限。删除最早的一轮或清空讨论后可继续。` }}</span>
                <span class="oc-alert-actions">
                  <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="requestTrim">删除最早的一轮</button>
                </span>
              </div>
              <p v-if="unsaved && target === 'draft'" class="oc-hint">草稿有未保存的修改，讨论只参考已保存的版本。</p>
              <p v-if="apiDirty" class="oc-hint">规划 API 设置尚未保存，使用上次保存的设置。</p>
            </div>
            <div class="oc-bar">
              <span class="oc-rounds">{{ roundsLabel }}</span>
              <span v-if="generatingDraft" class="oc-progress" role="status"><span class="bbs-spin" aria-hidden="true"></span>正在生成草稿…</span>
              <button v-if="generatingDraft" type="button" class="bbs-btn bbs-btn-sm" @click="cancelOutline">取消生成</button>
              <button v-else ref="draftButton" type="button" class="bbs-btn bbs-btn-sm oc-draft" :disabled="!canRefine" @click="openSheet">生成草稿<Icon name="arrow-up-right" /></button>
            </div>
            <div class="oc-composer" :class="{ 'is-disabled': typingBlocked }">
              <textarea v-model="question" v-autosize class="oc-input" rows="1" maxlength="4000" aria-label="讨论内容" :placeholder="placeholder"
                :disabled="typingBlocked" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" />
              <button v-if="discussionRun.busy" type="button" class="oc-send is-stop" :disabled="discussionState.saving" aria-label="停止等待回复" title="停止等待回复" @click="cancelOutlineDiscussion"><Icon name="stop" /></button>
              <button v-else type="button" class="oc-send" :disabled="!canSend" aria-label="发送" title="发送（Ctrl+Enter）" @click="send"><Icon name="send" /></button>
            </div>
            <p class="oc-caption">发送仅用于讨论<span class="oc-shortcut"> · Ctrl+Enter 发送</span><span v-if="question.length > Math.min(3600, room.question - 400)" class="oc-count"> · {{ question.length }} / {{ room.question }}</span></p>
          </footer>

          <Transition name="oc-sheet">
            <div v-if="sheet" class="oc-scrim" @mousedown.self="closeSheet">
              <section ref="sheetEl" class="oc-sheet" role="dialog" aria-modal="true" :aria-labelledby="ids.sheet" tabindex="-1" @keydown="onSheetKeydown">
                <header class="oc-sheet-head">
                  <div>
                    <h3 :id="ids.sheet">按讨论生成草稿</h3>
                    <p>整理当前讨论，生成可编辑的规划草稿。</p>
                  </div>
                  <IconButton icon="close" label="关闭" @click="closeSheet" />
                </header>
                <div class="oc-sheet-card">
                  <div class="oc-sheet-row">
                    <span class="oc-sheet-label">参考版本</span>
                    <div class="oc-sheet-select"><BbsSelect :model-value="target" :options="targetOptions" aria-label="参考版本" @update:model-value="pickTarget" /></div>
                  </div>
                  <div class="oc-sheet-row">
                    <span class="oc-sheet-label">阶段数量<small>可设置 1–12 个阶段</small></span>
                    <div class="oc-stepper" role="group" aria-label="阶段数量">
                      <button type="button" :disabled="stageCount <= 1" aria-label="减少一个阶段" @click="stepStage(-1)"><Icon name="minus" /></button>
                      <input v-model.number="stageCount" type="number" min="1" max="12" step="1" inputmode="numeric" aria-label="阶段数量" @change="clampStage" />
                      <button type="button" :disabled="stageCount >= 12" aria-label="增加一个阶段" @click="stepStage(1)"><Icon name="plus" /></button>
                    </div>
                  </div>
                </div>
                <p class="oc-sheet-warn"><Icon name="info" />{{ sheetWarning }}</p>
                <p v-if="sheetError" class="bbs-callout is-danger" role="alert">{{ sheetError }}</p>
                <button type="button" class="bbs-btn bbs-btn-primary oc-sheet-primary" :disabled="!canRefine || !stageValid" @click="confirmRefine">生成草稿</button>
                <button type="button" class="oc-sheet-back" @click="closeSheet">返回讨论</button>
              </section>
            </div>
          </Transition>
        </section>
      </div>
    </Transition>
  </Teleport>

  <ConfirmDialog v-model:open="clearOpen" title="清空讨论" confirm-text="清空" tone="danger" confirm-icon="trash" top-layer @confirm="confirmClear">
    只清空当前聊天的讨论记录，草稿、规划、札记和摘要均不受影响。
  </ConfirmDialog>
  <ConfirmDialog v-model:open="trimOpen" title="删除最早的一轮" confirm-text="删除" tone="danger" confirm-icon="trash" top-layer @confirm="confirmTrim">
    删除最早的一轮问答（你的提问和规划模型的回答），其余讨论保留，删除后无法恢复。草稿、规划、札记和摘要均不受影响。
  </ConfirmDialog>
</template>

<style scoped>
/* —— 页面内的入口卡片 —— */
.oc-entry { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; min-width: 0; margin: 12px 0; padding: 12px 14px; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius); background: var(--bbs-surface); }
.oc-entry-avatar, .oc-avatar { flex: 0 0 auto; border-radius: 50%; object-fit: cover; box-shadow: 0 0 0 1px var(--bbs-line); }
.oc-entry-avatar { width: 40px; height: 40px; }
.oc-entry-main { flex: 1 1 220px; min-width: 0; }
.oc-entry-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 650; line-height: 1.5; color: var(--bbs-ink); }
.oc-entry-count { padding: 0 8px; border-radius: var(--bbs-radius-pill); background: var(--bbs-surface-2); font-size: 11px; font-weight: 500; line-height: 1.7; color: var(--bbs-ink-muted); }
.oc-entry-text { display: -webkit-box; margin: 2px 0 0; overflow: hidden; font-size: 13px; line-height: 1.6; color: var(--bbs-ink-muted); overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.oc-entry-open { flex: 0 0 auto; margin-left: auto; }

/* —— 对话界面：桌面居中大窗，窄屏全屏 —— */
.oc-mask { position: fixed; top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100vh; height: 100dvh; z-index: 10001; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--bbs-overlay); }
.oc-panel { position: relative; display: flex; flex-direction: column; width: min(100%, 760px); height: min(100%, 860px); min-height: 0; overflow: hidden; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius-win); background: var(--bbs-bg); box-shadow: var(--bbs-shadow); color: var(--bbs-ink); font-family: var(--bbs-font-sans); font-size: 14px; line-height: 1.6; }
.oc-panel.is-max { width: 100%; height: 100%; }
.oc-panel:focus { outline: none; }
.oc-grabber { display: none; }

.oc-head { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--bbs-line); background: var(--bbs-surface); }
.oc-avatar { width: 38px; height: 38px; }
.oc-titles { flex: 1 1 auto; min-width: 0; }
.oc-titles h2 { margin: 0; font: 600 16px/1.4 var(--bbs-font-reading); letter-spacing: .04em; color: var(--bbs-ink); }
.oc-titles p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--bbs-ink-muted); }
.oc-titles p.is-typing { color: var(--bbs-accent); }
.oc-more { position: relative; }
.oc-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 3; display: flex; flex-direction: column; min-width: 168px; padding: 4px; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius); background: var(--bbs-surface); box-shadow: var(--bbs-shadow); }
.oc-menu-item { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 10px; border: 0; border-radius: var(--bbs-radius-sm); background: transparent; color: var(--bbs-ink); font-size: 13px; text-align: left; cursor: pointer; }
.oc-menu-item:hover:not(:disabled), .oc-menu-item:focus-visible { background: var(--bbs-surface-2); }
.oc-menu-item.is-danger { color: var(--bbs-danger); }
.oc-menu-item:disabled { color: var(--bbs-ink-muted); }

.oc-context { flex: 0 0 auto; padding: 10px 16px; border-bottom: 1px solid var(--bbs-line); background: var(--bbs-surface); }
.oc-ref { display: flex; align-items: center; width: fit-content; max-width: 100%; min-width: 0; padding-left: 12px; border: 1px solid var(--bbs-control-border); border-radius: var(--bbs-radius-pill); background: var(--bbs-surface); }
.oc-ref-label { flex: 0 0 auto; padding-right: 10px; border-right: 1px solid var(--bbs-line); font-size: 13px; line-height: 1.4; color: var(--bbs-ink-soft); }
.oc-ref-select { min-width: 0; max-width: 320px; }
.oc-ref :deep(.bbs-select-trigger) { min-height: 34px; padding: 6px 12px 6px 10px; border: 0; border-radius: 0 var(--bbs-radius-pill) var(--bbs-radius-pill) 0; background: transparent; }
.oc-info { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--bbs-ink-muted); }
.oc-info .bbs-icon, .oc-sheet-warn .bbs-icon { flex: 0 0 auto; font-size: 14px; }

.oc-foot { flex: 0 0 auto; padding: 10px 16px max(12px, env(safe-area-inset-bottom)); border-top: 1px solid var(--bbs-line); background: var(--bbs-surface); }
.oc-alerts { display: flex; flex-direction: column; gap: 6px; max-height: 32vh; overflow-y: auto; }
.oc-alerts:not(:empty) { margin-bottom: 10px; }
.oc-alerts .bbs-callout { margin: 0; font-size: 12.5px; }
.oc-alert-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.oc-alert-row > span { flex: 1 1 200px; min-width: 0; }
.oc-alert-row > .oc-alert-actions { flex: 0 0 auto; display: inline-flex; flex-wrap: wrap; gap: 6px; }
.oc-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--bbs-ink-muted); }
.oc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.oc-rounds { flex: 1 1 auto; font-size: 12px; color: var(--bbs-ink-muted); }
.oc-progress { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--bbs-accent); }
.oc-progress .bbs-spin { flex: 0 0 auto; }
.oc-bar .oc-draft { border-color: var(--bbs-accent); background: transparent; color: var(--bbs-accent); }
.oc-bar .oc-draft:hover:not(:disabled) { background: var(--bbs-accent-soft); }
.oc-bar .oc-draft:disabled { border-color: var(--bbs-line); color: var(--bbs-ink-muted); }
.oc-composer { display: flex; align-items: flex-end; gap: 8px; padding: 5px 5px 5px 16px; border: 1px solid var(--bbs-control-border); border-radius: 22px; background: var(--bbs-surface); }
.oc-composer:focus-within { border-color: var(--bbs-accent); box-shadow: 0 0 0 1px var(--bbs-accent); }
.oc-composer.is-disabled { background: var(--bbs-surface-2); }
.oc-input { flex: 1 1 auto; min-width: 0; min-height: 34px; max-height: 168px; margin: 0; padding: 6px 0; border: 0; outline: none; resize: none; background: transparent; color: var(--bbs-ink); font-size: 14px; line-height: 1.6; overflow-y: auto; }
.oc-input:focus-visible { outline: none; }
.oc-input::placeholder { color: var(--bbs-ink-muted); }
.oc-send { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; background: var(--bbs-accent); color: var(--bbs-accent-ink); font-size: 17px; cursor: pointer; }
.oc-send:disabled { background: var(--bbs-surface-2); color: var(--bbs-ink-muted); }
.oc-send.is-stop { background: var(--bbs-ink); color: var(--bbs-surface); }
.oc-caption { margin: 6px 0 0; font-size: 11px; line-height: 1.5; text-align: center; color: var(--bbs-ink-muted); }

/* —— 生成草稿的底部面板：盖在对话上，对话区变暗 —— */
.oc-scrim { position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 4; display: flex; align-items: flex-end; justify-content: center; padding: 0 12px 12px; background: var(--bbs-overlay); }
.oc-sheet { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 560px; max-height: calc(100% - 24px); overflow-y: auto; padding: 18px 18px 14px; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius-win); background: var(--bbs-surface); box-shadow: var(--bbs-shadow); }
.oc-sheet:focus { outline: none; }
.oc-sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.oc-sheet-head h3 { margin: 0; font: 600 17px/1.4 var(--bbs-font-reading); letter-spacing: .03em; color: var(--bbs-ink); }
.oc-sheet-head p { margin: 4px 0 0; font-size: 13px; line-height: 1.6; color: var(--bbs-ink-muted); }
.oc-sheet-card { display: flex; flex-direction: column; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius); background: var(--bbs-bg); }
.oc-sheet-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 12px 14px; }
.oc-sheet-row + .oc-sheet-row { border-top: 1px solid var(--bbs-line); }
.oc-sheet-label { display: flex; flex-direction: column; font-size: 14px; font-weight: 600; color: var(--bbs-ink); }
.oc-sheet-label small { margin-top: 2px; font-size: 12px; font-weight: 400; color: var(--bbs-ink-muted); }
.oc-sheet-select { flex: 1 1 200px; min-width: 0; max-width: 300px; }
.oc-stepper { display: inline-flex; align-items: center; overflow: hidden; border: 1px solid var(--bbs-control-border); border-radius: var(--bbs-radius-pill); background: var(--bbs-surface); }
.oc-stepper button { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 36px; padding: 0; border: 0; background: transparent; color: var(--bbs-ink-soft); font-size: 15px; cursor: pointer; }
.oc-stepper button:hover:not(:disabled) { background: var(--bbs-surface-2); color: var(--bbs-accent); }
.oc-stepper button:disabled { color: var(--bbs-line-strong); }
.oc-stepper input { width: 44px; height: 36px; padding: 0; border: 0; border-left: 1px solid var(--bbs-line); border-right: 1px solid var(--bbs-line); background: transparent; color: var(--bbs-ink); font-size: 15px; font-weight: 600; text-align: center; -moz-appearance: textfield; appearance: textfield; }
.oc-stepper input::-webkit-outer-spin-button, .oc-stepper input::-webkit-inner-spin-button { margin: 0; -webkit-appearance: none; }
.oc-sheet-warn { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--bbs-warning); }
.oc-sheet-warn .bbs-icon { margin-top: 3px; }
.oc-sheet .bbs-callout { margin: 0; }
.oc-sheet-primary { width: 100%; min-height: 42px; font-size: 14px; }
.oc-sheet-back { align-self: center; min-height: 36px; padding: 4px 12px; border: 0; border-radius: var(--bbs-radius-sm); background: transparent; color: var(--bbs-ink-soft); font-size: 13px; cursor: pointer; }
.oc-sheet-back:hover { color: var(--bbs-accent); }

.oc-mask :is(button, input, textarea):focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }

/* —— 进出场：桌面淡入并微升；窄屏、触屏与减少动效时 --bbs-dur 为 0，直接到终态 —— */
.oc-enter-active, .oc-leave-active { transition: opacity var(--bbs-dur) var(--bbs-ease); }
.oc-enter-active .oc-panel, .oc-leave-active .oc-panel { transition: transform var(--bbs-dur) var(--bbs-ease); }
.oc-enter-from, .oc-leave-to { opacity: 0; }
.oc-enter-from .oc-panel, .oc-leave-to .oc-panel { transform: translateY(10px) scale(.985); }
.oc-sheet-enter-active, .oc-sheet-leave-active { transition: opacity var(--bbs-dur) var(--bbs-ease); }
.oc-sheet-enter-active .oc-sheet, .oc-sheet-leave-active .oc-sheet { transition: transform var(--bbs-dur) var(--bbs-ease); }
.oc-sheet-enter-from, .oc-sheet-leave-to { opacity: 0; }
.oc-sheet-enter-from .oc-sheet, .oc-sheet-leave-to .oc-sheet { transform: translateY(24px); }

@media (max-width: 640px) {
  /* 与宝书窗口的手机抽屉一致：贴底，顶部留 4% 或状态栏高度再加 8px（取较大者），顶部有可下拉关闭的横条 */
  .oc-mask { padding: 0; align-items: flex-end; }
  .oc-panel, .oc-panel.is-max { width: 100%; height: 96%; height: calc(100% - max(4%, env(safe-area-inset-top, 0px) + 8px)); border: 0; border-radius: var(--bbs-radius-win) var(--bbs-radius-win) 0 0; transition: transform var(--bbs-dur) var(--bbs-ease); }
  .oc-grabber { display: flex; flex: 0 0 auto; align-items: center; justify-content: center; height: 18px; background: var(--bbs-surface); cursor: grab; touch-action: none; }
  .oc-grabber span { width: 30px; height: 3px; border-radius: var(--bbs-radius-pill); background: var(--bbs-line-strong); opacity: .65; }
  .oc-expand, .oc-shortcut { display: none; }
  .oc-head { padding: 2px 8px 8px 6px; }
  .oc-context { padding: 8px 12px; }
  .oc-foot { padding: 8px 12px max(10px, env(safe-area-inset-bottom)); }
  .oc-scrim { padding: 0; }
  .oc-sheet { max-width: none; max-height: calc(100% - 40px); padding: 16px 16px max(12px, env(safe-area-inset-bottom)); border-width: 1px 0 0; border-radius: var(--bbs-radius-win) var(--bbs-radius-win) 0 0; }
  .oc-sheet-select { max-width: none; }
}
@media (hover: none), (pointer: coarse) {
  .oc-shortcut { display: none; }
  .oc-send { width: 40px; height: 40px; }
  .oc-stepper button { width: 44px; height: 40px; }
  .oc-stepper input { height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .oc-enter-active, .oc-leave-active, .oc-enter-active .oc-panel, .oc-leave-active .oc-panel,
  .oc-sheet-enter-active, .oc-sheet-leave-active, .oc-sheet-enter-active .oc-sheet, .oc-sheet-leave-active .oc-sheet { transition: none; }
}
</style>
