<script setup lang="ts">
/**
 * NPC 名册里的一张角色卡。tier 决定显示哪些字段与操作：
 *  主要角色：主要角色开关（已开启）、编辑、删除；其他三档：主要角色开关、随行开关、编辑、删除。
 * 两个开关是 aria-pressed 按钮，名称固定，状态由按下样式表达；只发出事件，写入记忆由页面处理。
 */
import { apiSettings } from '@/api/settings';
import IconButton from '@/components/IconButton.vue';
import type { MemNpc } from '@/memory/types';
import { computed } from 'vue';
import NpcCardBase from './NpcCardBase.vue';
import { npcCardFields, personChips, type NpcTier } from './npcView';

const props = defineProps<{ npc: MemNpc; tier: NpcTier }>();
const emit = defineEmits<{
  (e: 'toggle-important'): void;
  (e: 'toggle-follow'): void;
  (e: 'edit'): void;
  (e: 'remove'): void;
}>();

const chips = computed(() => personChips(props.npc.gender, props.npc.age, props.npc.ageTime));
const fields = computed(() => npcCardFields(props.npc, props.tier));
const starTitle = computed(() => {
  if (props.tier === 'main') return '取消主要角色';
  return apiSettings.summaryOnlyMode ? '设为主要角色（仅调整棱镜宝书内的角色分组）' : '设为主要角色（始终全量发送、追踪状态）';
});
const following = computed(() => props.tier === 'present' && props.npc.follow === true);
const followTitle = computed(() => {
  if (following.value) return '取消随行（留在当前地点）';
  return props.tier === 'present' ? '设为随行同伴' : '设为随行同伴（随主角在场）';
});
</script>

<template>
  <NpcCardBase
    :name="npc.name"
    :chips="chips"
    :fields="fields"
    :hint="tier === 'main' ? '暂无状态记录，可在编辑中补充着装、状态和位置。' : undefined"
    :variant="tier"
    :follow="npc.follow"
  >
    <template #actions>
      <IconButton icon="star" class="bbs-npc-star" :pressed="tier === 'main'" :label="'主要角色：' + npc.name" :title="starTitle" @click="emit('toggle-important')" />
      <IconButton v-if="tier !== 'main'" icon="follow" :pressed="following" :label="'随行：' + npc.name" :title="followTitle" @click="emit('toggle-follow')" />
      <IconButton icon="edit" :label="'编辑角色：' + npc.name" title="编辑" @click="emit('edit')" />
      <IconButton icon="trash" tone="danger" :label="'删除角色：' + npc.name" title="删除" @click="emit('remove')" />
    </template>
  </NpcCardBase>
</template>

<style scoped>
/* 主要角色开关按下时用警告色（金色星标），与随行等其他开关的强调色区分。 */
.bbs-npc-star.is-active { color: var(--bbs-warning); background: var(--bbs-warning-soft); }
</style>
