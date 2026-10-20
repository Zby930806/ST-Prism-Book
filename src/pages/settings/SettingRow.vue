<script setup lang="ts">
/**
 * 设置行：一行标签 + 控件，下方一段说明。设置页约 50 组字段共用。
 *
 * 渲染并列元素（行 + 说明 + 可选的详细说明），不加外层包裹：卡片里的相邻选择器（如 .bbs-vec-io + .bbs-switch-row）
 * 与 :last-child 等规则照常生效。控件放默认插槽；说明含加粗、代码等格式时用 hint 插槽。
 * 说明较长时，hint 只写一句要点，其余写在 details（或 details 插槽），收在「详细说明」里，点开再看。
 * kind：switch 为开关行，num 为数字或短下拉行（控件靠右）。
 * as：控件是原生 input/select 时用 label，点标签即聚焦控件；BbsSelect 等自绘控件用 div（在控件上写 aria-label）。
 * 其余属性（class 等）落在行元素上。样式在 settings.css。
 * 读屏：挂载后把说明的 id 写到行内第一个控件的 aria-describedby 上（控件已有该属性时不覆盖）。
 */
import { onMounted, ref, useId, useSlots } from 'vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  label: string;
  hint?: string;
  /** 详细说明：收在「详细说明」折叠里 */
  details?: string;
  kind?: 'switch' | 'num';
  as?: 'label' | 'div';
}>(), {
  hint: '',
  details: '',
  kind: 'switch',
  as: 'label',
});

const slots = useSlots();
const hintId = useId();
const rowEl = ref<HTMLElement | null>(null);
onMounted(() => {
  if (!props.hint && !slots.hint) return;
  const control = rowEl.value?.querySelector<HTMLElement>('input, select, textarea, button');
  if (control && !control.hasAttribute('aria-describedby')) control.setAttribute('aria-describedby', hintId);
});
</script>

<template>
  <component :is="as" ref="rowEl" v-bind="$attrs" :class="kind === 'num' ? 'bbs-num-row' : 'bbs-switch-row'">
    <span class="bbs-field-label">{{ label }}</span>
    <slot />
  </component>
  <p v-if="hint || $slots.hint" :id="hintId" class="bbs-field-hint"><slot name="hint">{{ hint }}</slot></p>
  <details v-if="details || $slots.details" class="prism-hint-more">
    <summary>详细说明</summary>
    <p class="bbs-field-hint"><slot name="details">{{ details }}</slot></p>
  </details>
</template>
