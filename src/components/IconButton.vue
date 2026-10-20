<script setup lang="ts">
/**
 * 图标按钮：只显示图标、没有文字的按钮。接口说明见 polish-20261009/ui-components-api.md。
 * label 必填：作为读屏名称（aria-label），也作为悬停提示（title）；提示需要更详细时另传 title。
 * 尺寸：md 取主题令牌 --bbs-icon-btn（桌面 36px，窄屏与触屏 40px）；sm 桌面 32px，窄屏与触屏 40px。样式在 base.css 的 .bbs-icon-btn。
 * 图标默认用 icon 指定；需要旋转环等自定义内容时用默认插槽。click 等原生事件与属性直接落在 <button> 上。
 */
import Icon from '@/components/Icon.vue';

const props = withDefaults(defineProps<{
  label: string;
  icon?: string;
  title?: string;
  /** danger：悬停显红，用于删除类操作 */
  tone?: 'default' | 'danger';
  size?: 'md' | 'sm';
  /** 已开启的状态（如已置顶、随行中），以强调色淡底显示 */
  active?: boolean;
  /** 开关型按钮：给出时输出 aria-pressed；为 true 时外观同 active */
  pressed?: boolean;
  disabled?: boolean;
}>(), {
  icon: undefined,
  title: undefined,
  tone: 'default',
  size: 'md',
  active: false,
  pressed: undefined,
  disabled: false,
});
</script>

<template>
  <button
    class="bbs-icon-btn"
    :class="{ 'is-danger': props.tone === 'danger', 'is-sm': props.size === 'sm', 'is-active': props.active || props.pressed === true }"
    type="button"
    :disabled="props.disabled"
    :title="props.title || props.label"
    :aria-label="props.label"
    :aria-pressed="props.pressed"
  >
    <slot><Icon v-if="props.icon" :name="props.icon" /></slot>
  </button>
</template>
