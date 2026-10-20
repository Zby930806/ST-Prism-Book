<script setup lang="ts">
/**
 * 编辑单条摘要 / 总结的弹窗。叶子：可改「故事内时间」+ 正文；总结：只压文本，故只改正文。
 * nested = 该节点已被某条总结收纳：编辑它不影响上层总结文本（总结只压快照），
 * 弹窗里提示「上层总结不会跟着变」，免得改完发现总结里旧信息还在、以为没保存上。
 * 由列表（卡片的编辑键，经 SUMMARY_CTX.openEdit）调用 open(row) 打开。
 */
import ModalShell from '@/components/ModalShell.vue';
import { editLeafAt, editSummary } from '@/memory/apply';
import { refreshInjection } from '@/memory/inject';
import { memory } from '@/memory/store';
import { splitTimeLabel } from '@/memory/timeTag';
import { computed, ref } from 'vue';
import type { SummaryRow } from './ctx';
import { levelLabel } from './labels';
import { useSummaryPage } from './pageCtx';

const page = useSummaryPage();
const { editingBlocked, allowMemoryEdit } = page;

type Editing =
  | { kind: 'leaf'; msgIndex: number; text: string; timeStart: string; timeEnd: string; nested: boolean }
  | { kind: 'comp'; compId: string; level: number; text: string; imported: boolean; nested: boolean };
const editing = ref<Editing | null>(null);

/**
 * 编辑框下只显示字数，按字符计（含标点）。设置里的「摘要字数」是写给模型的提示词，不限制手动编辑，
 * 所以这里不拿它比较、也不变色。
 */
const editingCount = computed(() => (editing.value ? `${Array.from(editing.value.text.trim()).length} 字` : ''));

/** 该 id 是否已被任何总结的 childIds 收纳（= 展开视图里的深层行） */
function isNested(id: string): boolean {
  return memory.summaries.some(s => (s.childIds ?? []).includes(id));
}

function open(r: SummaryRow) {
  if (!allowMemoryEdit()) return;
  if (r.kind === 'leaf' && typeof r.msgIndex === 'number') {
    // 旧数据无 timeStart/timeEnd 时，从已固化的 timeLabel 拆出起止填入
    const fb = !r.timeStart && !r.timeEnd ? splitTimeLabel(r.timeLabel) : {};
    editing.value = {
      kind: 'leaf',
      msgIndex: r.msgIndex,
      text: r.text,
      timeStart: r.timeStart ?? fb.start ?? '',
      timeEnd: r.timeEnd ?? fb.end ?? '',
      nested: isNested(r.id),
    };
  } else if (r.kind === 'comp') {
    editing.value = { kind: 'comp', compId: r.id, level: r.level, text: r.text, imported: r.imported === true, nested: isNested(r.id) };
  }
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  if (!allowMemoryEdit()) return;
  const e = editing.value;
  if (!e) return;
  if (e.kind === 'leaf') editLeafAt(e.msgIndex, e.text, e.timeStart, e.timeEnd);
  else editSummary(e.compId, e.text);
  refreshInjection();
  editing.value = null;
}

page.onCloseEditors(cancelEdit);
defineExpose({ open });
</script>

<template>
  <ModalShell
    v-if="!editingBlocked"
    :open="!!editing"
    :title="editing ? (editing.kind === 'comp' ? `编辑${levelLabel(editing.level, editing.imported)}` : `编辑摘要 · 楼层 #${editing.msgIndex}`) : ''"
    :aria-label="editing?.kind === 'comp' ? '编辑总结' : '编辑摘要'"
    @close="cancelEdit"
  >
    <template v-if="editing">
      <!-- 已被总结收纳的节点:提醒上层总结不会跟着变。叶子才提向量召回(总结不进向量库) -->
      <p v-if="editing.nested" class="bbs-field-hint bbs-nested-hint">
        {{ editing.kind === 'leaf'
          ? '这条已经合并进上层总结。改动会用于向量召回，但上层总结的文字不会跟着变；如果总结里也有同样的错误，请一起改。'
          : '这条已经合并进更上层的总结，改动不会同步上去；如果上层也有同样的错误，请一起改。' }}
      </p>
      <!-- 时间仅叶子可编辑(起止两端);总结只压文本,无时间字段 -->
      <div v-if="editing.kind === 'leaf'" class="bbs-modal-field bbs-time-pair">
        <label class="bbs-time-col">
          <span class="bbs-modal-label">开始时间</span>
          <input v-model="editing.timeStart" class="bbs-input" type="text" placeholder="如 1988/9/29 21:00" />
        </label>
        <label class="bbs-time-col">
          <span class="bbs-modal-label">结束时间</span>
          <input v-model="editing.timeEnd" class="bbs-input" type="text" placeholder="如 1988/9/29 21:30" />
        </label>
      </div>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">{{ editing.kind === 'comp' ? (editing.imported ? '旧总结内容' : '总结内容') : '摘要内容' }}</span>
        <textarea v-model="editing.text" class="bbs-input bbs-modal-textarea" rows="8"></textarea>
      </label>
      <p class="bbs-field-hint bbs-edit-count" aria-live="polite">{{ editingCount }}</p>
    </template>
    <template #footer>
      <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="saveEdit">保存</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 起止时间:两个输入框并排,各占一半 */
.bbs-time-pair {
  display: flex;
  gap: 10px;
}
.bbs-time-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 编辑已被总结收纳的节点时的提醒 */
.bbs-nested-hint {
  margin-bottom: 14px;
  color: var(--bbs-warning);
}
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}
/* 编辑框下的字数:右对齐、贴着输入框(抵掉弹窗的 14px 间距),只是提示,不变色 */
.bbs-modal .bbs-edit-count {
  margin: -10px 0 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .bbs-time-pair { flex-direction: column; }
  .bbs-time-col { width: 100%; }
}
</style>
