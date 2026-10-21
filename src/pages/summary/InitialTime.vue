<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { derivedMeta } from '@/memory/store';
import { INITIAL_TIME_ORIGIN_KEY, initialStoryTime } from '@/memory/timeTag';
import { currentStoryTimeTarget, initialTimeEditIssue, saveCurrentStoryTime, saveInitialStoryTime } from '@/memory/initialTime';
import { getContext } from '@/st/context';

const value = ref('');
const saving = ref(false);
const error = ref('');
const done = ref('');
// 新聊天设开场时间；已经开始的旧聊天没有故事时间时，改为设定截至最新一层摘要的当前故事时间
const openingIssue = computed(() => { void derivedMeta.rev; return initialTimeEditIssue(); });
const current = computed(() => { void derivedMeta.rev; return openingIssue.value ? currentStoryTimeTarget() : { floor: -1, issue: '' }; });
const mode = computed<'opening' | 'current' | 'locked'>(() => !openingIssue.value ? 'opening' : current.value.floor >= 0 ? 'current' : 'locked');
const title = computed(() => (mode.value === 'opening' ? '开场时间' : mode.value === 'current' ? '当前故事时间' : '故事时间'));
const summaryMeta = computed(() => derivedMeta.latestStoryTime || (mode.value === 'opening' ? '新聊天开始时自动设定' : '未设定'));
const fictional = computed(() => { void derivedMeta.rev; return getContext()?.chatMetadata?.[INITIAL_TIME_ORIGIN_KEY] === 'fictional'; });
watch([() => { void derivedMeta.rev; return getContext()?.chatMetadata; }, () => { void derivedMeta.rev; return initialStoryTime(); }], ([meta], [oldMeta]) => {
  value.value = initialStoryTime(); error.value = '';
  if (meta !== oldMeta) done.value = '';
}, { immediate: true });
async function save() {
  const meta = getContext()?.chatMetadata;
  const text = value.value.trim();
  saving.value = true; error.value = ''; done.value = '';
  try {
    if (mode.value === 'current') {
      const floor = await saveCurrentStoryTime(text);
      if (getContext()?.chatMetadata === meta) {
        done.value = `已记录：#${floor} 楼摘要的结束时间为「${text}」。之后的摘要从这个时间往后推算，更早的摘要没有改动。`;
        value.value = '';
      }
    } else {
      await saveInitialStoryTime(text);
    }
  } catch (e) { if (getContext()?.chatMetadata === meta) error.value = String(e instanceof Error ? e.message : e); }
  finally { saving.value = false; }
}
</script>

<template>
  <details class="bbs-disclosure bbs-initial-time" :aria-label="title + '设置'">
    <summary>{{ title }} <span class="bbs-disclosure-meta">{{ summaryMeta }}</span></summary>
    <template v-if="mode === 'opening'">
      <p class="bbs-field-hint">新聊天未写明时间时，从「故事第1天 08:00」开始，正文和摘要共用该起点。正文中写明的时间优先；也可在此设定开场时间。</p>
      <p v-if="fictional" class="bbs-field-hint">当前聊天的起点是自动设定的虚构时间，不是现实日期。</p>
    </template>
    <template v-else-if="mode === 'current'">
      <p class="bbs-field-hint">这个聊天已有摘要，但还没有记录故事时间。年龄推算、相对时间和伤势提醒都要用到它，没有时只能按楼层数估算。可以在此设定截至 #{{ current.floor }} 楼的故事时间。</p>
      <p class="bbs-field-hint">时间记在 #{{ current.floor }} 楼摘要的结束时间上（这层摘要原本没有时间），只影响之后的推算：已有摘要里写好的时间不会改动，更早的楼层也不会重新摘要。</p>
    </template>
    <p v-else class="bbs-field-hint">{{ current.issue || openingIssue }}</p>
    <form v-if="mode !== 'locked'" class="bbs-initial-time-form" @submit.prevent="save">
      <input v-model="value" class="bbs-input" maxlength="80" :aria-label="title" :placeholder="mode === 'opening' ? '角色设定中的时间，或自定的开场时间' : '如 永和十五年八月初七 傍晚，或 故事第12天 21:00'" :disabled="saving" />
      <button class="bbs-btn" type="submit" :disabled="saving || !value.trim()">{{ saving ? '保存中…' : '保存' }}</button>
    </form>
    <p v-if="done" class="bbs-callout is-success" role="status">{{ done }}</p>
    <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
  </details>
</template>

<style scoped>
.bbs-initial-time-form { display: flex; gap: 8px; margin: 4px 0 6px; }
.bbs-initial-time-form .bbs-input { flex: 1 1 auto; min-width: 0; }
.bbs-initial-time-form .bbs-btn { flex: 0 0 auto; }
@media (max-width: 420px) { .bbs-initial-time-form { flex-direction: column; } }
</style>
