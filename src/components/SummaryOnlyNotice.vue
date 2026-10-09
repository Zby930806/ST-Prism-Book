<script setup lang="ts">
import { apiSettings } from '@/api/settings';
import Icon from '@/components/Icon.vue';

defineProps<{ subject: string }>();
</script>

<template>
  <aside v-if="apiSettings.summaryOnlyMode" class="bbs-summary-only-notice" role="status">
    <span class="bbs-summary-only-icon"><Icon name="eye-off" /></span>
    <div class="bbs-summary-only-copy">
      <strong>只记录，不交给正文模型</strong>
      <p>设置里打开了「仅注入剧情摘要」：{{ subject }}照常分析和保存，但不会交给正文模型。</p>
    </div>
  </aside>
</template>

<style scoped>
.bbs-summary-only-notice {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin-top: 12px;
  padding: 11px 13px;
  border: 2px solid var(--bbs-warning);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-warning-soft);
  box-shadow: inset 4px 0 0 var(--bbs-warning);
}

.bbs-summary-only-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border: 1px solid var(--bbs-warning);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-warning);
  font-size: 17px;
}

.bbs-summary-only-copy {
  min-width: 0;
}

.bbs-summary-only-copy strong {
  display: block;
  color: var(--bbs-warning);
  font-size: 13.5px;
  line-height: 1.35;
}

.bbs-summary-only-copy p {
  margin: 3px 0 0;
  color: var(--bbs-ink-soft);
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 480px) {
  .bbs-summary-only-notice {
    gap: 9px;
    padding: 10px;
  }

  .bbs-summary-only-icon {
    width: 28px;
    height: 28px;
  }
}
</style>
