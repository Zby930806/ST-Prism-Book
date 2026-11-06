<script setup lang="ts">
/**
 * 更新窗口：有新版本时显示版本号和更新说明，「立即更新」后由酒馆拉取新版本并自动刷新页面；
 * 刷新后再用「更新完成」窗口列出这次更新的内容（读本机 README，见 update.ts 的 announceUpdated）。
 * 酒馆连不上安装来源时，改由「改用线路」窗口从另一条线路（GitHub 或码云）重新安装。
 * 挂在 App 上，打开宝书时自动弹出一次（见 update.ts 的 showUpdateDialogOnce），设置页的「更新」也打开它。
 */
import ModalShell from '@/components/ModalShell.vue';
import UpdateNotes from '@/components/UpdateNotes.vue';
import {
  closeSwitchDialog,
  closeUpdateDialog,
  closeUpdatedDialog,
  defaultSwitchTarget,
  LINE_LABEL,
  LINE_URL,
  openSwitchDialog,
  otherLine,
  performUpdate,
  spaced,
  switchLine,
  updateState,
  type UpdateLine,
} from '@/memory/update';
import { toast } from '@/st/toast';
import { computed } from 'vue';

/* 更新窗口：酒馆连不上安装来源时的说明和「改从…安装」按钮（认不出安装来源时说「安装来源」，改用码云） */
const text = computed(() => {
  const target = LINE_LABEL[defaultSwitchTarget()];
  const source = updateState.line ? LINE_LABEL[updateState.line] : '安装来源';
  return {
    switchButton: spaced(`改从${target}安装…`),
    unreachable: spaced(`酒馆服务器连不上${source}，没法直接更新。可以改从${target}重新安装最新版本：两边内容相同，聊天记录、记忆和设置都不受影响，之后检查和更新都走${target}。`),
    changelog: spaced(`在${updateState.changelogUrl.includes('gitee.com') ? '码云' : 'GitHub'}上查看更新记录`),
  };
});

/* 改用线路窗口：要改用的线路，和旧安装删除后没装上时可以换的另一条 */
const switching = computed(() => {
  const target = LINE_LABEL[updateState.switchTarget];
  return {
    title: spaced(`改用${target}线路`),
    lead: spaced(`从${target}重新安装棱镜宝书，之后检查和安装更新都走${target}：`),
    confirm: spaced(`改用${target}`),
    other: spaced(`改从${LINE_LABEL[otherLine(updateState.switchTarget)]}安装`),
  };
});

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

async function switchTo(target: UpdateLine) {
  try {
    await switchLine(target);
    toast('安装完成，正在刷新酒馆…', 'success');
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
        没能读取更新说明（可能是网络连不上），不影响更新；更新完成后会显示这次更新的内容。<a v-if="updateState.changelogUrl" :href="updateState.changelogUrl" target="_blank" rel="noopener noreferrer">{{ text.changelog }}</a>
      </p>
      <p v-if="updateState.sourceUnreachable" class="bbs-callout is-warning">{{ text.unreachable }}</p>
      <p v-else class="bbs-field-hint">由酒馆从本扩展的安装来源拉取新版本，完成后自动刷新酒馆页面。聊天记录、记忆和设置都不受影响。</p>
      <div v-if="updateState.error" class="bbs-callout is-danger" role="alert">{{ updateState.error }}</div>
    </div>
    <template #footer>
      <button class="bbs-btn" type="button" :disabled="updateState.updating" @click="closeUpdateDialog">以后再说</button>
      <button
        v-if="updateState.sourceUnreachable || updateState.offerSwitch"
        class="bbs-btn"
        :class="{ 'bbs-btn-primary': updateState.sourceUnreachable }"
        type="button"
        :disabled="updateState.updating"
        @click="openSwitchDialog()"
      >{{ text.switchButton }}</button>
      <button v-if="!updateState.sourceUnreachable" class="bbs-btn bbs-btn-primary" type="button" :disabled="updateState.updating" @click="update">
        {{ updateState.updating ? '更新中…' : '立即更新' }}
      </button>
    </template>
  </ModalShell>

  <ModalShell :open="updateState.switchDialogOpen" :title="switching.title" close-label="取消" @close="closeSwitchDialog">
    <div class="bbs-update" aria-live="polite">
      <p class="bbs-update-lead">{{ switching.lead }}</p>
      <p class="bbs-update-url">{{ LINE_URL[updateState.switchTarget] }}</p>
      <p class="bbs-field-hint">本扩展在 GitHub 和码云（国内镜像）各有一份，内容相同，每次发布同时更新。国内网络连不上 GitHub 时用码云。</p>
      <p class="bbs-field-hint">酒馆会先删除现有的安装目录，再从上面的地址下载最新版本，完成后自动刷新酒馆。聊天记录、记忆和设置都保存在酒馆里，不受影响。</p>
      <div v-if="updateState.error" class="bbs-callout is-danger" role="alert">{{ updateState.error }}</div>
    </div>
    <template #footer>
      <button
        v-if="updateState.reinstallPending"
        class="bbs-btn"
        type="button"
        :disabled="updateState.updating"
        @click="switchTo(otherLine(updateState.switchTarget))"
      >{{ switching.other }}</button>
      <button v-else class="bbs-btn" type="button" :disabled="updateState.updating" @click="closeSwitchDialog">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="updateState.updating" @click="switchTo(updateState.switchTarget)">
        {{ updateState.updating ? '安装中…' : updateState.reinstallPending ? '重新安装' : switching.confirm }}
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
.bbs-update-lead { margin: 0; font-size: 13.5px; line-height: 1.7; color: var(--bbs-ink); }
.bbs-update-url {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
