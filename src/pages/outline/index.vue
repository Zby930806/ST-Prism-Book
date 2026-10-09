<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import OutlineDiscussion from './OutlineDiscussion.vue';
import { getContext } from '@/st/context';
import type { ApiChannel } from '@/api/settings';
import { engineActiveHere } from '@/api/settings';
import type { OutlineContent, OutlineDraft } from '@/outline/types';
import { OUTLINE_LIMITS as L } from '@/outline/limits';
import { validateOutlineContent } from '@/outline/protocol';
import { outlineSettings, outlineSettingsIssue, resolveOutlineChannel, saveOutlineSettings } from '@/outline/settings';
import { outlineRun, generateOutline, cancelOutline, discussionRun } from '@/outline/service';
import { discussionState } from '@/outline/discussionStore';
import {
  outlineState, saveOutlineDraft, activateOutlineDraft, setOutlineEnabled,
  setOutlineChapter, reconfirmOutline, outlineSourceCurrent,
} from '@/outline/store';
import { useNotesModelCatalog } from '@/notes/modelCatalog';

type Editor = Omit<OutlineContent, 'constraints' | 'chapters'> & {
  constraints: string;
  chapters: Array<{ title: string; goal: string; approach: string; beats: string; exitCriteria: string }>;
};
const props = defineProps<{ disabled?: boolean }>();
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
function captureChat() {
  const ctx = getContext();
  return { chat: ctx?.chat, metadata: ctx?.chatMetadata, id: ctx?.getCurrentChatId(), character: ctx?.characterId, group: ctx?.groupId };
}
type Chat = ReturnType<typeof captureChat>;
let mounted = true;
function sameChat(snapshot: Chat): boolean {
  const now = captureChat();
  return mounted && !!now.id && now.chat === snapshot.chat && now.metadata === snapshot.metadata && now.id === snapshot.id
    && now.character === snapshot.character && now.group === snapshot.group;
}
onBeforeUnmount(() => { mounted = false; });

const brief = ref('');
const chapterCount = ref(6);
const editor = ref<Editor | null>(null);
const editBrief = ref('');
const selectedChapter = ref(0);
const currentEdit = computed(() => editor.value?.chapters[selectedChapter.value]);
const expectedRevision = ref(-1);
let editorChat = captureChat();
let draftId: string | null = null;
const baseline = ref('');
const editorFingerprint = () => JSON.stringify([editor.value, editBrief.value]);
const dirty = computed(() => !!editor.value && editorFingerprint() !== baseline.value);
const error = ref('');
const notice = ref('');
const pending = ref(false);
const generating = ref(false);
const protectedData = computed(() => /版本|格式|只读|保护/.test(outlineState.issue));
const protectedSettings = computed(() => /版本|格式|只读|保护/.test(outlineSettingsIssue.value));
const engineEnabled = computed(() => engineActiveHere());
const locked = computed(() => !!props.disabled || protectedData.value || pending.value || generating.value || outlineRun.busy || outlineState.saving || discussionRun.busy || discussionState.saving);
const active = computed(() => outlineState.active);
const currentStage = computed(() => active.value?.content.chapters[active.value.currentChapter]);
function sourceCurrent(record: OutlineDraft): boolean {
  void outlineState.revision;
  return outlineSourceCurrent(record);
}
const activeCurrent = computed(() => !!active.value && sourceCurrent(active.value));
const draftCurrent = computed(() => !!outlineState.draft && sourceCurrent(outlineState.draft));

type Confirmation = { kind: 'generate' | 'activate' | 'reconfirm'; revision: number; id: string | null; chat: Chat };
// 聊天快照保留原始引用，不能被深层响应式代理改变身份比较。
const confirmation = shallowRef<Confirmation | null>(null);
function loadEditor() {
  const draft = outlineState.draft;
  editor.value = draft ? {
    title: draft.content.title, premise: draft.content.premise, constraints: draft.content.constraints.join('\n'),
    chapters: draft.content.chapters.map(stage => ({ ...stage, beats: stage.beats.join('\n') })),
  } : null;
  editBrief.value = draft?.brief ?? '';
  draftId = draft?.id ?? null;
  expectedRevision.value = outlineState.revision;
  editorChat = captureChat();
  selectedChapter.value = 0;
  baseline.value = editorFingerprint();
}
// 合并同一轮 store 的字段更新后再载入；保存时仍同步校验 revision 和聊天身份。
watch(() => [outlineState.revision, outlineState.draft?.id], () => {
  const switched = !sameChat(editorChat);
  const discarded = dirty.value;
  confirmation.value = null;
  loadEditor();
  if (switched) { brief.value = ''; chapterCount.value = 6; error.value = ''; notice.value = ''; }
  if (discarded && !pending.value) notice.value = '聊天或规划已经变了，之前没保存的修改已作废，请在重新载入的草稿上编辑。';
}, { immediate: true });
watch([brief, chapterCount], () => { if (confirmation.value?.kind === 'generate') confirmation.value = null; });
watch([editor, editBrief], () => { if (confirmation.value?.kind === 'activate') confirmation.value = null; }, { deep: true });
watch(() => props.disabled, disabled => { if (disabled) confirmation.value = null; });

async function runAction(action: () => Promise<void>, success: string) {
  if (locked.value) return;
  if (!sameChat(editorChat) || expectedRevision.value !== outlineState.revision) {
    confirmation.value = null;
    error.value = '聊天或规划已经变了，请等重新载入后再操作，这次没有改动任何内容。';
    return;
  }
  const chat = captureChat();
  pending.value = true;
  error.value = ''; notice.value = ''; confirmation.value = null;
  try { await action(); if (sameChat(chat)) notice.value = success; }
  catch (cause) { if (sameChat(chat)) error.value = errorText(cause); }
  finally { pending.value = false; }
}
function requireEditor() {
  if (!sameChat(editorChat) || expectedRevision.value !== outlineState.revision || draftId !== outlineState.draft?.id) {
    throw new Error('聊天或规划已经变了，请重新载入后再编辑，刚才的修改没有保存。');
  }
}
function contentForSave(): OutlineContent {
  const value = editor.value;
  if (!value) throw new Error('没有可保存的规划草稿。');
  const content: OutlineContent = {
    title: value.title.trim(), premise: value.premise.trim(), constraints: lines(value.constraints),
    chapters: value.chapters.map(stage => ({ title: stage.title.trim(), goal: stage.goal.trim(), approach: stage.approach.trim(), beats: lines(stage.beats), exitCriteria: stage.exitCriteria.trim() })),
  };
  try { return validateOutlineContent(content); }
  catch (cause) {
    // 与模型回复、持久化校验共用同一协议，自动定位有问题的编辑阶段。
    const match = errorText(cause).match(/chapters\[(\d+)\]/);
    if (match) selectedChapter.value = Number(match[1]);
    throw cause;
  }
}
function saveDraft() {
  return runAction(async () => {
    requireEditor();
    await saveOutlineDraft(contentForSave(), editBrief.value, expectedRevision.value);
  }, '草稿已保存。确认加入计划后才会生效。');
}
function addStage() {
  if (locked.value || !editor.value || editor.value.chapters.length >= 12) return;
  editor.value.chapters.push({ title: '', goal: '', approach: '', beats: '', exitCriteria: '' });
  selectedChapter.value = editor.value.chapters.length - 1;
}
function removeStage() {
  if (locked.value || !editor.value || editor.value.chapters.length <= 1) return;
  editor.value.chapters.splice(selectedChapter.value, 1);
  selectedChapter.value = Math.min(selectedChapter.value, editor.value.chapters.length - 1);
}
function requestConfirmation(kind: Confirmation['kind']) {
  if (locked.value) return;
  error.value = ''; notice.value = '';
  if (kind === 'activate') {
    if (dirty.value) { error.value = '草稿还有没保存的修改，请先保存再加入计划。'; return; }
    try { requireEditor(); } catch (cause) { error.value = errorText(cause); return; }
    if (!draftCurrent.value) { error.value = '草稿生成后剧情有变动，请核对草稿、重新保存后再加入计划。'; return; }
  }
  confirmation.value = { kind, revision: outlineState.revision, id: kind === 'activate' ? outlineState.draft?.id ?? null : active.value?.id ?? null, chat: captureChat() };
}
function validConfirmation(kind: Confirmation['kind']): Confirmation | null {
  const request = confirmation.value;
  confirmation.value = null;
  if (!request || request.kind !== kind || !sameChat(request.chat) || request.revision !== outlineState.revision) {
    error.value = '聊天或规划已经变了，请重新核对后再确认。'; return null;
  }
  return request;
}
function confirmActivate() {
  if (locked.value) return;
  const request = validConfirmation('activate');
  if (!request?.id) return;
  return runAction(async () => {
    requireEditor();
    if (dirty.value) throw new Error('请先保存修改，再加入计划。');
    await activateOutlineDraft(request.id!);
  }, '已加入创作规划，从第一阶段开始。');
}
function confirmReconfirm() {
  if (locked.value) return;
  const request = validConfirmation('reconfirm');
  if (!request || request.id !== active.value?.id) return;
  return runAction(reconfirmOutline, '已按当前剧情重新启用，继续当前阶段。');
}
function toggleActive() {
  const value = active.value;
  if (!value) return;
  return runAction(() => setOutlineEnabled(!value.enabled), value.enabled ? '规划已暂停，不再交给正文模型。' : '规划已继续。');
}
function moveStage(index: number) {
  return runAction(() => setOutlineChapter(index), index === active.value?.content.chapters.length
    ? '规划已结束，不再交给正文模型。' : '已切换到新的阶段。');
}

const apiDraft = reactive(copy(outlineSettings.channel));
const apiMode = ref(outlineSettings.apiMode);
const apiBaseline = ref(JSON.stringify([apiMode.value, apiDraft]));
const apiDirty = computed(() => JSON.stringify([apiMode.value, apiDraft]) !== apiBaseline.value);
const apiOpen = ref(false);
const { models, loading: modelsLoading, message: modelsMessage, error: modelsError, pull: pullModels, cancel: cancelModels } = useNotesModelCatalog(apiDraft);
const modelSearch = ref('');
const matchingModels = computed(() => models.value.filter(model => model.toLowerCase().includes(modelSearch.value.trim().toLowerCase())));
const visibleModels = computed(() => matchingModels.value.slice(0, 200));
watch(() => [apiDraft.url, apiDraft.key], () => { modelSearch.value = ''; });
watch(apiMode, cancelModels);
watch(outlineSettings, () => {
  if (apiDirty.value) return;
  Object.assign(apiDraft, copy(outlineSettings.channel)); apiMode.value = outlineSettings.apiMode;
  apiBaseline.value = JSON.stringify([apiMode.value, apiDraft]);
}, { deep: true });
function channelIssue(channel: ApiChannel): string {
  if (!channel.url.trim() || !channel.model.trim()) return '请填写 API 地址和模型名。';
  try {
    const url = new URL(channel.url.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#\\\s]/.test(channel.url.trim())) throw new Error();
  } catch { return 'API 地址要写完整的 http(s) 地址，不能带账号、? 参数或 #。'; }
  if (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2) return '温度要在 0–2 之间。';
  if (!Number.isSafeInteger(channel.maxTokens) || channel.maxTokens < 256 || channel.maxTokens > 65535) return '最大输出要是 256–65535 之间的整数。';
  if (!Number.isSafeInteger(channel.timeoutSec) || channel.timeoutSec < 10 || channel.timeoutSec > 600) return '超时要是 10–600 之间的整数（秒）。';
  return '';
}
const configurationIssue = computed(() => {
  try { return channelIssue(resolveOutlineChannel()); }
  catch (cause) { return errorText(cause); }
});
function saveApi() {
  if (locked.value || protectedSettings.value) return;
  error.value = ''; notice.value = '';
  const issue = apiMode.value === 'independent' ? channelIssue(apiDraft) : '';
  if (issue) { error.value = issue; return; }
  const previous = copy(outlineSettings);
  try {
    outlineSettings.apiMode = apiMode.value;
    outlineSettings.channel = copy(apiDraft);
    saveOutlineSettings();
    Object.assign(apiDraft, copy(outlineSettings.channel)); apiMode.value = outlineSettings.apiMode;
    apiBaseline.value = JSON.stringify([apiMode.value, apiDraft]);
    notice.value = '规划 API 设置已保存。';
  } catch (cause) { Object.assign(outlineSettings, previous); error.value = errorText(cause); }
}
const canGenerate = computed(() => engineEnabled.value && !locked.value && !protectedSettings.value && !configurationIssue.value
  && !!brief.value.trim() && brief.value.length <= 8000 && Number.isInteger(chapterCount.value) && chapterCount.value >= 1 && chapterCount.value <= 12);
async function startGeneration(confirmed = false) {
  if (!canGenerate.value) return;
  if (!sameChat(editorChat) || expectedRevision.value !== outlineState.revision) {
    confirmation.value = null;
    error.value = '聊天或规划已经变了，请在当前聊天重新填写要求。';
    return;
  }
  if (outlineState.draft || active.value) {
    if (!confirmed) { requestConfirmation('generate'); return; }
    if (!validConfirmation('generate')) return;
  }
  const chat = captureChat();
  generating.value = true; error.value = ''; notice.value = '';
  try { await generateOutline(brief.value.trim(), chapterCount.value); }
  catch (cause) { if (sameChat(chat)) error.value = errorText(cause); }
  finally { generating.value = false; }
}
</script>

<template>
  <div class="outline-planner">
    <div class="feedback" aria-live="polite">
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="outlineRun.status" role="status">{{ outlineRun.status }}</p>
    </div>
    <div v-if="error || outlineRun.error || outlineState.issue || outlineSettingsIssue" class="bbs-callout is-danger" role="alert">
      <p v-if="error">{{ error }}</p><p v-if="outlineRun.error">{{ outlineRun.error }}</p>
      <p v-if="outlineState.issue">{{ outlineState.issue }}</p><p v-if="outlineSettingsIssue">{{ outlineSettingsIssue }}</p>
      <details v-if="outlineRun.error && outlineRun.errorDetail"><summary>技术细节</summary><p>{{ outlineRun.errorDetail }}</p></details>
    </div>
    <p v-if="disabled" class="hint">记忆处于只读保护，暂时不能修改规划。</p>
    <p v-if="!engineEnabled" class="hint">当前角色没有启用棱镜宝书：可以查看规划，但不会生成，也不会交给正文。</p>

    <section v-if="active" class="planner-card planner-active" aria-label="已确认的创作规划">
      <header class="planner-active-head">
        <h3>{{ active.content.title }}</h3>
        <span class="planner-state" :class="{ 'is-on': currentStage && engineEnabled && activeCurrent && active.enabled }">{{ !currentStage ? '已结束' : !engineEnabled ? '未启用' : !activeCurrent ? '剧情有改动，已暂停' : active.enabled ? '正在生效' : '已暂停' }}</span>
      </header>
      <p v-if="!currentStage" class="hint">规划已经全部走完，不再交给正文模型。</p>
      <template v-else>
        <p class="planner-stage-line">第 {{ active.currentChapter + 1 }} / {{ active.content.chapters.length }} 阶段 · {{ currentStage.title }}</p>
        <dl class="planner-stage">
          <div><dt>阶段目标</dt><dd class="plain">{{ currentStage.goal }}</dd></div>
          <div><dt>剧情要点</dt><dd><ul><li v-for="(beat, index) in currentStage.beats" :key="index">{{ beat }}</li></ul></dd></div>
          <div><dt>发展方式</dt><dd class="plain">{{ currentStage.approach }}</dd></div>
          <div><dt>推进条件</dt><dd class="plain">{{ currentStage.exitCriteria }}</dd></div>
        </dl>
      </template>
      <div class="actions">
        <button v-if="currentStage && (activeCurrent || active.enabled)" type="button" class="bbs-btn" :disabled="locked" @click="toggleActive">{{ active.enabled ? '暂停规划' : '继续规划' }}</button>
        <button v-if="currentStage && !activeCurrent" type="button" class="bbs-btn" :disabled="locked" @click="requestConfirmation('reconfirm')">核对后重新启用</button>
        <button type="button" class="bbs-btn" :disabled="locked || active.currentChapter === 0" @click="moveStage(active.currentChapter - 1)">上一阶段</button>
        <button v-if="currentStage" type="button" class="bbs-btn" :disabled="locked" @click="moveStage(active.currentChapter + 1)">{{ active.currentChapter + 1 === active.content.chapters.length ? '结束规划' : '下一阶段' }}</button>
      </div>
      <p class="hint">阶段由你手动切换；切换只代表规划进度，不代表剧情已经发生。</p>
      <div v-if="confirmation?.kind === 'reconfirm'" class="confirmation">
        <p>先对照当前剧情看一遍下面的各阶段。确认后会以当前剧情为准，重新启用当前阶段。</p>
        <div class="actions"><button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked" @click="confirmReconfirm">已核对，重新启用</button><button type="button" class="bbs-btn" @click="confirmation = null">取消</button></div>
      </div>
      <details class="bbs-disclosure all-stages">
        <summary>全部阶段 <span class="bbs-disclosure-meta">{{ active.content.chapters.length }} 个</span></summary>
        <p class="plain">{{ active.content.premise }}</p>
        <ul v-if="active.content.constraints.length"><li v-for="(constraint, index) in active.content.constraints" :key="index">{{ constraint }}</li></ul>
        <ol class="stage-list">
          <li v-for="(stage, index) in active.content.chapters" :key="index">
            <h4>{{ stage.title }} <span class="hint">{{ index < active.currentChapter ? '已过' : index === active.currentChapter ? '当前' : '未开始' }}</span></h4>
            <p class="plain"><strong>阶段目标：</strong>{{ stage.goal }}</p>
            <ul><li v-for="(beat, beatIndex) in stage.beats" :key="beatIndex">{{ beat }}</li></ul>
            <p class="plain"><strong>发展方式：</strong>{{ stage.approach }}</p>
            <p class="plain"><strong>推进条件：</strong>{{ stage.exitCriteria }}</p>
          </li>
        </ol>
      </details>
    </section>

    <OutlineDiscussion :disabled="locked" :unsaved="dirty" :configuration-issue="configurationIssue" :api-dirty="apiDirty" />
    <details class="bbs-disclosure is-card planner-workbench">
      <summary>{{ active ? '修改或重新生成规划' : '生成规划草稿' }}<span v-if="dirty" class="bbs-disclosure-meta">有未保存的修改</span></summary>
      <p class="hint">写下你希望故事怎么发展，模型会结合当前剧情给出分阶段的草稿；你可以修改，确认加入计划后才生效。</p>
      <section class="planner-section" aria-label="生成规划草稿">
        <fieldset :disabled="locked">
          <label>你希望怎么发展<textarea v-model="brief" class="bbs-input" rows="4" maxlength="8000" placeholder="比如人物关系往哪走、想要的转折、节奏、不想出现的情节……会结合当前剧情来规划。" /></label>
          <div class="planner-row">
            <label class="planner-count">分几个阶段（1–12）<input v-model.number="chapterCount" class="bbs-input" type="number" min="1" max="12" step="1" inputmode="numeric" /></label>
            <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="startGeneration()">{{ outlineState.draft || active ? '重新生成规划草稿' : '生成规划草稿' }}</button>
          </div>
        </fieldset>
        <button v-if="outlineRun.busy || generating" type="button" class="bbs-btn" @click="cancelOutline">取消生成</button>
        <p v-if="configurationIssue" class="bbs-callout is-warning">{{ configurationIssue }} <button type="button" class="bbs-btn bbs-btn-sm" @click="apiOpen = true">打开规划 API 设置</button></p>
        <p v-if="apiDirty" class="hint">API 设置还没保存，生成会用上次保存的设置。</p>
        <div v-if="confirmation?.kind === 'generate'" class="confirmation">
          <p>重新生成会再请求一次 API。成功后会替换当前草稿（包括没保存的修改），正在用的规划不受影响。</p>
          <div class="actions"><button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="startGeneration(true)">确认重新生成</button><button type="button" class="bbs-btn" @click="confirmation = null">取消</button></div>
        </div>
        <pre v-if="outlineRun.draft" class="stream" aria-label="正在生成的草稿">{{ outlineRun.draft }}</pre>
      </section>

      <section v-if="editor" class="planner-section" aria-label="未确认的规划草稿编辑器">
        <h3>规划草稿 <span class="hint">{{ dirty ? '有未保存的修改' : '已保存，还没加入计划' }}</span></h3>
        <p v-if="!draftCurrent" class="bbs-callout is-warning">草稿生成后剧情有变动，请核对后重新保存再加入计划。</p>
        <fieldset :disabled="locked">
          <label>规划标题<input v-model="editor.title" class="bbs-input" :maxlength="L.title" /></label>
          <label>整体发展方向<textarea v-model="editor.premise" class="bbs-input" rows="3" :maxlength="L.premise" /></label>
          <label>整体约束（每行一条）<textarea v-model="editor.constraints" class="bbs-input" rows="3" /></label>
          <label>当时的要求<textarea v-model="editBrief" class="bbs-input" rows="3" maxlength="8000" /></label>
          <div class="planner-row">
            <label class="planner-stage-pick">编辑哪个阶段<select v-model.number="selectedChapter" class="bbs-input"><option v-for="(stage, index) in editor.chapters" :key="index" :value="index">{{ index + 1 }} · {{ stage.title || '未命名阶段' }}</option></select></label>
            <div class="actions"><button type="button" class="bbs-btn" :disabled="editor.chapters.length >= 12" @click="addStage">新增阶段</button><button type="button" class="bbs-btn" :disabled="editor.chapters.length <= 1" @click="removeStage">删除这个阶段</button></div>
          </div>
          <div v-if="currentEdit" class="stage-editor">
            <label>阶段标题<input v-model="currentEdit.title" class="bbs-input" :maxlength="L.title" /></label>
            <label>阶段目标<textarea v-model="currentEdit.goal" class="bbs-input" rows="3" :maxlength="L.goal" /></label>
            <label>剧情要点（每行一条）<textarea v-model="currentEdit.beats" class="bbs-input" rows="5" /></label>
            <label>发展方式<textarea v-model="currentEdit.approach" class="bbs-input" rows="4" :maxlength="L.approach" /></label>
            <label>推进条件<textarea v-model="currentEdit.exitCriteria" class="bbs-input" rows="3" :maxlength="L.exitCriteria" /></label>
          </div>
          <div class="actions"><button type="button" class="bbs-btn" @click="saveDraft">保存草稿</button><button type="button" class="bbs-btn bbs-btn-primary" @click="requestConfirmation('activate')">确认加入计划</button></div>
        </fieldset>
        <p v-if="dirty" class="hint">保存修改后才能加入计划。</p>
        <div v-if="confirmation?.kind === 'activate'" class="confirmation">
          <p>把这份草稿设为当前的创作规划，从第一阶段开始；之前确认的规划会被替换。</p>
          <div class="actions"><button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked || dirty" @click="confirmActivate">加入并启用</button><button type="button" class="bbs-btn" @click="confirmation = null">取消</button></div>
        </div>
      </section>

      <details class="bbs-disclosure planner-api" :open="apiOpen" @toggle="apiOpen = ($event.target as HTMLDetailsElement).open">
        <summary>规划 API 设置 <span class="bbs-disclosure-meta">{{ outlineSettings.apiMode === 'notes' ? '用札记的 API' : '专用 API' }}</span></summary>
        <p class="hint">默认直接用札记填好的 API（不需要打开札记功能），也可以给规划单独设一个。改完点保存才生效；密钥保存在酒馆的扩展设置里，分享设置备份前记得删掉。</p>
        <form @submit.prevent="saveApi">
          <fieldset :disabled="locked || protectedSettings">
            <label>用哪个 API<select v-model="apiMode" class="bbs-input" aria-label="API 模式"><option value="notes">用札记的 API（默认）</option><option value="independent">规划专用 API</option></select></label>
            <template v-if="apiMode === 'independent'">
              <label>API 地址<input v-model="apiDraft.url" class="bbs-input" type="url" required autocomplete="off" spellcheck="false" placeholder="https://your-api.example/v1" /></label>
              <label>API 密钥<input v-model="apiDraft.key" class="bbs-input" type="password" autocomplete="new-password" spellcheck="false" /></label>
              <div class="actions"><button type="button" class="bbs-btn" :disabled="modelsLoading || !apiDraft.url.trim()" @click="pullModels">{{ modelsLoading ? '拉取中…' : '拉取模型列表' }}</button><button v-if="modelsLoading" type="button" class="bbs-btn" @click="cancelModels">取消拉取</button></div>
              <label v-if="models.length">搜索模型<input v-model="modelSearch" class="bbs-input" type="search" /></label>
              <label>从列表选择<select class="bbs-input" aria-label="模型下拉选择" :value="visibleModels.includes(apiDraft.model) ? apiDraft.model : ''" :disabled="!visibleModels.length || modelsLoading" @change="apiDraft.model = ($event.target as HTMLSelectElement).value"><option value="" disabled>{{ models.length ? '选择一个模型' : '先拉取列表，或直接在下面填写' }}</option><option v-for="model in visibleModels" :key="model" :value="model">{{ model }}</option></select></label>
              <p v-if="matchingModels.length > 200" class="hint">只显示前 200 个，可以搜索缩小范围。</p>
              <label>模型名<input v-model="apiDraft.model" class="bbs-input" required autocomplete="off" spellcheck="false" /></label>
              <p v-if="modelsMessage" class="hint" role="status">{{ modelsMessage }}</p><p v-if="modelsError" class="bbs-callout is-warning" role="alert">{{ modelsError }}</p>
              <div class="planner-grid">
                <label>温度<input v-model.number="apiDraft.temperature" class="bbs-input" type="number" required min="0" max="2" step="0.1" /></label>
                <label>最大输出 tokens<input v-model.number="apiDraft.maxTokens" class="bbs-input" type="number" required min="256" max="65535" step="1" /></label>
                <label>超时（秒）<input v-model.number="apiDraft.timeoutSec" class="bbs-input" type="number" required min="10" max="600" step="1" /></label>
              </div>
              <label class="checkbox"><input v-model="apiDraft.stream" type="checkbox" class="bbs-switch" />流式输出</label>
            </template>
            <button type="submit" class="bbs-btn bbs-btn-primary">保存</button>
          </fieldset>
        </form>
      </details>
    </details>
  </div>
</template>

<style scoped>
.outline-planner { min-width:0; max-width:100%; margin:6px 0 0; color:var(--bbs-ink); font-size:13px; line-height:1.75; overflow-wrap:anywhere; }
.outline-planner *, .outline-planner *::before, .outline-planner *::after { box-sizing:border-box; }
.planner-card { min-width:0; margin:12px 0; padding:16px 18px; background:var(--bbs-surface); border:1px solid var(--bbs-line); border-radius:12px; }
.planner-active { border-left:3px solid var(--bbs-accent); }
.planner-active-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.planner-state { padding:2px 10px; border-radius:var(--bbs-radius-pill); background:var(--bbs-surface-2); font-size:12px; color:var(--bbs-ink-muted); }
.planner-state.is-on { background:var(--bbs-accent-soft); color:var(--bbs-accent); }
.planner-stage-line { margin:6px 0 10px; font-weight:600; color:var(--bbs-ink-soft); }
.planner-stage { display:grid; gap:10px; margin:0; }
.planner-stage > div { display:grid; grid-template-columns:72px minmax(0,1fr); gap:10px; }
.planner-stage dt { font-size:12px; line-height:1.9; color:var(--bbs-ink-muted); }
.planner-stage dd { margin:0; min-width:0; }
.planner-stage ul { margin:0; padding-left:18px; }
.planner-section { margin:12px 0 4px; }
.planner-section + .planner-section { padding-top:14px; border-top:1px solid var(--bbs-line); }
.planner-row { display:flex; align-items:flex-end; flex-wrap:wrap; gap:10px 14px; }
.planner-row .actions { margin:0 0 10px; }
.planner-count { flex:0 1 180px; }
.planner-stage-pick { flex:1 1 220px; }
.planner-row > .bbs-btn { margin-bottom:10px; }
.planner-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr)); gap:0 12px; }
.planner-api { margin-top:10px; border-top:1px solid var(--bbs-line); }
.outline-planner h3 { margin:0; font-size:15px; font-weight:650; }
.outline-planner h4 { margin:8px 0; font-size:13px; }
.outline-planner p { margin:8px 0; }
.outline-planner ul,.outline-planner ol { padding-left:20px; }
.outline-planner fieldset { min-width:0; margin:0; padding:0; border:0; }
.outline-planner label { display:flex; flex-direction:column; gap:5px; min-width:0; margin:10px 0; font-size:12.5px; color:var(--bbs-ink-soft); }
.outline-planner .bbs-input { display:block; width:100%; min-width:0; max-width:100%; min-height:40px; font-size:13px; color:var(--bbs-ink); }
.outline-planner textarea { resize:vertical; line-height:1.7; font:inherit; }
.outline-planner .checkbox { flex-direction:row; align-items:center; gap:10px; min-height:40px; }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
.outline-planner .bbs-btn { min-width:44px; min-height:38px; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.hint { color:var(--bbs-ink-muted); font-size:12.5px; font-weight:400; }
.feedback { color:var(--bbs-accent); font-size:13px; }
.feedback p:empty { display:none; }
.confirmation { padding:10px 14px; margin:12px 0; border-left:2px solid var(--bbs-accent); border-radius:0 8px 8px 0; background:var(--bbs-accent-soft); }
.stream { white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; padding:10px 12px; border-radius:8px; background:var(--bbs-surface-2); font:12px/1.7 var(--bbs-font-mono); }
.plain { white-space:pre-wrap; }
.stage-editor { border-top:1px solid var(--bbs-line); margin-top:12px; }
.stage-list > li + li { border-top:1px solid var(--bbs-line); margin-top:12px; padding-top:6px; }
.outline-planner :is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--bbs-accent); outline-offset:2px; }
@media(max-width:480px) { .planner-card { padding:14px; } .planner-stage > div { grid-template-columns:minmax(0,1fr); gap:2px; } }
@media(max-width:360px) { .planner-card { padding:10px; } .actions { gap:6px; } }
</style>
