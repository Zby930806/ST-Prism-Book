<script setup lang="ts">
/**
 * 弹窗外壳：标题栏（标题 + 关闭键）、主体、底部操作。接口说明见 polish-20261009/ui-components-api.md。
 * 基于 ModalMask：Teleport 到 modalHost、焦点管理、Esc 与点遮罩关闭；open 为 false 时插槽不求值。
 * 其他属性（class、data-*）落在 .bbs-modal 对话框元素上；外框尺寸用 wide，其余外框样式在 base.css。
 */
import IconButton from '@/components/IconButton.vue';
import ModalMask from '@/components/ModalMask.vue';

defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{
  open: boolean;
  title: string;
  /** 宽版：最大 680px；默认最大 520px */
  wide?: boolean;
  /** 叠在其他弹窗之上 */
  topLayer?: boolean;
  /** 关闭键的读屏名称 */
  closeLabel?: string;
}>(), {
  wide: false,
  topLayer: false,
  closeLabel: '关闭',
});
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <ModalMask :open="open" :top-layer="topLayer" @close="emit('close')">
    <div class="bbs-modal" :class="{ 'bbs-modal-wide': wide }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" v-bind="$attrs">
      <header class="bbs-modal-head">
        <span class="bbs-modal-title">{{ title }}</span>
        <span v-if="$slots.head" class="bbs-modal-head-extra"><slot name="head" /></span>
        <IconButton :label="closeLabel" icon="close" @click="emit('close')" />
      </header>
      <slot />
      <footer v-if="$slots.footer" class="bbs-modal-foot"><slot name="footer" /></footer>
    </div>
  </ModalMask>
</template>
