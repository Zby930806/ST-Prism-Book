<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
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

const actionError = ref('');
const notice = ref('');
const importResult = ref<number | null>(null);
const pendingAction = ref(false);
const startingRun = ref(false);
const locked = computed(() => pendingAction.value || startingRun.value || notesRun.busy);
const apiDraft = reactive({ ...notesSettings.channel });
const apiDirty = ref(false);
const apiOpen = ref(false);
const page = ref(1);
const PAGE_SIZE = 5;
const orderedRecords = computed(() => [...notesState.records].sort((a, b) => b.createdAt - a.createdAt));
const pageCount = computed(() => Math.max(1, Math.ceil(orderedRecords.value.length / PAGE_SIZE)));
const visibleRecords = computed(() => orderedRecords.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
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
  { status: 'completed', label: '完成' },
  { status: 'cancelled', label: '取消' },
] as const;

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
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败，请重试。');
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
  if (!channel.url.trim() || !channel.model.trim()) return '尚未配置独立 API：请填写地址和模型并保存，不会跟随正文 API。';
  try {
    const url = new URL(channel.url.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return 'API 地址须为不含账号、查询参数或片段的 HTTP / HTTPS 地址。';
  } catch { return '请输入完整的 HTTP / HTTPS API 地址。'; }
  if (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2) return '温度须为 0–2 之间的数值。';
  if (!Number.isSafeInteger(channel.maxTokens) || channel.maxTokens < 256 || channel.maxTokens > 16000) return '最大输出须为 256–16000 之间的整数。';
  if (!Number.isSafeInteger(channel.timeoutSec) || channel.timeoutSec < 10 || channel.timeoutSec > 600) return '超时须为 10–600 之间的整数秒。';
  return '';
}
const configurationIssue = computed(() => channelIssue(notesSettings.channel));
const canGenerate = computed(() => notesSettings.enabled && !configurationIssue.value && !locked.value);

function saveApi() {
  actionError.value = '';
  notice.value = '';
  const issue = channelIssue(apiDraft);
  if (issue) { actionError.value = issue; return; }
  const previous = { ...notesSettings.channel };
  try {
    Object.assign(notesSettings.channel, apiDraft, { url: apiDraft.url.trim(), model: apiDraft.model.trim() });
    saveNotesSettings();
    if (settingsIssue.value) throw new Error(settingsIssue.value);
    apiDirty.value = false;
    Object.assign(apiDraft, notesSettings.channel);
    notice.value = '独立 API 设置已保存；未发送模型请求。';
  } catch (error) {
    Object.assign(notesSettings.channel, previous);
    actionError.value = errorText(error);
  }
}
function changeFlag(key: 'enabled' | 'autoGenerate' | 'injectConfirmed', event: Event) {
  const input = event.target as HTMLInputElement;
  const previous = notesSettings[key];
  actionError.value = '';
  notice.value = '';
  try {
    notesSettings[key] = input.checked;
    saveNotesSettings();
    if (settingsIssue.value) throw new Error(settingsIssue.value);
    notice.value = '札记偏好已保存。';
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
  actionError.value = '';
  notice.value = '';
  const [min, max] = key === 'recentFloors' ? [1, 40] : [1000, 40000];
  if (!input.value.trim() || !Number.isSafeInteger(value) || value < min || value > max) {
    actionError.value = key === 'recentFloors' ? '最近楼层数须为 1–40 之间的整数。' : '记忆字数须为 1000–40000 之间的整数。';
    input.value = String(previous);
    return;
  }
  try {
    notesSettings[key] = value;
    saveNotesSettings();
    if (settingsIssue.value) throw new Error(settingsIssue.value);
    notice.value = '札记偏好已保存。';
  } catch (error) {
    notesSettings[key] = previous;
    input.value = String(previous);
    actionError.value = errorText(error);
  }
}
async function startGeneration(force = false) {
  if (!canGenerate.value) return;
  startingRun.value = true;
  actionError.value = '';
  notice.value = '';
  try { await generateNotes(force); page.value = 1; }
  catch (error) { actionError.value = errorText(error); }
  finally { startingRun.value = false; }
}
function stopGeneration() {
  try { cancelNotes(); notice.value = '已请求取消，正在等待生成停止。'; }
  catch (error) { actionError.value = errorText(error); }
}
async function runAction(action: () => Promise<void>) {
  if (locked.value) return;
  pendingAction.value = true;
  actionError.value = '';
  notice.value = '';
  try { await action(); }
  catch (error) { actionError.value = errorText(error); }
  finally { pendingAction.value = false; }
}
function confirm(record: NoteRecord, questionId: string) {
  return runAction(async () => {
    const current = notesState.records.find(item => item.id === record.id);
    if (!current || !isCurrent(current)) throw new Error('这份札记关联的正文已失效，请根据当前正文重新生成后确认。');
    if (!current.questions.some(question => question.id === questionId)) throw new Error('问题已变化，请重新打开这份札记。');
    const text = edits[questionKey(record.id, questionId)]?.trim();
    if (!text || text.length > 4000) throw new Error('请填写 1–4000 字的采用方案。');
    await confirmQuestion(record.id, questionId, text);
    notice.value = '安排已确认，可在下方已确认清单中跟进。';
  });
}
function reject(noteId: string, questionId: string) {
  return runAction(async () => {
    await rejectQuestion(noteId, questionId);
    notice.value = '这个问题已搁置，不会作为已确认安排注入。';
  });
}
function updateDecision(decision: NoteDecision, status: typeof decisionActions[number]['status']) {
  return runAction(async () => {
    if ((status === 'pending' || status === 'in_progress') && !decisionIsCurrent(decision)) {
      throw new Error('正文关联已失效，不能重新激活这条安排；仍可完成或取消。');
    }
    await setDecisionStatus(decision.id, status);
    notice.value = `安排已更新为「${statusLabels[status]}」。`;
  });
}
function importNotes() {
  return runAction(async () => {
    importResult.value = null;
    importResult.value = await importLegacyNotes();
    page.value = 1;
  });
}
</script>

<template>
  <div class="notes-page">
    <PageHeader title="双子札记" description="戏外商量，故事里慢慢兑现。" icon="notes" eyebrow="PRISM / NOTES" />

    <section class="notes-card notes-controls" aria-label="札记生成">
      <div class="notes-toolbar">
        <label class="notes-toggle">
          <input type="checkbox" :checked="notesSettings.enabled" :disabled="locked" aria-label="启用双子札记" @change="changeFlag('enabled', $event)" />
          <span>启用双子札记</span>
        </label>
        <div class="notes-actions">
          <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="startGeneration()"><Icon name="edit" />生成札记</button>
          <button v-if="orderedRecords.length" type="button" class="bbs-btn" :disabled="!canGenerate" @click="startGeneration(true)"><Icon name="refresh" />重新生成</button>
          <button v-if="notesRun.busy || startingRun" type="button" class="bbs-btn" @click="stopGeneration">取消生成</button>
        </div>
      </div>
      <p class="notes-hint">独立 API，戏外讨论。使用前请关闭原札记触发，避免重复生成；具体说明见下方设置。</p>
      <p v-if="!notesSettings.enabled" class="notes-hint">当前未启用；仍可查看历史、整理安排和导入已有札记。</p>
      <p v-if="configurationIssue" class="notes-warning">{{ configurationIssue }} <button type="button" class="notes-link" @click="apiOpen = true">配置独立 API</button></p>
      <p v-if="apiDirty" class="notes-hint">API 表单有未保存修改；生成仅使用已保存配置。</p>
    </section>

    <div class="notes-feedback" aria-live="polite" aria-atomic="true">
      <p v-if="notesRun.status" class="notes-status" role="status">{{ notesRun.status }}</p>
      <p v-else-if="notesRun.busy || startingRun" class="notes-status" role="status">正在生成札记…</p>
      <p v-if="notice" class="notes-status" role="status">{{ notice }}</p>
      <p v-if="importResult !== null" class="notes-status" role="status">本次已导入 {{ importResult }} 份已有 aftertalk 札记，未修改正文。</p>
    </div>
    <div v-if="actionError || notesRun.error || settingsIssue || notesState.issue" class="notes-error" role="alert">
      <p v-if="actionError">{{ actionError }}</p>
      <p v-if="notesRun.error">生成：{{ notesRun.error }}</p>
      <p v-if="settingsIssue">设置：{{ settingsIssue }}</p>
      <p v-if="notesState.issue">札记存储：{{ notesState.issue }}</p>
    </div>

    <details class="notes-card" :open="apiOpen" @toggle="apiOpen = ($event.target as HTMLDetailsElement).open">
      <summary>独立 API 设置 <span class="notes-summary-hint">{{ configurationIssue ? '未就绪' : '已配置' }}</span></summary>
      <p class="notes-hint">独立 API 支持 OpenAI 兼容接口，仅用于双子札记，不跟随正文或摘要 API，也不修改正文渠道。请填写完整基础地址及模型；是否需要密钥以服务商要求为准。</p>
      <p class="notes-warning">API key 保存在酒馆扩展设置中，请勿分享带有 key 的设置备份。</p>
      <form class="notes-form" @submit.prevent="saveApi" @input="apiDirty = true">
        <fieldset :disabled="locked">
          <div class="notes-grid">
            <label class="notes-field notes-full">API 地址<input v-model="apiDraft.url" class="bbs-input" type="url" required autocomplete="off" spellcheck="false" aria-label="札记独立 API 地址" placeholder="https://your-api.example/v1" /></label>
            <label class="notes-field notes-full">API 密钥<input v-model="apiDraft.key" class="bbs-input" type="password" autocomplete="new-password" spellcheck="false" aria-label="札记独立 API 密钥" placeholder="按服务商要求填写" /></label>
            <label class="notes-field notes-full">模型<input v-model="apiDraft.model" class="bbs-input" type="text" required autocomplete="off" spellcheck="false" aria-label="札记独立 API 模型" placeholder="填写模型名称" /></label>
            <label class="notes-field">温度<input v-model.number="apiDraft.temperature" class="bbs-input" type="number" required min="0" max="2" step="0.1" inputmode="decimal" aria-label="札记独立 API 温度" /></label>
            <label class="notes-field">最大输出 tokens<input v-model.number="apiDraft.maxTokens" class="bbs-input" type="number" required min="256" max="16000" step="1" inputmode="numeric" aria-label="札记独立 API 最大输出 tokens" /></label>
            <label class="notes-field">超时（秒）<input v-model.number="apiDraft.timeoutSec" class="bbs-input" type="number" required min="10" max="600" step="1" inputmode="numeric" aria-label="札记独立 API 超时秒数" /></label>
            <label class="notes-toggle"><input v-model="apiDraft.stream" type="checkbox" aria-label="札记独立 API 流式输出" />流式输出</label>
          </div>
          <button type="submit" class="bbs-btn bbs-btn-primary"><Icon name="check" />保存独立 API</button>
        </fieldset>
      </form>
    </details>

    <details class="notes-card">
      <summary>自动生成与安排注入 <span class="notes-summary-hint">{{ notesSettings.autoGenerate || notesSettings.injectConfirmed ? '已自定义' : '默认关闭' }}</span></summary>
      <p class="notes-hint">开启自动生成前，请关闭原悬浮球的札记自动生成；若预设还要求正文输出 aftertalk，请同时关闭那条正文触发，完整规则仍保留在本页。仅已确认且处于「待兑现 / 进行中」的有效安排可参与注入，完成、取消或搁置后不再注入。</p>
      <div class="notes-preferences">
        <label class="notes-toggle"><input type="checkbox" :checked="notesSettings.autoGenerate" :disabled="locked || (!notesSettings.autoGenerate && (!notesSettings.enabled || !!configurationIssue))" aria-label="自动生成札记" @change="changeFlag('autoGenerate', $event)" />自动生成札记</label>
        <label class="notes-toggle"><input type="checkbox" :checked="notesSettings.injectConfirmed" :disabled="locked || (!notesSettings.injectConfirmed && !notesSettings.enabled)" aria-label="注入已确认的有效安排" @change="changeFlag('injectConfirmed', $event)" />注入已确认安排</label>
        <div class="notes-grid">
          <label class="notes-field">最近正文楼层数<input :value="notesSettings.recentFloors" class="bbs-input" type="number" min="1" max="40" step="1" inputmode="numeric" :disabled="locked" aria-label="札记参考最近正文楼层数" @change="changeLimit('recentFloors', $event)" /></label>
          <label class="notes-field">记忆字数上限<input :value="notesSettings.memoryChars" class="bbs-input" type="number" min="1000" max="40000" step="1" inputmode="numeric" :disabled="locked" aria-label="札记参考记忆字数上限" @change="changeLimit('memoryChars', $event)" /></label>
        </div>
      </div>
    </details>

    <section v-if="notesRun.draft" class="notes-card" aria-label="生成中的札记草稿" :aria-busy="notesRun.busy">
      <h2>札记草稿 <span class="notes-summary-hint">尚未作为安排确认</span></h2>
      <pre class="notes-text">{{ notesRun.draft }}</pre>
    </section>

    <section class="notes-section" aria-label="最近札记与历史">
      <div class="notes-section-heading"><h2>最近札记</h2><span class="notes-hint">共 {{ orderedRecords.length }} 份 · 每页最多 5 份</span></div>
      <div v-if="!orderedRecords.length" class="notes-empty"><Icon name="notes" :size="28" /><p>先在戏外聊聊下一步。</p><p class="notes-hint">启用并配置独立 API 后生成，或在下方导入已有 aftertalk。</p></div>
      <details v-for="(record, index) in visibleRecords" :key="record.id" class="notes-card notes-record" :open="index === 0">
        <summary>
          <span>{{ page === 1 && index === 0 ? '最新札记' : '历史札记' }} · 第 {{ record.floor }} 楼</span>
          <span v-if="!isCurrent(record)" class="notes-invalid">已失效</span>
          <span class="notes-record-date">{{ formatDate(record.createdAt) }} · 分支 {{ record.swipe }}</span>
        </summary>
        <p v-if="!isCurrent(record)" class="notes-warning">这份札记已失效（正文变化或已有更新版本）：仅保留查阅，不可确认安排，请使用当前正文的最新札记。</p>
        <pre class="notes-text">{{ record.text }}</pre>
        <div v-for="question in record.questions" :key="questionKey(record.id, question.id)" class="notes-question">
          <h3>{{ question.label }}</h3>
          <p class="notes-question-prompt">{{ question.prompt }}</p>
          <label class="notes-field">采用方案
            <textarea v-model="edits[questionKey(record.id, question.id)]" class="bbs-input" rows="3" maxlength="4000" :disabled="locked || !isCurrent(record)" :aria-label="`第 ${record.floor} 楼 ${question.label} 采用方案`" placeholder="编辑你希望在故事里逐步兑现的安排" />
          </label>
          <p v-if="questionDecision(record.id, question.id)" class="notes-hint">当前：{{ statusLabels[questionDecision(record.id, question.id)!.status] }}。编辑后需再次确认才会更新安排。</p>
          <div class="notes-actions">
            <button type="button" class="bbs-btn bbs-btn-primary" :disabled="locked || !isCurrent(record) || !edits[questionKey(record.id, question.id)]?.trim()" @click="confirm(record, question.id)">确认安排</button>
            <button type="button" class="bbs-btn" :disabled="locked || !isCurrent(record) || questionDecision(record.id, question.id)?.status === 'rejected'" @click="reject(record.id, question.id)">搁置</button>
          </div>
        </div>
        <p v-if="!record.questions.length" class="notes-hint">这份札记未提取到可确认的 Q 问题，原文已完整保留。</p>
      </details>
      <nav v-if="pageCount > 1" class="notes-pagination" aria-label="札记历史分页">
        <button type="button" class="bbs-btn" :disabled="page <= 1" aria-label="上一页札记" @click="page--">上一页</button>
        <span aria-live="polite">{{ page }} / {{ pageCount }}</span>
        <button type="button" class="bbs-btn" :disabled="page >= pageCount" aria-label="下一页札记" @click="page++">下一页</button>
      </nav>
    </section>

    <section class="notes-section" aria-label="已确认安排清单">
      <div class="notes-section-heading"><h2>已确认清单</h2><span class="notes-hint">{{ decisions.length }} 项</span></div>
      <p class="notes-hint">只有点击「确认安排」才会将方案加入清单。聊天中带 Q 编号的用户原话会提供给札记阅读，但不会自动确认方案或修改安排状态；请在本页手动确认和更新。</p>
      <p class="notes-hint">{{ notesSettings.enabled && notesSettings.injectConfirmed ? '安排注入已开启。' : '安排注入未启用。' }}完成、取消的安排仅留档，不再注入。</p>
      <p v-if="!decisions.length" class="notes-empty">还没有已确认的安排。上面的讨论不会自动变成故事指令。</p>
      <article v-for="decision in visibleDecisions" :key="decision.id" class="notes-card notes-decision">
        <div class="notes-section-heading"><h3>{{ statusLabels[decision.status] }}</h3><span v-if="!decisionIsCurrent(decision)" class="notes-invalid">正文关联已失效</span></div>
        <p class="notes-hint">{{ formatDate(decision.createdAt) }}</p>
        <p class="notes-decision-text">{{ decision.text }}</p>
        <div class="notes-actions" role="group" aria-label="安排状态">
          <button v-for="action in decisionActions" :key="action.status" type="button" class="bbs-btn" :class="{ 'is-selected': decision.status === action.status }" :aria-pressed="decision.status === action.status" :disabled="locked || decision.status === action.status || ((!decisionIsCurrent(decision)) && (action.status === 'pending' || action.status === 'in_progress'))" @click="updateDecision(decision, action.status)">{{ action.label }}</button>
        </div>
      </article>
      <nav v-if="decisionPageCount > 1" class="notes-pagination" aria-label="安排分页">
        <button type="button" class="bbs-btn" :disabled="decisionPage <= 1" aria-label="上一页安排" @click="decisionPage--">上一页</button>
        <span>{{ decisionPage }} / {{ decisionPageCount }} · 每页 10 项</span>
        <button type="button" class="bbs-btn" :disabled="decisionPage >= decisionPageCount" aria-label="下一页安排" @click="decisionPage++">下一页</button>
      </nav>
    </section>

    <details class="notes-card">
      <summary>原始完整提示词 <span class="notes-summary-hint">只读</span></summary>
      <pre class="notes-text" aria-label="原始完整札记提示词，只读">{{ ORIGINAL_NOTES_PROMPT }}</pre>
    </details>
    <details class="notes-card">
      <summary>导入已有札记</summary>
      <p class="notes-hint">显式读取已有 aftertalk 为独立札记，不改写或删除聊天正文，不会自动确认其中的安排。</p>
      <button type="button" class="bbs-btn" :disabled="locked" @click="importNotes"><Icon name="download" />导入已有 aftertalk</button>
      <p v-if="importResult !== null" class="notes-hint">本次导入 {{ importResult }} 份。</p>
    </details>
  </div>
</template>

<style scoped>
.notes-page { width:100%; min-width:0; max-width:100%; color:var(--bbs-ink); overflow-wrap:anywhere; }
.notes-page :where(section, article, details, div, form, fieldset, label) { min-width:0; }
.notes-card { margin:0 0 14px; padding:18px; border:1px solid var(--bbs-line); border-radius:var(--bbs-radius); background:var(--bbs-surface); }
.notes-controls { border-top:2px solid var(--bbs-accent); }
.notes-toolbar, .notes-actions, .notes-section-heading, .notes-pagination { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.notes-toolbar, .notes-section-heading { justify-content:space-between; }
.notes-toggle { display:flex; align-items:center; gap:9px; font-size:13px; cursor:pointer; }
.notes-toggle input { flex:0 0 auto; width:18px; height:18px; margin:0; accent-color:var(--bbs-accent); }
.notes-hint, .notes-summary-hint, .notes-record-date { color:var(--bbs-ink-muted); font-size:12px; line-height:1.8; }
.notes-hint { margin:10px 0 0; }
.notes-summary-hint { margin-left:8px; font-weight:400; }
.notes-warning, .notes-error { padding:10px 12px; border-radius:var(--bbs-radius-sm); font-size:13px; }
.notes-warning { color:var(--bbs-warning); background:var(--bbs-warning-soft); }
.notes-error { margin:0 0 14px; color:var(--bbs-danger); background:var(--bbs-danger-soft); }
.notes-error p { margin:4px 0; }
.notes-status { margin:0 0 12px; font-size:13px; color:var(--bbs-ink-soft); }
.notes-link { padding:2px 0; border:0; background:none; color:inherit; font:inherit; text-decoration:underline; cursor:pointer; }
.notes-page summary { cursor:pointer; font-size:14px; font-weight:600; line-height:1.8; }
.notes-page summary:focus-visible, .notes-link:focus-visible, .notes-toggle input:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:3px; }
.notes-page h2 { margin:0; font:600 19px/1.6 var(--bbs-font-reading); }
.notes-page h3 { margin:0; font-size:14px; line-height:1.8; }
.notes-form { margin-top:14px; }
.notes-form fieldset { margin:0; padding:0; border:0; }
.notes-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-bottom:16px; }
.notes-full { grid-column:1 / -1; }
.notes-field { display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--bbs-ink-soft); }
.notes-page .bbs-input { box-sizing:border-box; min-width:0; max-width:100%; }
.notes-page textarea { resize:vertical; min-height:90px; }
.notes-page .bbs-btn { min-height:40px; max-width:100%; justify-content:center; white-space:normal; overflow-wrap:anywhere; }
.notes-preferences { display:grid; gap:16px; margin-top:16px; }
.notes-preferences .notes-grid { margin-bottom:0; }
.notes-section { margin:26px 0; }
.notes-section-heading { margin-bottom:12px; }
.notes-section-heading .notes-hint { margin:0; }
.notes-empty { padding:24px 16px; text-align:center; background:var(--bbs-surface-2); border-radius:var(--bbs-radius); color:var(--bbs-ink-soft); font-size:13px; }
.notes-empty p { margin:8px 0 0; }
.notes-record-date { display:block; margin:5px 0 0; font-weight:400; }
.notes-invalid { display:inline-block; padding:2px 7px; border-radius:4px; background:var(--bbs-warning-soft); color:var(--bbs-warning); font-size:11px; font-weight:500; }
.notes-text { margin:16px 0 0; max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font:400 14px/1.95 var(--bbs-font-reading); }
.notes-question { margin-top:20px; padding-top:18px; border-top:1px solid var(--bbs-line); }
.notes-question-prompt, .notes-decision-text { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; line-height:1.9; }
.notes-question .notes-actions { margin-top:12px; }
.notes-pagination { justify-content:center; font-size:12px; }
.notes-decision .notes-section-heading { margin-bottom:0; }
.notes-decision .notes-hint { margin-top:4px; }
.notes-decision .is-selected { border-color:var(--bbs-accent); background:var(--bbs-accent-soft); color:var(--bbs-accent); opacity:1; }
@media (max-width:640px) {
  .notes-card { padding:14px; }
  .notes-toolbar { align-items:flex-start; flex-direction:column; gap:14px; }
  .notes-page .bbs-btn { min-height:44px; padding:8px 11px; }
  .notes-actions { gap:8px; }
  .notes-grid { grid-template-columns:minmax(0,1fr); }
  .notes-section { margin:22px 0; }
}
</style>
