<script setup lang="ts">
/**
 * 角色卡最下方的「对主角的了解」：该角色知道或以为的主角的事。默认收起，展开后可添加、修改、删除；
 * 写入与弹窗都在页面上，这里只发出事件。没有条目时整块缩成一行：标题 +「暂无」+ 一句说明 + 添加键。
 * warning：不记录或不发送时的提醒（警告色）；note：发送规则，展开后显示在列表上方。
 */
import FoldSection from '@/components/FoldSection.vue';
import IconButton from '@/components/IconButton.vue';
import type { MemKnowledge } from '@/memory/types';
import { ref } from 'vue';
import NpcEntry from './NpcEntry.vue';
import { labelSnippet } from './npcView';

const props = defineProps<{
  name: string;
  userName: string;
  entries: MemKnowledge[];
  /** 有有效摘要可写入时才能手动修改 */
  canEdit: boolean;
  warning?: string;
  note?: string;
}>();
const emit = defineEmits<{
  (e: 'add'): void;
  (e: 'edit', entry: MemKnowledge): void;
  (e: 'remove', entry: MemKnowledge): void;
}>();
const open = ref(false);
</script>

<template>
  <FoldSection
    class="bbs-npc-know"
    :title="`对${props.userName}的了解`"
    :count="entries.length"
    :open="open"
    :warning="warning"
    empty-hint="没有记下的私事按该角色不知道处理。"
    hint-below
    @update:open="open = $event"
  >
    <template #title><h3 class="bbs-npc-know-title">对{{ userName }}的了解</h3></template>
    <template #actions>
      <IconButton
        icon="plus"
        :label="`添加${name}对${userName}的了解`"
        :title="canEdit ? '添加一条' : '需先有摘要才能手动添加'"
        :disabled="!canEdit"
        @click="emit('add')"
      />
    </template>
    <p v-if="note" class="bbs-field-hint">{{ note }}</p>
    <div class="bbs-npc-know-list">
      <NpcEntry v-for="k in entries" :key="k.id" :text="k.text" :tag="k.createdTime ? `记于 ${k.createdTime}` : undefined">
        <template #actions>
          <IconButton icon="edit" :label="'修改了解记录：' + labelSnippet(k.text)" title="修改" :disabled="!canEdit" @click="emit('edit', k)" />
          <IconButton icon="trash" tone="danger" :label="'删除了解记录：' + labelSnippet(k.text)" title="删除" :disabled="!canEdit" @click="emit('remove', k)" />
        </template>
      </NpcEntry>
    </div>
  </FoldSection>
</template>

<style scoped>
.bbs-npc-know { gap: 8px; }
.bbs-npc-know-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--bbs-ink-soft); }
.bbs-npc-know-list { display: flex; flex-direction: column; }
.bbs-npc-know .bbs-field-hint { margin: 0 0 4px; }
</style>
