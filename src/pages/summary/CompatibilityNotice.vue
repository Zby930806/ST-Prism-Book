<script setup lang="ts">
/** 旧记忆兼容提示：需要转换时给出说明和「备份并转换」，只读保护时列出原因；转换前另有确认框。 */
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { engineState } from '@/memory/engine';
import { compatibilityState } from '@/memory/store';
import { useSummaryPage } from './pageCtx';

const page = useSummaryPage();
const { conversionBusy } = page;
const { convertConfirmOpen, conversionError, openConversionConfirm, confirmConversion } = page.conversion;
</script>

<template>
  <aside v-if="compatibilityState.mode !== 'ready'" class="bbs-callout is-warning bbs-compatibility" aria-label="旧记忆兼容状态" aria-live="polite">
    <template v-if="compatibilityState.mode === 'convert'">
      <strong class="bbs-callout-title">旧记忆需要转换</strong>
      <p>当前聊天使用旧版存储格式。转换只改变存储结构，不请求 AI，也不改动摘要内容，转换前自动备份。</p>
      <p class="bbs-compat-note">上次检查：待转换 {{ compatibilityState.conversion.length }} 条，逐楼摘要 {{ compatibilityState.leaves }} 条，总结 {{ compatibilityState.summaries }} 条。转换前请先导出聊天备份，期间不要补摘、重建或导入。</p>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="conversionBusy || engineState.running" @click="openConversionConfirm">{{ conversionBusy ? '正在转换…' : '备份并转换…' }}</button>
      <p v-if="engineState.running" class="bbs-compat-note">当前的摘要任务结束后才能转换。</p>
    </template>
    <template v-else>
      <strong class="bbs-callout-title">旧记忆处于只读保护</strong>
      <p>无法确认旧记忆能否安全写入，补摘、重建、总结、导入和编辑均已暂停。原数据保留，未被当作空记忆覆盖。</p>
      <ul v-if="compatibilityState.issues.length">
        <li v-for="(issue, index) in compatibilityState.issues" :key="index">{{ issue }}</li>
      </ul>
      <p v-else>兼容检查尚未完成。</p>
      <p class="bbs-compat-note">建议先用酒馆的导出聊天功能备份，再对照上面的原因检查。不要用重建或导入来解除保护。</p>
    </template>
    <p v-if="conversionBusy" role="status">转换和保存尚未完成，请勿重复提交或切换聊天；关闭确认窗口不会中断保存。</p>
    <p v-if="conversionError" class="bbs-compatibility-error" role="alert">转换没有成功：{{ conversionError }} 请先导出聊天检查保存结果，不要反复转换或重建。</p>
  </aside>
  <ConfirmDialog
    v-model:open="convertConfirmOpen"
    title="转换旧记忆"
    confirm-text="备份并转换"
    :busy="conversionBusy || engineState.running"
    busy-text="请等当前操作完成…"
    @confirm="confirmConversion"
  >
    只转换当前聊天的旧存储格式：不请求 AI，不改写摘要内容，摘要和各层总结都会保留，旧记录另存一份备份。
    请先另外导出聊天备份。转换要保存聊天和元数据，保存可能失败；如果提示失败，请导出聊天检查实际结果，不要直接重试或重建。保存期间不要切换聊天。继续吗？
  </ConfirmDialog>
</template>

<style scoped>
/* 兼容警告：沿用共享提示条，只补间距。 */
.bbs-compatibility ul { margin:6px 0; padding-left:20px; }
.bbs-compatibility .bbs-btn { margin-top:8px; }
.bbs-compat-note { font-size:12.5px; color:var(--bbs-ink-soft); }
.bbs-compatibility-error { color:var(--bbs-danger); }
</style>
