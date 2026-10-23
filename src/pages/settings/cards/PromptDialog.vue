<script setup lang="ts">
/**
 * 提示词编辑弹窗：草稿 promptDraft，点「完成」才写回 apiSettings，取消则丢弃。
 * 自定义不会跟着内置更新：内置改过时提醒，并能列出差异。由卡片调用 open(meta) 打开。
 */
import Icon from '@/components/Icon.vue';
import ModalShell from '@/components/ModalShell.vue';
import { apiSettings } from '@/api/settings';
import { computed, nextTick, ref } from 'vue';
import { diffHunks, diffLines, diffStats, type DiffRow } from '../promptDiff';
import { isCustom, promptSync, taskContextModeAfterSave, type PromptMeta, type PromptSync } from '../promptMeta';

// 正在编辑的提示词;draft 是草稿,点「完成」才写回 apiSettings(取消则丢弃)。
const editingPrompt = ref<PromptMeta | null>(null);
const promptDraft = ref('');
const promptArea = ref<HTMLTextAreaElement | null>(null);
// 草稿是照着哪一版内置改的:打开时取已记录的基准;原本没自定义、从内置开始改的,就是现在的内置。
const promptDraftBase = ref<string | null>(null);
const promptDiffOpen = ref(false);

const editorSync = computed<PromptSync>(() => (editingPrompt.value ? promptSync(editingPrompt.value) : 'default'));
/** 差异:内置已更新时看「改的那一版内置 → 现在的内置」;没记录基准时看「你的版本 → 现在的内置」。 */
const promptDiff = computed<{ title: string; rows: DiffRow[] } | null>(() => {
  const meta = editingPrompt.value;
  if (!meta || !promptDiffOpen.value) return null;
  const base = apiSettings.promptBases[meta.key];
  const fromBase = editorSync.value === 'outdated' && !!base;
  const lines = fromBase ? diffLines(base!, meta.builtin) : diffLines(promptDraft.value, meta.builtin);
  const { added, removed } = diffStats(lines);
  return {
    title: fromBase
      ? `内置版本自修改依据的版本以来：增加 ${added} 行，删除 ${removed} 行`
      : `当前自定义与内置版本对比：内置多 ${added} 行，少 ${removed} 行（含自定义改动）`,
    rows: diffHunks(lines, 1),
  };
});
// 「已同步，不再提醒」:把基准换成现在的内置,只影响提醒,不改提示词正文
function markPromptSynced() {
  const meta = editingPrompt.value;
  if (!meta) return;
  apiSettings.promptBases[meta.key] = meta.builtin;
  promptDraftBase.value = meta.builtin;
  promptDiffOpen.value = false;
}

function open(meta: PromptMeta) {
  editingPrompt.value = meta;
  // 已自定义→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  promptDraft.value = meta.key === 'jailbreak' && apiSettings.taskContextMode === 'custom'
    ? apiSettings.prompts[meta.key] : apiSettings.prompts[meta.key].trim() || meta.builtin;
  promptDraftBase.value = isCustom(meta.key) ? (apiSettings.promptBases[meta.key] ?? null) : meta.builtin;
  promptDiffOpen.value = false;
}
function closePrompt() {
  editingPrompt.value = null;
  promptDraft.value = '';
  promptDraftBase.value = null;
  promptDiffOpen.value = false;
}
function savePrompt() {
  const meta = editingPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「默认」
  const v = promptDraft.value.trim();
  const sameAsBuiltin = v === meta.builtin.trim();
  apiSettings.prompts[meta.key] = sameAsBuiltin ? '' : promptDraft.value;
  // 任务说明:原来禁用的保持禁用,只保存内容;其余按内容切换内置/自定义
  if (meta.key === 'jailbreak') apiSettings.taskContextMode = taskContextModeAfterSave(apiSettings.taskContextMode, sameAsBuiltin);
  // 记下这份自定义照着哪一版内置改的;回到内置就不用记了。旧版本里改的、没有基准的保持不记。
  if (sameAsBuiltin) delete apiSettings.promptBases[meta.key];
  else if (promptDraftBase.value) apiSettings.promptBases[meta.key] = promptDraftBase.value;
  closePrompt();
}
// 「恢复默认」:把草稿重置回内置模板(保存后即回落内置)
function resetPrompt() {
  if (!editingPrompt.value) return;
  promptDraft.value = editingPrompt.value.builtin;
  promptDraftBase.value = editingPrompt.value.builtin;
}

// 点宏标签 → 插入到文本框光标处(无焦点则追加到末尾)
function insertMacro(token: string) {
  const el = promptArea.value;
  if (!el) {
    promptDraft.value += token;
    return;
  }
  const start = el.selectionStart ?? promptDraft.value.length;
  const end = el.selectionEnd ?? start;
  promptDraft.value = promptDraft.value.slice(0, start) + token + promptDraft.value.slice(end);
  // 等 v-model 回填后把光标移到插入内容之后
  void nextTick(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

defineExpose({ open });
</script>

<template>
  <ModalShell
    :open="!!editingPrompt"
    :title="editingPrompt ? '编辑' + editingPrompt.label : ''"
    wide
    close-label="关闭提示词编辑窗口"
    class="prism-settings-modal"
    @close="closePrompt"
  >
    <template v-if="editingPrompt">

      <p class="bbs-modal-label">{{ editingPrompt.hint }}</p>
      <p class="prism-editor-note">修改后点击「完成」保存；「恢复默认」后同样需点击「完成」生效，点击「取消」放弃修改。</p>
      <p v-if="editingPrompt.key === 'jailbreak' && apiSettings.taskContextMode === 'disabled'" class="bbs-callout is-warning" role="status">
        任务说明当前已禁用：点击「完成」只保存内容，不会启用。需要发送时，在「自定义提示词 → 任务说明模式」中切换。
      </p>

      <!-- 自定义不会跟着内置更新:内置改过就提醒,并能列出差异 -->
      <div v-if="editorSync === 'outdated' || editorSync === 'unknown'" class="bbs-callout is-warning prism-prompt-sync" role="status">
        <p class="prism-prompt-sync-text">
          {{ editorSync === 'outdated'
            ? '自定义后内置版本已更新，自定义内容不会自动同步。可查看内置版本的改动，按需修改下方文本。'
            : '该自定义内容修改于旧版本，未记录当时依据的内置版本。可与当前内置版本对比，判断是否需要同步。' }}
        </p>
        <div class="prism-prompt-sync-actions">
          <button class="bbs-btn bbs-btn-sm" type="button" :aria-expanded="promptDiffOpen" @click="promptDiffOpen = !promptDiffOpen">
            {{ promptDiffOpen ? '收起差异' : editorSync === 'outdated' ? '查看内置改动' : '与当前内置对比' }}
          </button>
          <button class="bbs-btn bbs-btn-sm" type="button" @click="markPromptSynced">已同步，不再提醒</button>
        </div>
      </div>
      <div v-if="promptDiff" class="prism-diff" role="region" aria-label="提示词差异">
        <p class="prism-diff-title">{{ promptDiff.title }}</p>
        <div class="prism-diff-body">
          <template v-for="(row, i) in promptDiff.rows" :key="i">
            <p v-if="row.type === 'skip'" class="prism-diff-skip">… 中间相同的 {{ row.count }} 行 …</p>
            <p v-else class="prism-diff-line" :class="`is-${row.type}`"><span class="prism-diff-mark" aria-hidden="true">{{ row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ' }}</span>{{ row.text || ' ' }}</p>
          </template>
        </div>
        <p class="prism-diff-hint">「+」表示当前内置版本有、对比版本没有的行，「−」相反。同步时将所需改动写入下方文本，点击「完成」保存，再点击「已同步，不再提醒」。</p>
      </div>

      <!-- 可用宏:点一下插入到光标处 -->
      <div class="bbs-macro-bar">
        <span class="bbs-macro-tip">点击插入宏：</span>
        <button
          v-for="mac in editingPrompt.macros"
          :key="mac.token"
          class="bbs-macro"
          type="button"
          :title="mac.desc"
          @click="insertMacro(mac.token)"
        >
          {{ mac.token }}
        </button>
      </div>

      <textarea
        ref="promptArea"
        v-model="promptDraft"
        class="bbs-input bbs-prompt-area"
        :aria-label="editingPrompt.label + '正文'"
        spellcheck="false"
        rows="16"
      ></textarea>

    </template>

    <template #footer>
      <button class="bbs-btn bbs-btn-danger" type="button" @click="resetPrompt">
        <Icon name="refresh" /> 恢复默认
      </button>
      <span class="bbs-modal-foot-spacer"></span>
      <button class="bbs-btn" type="button" @click="closePrompt">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="savePrompt">完成</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* —— 提示词过期提醒与差异 —— */
.prism-prompt-sync {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.prism-prompt-sync-text {
  margin: 0;
}
.prism-prompt-sync-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.prism-diff {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.prism-diff-title,
.prism-diff-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbs-ink-muted);
}
.prism-diff-title {
  font-weight: 600;
  color: var(--bbs-ink-soft);
}
.prism-diff-body {
  max-height: 300px;
  overflow: auto;
  padding: 6px 0;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-bg);
}
.prism-diff-line,
.prism-diff-skip {
  margin: 0;
  padding: 1px 10px 1px 26px;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink-soft);
}
.prism-diff-mark {
  display: inline-block;
  width: 16px;
  margin-left: -16px;
  font-weight: 700;
}
.prism-diff-line.is-add {
  color: var(--bbs-ink);
  background: var(--bbs-accent-soft);
}
.prism-diff-line.is-add .prism-diff-mark {
  color: var(--bbs-accent);
}
.prism-diff-line.is-del {
  color: var(--bbs-ink-muted);
  background: var(--bbs-danger-soft);
  text-decoration: line-through;
}
.prism-diff-line.is-del .prism-diff-mark {
  color: var(--bbs-danger);
}
.prism-diff-skip {
  color: var(--bbs-ink-muted);
  font-style: italic;
}

/* —— 提示词弹窗:更宽(.bbs-modal-wide 见 settings.css 弹窗一节) + 大文本框 —— */
/* 宏标签条:可横向裹行,每个宏点击插入 */
.bbs-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbs-macro-tip {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  margin-right: 2px;
}
.bbs-macro {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: 32px;
  padding: 3px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-macro:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-prompt-area {
  width: 100%;
  resize: vertical;
  min-height: 240px;
  line-height: 1.6;
  font-family: var(--bbs-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
@media (max-width: 640px), (pointer: coarse) {
  .bbs-macro { min-height: 40px; }
}
.prism-editor-note { margin: 0; padding: 10px 12px; color: var(--bbs-ink-soft); background: var(--bbs-accent-soft); border-radius: 10px; font-size: 12px; line-height: 1.7; }
@media (max-width: 420px) {
  .bbs-prompt-area { min-height: 220px; font-size: 13px; }
}
</style>
