<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import { getContext } from '@/st/context';
import type { ApiChannel } from '@/api/settings';
import { engineActiveHere } from '@/api/settings';
import type { OutlineContent, OutlineDraft } from '@/outline/types';
import { OUTLINE_LIMITS as L } from '@/outline/limits';
import { validateOutlineContent } from '@/outline/protocol';
import { outlineSettings, outlineSettingsIssue, resolveOutlineChannel, saveOutlineSettings } from '@/outline/settings';
import { outlineRun, generateOutline, cancelOutline } from '@/outline/service';
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
const locked = computed(() => !!props.disabled || protectedData.value || pending.value || generating.value || outlineRun.busy || outlineState.saving);
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
  if (discarded && !pending.value) notice.value = '聊天或规划版本已变化，旧编辑已失效；请基于重新载入的草稿编辑，未写入其他聊天。';
}, { immediate: true });
watch([brief, chapterCount], () => { if (confirmation.value?.kind === 'generate') confirmation.value = null; });
watch([editor, editBrief], () => { if (confirmation.value?.kind === 'activate') confirmation.value = null; }, { deep: true });
watch(() => props.disabled, disabled => { if (disabled) confirmation.value = null; });

async function runAction(action: () => Promise<void>, success: string) {
  if (locked.value) return;
  if (!sameChat(editorChat) || expectedRevision.value !== outlineState.revision) {
    confirmation.value = null;
    error.value = '聊天或规划版本已变化，请在重新载入后操作；未修改任何内容。';
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
    throw new Error('聊天或规划版本已变化，请重新载入后编辑；旧内容未保存。');
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
  }, '规划草稿已保存，尚未加入计划；已有创作规划未替换。');
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
    if (dirty.value) { error.value = '草稿有未保存修改，请先保存，再确认加入计划。'; return; }
    try { requireEditor(); } catch (cause) { error.value = errorText(cause); return; }
    if (!draftCurrent.value) { error.value = '参考剧情已变化，请核对草稿并重新保存后加入计划。'; return; }
  }
  confirmation.value = { kind, revision: outlineState.revision, id: kind === 'activate' ? outlineState.draft?.id ?? null : active.value?.id ?? null, chat: captureChat() };
}
function validConfirmation(kind: Confirmation['kind']): Confirmation | null {
  const request = confirmation.value;
  confirmation.value = null;
  if (!request || request.kind !== kind || !sameChat(request.chat) || request.revision !== outlineState.revision) {
    error.value = '聊天或规划已变化，请重新核对并确认。'; return null;
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
  }, '已加入计划中的「创作规划」，从第一阶段开始；普通剧情计划保持不变。');
}
function confirmReconfirm() {
  if (locked.value) return;
  const request = validConfirmation('reconfirm');
  if (!request || request.id !== active.value?.id) return;
  return runAction(reconfirmOutline, '已按当前剧情重新确认创作规划，继续当前阶段。');
}
function toggleActive() {
  const value = active.value;
  if (!value) return;
  return runAction(() => setOutlineEnabled(!value.enabled), value.enabled ? '创作规划已暂停，不再注入。' : '创作规划已继续。');
}
function moveStage(index: number) {
  return runAction(() => setOutlineChapter(index), index === active.value?.content.chapters.length
    ? '规划进度已结束，已撤下注入；不代表剧情事件已经发生。' : '已调整规划阶段；没有写入剧情事实或发送正文。');
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
  if (!channel.url.trim() || !channel.model.trim()) return '请填写 API 地址和模型。';
  try {
    const url = new URL(channel.url.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#\\\s]/.test(channel.url.trim())) throw new Error();
  } catch { return 'API 地址须为不含账号、查询参数或片段的完整 HTTP / HTTPS 地址。'; }
  if (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2) return '温度须为0–2。';
  if (!Number.isSafeInteger(channel.maxTokens) || channel.maxTokens < 256 || channel.maxTokens > 65535) return '最大输出须为256–65535之间的整数。';
  if (!Number.isSafeInteger(channel.timeoutSec) || channel.timeoutSec < 10 || channel.timeoutSec > 600) return '超时须为10–600之间的整数秒。';
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
    notice.value = '规划 API 设置已保存，未发送生成请求，也未修改札记配置。';
  } catch (cause) { Object.assign(outlineSettings, previous); error.value = errorText(cause); }
}
const canGenerate = computed(() => engineEnabled.value && !locked.value && !protectedSettings.value && !configurationIssue.value
  && !!brief.value.trim() && brief.value.length <= 8000 && Number.isInteger(chapterCount.value) && chapterCount.value >= 1 && chapterCount.value <= 12);
async function startGeneration(confirmed = false) {
  if (!canGenerate.value) return;
  if (!sameChat(editorChat) || expectedRevision.value !== outlineState.revision) {
    confirmation.value = null;
    error.value = '聊天或规划版本已变化，请在当前聊天重新填写创作要求。';
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
    <div v-if="error || outlineRun.error || outlineState.issue || outlineSettingsIssue" class="warning" role="alert">
      <p v-if="error">{{ error }}</p><p v-if="outlineRun.error">{{ outlineRun.error }}</p>
      <p v-if="outlineState.issue">{{ outlineState.issue }}</p><p v-if="outlineSettingsIssue">{{ outlineSettingsIssue }}</p>
    </div>
    <p v-if="disabled" class="hint">当前记忆处于保护状态，暂不可修改创作规划。</p>
    <p v-if="!engineEnabled" class="hint">当前角色的棱镜宝书尚未启用；可以查看已保存规划，但不生成或注入正文。</p>

    <section v-if="active" class="planner-card" aria-label="已确认的创作规划">
      <h3>创作规划 · {{ active.content.title }}</h3>
      <p class="hint">这些是未来创作方向，不是角色已作出的承诺或已发生的剧情。普通剧情计划保持独立。</p>
      <p v-if="!currentStage">规划进度已结束，已撤下注入。</p>
      <template v-else>
        <p><strong>当前阶段 {{ active.currentChapter + 1 }} / {{ active.content.chapters.length }} · {{ currentStage.title }}</strong></p>
        <p class="hint">{{ !engineEnabled ? '棱镜宝书未启用，暂不注入' : !activeCurrent ? '参考剧情已变化，暂停注入，须重新核对' : active.enabled ? '已启用当前阶段指引' : '已暂停注入' }}</p>
        <p class="plain"><strong>阶段目标：</strong>{{ currentStage.goal }}</p>
        <ul><li v-for="(beat, index) in currentStage.beats" :key="index">{{ beat }}</li></ul>
        <p class="plain"><strong>发展方式：</strong>{{ currentStage.approach }}</p>
        <p class="plain"><strong>推进条件：</strong>{{ currentStage.exitCriteria }}</p>
      </template>
      <div class="actions">
        <button v-if="currentStage && (activeCurrent || active.enabled)" type="button" class="bbs-btn" :disabled="locked" @click="toggleActive">{{ active.enabled ? '暂停规划' : '继续规划' }}</button>
        <button v-if="currentStage && !activeCurrent" type="button" class="bbs-btn" :disabled="locked" @click="requestConfirmation('reconfirm')">核对后重新启用</button>
        <button type="button" class="bbs-btn" :disabled="locked || active.currentChapter === 0" @click="moveStage(active.currentChapter - 1)">上一阶段</button>
        <button v-if="currentStage" type="button" class="bbs-btn" :disabled="locked" @click="moveStage(active.currentChapter + 1)">{{ active.currentChapter + 1 === active.content.chapters.length ? '结束规划并撤下注入' : '下一阶段' }}</button>
      </div>
      <p class="hint">手动推进只标记规划进度，不代表剧情完成；最后阶段结束后不再注入。不会自动连写或发送正文。</p>
      <div v-if="confirmation?.kind === 'reconfirm'" class="confirmation">
        <p>请先核对下方全部阶段与当前剧情。确认后以当前剧情为依据，重新启用当前阶段，不改写普通剧情计划。</p>
        <div class="actions"><button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked" @click="confirmReconfirm">已核对，重新启用</button><button type="button" class="bbs-btn" @click="confirmation = null">取消</button></div>
      </div>
      <details class="all-stages">
        <summary>查看全部已确认阶段（{{ active.content.chapters.length }}）</summary>
        <p class="plain">{{ active.content.premise }}</p>
        <ul v-if="active.content.constraints.length"><li v-for="(constraint, index) in active.content.constraints" :key="index">{{ constraint }}</li></ul>
        <ol class="stage-list">
          <li v-for="(stage, index) in active.content.chapters" :key="index">
            <h4>{{ stage.title }} <span class="hint">{{ index < active.currentChapter ? '已越过' : index === active.currentChapter ? '当前' : '待推进' }}</span></h4>
            <p class="plain"><strong>阶段目标：</strong>{{ stage.goal }}</p>
            <ul><li v-for="(beat, beatIndex) in stage.beats" :key="beatIndex">{{ beat }}</li></ul>
            <p class="plain"><strong>发展方式：</strong>{{ stage.approach }}</p>
            <p class="plain"><strong>推进条件：</strong>{{ stage.exitCriteria }}</p>
          </li>
        </ol>
      </details>
    </section>

    <details class="planner-workbench">
      <summary>{{ active ? '编辑 / 重新生成创作规划' : '大纲规划 · 生成草稿并确认加入计划' }}<span v-if="dirty">（未保存）</span></summary>
      <PageHeader title="大纲规划" description="结合当前剧情与你的创作要求，规划剧情要点和发展方式。" icon="plans" />
      <p class="hint">生成规划草稿 → 编辑剧情要点与发展方式 → 确认加入计划。只有确认后的内容才进入上方「创作规划」。</p>
      <p class="hint">角色的动机、知情范围与关系连续性优先，不强迫人物配合节点。大纲总上限 {{ L.json }} 字符；正文只注入全局约束与当前阶段，合计最多 {{ L.injection }} 字符，不提前注入后续阶段。API 输出 token 上限需在所用渠道中单独设置。</p>
      <section class="planner-card" aria-label="生成规划草稿">
        <fieldset :disabled="locked">
          <label>创作要求 / 你的 input<textarea v-model="brief" class="bbs-input" rows="4" maxlength="8000" placeholder="想往哪里发展？可写人物关系、希望出现的转折、节奏与禁区；系统会结合当前聊天剧情。" /></label>
          <label>规划阶段数（1–12）<input v-model.number="chapterCount" class="bbs-input" type="number" min="1" max="12" step="1" inputmode="numeric" /></label>
          <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="startGeneration()">{{ outlineState.draft || active ? '重新生成规划草稿' : '生成规划草稿' }}</button>
        </fieldset>
        <button v-if="outlineRun.busy || generating" type="button" class="bbs-btn" @click="cancelOutline">取消生成</button>
        <p v-if="configurationIssue" class="warning">{{ configurationIssue }} <button type="button" class="bbs-btn" @click="apiOpen = true">配置 API</button></p>
        <p v-if="apiDirty" class="hint">API 配置有未保存修改；生成仅使用已保存配置。</p>
        <div v-if="confirmation?.kind === 'generate'" class="confirmation">
          <p>重新生成会再次调用 API，可能产生费用；成功后替换草稿和未保存编辑，但不会替换已确认创作规划。</p>
          <div class="actions"><button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="startGeneration(true)">确认重新生成</button><button type="button" class="bbs-btn" @click="confirmation = null">取消</button></div>
        </div>
        <pre v-if="outlineRun.draft" class="stream" aria-label="规划生成中的纯文本草稿">{{ outlineRun.draft }}</pre>
      </section>

      <section v-if="editor" class="planner-card" aria-label="未确认的规划草稿编辑器">
        <h3>规划草稿 <span class="hint">{{ dirty ? '有未保存修改' : '已保存，待确认加入计划' }}</span></h3>
        <p v-if="!draftCurrent" class="warning">参考剧情已变化；请核对编辑内容，并重新保存后加入计划。</p>
        <fieldset :disabled="locked">
          <label>规划标题<input v-model="editor.title" class="bbs-input" :maxlength="L.title" /></label>
          <label>整体发展方向<textarea v-model="editor.premise" class="bbs-input" rows="3" :maxlength="L.premise" /></label>
          <label>创作约束（每行一条，最多{{ L.constraints }}条，每条{{ L.constraint }}字）<textarea v-model="editor.constraints" class="bbs-input" rows="3" /></label>
          <label>草稿对应的创作要求<textarea v-model="editBrief" class="bbs-input" rows="3" maxlength="8000" /></label>
          <label>编辑阶段（一次只展开一个）<select v-model.number="selectedChapter" class="bbs-input"><option v-for="(stage, index) in editor.chapters" :key="index" :value="index">{{ index + 1 }} · {{ stage.title || '未命名阶段' }}</option></select></label>
          <div class="actions"><button type="button" class="bbs-btn" :disabled="editor.chapters.length >= 12" @click="addStage">新增阶段</button><button type="button" class="bbs-btn" :disabled="editor.chapters.length <= 1" @click="removeStage">删除当前编辑阶段</button></div>
          <div v-if="currentEdit" class="stage-editor">
            <label>阶段标题<input v-model="currentEdit.title" class="bbs-input" :maxlength="L.title" /></label>
            <label>阶段目标<textarea v-model="currentEdit.goal" class="bbs-input" rows="3" :maxlength="L.goal" /></label>
            <label>剧情要点（每行一条，1–{{ L.beats }}条，每条{{ L.beat }}字）<textarea v-model="currentEdit.beats" class="bbs-input" rows="5" /></label>
            <label>发展方式（1–{{ L.approach }}字）<textarea v-model="currentEdit.approach" class="bbs-input" rows="4" :maxlength="L.approach" /></label>
            <label>推进条件<textarea v-model="currentEdit.exitCriteria" class="bbs-input" rows="3" :maxlength="L.exitCriteria" /></label>
          </div>
          <div class="actions"><button type="button" class="bbs-btn" @click="saveDraft">保存草稿编辑</button><button type="button" class="bbs-btn bbs-btn-primary" @click="requestConfirmation('activate')">确认加入计划</button></div>
        </fieldset>
        <p v-if="dirty" class="hint">请先保存修改，才能确认加入计划。保存草稿不会自动启用。</p>
        <div v-if="confirmation?.kind === 'activate'" class="confirmation">
          <p>将已保存草稿加入「创作规划」，替换此前确认的创作规划并从第一阶段开始。普通剧情计划不变，不会把这些内容记为已发生的事实。</p>
          <div class="actions"><button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked || dirty" @click="confirmActivate">确认加入并启用</button><button type="button" class="bbs-btn" @click="confirmation = null">取消</button></div>
        </div>
      </section>

      <details class="planner-card" :open="apiOpen" @toggle="apiOpen = ($event.target as HTMLDetailsElement).open">
        <summary>规划 API 设置 · {{ outlineSettings.apiMode === 'notes' ? '复用札记' : '专用渠道' }}</summary>
        <p class="hint">默认复用札记 API 配置，不要求开启札记开关；不使用正文 / 摘要渠道，不改动札记提示词或数据。</p>
        <p class="hint">配置只有显式保存后才生效。密钥保存在酒馆扩展设置中，请勿分享含密钥的备份。</p>
        <form @submit.prevent="saveApi">
          <fieldset :disabled="locked || protectedSettings">
            <label>API 模式<select v-model="apiMode" class="bbs-input" aria-label="API 模式"><option value="notes">复用札记 API（默认）</option><option value="independent">大纲规划专用 API</option></select></label>
            <template v-if="apiMode === 'independent'">
              <label>API 地址<input v-model="apiDraft.url" class="bbs-input" type="url" required autocomplete="off" spellcheck="false" placeholder="https://your-api.example/v1" /></label>
              <label>API 密钥<input v-model="apiDraft.key" class="bbs-input" type="password" autocomplete="new-password" spellcheck="false" /></label>
              <div class="actions"><button type="button" class="bbs-btn" :disabled="modelsLoading || !apiDraft.url.trim()" @click="pullModels">{{ modelsLoading ? '拉取中…' : '拉取模型列表' }}</button><button v-if="modelsLoading" type="button" class="bbs-btn" @click="cancelModels">取消拉取</button></div>
              <label v-if="models.length">搜索模型<input v-model="modelSearch" class="bbs-input" type="search" /></label>
              <label>模型下拉选择<select class="bbs-input" aria-label="模型下拉选择" :value="visibleModels.includes(apiDraft.model) ? apiDraft.model : ''" :disabled="!visibleModels.length || modelsLoading" @change="apiDraft.model = ($event.target as HTMLSelectElement).value"><option value="" disabled>{{ models.length ? '选择匹配模型，或在下方手填' : '先拉取列表，也可直接手填' }}</option><option v-for="model in visibleModels" :key="model" :value="model">{{ model }}</option></select></label>
              <p v-if="matchingModels.length > 200" class="hint">仅显示前200个匹配项，请搜索缩小范围。</p>
              <label>模型 ID / 手动输入<input v-model="apiDraft.model" class="bbs-input" required autocomplete="off" spellcheck="false" /></label>
              <p class="hint">拉取使用当前表单地址和密钥，不调用生成接口，不自动选择模型或保存。</p>
              <p v-if="modelsMessage" class="hint" role="status">{{ modelsMessage }}</p><p v-if="modelsError" class="warning" role="alert">{{ modelsError.replace('札记 API', '规划 API') }}</p>
              <label>温度<input v-model.number="apiDraft.temperature" class="bbs-input" type="number" required min="0" max="2" step="0.1" /></label>
              <label>最大输出 tokens<input v-model.number="apiDraft.maxTokens" class="bbs-input" type="number" required min="256" max="65535" step="1" /></label>
              <label>超时（秒）<input v-model.number="apiDraft.timeoutSec" class="bbs-input" type="number" required min="10" max="600" step="1" /></label>
              <label class="checkbox"><input v-model="apiDraft.stream" type="checkbox" />流式输出</label>
            </template>
            <button type="submit" class="bbs-btn bbs-btn-primary">保存规划 API 设置</button>
          </fieldset>
        </form>
      </details>
    </details>
  </div>
</template>

<style scoped>
.outline-planner { min-width:0; max-width:100%; margin:12px 0; color:var(--bbs-ink); font-size:12px; line-height:1.8; overflow-wrap:anywhere; }
.outline-planner *, .outline-planner *::before, .outline-planner *::after { box-sizing:border-box; }
.planner-card { min-width:0; margin:12px 0; padding:12px; background:var(--bbs-surface); border:1px solid var(--bbs-line); border-radius:8px; }
.outline-planner h3 { margin:0 0 8px; font-size:14px; }.outline-planner h4 { margin:8px 0; font-size:13px; }
.outline-planner p { margin:8px 0; }.outline-planner ul,.outline-planner ol { padding-left:20px; }
.outline-planner summary { display:list-item; min-height:44px; padding:10px 0; cursor:pointer; font-weight:600; white-space:normal; }
.outline-planner fieldset { min-width:0; margin:0; padding:0; border:0; }
.outline-planner label { display:flex; flex-direction:column; gap:5px; min-width:0; margin:10px 0; }
.outline-planner .bbs-input { display:block; width:100%; min-width:0; max-width:100%; min-height:44px; }
.outline-planner textarea { resize:vertical; line-height:1.7; font:inherit; }
.outline-planner .checkbox { flex-direction:row; align-items:center; min-height:44px; }.checkbox input { width:18px; height:18px; }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
.outline-planner .bbs-btn { min-width:44px; min-height:44px; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.hint { color:var(--bbs-ink-muted); font-size:11px; font-weight:400; }
.warning { color:var(--bbs-danger); }.feedback { color:var(--bbs-accent); }
.confirmation { padding:10px; margin:12px 0; border-left:2px solid var(--bbs-accent); background:var(--bbs-accent-soft); }
.stream { white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; font:12px/1.7 var(--bbs-font-mono); }
.plain { white-space:pre-wrap; }.stage-editor { border-top:1px solid var(--bbs-line); margin-top:12px; }
.stage-list > li + li { border-top:1px solid var(--bbs-line); margin-top:12px; padding-top:6px; }
.outline-planner :deep(.prism-page-title) { font-size:21px; }.outline-planner :deep(.prism-page-header) { margin:12px 0; }
.outline-planner :is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--bbs-accent); outline-offset:2px; }
@media(max-width:360px) { .planner-card { padding:8px; }.actions { gap:6px; } }
</style>
