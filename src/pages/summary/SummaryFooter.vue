<script setup lang="ts">
/**
 * 摘要页页脚：开场时间、导入旧总结、旧记忆兼容说明、重建记忆——不常用的入口收在最下面。
 * 导入旧总结第一版只接收粘贴文本 + 从 #0 起的覆盖截止楼层。
 */
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalShell from '@/components/ModalShell.vue';
import { addSummary } from '@/memory/apply';
import { batchBackfill, engineState, isAiFloor, syncHiddenNow } from '@/memory/engine';
import { compatibilityState, derivedMeta, memory, recomputeDerived } from '@/memory/store';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { ref } from 'vue';
import InitialTime from './InitialTime.vue';
import { useSummaryPage } from './pageCtx';

const page = useSummaryPage();
const { editingBlocked, allowMemoryEdit, hasLeaf } = page;

/* ---- 导入旧总结 ---- */
const importHistoryOpen = ref(false);
const importHistoryText = ref('');
const importHistoryFloor = ref(0);
const importHistoryMaxFloor = ref(0);

function closeImportHistory() {
  importHistoryOpen.value = false;
}

function openImportHistory() {
  if (!allowMemoryEdit()) return;
  if (memory.summaries.some(s => s.imported)) {
    toast('当前聊天已导入过旧总结，可直接编辑，或删除后重新导入。', 'warning');
    return;
  }
  const chat = getContext()?.chat ?? [];
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) {
    toast('当前聊天还没有 AI 回复，没有可覆盖的楼层。', 'warning');
    return;
  }
  importHistoryText.value = '';
  importHistoryMaxFloor.value = lastAi;
  importHistoryFloor.value = lastAi;
  importHistoryOpen.value = true;
}

async function saveImportedHistory() {
  if (!allowMemoryEdit()) return;
  const text = importHistoryText.value.trim();
  const floor = Number(importHistoryFloor.value);
  if (!text) {
    toast('请先粘贴旧总结的内容。', 'warning');
    return;
  }
  if (!Number.isInteger(floor) || floor < 0 || floor > importHistoryMaxFloor.value) {
    toast(`截止楼层需在 #0 – #${importHistoryMaxFloor.value} 之间。`, 'warning');
    return;
  }
  const chat = getContext()?.chat ?? [];
  if (!isAiFloor(chat[floor])) {
    toast('截止楼层需选择一条 AI 回复，以免隐藏尚未回复的用户消息。', 'warning');
    return;
  }
  if (memory.summaries.some(s => s.imported)) {
    toast('当前聊天已有导入的旧总结。', 'warning');
    return;
  }
  // 不静默覆盖棱镜宝书已经做过的逐楼摘要：重叠时两套叙事会同时进入上下文，应由用户先处理边界。
  const overlap = derivedMeta.leaves.some(l => !l.stale && l.msgIndex <= floor);
  if (overlap) {
    toast('该范围内已有棱镜宝书的摘要。请将截止楼层前移，或先删除重叠的摘要。', 'warning');
    return;
  }

  const existingTimes = [
    ...memory.summaries.map(s => s.createdAt),
    ...derivedMeta.leaves.filter(l => !l.stale).map(l => l.createdAt),
  ].filter(Number.isFinite);
  const createdAt = (existingTimes.length ? Math.min(...existingTimes) : Date.now()) - 1;
  addSummary({
    text,
    level: 2,
    auto: false,
    childIds: [],
    imported: true,
    importedFloorStart: 0,
    importedFloorEnd: floor,
    createdAt,
  });
  closeImportHistory();
  recomputeDerived();
  await syncHiddenNow(true);
  toast(`已导入旧总结，覆盖 #0 – #${floor}。`, 'success');
}

/* ---- 重建记忆 ---- */
const rebuildConfirmOpen = ref(false);
function openRebuildConfirm() {
  if (!allowMemoryEdit() || engineState.running) return;
  rebuildConfirmOpen.value = true;
}
function rebuildChatMemory() {
  if (!allowMemoryEdit()) return;
  rebuildConfirmOpen.value = false;
  if (!engineState.running) void batchBackfill({ regenerate: true });
}

page.onCloseEditors(() => {
  closeImportHistory();
  rebuildConfirmOpen.value = false;
});
page.onReset(closeImportHistory);
</script>

<template>
  <footer class="bbs-summary-footer" aria-label="更多">
    <InitialTime />
    <details class="bbs-disclosure bbs-import-entry">
      <summary>导入旧总结 <span class="bbs-disclosure-meta">使用棱镜宝书之前写的剧情总结</span></summary>
      <p class="bbs-field-hint">把世界书等处的旧剧情总结作为一条总结导入，只导入文字，不生成物品、计划或角色状态。</p>
      <button class="bbs-btn bbs-btn-sm" type="button" :disabled="engineState.running || editingBlocked" @click="openImportHistory"><Icon name="download" />导入旧总结…</button>
    </details>
    <details v-if="compatibilityState.mode === 'ready'" class="bbs-disclosure bbs-compat-ready">
      <summary>旧记忆兼容 <span class="bbs-disclosure-meta">正常，不需要重建</span></summary>
      <p class="bbs-field-hint">当前聊天的旧摘要和 L1/L2 总结按原格式读取，升级后无需重新摘要或重建。</p>
      <p class="bbs-field-hint">上次检查：逐楼摘要 {{ compatibilityState.leaves }} 条，总结 {{ compatibilityState.summaries }} 条（检查时的数量，以上方列表为准）。</p>
    </details>
    <details v-if="hasLeaf" class="bbs-disclosure bbs-maintenance">
      <summary>重建记忆 <span class="bbs-disclosure-meta">按楼层重新生成全部摘要</span></summary>
      <div class="bbs-callout is-danger bbs-maintenance-body">
        <p>重建会按楼层顺序重新请求 AI，覆盖现有摘要及手动修改的内容。升级插件不需要重建。重建前请先导出聊天备份。</p>
        <button class="bbs-btn bbs-btn-danger" type="button" :disabled="engineState.running || editingBlocked" @click="openRebuildConfirm">重建本聊天记忆…</button>
      </div>
    </details>
  </footer>

  <ConfirmDialog v-if="!editingBlocked" v-model:open="rebuildConfirmOpen" title="重建本聊天记忆" tone="danger" confirmText="按楼层顺序重建" @confirm="rebuildChatMemory">
    升级插件不需要重建：旧摘要和总结能直接读取，或转换后继续用。重建会重新请求 AI，覆盖手动改过的摘要和相关状态。
    将按顺序重新摘要当前聊天的所有 AI 楼层（番外、导入的旧总结和继承的数据除外），每层请求一次，失败可能重试，费用可能较高。请先备份聊天，完成前请勿切换聊天或修改正文。
    每层成功后替换这层原来的摘要和状态（包括手动修改的内容），相关的上层总结会作废并按设置重新生成。失败或取消就停下：已完成的用新结果，没完成的保留旧结果，剧情原文不会被删。继续吗？
  </ConfirmDialog>

  <!-- ===== 导入旧总结弹窗 ===== -->
  <ModalShell v-if="!editingBlocked" :open="importHistoryOpen" title="导入旧总结" @close="closeImportHistory">
    <p class="bbs-field-hint bbs-import-note">
      粘贴使用棱镜宝书之前写在世界书等处的剧情总结。只导入文字，不生成物品、计划或角色状态。
    </p>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">旧总结内容</span>
      <textarea
        v-model="importHistoryText"
        class="bbs-input bbs-modal-textarea"
        rows="10"
        placeholder="粘贴按时间顺序整理好的旧剧情总结…"
      ></textarea>
    </label>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">覆盖到哪一层（含）</span>
      <input
        v-model.number="importHistoryFloor"
        class="bbs-input"
        type="number"
        min="0"
        :max="importHistoryMaxFloor"
      />
      <span class="bbs-field-hint">导入的内容代表 #0 – #{{ importHistoryFloor }}，这些楼层不会再补摘。当前最后一条 AI 回复是 #{{ importHistoryMaxFloor }}。</span>
    </label>
    <p class="bbs-field-hint bbs-import-warning">
      导入后请关闭世界书中原有的总结条目，避免重复注入。导入不会修改世界书。
    </p>
    <template #footer>
      <button class="bbs-btn" type="button" @click="closeImportHistory">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importHistoryText.trim()" @click="saveImportedHistory">导入</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 页脚：开场时间、导入、兼容说明、重建这些不常用的入口收在最下面。 */
.bbs-summary-footer { margin-top:32px; border-top:1px solid var(--bbs-line); }
.bbs-summary-footer > :deep(details) { border-bottom:1px solid var(--bbs-line); }
.bbs-summary-footer > :deep(details > summary) { font-size:13px; }
.bbs-summary-footer > :deep(details[open]) { padding-bottom:14px; }
.bbs-summary-footer summary:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:3px; }
.bbs-import-entry .bbs-btn { margin-top:4px; }
.bbs-maintenance-body { margin:4px 0 0; }
.bbs-maintenance-body .bbs-btn { margin-top:6px; }

/* 导入旧总结弹窗 */
.bbs-import-note,
.bbs-import-warning {
  margin-bottom: 14px;
}
.bbs-import-warning {
  color: var(--bbs-warning);
}
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}
</style>
