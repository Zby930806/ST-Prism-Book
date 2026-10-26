<script setup lang="ts">
/**
 * 角色重新建档的进度与未完成记录：进行中显示进度条和「取消」；停下或做完时写明进度、新找到的角色和档案改动的数量、
 * 跳过的批次和失败原因，提供「继续」「审核」「放弃」。开始、审核与放弃的弹窗由角色页处理。
 */
import { cancelNpcRefile, npcRefileState, refileReview, refileSkipText, type RefileRecord } from '@/memory/npcRefile';
import { computed } from 'vue';

const props = defineProps<{ record: RefileRecord | null }>();
const emit = defineEmits<{ (e: 'continue'): void; (e: 'review'): void; (e: 'discard'): void }>();

const rec = computed(() => props.record);
const counts = computed(() => {
  if (!rec.value) return { added: 0, changes: 0 };
  const review = refileReview(rec.value);
  return { added: review.added.length, changes: review.changes.length };
});
const percent = computed(() => (npcRefileState.total ? Math.min(100, Math.round((npcRefileState.done / npcRefileState.total) * 100)) : 0));
const stepText = computed(() => (npcRefileState.phase === 'archive'
  ? `第二步：重做档案 ${npcRefileState.done}/${npcRefileState.total} 个角色`
  : `第一步：补齐漏记 ${npcRefileState.done}/${npcRefileState.total} 批`));
const progressText = computed(() => {
  const r = rec.value;
  if (!r) return '';
  if (r.phase === 'discover') return `第一步已完成 ${r.discoverDone} 批`;
  if (r.phase === 'archive') return `第一步已完成，第二步已整理 ${r.archiveDone}/${r.archiveQueue.length} 个角色`;
  return '两步都已完成';
});
const resultText = computed(() => `找到 ${counts.value.added} 个新角色，${counts.value.changes} 项档案改动`);
const skippedText = computed(() => {
  const list = rec.value?.skipped ?? [];
  if (!list.length) return '';
  return `${list.length} 批没有可用的回复，已跳过：${list.map(refileSkipText).join('；')}。`;
});
</script>

<template>
  <div v-if="npcRefileState.running" class="bbs-refile-progress" role="status" aria-live="polite">
    <div class="bbs-refile-progress-line">
      <span class="bbs-spin"></span>
      <span class="bbs-refile-progress-title">角色重新建档</span>
      <span class="bbs-refile-progress-step">{{ stepText }}</span>
      <span v-if="npcRefileState.current" class="bbs-refile-progress-current">{{ npcRefileState.current }}</span>
      <button class="bbs-btn bbs-btn-sm bbs-refile-cancel" type="button" :disabled="npcRefileState.cancelRequested" @click="cancelNpcRefile">
        {{ npcRefileState.cancelRequested ? '停止中…' : '取消' }}
      </button>
    </div>
    <div class="bbs-refile-bar" aria-hidden="true"><i :style="{ width: percent + '%' }"></i></div>
  </div>

  <div v-else-if="rec" class="bbs-callout bbs-refile-notice" :class="rec.phase === 'review' ? 'is-success' : 'is-warning'" role="status">
    <span class="bbs-callout-title">{{ rec.phase === 'review' ? '角色重新建档已完成，等待审核' : '角色重新建档没有完成' }}</span>
    <span class="bbs-callout-help">{{ progressText }}；{{ resultText }}。结果审核并应用后才写入。</span>
    <span v-if="skippedText" class="bbs-callout-help">{{ skippedText }}</span>
    <span v-if="rec.error" class="bbs-callout-help bbs-refile-error">上次停下的原因：{{ rec.error }}</span>
    <div class="bbs-refile-actions">
      <button v-if="rec.phase !== 'review'" class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="emit('continue')">继续</button>
      <button v-if="rec.phase === 'review' || counts.added || counts.changes" class="bbs-btn bbs-btn-sm" :class="{ 'bbs-btn-primary': rec.phase === 'review' }" type="button" @click="emit('review')">
        {{ rec.phase === 'review' ? '审核' : '审核已找到的结果' }}
      </button>
      <button class="bbs-btn bbs-btn-sm" type="button" @click="emit('discard')">放弃</button>
    </div>
  </div>
</template>

<style scoped>
/* 进行中:与摘要页批量补摘同一画法——细边卡片、旋转环、进度文字、取消键,下方一条细进度条 */
.bbs-refile-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 0 22px;
  padding: 12px 16px 14px;
  border: 1px solid var(--bbs-line);
  border-left: 3px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-refile-progress-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
}
.bbs-refile-progress-line .bbs-spin { width: 12px; height: 12px; }
.bbs-refile-progress-step { font-weight: 500; color: var(--bbs-ink-soft); }
.bbs-refile-progress-current { min-width: 0; font-weight: 400; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-refile-cancel { margin-left: auto; }
.bbs-refile-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  overflow: hidden;
}
.bbs-refile-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
/* 停下或待审核:提示框加一行操作键 */
.bbs-refile-notice { margin: 0 0 22px; }
.bbs-refile-error { overflow-wrap: anywhere; }
.bbs-refile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
</style>
