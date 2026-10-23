<script setup lang="ts">
/**
 * 本楼「没写入的内容」:最后一次尝试时不符合要求、没有写入的更新(原记录保持不变),以及跳过的无效变量命令。
 * 每项写清是哪一项、为什么;改法在说明里。只读,不提供操作——需要时在对应页面手动修改,或重新生成本楼摘要。
 */
import FloorSection from './FloorSection.vue';
import { describeDropped, type DroppedEvidence } from '@/memory/summaryResponse';
import { getContext } from '@/st/context';
import { computed } from 'vue';

const props = defineProps<{ dropped: DroppedEvidence[] }>();
const rows = computed(() => {
  const userName = getContext()?.name1?.trim() || '主角';
  return props.dropped.map(d => describeDropped(d, userName));
});
</script>

<template>
  <FloorSection
    class="bbs-fp-dropped"
    icon="bolt"
    tone="warning"
    :title="`没写入的内容 · ${dropped.length} 项`"
    note="生成本楼摘要时，这些更新不符合要求，没有写入，原记录保持不变。"
  >
    <ul class="bbs-fp-dropped-list">
      <li v-for="(row, i) in rows" :key="i" class="bbs-fp-dropped-item">
        <span class="bbs-fp-dropped-what">{{ row.what }}</span>
        <span class="bbs-fp-dropped-why">{{ row.why }}</span>
      </li>
    </ul>
    <p class="bbs-fp-dropped-hint">需要时在「角色」「物品」等页面手动修改，或重新生成本楼摘要。</p>
  </FloorSection>
</template>

<style scoped>
.bbs-fp-dropped {
  margin-top: 14px;
}
.bbs-fp-dropped-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* 每项一块条目(与变动条同一层底色),左侧警告色竖线 */
.bbs-fp-dropped-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line);
  border-left: 3px solid var(--bbs-warning);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
}
.bbs-fp-dropped-what {
  font-size: var(--bbs-fs-sm);
  line-height: 1.45;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-fp-dropped-why {
  font-size: var(--bbs-fs-meta);
  line-height: 1.5;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
.bbs-fp-dropped-hint {
  margin: 0;
  font-size: var(--bbs-fs-meta);
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}
</style>
