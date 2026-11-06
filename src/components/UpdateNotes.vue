<script setup lang="ts">
/** 更新说明列表：每个版本一张卡片，取自 README 中「X.Y.Z 的改动」，段落和列表项按原顺序排列。 */
import type { UpdateNote } from '@/memory/update';

defineProps<{ notes: UpdateNote[] }>();
</script>

<template>
  <section v-for="note in notes" :key="note.version" class="bbs-update-note">
    <h4 class="bbs-update-version">v{{ note.version }}</h4>
    <p v-for="(line, i) in note.lines" :key="i" :class="line.bullet ? 'bbs-update-bullet' : 'bbs-update-para'">{{ line.text }}</p>
  </section>
</template>

<style scoped>
.bbs-update-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: 10px;
}
.bbs-update-version { margin: 0 0 2px; font-size: 13px; color: var(--bbs-ink); }
.bbs-update-para,
.bbs-update-bullet {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
  overflow-wrap: anywhere;
}
.bbs-update-bullet { position: relative; padding-left: 14px; }
.bbs-update-bullet::before { content: '•'; position: absolute; left: 2px; color: var(--bbs-ink-muted); }
</style>
