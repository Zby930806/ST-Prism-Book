<script setup lang="ts">
/**
 * 「从原文补全档案」的确认弹窗：检索进行中、找到可补的字段（附原文依据）、没有可补内容、档案已完整、请求失败。
 * 只填该角色当前为空的字段；写入记在最新一条摘要的补档结果里（重新摘要该楼时沿用）。写入与取消由页面处理。
 */
import ModalShell from '@/components/ModalShell.vue';
import { ENRICH_FIELD_LABELS, type ManualEnrichResult } from '@/memory/npcEnrich';
import { NPC_ENRICH_FIELDS } from '@/memory/types';
import { computed } from 'vue';

const props = defineProps<{
  open: boolean;
  name: string;
  /** 还在请求时为 null */
  result: ManualEnrichResult | null;
}>();
const emit = defineEmits<{ (e: 'apply'): void; (e: 'close'): void }>();

const rows = computed(() => NPC_ENRICH_FIELDS
  .filter(key => props.result?.fields[key])
  .map(key => ({ key, label: ENRICH_FIELD_LABELS[key], value: props.result!.fields[key]!, evidence: props.result!.evidence[key] ?? '' })));
</script>

<template>
  <ModalShell :open="open" :title="'从原文补全档案：' + name" @close="emit('close')">
    <div class="bbs-enrich" aria-live="polite">
      <p v-if="!result" class="bbs-enrich-wait"><span class="bbs-spin" aria-hidden="true"></span>正在检索提到「{{ name }}」的原文并请求补全……</p>
      <template v-else-if="result.status === 'ok'">
        <p class="bbs-field-hint">以下字段在档案中为空，原文有明确依据。写入后只填空字段，不覆盖已有内容；写入记在最新一条摘要上。</p>
        <dl class="bbs-enrich-list">
          <div v-for="row in rows" :key="row.key" class="bbs-enrich-row">
            <dt>{{ row.label }}</dt>
            <dd>
              <span class="bbs-enrich-value">{{ row.value }}</span>
              <span v-if="row.evidence" class="bbs-enrich-evidence">原文：{{ row.evidence }}</span>
            </dd>
          </div>
        </dl>
      </template>
      <p v-else-if="result.status === 'empty'" class="bbs-callout">
        {{ result.excerpts ? `检索到 ${result.excerpts} 段提到「${name}」的原文，其中没有可补充的明确外貌、身份或性别描写，档案未改动。` : `聊天记录中没有找到提到「${name}」的原文，档案未改动。` }}
      </p>
      <p v-else-if="result.status === 'complete'" class="bbs-callout">「{{ name }}」的档案已完整，无需补全。</p>
      <div v-else class="bbs-callout is-danger" role="alert">
        <span class="bbs-callout-title">{{ result.error?.title || '补全档案没有完成' }}</span>
        <span v-if="result.error?.hint" class="bbs-callout-help">{{ result.error.hint }}</span>
        <details v-if="result.error?.detail"><summary>技术细节</summary><p>{{ result.error.detail }}</p></details>
      </div>
    </div>
    <template #footer>
      <button class="bbs-btn" type="button" @click="emit('close')">{{ result?.status === 'ok' ? '取消' : '关闭' }}</button>
      <button v-if="result?.status === 'ok'" class="bbs-btn bbs-btn-primary" type="button" @click="emit('apply')">写入档案</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.bbs-enrich { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bbs-enrich-wait { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 13px; line-height: 1.7; color: var(--bbs-ink-soft); }
.bbs-enrich-list { display: flex; flex-direction: column; gap: 12px; margin: 0; }
.bbs-enrich-row { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.bbs-enrich-row dt { font-size: 12px; color: var(--bbs-ink-muted); }
.bbs-enrich-row dd { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 0; }
.bbs-enrich-value { font-size: 13px; line-height: 1.75; color: var(--bbs-ink); overflow-wrap: anywhere; }
.bbs-enrich-evidence { padding-left: 8px; border-left: 2px solid var(--bbs-line); font-size: 12px; line-height: 1.7; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
</style>
