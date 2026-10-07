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
.prism-page-header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:0 0 24px;min-width:0}
.prism-page-heading{min-width:0}.prism-eyebrow{margin:0 0 6px;font:600 10px/1.4 var(--bbs-font-sans);letter-spacing:.18em;color:var(--bbs-accent);text-transform:uppercase}
.prism-page-title{display:flex;align-items:center;gap:10px;font-size:25px;line-height:1.4;font-weight:650;letter-spacing:-.025em;margin:0;color:var(--bbs-ink)}
.prism-page-icon{font-size:22px;color:var(--bbs-accent)}.prism-page-description{margin:7px 0 0;max-width:58ch;font-size:12px;line-height:1.8;color:var(--bbs-ink-soft);overflow-wrap:anywhere}
.prism-page-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;flex-shrink:0;max-width:50%}
@media(max-width:640px){.prism-page-header{flex-wrap:wrap;gap:12px;margin-bottom:20px}.prism-page-title{font-size:22px}.prism-page-actions{max-width:100%;justify-content:flex-start}.prism-page-description{font-size:12px}}
</style>
