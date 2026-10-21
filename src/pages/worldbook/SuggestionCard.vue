<script setup lang="ts">
/** 一条世界书建议：动作、标题、关键词、内容；修改类显示改前改后对比；依据楼层、冲突和权限说明；应用、编辑、忽略。 */
import { computed, ref } from 'vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import { KIND_LABELS, permissionBlock } from '@/worldbook/protocol';
import { previewChange, suggestionConflict } from '@/worldbook/writer';
import { changeParts, floorsText, trimContext } from '@/worldbook/view';
import { entryKeys } from '@/worldbook/entries';
import type { Suggestion, WorldData, WorldbookPermission } from '@/worldbook/types';

const props = defineProps<{
  suggestion: Suggestion;
  data: WorldData | null;
  bookError: string;
  stale: boolean;
  locked: boolean;
  permission: WorldbookPermission;
}>();
const emit = defineEmits<{ (e: 'apply'): void; (e: 'edit'): void; (e: 'ignore'): void }>();

const s = computed(() => props.suggestion);
const pending = computed(() => s.value.status === 'pending');
const preview = computed(() => previewChange(s.value, props.data));
const conflict = computed(() => (pending.value && props.data ? suggestionConflict(s.value, props.data) : ''));
const blocked = computed(() => (pending.value && s.value.kind !== 'flag' ? permissionBlock(s.value.kind, props.permission) : ''));
// 世界书不存在、依据楼层失效的说明在整批的头部显示一次，卡片里只说明本条自己的问题（冲突、超出权限）
const problem = computed(() => (pending.value && !props.stale && !props.bookError ? conflict.value || blocked.value : ''));
const canApply = computed(() => pending.value && s.value.kind !== 'flag' && !props.stale && !props.bookError && !problem.value && !!props.data && !props.locked);
const modifies = computed(() => ['append', 'replace', 'rewrite'].includes(s.value.kind));
const expanded = ref(false);
const fullParts = computed(() => (modifies.value && preview.value.entry ? changeParts(s.value, preview.value.before) : { before: [], after: [] }));
const parts = computed(() => (expanded.value ? fullParts.value : { before: trimContext(fullParts.value.before), after: trimContext(fullParts.value.after) }));
const canExpand = computed(() => JSON.stringify(trimContext(fullParts.value.before)) !== JSON.stringify(fullParts.value.before)
  || JSON.stringify(trimContext(fullParts.value.after)) !== JSON.stringify(fullParts.value.after));
const existingKeys = computed(() => (preview.value.entry ? entryKeys(preview.value.entry) : []));
const badge = computed(() => ({ create: 'is-add', append: 'is-add', keys: 'is-add', replace: 'is-resolve', rewrite: 'is-resolve', flag: 'is-reopen' }[s.value.kind]));
const statusLabel = computed(() => ({ pending: '', applied: '已应用', ignored: s.value.kind === 'flag' ? '已读' : '已忽略', undone: '已撤销' }[s.value.status]));
const basis = computed(() => [floorsText(s.value.floors), s.value.kind === 'flag' ? '' : s.value.reason].filter(Boolean).join('：'));
</script>

<template>
  <article class="wb-card" :class="[`is-${s.kind}`, `is-${s.status}`]">
    <header class="wb-card-head">
      <span class="bbs-op-badge" :class="badge">{{ KIND_LABELS[s.kind] }}</span>
      <h3 class="wb-card-title">{{ s.title }}</h3>
      <span v-if="s.uid !== null" class="wb-uid">uid {{ s.uid }}</span>
      <span v-if="s.edited" class="wb-tag">已编辑</span>
      <span v-if="statusLabel" class="wb-tag" :class="{ 'is-done': s.status === 'applied' }">{{ statusLabel }}</span>
    </header>

    <p v-if="s.keys.length" class="wb-keys">
      <span class="wb-keys-label">{{ s.kind === 'create' ? '关键词' : '新增关键词' }}</span>
      <span v-for="key in s.keys" :key="key" class="wb-chip">{{ key }}</span>
    </p>

    <p v-if="s.kind === 'create'" class="wb-text">{{ s.content }}</p>
    <div v-else-if="modifies" class="wb-diff-wrap">
      <div v-if="preview.entry" class="wb-diff">
        <div class="wb-diff-col">
          <span class="wb-diff-label">改前</span>
          <p class="wb-text"><span v-for="(part, i) in parts.before" :key="i" :class="`wb-part is-${part.type}`">{{ part.text }}</span></p>
        </div>
        <div class="wb-diff-col">
          <span class="wb-diff-label">改后</span>
          <p class="wb-text"><span v-for="(part, i) in parts.after" :key="i" :class="`wb-part is-${part.type}`">{{ part.text }}</span><span v-if="!parts.after.length" class="wb-empty-text">（空）</span></p>
        </div>
      </div>
      <p v-else-if="s.kind === 'append'" class="wb-text">{{ s.content }}</p>
      <p v-else class="bbs-field-hint">读不到目标条目的当前内容，无法显示改前改后对比。</p>
      <button v-if="canExpand" type="button" class="wb-link" @click="expanded = !expanded">{{ expanded ? '只看改动附近' : '展开全文' }}</button>
    </div>
    <p v-else-if="s.kind === 'keys' && existingKeys.length" class="wb-keys is-existing">
      <span class="wb-keys-label">现有关键词</span>
      <span v-for="key in existingKeys" :key="key" class="wb-chip is-muted">{{ key }}</span>
    </p>
    <p v-if="s.kind === 'flag'" class="wb-flag">{{ s.reason }}</p>

    <p v-if="basis" class="wb-basis"><span class="wb-basis-label">依据</span>{{ basis }}</p>
    <ul v-if="s.warnings.length && pending" class="wb-warnings">
      <li v-for="(warning, i) in s.warnings" :key="i">{{ warning }}</li>
    </ul>
    <p v-if="problem" class="bbs-callout is-warning wb-problem">{{ problem }}</p>

    <footer v-if="pending" class="wb-card-foot">
      <template v-if="s.kind === 'flag'">
        <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="emit('ignore')"><Icon name="check" />知道了</button>
      </template>
      <template v-else>
        <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked" @click="emit('ignore')">忽略</button>
        <IconButton icon="edit" size="sm" :label="'编辑建议：' + s.title" title="编辑后再应用" :disabled="locked || stale || !!bookError" @click="emit('edit')" />
        <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="!canApply" @click="emit('apply')"><Icon name="check" />应用</button>
      </template>
    </footer>
  </article>
</template>

<style scoped>
.wb-card { min-width: 0; margin: 10px 0 0; padding: 12px 14px; border: 1px solid var(--bbs-line); border-radius: 12px; background: var(--bbs-surface); }
.wb-card.is-pending { border-left: 3px solid var(--bbs-accent); }
.wb-card.is-pending.is-flag { border-left-color: var(--bbs-warning); }
.wb-card:not(.is-pending) { border-style: dashed; }
.wb-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.wb-card-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 14.5px; font-weight: 650; color: var(--bbs-ink); overflow-wrap: anywhere; }
.wb-uid { font: 12px/1.6 var(--bbs-font-mono); color: var(--bbs-ink-muted); }
.wb-tag { padding: 0 8px; border-radius: var(--bbs-radius-pill); background: var(--bbs-surface-2); font-size: 11.5px; line-height: 1.8; color: var(--bbs-ink-soft); }
.wb-tag.is-done { background: var(--bbs-accent-soft); color: var(--bbs-accent); }
.wb-keys { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 8px 0 0; }
.wb-keys-label { margin-right: 2px; font-size: 12px; color: var(--bbs-ink-muted); }
.wb-chip { padding: 1px 8px; border-radius: var(--bbs-radius-xs); background: var(--bbs-accent-soft); color: var(--bbs-accent); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.wb-chip.is-muted { background: var(--bbs-surface-2); color: var(--bbs-ink-soft); }
.wb-text { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 400 13.5px/1.85 var(--bbs-font-reading); color: var(--bbs-ink); }
.wb-diff { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 8px; }
.wb-diff-col { min-width: 0; padding: 8px 10px; border: 1px solid var(--bbs-line); border-radius: 8px; background: var(--bbs-bg); }
.wb-diff-col .wb-text { max-height: 260px; margin: 2px 0 0; overflow: auto; }
.wb-diff-label { font-size: 11.5px; font-weight: 600; color: var(--bbs-ink-muted); }
.wb-part.is-same { color: var(--bbs-ink-soft); }
.wb-part.is-removed { background: var(--bbs-danger-soft); color: var(--bbs-danger); text-decoration: line-through; text-decoration-thickness: 1px; }
.wb-part.is-added { background: var(--bbs-accent-soft); color: var(--bbs-ink); box-shadow: inset 0 -1.5px 0 var(--bbs-accent); }
.wb-empty-text { color: var(--bbs-ink-muted); }
.wb-link { margin-top: 6px; padding: 0; border: 0; background: none; color: var(--bbs-accent); font-size: 12.5px; cursor: pointer; }
.wb-link:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }
.wb-flag { margin: 8px 0 0; font-size: 13.5px; line-height: 1.8; color: var(--bbs-ink); white-space: pre-wrap; }
.wb-basis { margin: 8px 0 0; font-size: 12.5px; line-height: 1.7; color: var(--bbs-ink-soft); overflow-wrap: anywhere; }
.wb-basis-label { margin-right: 6px; font-weight: 600; color: var(--bbs-ink-muted); }
.wb-warnings { margin: 6px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: var(--bbs-ink-muted); }
.wb-problem { margin: 8px 0 0; }
.wb-card-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 10px; }
@media (max-width: 640px) {
  .wb-diff { grid-template-columns: minmax(0, 1fr); }
  .wb-card { padding: 12px; }
}
</style>
