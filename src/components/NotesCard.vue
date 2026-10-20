<script setup lang="ts">
/**
 * 聊天里的札记卡片:挂在最新正文楼层和有札记的楼层下方(由 notesPanel.ts 逐楼挂载)。
 * 卡片外壳(头部按钮、抽屉、inert)与分区标题直接用楼层面板的 FloorCardShell、FloorSection,两者外观保持一致。
 *
 * - 最新正文楼层:没有札记时显示「生成札记」;生成中显示进度和已写出的内容,可取消。
 * - 有札记的楼层:卡片头显示问题数和确认情况,展开后看札记全文,逐题确认安排或搁置。
 * - 失效札记(正文改过、楼层被删)不在聊天里显示,仍可在「札记」页查看。
 *
 * 数据读写全部走 notes/store 与 notes/service,与札记页共用同一份状态(notesState / notesRun)。
 */
import { computed, reactive, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import FloorCardShell from '@/components/floor/FloorCardShell.vue';
import FloorSection from '@/components/floor/FloorSection.vue';
import { getContext } from '@/st/context';
import { openBook, ui } from '@/state/ui';
import { notesSettings, notesChannelIssue, settingsIssue } from '@/notes/settings';
import { notesRun, generateNotes, cancelNotes } from '@/notes/service';
import { notesState, recordIsCurrent, confirmQuestion, rejectQuestion, notesWriteIssue, deleteNote } from '@/notes/store';
import { toast } from '@/st/toast';
import { latestStoryFloor } from '@/notes/source';
import { floorNote } from '@/notes/floors';
import type { NoteDecision } from '@/notes/types';

const props = defineProps<{ floor: number; sig: { tick: number } }>();

const STATUS_LABEL: Record<NoteDecision['status'], string> = {
  pending: '待兑现', in_progress: '进行中', completed: '已完成', cancelled: '已取消', rejected: '已搁置',
};

// chat 非 reactive:sig.tick(宿主转发的酒馆事件)与 notesState.revision(札记读写)两路触发重算
const isLatest = computed(() => {
  void props.sig.tick;
  void notesState.revision;
  const ctx = getContext();
  return !!ctx && latestStoryFloor(ctx) === props.floor;
});
const record = computed(() => {
  void props.sig.tick;
  void notesState.revision;
  return floorNote(props.floor);
});
// 同一段正文重新生成后,旧札记的提案不能再确认(与札记页同一规则)
const current = computed(() => {
  void props.sig.tick;
  void notesState.revision;
  return !!record.value && recordIsCurrent(record.value);
});
const running = computed(() => notesRun.busy && notesRun.floor === props.floor);
// 生成结束后的结果说明(保存成功、截断、失败)只在对应楼层显示,直到下一次生成
const message = computed(() => {
  if (notesRun.busy || notesRun.floor !== props.floor) return null;
  if (notesRun.error) return { kind: 'error', text: notesRun.error, detail: notesRun.errorDetail };
  if (notesRun.status) return { kind: notesRun.errorDetail ? 'warning' : 'info', text: notesRun.status, detail: notesRun.errorDetail };
  return null;
});
const visible = computed(() => notesSettings.enabled && notesSettings.showInChat && (!!record.value || isLatest.value || running.value));

const decisionOf = (questionId: string) => {
  void notesState.revision;
  const r = record.value;
  return r ? notesState.decisions.find(d => d.noteId === r.id && d.questionId === questionId) ?? null : null;
};
const confirmedCount = computed(() => {
  void notesState.revision;
  const r = record.value;
  if (!r) return 0;
  return r.questions.filter(q => {
    const s = decisionOf(q.id)?.status;
    return s === 'pending' || s === 'in_progress' || s === 'completed';
  }).length;
});
const headSummary = computed(() => {
  const r = record.value;
  if (running.value) return '正在生成札记…';
  if (!r) return '本楼还没有札记';
  if (!r.questions.length) return '札记中没有编号问题';
  return `${r.questions.length} 个问题 · 已确认 ${confirmedCount.value}`;
});

const expanded = ref(false);
// 新札记写完时自动展开,便于直接确认;已有的札记默认收起,不占聊天版面
watch(() => record.value?.id, (id, old) => {
  if (id && old !== undefined && id !== old) expanded.value = true;
});
watch(running, on => { if (on) expanded.value = true; }, { immediate: true });

/* ============ 确认与搁置 ============ */
const edits = reactive<Record<string, string>>({});
// 只补还没有的输入框内容:确认一题后其他题里没保存的修改保留(与札记页一致);换了一份札记才整体重填
function fillEdits() {
  const r = record.value;
  if (!r) return;
  for (const q of r.questions) if (!(q.id in edits)) edits[q.id] = decisionOf(q.id)?.text ?? q.proposal;
}
watch(() => record.value?.id, () => {
  for (const key of Object.keys(edits)) delete edits[key];
  fillEdits();
}, { immediate: true });
watch(() => notesState.revision, fillEdits);

const pending = ref(false);
const feedback = reactive({ at: '', text: '', error: false });
function say(at: string, text: string, error = false) {
  Object.assign(feedback, { at, text, error });
}
async function act(at: string, task: () => Promise<void>, done: string) {
  if (pending.value || notesRun.busy) return;
  pending.value = true;
  say(at, '');
  try {
    await task();
    say(at, done);
  } catch (error) {
    say(at, error instanceof Error ? error.message : '操作没有完成，请重试。', true);
  } finally {
    pending.value = false;
  }
}
function confirm(questionId: string) {
  const r = record.value;
  if (!r) return;
  const text = (edits[questionId] ?? '').trim();
  if (!text || text.length > 4000) { say(questionId, '采用方案要写 1–4000 字。', true); return; }
  void act(questionId, () => confirmQuestion(r.id, questionId, text), '已确认，加入「已确认的安排」。');
}
function reject(questionId: string) {
  const r = record.value;
  if (!r) return;
  void act(questionId, () => rejectQuestion(r.id, questionId), '已搁置，不注入正文。');
}

/* ============ 生成 ============ */
// 生成前的检查与札记页一致;不满足时说明原因,并给出去札记页填写的入口
const blocker = computed(() => {
  void notesState.revision;
  if (settingsIssue.value) return settingsIssue.value;
  const channel = notesChannelIssue();
  if (channel) return '札记 API 还没有填写完整，在「札记」页底部的「独立 API 设置」中填写。';
  return notesWriteIssue();
});
const canGenerate = computed(() => isLatest.value && !blocker.value && !notesRun.busy && !notesRun.storyBusy && !pending.value);
function generate(force: boolean) {
  if (!canGenerate.value) return;
  say('', '');
  void generateNotes(force);
}
function openNotesPage() {
  openBook('notes');
}

/* ============ 删除 ============ */
// 行内两步确认:每张卡片是独立的 shadow,没有弹窗宿主(与楼层面板的删除摘要相同)。删除连同这份札记的安排一起删。
const confirmingDelete = ref(false);
const linkedDecisions = computed(() => {
  void notesState.revision;
  const r = record.value;
  return r ? notesState.decisions.filter(d => d.noteId === r.id).length : 0;
});
watch([() => record.value?.id, expanded], () => { confirmingDelete.value = false; });
function askDelete() {
  if (pending.value || notesRun.busy || !record.value) return;
  confirmingDelete.value = true;
}
async function removeNote() {
  const r = record.value;
  if (!r || pending.value) return;
  pending.value = true;
  try {
    await deleteNote(r.id);
    toast(`第 ${props.floor} 楼的札记已删除。`, 'success');
  } catch (error) {
    toast(error instanceof Error ? error.message : '札记没有删除，请重试。', 'error');
  } finally {
    pending.value = false;
    confirmingDelete.value = false;
  }
}
</script>

<template>
  <div v-if="visible" class="bbs-root bbs-nc" :data-theme="ui.theme">
    <FloorCardShell v-model:expanded="expanded" :drawer-id="`bbs-nc-body-${floor}`" caret class="bbs-nc-card" :class="{ 'is-running': running }">
      <template #head>
        <span class="bbs-nc-row">
          <span class="bbs-nc-badge"><Icon name="notes" />札记</span>
          <span class="bbs-nc-summary">{{ headSummary }}</span>
          <span v-if="running" class="bbs-nc-spinner" aria-hidden="true"></span>
        </span>
      </template>

      <!-- 生成中:卡片头已写「正在生成札记…」,这里只显示已写出的内容,写完才保存 -->
      <template v-if="running">
        <pre v-if="notesRun.draft" class="bbs-nc-text bbs-nc-draft" aria-live="polite">{{ notesRun.draft }}</pre>
        <p v-else class="bbs-nc-note">等待模型返回内容；写完后保存，生成过程中可取消。</p>
        <div class="bbs-nc-footer">
          <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelNotes">取消生成</button>
        </div>
      </template>

      <template v-else>
        <div v-if="message" class="bbs-callout bbs-nc-message" :class="message.kind === 'error' ? 'is-danger' : message.kind === 'warning' ? 'is-warning' : ''" :role="message.kind === 'error' ? 'alert' : 'status'">
          <p>{{ message.text }}</p>
          <details v-if="message.detail"><summary>技术细节</summary><p>{{ message.detail }}</p></details>
        </div>

        <template v-if="record">
          <p v-if="!current" class="bbs-callout is-warning bbs-nc-message">同一段正文后来又生成了新的札记，这份札记中的方案不能再确认。</p>
          <pre class="bbs-nc-text">{{ record.text }}</pre>
          <FloorSection v-if="record.questions.length" icon="checklist" :title="`问题 · ${record.questions.length} 个`">
            <section v-for="q in record.questions" :key="q.id" class="bbs-nc-question">
              <div class="bbs-nc-qhead">
                <span class="bbs-nc-qid">{{ q.label }}</span>
                <p class="bbs-nc-qprompt">{{ q.prompt }}</p>
              </div>
              <label class="bbs-nc-field">
                <span class="bbs-nc-label">采用方案</span>
                <textarea
                  v-model="edits[q.id]"
                  class="bbs-input bbs-nc-textarea"
                  rows="3"
                  maxlength="4000"
                  :disabled="pending || !current"
                  :aria-label="`第 ${floor} 楼 ${q.label} 采用方案`"
                  placeholder="填写这一条的兑现方式，可直接修改暂定写法。"
                ></textarea>
              </label>
              <p v-if="decisionOf(q.id)" class="bbs-nc-state">当前状态：{{ STATUS_LABEL[decisionOf(q.id)!.status] }}。修改方案后需再次确认。</p>
              <div class="bbs-nc-actions">
                <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" :disabled="pending || !current || !edits[q.id]?.trim()" @click="confirm(q.id)">确认安排</button>
                <button class="bbs-btn bbs-btn-sm" type="button" :disabled="pending || !current || decisionOf(q.id)?.status === 'rejected'" @click="reject(q.id)">搁置</button>
              </div>
              <p v-if="feedback.at === q.id && feedback.text" class="bbs-nc-feedback" :class="{ 'is-error': feedback.error }" :role="feedback.error ? 'alert' : 'status'">{{ feedback.text }}</p>
            </section>
          </FloorSection>
          <p v-else class="bbs-nc-note">札记中没有 Q1–Q4 形式的编号问题，没有可确认的方案。</p>
        </template>
        <p v-else class="bbs-nc-note">根据最近的剧情在故事外提出问题；确认后的方案作为「安排」，可注入正文。</p>

        <p v-if="isLatest && blocker" class="bbs-nc-hint is-warn">{{ blocker }}</p>
        <p v-else-if="isLatest && notesRun.storyBusy" class="bbs-nc-hint">正文生成结束后才能生成札记。</p>

        <div v-if="confirmingDelete" class="bbs-nc-footer is-confirm">
          <span class="bbs-nc-confirm-text">删除这份札记？{{ linkedDecisions ? `其中的 ${linkedDecisions} 条安排会一起删除。` : '' }}</span>
          <button class="bbs-btn bbs-btn-sm" type="button" :disabled="pending" @click="confirmingDelete = false">取消</button>
          <button class="bbs-nc-confirm-ok" type="button" :disabled="pending" @click="removeNote"><Icon name="trash" />删除</button>
        </div>
        <div v-else class="bbs-nc-footer">
          <button v-if="isLatest && !record" class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" :disabled="!canGenerate" @click="generate(false)"><Icon name="edit" />生成札记</button>
          <button v-else-if="isLatest" class="bbs-btn bbs-btn-sm" type="button" :disabled="!canGenerate" @click="generate(true)"><Icon name="refresh" />重新生成</button>
          <button class="bbs-btn bbs-btn-sm" type="button" @click="openNotesPage"><Icon name="navigate" />札记页</button>
          <button v-if="record" class="bbs-nc-delete" type="button" title="删除这份札记" :disabled="pending || notesRun.busy" @click="askDelete"><Icon name="trash" />删除札记</button>
        </div>
      </template>
    </FloorCardShell>
  </div>
</template>

<style scoped>
.bbs-nc {
  margin: 6px 0 2px;
}
/* 卡片外壳、头部按钮、抽屉的尺寸来自 FloorCardShell;这里只写札记自己的内容 */
.bbs-nc-card.is-running {
  border-left: 3px solid var(--bbs-accent);
}
.bbs-nc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bbs-nc-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: var(--bbs-fs-badge);
  font-weight: 600;
}
.bbs-nc-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--bbs-fs-sm);
  color: var(--bbs-ink-soft);
}
.bbs-nc-spinner {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  box-sizing: border-box;
  border: 2px solid var(--bbs-accent);
  border-right-color: transparent;
  border-radius: 50%;
  animation: bbs-nc-spin 0.7s linear infinite;
}
@keyframes bbs-nc-spin {
  to { transform: rotate(360deg); }
}

.bbs-nc-message {
  margin: 0 0 10px;
  font-size: var(--bbs-fs-meta);
}
/* 札记全文:与楼层面板的摘要正文同一种抬起块,保留阅读字体 */
.bbs-nc-text {
  box-sizing: border-box;
  margin: 0 0 12px;
  max-height: 340px;
  overflow: auto;
  padding: 9px 11px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font: 400 13px/1.85 var(--bbs-font-reading);
  color: var(--bbs-ink);
}
.bbs-nc-draft {
  max-height: 240px;
  border-style: dashed;
  border-color: var(--bbs-accent);
}
/* 问题条目:分区里只保留一层底色,与楼层面板的变动条目相同 */
.bbs-nc-question {
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
}
.bbs-nc-qhead {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.bbs-nc-qid {
  flex: 0 0 auto;
  min-width: 28px;
  padding: 0 6px;
  border-radius: var(--bbs-radius-xs);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font: 600 var(--bbs-fs-badge)/22px var(--bbs-font-mono);
  text-align: center;
}
.bbs-nc-qprompt {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: var(--bbs-fs-sm);
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bbs-nc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.bbs-nc-label {
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-soft);
}
.bbs-nc-textarea {
  box-sizing: border-box;
  max-width: 100%;
  min-height: 72px;
  resize: vertical;
  font-size: var(--bbs-fs-sm);
  line-height: 1.7;
}
.bbs-nc-state {
  margin: 6px 0 0;
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-muted);
}
.bbs-nc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.bbs-nc-actions .bbs-btn,
.bbs-nc-footer .bbs-btn {
  min-height: var(--bbs-control-h-sm);
}
/* 页脚:与楼层面板页脚同样以细线隔开 */
.bbs-nc-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--bbs-line);
}
/* 删除入口:安静的图标+字,靠右;悬停才显危险色(与楼层面板的删除摘要相同) */
.bbs-nc-delete {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: var(--bbs-control-h-sm);
  padding: 5px 10px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: var(--bbs-fs-meta);
  cursor: pointer;
}
.bbs-nc-delete:hover:not(:disabled) {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-nc-delete:disabled {
  opacity: 0.55;
}
.bbs-nc-confirm-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-soft);
}
.bbs-nc-confirm-ok {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: var(--bbs-control-h-sm);
  padding: 5px 12px;
  border: 1px solid var(--bbs-danger);
  border-radius: 9px;
  background: var(--bbs-danger);
  color: var(--bbs-danger-ink);
  font-size: var(--bbs-fs-meta);
  font-weight: 600;
  cursor: pointer;
}
.bbs-nc-confirm-ok:disabled {
  opacity: 0.55;
}
.bbs-nc-feedback {
  margin: 6px 0 0;
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-soft);
}
.bbs-nc-feedback.is-error {
  color: var(--bbs-danger);
}
/* 说明条:与楼层面板的说明条相同 */
.bbs-nc-note {
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
  font-size: var(--bbs-fs-meta);
  line-height: 1.6;
  text-wrap: pretty;
}
.bbs-nc-hint {
  margin: 10px 0 0;
  font-size: var(--bbs-fs-meta);
  line-height: 1.7;
  color: var(--bbs-ink-muted);
}
.bbs-nc-hint.is-warn {
  color: var(--bbs-warning);
}

@media (max-width: 640px), (pointer: coarse) {
  .bbs-nc-actions .bbs-btn,
  .bbs-nc-footer .bbs-btn {
    flex: 1 1 auto;
    min-height: 40px;
    justify-content: center;
  }
  .bbs-nc-delete,
  .bbs-nc-confirm-ok {
    min-height: 40px;
  }
  /* 确认行:提示独占一行,取消与删除等宽并排 */
  .bbs-nc-footer.is-confirm .bbs-nc-confirm-text {
    flex-basis: 100%;
  }
  .bbs-nc-footer.is-confirm .bbs-btn,
  .bbs-nc-footer.is-confirm .bbs-nc-confirm-ok {
    flex: 1 1 0;
    justify-content: center;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bbs-nc-spinner {
    animation-duration: 1.4s;
  }
}
</style>
