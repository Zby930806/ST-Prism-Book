<script setup lang="ts">
/**
 * 角色页区块标题行：左侧分组标签（如「主角」「在场」）或自定义内容（lead 插槽，如折叠按钮），
 * 中间一句说明，右侧操作（actions 插槽）。说明在「仅本地记录」时用警告色。
 */
import Icon from '@/components/Icon.vue';

defineProps<{
  /** 分组标签文字；不给时不显示标签 */
  tag?: string;
  tagIcon?: string;
  /** 标签配色：main/present 强调色，protagonist 警告色，nearby 描边，不给为中性灰 */
  tagTone?: 'main' | 'present' | 'nearby' | 'protagonist';
  /** 标签旁的说明；空字符串或不给时不显示 */
  hint?: string;
  /** 说明是「仅供棱镜宝书记录，不发送给主对话 AI」这类提醒时为 true */
  localOnly?: boolean;
  /** 窄屏（≤480px）时说明排到下一行、占满整行，标题与操作键留在同一行 */
  hintBelow?: boolean;
}>();
</script>

<template>
  <div class="bbs-npc-grouphead">
    <slot name="lead" />
    <span v-if="tag" class="bbs-npc-grouptag" :class="tagTone ? 'is-' + tagTone : undefined"><Icon v-if="tagIcon" :name="tagIcon" />{{ tag }}</span>
    <span v-if="hint" class="bbs-npc-grouphint" :class="{ 'is-local-only': localOnly, 'is-below': hintBelow }">{{ hint }}</span>
    <slot name="actions" />
  </div>
</template>

<style scoped>
.bbs-npc-grouphead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.bbs-npc-grouptag { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 7px; background: var(--bbs-surface-2); font-size: 12px; font-weight: 650; color: var(--bbs-ink-soft); }
.bbs-npc-grouptag.is-present, .bbs-npc-grouptag.is-main { background: var(--bbs-accent-soft); color: var(--bbs-accent); }
.bbs-npc-grouptag.is-protagonist { background: var(--bbs-warning-soft); color: var(--bbs-warning); }
.bbs-npc-grouptag.is-nearby { background: transparent; border: 1px solid var(--bbs-line-strong); }
.bbs-npc-grouphint { flex: 1 1 150px; color: var(--bbs-ink-muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.bbs-npc-grouphint.is-local-only { color: var(--bbs-warning); }
@media (max-width: 480px) { .bbs-npc-grouphint.is-below { order: 99; flex-basis: 100%; } }
</style>
