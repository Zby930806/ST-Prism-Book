<script setup lang="ts">
/**
 * 名单勾选弹窗：搜索框 + 勾选列表。排除角色与整本排除世界书共用。
 * 名字列表由调用方在打开时计算（关闭后不再持有，避免常驻大列表）；搜索词每次打开时清空。
 * 列表很长时用子串过滤收敛渲染量。外框（标题栏、关闭键、底部）用共享的 ModalShell。
 */
import ModalShell from '@/components/ModalShell.vue';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  /** 弹窗标题 */
  title: string;
  /** 弹窗的读屏名称 */
  dialogLabel: string;
  /** 关闭键的名称 */
  closeLabel: string;
  /** 搜索框占位文字 */
  placeholder: string;
  /** 全部名字（已去重排序） */
  names: string[];
  /** 已勾选的名字 */
  selected: string[];
  /** 名字的量词与名称，用于计数：「个角色」「本」 */
  countUnit: string;
  /** 没有匹配时的对象名称：「角色」「世界书」 */
  noun: string;
  /** 一个名字也没读到时的说明 */
  emptyText: string;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'toggle', name: string): void }>();

const search = ref('');
watch(() => props.open, open => { if (open) search.value = ''; });

// 过滤:空搜索显示全部;否则大小写不敏感子串匹配
const filtered = computed<string[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.names;
  return props.names.filter(n => n.toLowerCase().includes(q));
});
</script>

<template>
  <ModalShell :open="open" :title="title" :close-label="closeLabel" class="prism-settings-modal" :aria-label="dialogLabel" @close="emit('close')">
    <input
      v-model="search"
      class="bbs-input"
      type="search"
      :placeholder="placeholder"
      :aria-label="placeholder.replace(/…$/, '')"
      spellcheck="false"
    />

    <div class="bbs-exclude-list">
      <label v-for="name in filtered" :key="name" class="bbs-exclude-row">
        <input
          type="checkbox"
          class="bbs-checkbox"
          :checked="selected.includes(name)"
          @change="emit('toggle', name)"
        />
        <span class="bbs-exclude-row-name">{{ name }}</span>
      </label>
      <p v-if="!names.length" class="bbs-field-hint">{{ emptyText }}</p>
      <p v-else-if="!filtered.length" class="bbs-field-hint">没有匹配「{{ search }}」的{{ noun }}。</p>
    </div>

    <template #footer>
      <span class="bbs-exclude-count">共 {{ names.length }} {{ countUnit }} · 已排除 {{ selected.length }}</span>
      <span class="bbs-modal-foot-spacer"></span>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="emit('close')">完成</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 弹窗内勾选列表:固定高度内滚动,长名单不撑爆弹窗 */
.bbs-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
/* 勾选行：整行可点，桌面高 40px，窄屏与触屏 44px */
.bbs-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 8px 8px;
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
}
@media (max-width: 640px), (pointer: coarse) {
  .bbs-exclude-row { min-height: 44px; }
}
.bbs-exclude-row:hover {
  background: var(--bbs-surface-2);
}
.bbs-exclude-row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-exclude-count {
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
</style>
