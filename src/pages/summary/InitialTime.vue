<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { derivedMeta } from '@/memory/store';
import { INITIAL_TIME_ORIGIN_KEY, initialStoryTime } from '@/memory/timeTag';
import { initialTimeEditIssue, saveInitialStoryTime } from '@/memory/initialTime';
import { getContext } from '@/st/context';

const value = ref('');
const saving = ref(false);
const error = ref('');
const issue = computed(() => { void derivedMeta.rev; return initialTimeEditIssue(); });
const fictional = computed(() => { void derivedMeta.rev; return getContext()?.chatMetadata?.[INITIAL_TIME_ORIGIN_KEY] === 'fictional'; });
watch([() => { void derivedMeta.rev; return getContext()?.chatMetadata; }, () => { void derivedMeta.rev; return initialStoryTime(); }], () => {
  value.value = initialStoryTime(); error.value = '';
}, { immediate: true });
async function save() {
  const meta = getContext()?.chatMetadata;
  saving.value = true; error.value = '';
  try { await saveInitialStoryTime(value.value); }
  catch (e) { if (getContext()?.chatMetadata === meta) error.value = String(e instanceof Error ? e.message : e); }
  finally { saving.value = false; }
}
</script>

<template>
  <details class="bbs-disclosure bbs-initial-time" aria-label="开场时间设置">
    <summary>开场时间 <span class="bbs-disclosure-meta">{{ derivedMeta.latestStoryTime || '新聊天开始时自动设定' }}</span></summary>
    <p class="bbs-field-hint">新聊天如果没写时间，会从「故事第1天 08:00」开始，正文和摘要共用这个起点。正文里写明的时间优先；也可以在这里设定你想要的开场时间。</p>
    <p v-if="fictional" class="bbs-field-hint">这个聊天的起点是自动设定的虚构时间，不是现实日期。</p>
    <p v-if="issue" class="bbs-field-hint">{{ issue }}</p>
    <form v-else class="bbs-initial-time-form" @submit.prevent="save">
      <input v-model="value" class="bbs-input" maxlength="80" aria-label="开场时间" placeholder="角色设定里的时间，或你想要的开场时间" :disabled="saving" />
      <button class="bbs-btn" type="submit" :disabled="saving || !value.trim()">{{ saving ? '保存中…' : '保存' }}</button>
    </form>
    <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
  </details>
</template>

<style scoped>
.bbs-initial-time-form { display: flex; gap: 8px; margin: 4px 0 6px; }
.bbs-initial-time-form .bbs-input { flex: 1 1 auto; min-width: 0; }
.bbs-initial-time-form .bbs-btn { flex: 0 0 auto; }
@media (max-width: 420px) { .bbs-initial-time-form { flex-direction: column; } }
</style>
