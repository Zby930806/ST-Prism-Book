<script setup lang="ts">
/**
 * 全部重新摘要的确认弹窗：新开一次时说明范围、请求次数、保留和替换什么，可选起始楼层；
 * 有未完成的记录时先问继续还是重新开始。状态与动作在 pageCtx 的 rebuild 一组。
 */
import ModalShell from '@/components/ModalShell.vue';
import { computed } from 'vue';
import { useSummaryPage } from './pageCtx';

const page = useSummaryPage();
const { editingBlocked } = page;
const { rebuildOpen, rebuildStep, rebuildFromInput, rebuildHasHorae, rebuildProgressView, rebuildAll, rebuildFloors, chooseRebuildRestart, runRebuild, resumeRebuild } = page.rebuild;

const unfinished = computed(() => {
  const p = rebuildProgressView.value;
  return p && p.next !== null ? p : null;
});
const resuming = computed(() => rebuildStep.value === 'resume' && !!unfinished.value);
const first = computed(() => rebuildAll.value[0]);
const last = computed(() => rebuildAll.value[rebuildAll.value.length - 1]);
const start = computed(() => rebuildFloors.value[0]);
// 填的楼层不是可以重新摘要的 AI 回复时，从它之后的第一个开始；之后没有就不能开始
const startNote = computed(() => {
  const input = rebuildFromInput.value;
  if (input === '' || !Number.isFinite(input)) return '';
  if (!rebuildFloors.value.length) return `#${input} 及之后没有可以重新摘要的楼层。`;
  return start.value !== input ? `#${input} 不是可以重新摘要的 AI 回复，从之后的 #${start.value} 开始。` : '';
});
const remaining = computed(() => (unfinished.value ? unfinished.value.total - unfinished.value.done : 0));
// 范围内还没有摘要的楼层一并摘要，计入请求次数
const unsummarized = computed(() => {
  const pending = new Set(page.pendingFloors.value);
  return rebuildFloors.value.filter(f => pending.has(f)).length;
});
</script>

<template>
  <ModalShell v-if="!editingBlocked" :open="rebuildOpen" title="全部重新摘要" class="bbs-rebuild-modal" @close="rebuildOpen = false">
    <template v-if="resuming && unfinished">
      <p class="bbs-field-hint bbs-rebuild-lead">上次的全部重新摘要没有完成：已完成 {{ unfinished.done }}/{{ unfinished.total }} 层，停在 #{{ unfinished.next }}。</p>
      <p class="bbs-field-hint">继续：只处理还没有重新摘要的 {{ remaining }} 层，每层请求一次 AI，共 {{ remaining }} 次摘要请求；失败重试和合并总结另外产生请求。</p>
      <p class="bbs-field-hint">重新开始：放弃上次的进度，重新选择起始楼层，范围内的楼层都重新处理。</p>
    </template>
    <template v-else>
      <p class="bbs-field-hint bbs-rebuild-lead" role="status">
        <template v-if="rebuildFloors.length">按楼层顺序重新摘要 #{{ start }}–#{{ last }} 的 {{ rebuildFloors.length }} 层 AI 回复<template v-if="unsummarized">（其中 {{ unsummarized }} 层还没有摘要）</template>，每层请求一次 AI，共 {{ rebuildFloors.length }} 次摘要请求；失败重试和合并总结另外产生请求，费用可能较高。</template>
        <template v-else>没有可以重新摘要的楼层。</template>
      </p>
      <label v-if="rebuildAll.length" class="bbs-modal-field">
        <span class="bbs-modal-label">从第几楼开始</span>
        <input v-model.number="rebuildFromInput" class="bbs-input" type="number" :min="first" :max="last" step="1" :placeholder="first === undefined ? '' : String(first)" />
        <span class="bbs-field-hint">填写 AI 回复的楼层号，留空从 #{{ first }} 开始；之前的楼层保留现有摘要。</span>
        <span v-if="startNote" class="bbs-field-hint bbs-rebuild-warning" role="status">{{ startNote }}</span>
      </label>
      <p v-if="unfinished" class="bbs-field-hint bbs-rebuild-warning">开始后放弃上次未完成的进度（已完成 {{ unfinished.done }}/{{ unfinished.total }} 层）。</p>
      <p class="bbs-field-hint">每层完成后替换这层原来的摘要和模型记录的状态。在各页面新增、修改、删除的物品、角色、地点、计划悬念等单独保存，完成后仍然保留；1.4.0 之前做的这类修改记在当时的摘要里，会随之替换。直接改写过的摘要正文、已了结计划悬念的文字和各条目的记录时间按新结果替换。<template v-if="rebuildHasHorae">从 Horae 迁移来的物品、计划等状态按正文重新推算后替换。</template></p>
      <p class="bbs-field-hint">包含被替换摘要的旧总结作废；处理过程中，覆盖楼层都已重新摘要的摘要按设置逐步合并为总结，全部完成后再把能合并的都合并完。番外楼、导入的旧总结覆盖的楼层、带数据新建对话继承的数据和没有故事正文的楼层不处理，保留原样。</p>
      <p class="bbs-field-hint">可以随时取消，当前一层完成后停止；处理期间修改正文或切换聊天也会停止。停止后（包括失败和刷新页面），可在摘要页从停下的楼层继续：已完成的楼层用新结果，其余保留原摘要，剧情原文不会被删除。</p>
      <p class="bbs-field-hint bbs-rebuild-warning">升级插件不需要全部重新摘要，旧摘要和总结可以直接读取。开始前请先用酒馆的「管理聊天文件」导出聊天备份。</p>
    </template>
    <template #footer>
      <button class="bbs-btn" type="button" @click="rebuildOpen = false">取消</button>
      <template v-if="resuming">
        <button class="bbs-btn" type="button" @click="chooseRebuildRestart">重新开始…</button>
        <button class="bbs-btn bbs-btn-primary" type="button" @click="resumeRebuild">继续</button>
      </template>
      <button v-else class="bbs-btn bbs-btn-danger" type="button" :disabled="!rebuildFloors.length" @click="runRebuild">开始全部重新摘要</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 全部重新摘要弹窗：首段写范围和请求次数，说明逐段排列，警示语用警告色 */
.bbs-rebuild-modal .bbs-field-hint {
  margin: 0 0 10px;
}
.bbs-rebuild-lead {
  color: var(--bbs-ink);
}
.bbs-rebuild-modal .bbs-modal-field {
  margin-bottom: 12px;
}
.bbs-rebuild-modal .bbs-modal-field .bbs-field-hint {
  margin: 4px 0 0;
}
.bbs-rebuild-warning {
  color: var(--bbs-warning);
}
</style>
