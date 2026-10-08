<script setup lang="ts">
import { computed } from 'vue';
import { pageNumber } from './view';
const props = defineProps<{ page: number; total: number; size: number; label: string }>();
const emit = defineEmits<{ 'update:page': [page: number] }>();
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.size)));
function jump(event: Event) {
  const input = event.target as HTMLInputElement;
  const page = pageNumber(Number(input.value), props.total, props.size);
  input.value = String(page);
  emit('update:page', page);
}
</script>
<template>
  <nav v-if="total > size" class="bbs-summary-pager" :aria-label="`${label}分页`">
    <button class="bbs-btn bbs-btn-sm" type="button" :disabled="page <= 1" @click="emit('update:page', page - 1)">上一页</button>
    <label>第 <input class="bbs-input" type="number" min="1" :max="pages" :value="page" :aria-label="`${label}页码`" @change="jump" /> / {{ pages }} 页</label>
    <span class="bbs-pager-total">{{ total }} 条</span>
    <button class="bbs-btn bbs-btn-sm" type="button" :disabled="page >= pages" @click="emit('update:page', page + 1)">下一页</button>
  </nav>
</template>
<style scoped>
.bbs-summary-pager { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px; margin:15px 0 5px; padding:8px 0; border-top:1px solid var(--bbs-line); border-bottom:1px solid var(--bbs-line); font-size:10px; color:var(--bbs-ink-muted); }
.bbs-summary-pager label { display:flex; align-items:center; gap:4px; }
.bbs-summary-pager input { width:42px; min-height:36px; padding:4px; border:0; text-align:center; border-radius:5px; background:var(--bbs-surface); font-size:11px; }
.bbs-summary-pager button { min-height:40px; padding:7px 8px; border:0; background:transparent; font-size:11px; color:var(--bbs-ink-soft); }
.bbs-summary-pager button:hover { background:var(--bbs-surface-2); color:var(--bbs-accent); }
@media(max-width:360px) { .bbs-pager-total { display:none; } }
</style>
