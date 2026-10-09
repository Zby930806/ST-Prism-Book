<script setup lang="ts">
import Icon from './Icon.vue';
defineProps<{ title: string; description?: string; icon?: string; eyebrow?: string }>();
</script>
<template>
  <header class="prism-page-header">
    <div class="prism-page-heading">
      <p v-if="eyebrow" class="prism-eyebrow">{{ eyebrow }}</p>
      <h1 class="prism-page-title"><Icon v-if="icon" :name="icon" class="prism-page-icon" />{{ title }}</h1>
      <p v-if="description" class="prism-page-description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="prism-page-actions"><slot name="actions" /></div>
  </header>
</template>
<style scoped>
.prism-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin: 0 0 22px; min-width: 0; }
.prism-page-heading { min-width: 0; }
.prism-eyebrow { margin: 0 0 6px; font: 600 11px/1.4 var(--bbs-font-sans); letter-spacing: .12em; color: var(--bbs-ink-muted); }
.prism-page-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-family: var(--bbs-font-reading);
  font-size: 26px;
  line-height: 1.35;
  font-weight: 650;
  letter-spacing: .04em;
  color: var(--bbs-ink);
}
.prism-page-icon { flex: 0 0 auto; font-size: 22px; color: var(--bbs-accent); }
.prism-page-description { margin: 6px 0 0; max-width: 60ch; font-size: 13px; line-height: 1.75; color: var(--bbs-ink-soft); overflow-wrap: anywhere; }
.prism-page-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; flex-shrink: 0; max-width: 50%; padding-top: 4px; }
@media (max-width: 640px) {
  .prism-page-header { flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .prism-page-title { font-size: 23px; }
  .prism-page-icon { font-size: 20px; }
  .prism-page-actions { max-width: 100%; justify-content: flex-start; padding-top: 0; }
}
</style>
