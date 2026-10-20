<script setup lang="ts">
import { apiSettings } from '@/api/settings';
import Icon from '@/components/Icon.vue';

defineProps<{ subject: string }>();
</script>

<template>
  <aside v-if="apiSettings.summaryOnlyMode" class="bbs-callout is-warning bbs-summary-only-notice" role="status">
    <span class="bbs-summary-only-icon" aria-hidden="true"><Icon name="eye-off" /></span>
    <div class="bbs-summary-only-copy">
      <strong class="bbs-callout-title">仅记录，不注入正文</strong>
      <p>已开启「仅注入剧情摘要」：{{ subject }}照常分析和保存，但不注入正文。</p>
    </div>
  </aside>
</template>

<style scoped>
/* 外观沿用共享警告提示条（.bbs-callout.is-warning），这里只排图标与文字。 */
.bbs-summary-only-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
}

.bbs-summary-only-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  font-size: 16px;
}

.bbs-summary-only-copy {
  min-width: 0;
}

.bbs-summary-only-copy p {
  margin: 2px 0 0;
  color: var(--bbs-ink-soft);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>
