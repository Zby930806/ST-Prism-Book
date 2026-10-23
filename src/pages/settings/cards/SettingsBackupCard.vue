<script setup lang="ts">
/* 设置备份：导出（已去掉密钥）与导入棱镜宝书的全部设置。收集、去密钥、合并与保存见 src/settingsBackup.ts。 */
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { applySettingsImport, describeImportPlan, downloadSettingsBackup, parseSettingsBackup, planSettingsImport, type ImportPlan } from '@/settingsBackup';
import { computed, ref, shallowRef } from 'vue';
import { TONE_CLASS, type Notice } from '../notice';

const fileInput = ref<HTMLInputElement | null>(null);
const notice = ref<Notice | null>(null);
const plan = shallowRef<ImportPlan | null>(null);
const confirmOpen = ref(false);
const importing = ref(false);
const planLines = computed(() => (plan.value ? describeImportPlan(plan.value) : []));
const planSource = computed(() => {
  const p = plan.value;
  if (!p) return '';
  const at = p.exportedAt ? new Date(p.exportedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString('zh-CN', { hour12: false }) : '';
  return ['文件导出于' + (when || '未知时间'), p.pluginVersion ? '来自棱镜宝书 ' + p.pluginVersion : ''].filter(Boolean).join('，') + '。';
});

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function exportSettings() {
  try {
    const name = downloadSettingsBackup();
    notice.value = { tone: 'ok', text: `已导出 ${name}（已去掉密钥）。` };
  } catch (e) {
    notice.value = { tone: 'error', text: '导出失败：' + errorText(e) };
  }
}

function pickFile() {
  notice.value = null;
  fileInput.value?.click();
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 允许再次选同一个文件
  if (!file) return;
  let text: string;
  try {
    text = await readFile(file);
  } catch (e) {
    notice.value = { tone: 'error', text: '导入失败：文件读不出来（' + errorText(e) + '）。请换一个文件再试。' };
    return;
  }
  const parsed = parseSettingsBackup(text);
  if (!parsed.ok) {
    notice.value = { tone: 'error', text: parsed.error };
    return;
  }
  const ext = getContext()?.extensionSettings;
  if (!ext) {
    notice.value = { tone: 'error', text: '导入失败：酒馆设置接口还没有就绪。请稍后再试。' };
    return;
  }
  const next = planSettingsImport(parsed.backup, ext);
  if (!next.hasChanges) {
    const skipped = describeImportPlan(next).filter(line => line.includes('没有导入'));
    notice.value = { tone: skipped.length ? 'warn' : 'ok', text: ['文件里的设置与本机相同，没有需要导入的内容。', ...skipped].join('') };
    return;
  }
  plan.value = next;
  confirmOpen.value = true;
}

function confirmImport() {
  const current = plan.value;
  if (!current || importing.value) return;
  importing.value = true;
  try {
    const result = applySettingsImport(current);
    const keys = current.needKeys.length ? `可能需要填写密钥：${current.needKeys.join('、')}。` : '';
    if (result.failed.length) {
      const failed = result.failed.map(f => `${f.label}（${f.error}）`).join('；');
      notice.value = { tone: 'warn', text: `${result.applied.length ? '已导入：' + result.applied.join('、') + '。' : ''}没有导入：${failed}。这些设置保持原样。${keys}` };
      toast('部分设置没有导入，原因见设置页「设置备份」。', 'warning');
    } else {
      notice.value = { tone: 'ok', text: `设置已导入：${result.applied.join('、')}。${keys}` };
      toast('设置已导入。', 'success');
    }
  } catch (e) {
    notice.value = { tone: 'error', text: '导入失败：' + errorText(e) };
  } finally {
    importing.value = false;
    confirmOpen.value = false;
    plan.value = null;
  }
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="设置备份" :open="false">
    <p class="prism-card-intro">导出或导入棱镜宝书的全部设置，包括副 API 渠道、摘要与注入、向量记忆、提示词、排除名单，以及札记、规划和世界书的设置。导出的文件不含 API 密钥；导入时，地址与本机是同一个服务器的保留本机已填写的密钥，地址换了服务器的需要重新填写。</p>

    <div class="bbs-backup-row">
      <div class="bbs-backup-text">
        <span class="bbs-field-label">导出设置</span>
        <p class="bbs-backup-desc">下载一个 .json 文件。文件名带导出日期，文件内注明已去掉密钥。</p>
      </div>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="exportSettings"><Icon name="download" />导出设置</button>
    </div>
    <div class="bbs-backup-row">
      <div class="bbs-backup-text">
        <span class="bbs-field-label">导入设置</span>
        <p class="bbs-backup-desc">选择导出的文件后，先列出会修改的内容，确认后才导入。API 渠道和排除名单只增加、不删除，这两项与柏宝绘等同源插件共用。</p>
      </div>
      <button class="bbs-btn" type="button" :disabled="importing" @click="pickFile"><Icon name="upload" />导入设置…</button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
    </div>
    <p v-if="notice" class="bbs-callout prism-inline-notice" :class="TONE_CLASS[notice.tone]" :role="notice.tone === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <ConfirmDialog
      v-model:open="confirmOpen"
      title="导入设置"
      confirm-text="导入"
      busy-text="导入中…"
      :busy="importing"
      @cancel="plan = null"
      @confirm="confirmImport"
    >
      <span class="bbs-backup-plan-source">{{ planSource }}</span>
      <span v-for="(line, i) in planLines" :key="i" class="bbs-backup-plan-line">{{ line }}</span>
    </ConfirmDialog>
  </Collapsible>
</template>

<style scoped>
.bbs-backup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-backup-row:last-of-type {
  border-bottom: 0;
}
.bbs-backup-text {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-backup-desc {
  margin: 4px 0 0;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.bbs-backup-row .bbs-btn {
  flex: 0 0 auto;
}
/* 确认框正文是一段 <p>，逐行用块级 span 排开 */
.bbs-backup-plan-source {
  display: block;
  color: var(--bbs-ink-muted);
  font-size: 12px;
}
.bbs-backup-plan-line {
  display: block;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .bbs-backup-row {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }
  .bbs-backup-row .bbs-btn {
    justify-content: center;
    width: 100%;
  }
}
</style>
