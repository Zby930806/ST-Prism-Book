<script setup lang="ts">
/**
 * 未摘要楼层：批量补摘进行中的进度条，以及尚未摘要的楼层与分页。连续的楼层合成一段（中间没有别的 AI 楼，
 * 番外楼不打断）：单层点击直接补摘那一楼，多层的一段打开批量补摘确认、只补这一段。全部补摘的入口在概览的「补摘」按钮。
 * 清洗后没有故事正文的楼层（只有状态栏、时间标签、思考或旁注）无法摘要，单独列出并提供「标为番外」。
 */
import Icon from '@/components/Icon.vue';
import { batchState, cancelBatchBackfill, engineState, floorBackfillState, floorHasStoryBody, isAiFloor, setFloorOmit, summarizeFloor } from '@/memory/engine';
import { derivedMeta } from '@/memory/store';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, ref, watch } from 'vue';
import SummaryPager from './SummaryPager.vue';
import { useSummaryPage } from './pageCtx';
import { pendingRanges, type PendingRange } from './spectrum';
import { arrayPage, PENDING_PAGE_SIZE } from './view';

const page = useSummaryPage();
const { pendingFloors, allowMemoryEdit } = page;
const { batchEta, openBatchConfirm } = page.batch;

// 没有故事正文的楼层:不会被摘要,一直待摘要;新的在前
const bodyless = computed(() => {
  void derivedMeta.rev;
  return pendingFloors.value.filter(f => !floorHasStoryBody(f));
});
// 新的段在前，与原来楼层号的顺序一致
const ranges = computed(() => {
  void derivedMeta.rev;
  const chat = getContext()?.chat ?? [];
  const aiFloors: number[] = [];
  chat.forEach((message, index) => { if (isAiFloor(message)) aiFloors.push(index); });
  const skip = new Set(bodyless.value);
  return pendingRanges(pendingFloors.value.filter(f => !skip.has(f)), aiFloors).reverse();
});
const pendingPage = ref(1);
const pendingWindow = computed(() => arrayPage(ranges.value, pendingPage.value, PENDING_PAGE_SIZE));
watch(() => pendingWindow.value.page, p => { pendingPage.value = p; });
page.onReset(() => { pendingPage.value = 1; });

// 进度条宽度：已完成 / 总数
const batchPercent = computed(() => (batchState.total ? Math.min(100, Math.round((batchState.done / batchState.total) * 100)) : 0));
const summarizingFloor = computed<number | null>(() => {
  // derivedMeta.rev 让切聊天后的 computed 重新核对当前 chatId。
  void derivedMeta.rev;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  return floorBackfillState.running && floorBackfillState.chatId === chatId
    ? floorBackfillState.floor
    : null;
});
function summarizeOne(floor: number) {
  if (!allowMemoryEdit()) return;
  if (engineState.running || summarizingFloor.value !== null) return;
  // 任务状态由 engine 的 floorBackfillState 维护；页面卸载/重开不会丢失。
  void summarizeFloor(floor);
}
const rangeName = (range: PendingRange) => range.floors.length > 1 ? `#${range.first}–#${range.last}` : `#${range.first}`;
function openRange(range: PendingRange) {
  if (range.floors.length === 1) { summarizeOne(range.first); return; }
  openBatchConfirm(range.floors);
}
// 标为番外:这一楼不再参与摘要、总结和注入(可在楼层面板取消番外)
const omitting = ref<number | null>(null);
async function markOmit(floor: number) {
  if (!allowMemoryEdit() || engineState.running || omitting.value !== null) return;
  omitting.value = floor;
  try {
    await setFloorOmit(floor, true);
    if (engineState.lastError && getContext()?.chat?.[floor]?.extra?.bbs_omit !== true) toast(engineState.lastError, 'error');
    else toast(`楼层 #${floor} 已标为番外，不再参与摘要、总结和注入。`, 'success');
  } finally {
    omitting.value = null;
  }
}
</script>

<template>
  <div v-if="batchState.running" class="bbs-pending bbs-job-progress" role="status" aria-live="polite">
    <div class="bbs-batch-progress">
      <span class="bbs-spin"></span>
      <span class="bbs-batch-count">{{ batchState.mode === 'rebuild' ? '正在重建' : '正在补摘' }} {{ batchState.done }}/{{ batchState.total }}</span>
      <span v-if="batchState.lite && batchState.stage" class="bbs-batch-stage">{{ batchState.stage === 'lite' ? '较早楼层合并摘要' : '逐层摘要' }}</span>
      <span v-if="batchEta" class="bbs-batch-eta">{{ batchEta }}</span>
      <button class="bbs-btn bbs-btn-sm bbs-batch-cancel" type="button" :disabled="batchState.cancelRequested" @click="cancelBatchBackfill">
        {{ batchState.cancelRequested ? '停止中…' : '取消' }}
      </button>
    </div>
    <div class="bbs-batch-bar" aria-hidden="true"><i :style="{ width: batchPercent + '%' }"></i></div>
  </div>

  <!-- 未摘要楼层:只列楼层号,点一下单独补摘那一楼;全部补摘用概览的「补摘」按钮 -->
  <section v-if="pendingFloors.length" class="bbs-pending bbs-backfill" aria-label="未摘要楼层">
    <div class="bbs-pending-head">
      <span class="bbs-pending-label" :data-count="pendingFloors.length">
        <Icon name="summary" />未摘要楼层
      </span>
    </div>
    <p class="bbs-backfill-description">连续的楼层合为一段，点击补摘这一楼或这一段；全部补摘使用上方的「补摘」按钮。</p>
    <div v-if="ranges.length" class="bbs-pending-chips">
      <button
        v-for="range in pendingWindow.items"
        :key="range.first"
        class="bbs-pending-chip"
        type="button"
        :disabled="engineState.running || summarizingFloor !== null || batchState.running"
        :title="range.floors.length > 1 ? `补摘楼层 ${rangeName(range)}，共 ${range.floors.length} 层` : `给楼层 ${rangeName(range)} 生成摘要`"
        :aria-label="range.floors.length > 1 ? `补摘楼层 ${rangeName(range)}，共 ${range.floors.length} 层` : `给楼层 ${rangeName(range)} 生成摘要`"
        @click="openRange(range)"
      >
        <span v-if="summarizingFloor !== null && range.floors.includes(summarizingFloor)" class="bbs-spin"></span>
        <template v-else>{{ rangeName(range) }}<small v-if="range.floors.length > 1" class="bbs-pending-count">{{ range.floors.length }} 层</small></template>
      </button>
    </div>
    <div v-if="bodyless.length" class="bbs-pending-bodyless">
      <p class="bbs-backfill-description">以下楼层清洗后没有故事正文（只有状态栏、时间标签、思考或旁注），无法摘要，会一直待摘要并拦截生成。可编辑正文、删除这一楼，或标为番外跳过。</p>
      <div class="bbs-pending-chips">
        <span v-for="floor in bodyless" :key="floor" class="bbs-pending-bodyless-item">
          <span class="bbs-pending-bodyless-floor">#{{ floor }}</span>
          <button
            class="bbs-btn bbs-btn-sm"
            type="button"
            :disabled="engineState.running || batchState.running || omitting !== null"
            :aria-label="`把楼层 #${floor} 标为番外`"
            @click="markOmit(floor)"
          >{{ omitting === floor ? '处理中…' : '标为番外' }}</button>
        </span>
      </div>
    </div>
  </section>

  <SummaryPager :page="pendingWindow.page" :total="pendingWindow.total" :size="PENDING_PAGE_SIZE" label="待补摘楼层段" @update:page="pendingPage = $event" />
</template>

<style scoped>
/* —— 未摘要楼层:待办面板,细边卡片加左侧强调条,提示「这些楼还没摘」 —— */
.bbs-pending {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 16px 14px;
  border: 1px solid var(--bbs-line);
  border-left: 3px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-backfill-description {
  margin: 0;
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.7;
  color: var(--bbs-ink-muted);
}
/* 标题行:标签靠左 */
.bbs-pending-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-pending-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-accent);
}
/* 标签后跟一枚计数小点,强化「有 N 楼待办」 */
.bbs-pending-label::after {
  content: attr(data-count);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
/* 批量进行中的进度块:旋转环 + 进度文字 + 取消键,下方一条细进度条 */
.bbs-batch-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
}
.bbs-batch-progress .bbs-spin {
  width: 12px;
  height: 12px;
}
/* 剩余时间:估算值,用次要色,窄屏可以折到下一行 */
.bbs-batch-eta {
  font-weight: 400;
  color: var(--bbs-ink-muted);
}
/* 当前阶段(合并摘要 / 逐层摘要):与剩余时间同为次要信息 */
.bbs-batch-stage {
  font-weight: 500;
  color: var(--bbs-ink-soft);
}
.bbs-batch-cancel {
  margin-left: auto;
}
.bbs-batch-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  overflow: hidden;
}
.bbs-batch-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
.bbs-pending-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-pending-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  min-height: var(--bbs-control-h-sm);
  padding: 0 9px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.bbs-pending-chip:hover:not(:disabled) {
  color: var(--bbs-accent-ink);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent);
}
/* 多层的一段：楼层范围后跟层数 */
.bbs-pending-count {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--bbs-ink-muted);
}
.bbs-pending-chip:hover:not(:disabled) .bbs-pending-count {
  color: inherit;
}
.bbs-pending-chip:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 没有故事正文的楼层:楼层号 + 「标为番外」,与待补摘的楼层分开列出 */
.bbs-pending-bodyless {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--bbs-line);
}
.bbs-pending-bodyless-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bbs-pending-bodyless-floor {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--bbs-ink);
}
/* 窄屏和触屏:楼层号加大到 40px 高,便于点按 */
@media (max-width: 640px), (pointer: coarse) {
  .bbs-pending-chip { min-width: 44px; min-height: 40px; }
}
</style>
