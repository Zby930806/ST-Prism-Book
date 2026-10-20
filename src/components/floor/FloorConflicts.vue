<script setup lang="ts">
/**
 * 本楼正文与已有记录不一致的地方(摘要时标出,记录保持原样)。每处可选「提醒正文模型」或「忽略」,处理过的可撤销。
 * 从 FloorPanel.vue 拆出,行为不变;番外楼和无效摘要由调用方不渲染。
 */
import FloorSection from './FloorSection.vue';
import { setConflictStatus } from '@/memory/continuity';
import { toast } from '@/st/toast';
import type { LeafConflict } from '@/memory/types';

const props = defineProps<{ floor: number; conflicts: LeafConflict[] }>();

const CONFLICT_STATE: Record<string, string> = { pending: '下一次生成时提醒', reminded: '已提醒正文模型', ignored: '已忽略' };
function changeConflict(index: number, status: 'pending' | 'ignored' | 'open') {
  if (!setConflictStatus(props.floor, index, status)) toast('记忆处于保护状态，未修改。', 'error');
}
</script>

<template>
  <FloorSection
    class="bbs-fp-conflicts"
    icon="bolt"
    tone="warning"
    :title="`与记录不一致 · ${conflicts.length} 处`"
    note="摘要时发现本楼正文与已有记录不一致，且正文没有交代变化，记录保持原样。"
  >
    <div v-for="(c, i) in conflicts" :key="i" class="bbs-fp-conflict" :class="`is-${c.status ?? 'open'}`">
      <p class="bbs-fp-conflict-about">{{ c.about }}</p>
      <p class="bbs-fp-conflict-line"><span class="bbs-fp-conflict-tag">记录</span>{{ c.record }}</p>
      <p class="bbs-fp-conflict-line"><span class="bbs-fp-conflict-tag">正文</span>「{{ c.text }}」</p>
      <div class="bbs-fp-conflict-actions">
        <template v-if="!c.status || c.status === 'open'">
          <button class="bbs-btn bbs-btn-sm" type="button" title="下一次生成时注入一次提醒，使正文按记录继续" @click="changeConflict(i, 'pending')">提醒正文模型</button>
          <button class="bbs-btn bbs-btn-sm" type="button" @click="changeConflict(i, 'ignored')">忽略</button>
        </template>
        <template v-else>
          <span class="bbs-fp-conflict-state">{{ CONFLICT_STATE[c.status] }}</span>
          <button v-if="c.status !== 'reminded'" class="bbs-btn bbs-btn-sm bbs-fp-conflict-undo" type="button" @click="changeConflict(i, 'open')">撤销</button>
        </template>
      </div>
    </div>
    <p class="bbs-fp-conflict-hint">以正文为准时，可在角色页、物品页等处直接修改对应记录。</p>
  </FloorSection>
</template>

<style scoped>
.bbs-fp-conflicts {
  margin-top: 14px;
}
/* 每处一块条目(与变动条同一层底色),左侧警告色竖线;处理过的竖线退成中性色、文字降一档(不降透明度,保证对比度) */
.bbs-fp-conflict {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-left: 3px solid var(--bbs-warning);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
}
.bbs-fp-conflict:not(.is-open) {
  border-left-color: var(--bbs-line-strong, var(--bbs-line));
}
.bbs-fp-conflict:not(.is-open) .bbs-fp-conflict-about {
  color: var(--bbs-ink-soft);
}
.bbs-fp-conflict:not(.is-open) .bbs-fp-conflict-line {
  color: var(--bbs-ink-muted);
}
.bbs-fp-conflict p {
  margin: 0;
}
.bbs-fp-conflict-about {
  font-size: var(--bbs-fs-sm);
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-fp-conflict-line {
  display: flex;
  gap: 6px;
  font-size: var(--bbs-fs-sm);
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
.bbs-fp-conflict-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  font-size: var(--bbs-fs-badge);
  line-height: 20px;
  color: var(--bbs-ink-muted);
}
.bbs-fp-conflict-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
/* 操作键:与其他小按钮同一套 .bbs-btn-sm(桌面 32px 高,手机与触屏 40px,见 base.css) */
.bbs-fp-conflict-actions .bbs-btn-sm {
  padding: 4px 10px;
  font-size: var(--bbs-fs-meta);
}
.bbs-fp-conflict-state {
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-muted);
}
.bbs-fp-conflict-hint {
  margin: 0;
  font-size: var(--bbs-fs-meta);
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}
</style>
