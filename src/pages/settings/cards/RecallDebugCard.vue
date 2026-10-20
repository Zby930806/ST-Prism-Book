<script setup lang="ts">
/**
 * 召回调试（提案 P2）：原「向量记忆 › 上次召回详情」移出，成为「记忆与召回」分组下的独立卡片。
 * 卡片默认收起；内容为上一次召回各阶段的中间结果（RecallDebug），只读，随召回自动刷新。
 */
import Collapsible from '@/components/Collapsible.vue';
import RecallDebug from './RecallDebug.vue';
</script>

<template>
  <Collapsible class="prism-settings-card" title="召回调试" :open="false">
    <p class="prism-card-intro">上一次生成正文时的召回过程：查询重写、检索、重排分档和最终注入的内容，用于调整「向量记忆」中的召回参数。</p>
    <RecallDebug />
  </Collapsible>
</template>
