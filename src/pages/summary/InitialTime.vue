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
  <details class="bbs-card" aria-label="开场时间设置">
    <summary>开场时间 · {{ derivedMeta.latestStoryTime || '新开场开始时自动初始化' }}</summary>
    <p class="bbs-field-hint">新开场无时间时自动使用“故事第1天 08:00”，只初始化一次，正文与摘要共用。可在此设置你确认的时间；用户设置与正文明确时间优先，不把回忆日期当当前时间。</p>
    <p v-if="fictional" class="bbs-field-hint">本聊天初始化起点为程序虚构，不是现实日期。开始建档前可在此修改；建档后按下方指引编辑逐楼时间。</p>
    <p v-if="issue" class="bbs-field-hint">{{ issue }}</p>
    <form v-else @submit.prevent="save">
      <label>用户设定的开场时间<input v-model="value" class="bbs-input" maxlength="80" placeholder="填写角色设定或你确认的开场时间" :disabled="saving" /></label>
      <button class="bbs-btn" type="submit" :disabled="saving || !value.trim()">{{ saving ? '保存中…' : '保存开场时间' }}</button>
    </form>
    <p class="bbs-field-hint">旧聊天不会自动补造时间。旧摘要需补时间时编辑对应逐楼摘要，不必全量重建；旧空时间仍可兼容读取。</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </details>
</template>
