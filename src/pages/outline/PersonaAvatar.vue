<script setup lang="ts">
/**
 * 规划讨论角色的头像：Qiheng 用内嵌的头像（大图用插画）；自定义角色用上传的图片，
 * 没有图片或图片加载失败时显示名字的第一个字。尺寸和圆角由外层的 class 决定。
 */
import { computed, ref, watch } from 'vue';
import { activeDiscussionPersona, personaInitial } from '@/outline/persona';
import { QIHENG_AVATAR, QIHENG_PORTRAIT } from '@/outline/qihengAvatar';

const props = withDefaults(defineProps<{ size: number; portrait?: boolean }>(), { portrait: false });
const persona = computed(() => activeDiscussionPersona());
const failed = ref(false);
watch(() => persona.value.avatar, () => { failed.value = false; });
const src = computed(() => {
  if (!persona.value.custom) return props.portrait ? QIHENG_PORTRAIT : QIHENG_AVATAR;
  return failed.value ? '' : persona.value.avatar;
});
const monoStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px`, fontSize: `${Math.round(props.size * 0.42)}px` }));
</script>

<template>
  <img v-if="src" class="pa" :src="src" :alt="portrait ? persona.name : ''" :width="size" :height="size" @error="failed = true" />
  <span v-else class="pa pa-mono" :style="monoStyle" aria-hidden="true">{{ personaInitial(persona.name) }}</span>
</template>

<style scoped>
.pa { flex: 0 0 auto; border-radius: 50%; object-fit: cover; box-shadow: 0 0 0 1px var(--bbs-line); }
.pa-mono { display: inline-flex; align-items: center; justify-content: center; background: var(--bbs-accent-soft); color: var(--bbs-accent); font-family: var(--bbs-font-reading); font-weight: 650; line-height: 1; user-select: none; }
</style>
