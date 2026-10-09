<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { engineActiveHere } from '@/api/settings';
import { getContext } from '@/st/context';
import { outlineState } from '@/outline/store';
import { discussionState, clearOutlineDiscussion } from '@/outline/discussionStore';
import { captureOutlineSource, sameOutlineChat, type OutlineSource } from '@/outline/source';
import type { DiscussionTarget } from '@/outline/discussionContext';
import { discussionRun, sendOutlineDiscussion, cancelOutlineDiscussion, captureOutlineRefinement, generateOutline, outlineRun, cancelOutline } from '@/outline/service';

const props = defineProps<{ disabled: boolean; unsaved: boolean; configurationIssue: string; apiDirty: boolean }>();
const question = ref(''), target = ref<DiscussionTarget>('none'), stageCount = ref(6), refining = ref(false);
const error = ref(''), touchedTarget = ref(false);
let mounted = true;
onBeforeUnmount(() => { mounted = false; });
const record = computed(() => target.value === 'draft' ? outlineState.draft : target.value === 'active' ? outlineState.active : null);
const locked = computed(() => props.disabled || discussionRun.busy || discussionState.saving || outlineRun.busy
  || /只读|版本|格式/.test(discussionState.issue));
const available = computed(() => !locked.value && engineActiveHere() && !props.configurationIssue);
const canSend = computed(() => available.value && !!question.value.trim() && question.value.length <= 4000);
type Confirmation = { kind: 'refine' | 'clear'; source: OutlineSource; revision: number; discussionRevision: number; target: DiscussionTarget; count: number };
const confirmation = shallowRef<Confirmation | null>(null);
watch(() => [outlineState.active?.id, outlineState.draft?.id], () => {
  if (!touchedTarget.value) target.value = outlineState.active ? 'active' : outlineState.draft ? 'draft' : 'none';
  else if (target.value !== 'none' && !record.value) { target.value = 'none'; touchedTarget.value = false; }
}, { immediate: true });
watch(record, value => { stageCount.value = value?.content.chapters.length ?? 6; }, { immediate: true });
watch(() => [outlineState.revision, discussionState.revision, target.value, stageCount.value, question.value], () => {
  const request = confirmation.value;
  if (request && (!sameOutlineChat(request.source) || request.revision !== outlineState.revision
    || request.discussionRevision !== discussionState.revision || request.target !== target.value || request.count !== stageCount.value))
    confirmation.value = null;
});
// 切聊天清掉未发送输入与确认，普通新回复/草稿保存不清空用户正在输入的意见。
let chat = getContext() ? captureOutlineSource(getContext()!) : undefined;
watch(() => [outlineState.revision, discussionState.revision], () => {
  if (chat && sameOutlineChat(chat)) return;
  chat = getContext() ? captureOutlineSource(getContext()!) : undefined;
  question.value = ''; error.value = ''; confirmation.value = null; touchedTarget.value = false;
  target.value = outlineState.active ? 'active' : outlineState.draft ? 'draft' : 'none';
});
async function send() {
  if (!canSend.value) return;
  const ctx = getContext(); if (!ctx) return;
  const source = captureOutlineSource(ctx), text = question.value;
  error.value = ''; confirmation.value = null;
  const saved = await sendOutlineDiscussion(text, target.value);
  if (saved && mounted && sameOutlineChat(source) && question.value === text) question.value = '';
}
function request(kind: Confirmation['kind']) {
  if (locked.value || (kind === 'refine' && !available.value)) return;
  const ctx = getContext(); if (!ctx?.getCurrentChatId()) return;
  error.value = '';
  confirmation.value = { kind, source: captureOutlineSource(ctx), revision: outlineState.revision,
    discussionRevision: discussionState.revision, target: target.value, count: stageCount.value };
}
async function confirm() {
  const choice = confirmation.value;
  if (!choice || locked.value) return;
  confirmation.value = null;
  if (!sameOutlineChat(choice.source) || choice.revision !== outlineState.revision
    || choice.discussionRevision !== discussionState.revision || choice.target !== target.value || choice.count !== stageCount.value) {
    error.value = '聊天、讨论或规划已经变了，请重新核对。'; return;
  }
  try {
    if (choice.kind === 'clear') {
      await clearOutlineDiscussion(choice.discussionRevision);
      if (mounted && sameOutlineChat(choice.source)) { discussionRun.error = ''; discussionRun.errorDetail = ''; discussionRun.status = '讨论已清空。'; }
      return;
    }
    const reference = captureOutlineRefinement(choice.target);
    const previousDraftId = outlineState.draft?.id;
    refining.value = true;
    await generateOutline('根据所选大纲与讨论生成修订草稿。以讨论中用户最新明确意见为准，模型建议不等于已被采纳；保留未要求改动的合理内容与人物边界。没有现有大纲时按讨论整理初稿。不要把讨论当成剧情事实。', choice.count, reference);
    if (mounted && sameOutlineChat(choice.source) && !outlineRun.error && outlineState.draft && outlineState.draft.id !== previousDraftId) { target.value = 'draft'; touchedTarget.value = true; }
  } catch (cause) {
    if (mounted && sameOutlineChat(choice.source)) error.value = cause instanceof Error ? cause.message : '操作未完成，请重试。';
  } finally { refining.value = false; }
}
</script>

<template>
  <details class="bbs-disclosure is-card outline-discussion" aria-label="大纲讨论区">
    <summary>和模型讨论规划 <span v-if="discussionState.messages.length" class="bbs-disclosure-meta">{{ discussionState.messages.length / 2 }} 轮</span></summary>
    <p class="hint">先和模型聊聊人物动机、节奏或走向。讨论不会改动规划，也不会发给正文；想采纳时点「按讨论生成草稿」。</p>
    <p v-if="unsaved" class="bbs-callout is-warning">草稿有没保存的修改：讨论只会参考已保存的版本，按讨论生成草稿也会覆盖这些修改。</p>
    <p v-if="configurationIssue" class="bbs-callout is-warning">{{ configurationIssue }}</p>
    <p v-if="apiDirty" class="hint">API 设置还没保存，讨论会用上次保存的设置。</p>
    <label>参考哪个版本
      <select v-model="target" class="bbs-input" aria-label="讨论参考" :disabled="locked" @change="touchedTarget = true">
        <option v-if="outlineState.active" value="active">正在用的规划 · {{ outlineState.active.content.title }}</option>
        <option v-if="outlineState.draft" value="draft">草稿 · {{ outlineState.draft.content.title }}</option>
        <option value="none">不参考，先聊方向</option>
      </select>
    </label>
    <ol v-if="discussionState.messages.length" class="discussion-messages" aria-label="已保存的大纲讨论">
      <li v-for="(message, index) in discussionState.messages" :key="index" :class="message.role">
        <strong>{{ message.role === 'user' ? '你' : '模型' }}</strong>
        <div class="discussion-text">{{ message.content }}</div>
      </li>
    </ol>
    <p v-else class="hint">还没有讨论。可以问问：「这个转折会不会让角色太配合了？有没有更自然的走法？」</p>
    <label>你想聊的<textarea v-model="question" class="bbs-input" rows="4" maxlength="4000" :disabled="locked" placeholder="想保留什么、想改什么，或者先问问模型的看法。Ctrl+Enter 发送" @keydown.ctrl.enter.prevent="send" /></label>
    <div class="discussion-actions">
      <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canSend" @click="send">发送</button>
      <button v-if="discussionRun.busy" type="button" class="bbs-btn" :disabled="discussionState.saving" @click="cancelOutlineDiscussion">取消</button>
    </div>
    <p v-if="discussionRun.status" class="discussion-status" role="status">{{ discussionRun.status }}</p>
    <div v-if="error || discussionRun.error || discussionState.issue" class="bbs-callout is-danger" role="alert">
      <p>{{ error || discussionRun.error || discussionState.issue }}</p>
      <details v-if="!error && discussionRun.error && discussionRun.errorDetail"><summary>技术细节</summary><p>{{ discussionRun.errorDetail }}</p></details>
    </div>
    <div class="discussion-refine">
      <label>草稿分几个阶段（1–12）<input v-model.number="stageCount" class="bbs-input" type="number" min="1" max="12" step="1" :disabled="locked" /></label>
      <div class="discussion-actions">
        <button type="button" class="bbs-btn" :disabled="!available || !discussionState.messages.length || !Number.isInteger(stageCount) || stageCount < 1 || stageCount > 12" @click="request('refine')">按讨论生成草稿</button>
        <button type="button" class="bbs-btn" :disabled="locked || !discussionState.messages.length" @click="request('clear')">清空讨论</button>
        <button v-if="refining && outlineRun.busy" type="button" class="bbs-btn" @click="cancelOutline">取消生成</button>
      </div>
    </div>
    <div v-if="confirmation" class="discussion-confirmation">
      <p>{{ confirmation.kind === 'clear' ? '只清空这个聊天的讨论记录，草稿、规划、札记和摘要都不受影响。确定清空吗？' : '会再请求一次规划 API，按讨论生成新草稿，替换当前草稿（包括没保存的修改）。正在用的规划不受影响，新草稿也要你确认后才生效。' }}</p>
      <div class="discussion-actions">
        <button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked" @click="confirm">{{ confirmation.kind === 'clear' ? '清空' : '生成草稿' }}</button>
        <button type="button" class="bbs-btn" @click="confirmation = null">取消</button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.outline-discussion { min-width:0; max-width:100%; margin:12px 0; overflow-wrap:anywhere; font-size:13px; line-height:1.75; }
label { display:flex; flex-direction:column; gap:5px; margin:10px 0; min-width:0; font-size:12.5px; color:var(--bbs-ink-soft); }
.bbs-input { box-sizing:border-box; width:100%; min-width:0; max-width:100%; min-height:40px; font-size:13px; color:var(--bbs-ink); }
textarea { resize:vertical; font:inherit; }
.discussion-actions { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
.bbs-btn { min-height:38px; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.discussion-messages { list-style:none; margin:12px 0; padding:0; max-height:380px; overflow:auto; overscroll-behavior:contain; display:flex; flex-direction:column; gap:8px; }
.discussion-messages li { padding:10px 12px; border-radius:10px; background:var(--bbs-surface-2); }
.discussion-messages li strong { display:block; margin-bottom:2px; font-size:12px; color:var(--bbs-ink-muted); }
.discussion-messages .user { margin-left:12%; background:var(--bbs-accent-soft); }
.discussion-messages .user strong { color:var(--bbs-accent); }
.discussion-messages .assistant { margin-right:12%; }
.discussion-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.discussion-status { color:var(--bbs-accent); }
.discussion-refine { margin-top:6px; padding-top:6px; border-top:1px solid var(--bbs-line); }
.discussion-refine label { max-width:220px; }
.discussion-confirmation { padding:10px 14px; border-left:2px solid var(--bbs-accent); border-radius:0 8px 8px 0; background:var(--bbs-accent-soft); }
.hint { color:var(--bbs-ink-muted); font-size:12.5px; }
:is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--bbs-accent); outline-offset:2px; }
@media(max-width:480px) { .discussion-messages .user { margin-left:0; } .discussion-messages .assistant { margin-right:0; } .discussion-refine label { max-width:none; } }
</style>
