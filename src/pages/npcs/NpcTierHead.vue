<script setup lang="ts">
/**
 * 角色页三大块（主角 / 主要角色 / NPC）的标题行：左侧二级标题，右侧计数等次要信息，下一行一句说明。
 * 说明是「仅供棱镜宝书记录，不发送给主对话 AI」这类提醒时用警告色。
 */
defineProps<{
  title: string;
  /** 标题行右侧的次要信息（如「显示 3 / 5 位」）；不给时不显示 */
  meta?: string;
  /** 标题下的一句说明 */
  hint?: string;
  localOnly?: boolean;
  /** 二级标题的 id，供区块 aria-labelledby 使用 */
  headingId?: string;
}>();
</script>

<template>
  <div class="bbs-npc-tierhead">
    <div class="bbs-npc-tierline">
      <h2 :id="headingId">{{ title }}</h2>
      <span v-if="meta" role="status">{{ meta }}</span>
    </div>
    <p v-if="hint" class="bbs-npc-tierhint" :class="{ 'is-local-only': localOnly }">{{ hint }}</p>
  </div>
</template>

<style scoped>
.bbs-npc-tierhead { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.bbs-npc-tierline { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.bbs-npc-tierline h2 { margin: 0; font-size: 16px; font-weight: 650; color: var(--bbs-ink); }
.bbs-npc-tierline > span { font-size: 11px; color: var(--bbs-ink-muted); }
.bbs-npc-tierhint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-npc-tierhint.is-local-only { color: var(--bbs-warning); }
</style>
