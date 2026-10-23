<script setup lang="ts">
/** 「创作规划」折叠行：行内显示阶段与状态，展开后是说明和规划编辑器（OutlinePlanner，界面由创作规划页负责）。 */
import OutlinePlanner from '@/pages/outline/index.vue';
import { engineActiveHere } from '@/api/settings';
import { outlineSourceCurrent, outlineState } from '@/outline/store';
import { computed } from 'vue';
import ReaderRow from './ReaderRow.vue';
import { useSummaryPage } from './pageCtx';

const { editingBlocked } = useSummaryPage();
// 与规划卡片的状态一致：参考的正文被改写、重抽或删除后，规划不再注入，这里也显示「剧情有改动，已暂停」。
const outlineLine = computed(() => {
  void outlineState.revision;
  const a = outlineState.active;
  if (a) {
    const n = a.content.chapters.length;
    if (a.currentChapter >= n) return `${n} 个阶段 · 已结束`;
    const state = !engineActiveHere() ? '未启用' : !outlineSourceCurrent(a) ? '剧情有改动，已暂停' : a.enabled ? '正在生效' : '已暂停';
    return `第 ${a.currentChapter + 1}/${n} 阶段 · ${state}`;
  }
  return outlineState.draft ? '有待确认的草稿' : '尚未规划';
});
</script>

<template>
  <ReaderRow icon="navigate" title="创作规划" :line="outlineLine" class="bbs-outline-row">
    <p class="bbs-outline-intro">根据剧情和用户要求规划后续走向。规划是写作方向，不是已发生的事；确认后注入正文，每次只注入当前阶段。</p>
    <OutlinePlanner :disabled="editingBlocked" />
  </ReaderRow>
</template>

<style scoped>
.bbs-outline-intro { margin:0 0 12px; max-width:62ch; font-size:13px; line-height:1.75; color:var(--bbs-ink-soft); }
</style>
