<script setup lang="ts">
/** 讨论消息里的一行文字：粗体、斜体、行内代码，其余为纯文本。 */
import type { InlinePart } from '@/outline/discussionView';

defineProps<{ parts: InlinePart[] }>();
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"><code v-if="part.code" class="dt-code">{{ part.text }}</code><strong v-else-if="part.bold" class="dt-strong">{{ part.text }}</strong><em v-else-if="part.italic">{{ part.text }}</em><template v-else>{{ part.text }}</template></template>
</template>

<style scoped>
.dt-strong { font-weight: 650; color: var(--bbs-ink); }
.dt-code { padding: 1px 5px; border-radius: var(--bbs-radius-xs); background: var(--bbs-surface-2); font: 0.92em/1.5 var(--bbs-font-mono); overflow-wrap: anywhere; }
</style>
