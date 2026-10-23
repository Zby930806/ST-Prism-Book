<script setup lang="ts">
/**
 * 世界书页：根据剧情生成世界书条目的建议，审核后写入所选的世界书，写入的改动可撤销。
 * 结构：页头 → 写入目标与生成 → 待审核的建议 → 已写入记录（默认收起）→ 设置。
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import BbsSelect from '@/components/BbsSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import FoldSection from '@/components/FoldSection.vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import ModalShell from '@/components/ModalShell.vue';
import PageHeader from '@/components/PageHeader.vue';
import SuggestionCard from './SuggestionCard.vue';
import SuggestionEditDialog from './SuggestionEditDialog.vue';
import WorldbookSettingsPanel from './WorldbookSettingsPanel.vue';
import { useBookSnapshots } from './useBookSnapshots';
import { engineActiveHere } from '@/api/settings';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { bookNameIssue, createChatBook, hostApiIssue, refreshWorldHost, worldHost } from '@/worldbook/host';
import { saveSuggestionEdit, setCursor, setSuggestionStatus, setTarget, worldbookState, worldbookWriteIssue } from '@/worldbook/store';
import { batchStale, cancelSuggestions, currentTarget, defaultTarget, generateSuggestions, pendingCount, targetIssue, worldbookRun } from '@/worldbook/service';
import { applySuggestions, missingBookMessage, undoApplied, writerState, type ApplyOutcome } from '@/worldbook/writer';
import { worldbookChannelIssue, worldbookSettings } from '@/worldbook/settings';
import { KIND_LABELS, PERMISSION_LABELS } from '@/worldbook/protocol';
import { cursorBefore, planRead, rangeCurrent } from '@/worldbook/source';
import { diffSentences, findEntry, listEntries } from '@/worldbook/entries';
import { formatTime } from '@/worldbook/view';
import { WB_LIMITS } from '@/worldbook/limits';
import type { AppliedRecord, Suggestion, SuggestionBatch } from '@/worldbook/types';

const settingsPanel = ref<InstanceType<typeof WorldbookSettingsPanel> | null>(null);
const feedbackAt = ref('panel');
const notice = ref('');
const actionError = ref('');
const pendingAction = ref(false);
function report(where: string) { feedbackAt.value = where; notice.value = ''; actionError.value = ''; }
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作没有完成，请重试。');
const locked = computed(() => worldbookRun.busy || writerState.busy || pendingAction.value || worldbookState.saving);

onMounted(() => { void refreshWorldHost(); });

/* —— 写入目标 —— */
const targetName = computed(() => { void worldHost.revision; return currentTarget(); });
const bindings = computed(() => worldHost.bindings);
function tagsFor(name: string): string[] {
  const b = bindings.value;
  return [b.chat === name ? '聊天绑定' : '', b.charPrimary === name ? '角色主世界书' : '', b.charAux.includes(name) ? '角色附加' : '',
    b.global.includes(name) ? '全局启用' : '', b.persona === name ? '用户角色绑定' : ''].filter(Boolean);
}
const bookOptions = computed(() => {
  const names = [...(worldHost.names ?? [])];
  if (targetName.value && !names.includes(targetName.value)) names.unshift(targetName.value);
  // 按在当前聊天中的启用方式排序：聊天绑定、角色主世界书、角色附加、用户角色绑定、全局启用，其余按名称
  const rank = (n: string) => {
    const b = bindings.value;
    return b.chat === n ? 0 : b.charPrimary === n ? 1 : b.charAux.includes(n) ? 2 : b.persona === n ? 3 : b.global.includes(n) ? 4 : 5;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh')).map(name => {
    const tags = tagsFor(name);
    const missing = worldHost.names && !worldHost.names.includes(name);
    return { value: name, label: name + (missing ? '（不存在）' : tags.length ? '（' + tags.join('、') + '）' : '') };
  });
});
const targetTags = computed(() => tagsFor(targetName.value));
const hostIssue = computed(() => { void worldHost.revision; return hostApiIssue(); });
const targetProblem = computed(() => { void worldHost.revision; void worldbookState.target; return targetIssue(targetName.value); });
const storageIssue = computed(() => { void worldbookState.revision; return worldbookWriteIssue(); });
async function chooseTarget(name: string) {
  report('target');
  if (name === targetName.value && worldbookState.target) return;
  try { await setTarget(name); notice.value = '写入目标已改为「' + name + '」，本聊天会记住这个选择。'; }
  catch (e) { actionError.value = errorText(e); }
}
async function restoreDefault() {
  report('target');
  try { await setTarget(null); notice.value = defaultTarget() ? '已恢复默认，写入目标为「' + defaultTarget() + '」。' : '已恢复默认。'; }
  catch (e) { actionError.value = errorText(e); }
}
async function refreshBooks() {
  report('target');
  await refreshWorldHost();
  notice.value = worldHost.names ? '已刷新，共 ' + worldHost.names.length + ' 本世界书。' : '';
  if (!worldHost.names) actionError.value = '读取不到世界书列表。请确认酒馆已加载完成，或刷新页面后重试。';
}

/* —— 新建并绑定到当前聊天 —— */
const createOpen = ref(false);
const createName = ref('');
const createError = ref('');
const creating = ref(false);
function openCreate() {
  const ctx = getContext();
  const base = (ctx?.name2 || '聊天').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 40);
  createName.value = (base || '聊天') + ' 剧情设定';
  createError.value = '';
  createOpen.value = true;
}
async function confirmCreate() {
  if (creating.value) return;
  createError.value = bookNameIssue(createName.value);
  if (createError.value) return;
  creating.value = true;
  try {
    const name = await createChatBook(createName.value);
    await setTarget(name);
    createOpen.value = false;
    report('target');
    notice.value = '已新建世界书「' + name + '」，绑定到当前聊天，并设为写入目标。';
  } catch (e) { createError.value = errorText(e); }
  finally { creating.value = false; }
}

/* —— 世界书数据（冲突判断、改前改后对比） —— */
const visibleBatches = computed(() => [...worldbookState.batches].filter(b => b.suggestions.some(s => s.status === 'pending')).sort((a, b) => b.createdAt - a.createdAt));
const { books } = useBookSnapshots(() => [targetName.value, ...visibleBatches.value.map(b => b.book)]);
const targetData = computed(() => books.value.get(targetName.value)?.data ?? null);
function bookView(name: string) { return books.value.get(name) ?? { data: null, error: '' }; }
function bookError(batch: SuggestionBatch): string {
  void worldHost.revision;
  if (worldHost.names && !worldHost.names.includes(batch.book)) return missingBookMessage(batch.book);
  return bookView(batch.book).error;
}
function stale(batch: SuggestionBatch): boolean { return batchStale(batch); }
const pending = computed(() => pendingCount());

/* —— 读取进度与 API 状态 —— */
const apiIssue = computed(() => { void worldbookSettings.apiMode; void worldbookSettings.channel.url; void worldbookSettings.channel.model; return worldbookChannelIssue(); });
const nextRead = computed(() => {
  void worldbookState.revision;
  const ctx = getContext();
  if (!ctx) return '';
  const plan = planRead(ctx, worldbookState.cursor, worldbookSettings.read, { allowReread: true, floorText: worldbookSettings.read.maxChars });
  if (!plan) return '当前聊天还没有可以读取的正文。';
  const span = '第 ' + plan.floors[0] + '–' + plan.floors[plan.floors.length - 1] + ' 楼（' + plan.floors.length + ' 层）';
  const cursor = worldbookState.cursor;
  if (plan.mode === 'first') return '本聊天还没有读取过；生成时读取最近的' + span + (plan.older ? '，更早的 ' + plan.older + ' 层可在「读取范围」中设定起点后读取' : '') + '。';
  const done = cursor && cursor.floor >= 0 ? '上次读取到第 ' + cursor.floor + ' 楼' : '已设定从第 0 楼开始读取';
  if (plan.mode === 'reread') return done + '，之后没有新楼层；生成时重新读取最近的' + span + '。';
  return done + '；下次读取' + span + (plan.remaining ? '，之后还有 ' + plan.remaining + ' 层' : '') + '。';
});
const canGenerate = computed(() => !locked.value && !worldbookRun.storyBusy && engineActiveHere() && !hostIssue.value && !targetProblem.value && !apiIssue.value && !storageIssue.value);
const entryCount = computed(() => (targetData.value ? listEntries(targetData.value).length : null));

async function generate() {
  if (!canGenerate.value) return;
  report('panel');
  await generateSuggestions();
}
function stop() { report('panel'); cancelSuggestions(); }

/* —— 审核 —— */
async function runAction(where: string, action: () => Promise<void>) {
  if (locked.value) return;
  pendingAction.value = true;
  report(where);
  try { await action(); } catch (e) { actionError.value = errorText(e); }
  finally { pendingAction.value = false; }
}
function outcomeText(out: ApplyOutcome, book: string): { ok: string; fail: string } {
  const ok = out.applied.length ? '已写入世界书「' + book + '」' + out.applied.length + ' 条，可在「已写入记录」中撤销。' : '';
  const fail = out.issues.map(i => '「' + i.title + '」没有写入：' + i.reason).join('\n');
  return { ok, fail };
}
/** 这批还有待处理的建议时，结果显示在这批下方；整批处理完后批次不再显示，结果移到页面上方。 */
function settleFeedback(batchId: string) {
  const stillShown = worldbookState.batches.find(b => b.id === batchId)?.suggestions.some(s => s.status === 'pending');
  if (!stillShown) feedbackAt.value = 'panel';
}
function applyOne(batch: SuggestionBatch, s: Suggestion) {
  // 依据楼层已失效的批次：先弹窗说明，核对后才「仍然应用」
  if (stale(batch)) { if (!locked.value) batchConfirm.value = { kind: 'apply', batch, ids: [s.id] }; return; }
  return runAction('batch:' + batch.id, async () => {
    const out = await applySuggestions(batch.id, [s.id]);
    const text = outcomeText(out, batch.book);
    notice.value = text.ok; actionError.value = text.fail;
    settleFeedback(batch.id);
  });
}
function ignoreOne(batch: SuggestionBatch, s: Suggestion) {
  return runAction('batch:' + batch.id, async () => {
    await setSuggestionStatus(batch.id, [s.id], 'ignored');
    notice.value = s.kind === 'flag' ? '已标为已读。' : '已忽略这条建议，世界书没有改动。';
    settleFeedback(batch.id);
  });
}
/** 依据楼层失效后，把读取进度设到这批的起点，下次生成会重新覆盖这一范围。 */
function rereadFrom(batch: SuggestionBatch) {
  return runAction('batch:' + batch.id, async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('请先打开一个已保存的聊天。');
    await setCursor(cursorBefore(ctx, batch.source.from));
    notice.value = '下次从第 ' + batch.source.from + ' 楼开始读取。点「生成建议」重新生成；这批旧建议可以忽略。';
  });
}

/* 批量应用、批量忽略：确认后执行。ids 为空表示整批中尚未处理的建议 */
type BatchConfirm = { kind: 'apply' | 'ignore'; batch: SuggestionBatch; ids?: string[] };
const batchConfirm = shallowRef<BatchConfirm | null>(null);
const batchConfirmOpen = computed({ get: () => !!batchConfirm.value, set: (v: boolean) => { if (!v && !pendingAction.value) batchConfirm.value = null; } });
function pendingWrites(batch: SuggestionBatch) { return batch.suggestions.filter(s => s.status === 'pending' && s.kind !== 'flag'); }
const staleNote = (batch: SuggestionBatch) => '这批建议依据的第 ' + batch.source.from + '–' + batch.source.to + ' 楼已被改写、重抽或删除，内容可能与现在的正文不符，请核对后再写入。';
const batchConfirmText = computed(() => {
  const c = batchConfirm.value; if (!c) return '';
  const list = c.batch.suggestions.filter(s => s.status === 'pending');
  if (c.kind === 'ignore') return '忽略这批中尚未处理的 ' + list.length + ' 条建议。忽略后不再显示，世界书不会改动。';
  const prefix = stale(c.batch) ? staleNote(c.batch) : '';
  if (c.ids) {
    const s = c.batch.suggestions.find(x => x.id === c.ids![0]);
    return prefix + '把「' + (s?.title ?? '') + '」写入世界书「' + c.batch.book + '」；写入后可在「已写入记录」中撤销。';
  }
  const counts = new Map<string, number>();
  for (const s of pendingWrites(c.batch)) counts.set(KIND_LABELS[s.kind], (counts.get(KIND_LABELS[s.kind]) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => k + ' ' + n + ' 条').join('、');
  return prefix + '把这批中 ' + pendingWrites(c.batch).length + ' 条建议写入世界书「' + c.batch.book + '」：' + parts + '。有冲突或超出当前修改权限的会跳过并说明原因；写入后可在「已写入记录」中撤销。提醒不写入。';
});
function askBatch(kind: BatchConfirm['kind'], batch: SuggestionBatch) { if (!locked.value) batchConfirm.value = { kind, batch }; }
async function confirmBatch() {
  const c = batchConfirm.value; if (!c) return;
  await runAction('batch:' + c.batch.id, async () => {
    if (c.kind === 'ignore') {
      const ids = c.batch.suggestions.filter(s => s.status === 'pending').map(s => s.id);
      const n = await setSuggestionStatus(c.batch.id, ids, 'ignored');
      notice.value = '已忽略 ' + n + ' 条建议。';
    } else {
      const out = await applySuggestions(c.batch.id, c.ids ?? pendingWrites(c.batch).map(s => s.id), { allowStale: stale(c.batch) });
      const text = outcomeText(out, c.batch.book);
      notice.value = text.ok; actionError.value = text.fail;
    }
    settleFeedback(c.batch.id);
  });
  batchConfirm.value = null;
}

/* 编辑后再应用 */
const editing = shallowRef<{ batch: SuggestionBatch; suggestion: Suggestion } | null>(null);
const editEntry = computed(() => {
  const e = editing.value; if (!e || e.suggestion.uid === null) return null;
  const data = bookView(e.batch.book).data;
  return data ? findEntry(data, e.suggestion.uid)?.entry ?? null : null;
});
const editData = computed(() => (editing.value ? bookView(editing.value.batch.book).data : null));
function openEdit(batch: SuggestionBatch, s: Suggestion) { if (!locked.value) editing.value = { batch, suggestion: s }; }
async function saveEdit(patch: Pick<Suggestion, 'title' | 'keys' | 'content' | 'find'>, apply: boolean) {
  const e = editing.value; if (!e) return;
  await runAction('batch:' + e.batch.id, async () => {
    await saveSuggestionEdit(e.batch.id, e.suggestion.id, patch);
    editing.value = null;
    if (!apply) { notice.value = '建议已修改，尚未写入。'; return; }
    const out = await applySuggestions(e.batch.id, [e.suggestion.id]);
    const text = outcomeText(out, e.batch.book);
    notice.value = text.ok; actionError.value = text.fail;
    settleFeedback(e.batch.id);
  });
}

/* —— 已写入记录 —— */
const recordsOpen = ref(false);
const recordPage = ref(1);
const RECORDS_PER_PAGE = 10;
const records = computed(() => [...worldbookState.applied].sort((a, b) => b.at - a.at));
const recordPages = computed(() => Math.max(1, Math.ceil(records.value.length / RECORDS_PER_PAGE)));
const pagedRecords = computed(() => records.value.slice((recordPage.value - 1) * RECORDS_PER_PAGE, recordPage.value * RECORDS_PER_PAGE));
watch(recordPages, n => { recordPage.value = Math.min(recordPage.value, n); });
function recordStale(r: AppliedRecord): boolean { void worldbookState.revision; return !rangeCurrent(r.source); }
function recordDiff(r: AppliedRecord) {
  return r.before ? diffSentences(r.before.content, r.after.content) : { before: [], after: [{ text: r.after.content, type: 'same' as const }] };
}
function recordKeys(r: AppliedRecord): string[] {
  const before = new Set((r.before?.key ?? []).map(k => k.trim().toLowerCase()));
  return r.after.key.filter(k => !before.has(k.trim().toLowerCase()));
}
const undoTarget = shallowRef<AppliedRecord | null>(null);
const undoOpen = computed({ get: () => !!undoTarget.value, set: (v: boolean) => { if (!v && !pendingAction.value) undoTarget.value = null; } });
const undoText = computed(() => {
  const r = undoTarget.value; if (!r) return '';
  return r.kind === 'create'
    ? '从世界书「' + r.book + '」中删除新建的条目「' + r.title + '」（uid ' + r.uid + '）。条目在写入后被修改过时不会删除。'
    : '把世界书「' + r.book + '」中的条目「' + r.title + '」（uid ' + r.uid + '）恢复到写入前的内容和关键词。条目在写入后被修改过时不会撤销，以免覆盖之后的修改。';
});
async function confirmUndo() {
  const r = undoTarget.value; if (!r) return;
  await runAction('records', async () => {
    const message = await undoApplied(r.id);
    notice.value = message;
    toast(message, 'success');
  });
  undoTarget.value = null;
}
const badgeClass = (kind: string) => (kind === 'replace' || kind === 'rewrite' ? 'is-resolve' : 'is-add');
</script>

<template>
  <div class="wb-page">
    <PageHeader title="世界书" icon="worldbook" description="根据剧情生成世界书条目的建议，审核后写入所选的世界书，写入后可以撤销。" />

    <section class="wb-panel" aria-label="写入目标与生成">
      <div class="wb-target">
        <span class="wb-target-label">写入目标</span>
        <div class="wb-target-pick">
          <BbsSelect v-if="bookOptions.length" :model-value="targetName" :options="bookOptions" aria-label="写入目标世界书" @update:model-value="chooseTarget" />
          <span v-else class="wb-target-none">没有可选的世界书</span>
          <IconButton icon="refresh" label="刷新世界书列表" :disabled="locked" @click="refreshBooks" />
        </div>
      </div>
      <div v-if="targetName && !targetProblem" class="wb-target-meta">
        <span v-for="tag in targetTags" :key="tag" class="wb-bind">{{ tag }}</span>
        <span v-if="!targetTags.length" class="wb-bind is-plain">未在当前聊天启用</span>
        <span v-if="entryCount !== null" class="wb-meta">共 {{ entryCount }} 条</span>
        <span class="wb-meta">修改权限：{{ PERMISSION_LABELS[worldbookSettings.permission] }}</span>
      </div>
      <p class="bbs-field-hint">
        按聊天记住选择；默认使用聊天绑定的世界书，没有时使用角色主世界书。
        <button v-if="worldbookState.target" type="button" class="wb-link" :disabled="locked" @click="restoreDefault">恢复默认</button>
      </p>
      <div v-if="!bindings.chat && !hostIssue" class="wb-create">
        <span>当前聊天没有绑定世界书。写进角色主世界书的条目会在这个角色的所有聊天中生效；只想用在这个聊天时，可以新建一本并绑定到当前聊天。</span>
        <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="openCreate"><Icon name="plus" />新建并绑定到当前聊天</button>
      </div>
      <p v-if="hostIssue" class="bbs-callout is-danger" role="alert">{{ hostIssue }}</p>
      <p v-else-if="worldHost.revision > 0 && worldHost.names === null" class="bbs-callout is-warning">读取不到酒馆的世界书列表，只能使用当前的写入目标。请确认酒馆已加载完成，点击右侧刷新键重试，或刷新页面。</p>
      <p v-else-if="targetProblem" class="bbs-callout is-warning">{{ targetProblem }}</p>
      <div v-if="feedbackAt === 'target' && (notice || actionError)" class="wb-inline">
        <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
        <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
      </div>

      <div class="wb-generate">
        <p class="wb-read">{{ nextRead }}</p>
        <div class="wb-actions">
          <button v-if="worldbookRun.busy" type="button" class="bbs-btn" @click="stop">取消生成</button>
          <button type="button" class="bbs-btn bbs-btn-primary" :disabled="!canGenerate" @click="generate"><Icon name="sparkles" />生成建议</button>
        </div>
      </div>
      <div v-if="apiIssue" class="bbs-callout is-warning wb-setup">
        <span>{{ apiIssue }}</span>
        <button type="button" class="bbs-btn bbs-btn-sm" @click="settingsPanel?.openApi()">打开 API 设置</button>
      </div>
      <p v-if="worldbookRun.storyBusy" class="bbs-field-hint">正文正在生成，结束后再生成建议。</p>
      <p v-else-if="!engineActiveHere()" class="bbs-field-hint">当前角色没有启用棱镜宝书，不能生成建议；已有的建议和记录仍可查看和处理。</p>
      <p v-if="pending && !worldbookRun.busy" class="bbs-field-hint">还有 {{ pending }} 条建议待审核；再次生成的建议会另列一批。</p>
    </section>

    <div class="wb-feedback" aria-live="polite">
      <p v-if="worldbookRun.busy" class="wb-status" role="status">{{ worldbookRun.status || '正在生成建议…' }}<template v-if="worldbookRun.received">（已接收 {{ worldbookRun.received }} 字）</template></p>
      <p v-else-if="worldbookRun.status" class="wb-status" role="status">{{ worldbookRun.status }}</p>
      <p v-if="feedbackAt === 'panel' && notice" class="wb-status" role="status">{{ notice }}</p>
      <p v-if="worldbookRun.autoNote" class="bbs-callout is-warning">{{ worldbookRun.autoNote }}</p>
    </div>
    <div v-if="worldbookRun.error || worldbookState.issue || (feedbackAt === 'panel' && actionError)" class="bbs-callout is-danger wb-error" role="alert">
      <p v-if="feedbackAt === 'panel' && actionError" class="wb-pre">{{ actionError }}</p>
      <template v-if="worldbookRun.error">
        <p>{{ worldbookRun.error }}</p>
        <details v-if="worldbookRun.errorDetail"><summary>技术细节</summary><p>{{ worldbookRun.errorDetail }}</p></details>
      </template>
      <p v-if="worldbookState.issue">{{ worldbookState.issue }}</p>
    </div>
    <p v-if="worldbookState.saveWarning" class="bbs-callout is-warning">{{ worldbookState.saveWarning }}</p>
    <p v-if="worldbookState.pruneNotice" class="bbs-callout is-warning">{{ worldbookState.pruneNotice }}</p>
    <details v-if="worldbookRun.lastDropped.length" class="bbs-disclosure wb-dropped">
      <summary>模型给出的 {{ worldbookRun.lastDropped.length }} 条建议不符合要求，已丢弃</summary>
      <ul><li v-for="(d, i) in worldbookRun.lastDropped" :key="i"><strong>{{ d.label }}</strong>：{{ d.reason }}</li></ul>
    </details>

    <section class="wb-section" aria-label="待审核的建议">
      <div class="wb-section-head">
        <h2 class="wb-heading">待审核的建议</h2>
        <span v-if="pending" class="wb-count">{{ pending }} 条</span>
      </div>
      <EmptyState v-if="!visibleBatches.length" icon="worldbook" title="暂无待审核的建议"
        text="点击「生成建议」读取新的楼层，也可在页面底部打开自动建议。建议经确认后才写入世界书。" />
      <article v-for="batch in visibleBatches" :key="batch.id" class="wb-batch" :class="{ 'is-stale': stale(batch) }">
        <header class="wb-batch-head">
          <div class="wb-batch-title">
            <strong>第 {{ batch.source.from }}–{{ batch.source.to }} 楼</strong>
            <span class="wb-meta">{{ batch.auto ? '自动' : '手动' }} · {{ formatTime(batch.createdAt) }} · 写入「{{ batch.book }}」</span>
          </div>
          <div class="wb-batch-actions">
            <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="askBatch('ignore', batch)">全部忽略</button>
            <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="locked || !pendingWrites(batch).length || !!bookError(batch)" @click="askBatch('apply', batch)"><Icon name="check" />{{ stale(batch) ? '仍然全部应用' : '全部应用' }}</button>
          </div>
        </header>
        <div v-if="feedbackAt === 'batch:' + batch.id && (notice || actionError)" class="wb-inline wb-batch-feedback">
          <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
          <p v-if="actionError" class="bbs-callout is-danger wb-pre" role="alert">{{ actionError }}</p>
        </div>
        <div v-if="stale(batch)" class="bbs-callout is-warning wb-stale">
          <span>这批建议依据的第 {{ batch.source.from }}–{{ batch.source.to }} 楼已被改写、重抽或删除，建议可能与现在的正文不符。可以逐条核对后点「仍然应用」，或从第 {{ batch.source.from }} 楼重新读取后重新生成。</span>
          <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="rereadFrom(batch)">从第 {{ batch.source.from }} 楼重新读取</button>
        </div>
        <p v-else-if="bookError(batch)" class="bbs-callout is-warning">{{ bookError(batch) }}</p>
        <SuggestionCard
          v-for="s in batch.suggestions"
          :key="s.id"
          :suggestion="s"
          :data="bookView(batch.book).data"
          :book-error="bookError(batch)"
          :stale="stale(batch)"
          :locked="locked"
          :permission="worldbookSettings.permission"
          @apply="applyOne(batch, s)"
          @edit="openEdit(batch, s)"
          @ignore="ignoreOne(batch, s)"
        />
        <details v-if="batch.dropped.length" class="bbs-disclosure wb-dropped">
          <summary>{{ batch.dropped.length }} 条建议不符合要求，已丢弃</summary>
          <ul><li v-for="(d, i) in batch.dropped" :key="i"><strong>{{ d.label }}</strong>：{{ d.reason }}</li></ul>
        </details>
      </article>
    </section>

    <section class="wb-section wb-records-section" aria-label="已写入记录">
      <FoldSection title="已写入记录" :count="records.length" :open="recordsOpen" empty-hint="应用建议后，写入的改动记在这里，可以撤销。" @update:open="recordsOpen = $event">
        <template #title><h2 class="wb-heading">已写入记录</h2></template>
        <p class="bbs-field-hint">每个聊天保存最近 {{ WB_LIMITS.applied }} 条。撤销时，条目自写入后没有被改过才恢复原样（新建的条目则删除）；被改过时说明原因，不覆盖。</p>
        <ul class="wb-records">
          <li v-for="r in pagedRecords" :key="r.id" class="wb-record" :class="{ 'is-undone': r.undoneAt !== null }">
            <div class="wb-record-head">
              <span class="bbs-op-badge" :class="badgeClass(r.kind)">{{ KIND_LABELS[r.kind] }}</span>
              <span class="wb-record-title">{{ r.title }}</span>
              <span class="wb-meta">uid {{ r.uid }} · 「{{ r.book }}」 · {{ formatTime(r.at) }}</span>
              <span v-if="r.undoneAt !== null" class="wb-tag">已撤销</span>
              <span v-else-if="recordStale(r)" class="wb-tag is-warning" title="这次写入依据的楼层已被改写、重抽或删除">依据楼层已改动</span>
              <button v-if="r.undoneAt === null" type="button" class="bbs-btn bbs-btn-sm wb-record-undo" :disabled="locked" @click="undoTarget = r">撤销</button>
            </div>
            <details class="wb-record-detail">
              <summary><span class="is-closed-text">查看改动</span><span class="is-open-text">收起改动</span></summary>
              <p v-if="recordKeys(r).length" class="wb-record-keys">{{ r.kind === 'create' ? '关键词' : '新增关键词' }}：{{ recordKeys(r).join('、') }}</p>
              <div class="wb-record-diff">
                <p v-if="r.before" class="wb-record-text"><span class="wb-diff-label">改前</span><span v-for="(p, i) in recordDiff(r).before" :key="i" :class="`wb-part is-${p.type}`">{{ p.text }}</span></p>
                <p class="wb-record-text"><span class="wb-diff-label">{{ r.before ? '改后' : '内容' }}</span><span v-for="(p, i) in recordDiff(r).after" :key="i" :class="`wb-part is-${p.type}`">{{ p.text }}</span></p>
              </div>
            </details>
          </li>
        </ul>
        <nav v-if="recordPages > 1" class="wb-pagination" aria-label="写入记录分页">
          <button type="button" class="bbs-btn bbs-btn-sm" :disabled="recordPage <= 1" @click="recordPage--">上一页</button>
          <span>{{ recordPage }} / {{ recordPages }}</span>
          <button type="button" class="bbs-btn bbs-btn-sm" :disabled="recordPage >= recordPages" @click="recordPage++">下一页</button>
        </nav>
        <div v-if="feedbackAt === 'records' && (notice || actionError)" class="wb-inline">
          <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
          <p v-if="actionError" class="bbs-callout is-danger" role="alert">{{ actionError }}</p>
        </div>
      </FoldSection>
    </section>

    <WorldbookSettingsPanel ref="settingsPanel" :locked="locked" :next-read="nextRead" />

    <ConfirmDialog v-model:open="batchConfirmOpen" :title="batchConfirm?.kind === 'ignore' ? '全部忽略' : batchConfirm?.ids ? '仍然应用' : batchConfirm && stale(batchConfirm.batch) ? '仍然全部应用' : '全部应用'" :confirm-text="batchConfirm?.kind === 'ignore' ? '忽略' : '写入'"
      :confirm-icon="batchConfirm?.kind === 'ignore' ? '' : 'check'" :busy="pendingAction || writerState.busy" busy-text="处理中…" @confirm="confirmBatch">{{ batchConfirmText }}</ConfirmDialog>
    <ConfirmDialog v-model:open="undoOpen" title="撤销写入" confirm-text="撤销" tone="danger" :busy="pendingAction || writerState.busy" busy-text="撤销中…" @confirm="confirmUndo">{{ undoText }}</ConfirmDialog>
    <SuggestionEditDialog :suggestion="editing?.suggestion ?? null" :entry="editEntry" :data="editData" :busy="locked" @close="editing = null" @save="saveEdit" />
    <ModalShell :open="createOpen" title="新建世界书并绑定到当前聊天" close-label="关闭新建世界书" @close="createOpen = false">
      <p class="wb-modal-text">新建一本空的世界书，绑定到当前聊天，并设为本聊天的写入目标。聊天绑定的世界书只在这个聊天中启用，不影响这个角色的其他聊天。</p>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">世界书名</span>
        <input v-model="createName" class="bbs-input" type="text" maxlength="64" autocomplete="off" @keydown.enter.prevent="confirmCreate" />
      </label>
      <p v-if="createError" class="bbs-callout is-danger" role="alert">{{ createError }}</p>
      <template #footer>
        <button type="button" class="bbs-btn" :disabled="creating" @click="createOpen = false">取消</button>
        <button type="button" class="bbs-btn bbs-btn-primary" :disabled="creating" @click="confirmCreate"><Icon name="plus" />{{ creating ? '新建中…' : '新建并绑定' }}</button>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.wb-page { width: 100%; min-width: 0; max-width: 100%; color: var(--bbs-ink); overflow-wrap: anywhere; }
.wb-page :where(section, article, details, div, form, fieldset, label) { min-width: 0; }

.wb-panel { margin: 0 0 16px; padding: 14px 18px; border: 1px solid var(--bbs-line); border-radius: 14px; background: var(--bbs-surface); }
.wb-target { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.wb-target-label { flex: 0 0 auto; font-size: 14px; font-weight: 600; }
.wb-target-pick { display: flex; flex: 1 1 260px; align-items: center; gap: 6px; min-width: 0; }
.wb-target-pick :deep(.bbs-select-box) { flex: 1 1 auto; min-width: 0; }
.wb-target-none { flex: 1 1 auto; font-size: 13px; color: var(--bbs-ink-muted); }
.wb-target-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 10px; }
.wb-bind { padding: 0 8px; border-radius: var(--bbs-radius-pill); background: var(--bbs-accent-soft); color: var(--bbs-accent); font-size: 11.5px; font-weight: 600; line-height: 1.8; }
.wb-bind.is-plain { background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-weight: 500; }
.wb-meta { font-size: 12px; color: var(--bbs-ink-muted); }
.wb-panel > .bbs-field-hint { margin: 8px 0 0; }
.wb-panel > .bbs-callout { margin: 10px 0 0; }
.wb-link { padding: 0; border: 0; background: none; color: var(--bbs-accent); font: inherit; cursor: pointer; }
.wb-link:disabled { opacity: .5; cursor: default; }
.wb-link:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }
.wb-create { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: var(--bbs-surface-2); font-size: 12.5px; line-height: 1.7; color: var(--bbs-ink-soft); }
.wb-create > span { flex: 1 1 260px; min-width: 0; }
.wb-generate { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--bbs-line); }
.wb-read { flex: 1 1 260px; min-width: 0; margin: 0; font-size: 13px; line-height: 1.7; color: var(--bbs-ink-soft); }
.wb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wb-setup { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }

.wb-feedback > :last-child { margin-bottom: 12px; }
.wb-status { margin: 0 0 12px; padding: 1px 0 1px 12px; border-left: 2px solid var(--bbs-accent); font-size: 13px; line-height: 1.7; color: var(--bbs-ink-soft); }
.wb-error { margin: 0 0 16px; }
.wb-pre { white-space: pre-line; }
.wb-inline { margin-top: 12px; }
.wb-inline > :last-child { margin-bottom: 0; }
.wb-dropped { margin: 10px 0 0; }
.wb-dropped ul { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8; color: var(--bbs-ink-soft); }
.wb-dropped strong { font-weight: 600; color: var(--bbs-ink); }

.wb-section { margin: 28px 0; }
.wb-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; margin: 0 0 10px; }
.wb-heading { margin: 0; font: 600 20px/1.5 var(--bbs-font-reading); letter-spacing: .04em; color: var(--bbs-ink); }
.wb-count { font-size: 12.5px; color: var(--bbs-ink-muted); }
.wb-batch { margin: 0 0 16px; padding: 12px 14px 14px; border: 1px solid var(--bbs-line); border-radius: 14px; background: var(--bbs-bg); }
.wb-batch.is-stale { border-style: dashed; }
.wb-batch-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.wb-batch-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-size: 14px; }
.wb-batch-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.wb-batch > .bbs-callout { margin: 10px 0 0; }
.wb-stale { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.wb-stale > span { flex: 1 1 260px; min-width: 0; }

.wb-records-section :deep(.bbs-fold) { gap: 8px; }
.wb-records { margin: 4px 0 0; padding: 0; list-style: none; }
.wb-record { padding: 10px 0; border-bottom: 1px solid var(--bbs-line); }
.wb-record:first-child { border-top: 1px solid var(--bbs-line); }
.wb-record-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.wb-record-title { font-size: 13.5px; font-weight: 600; color: var(--bbs-ink); }
.wb-record.is-undone .wb-record-title { color: var(--bbs-ink-soft); text-decoration: line-through; text-decoration-thickness: 1px; }
.wb-record-undo { margin-left: auto; }
.wb-tag { padding: 0 8px; border-radius: var(--bbs-radius-pill); background: var(--bbs-surface-2); font-size: 11.5px; line-height: 1.8; color: var(--bbs-ink-soft); }
.wb-tag.is-warning { background: var(--bbs-warning-soft); color: var(--bbs-warning); }
.wb-record-detail { margin-top: 4px; }
.wb-record-detail > summary { width: fit-content; list-style: none; cursor: pointer; font-size: 12.5px; color: var(--bbs-accent); }
.wb-record-detail > summary::-webkit-details-marker { display: none; }
.wb-record-detail > summary .is-open-text, .wb-record-detail[open] > summary .is-closed-text { display: none; }
.wb-record-detail[open] > summary .is-open-text { display: inline; }
.wb-record-detail > summary:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }
.wb-record-keys { margin: 6px 0 0; font-size: 12.5px; color: var(--bbs-ink-soft); }
.wb-record-diff { display: grid; gap: 8px; margin-top: 6px; }
.wb-record-text { max-height: 220px; margin: 0; padding: 8px 10px; overflow: auto; border: 1px solid var(--bbs-line); border-radius: 8px; background: var(--bbs-bg); white-space: pre-wrap; font: 400 13px/1.8 var(--bbs-font-reading); }
.wb-diff-label { display: block; font: 600 11.5px/1.6 var(--bbs-font-sans); color: var(--bbs-ink-muted); }
.wb-part.is-same { color: var(--bbs-ink-soft); }
.wb-part.is-removed { background: var(--bbs-danger-soft); color: var(--bbs-danger); text-decoration: line-through; text-decoration-thickness: 1px; }
.wb-part.is-added { background: var(--bbs-accent-soft); color: var(--bbs-ink); box-shadow: inset 0 -1.5px 0 var(--bbs-accent); }
.wb-pagination { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 12px; font-size: 12.5px; color: var(--bbs-ink-muted); }
.wb-modal-text { margin: 0; font-size: 13px; line-height: 1.7; color: var(--bbs-ink-soft); }

@media (max-width: 640px) {
  .wb-panel { padding: 12px 14px; }
  .wb-generate { flex-direction: column; align-items: stretch; }
  .wb-generate .wb-read { flex: 0 0 auto; }
  .wb-actions .bbs-btn { flex: 1 1 auto; }
  .wb-heading { font-size: 18px; }
  .wb-batch { padding: 12px; }
  .wb-batch-actions { width: 100%; }
  .wb-batch-actions .bbs-btn { flex: 1 1 0; }
}
</style>
