<script setup lang="ts">
/**
 * 角色页的一张角色卡（主要角色或 NPC）。tier 决定显示哪些字段与操作：
 *  主要角色：主要角色开关（已开启）、编辑、删除；NPC 三档：主要角色开关、随行开关、编辑、删除。
 * 两个开关是 aria-pressed 按钮，名称固定，状态由按下样式表达；只发出事件，写入记忆由页面处理。
 * 档案缺外貌、身份或性别时，卡片底部显示所缺项与「从原文补全」（检索全部楼层，结果确认后写入）。
 */
import { apiSettings } from '@/api/settings';
import IconButton from '@/components/IconButton.vue';
import type { MemNpc } from '@/memory/types';
import { computed } from 'vue';
import NpcCardBase from './NpcCardBase.vue';
import { npcCardFields, npcChips, profileGapText, type NpcTier } from './npcView';

const props = defineProps<{
  npc: MemNpc;
  tier: NpcTier;
  /** 有有效摘要可写入时才能补全 */
  canEnrich?: boolean;
  /** 本卡正在检索原文 */
  enriching?: boolean;
  /** 其他角色正在检索,本卡暂不可点 */
  enrichBusy?: boolean;
}>();
const emit = defineEmits<{
  (e: 'toggle-important'): void;
  (e: 'toggle-follow'): void;
  (e: 'edit'): void;
  (e: 'remove'): void;
  (e: 'enrich'): void;
}>();

const chips = computed(() => npcChips(props.npc));
const fields = computed(() => npcCardFields(props.npc, props.tier));
const gaps = computed(() => profileGapText(props.npc));
const starTitle = computed(() => {
  if (props.tier === 'main') return '取消主要角色（改为 NPC）';
  return apiSettings.summaryOnlyMode ? '设为主要角色（仅调整棱镜宝书内的角色分组）' : '设为主要角色（档案与当前状态始终随正文发送）';
});
const following = computed(() => props.tier === 'present' && props.npc.follow === true);
const followTitle = computed(() => {
  if (following.value) return '取消随行（留在当前地点）';
  return props.tier === 'present' ? '设为随行同伴' : '设为随行同伴（随主角在场）';
});
const enrichTitle = computed(() => (props.canEnrich
  ? '检索全部楼层中提到该角色的原文，只补充为空的字段；写入前可核对'
  : '需先有摘要才能写入'));
</script>

<template>
  <NpcCardBase
    :name="npc.name"
    :chips="chips"
    :fields="fields"
    :hint="tier === 'main' ? '暂无档案或状态记录，可在编辑中补充。' : undefined"
    :variant="tier"
    :follow="npc.follow"
  >
    <template #actions>
      <IconButton icon="star" class="bbs-npc-star" :pressed="tier === 'main'" :label="'主要角色：' + npc.name" :title="starTitle" @click="emit('toggle-important')" />
      <IconButton v-if="tier !== 'main'" icon="follow" :pressed="following" :label="'随行：' + npc.name" :title="followTitle" @click="emit('toggle-follow')" />
      <IconButton icon="edit" :label="'编辑角色：' + npc.name" title="编辑" @click="emit('edit')" />
      <IconButton icon="trash" tone="danger" :label="'删除角色：' + npc.name" title="删除" @click="emit('remove')" />
    </template>
    <template v-if="gaps" #footer>
      <span class="bbs-npc-gap">档案缺：{{ gaps }}</span>
      <button class="bbs-btn bbs-btn-sm bbs-npc-enrich" type="button" :disabled="!canEnrich || enriching || enrichBusy"
        :title="enrichTitle" :aria-label="'从原文补全档案：' + npc.name" @click="emit('enrich')">
        <span v-if="enriching" class="bbs-spin" aria-hidden="true"></span>{{ enriching ? '正在检索原文' : '从原文补全' }}
      </button>
    </template>
  </NpcCardBase>
</template>

<style scoped>
/* 主要角色开关按下时用警告色（金色星标），与随行等其他开关的强调色区分。 */
.bbs-npc-star.is-active { color: var(--bbs-warning); background: var(--bbs-warning-soft); }
.bbs-npc-gap { flex: 1 1 auto; min-width: 0; font-size: 12px; line-height: 1.6; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-npc-enrich { flex: 0 0 auto; }
</style>
