<script setup lang="ts">
/**
 * 「角色重新建档」开始或继续前的确认：两步各要多少次请求、费用提醒、所用的 API、不改动的内容。
 * 有未完成的记录时提供「继续」和「从头开始」。是否开始由角色页处理。
 */
import ModalShell from '@/components/ModalShell.vue';
import type { RefileEstimate } from '@/memory/npcRefile';

defineProps<{
  open: boolean;
  estimate: RefileEstimate | null;
  /** 有未完成的记录:按剩余部分估计,按钮为「继续」与「从头开始」 */
  resuming: boolean;
  /** 「摘要」所用的 API */
  senderLabel: string;
}>();
const emit = defineEmits<{ (e: 'start', restart: boolean): void; (e: 'close'): void }>();
</script>

<template>
  <ModalShell :open="open" title="角色重新建档" @close="emit('close')">
    <div v-if="estimate" class="bbs-refile-start">
      <p class="bbs-field-hint">按原文补齐名册里漏记的角色，并按原文重新整理全部角色的档案。结果先列出审核，勾选后才写入。</p>
      <dl class="bbs-refile-plan">
        <div class="bbs-refile-plan-row">
          <dt>第一步 补齐漏记</dt>
          <dd>{{ estimate.chunks ? `分 ${estimate.chunks} 批读原文（${estimate.floors} 条消息），每批一次请求` : '已完成' }}</dd>
        </div>
        <div class="bbs-refile-plan-row">
          <dt>第二步 重做档案</dt>
          <dd>{{ estimate.characters ? `${estimate.characters} 个角色，约 ${estimate.archiveBatches} 次请求` : estimate.chunks ? '名册中还没有角色' : '已完成' }}{{ estimate.chunks ? '；第一步新找到的角色另计' : '' }}</dd>
        </div>
      </dl>
      <p class="bbs-callout is-warning">请求次数较多，费用较高。使用「摘要」所用的 API：{{ senderLabel }}。开始前请先用酒馆的「管理聊天文件」导出聊天备份。</p>
      <p class="bbs-field-hint">只整理身份、性别、年龄、外貌和性格；位置、随行、好感、伤情、着装、关系、人际关系和主角档案不改动。可以随时取消，之后从停下的位置继续。{{ resuming ? '上次的进度和已找到的结果仍在，选择「从头开始」会清除它们。' : '' }}</p>
    </div>
    <template #footer>
      <button class="bbs-btn" type="button" @click="emit('close')">取消</button>
      <button v-if="resuming" class="bbs-btn" type="button" @click="emit('start', true)">从头开始</button>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="emit('start', false)">{{ resuming ? '继续' : '开始' }}</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.bbs-refile-start { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bbs-refile-start > p { margin: 0; }
.bbs-refile-plan { display: flex; flex-direction: column; gap: 8px; margin: 0; }
.bbs-refile-plan-row { display: grid; grid-template-columns: 7.5em minmax(0, 1fr); gap: 10px; align-items: baseline; }
.bbs-refile-plan-row dt { font-size: 12px; font-weight: 600; color: var(--bbs-ink-soft); }
.bbs-refile-plan-row dd { margin: 0; font-size: 13px; line-height: 1.7; color: var(--bbs-ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .bbs-refile-plan-row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
</style>
