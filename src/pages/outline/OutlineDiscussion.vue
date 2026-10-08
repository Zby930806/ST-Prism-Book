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
    error.value = '聊天、讨论或大纲已变化，请重新核对。'; return;
  }
  try {
    if (choice.kind === 'clear') {
      await clearOutlineDiscussion(choice.discussionRevision);
      if (mounted && sameOutlineChat(choice.source)) { discussionRun.error = ''; discussionRun.status = '本聊天讨论已清空，草稿与已确认规划未改变。'; }
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
  <details class="outline-discussion" aria-label="大纲讨论区">
    <summary>与模型讨论大纲 <span v-if="discussionState.messages.length">· {{ discussionState.messages.length / 2 }} 轮</span></summary>
    <p>可商量动机、节奏、分支或修改方向。讨论与规划共用所选规划 API；聊天本身不会改大纲，也不会发进正文。</p>
    <p class="hint">记录随本聊天保存，最多12轮、合计48000字符；每次请求参考最近24000字符的完整问答。讨论后点击“按讨论生成草稿”，核对并确认加入计划才会生效。</p>
    <p v-if="unsaved" class="warning">编辑器有未保存修改：讨论只参考已保存版本。建议先保存，再讨论；生成修订草稿会替换旧草稿与未保存编辑。</p>
    <p v-if="configurationIssue" class="warning">{{ configurationIssue }} 请在下方“规划 API 设置”中配置。</p>
    <p v-if="apiDirty" class="hint">API 表单尚未保存；讨论使用已保存的渠道。</p>
    <label>讨论参考
      <select v-model="target" class="bbs-input" aria-label="讨论参考" :disabled="locked" @change="touchedTarget = true">
        <option v-if="outlineState.active" value="active">已确认规划 · {{ outlineState.active.content.title }}</option>
        <option v-if="outlineState.draft" value="draft">已保存草稿 · {{ outlineState.draft.content.title }}</option>
        <option value="none">先讨论方向（不参考现有大纲）</option>
      </select>
    </label>
    <ol v-if="discussionState.messages.length" class="discussion-messages" aria-label="已保存的大纲讨论">
      <li v-for="(message, index) in discussionState.messages" :key="index" :class="message.role">
        <strong>{{ message.role === 'user' ? '你' : '规划模型' }}</strong>
        <div class="discussion-text">{{ message.content }}</div>
      </li>
    </ol>
    <p v-else class="hint">还没有讨论。可以问：“这个转折会不会让角色突然变得太配合？有没有更自然的发展？”</p>
    <label>你的大纲意见<textarea v-model="question" class="bbs-input" rows="4" maxlength="4000" :disabled="locked" placeholder="说说想保留、想调整的地方，也可以先问模型的看法。" @keydown.ctrl.enter.prevent="send" /></label>
    <div class="discussion-actions">
      <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canSend" @click="send">发送讨论</button>
      <button v-if="discussionRun.busy" type="button" class="bbs-btn" :disabled="discussionState.saving" @click="cancelOutlineDiscussion">取消讨论</button>
    </div>
    <p v-if="discussionRun.status" role="status">{{ discussionRun.status }}</p>
    <p v-if="error || discussionRun.error || discussionState.issue" class="warning" role="alert">{{ error || discussionRun.error || discussionState.issue }}</p>
    <label>讨论修订阶段数（1–12）<input v-model.number="stageCount" class="bbs-input" type="number" min="1" max="12" step="1" :disabled="locked" /></label>
    <div class="discussion-actions">
      <button type="button" class="bbs-btn" :disabled="!available || !discussionState.messages.length || !Number.isInteger(stageCount) || stageCount < 1 || stageCount > 12" @click="request('refine')">按讨论生成草稿</button>
      <button type="button" class="bbs-btn" :disabled="locked || !discussionState.messages.length" @click="request('clear')">清空本聊天讨论</button>
      <button v-if="refining && outlineRun.busy" type="button" class="bbs-btn" @click="cancelOutline">取消修订生成</button>
    </div>
    <div v-if="confirmation" class="discussion-confirmation">
      <p>{{ confirmation.kind === 'clear' ? '只清空本聊天的讨论记录，不改草稿、已确认规划、札记或摘要。确定清空？' : '将再次调用规划 API，可能产生费用；成功后替换草稿和未保存编辑，不替换已确认规划。需要你另行确认加入计划。' }}</p>
      <div class="discussion-actions">
        <button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked" @click="confirm">{{ confirmation.kind === 'clear' ? '确认清空讨论' : '确认生成修订草稿' }}</button>
        <button type="button" class="bbs-btn" @click="confirmation = null">取消</button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.outline-discussion { min-width:0; max-width:100%; padding:12px; margin:12px 0; border:1px solid var(--bbs-line); border-radius:8px; background:var(--bbs-surface); overflow-wrap:anywhere; }
summary { cursor:pointer; min-height:44px; padding:10px 0; font-weight:600; }
label { display:flex; flex-direction:column; gap:5px; margin:10px 0; min-width:0; }
.bbs-input { box-sizing:border-box; width:100%; min-width:0; max-width:100%; min-height:44px; }
textarea { resize:vertical; font:inherit; }
.discussion-actions { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
.bbs-btn { min-height:44px; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.discussion-messages { list-style:none; margin:12px 0; padding:0; max-height:360px; overflow:auto; overscroll-behavior:contain; }
.discussion-messages li { margin:8px 0; padding:10px; border:1px solid var(--bbs-line); border-radius:8px; }
.discussion-messages .user { border-left:3px solid var(--bbs-accent); }
.discussion-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.discussion-confirmation { padding:10px; border-left:2px solid var(--bbs-accent); background:var(--bbs-accent-soft); }
.hint { color:var(--bbs-ink-muted); font-size:11px; }.warning { color:var(--bbs-danger); }
:is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--bbs-accent); outline-offset:2px; }
</style>
