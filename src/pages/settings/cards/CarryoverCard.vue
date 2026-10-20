<script setup lang="ts">
/* 带数据创建新对话：打包当前聊天的近期全文、历史摘要和当前状态，带入新建的对话。 */
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { computeCarryoverPlan, createNewChatWithCarryover, type CarryoverPlan } from '@/memory/carryover';
import { computed, ref } from 'vue';
import { readableError } from '../notice';

const carrying = ref(false);
const carryMsg = ref('');
const carryConfirmOpen = ref(false);
// 携带计划:展开面板时实时算(纯读 chat,不缓存,避免切聊天后过期)
const carryPlan = computed<CarryoverPlan>(() => computeCarryoverPlan());
async function runCarryover() {
  carryConfirmOpen.value = false;
  carrying.value = true;
  carryMsg.value = '';
  try {
    const ok = await createNewChatWithCarryover();
    carryMsg.value = ok ? '已创建新对话。' : '未能创建新对话，原因见弹出的提示。';
  } catch (e) {
    carryMsg.value = `创建失败：${readableError(e, '请稍后重试')}`;
  } finally {
    carrying.value = false;
  }
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="带数据创建新对话" :open="false">
    <p class="bbs-field-hint">将当前聊天最近的全文、合并后的历史摘要和当前状态（时间地点、场景、物品、角色、计划、信息差、变量）打包，带入新建的对话。新对话通过一条「种子摘要」还原状态，旧剧情以摘要形式保留；启用向量记忆时，旧聊天会保存一份快照，新对话也可召回其中的内容（多次接续时累加，分支也会继承）。</p>
    <div v-if="carryPlan" class="bbs-field-hint">
      将带入：AI 回复 {{ carryPlan.aiCount }} 条，实际消息 {{ carryPlan.carryCount }} 条；旧剧情摘要：{{ carryPlan.recapLen > 0 ? '有' : '无' }}。
    </div>
    <button
      class="bbs-btn bbs-btn-sm bbs-btn-primary"
      type="button"
      :disabled="carrying || !carryPlan?.hasData"
      @click="carryConfirmOpen = true"
    >
      {{ carrying ? '创建中…' : '带数据创建新对话' }}
    </button>
    <p v-if="carryMsg" class="bbs-field-hint">{{ carryMsg }}</p>

    <ConfirmDialog
      v-model:open="carryConfirmOpen"
      title="带数据创建新对话"
      confirm-text="创建并切入"
      @confirm="runCarryover"
    >
      基于当前聊天新建一个对话，带入记忆并切换过去。是否继续？
    </ConfirmDialog>
  </Collapsible>
</template>
