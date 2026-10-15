<script setup lang="ts">
/**
 * 重新摘要的对比弹窗:新结果生成后先不写入,和现在的摘要并排放着,用户选一份保留。
 * 只负责展示和发出选择;写入与否由调用方交给 engine 的 applyFloorPreview / discardFloorPreview。
 * 变动标签与楼层面板共用 memory/deltaTags,两处说法一致。
 */
import ModalMask from '@/components/ModalMask.vue';
import { DELTA_OP_LABEL, deltaTagGroups } from '@/memory/deltaTags';
import type { FloorPreview } from '@/memory/engine';
import type { StoredDelta } from '@/memory/types';
import { computed } from 'vue';

const props = defineProps<{ preview: FloorPreview | null; busy?: boolean }>();
const emit = defineEmits<{ (e: 'keep'): void; (e: 'replace'): void }>();

interface Side {
  key: 'current' | 'next';
  label: string;
  text: string;
  chars: number;
  time: string;
  location: string;
  groups: ReturnType<typeof deltaTagGroups>;
}

function timeOf(start?: string, end?: string, label?: string): string {
  const s = start?.trim();
  const e = end?.trim();
  if (s && e && s !== e) return `${s} → ${e}`;
  return s || e || label?.trim() || '';
}

function sideOf(key: Side['key'], label: string, text: string, delta: StoredDelta | undefined, time: string, floor: number): Side {
  const body = text.trim();
  return {
    key, label, time,
    text: body,
    chars: Array.from(body).length,
    location: delta?.location?.trim() ?? '',
    groups: deltaTagGroups(delta, floor).filter(g => g.tags.length > 0),
  };
}

const sides = computed<Side[]>(() => {
  const p = props.preview;
  if (!p) return [];
  return [
    sideOf('current', '现在的', p.current.text ?? '', p.current.delta, timeOf(p.current.timeStart, p.current.timeEnd, p.current.timeLabel), p.floor),
    sideOf('next', '新生成的', p.next.text, p.next.delta, timeOf(p.next.timeStart, p.next.timeEnd), p.floor),
  ];
});

function keep() {
  if (!props.busy) emit('keep');
}
</script>

<template>
  <ModalMask :open="!!preview" @close="keep">
    <div v-if="preview" class="bbs-modal prism-compare" role="dialog" aria-modal="true" :aria-label="`楼层 #${preview.floor} 摘要对比`">
      <header class="bbs-modal-head">
        <span class="bbs-modal-title">楼层 #{{ preview.floor }}：选一份保留</span>
      </header>
      <p class="prism-compare-note">
        新摘要尚未写入。选择「用新的」将替换本楼摘要及其带来的时间、物品、角色、计划等变化；包含本楼的上层总结将作废，之后按设置重新生成。选择「保留现在的」不做任何修改。
      </p>
      <div class="prism-compare-cols">
        <section v-for="side in sides" :key="side.key" class="prism-compare-col" :class="`is-${side.key}`" :aria-label="side.label">
          <h3 class="prism-compare-label">{{ side.label }}<span class="prism-compare-count">{{ side.chars }} 字</span></h3>
          <p v-if="side.time" class="prism-compare-meta">🕑 {{ side.time }}</p>
          <p class="prism-compare-text" :class="{ 'is-muted': !side.text }">{{ side.text || '（没有摘要正文）' }}</p>
          <div class="prism-compare-changes">
            <p v-if="side.location" class="prism-compare-meta">地点：{{ side.location }}</p>
            <div v-for="g in side.groups" :key="g.title" class="prism-compare-group">
              <span class="prism-compare-group-title">{{ g.title }}</span>
              <ul>
                <li v-for="t in g.tags" :key="t.key" :class="`op-${t.op}`">
                  <span class="prism-compare-op">{{ DELTA_OP_LABEL[t.op] }}</span>
                  <span class="prism-compare-tag">
                    <span>{{ t.text }}</span>
                    <span v-if="t.sub" class="prism-compare-sub">{{ t.sub }}</span>
                  </span>
                </li>
              </ul>
            </div>
            <p v-if="!side.groups.length && !side.location" class="prism-compare-none">没有状态变化</p>
          </div>
        </section>
      </div>
      <footer class="bbs-modal-foot">
        <button class="bbs-btn" type="button" :disabled="busy" @click="keep">保留现在的</button>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="busy" @click="emit('replace')">{{ busy ? '替换中…' : '用新的' }}</button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
.prism-compare {
  max-width: 880px;
}
/* 内容长时弹窗内部滚动;两个选择按钮贴在底部,不用滚到最后才能点 */
.prism-compare .bbs-modal-foot {
  position: sticky;
  bottom: -18px;
  margin: 0 -18px -18px;
  padding: 12px 18px;
  border-top: 1px solid var(--bbs-line);
  background: var(--bbs-surface);
}
.prism-compare-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bbs-ink-muted);
}
.prism-compare-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  /* 弹窗是可滚动的纵向 flex:两栏不能被压扁,否则内容会盖到下面的按钮上 */
  flex-shrink: 0;
}
.prism-compare-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-bg);
}
/* 新结果描一道强调色边,一眼分清哪份是新的 */
.prism-compare-col.is-next {
  border-color: var(--bbs-accent);
  box-shadow: 0 0 0 1px var(--bbs-accent-soft);
}
.prism-compare-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.prism-compare-col.is-next .prism-compare-label {
  color: var(--bbs-accent);
}
.prism-compare-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
.prism-compare-meta {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  overflow-wrap: anywhere;
}
.prism-compare-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--bbs-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.prism-compare-text.is-muted,
.prism-compare-none {
  color: var(--bbs-ink-muted);
}
.prism-compare-changes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--bbs-line);
}
.prism-compare-none {
  margin: 0;
  font-size: 12px;
}
.prism-compare-group-title {
  display: block;
  margin-bottom: 4px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
}
.prism-compare-group ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.prism-compare-group li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--bbs-ink);
}
/* 徽标颜色与楼层面板一致:新增=强调、移除=危险、了结/重启=提醒、更新/迁移=中性 */
.prism-compare-op {
  flex: 0 0 auto;
  margin-top: 2px;
  padding: 0 6px;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
}
.op-add .prism-compare-op {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.op-remove .prism-compare-op {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.op-resolve .prism-compare-op,
.op-reopen .prism-compare-op {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
.prism-compare-tag {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-wrap: anywhere;
}
.prism-compare-sub {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
}
@media (max-width: 640px) {
  .prism-compare-cols {
    grid-template-columns: 1fr;
  }
}
</style>
