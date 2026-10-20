<script setup lang="ts">
/* 召回调试：把上一次召回各阶段的中间结果可视化，便于调参与排障。纯只读展示 recallDebug，响应式自动刷新。
   五个步骤用行式折叠（details.bbs-disclosure），不再卡片套卡片。 */
import EmptyState from '@/components/EmptyState.vue';
import { recallDebug } from '@/memory/vector/debug';
import { recallStatusText } from '@/memory/vector/recallView';
import { computed } from 'vue';

function fmtRecallTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 来源 Q 标签:后端回传 -1(旧后端未支持)时显示占位符
function qLabel(queryIndex: number): string {
  return queryIndex >= 0 ? `Q${queryIndex + 1}` : '—';
}
const TIER_LABEL: Record<'full' | 'brief' | 'drop' | 'cut', string> = { full: '全文', brief: '摘要', drop: '丢弃', cut: '超出预算' };
// 候选来自哪一路(向量一路不标)
const ROUTE_LABEL: Record<'vector' | 'keyword' | 'both' | 'sticky', string> = { vector: '向量', keyword: '关键词', both: '向量+关键词', sticky: '上轮保留' };
// 状态语气:决定横幅左侧圆点的配色(成功/警示/失败/进行中)
const recallStatusKind = computed<'ok' | 'warn' | 'fail' | 'pending'>(() => {
  const s = recallDebug.status;
  if (s.includes('失败')) return 'fail';
  if (s.includes('进行中')) return 'pending';
  if (s.includes('未召回') || s.includes('未注入')) return 'warn';
  return 'ok';
});
// 分数(0~1)→ 进度条宽度百分比;负分(如未知)按 0 处理
function scorePct(score: number): number {
  return Math.max(0, Math.min(1, score)) * 100;
}
</script>

<template>
  <EmptyState
    v-if="!recallDebug.at"
    compact
    icon="search"
    title="暂无召回记录"
    text="启用向量记忆并生成一次正文后，此处显示查询重写、检索、重排和注入各步骤的结果。"
  />
  <div v-else class="bbs-dbg">
    <!-- 状态横幅:左侧圆点按语气配色,右侧时间 -->
    <div class="bbs-dbg-banner" :class="`is-${recallStatusKind}`">
      <span class="bbs-dbg-dot" aria-hidden="true"></span>
      <span class="bbs-dbg-status-text">{{ recallStatusText(recallDebug) }}</span>
      <span class="bbs-dbg-time">{{ fmtRecallTime(recallDebug.at) }}</span>
    </div>

    <!-- 五个阶段各自可折叠,默认收起;行尾带计数 -->
    <div class="bbs-dbg-steps">
    <details class="bbs-disclosure bbs-dbg-step">
      <summary>1 · 查询重写<span class="bbs-disclosure-meta">{{ recallDebug.queries.length }} 条查询</span></summary>
      <p v-if="recallDebug.intent" class="bbs-dbg-intent">
        <span class="bbs-dbg-tag">INTENT</span><span class="bbs-dbg-intent-text">{{ recallDebug.intent }}</span>
      </p>
      <ul v-if="recallDebug.queries.length" class="bbs-dbg-qlist">
        <li v-for="(q, i) in recallDebug.queries" :key="i" class="bbs-dbg-qitem">
          <span class="bbs-dbg-qno">Q{{ i + 1 }}</span><span class="bbs-dbg-qtext">{{ q }}</span>
        </li>
      </ul>
      <p v-else class="bbs-dbg-empty">无</p>
    </details>

    <details class="bbs-disclosure bbs-dbg-step">
      <summary>2 · Embedding 检索<span class="bbs-disclosure-meta">{{ recallDebug.embedding.length }} 条</span></summary>
      <ul v-if="recallDebug.embedding.length" class="bbs-dbg-cards">
        <li v-for="(h, i) in recallDebug.embedding" :key="i" class="bbs-dbg-card">
          <div class="bbs-dbg-card-top">
            <span class="bbs-dbg-src" :title="`来源 ${qLabel(h.queryIndex)}`">{{ qLabel(h.queryIndex) }}</span>
            <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === '旧档' }">{{ h.source }}</span>
            <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
            <span class="bbs-dbg-num">{{ h.similarity.toFixed(3) }}</span>
          </div>
          <div class="bbs-dbg-bar"><i :style="{ width: scorePct(h.similarity) + '%' }"></i></div>
          <p class="bbs-dbg-prev">{{ h.preview }}</p>
        </li>
      </ul>
      <p v-else class="bbs-dbg-empty">无</p>
    </details>

    <details class="bbs-disclosure bbs-dbg-step">
      <summary>3 · 关键词命中<span class="bbs-disclosure-meta">{{ recallDebug.keyword.length }} 条</span></summary>
      <ul v-if="recallDebug.keyword.length" class="bbs-dbg-cards">
        <li v-for="(h, i) in recallDebug.keyword" :key="i" class="bbs-dbg-card">
          <div class="bbs-dbg-card-top">
            <span class="bbs-dbg-from">{{ h.source }}</span>
            <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
            <span class="bbs-dbg-num">{{ h.score.toFixed(2) }}</span>
          </div>
          <p class="bbs-dbg-prev">命中：{{ h.matched.join('、') }}</p>
          <p class="bbs-dbg-prev">{{ h.preview }}</p>
        </li>
      </ul>
      <p v-else class="bbs-dbg-empty">无（未启用关键词召回，或当前对话未提到已记录的名字）</p>
    </details>

    <details class="bbs-disclosure bbs-dbg-step">
      <summary>4 · Rerank 分档<span class="bbs-disclosure-meta">{{ recallDebug.rerank.length }} 条</span></summary>
      <ul v-if="recallDebug.rerank.length" class="bbs-dbg-cards">
        <li v-for="(h, i) in recallDebug.rerank" :key="i" class="bbs-dbg-card" :class="{ 'is-dropped': h.tier === 'drop' }">
          <div class="bbs-dbg-card-top">
            <span class="bbs-dbg-tier" :class="`is-${h.tier}`">{{ TIER_LABEL[h.tier] }}</span>
            <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === '旧档' }">{{ h.source }}</span>
            <span v-if="h.route && h.route !== 'vector'" class="bbs-dbg-src">{{ ROUTE_LABEL[h.route] }}</span>
            <span v-if="h.downgraded" class="bbs-dbg-src" title="达到全文档，原文放不进召回预算，改发摘要">原文超出预算</span>
            <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
            <span class="bbs-dbg-num">{{ h.rerankScore.toFixed(3) }}</span>
          </div>
          <div class="bbs-dbg-bar" :class="`tier-${h.tier}`"><i :style="{ width: scorePct(h.rerankScore) + '%' }"></i></div>
          <p class="bbs-dbg-prev">{{ h.preview }}</p>
        </li>
      </ul>
      <p v-else class="bbs-dbg-empty">无（未执行 rerank，或没有候选）</p>
    </details>

    <details class="bbs-disclosure bbs-dbg-step">
      <summary>5 · 最终注入<span class="bbs-disclosure-meta">{{ recallDebug.injectedText ? '已注入' : '未注入' }}</span></summary>
      <pre v-if="recallDebug.injectedText" class="bbs-dbg-pre">{{ recallDebug.injectedText }}</pre>
      <p v-else class="bbs-dbg-empty">本轮未注入。</p>
    </details>
    </div>
  </div>
</template>

<style scoped>
/* —— 上次召回详情(调试面板):状态横幅 + 步骤分区 + 分数条卡片 —— */
.bbs-dbg {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 状态横幅:左色点 + 文案 + 时间 */
.bbs-dbg-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  border-left: 3px solid var(--bbs-line-strong);
}
.bbs-dbg-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bbs-ink-muted);
}
.bbs-dbg-banner.is-ok {
  border-left-color: var(--bbs-accent);
}
.bbs-dbg-banner.is-ok .bbs-dbg-dot {
  background: var(--bbs-accent);
}
.bbs-dbg-banner.is-warn {
  border-left-color: var(--bbs-warning);
}
.bbs-dbg-banner.is-warn .bbs-dbg-dot {
  background: var(--bbs-warning);
}
.bbs-dbg-banner.is-fail {
  border-left-color: var(--bbs-danger);
}
.bbs-dbg-banner.is-fail .bbs-dbg-dot {
  background: var(--bbs-danger);
}
.bbs-dbg-banner.is-pending .bbs-dbg-dot {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-status-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}

/* 步骤：行式折叠，行间细线；展开内容下方留白 */
.bbs-dbg-steps {
  border-top: 1px solid var(--bbs-line);
}
.bbs-dbg-step {
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-dbg-step[open] {
  padding-bottom: 12px;
}

.bbs-dbg-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 重写:INTENT 高亮 + Q 列表 */
.bbs-dbg-intent {
  display: flex;
  gap: 7px;
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent-soft);
  font-size: 12px;
  line-height: 1.6;
}
.bbs-dbg-intent-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-tag {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-family: var(--bbs-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.bbs-dbg-qlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-dbg-qitem {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--bbs-ink);
}
.bbs-dbg-qno {
  flex: 0 0 auto;
  min-width: 22px;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--bbs-accent);
}
.bbs-dbg-qtext {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

/* 命中卡片列表:固定高度内滑动,长列表不把折叠区撑得很长。 */
.bbs-dbg-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.bbs-dbg-card {
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
/* 丢弃档：虚线边、透明底、次要色文字；不降整体透明度，保证文字对比度 */
.bbs-dbg-card.is-dropped {
  border-style: dashed;
  background: transparent;
}
.bbs-dbg-card.is-dropped :is(.bbs-dbg-prev, .bbs-dbg-num, .bbs-dbg-from) {
  color: var(--bbs-ink-muted);
}
.bbs-dbg-card-top {
  display: flex;
  flex-wrap: wrap; /* 标签多时(来源路、原文超出预算)窄屏换行,不把分数挤出卡片 */
  align-items: center;
  gap: 4px 8px;
  margin-bottom: 6px;
}
/* 来源 Q 徽标 */
.bbs-dbg-src {
  flex: 0 0 auto;
  min-width: 38px; /* 与楼层号标签等宽,单数 Q 也不至于太窄 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
}
/* 来源标记:本聊天楼层号(中性)/ 旧档(描边提示色) */
.bbs-dbg-from {
  flex: 0 0 auto;
  min-width: 38px; /* 楼层号个位数(#5)也不至于太窄,与 Q 标签视觉等宽 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-from.is-bundle {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-color: transparent;
}
.bbs-dbg-when {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-dbg-num {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-ink);
  font-variant-numeric: tabular-nums;
}
/* 分数条:细轨 + 填充;默认强调色,rerank 各档分色 */
.bbs-dbg-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line);
  overflow: hidden;
}
.bbs-dbg-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
.bbs-dbg-bar.tier-brief > i {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-bar.tier-drop > i {
  background: var(--bbs-ink-muted);
}
.bbs-dbg-bar.tier-cut > i {
  background: var(--bbs-warning);
}
.bbs-dbg-prev {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
/* 分档徽标:全文(强调实底)/摘要(中性)/丢弃(描边褪色) */
.bbs-dbg-tier {
  flex: 0 0 auto;
  min-width: 32px;
  text-align: center;
  padding: 1px 8px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.bbs-dbg-tier.is-full {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-dbg-tier.is-brief {
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-tier.is-drop {
  color: var(--bbs-ink-muted);
  background: transparent;
  border: 1px solid var(--bbs-line);
}
/* 超出预算:达标却没放进召回预算,用提示色,和没达标的「丢弃」区分开 */
.bbs-dbg-tier.is-cut {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* 注入文本框:等宽、限高滚动 */
.bbs-dbg-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink);
}
</style>
