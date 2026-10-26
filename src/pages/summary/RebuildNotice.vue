<script setup lang="ts">
/**
 * 全部重新摘要未完成（取消、失败、切换聊天或刷新后）：显示已完成多少层、停在哪一楼，提供「继续」和「结束」。
 * 结束只删运行记录，不改已有摘要。处理中由 PendingFloors 显示进度条，这里不显示。
 */
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { batchState, engineState } from '@/memory/engine';
import { computed, ref } from 'vue';
import { useSummaryPage } from './pageCtx';

const page = useSummaryPage();
const { editingBlocked } = page;
const { rebuildProgressView, resumeRebuild, endRebuild } = page.rebuild;
const progress = computed(() => (batchState.running ? null : rebuildProgressView.value));
const endConfirmOpen = ref(false);
page.onCloseEditors(() => { endConfirmOpen.value = false; });
function confirmEnd() {
  endConfirmOpen.value = false;
  endRebuild();
}
</script>

<template>
  <div v-if="progress" class="bbs-callout is-warning bbs-rebuild-notice" role="status">
    <template v-if="progress.next !== null">
      <strong class="bbs-callout-title">全部重新摘要未完成：已完成 {{ progress.done }}/{{ progress.total }} 层，停在 #{{ progress.next }}</strong>
      <span class="bbs-callout-help">继续时只处理还没有重新摘要的楼层。结束后不再保留这次的进度：已完成的楼层保留新结果，其余保留原摘要。</span>
      <div class="bbs-rebuild-actions">
        <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" :disabled="engineState.running" @click="resumeRebuild">继续</button>
        <button class="bbs-btn bbs-btn-sm" type="button" :disabled="engineState.running" @click="endConfirmOpen = true">结束</button>
      </div>
    </template>
    <template v-else>
      <strong class="bbs-callout-title">全部重新摘要已完成：{{ progress.done }}/{{ progress.total }} 层</strong>
      <div class="bbs-rebuild-actions">
        <button class="bbs-btn bbs-btn-sm" type="button" :disabled="engineState.running" @click="endRebuild">知道了</button>
      </div>
    </template>
  </div>

  <ConfirmDialog v-if="!editingBlocked" v-model:open="endConfirmOpen" title="结束全部重新摘要" confirm-text="结束" @confirm="confirmEnd">
    结束后不再保留这次的进度：已重新摘要的 {{ progress?.done ?? 0 }} 层保留新结果，其余 {{ progress ? progress.total - progress.done : 0 }} 层保留原摘要。之后要处理剩下的楼层，需要重新开始全部重新摘要。
  </ConfirmDialog>
</template>

<style scoped>
/* 未完成提示：沿用共享提示条，按钮另起一行并排 */
.bbs-rebuild-notice {
  margin-top: 14px;
}
.bbs-rebuild-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>
