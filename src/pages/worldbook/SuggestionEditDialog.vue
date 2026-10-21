<script setup lang="ts">
/** 编辑建议后再应用：与模型输出用同一套校验（normalizeEdit），不合格时在弹窗中说明原因。 */
import { computed, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import ModalShell from '@/components/ModalShell.vue';
import { KIND_LABELS, normalizeEdit } from '@/worldbook/protocol';
import { entryContent, entryKeys } from '@/worldbook/entries';
import { WB_LIMITS as L } from '@/worldbook/limits';
import type { Suggestion, WorldData, WorldEntry } from '@/worldbook/types';

type Patch = Pick<Suggestion, 'title' | 'keys' | 'content' | 'find'>;
const props = defineProps<{ suggestion: Suggestion | null; entry: WorldEntry | null; data: WorldData | null; busy: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'save', patch: Patch, apply: boolean): void }>();

const form = ref({ title: '', keys: '', content: '', find: '' });
const error = ref('');
watch(() => props.suggestion, s => {
  error.value = '';
  form.value = s ? { title: s.title, keys: s.keys.join('，'), content: s.content, find: s.find } : { title: '', keys: '', content: '', find: '' };
}, { immediate: true });

const kind = computed(() => props.suggestion?.kind ?? 'create');
const title = computed(() => props.suggestion ? '编辑建议：' + KIND_LABELS[kind.value] : '编辑建议');
const contentLabel = computed(() => ({ create: '内容', append: '追加内容', replace: '替换为', rewrite: '改写后的内容', keys: '', flag: '' }[kind.value]));
const contentMax = computed(() => ({ create: L.create, append: L.append, replace: L.replace, rewrite: L.rewrite, keys: 0, flag: 0 }[kind.value]));
const current = computed(() => (props.entry ? entryContent(props.entry) : ''));
const currentKeys = computed(() => (props.entry ? entryKeys(props.entry).join('、') : ''));

function submit(apply: boolean) {
  if (!props.suggestion || props.busy) return;
  error.value = '';
  try {
    const patch = normalizeEdit(kind.value, form.value, props.entry, props.data);
    emit('save', patch, apply);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '内容不符合要求。';
  }
}
</script>

<template>
  <ModalShell :open="!!suggestion" :title="title" wide close-label="关闭编辑建议" @close="emit('close')">
    <template v-if="suggestion">
      <p v-if="kind !== 'create'" class="wb-edit-target">条目「{{ suggestion.title }}」（uid {{ suggestion.uid }}）</p>
      <label v-if="kind === 'create'" class="bbs-modal-field">
        <span class="bbs-modal-label">标题</span>
        <input v-model="form.title" class="bbs-input" type="text" :maxlength="L.title" autocomplete="off" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">{{ kind === 'create' ? '关键词' : '新增关键词' }}</span>
        <input v-model="form.keys" class="bbs-input" type="text" autocomplete="off" :placeholder="kind === 'create' ? '用逗号分隔，至少一个，每个两个字以上' : '可留空；用逗号分隔'" />
        <span v-if="currentKeys" class="bbs-field-hint">现有关键词：{{ currentKeys }}</span>
      </label>
      <label v-if="kind === 'replace'" class="bbs-modal-field">
        <span class="bbs-modal-label">原文片段（与条目原文逐字一致，只出现一次）</span>
        <textarea v-model="form.find" v-autosize class="bbs-input bbs-modal-autogrow" rows="1" :maxlength="L.find" />
      </label>
      <label v-if="contentLabel" class="bbs-modal-field">
        <span class="bbs-modal-label">{{ contentLabel }}</span>
        <textarea v-model="form.content" v-autosize class="bbs-input wb-edit-content" rows="4" :maxlength="contentMax" />
        <span class="bbs-field-hint">{{ form.content.trim().length }} / {{ contentMax }} 字</span>
      </label>
      <details v-if="kind !== 'create' && entry" class="bbs-disclosure wb-edit-current">
        <summary>条目当前内容</summary>
        <p class="wb-edit-text">{{ current || '（空）' }}</p>
      </details>
      <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
    </template>
    <template #footer>
      <button type="button" class="bbs-btn" :disabled="busy" @click="emit('close')">取消</button>
      <button type="button" class="bbs-btn" :disabled="busy" @click="submit(false)">保存</button>
      <button type="button" class="bbs-btn bbs-btn-primary" :disabled="busy" @click="submit(true)"><Icon name="check" />保存并应用</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.wb-edit-target { margin: 0 0 10px; font-size: 13px; color: var(--bbs-ink-soft); overflow-wrap: anywhere; }
.wb-edit-content { min-height: 120px; max-height: 320px; overflow-y: auto; }
.wb-edit-current { margin-top: 6px; }
.wb-edit-text { max-height: 220px; margin: 6px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.8; color: var(--bbs-ink-soft); }
</style>
