<script setup lang="ts">
/**
 * 楼层光谱：摘要页概览里的一条细横条，每层 AI 回复一格。亮度表示保留的细节——
 * 原文最亮，逐楼摘要次之，并入总结、二次总结后越来越淡；待补摘是条纹空格，番外是斜线。
 * 悬停一段显示楼层范围和数量。计算见 spectrum.ts。
 * 色块按楼层数比例伸展；待补摘和番外的条纹是按像素平铺的 SVG 图案，楼层多少都保持同样的疏密。
 */
import { computed, useId } from 'vue';
import { isRealAiReply, resolveKeepStart } from '@/memory/engine';
import { derivedMeta, memory } from '@/memory/store';
import { getContext } from '@/st/context';
import { FLOOR_STATE_LABEL, FLOOR_STATES, floorSpectrum, type SpectrumRun } from './spectrum';

const ids = { gap: useId(), omit: useId() };
const patternOf = (state: string) => state === 'pending' ? ids.gap : state === 'omit' ? ids.omit : '';

const spectrum = computed(() => {
  // chat 不是响应式：derivedMeta.rev 在每次重算派生（摘要、删改、切聊天）后递增
  void derivedMeta.rev;
  const chat = getContext()?.chat ?? [];
  const floors: number[] = [];
  const omit = new Set<number>();
  chat.forEach((message, index) => {
    if (!isRealAiReply(message)) return;
    floors.push(index);
    if (message.extra?.bbs_omit) omit.add(index);
  });
  const leafOf = new Map(derivedMeta.leaves.filter(leaf => !leaf.stale).map(leaf => [leaf.msgIndex, leaf.id]));
  return floorSpectrum({
    floors, omit, pending: new Set(derivedMeta.pendingFloors), keepStart: resolveKeepStart(chat),
    leafOf, summaries: memory.summaries,
  });
});
const present = computed(() => FLOOR_STATES.filter(state => spectrum.value.counts[state] > 0));
const ariaLabel = computed(() => `楼层光谱：共 ${spectrum.value.total} 层 AI 回复，`
  + present.value.map(state => `${FLOOR_STATE_LABEL[state]} ${spectrum.value.counts[state]} 层`).join('，'));
const firstFloor = computed(() => spectrum.value.runs[0]?.firstFloor ?? 0);
const lastFloor = computed(() => spectrum.value.runs[spectrum.value.runs.length - 1]?.lastFloor ?? 0);

function runTitle(run: SpectrumRun): string {
  const where = run.count > 1 ? `#${run.firstFloor}–#${run.lastFloor}` : `#${run.firstFloor}`;
  return `${where}　${FLOOR_STATE_LABEL[run.state]} ${run.count} 层`;
}
</script>

<template>
  <div v-if="spectrum.total >= 2" class="bbs-spectrum">
    <!-- 条纹图案：放在不占位的 SVG 里（不能 display:none，否则部分浏览器不渲染引用它的图案） -->
    <svg class="bbs-spectrum-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <pattern :id="ids.gap" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect class="bbs-spectrum-gap-bg" width="5" height="5" /><rect class="bbs-spectrum-gap-fg" width="2" height="5" />
        </pattern>
        <pattern :id="ids.omit" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect class="bbs-spectrum-omit-bg" width="5" height="5" /><rect class="bbs-spectrum-omit-fg" width="2" height="5" />
        </pattern>
      </defs>
    </svg>
    <div class="bbs-spectrum-bar" role="img" :aria-label="ariaLabel">
      <span v-for="run in spectrum.runs" :key="run.start" :class="'is-' + run.state" :style="{ flexGrow: run.count }" :title="runTitle(run)">
        <svg v-if="patternOf(run.state)" class="bbs-spectrum-fill" aria-hidden="true" focusable="false"><rect width="100%" height="100%" :fill="`url(#${patternOf(run.state)})`" /></svg>
      </span>
    </div>
    <div class="bbs-spectrum-foot">
      <ul class="bbs-spectrum-legend" aria-hidden="true">
        <li v-for="state in present" :key="state"><i :class="'is-' + state"><svg v-if="patternOf(state)" class="bbs-spectrum-fill" aria-hidden="true" focusable="false"><rect width="100%" height="100%" :fill="`url(#${patternOf(state)})`" /></svg></i>{{ FLOOR_STATE_LABEL[state] }}</li>
      </ul>
      <span class="bbs-spectrum-axis">#{{ firstFloor }} – #{{ lastFloor }}</span>
    </div>
  </div>
</template>

<style scoped>
.bbs-spectrum { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bbs-spectrum-bar { display: flex; height: 12px; overflow: hidden; border-radius: 6px; background: var(--bbs-surface-2); }
/* 每段按楼层数伸展；只有一两层的段也至少留出 1px，看得见 */
.bbs-spectrum-bar > span { flex: 1 1 0; min-width: 1px; }
/* 亮度表示保留的细节：用透明度叠在横条底色上，不依赖 color-mix，旧版 WebView 也能显示 */
.bbs-spectrum .is-raw { background: var(--bbs-ink); }
.bbs-spectrum .is-leaf { background: var(--bbs-accent); opacity: 0.88; }
.bbs-spectrum .is-l1 { background: var(--bbs-accent); opacity: 0.55; }
.bbs-spectrum .is-l2 { background: var(--bbs-accent); opacity: 0.28; }
.bbs-spectrum-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.bbs-spectrum-fill { display: block; width: 100%; height: 100%; }
.bbs-spectrum-gap-bg { fill: var(--bbs-warning-soft); }
.bbs-spectrum-gap-fg { fill: var(--bbs-warning); }
.bbs-spectrum-omit-bg { fill: var(--bbs-surface-2); }
.bbs-spectrum-omit-fg { fill: var(--bbs-line-strong); }
.bbs-spectrum-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; }
.bbs-spectrum-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; font-size: var(--bbs-fs-meta); color: var(--bbs-ink-muted); }
.bbs-spectrum-legend li { display: inline-flex; align-items: center; gap: 6px; }
.bbs-spectrum-legend i { width: 9px; height: 9px; overflow: hidden; border-radius: 2px; }
.bbs-spectrum-axis { font-size: var(--bbs-fs-badge); color: var(--bbs-ink-muted); font-variant-numeric: tabular-nums; }
</style>
