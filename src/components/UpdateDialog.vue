<script setup lang="ts">
/**
 * 更新窗口：有新版本时显示版本号和更新说明，「立即更新」后由酒馆拉取新版本并自动刷新页面。
 * 挂在 App 上，打开宝书时自动弹出一次（见 update.ts 的 showUpdateDialogOnce），设置页的「更新」也打开它。
 */
import ModalShell from '@/components/ModalShell.vue';
import { closeUpdateDialog, performUpdate, updateState } from '@/memory/update';
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
      <section v-for="note in updateState.notes" :key="note.version" class="bbs-update-note">
        <h4 class="bbs-update-version">v{{ note.version }}</h4>
        <template v-for="(line, i) in note.lines" :key="i">
          <p :class="line.bullet ? 'bbs-update-bullet' : 'bbs-update-para'">{{ line.text }}</p>
        </template>
      </section>
      <p v-if="!updateState.notes.length" class="bbs-field-hint">
        没能读取更新说明（可能是浏览器连不上 GitHub），不影响更新。<a v-if="updateState.changelogUrl" :href="updateState.changelogUrl" target="_blank" rel="noopener noreferrer">在 GitHub 上查看更新记录</a>
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
</template>

<style scoped>
.bbs-update { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.bbs-update-versions { margin: 0; font-size: 14px; font-weight: 600; color: var(--bbs-ink); }
.bbs-update-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: 10px;
}
.bbs-update-version { margin: 0 0 2px; font-size: 13px; color: var(--bbs-ink); }
.bbs-update-para,
.bbs-update-bullet {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
  overflow-wrap: anywhere;
}
.bbs-update-bullet { position: relative; padding-left: 14px; }
.bbs-update-bullet::before { content: '•'; position: absolute; left: 2px; color: var(--bbs-ink-muted); }
</style>
