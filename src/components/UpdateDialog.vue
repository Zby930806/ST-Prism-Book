<script setup lang="ts">
/**
 * 更新窗口：有新版本时显示版本号和更新说明，「立即更新」后由酒馆拉取新版本并自动刷新页面；
 * 刷新后再用「更新完成」窗口列出这次更新的内容（读本机 README，见 update.ts 的 announceUpdated）。
 * 挂在 App 上，打开宝书时自动弹出一次（见 update.ts 的 showUpdateDialogOnce），设置页的「更新」也打开它。
 */
import ModalShell from '@/components/ModalShell.vue';
import UpdateNotes from '@/components/UpdateNotes.vue';
import { closeUpdateDialog, closeUpdatedDialog, performUpdate, updateState } from '@/memory/update';
import { toast } from '@/st/toast';

async function update() {
  try {
    const result = await performUpdate();
    if (result === 'updated') toast('更新完成，正在刷新酒馆…', 'success');
    else {
      toast('已经是最新版本。', 'success');
      closeUpdateDialog();
    }
  } catch {
    /* 失败原因已写进 updateState.error，显示在窗口里 */
  }
}
</script>

<template>
  <ModalShell :open="updateState.dialogOpen" title="棱镜宝书有新版本" close-label="以后再说" @close="closeUpdateDialog">
    <div class="bbs-update" aria-live="polite">
      <p class="bbs-update-versions">
        {{ updateState.latest ? `当前 v${updateState.current} → 最新 v${updateState.latest}` : `当前 v${updateState.current}，安装来源有新版本。` }}
      </p>
      <UpdateNotes :notes="updateState.notes" />
      <p v-if="updateState.notesLoading && !updateState.notes.length" class="bbs-field-hint">正在读取更新说明…</p>
      <p v-else-if="!updateState.notes.length" class="bbs-field-hint">
        没能读取更新说明（可能是网络连不上），不影响更新；更新完成后会显示这次更新的内容。<a v-if="updateState.changelogUrl" :href="updateState.changelogUrl" target="_blank" rel="noopener noreferrer">在 GitHub 上查看更新记录</a>
      </p>
      <p class="bbs-field-hint">由酒馆从本扩展的安装来源拉取新版本，完成后自动刷新酒馆页面。聊天记录、记忆和设置都不受影响。</p>
      <div v-if="updateState.error" class="bbs-callout is-danger" role="alert">{{ updateState.error }}</div>
    </div>
    <template #footer>
      <button class="bbs-btn" type="button" :disabled="updateState.updating" @click="closeUpdateDialog">以后再说</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="updateState.updating" @click="update">
        {{ updateState.updating ? '更新中…' : '立即更新' }}
      </button>
    </template>
  </ModalShell>

  <ModalShell :open="updateState.updatedDialogOpen" :title="`棱镜宝书已更新到 v${updateState.current}`" close-label="知道了" @close="closeUpdatedDialog">
    <div class="bbs-update">
      <p class="bbs-update-versions">从 v{{ updateState.updatedFrom }} 更新到 v{{ updateState.current }}，这次更新的内容：</p>
      <UpdateNotes :notes="updateState.updatedNotes" />
    </div>
    <template #footer>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="closeUpdatedDialog">知道了</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.bbs-update { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.bbs-update-versions { margin: 0; font-size: 14px; font-weight: 600; color: var(--bbs-ink); }
</style>
