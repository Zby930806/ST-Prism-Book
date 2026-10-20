<script setup lang="ts">
/** 摘要页概览：逐楼摘要、总结、待补摘三项计数与记忆状态，常驻的「补摘」入口（没有漏摘的楼层时禁用），下方为楼层光谱。 */
import Icon from '@/components/Icon.vue';
import { batchState, engineState } from '@/memory/engine';
import { compatibilityState, derivedMeta, memory } from '@/memory/store';
import { computed } from 'vue';
import FloorSpectrum from './FloorSpectrum.vue';
import { useSummaryPage } from './pageCtx';

const page = useSummaryPage();
const { editingBlocked, conversionBusy, pendingFloors } = page;
const { openBatchConfirm } = page.batch;
// 概览仅取当前响应式记忆；兼容报告是历史快照，不参与实时计数。
const liveLeafCount = computed(() => derivedMeta.leaves.filter(leaf => !leaf.stale).length);
</script>

<template>
  <section class="bbs-overview" aria-label="当前聊天概览">
    <dl class="bbs-overview-stats">
      <div><dt>逐楼摘要</dt><dd>{{ editingBlocked ? '—' : liveLeafCount }}</dd></div>
      <div><dt>总结</dt><dd>{{ editingBlocked ? '—' : memory.summaries.length }}</dd></div>
      <div class="bbs-overview-pending" :class="{ 'has-pending': !editingBlocked && pendingFloors.length > 0 }"><dt>待补摘</dt><dd>{{ editingBlocked ? '—' : pendingFloors.length }}</dd></div>
    </dl>
    <div class="bbs-overview-side">
      <span class="bbs-overview-status" :class="{ 'is-protected': editingBlocked }">{{ conversionBusy ? '正在转换' : compatibilityState.mode === 'ready' ? '记忆正常' : compatibilityState.mode === 'convert' ? '需要转换' : '只读保护' }}</span>
      <!-- 补摘入口常驻：没有漏摘的楼层时灰掉，有就显示层数，点开是批量补摘的确认。 -->
      <button
        class="bbs-btn bbs-btn-primary bbs-backfill-btn"
        type="button"
        :disabled="editingBlocked || engineState.running || batchState.running || !pendingFloors.length"
        title="按楼层顺序为未摘要的楼层生成摘要和状态，不覆盖已有摘要"
        @click="openBatchConfirm"
      ><Icon name="plus" />{{ !editingBlocked && pendingFloors.length ? `补摘 ${pendingFloors.length} 层` : '补摘' }}</button>
    </div>
    <FloorSpectrum v-if="!editingBlocked" class="bbs-overview-spectrum" />
  </section>
</template>

<style scoped>
/* 概览：三项计数一行，状态靠右；楼层光谱另起一行占满宽度。 */
.bbs-overview { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin:0 0 14px; padding:16px 20px; border:1px solid var(--bbs-line); border-radius:14px; background:var(--bbs-surface); }
.bbs-overview-spectrum { flex:1 1 100%; padding-top:14px; border-top:1px solid var(--bbs-line); }
.bbs-overview-stats { flex:1 1 auto; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:0; }
.bbs-overview-stats > div { display:flex; flex-direction:column; min-width:0; }
.bbs-overview-stats dd { order:-1; margin:0 0 2px; font:500 26px/1.2 var(--bbs-font-reading); font-variant-numeric:tabular-nums; color:var(--bbs-ink); }
.bbs-overview-stats dt { font-size:12px; color:var(--bbs-ink-muted); }
.bbs-overview-pending.has-pending dd { color:var(--bbs-accent); }
.bbs-overview-status { flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:var(--bbs-radius-pill); background:var(--bbs-surface-2); font-size:12px; color:var(--bbs-ink-soft); }
.bbs-overview-status::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--bbs-accent); }
.bbs-overview-status.is-protected { color:var(--bbs-warning); background:var(--bbs-warning-soft); }
.bbs-overview-status.is-protected::before { background:var(--bbs-warning); }
.bbs-overview-side { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; gap:10px; }
.bbs-backfill-btn { white-space:nowrap; }
@media(max-width:640px) {
 .bbs-overview { padding:14px 16px; gap:10px; flex-wrap:wrap; }
 .bbs-overview-stats { flex-basis:100%; }
 .bbs-overview-stats dd { font-size:24px; }
 .bbs-overview-side { flex-basis:100%; flex-direction:row; align-items:center; justify-content:space-between; }
}
</style>
