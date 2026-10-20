<script setup lang="ts" generic="T extends string">
/**
 * 分段选择：几个互斥选项并排在一条浅底轨道上，选中项白底、强调色文字。
 * 每个选项是带 aria-pressed 的按钮，整组用 label 作读屏名称。
 * 选项可带 hint（第二行小字，用于需要解释的选项，如变量模板的作用范围）。
 * 切换前需要校验的（如切模式要先解析 JSON），在 update:modelValue 里处理，不通过时不改值即可。
 */
import Icon from '@/components/Icon.vue';

interface SegmentOption<V extends string = string> {
  value: V;
  label: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
}

defineProps<{
  modelValue: T;
  options: SegmentOption<T>[];
  label: string;
  /** 占满整行，各选项等分 */
  block?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', value: T): void }>();
</script>

<template>
  <div class="bbs-segctl" :class="{ 'is-block': block }" role="group" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="bbs-segctl-opt"
      :class="{ 'is-on': o.value === modelValue, 'has-hint': !!o.hint }"
      :aria-pressed="o.value === modelValue"
      :disabled="o.disabled"
      @click="emit('update:modelValue', o.value)"
    >
      <span class="bbs-segctl-label"><Icon v-if="o.icon" :name="o.icon" />{{ o.label }}</span>
      <small v-if="o.hint" class="bbs-segctl-hint">{{ o.hint }}</small>
    </button>
  </div>
</template>
