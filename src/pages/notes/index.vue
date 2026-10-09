<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import { notesSettings, saveNotesSettings, settingsIssue } from '@/notes/settings';
import { notesRun, generateNotes, cancelNotes } from '@/notes/service';
import {
  notesState, recordIsCurrent, recordSourceIsCurrent, confirmQuestion, rejectQuestion,
  setDecisionStatus, importLegacyNotes,
} from '@/notes/store';
import type { NoteRecord, NoteDecision } from '@/notes/types';
import { ORIGINAL_NOTES_PROMPT } from '@/notes/prompt';
import { useNotesModelCatalog } from '@/notes/modelCatalog';
import { getContext } from '@/st/context';

const actionError = ref('');
const notice = ref('');
// 提示显示在触发它的那一块旁边：设置在页面底部、确认按钮在札记里，提示不该跑到看不见的顶部。
const feedbackAt = ref('panel');
const importResult = ref<number | null>(null);
const pendingAction = ref(false);
const startingRun = ref(false);
const locked = computed(() => pendingAction.value || startingRun.value || notesRun.busy);
const apiDraft = reactive({ ...notesSettings.channel });
const { models, loading: modelsLoading, message: modelsMessage, error: modelsError, pull: pullModels, cancel: cancelModels } = useNotesModelCatalog(apiDraft);
const modelSearch = ref('');
const matchingModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase();
  return query ? models.value.filter(model => model.toLowerCase().includes(query)) : models.value;
});
const visibleModels = computed(() => matchingModels.value.slice(0, 200));
watch(() => [apiDraft.url, apiDraft.key], () => { modelSearch.value = ''; });
function chooseModel(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) return;
  apiDraft.model = value;
  apiDirty.value = true;
}
const apiDirty = ref(false);
const apiOpen = ref(false);
const apiPanel = ref<HTMLDetailsElement>();
function openApi() {
  apiOpen.value = true;
  void nextTick(() => apiPanel.value?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
}
const page = ref(1);
const PAGE_SIZE = 5;
const orderedRecords = computed(() => [...notesState.records].sort((a, b) => b.createdAt - a.createdAt));
const pageCount = computed(() => Math.max(1, Math.ceil(orderedRecords.value.length / PAGE_SIZE)));
const visibleRecords = computed(() => orderedRecords.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
const expandedRecords = reactive(new Set<string>());
const recordExpansionScope = ref(0);
let expansionChat: NonNullable<ReturnType<typeof getContext>>['chat'] | undefined;
let expansionChatId: string | undefined;
// revision 同时覆盖切聊和同聊保存；只有聊天身份改变才清空手动展开状态。
watch(() => notesState.revision, () => {
  const context = getContext();
  const chatId = context?.getCurrentChatId();
  if (context?.chat === expansionChat && chatId === expansionChatId) return;
  expansionChat = context?.chat;
  expansionChatId = chatId;
  expandedRecords.clear();
  recordExpansionScope.value++;
}, { immediate: true, flush: 'sync' });
function toggleRecord(recordId: string, event: Event) {
  const details = event.currentTarget as HTMLDetailsElement;
  // 原生 toggle 延迟派发，旧聊天的事件不得写入新聊天的展开状态。
  if (details.dataset.expansionScope !== String(recordExpansionScope.value)) return;
  if (details.open) expandedRecords.add(recordId);
  else expandedRecords.delete(recordId);
}
const decisions = computed(() => [...notesState.decisions]
  .filter(decision => decision.status !== 'rejected')
  .sort((a, b) => b.createdAt - a.createdAt));
const decisionPage = ref(1);
const decisionPageCount = computed(() => Math.max(1, Math.ceil(decisions.value.length / 10)));
const visibleDecisions = computed(() => decisions.value.slice((decisionPage.value - 1) * 10, decisionPage.value * 10));
watch(decisionPageCount, count => { decisionPage.value = Math.min(decisionPage.value, count); });
const edits = reactive<Record<string, string>>({});
const statusLabels: Record<NoteDecision['status'], string> = {
  pending: '待兑现', in_progress: '进行中', completed: '已完成', cancelled: '已取消', rejected: '已搁置',
};
const decisionActions = [
  { status: 'pending', label: '待兑现' },
  { status: 'in_progress', label: '进行中' },
  { status: 'completed', label: '已完成' },
  { status: 'cancelled', label: '已取消' },
] as const;
const injecting = computed(() => notesSettings.enabled && notesSettings.injectConfirmed);
const injectionNote = computed(() => !notesSettings.enabled
  ? '双子札记没有启用，这些安排暂时不会交给正文模型。'
  : !notesSettings.injectConfirmed
    ? '「注入已确认安排」没有打开（在页面底部的「自动生成与注入」里），这些安排暂时只是记录。'
    : '待兑现和进行中的安排会交给正文模型；标成已完成或已取消后就不再交。');

function questionKey(noteId: string, questionId: string): string {
  return JSON.stringify([noteId, questionId]);
}
function questionDecision(noteId: string, questionId: string) {
  return notesState.decisions.find(decision => decision.noteId === noteId && decision.questionId === questionId);
}
function isCurrent(record: NoteRecord): boolean {
  // revision 变化时重算正文关联；是否失效的规则始终由 store 决定。
  void notesState.revision;
  return recordIsCurrent(record);
}
function decisionIsCurrent(decision: NoteDecision): boolean {
  const record = notesState.records.find(item => item.id === decision.noteId);
  // 重新生成只淘汰旧札记的提案；已确认安排仍按相同正文来源判断有效性。
  void notesState.revision;
  return !!record && recordSourceIsCurrent(record);
}
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '时间未知'
    : date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作没有完成，请重试。');
}
function report(where: string) {
  feedbackAt.value = where;
  actionError.value = '';
  notice.value = '';
}

watch(pageCount, count => { page.value = Math.min(page.value, count); });
watch(() => notesSettings.channel, channel => {
  if (!apiDirty.value) Object.assign(apiDraft, channel);
}, { deep: true });
watch(visibleRecords, records => {
  const activeKeys = new Set<string>();
  for (const record of records) {
    for (const question of record.questions) {
      const key = questionKey(record.id, question.id);
      activeKeys.add(key);
      if (!(key in edits)) edits[key] = questionDecision(record.id, question.id)?.text ?? question.proposal;
    }
  }
  for (const key of Object.keys(edits)) if (!activeKeys.has(key)) delete edits[key];
}, { deep: true, immediate: true });

function channelIssue(channel: typeof apiDraft): string {
  if (!channel.url.trim() || !channel.model.trim()) return '札记要用单独的 API，还没填写地址和模型名。';
  try {
    const url = new URL(channel.url.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return 'API 地址要写完整的 http(s) 地址，不能带账号、? 参数或 #。';
  } catch { return 'API 地址不是有效的网址，要以 http:// 或 https:// 开头。'; }
  if (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2) return '温度要在 0–2 之间。';
  if (!Number.isSafeInteger(channel.maxTokens) || channel.maxTokens < 256 || channel.maxTokens > 65535) return '最大输出要是 256–65535 之间的整数。';
  if (!Number.isSafeInteger(channel.timeoutSec) || channel.timeoutSec < 10 || channel.timeoutSec > 600) return '超时要是 10–600 之间的整数（秒）。';
  return '';
}
const configurationIssue = computed(() => channelIssue(notesSettings.channel));
const canGenerate = computed(() => notesSettings.enabled && !configurationIssue.value && !locked.value);
const prefsSummary = computed(() => `自动生成${notesSettings.autoGenerate ? '开' : '关'} · 注入${notesSettings.injectConfirmed ? '开' : '关'}`);

function saveApi() {
  report('api');
  const issue = channelIssue(apiDraft);
  if (issue) { actionError.value = issue; return; }
  const previous = { ...notesSettings.channel };
  try {
    Object.assign(notesSettings.channel, apiDraft, { url: apiDraft.url.trim(), model: apiDraft.model.trim() });
    saveNotesSettings();
    if (settingsIssue.value) throw new Error(settingsIssue.value);
    apiDirty.value = false;
    Object.assign(apiDraft, notesSettings.channel);
    notice.value = '札记 API 已保存。';
  } catch (error) {
    Object.assign(notesSettings.channel, previous);
    actionError.value = errorText(error);
  }
}
const flagNotices = {
  enabled: ['双子札记已启用。', '双子札记已关闭。'],
  autoGenerate: ['已打开自动生成。', '已关闭自动生成。'],
  injectConfirmed: ['已确认的安排会交给正文模型。', '已确认的安排不再交给正文模型。'],
} as const;
function changeFlag(key: 'enabled' | 'autoGenerate' | 'injectConfirmed', event: Event) {
  const input = event.target as HTMLInputElement;
  const previous = notesSettings[key];
  report(key === 'enabled' ? 'panel' : 'prefs');
  try {
    notesSettings[key] = input.checked;
    saveNotesSettings();
    if (settingsIssue.value) throw new Error(settingsIssue.value);
    notice.value = flagNotices[key][input.checked ? 0 : 1];
  } catch (error) {
    notesSettings[key] = previous;
    input.checked = previous;
    actionError.value = errorText(error);
  }
}
function changeLimit(key: 'recentFloors' | 'memoryChars', event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  const previous = notesSettings[key];
  report('prefs');
  const [min, max] = key === 'recentFloors' ? [1, 40] : [1000, 40000];
  if (!input.value.trim() || !Number.isSafeInteger(value) || value < min || value > max) {
    actionError.value = key === 'recentFloors' ? '参考楼层数要是 1–40 之间的整数。' : '字数上限要是 1000–40000 之间的整数。';
    input.value = String(previous);
    return;
  }
  try {
    notesSettings[key] = value;
    saveNotesSettings();
    if (settingsIssue.value) throw new Error(settingsIssue.value);
    notice.value = '已保存。';
  } catch (error) {
    notesSettings[key] = previous;
    input.value = String(previous);
    actionError.value = errorText(error);
  }
}
async function startGeneration(force = false) {
  if (!canGenerate.value) return;
  startingRun.value = true;
  report('panel');
  try { await generateNotes(force); page.value = 1; }
  catch (error) { actionError.value = errorText(error); }
  finally { startingRun.value = false; }
}
function stopGeneration() {
  report('panel');
  try { cancelNotes(); }
  catch (error) { actionError.value = errorText(error); }
}
async function runAction(where: string, action: () => Promise<void>) {
  if (locked.value) return;
  pendingAction.value = true;
  report(where);
  try { await action(); }
  catch (error) { actionError.value = errorText(error); }
  finally { pendingAction.value = false; }
}
function confirm(record: NoteRecord, questionId: string) {
  return runAction('q:' + questionKey(record.id, questionId), async () => {
    const current = notesState.records.find(item => item.id === record.id);
    if (!current || !isCurrent(current)) throw new Error('这份札记对应的正文已经变了，不能再确认。请为当前正文重新生成札记。');
    if (!current.questions.some(question => question.id === questionId)) throw new Error('这个问题已经不在了，请重新打开这份札记。');
    const text = edits[questionKey(record.id, questionId)]?.trim();
    if (!text || text.length > 4000) throw new Error('采用方案要写 1–4000 字。');
    await confirmQuestion(record.id, questionId, text);
    notice.value = '已确认，加进了下面的「已确认的安排」。';
  });
}
function reject(noteId: string, questionId: string) {
  return runAction('q:' + questionKey(noteId, questionId), async () => {
    await rejectQuestion(noteId, questionId);
    notice.value = '已搁置，不会交给正文模型。';
  });
}
function updateDecision(decision: NoteDecision, status: typeof decisionActions[number]['status']) {
  return runAction('d:' + decision.id, async () => {
    if ((status === 'pending' || status === 'in_progress') && !decisionIsCurrent(decision)) {
      throw new Error('这条安排对应的正文已经变了，不能再设为待兑现或进行中；可以标成已完成或已取消。');
    }
    await setDecisionStatus(decision.id, status);
    notice.value = `已标成「${statusLabels[status]}」。`;
  });
}
function importNotes() {
  return runAction('import', async () => {
    importResult.value = null;
    importResult.value = await importLegacyNotes();
    page.value = 1;
  });
}
</script>

<template>
  <div class="notes-page">
    <PageHeader title="双子札记" icon="notes" description="模型读完最近的剧情，在故事外提几个问题跟你商量。你确认过的方案才算「安排」，可以交给正文模型慢慢写进故事。" />

    <section class="notes-panel" aria-label="札记生成">
      <div class="notes-toolbar">
        <label class="notes-switch">
          <input type="checkbox" class="bbs-switch" :checked="notesSettings.enabled" :disabled="locked" aria-label="启用双子札记" @change="changeFlag('enabled', $event)" />
          <span>启用双子札记</span>
        </label>
        <div class="notes-actions">
          <button v-if="notesRun.busy || startingRun" type="button" class="bbs-btn" @click="stopGeneration">取消生成</button>
          <button v-if="orderedRecords.length" type="button" class="bbs-btn" :disabled="!canGenerate" @click="startGeneration(true)"><Icon name="refresh" />重新生成</button>
          <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="startGeneration()"><Icon name="edit" />生成札记</button>
        </div>
      </div>
      <p v-if="!notesSettings.enabled" class="bbs-field-hint">没有启用：不会生成新札记，已有的札记和安排照样可以查看、整理。</p>
      <div v-if="configurationIssue" class="bbs-callout is-warning notes-setup">
        <span>{{ configurationIssue }}</span>
        <button type="button" class="bbs-btn" @click="openApi">去填写</button>
      </div>
      <p v-if="apiDirty" class="bbs-field-hint">API 设置还没保存，生成会用上次保存的设置。</p>
      <p v-if="notesSettings.enabled && !orderedRecords.length" class="bbs-field-hint">预设或悬浮球里如果也在生成札记（aftertalk），先关掉那边，免得一轮出两份。</p>
    </section>

    <div class="notes-feedback" aria-live="polite" aria-atomic="true">
      <div v-if="notesRun.status && notesRun.errorDetail && !notesRun.error" class="bbs-callout is-warning" role="status">
        <p>{{ notesRun.status }}</p>
        <details><summary>技术细节</summary><p>{{ notesRun.errorDetail }}</p></details>
      </div>
      <p v-else-if="notesRun.status" class="notes-status" role="status">{{ notesRun.status }}</p>
      <p v-else-if="notesRun.busy || startingRun" class="notes-status" role="status">正在生成札记…</p>
      <p v-if="feedbackAt === 'panel' && notice" class="notes-status" role="status">{{ notice }}</p>
    </div>
    <div v-if="(feedbackAt === 'panel' && actionError) || notesRun.error || settingsIssue || notesState.issue" class="bbs-callout is-danger notes-error" role="alert">
      <p v-if="feedbackAt === 'panel' && actionError">{{ actionError }}</p>
      <template v-if="notesRun.error">
        <p>{{ notesRun.error }}</p>
        <details v-if="notesRun.errorDetail"><summary>技术细节</summary><p>{{ notesRun.errorDetail }}</p></details>
      </template>
      <p v-if="settingsIssue">{{ settingsIssue }}</p>
      <p v-if="notesState.issue">{{ notesState.issue }}</p>
    </div>

    <section v-if="notesRun.draft" class="notes-draft" aria-label="生成中的札记草稿" :aria-busy="notesRun.busy">
      <div class="notes-section-head"><h2 class="notes-heading">正在写</h2><span class="notes-count">写完才会保存</span></div>
      <pre class="notes-text">{{ notesRun.draft }}</pre>
    </section>

    <section class="notes-section" aria-label="最近札记与历史">
      <div class="notes-section-head">
        <h2 class="notes-heading">札记</h2>
        <span v-if="orderedRecords.length" class="notes-count">共 {{ orderedRecords.length }} 份</span>
      </div>
      <div v-if="!orderedRecords.length" class="notes-empty">
        <p>还没有札记。</p>
        <p class="bbs-field-hint">启用并填好 API 后点「生成札记」。正文里以前写过的 aftertalk，可以在页面底部导入。</p>
      </div>
      <details v-for="(record, index) in visibleRecords" :key="JSON.stringify([recordExpansionScope, record.id])" class="bbs-disclosure is-card notes-record" :class="{ 'is-stale': !isCurrent(record) }" :data-expansion-scope="recordExpansionScope" :open="expandedRecords.has(record.id)" @toggle="toggleRecord(record.id, $event)">
        <summary>
          <span class="notes-record-head">
            <span class="notes-record-title">第 {{ record.floor }} 楼<span v-if="page === 1 && index === 0 && isCurrent(record)" class="notes-tag is-new">最新</span><span v-if="!isCurrent(record)" class="notes-tag is-stale">已失效</span></span>
            <span class="notes-record-meta">{{ formatDate(record.createdAt) }}<template v-if="record.swipe"> · 分支 {{ record.swipe }}</template><template v-if="record.questions.length"> · {{ record.questions.length }} 个问题</template></span>
          </span>
        </summary>
        <p v-if="!isCurrent(record)" class="bbs-callout is-warning notes-stale-note">这份札记已失效：对应的正文改过了，或者后来又生成了新的一份。只能查看，里面的方案不能再确认。</p>
        <pre class="notes-text">{{ record.text }}</pre>
        <div v-for="question in record.questions" :key="questionKey(record.id, question.id)" class="notes-question">
          <div class="notes-question-head">
            <span class="notes-question-id">{{ question.label }}</span>
            <p class="notes-question-prompt">{{ question.prompt }}</p>
          </div>
          <label class="notes-field">采用方案
            <textarea v-model="edits[questionKey(record.id, question.id)]" class="bbs-input" rows="3" maxlength="4000" :disabled="locked || !isCurrent(record)" :aria-label="`第 ${record.floor} 楼 ${question.label} 采用方案`" placeholder="想让故事怎么兑现这一条，写在这里；可以直接改模型给的暂定写法。" />
          </label>
          <p v-if="questionDecision(record.id, question.id)" class="bbs-field-hint">现在是「{{ statusLabels[questionDecision(record.id, question.id)!.status] }}」。改了方案要再点「确认安排」才会更新。</p>
          <div class="notes-actions">
            <button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked || !isCurrent(record) || !edits[questionKey(record.id, question.id)]?.trim()" @click="confirm(record, question.id)">确认安排</button>
            <button type="button" class="bbs-btn" :disabled="locked || !isCurrent(record) || questionDecision(record.id, question.id)?.status === 'rejected'" @click="reject(record.id, question.id)">搁置</button>
          </div>
          <div v-if="feedbackAt === 'q:' + questionKey(record.id, question.id) && (notice || actionError)" class="notes-inline">
            <p v-if="notice" class="notes-status" role="status">{{ notice }}</p>
            <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
          </div>
        </div>
        <p v-if="!record.questions.length" class="bbs-field-hint">这份札记里没有 Q1–Q4 这样的编号问题，所以没有可以确认的方案；原文都在上面。</p>
      </details>
      <nav v-if="pageCount > 1" class="notes-pagination" aria-label="札记历史分页">
        <button type="button" class="bbs-btn" :disabled="page <= 1" aria-label="上一页札记" @click="page--">上一页</button>
        <span aria-live="polite">{{ page }} / {{ pageCount }}</span>
        <button type="button" class="bbs-btn" :disabled="page >= pageCount" aria-label="下一页札记" @click="page++">下一页</button>
      </nav>
    </section>

    <section class="notes-section" aria-label="已确认安排清单">
      <div class="notes-section-head">
        <h2 class="notes-heading">已确认的安排</h2>
        <span class="notes-inject" :class="{ 'is-on': injecting }">{{ injecting ? '注入中' : '未注入' }}</span>
      </div>
      <p class="bbs-field-hint">{{ injectionNote }}在聊天里回复「Q1：……」只会让下一份札记读到，确认还是要在这里点。</p>
      <p v-if="!decisions.length" class="notes-empty">还没有确认过安排。札记里的方案不会自动变成剧情。</p>
      <article v-for="decision in visibleDecisions" :key="decision.id" class="notes-decision" :class="`is-${decision.status}`">
        <header class="notes-decision-head">
          <span class="notes-chip">{{ statusLabels[decision.status] }}</span>
          <span v-if="!decisionIsCurrent(decision)" class="notes-tag is-stale">对应正文已变</span>
          <span class="notes-decision-date">{{ formatDate(decision.createdAt) }}</span>
        </header>
        <p class="notes-decision-text">{{ decision.text }}</p>
        <div class="notes-segment" role="group" aria-label="安排状态">
          <button v-for="action in decisionActions" :key="action.status" type="button" class="bbs-btn" :class="{ 'is-selected': decision.status === action.status }" :aria-pressed="decision.status === action.status" :disabled="locked || decision.status === action.status || ((!decisionIsCurrent(decision)) && (action.status === 'pending' || action.status === 'in_progress'))" @click="updateDecision(decision, action.status)">{{ action.label }}</button>
        </div>
        <div v-if="feedbackAt === 'd:' + decision.id && (notice || actionError)" class="notes-inline">
          <p v-if="notice" class="notes-status" role="status">{{ notice }}</p>
          <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
        </div>
      </article>
      <nav v-if="decisionPageCount > 1" class="notes-pagination" aria-label="安排分页">
        <button type="button" class="bbs-btn" :disabled="decisionPage <= 1" aria-label="上一页安排" @click="decisionPage--">上一页</button>
        <span>{{ decisionPage }} / {{ decisionPageCount }}</span>
        <button type="button" class="bbs-btn" :disabled="decisionPage >= decisionPageCount" aria-label="下一页安排" @click="decisionPage++">下一页</button>
      </nav>
    </section>

    <footer class="notes-footer" aria-label="札记设置">
      <details ref="apiPanel" class="bbs-disclosure" :open="apiOpen" @toggle="apiOpen = ($event.target as HTMLDetailsElement).open">
        <summary>独立 API 设置 <span class="bbs-disclosure-meta">{{ configurationIssue ? '还没填好' : notesSettings.channel.model }}</span></summary>
        <p class="bbs-field-hint">札记只用这里填的 API（OpenAI 兼容接口），不会借用正文或摘要的；创作规划默认也用它。密钥存在酒馆的扩展设置里，分享设置备份前记得删掉。</p>
        <form class="notes-form" @submit.prevent="saveApi" @input="apiDirty = true">
          <fieldset :disabled="locked">
            <label class="notes-field">API 地址<input v-model="apiDraft.url" class="bbs-input" type="url" required autocomplete="off" spellcheck="false" aria-label="札记独立 API 地址" placeholder="https://your-api.example/v1" /></label>
            <label class="notes-field">API 密钥<input v-model="apiDraft.key" class="bbs-input" type="password" autocomplete="new-password" spellcheck="false" aria-label="札记独立 API 密钥" placeholder="不需要密钥的服务可以留空" /></label>
            <div class="notes-model">
              <div class="notes-model-head">
                <span class="notes-model-label">模型</span>
                <div class="notes-actions">
                  <button type="button" class="bbs-btn" :disabled="modelsLoading || !apiDraft.url.trim()" @click="pullModels"><Icon name="refresh" />{{ modelsLoading ? '拉取中…' : '拉取模型列表' }}</button>
                  <button v-if="modelsLoading" type="button" class="bbs-btn" @click="cancelModels">取消</button>
                </div>
              </div>
              <label v-if="models.length" class="notes-field">搜索<input v-model="modelSearch" class="bbs-input" type="search" autocomplete="off" aria-label="搜索札记模型" placeholder="输入关键词筛选" @input.stop /></label>
              <label class="notes-field">从列表选择
                <select class="bbs-input" :value="visibleModels.includes(apiDraft.model) ? apiDraft.model : ''" :disabled="!visibleModels.length || modelsLoading" aria-label="札记模型下拉选择" @change="chooseModel">
                  <option value="" disabled>{{ models.length ? (matchingModels.length ? '选择一个模型' : '没有匹配的模型，可以在下面手动填写') : '先填地址，再拉取模型列表' }}</option>
                  <option v-for="model in visibleModels" :key="model" :value="model">{{ model }}</option>
                </select>
              </label>
              <p v-if="matchingModels.length > 200" class="bbs-field-hint">匹配到 {{ matchingModels.length }} 个，只显示前 200 个，可以搜索缩小范围。</p>
              <label class="notes-field">模型名<input v-model="apiDraft.model" class="bbs-input" type="text" required autocomplete="off" spellcheck="false" aria-label="札记独立 API 模型" placeholder="也可以直接填写服务商给的模型名" /></label>
              <p v-if="modelsMessage" class="bbs-field-hint" role="status">{{ modelsMessage }}</p>
              <p v-else-if="!modelsError" class="bbs-field-hint">拉取用的是上面填的地址和密钥，不用先保存。</p>
              <p v-if="modelsError" class="bbs-callout is-warning" role="alert">{{ modelsError }}</p>
            </div>
            <div class="notes-grid">
              <label class="notes-field">温度<input v-model.number="apiDraft.temperature" class="bbs-input" type="number" required min="0" max="2" step="0.1" inputmode="decimal" aria-label="札记独立 API 温度" /></label>
              <label class="notes-field">最大输出（tokens）<input v-model.number="apiDraft.maxTokens" class="bbs-input" type="number" required min="256" max="65535" step="1" inputmode="numeric" aria-label="札记独立 API 最大输出 tokens" /></label>
              <label class="notes-field">超时（秒）<input v-model.number="apiDraft.timeoutSec" class="bbs-input" type="number" required min="10" max="600" step="1" inputmode="numeric" aria-label="札记独立 API 超时秒数" /></label>
            </div>
            <p class="bbs-field-hint">最大输出是模型一次最多写多少，默认 8000，思考型模型的思考过程也算在里面。札记总被截断就调大；超过模型自己的上限时服务商会报错，按提示调小就行。</p>
            <label class="notes-switch-row"><span><strong>流式输出</strong><small>边写边显示；接口不支持时关掉。</small></span><input v-model="apiDraft.stream" type="checkbox" class="bbs-switch" aria-label="札记独立 API 流式输出" /></label>
            <button type="submit" class="bbs-btn bbs-btn-primary notes-save"><Icon name="check" />保存</button>
          </fieldset>
        </form>
        <div v-if="feedbackAt === 'api' && (notice || actionError)" class="notes-inline">
          <p v-if="notice" class="notes-status" role="status">{{ notice }}</p>
          <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
        </div>
      </details>

      <details class="bbs-disclosure">
        <summary>自动生成与注入 <span class="bbs-disclosure-meta">{{ prefsSummary }}</span></summary>
        <label class="notes-switch-row">
          <span><strong>自动生成札记</strong><small>{{ !notesSettings.autoGenerate && (!notesSettings.enabled || configurationIssue) ? '要先启用双子札记并填好 API。' : '每次正文写完后自动写一份。' }}</small></span>
          <input type="checkbox" class="bbs-switch" :checked="notesSettings.autoGenerate" :disabled="locked || (!notesSettings.autoGenerate && (!notesSettings.enabled || !!configurationIssue))" aria-label="自动生成札记" @change="changeFlag('autoGenerate', $event)" />
        </label>
        <label class="notes-switch-row">
          <span><strong>注入已确认安排</strong><small>{{ !notesSettings.injectConfirmed && !notesSettings.enabled ? '要先启用双子札记。' : '把待兑现、进行中的安排交给正文模型。' }}</small></span>
          <input type="checkbox" class="bbs-switch" :checked="notesSettings.injectConfirmed" :disabled="locked || (!notesSettings.injectConfirmed && !notesSettings.enabled)" aria-label="注入已确认的有效安排" @change="changeFlag('injectConfirmed', $event)" />
        </label>
        <p class="bbs-field-hint">以前用过原版札记的话，先关掉悬浮球里的札记自动生成，以及预设里让正文输出 aftertalk 的那一条，免得重复。</p>
        <div class="notes-grid">
          <label class="notes-field">参考最近几层（1–40）<input :value="notesSettings.recentFloors" class="bbs-input" type="number" min="1" max="40" step="1" inputmode="numeric" :disabled="locked" aria-label="札记参考最近正文楼层数" @change="changeLimit('recentFloors', $event)" /></label>
          <label class="notes-field">摘要和状态最多读多少字（1000–40000）<input :value="notesSettings.memoryChars" class="bbs-input" type="number" min="1000" max="40000" step="1" inputmode="numeric" :disabled="locked" aria-label="札记参考记忆字数上限" @change="changeLimit('memoryChars', $event)" /></label>
        </div>
        <div v-if="feedbackAt === 'prefs' && (notice || actionError)" class="notes-inline">
          <p v-if="notice" class="notes-status" role="status">{{ notice }}</p>
          <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
        </div>
      </details>

      <details class="bbs-disclosure">
        <summary>原版提示词 <span class="bbs-disclosure-meta">只读</span></summary>
        <pre class="notes-prompt" aria-label="原始完整札记提示词，只读">{{ ORIGINAL_NOTES_PROMPT }}</pre>
      </details>

      <details class="bbs-disclosure">
        <summary>导入正文里的札记</summary>
        <p class="bbs-field-hint">把聊天正文里已有的 aftertalk 读成札记，方便在这里确认。正文不会被修改或删除，里面说过的安排也不会自动确认。</p>
        <button type="button" class="bbs-btn" :disabled="locked" @click="importNotes"><Icon name="download" />导入</button>
        <div v-if="feedbackAt === 'import' && (importResult !== null || actionError)" class="notes-inline">
          <p v-if="importResult !== null" class="notes-status" role="status">{{ importResult ? `导入了 ${importResult} 份札记，聊天正文没有改动。` : '正文里没有新的 aftertalk 可以导入。' }}</p>
          <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
        </div>
      </details>
    </footer>
  </div>
</template>

<style scoped>
.notes-page { width:100%; min-width:0; max-width:100%; color:var(--bbs-ink); overflow-wrap:anywhere; }
.notes-page :where(section, article, details, div, form, fieldset, label) { min-width:0; }

/* 生成面板 */
.notes-panel { margin:0 0 16px; padding:14px 18px; border:1px solid var(--bbs-line); border-radius:14px; background:var(--bbs-surface); }
.notes-toolbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 16px; }
.notes-switch { display:inline-flex; align-items:center; gap:10px; min-height:40px; font-size:14px; font-weight:600; cursor:pointer; }
.notes-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.notes-panel > .bbs-field-hint { margin:8px 0 0; }
.notes-setup { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px; margin:12px 0 0; }

/* 状态与报错 */
.notes-status { margin:0 0 12px; padding:1px 0 1px 12px; border-left:2px solid var(--bbs-accent); font-size:13px; line-height:1.7; color:var(--bbs-ink-soft); }
.notes-error { margin:0 0 16px; }
.notes-inline { margin-top:12px; }
.notes-inline > :last-child { margin-bottom:0; }

/* 区块 */
.notes-section { margin:28px 0; }
.notes-section-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:6px 12px; margin:0 0 10px; }
.notes-heading { margin:0; font:600 20px/1.5 var(--bbs-font-reading); letter-spacing:.04em; color:var(--bbs-ink); }
.notes-count { font-size:12.5px; color:var(--bbs-ink-muted); }
.notes-section > .bbs-field-hint { margin:0 0 12px; }
.notes-empty { margin:0; padding:20px 18px; border:1px dashed var(--bbs-line-strong); border-radius:12px; text-align:center; font-size:13.5px; color:var(--bbs-ink-soft); }
.notes-empty p { margin:0; }
.notes-empty .bbs-field-hint { max-width:42ch; margin:6px auto 0; }
.notes-draft { margin:0 0 20px; padding:12px 18px 16px; border:1px dashed var(--bbs-accent); border-radius:12px; }
.notes-draft .notes-text { max-height:320px; overflow:auto; border-top:0; padding-top:0; }

/* 札记 */
.notes-record { margin:0 0 10px; }
.notes-record-head { display:flex; flex-direction:column; gap:1px; flex:1 1 auto; min-width:0; }
.notes-record-title { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:14.5px; font-weight:600; }
.notes-record-meta { font-size:12px; font-weight:400; color:var(--bbs-ink-muted); }
.notes-record.is-stale .notes-record-title { color:var(--bbs-ink-soft); }
.notes-tag { display:inline-block; padding:0 8px; border-radius:var(--bbs-radius-pill); font-size:11.5px; font-weight:500; line-height:1.8; }
.notes-tag.is-new { background:var(--bbs-accent-soft); color:var(--bbs-accent); }
.notes-tag.is-stale { background:var(--bbs-warning-soft); color:var(--bbs-warning); }
.notes-stale-note { margin:4px 0 12px; }
.notes-text { margin:0; padding:12px 0 0; max-width:100%; border-top:1px solid var(--bbs-line); white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font:400 14px/1.95 var(--bbs-font-reading); color:var(--bbs-ink); background:none; }
.notes-question { margin:14px 0 0; padding:14px 16px; border-radius:10px; background:var(--bbs-surface-2); }
.notes-question-head { display:flex; align-items:flex-start; gap:10px; }
.notes-question-id { flex:0 0 auto; min-width:30px; padding:0 7px; border-radius:6px; background:var(--bbs-accent-soft); color:var(--bbs-accent); font:600 12px/24px var(--bbs-font-mono); text-align:center; }
.notes-question-prompt { flex:1 1 auto; min-width:0; margin:0; font-size:13.5px; line-height:1.8; white-space:pre-wrap; }
.notes-field { display:flex; flex-direction:column; gap:6px; margin:12px 0 0; font-size:12.5px; color:var(--bbs-ink-soft); }
.notes-page .bbs-input { box-sizing:border-box; min-width:0; max-width:100%; }
.notes-page textarea { resize:vertical; min-height:84px; line-height:1.7; }
.notes-question .notes-field + .bbs-field-hint { margin:6px 0 0; }
.notes-question .notes-actions { margin-top:10px; }
.notes-pagination { display:flex; align-items:center; justify-content:center; gap:12px; margin-top:12px; font-size:12.5px; color:var(--bbs-ink-muted); }

/* 安排 */
.notes-inject { padding:1px 10px; border-radius:var(--bbs-radius-pill); background:var(--bbs-surface-2); font-size:12px; line-height:1.8; color:var(--bbs-ink-muted); }
.notes-inject.is-on { background:var(--bbs-accent-soft); color:var(--bbs-accent); }
.notes-decision { margin:0 0 10px; padding:12px 16px 14px; border:1px solid var(--bbs-line); border-radius:12px; background:var(--bbs-surface); }
.notes-decision.is-pending, .notes-decision.is-in_progress { border-left:3px solid var(--bbs-accent); }
.notes-decision-head { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
.notes-chip { display:inline-flex; padding:0 10px; border-radius:var(--bbs-radius-pill); background:var(--bbs-surface-2); color:var(--bbs-ink-soft); font-size:12px; font-weight:600; line-height:1.9; }
.is-pending .notes-chip, .is-in_progress .notes-chip { background:var(--bbs-accent-soft); color:var(--bbs-accent); }
.notes-decision-date { margin-left:auto; font-size:12px; color:var(--bbs-ink-muted); }
.notes-decision-text { margin:8px 0 12px; font-size:14px; line-height:1.85; white-space:pre-wrap; overflow-wrap:anywhere; }
.is-completed .notes-decision-text, .is-cancelled .notes-decision-text { color:var(--bbs-ink-muted); }
.notes-segment { display:inline-flex; flex-wrap:wrap; gap:2px; max-width:100%; padding:2px; border:1px solid var(--bbs-line); border-radius:10px; background:var(--bbs-surface-2); }
.notes-segment .bbs-btn { min-height:32px; padding:4px 12px; border:0; border-radius:8px; background:transparent; color:var(--bbs-ink-soft); font-weight:500; }
.notes-segment .bbs-btn:hover:not(:disabled) { background:var(--bbs-surface); color:var(--bbs-accent); }
.notes-segment .bbs-btn.is-selected { background:var(--bbs-surface); color:var(--bbs-accent); font-weight:650; opacity:1; outline:1px solid var(--bbs-line-strong); outline-offset:-1px; }
.notes-segment .bbs-btn:disabled:not(.is-selected) { opacity:.4; }

/* 设置 */
.notes-footer { margin-top:32px; border-top:1px solid var(--bbs-line); }
.notes-footer > details { border-bottom:1px solid var(--bbs-line); }
.notes-footer > details > summary { font-size:13.5px; }
.notes-footer > details[open] { padding-bottom:16px; }
.notes-footer .bbs-disclosure-meta { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.notes-footer > details > .bbs-field-hint:first-of-type { margin-top:0; }
.notes-form fieldset { min-width:0; margin:0; padding:0; border:0; }
.notes-model { margin:14px 0 0; padding:4px 14px 12px; border-radius:10px; background:var(--bbs-surface-2); }
.notes-model-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; }
.notes-model-label { font-size:12.5px; color:var(--bbs-ink-soft); }
.notes-model select { width:100%; text-overflow:ellipsis; }
.notes-model .bbs-field-hint { margin:8px 0 0; }
.notes-model .bbs-callout { margin:8px 0 0; }
.notes-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr)); gap:0 12px; }
.notes-grid + .bbs-field-hint { margin-top:8px; }
.notes-switch-row { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:48px; padding:8px 0; cursor:pointer; }
.notes-switch-row + .notes-switch-row { border-top:1px solid var(--bbs-line); }
.notes-switch-row strong { display:block; font-size:13.5px; font-weight:600; color:var(--bbs-ink); }
.notes-switch-row small { display:block; margin-top:1px; font-size:12.5px; color:var(--bbs-ink-muted); }
.notes-save { margin-top:6px; }
.notes-prompt { max-height:360px; margin:0; padding:12px 14px; overflow:auto; border-radius:10px; background:var(--bbs-surface-2); white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.75 var(--bbs-font-mono); color:var(--bbs-ink-soft); }

@media (max-width:640px) {
  .notes-panel { padding:12px 14px; }
  .notes-toolbar { flex-direction:column; align-items:stretch; }
  .notes-actions .bbs-btn { flex:1 1 auto; }
  .notes-heading { font-size:18px; }
  .notes-question { padding:12px; }
  .notes-decision { padding:12px 14px; }
  .notes-segment { display:flex; }
  .notes-segment .bbs-btn { flex:1 1 0; min-height:40px; padding:4px 6px; }
}
</style>
