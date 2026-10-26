<script setup lang="ts">
/**
 * 「角色重新建档」的审核列表：新角色（首次登场楼层、档案字段、原文）与已有角色的档案改动（原值与新值、原文），
 * 每项可勾选，打开时默认全选。「应用所选」只写入勾选的项；关闭不写入，结果留到下次审核。
 * 没做完就审核时提示：应用后清除进度，未处理的部分不再继续。
 */
import ModalShell from '@/components/ModalShell.vue';
import { refileReview, refileSkipText, type RefileRecord, type RefileReviewChange, type RefileSelection } from '@/memory/npcRefile';
import { computed, ref, watch } from 'vue';

const props = defineProps<{ open: boolean; record: RefileRecord | null }>();
const emit = defineEmits<{ (e: 'apply', selection: RefileSelection): void; (e: 'close'): void }>();

const review = computed(() => (props.record ? refileReview(props.record) : { added: [], changes: [] }));
const pickedAdded = ref(new Set<string>());
const pickedChanges = ref(new Set<string>());
watch(() => props.open, open => {
  if (!open) return;
  pickedAdded.value = new Set(review.value.added.map(a => a.name));
  pickedChanges.value = new Set(review.value.changes.map(c => c.key));
}, { immediate: true });

const partial = computed(() => !!props.record && props.record.phase !== 'review');
const empty = computed(() => !review.value.added.length && !review.value.changes.length);
const picked = computed(() => pickedAdded.value.size + pickedChanges.value.size);
const groups = computed(() => {
  const out: { name: string; items: RefileReviewChange[] }[] = [];
  for (const c of review.value.changes) {
    const group = out.find(g => g.name === c.name);
    if (group) group.items.push(c);
    else out.push({ name: c.name, items: [c] });
  }
  return out;
});
const skipped = computed(() => (props.record?.skipped ?? []).map(refileSkipText));

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
const allAdded = computed(() => review.value.added.every(a => pickedAdded.value.has(a.name)));
const allChanges = computed(() => review.value.changes.every(c => pickedChanges.value.has(c.key)));
function toggleAllAdded() {
  pickedAdded.value = allAdded.value ? new Set() : new Set(review.value.added.map(a => a.name));
}
function toggleAllChanges() {
  pickedChanges.value = allChanges.value ? new Set() : new Set(review.value.changes.map(c => c.key));
}
function apply() {
  emit('apply', { added: [...pickedAdded.value], changes: [...pickedChanges.value] });
}
</script>

<template>
  <ModalShell :open="open" wide title="审核角色重新建档的结果" @close="emit('close')">
    <div class="bbs-refile-review">
      <p class="bbs-field-hint">
        新角色 {{ review.added.length }} 个，档案改动 {{ review.changes.length }} 项。勾选要写入的项，未勾选的不写入；写入的内容作为手动修改保存，重新摘要后仍然保留。
      </p>
      <p v-if="partial" class="bbs-callout is-warning">本次还没有做完。应用后清除进度，未处理的楼层和角色不再继续；需要完整的结果时先关闭此窗口，再点「继续」。</p>
      <p v-if="skipped.length" class="bbs-callout">以下批次没有可用的回复，已跳过：{{ skipped.join('；') }}。</p>

      <section v-if="review.added.length" class="bbs-refile-section" aria-label="新角色">
        <header class="bbs-refile-section-head">
          <span class="bbs-refile-section-title">新角色<span class="bbs-refile-count">{{ review.added.length }}</span></span>
          <button class="bbs-btn bbs-btn-sm" type="button" @click="toggleAllAdded">{{ allAdded ? '全不选' : '全选' }}</button>
        </header>
        <label v-for="item in review.added" :key="item.name" class="bbs-refile-item">
          <input type="checkbox" class="bbs-refile-check" :checked="pickedAdded.has(item.name)" @change="pickedAdded = toggle(pickedAdded, item.name)" />
          <span class="bbs-refile-body">
            <span class="bbs-refile-name">{{ item.name }}<small>首次登场 #{{ item.floor }}</small></span>
            <span v-if="item.fields.length" class="bbs-refile-fields">
              <span v-for="f in item.fields" :key="f.key" class="bbs-refile-field"><b>{{ f.label }}</b>{{ f.value }}</span>
            </span>
            <span v-else class="bbs-refile-muted">原文没有写到身份、性别、年龄、外貌或性格，只记名字。</span>
            <span class="bbs-refile-evidence">原文：{{ item.appear }}</span>
          </span>
        </label>
      </section>

      <section v-if="review.changes.length" class="bbs-refile-section" aria-label="档案改动">
        <header class="bbs-refile-section-head">
          <span class="bbs-refile-section-title">档案改动<span class="bbs-refile-count">{{ review.changes.length }}</span></span>
          <button class="bbs-btn bbs-btn-sm" type="button" @click="toggleAllChanges">{{ allChanges ? '全不选' : '全选' }}</button>
        </header>
        <div v-for="group in groups" :key="group.name" class="bbs-refile-group">
          <span class="bbs-refile-name">{{ group.name }}</span>
          <label v-for="c in group.items" :key="c.key" class="bbs-refile-item">
            <input type="checkbox" class="bbs-refile-check" :checked="pickedChanges.has(c.key)" @change="pickedChanges = toggle(pickedChanges, c.key)" />
            <span class="bbs-refile-body">
              <span class="bbs-refile-label">{{ c.label }}</span>
              <span class="bbs-refile-old"><b>原</b>{{ c.old || '（空）' }}</span>
              <span class="bbs-refile-new"><b>新</b>{{ c.value }}</span>
              <span v-for="(q, i) in c.evidence" :key="i" class="bbs-refile-evidence">原文：{{ q }}</span>
            </span>
          </label>
        </div>
      </section>

      <p v-if="empty" class="bbs-callout">没有找到漏记的角色，现有角色的档案也没有需要改动的地方。</p>
    </div>
    <footer class="bbs-modal-foot bbs-refile-foot">
      <button class="bbs-btn" type="button" @click="emit('close')">关闭</button>
      <button v-if="empty" class="bbs-btn bbs-btn-primary" type="button" @click="apply">完成</button>
      <button v-else class="bbs-btn bbs-btn-primary" type="button" :disabled="!picked" @click="apply">应用所选（{{ picked }} 项）</button>
    </footer>
  </ModalShell>
</template>

<style scoped>
.bbs-refile-review { display: flex; flex-direction: column; gap: 14px; min-width: 0; flex-shrink: 0; }
/* 列表长时弹窗内部滚动;操作键贴在底部,不用滚到最后才能点 */
.bbs-refile-foot {
  position: sticky;
  bottom: -18px;
  z-index: 1;
  margin: 0 -18px -18px;
  padding: 12px 18px;
  border-top: 1px solid var(--bbs-line);
  background: var(--bbs-surface);
}
.bbs-refile-review > p { margin: 0; }
.bbs-refile-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.bbs-refile-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--bbs-line); }
.bbs-refile-section-title { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--bbs-ink); }
.bbs-refile-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: var(--bbs-radius-pill); background: var(--bbs-surface-2);
  font-size: 11px; font-weight: 600; color: var(--bbs-ink-soft); font-variant-numeric: tabular-nums;
}
.bbs-refile-group { display: flex; flex-direction: column; gap: 2px; padding-top: 6px; }
.bbs-refile-group > .bbs-refile-name { padding-left: 4px; }
/* 勾选行:整行可点,复选框固定方形不被长文本挤扁 */
.bbs-refile-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 8px;
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
}
.bbs-refile-item:hover { background: var(--bbs-surface-2); }
.bbs-refile-check { flex: 0 0 auto; width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--bbs-accent); cursor: pointer; }
.bbs-refile-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.bbs-refile-name { font-size: 13px; font-weight: 650; color: var(--bbs-ink); overflow-wrap: anywhere; }
.bbs-refile-name small { margin-left: 8px; font-size: 11.5px; font-weight: 500; color: var(--bbs-ink-muted); font-variant-numeric: tabular-nums; }
.bbs-refile-fields { display: flex; flex-direction: column; gap: 2px; }
.bbs-refile-field,
.bbs-refile-old,
.bbs-refile-new { font-size: 13px; line-height: 1.7; color: var(--bbs-ink); overflow-wrap: anywhere; }
.bbs-refile-field b,
.bbs-refile-old b,
.bbs-refile-new b { display: inline-block; min-width: 3em; margin-right: 6px; font-size: 12px; font-weight: 500; color: var(--bbs-ink-muted); }
.bbs-refile-old { color: var(--bbs-ink-soft); }
.bbs-refile-label { font-size: 12px; font-weight: 600; color: var(--bbs-accent); }
.bbs-refile-muted { font-size: 12.5px; color: var(--bbs-ink-muted); }
.bbs-refile-evidence { padding-left: 8px; border-left: 2px solid var(--bbs-line); font-size: 12px; line-height: 1.7; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
@media (max-width: 640px), (pointer: coarse) {
  .bbs-refile-item { padding: 12px 6px; }
}
</style>
