<script setup lang="ts">
/**
 * 自定义变量页(MVU 式:一个 JSON 状态树 + 路径命令)。三块:
 *  ① 当前状态:AI 在剧情里用命令建/改出来的 JSON(派生,只读展示;可手动编辑整份 → 写回最新叶子)。
 *  ② 初始模板与说明:三层(全局/角色/聊天)各一份初始结构 + 给 AI 的说明,合并作为重放起点。
 *  ③ 导入/导出:分享变量结构(模板+说明,不含值)。
 * 值永远每聊天独立(从各聊天叶子的 varOps 重放);改模板不需摘要,改「当前值」需要有摘要(写最新叶子)。
 */
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import ModalMask from '@/components/ModalMask.vue';
import JsonTreeEditor from '@/components/JsonTreeEditor.vue';
import { currentCharKey } from '@/api/settings';
import { mergeTemplates, setVarsRoot } from '@/memory/apply';
import { refreshInjection } from '@/memory/inject';
import { derivedMeta, memory, replaceVarsTemplate } from '@/memory/store';
import type { JsonValue, VarTier } from '@/memory/types';
import { toast } from '@/st/toast';
import { computed, ref, watch } from 'vue';

const hasLeaf = computed(() => derivedMeta.hasLeaf);
// rev 每次重算派生(含切聊天/切角色)自增,借它让「是否有角色」「当前状态」随之刷新
const charAvailable = computed(() => { void derivedMeta.rev; return currentCharKey() !== null; });

const TIER_META: Record<VarTier, { label: string; hint: string }> = {
  global: { label: '全局', hint: '所有角色所有聊天共享初始模板' },
  char: { label: '角色', hint: '当前角色的所有聊天共享初始模板' },
  chat: { label: '聊天', hint: '仅当前聊天' },
};
const TIER_ORDER: VarTier[] = ['global', 'char', 'chat'];

/** 解析成 JSON 对象(根须是对象);失败返回 null。 */
function parseObj(text: string): Record<string, JsonValue> | null {
  try {
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/* ============ 当前状态 ============ */
const stateJson = computed(() => {
  void derivedMeta.rev;
  try {
    return JSON.stringify(memory.vars, null, 2);
  } catch {
    return '{}';
  }
});
const hasState = computed(() => Object.keys(memory.vars).length > 0);

const editStateOpen = ref(false);
const stateEdit = ref('');
const stateEditErr = ref('');
function openEditState() {
  if (!hasLeaf.value) return;
  stateEdit.value = stateJson.value;
  stateEditErr.value = '';
  editStateOpen.value = true;
}
function saveState() {
  const json = parseObj(stateEdit.value);
  if (!json) { stateEditErr.value = 'JSON 无效或根不是对象 {…}'; return; }
  if (!setVarsRoot(json)) { stateEditErr.value = '保存失败：要先有摘要才能写入。'; return; }
  refreshInjection();
  editStateOpen.value = false;
}

/* ============ 初始模板与说明(三层) ============ */
const defaultEditorTier = (): VarTier => (charAvailable.value ? 'char' : 'chat');
const editorTier = ref<VarTier>(defaultEditorTier());
const editorMode = ref<'tree' | 'source'>('tree'); // 结构编辑器(默认)/ 源码
const editorTree = ref<Record<string, JsonValue>>({}); // 树形模式的工作副本
const editorJson = ref(''); // 源码模式文本
const editorMeaning = ref(''); // 含义:各字段是什么(主/副API都拿)
const editorRule = ref('');    // 变化规则:何时怎么改/可否新建(仅副API)
const jsonError = ref('');

function loadTier(t: VarTier) {
  const tpl = memory.varTemplates[t];
  editorTree.value = JSON.parse(JSON.stringify(tpl.json ?? {}));
  editorJson.value = Object.keys(tpl.json).length ? JSON.stringify(tpl.json, null, 2) : '{\n\n}';
  editorMeaning.value = tpl.meaning;
  editorRule.value = tpl.rule;
  jsonError.value = '';
}
function switchTier(t: VarTier) {
  if (t === 'char' && !charAvailable.value) return;
  editorTier.value = t;
  loadTier(t);
}
loadTier(editorTier.value); // 初始优先载入角色层;群聊/未进入时回退聊天层

// 树形编辑改动 → 同步一份到源码文本(切到源码时不落后)
watch(editorTree, v => { editorJson.value = JSON.stringify(v, null, 2); }, { deep: true });

// 切模式:进树形时用源码文本重解析(接住用户在源码里的编辑);进源码时用树重渲染
function switchMode(m: 'tree' | 'source') {
  if (m === editorMode.value) return;
  if (m === 'tree') {
    const obj = parseObj(editorJson.value);
    if (!obj) { jsonError.value = '源码 JSON 不对，改好后才能切到结构视图。'; return; }
    editorTree.value = obj;
    jsonError.value = '';
  } else {
    editorJson.value = JSON.stringify(editorTree.value, null, 2);
  }
  editorMode.value = m;
}

/** 取当前编辑中的 json(按模式来源);无效返回 null。 */
function currentEditorJson(): Record<string, JsonValue> | null {
  return editorMode.value === 'tree' ? editorTree.value : parseObj(editorJson.value);
}

function saveTemplate() {
  const t = editorTier.value;
  if (t === 'char' && !charAvailable.value) return;
  const json = currentEditorJson();
  if (!json) { jsonError.value = 'JSON 无效或根不是对象 {…}'; return; }
  jsonError.value = '';
  replaceVarsTemplate(t, { json, meaning: editorMeaning.value, rule: editorRule.value });
  refreshInjection();
  toast(`已保存${TIER_META[t].label}模板`, 'success');
}

/* ============ 导入 / 导出(模板+说明,不含值) ============ */
const exportOpen = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importTier = ref<VarTier>('chat');

const exportText = computed(() => {
  const json = mergeTemplates(memory.varTemplates);
  const meaning = TIER_ORDER.map(t => memory.varTemplates[t].meaning.trim()).filter(Boolean).join('\n\n');
  const rule = TIER_ORDER.map(t => memory.varTemplates[t].rule.trim()).filter(Boolean).join('\n\n');
  return JSON.stringify({ app: 'ST-BaiBai-Book', kind: 'vars', version: 3, json, meaning, rule }, null, 2);
});
const hasAnyTemplate = computed(() => {
  void derivedMeta.rev;
  return TIER_ORDER.some(t => Object.keys(memory.varTemplates[t].json).length || memory.varTemplates[t].meaning.trim() || memory.varTemplates[t].rule.trim());
});

function openExport() {
  if (!hasAnyTemplate.value) return;
  exportOpen.value = true;
}
function openImport() {
  importText.value = '';
  importTier.value = 'chat';
  importOpen.value = true;
}
async function copyExport() {
  try {
    await navigator.clipboard.writeText(exportText.value);
    toast('已复制到剪贴板', 'success');
  } catch {
    toast('复制失败，请在框里手动选中复制。', 'error');
  }
}
function downloadExport() {
  const blob = new Blob([exportText.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baibai-vars.json';
  a.click();
  URL.revokeObjectURL(url);
}
function onImportFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { importText.value = String(reader.result ?? ''); };
  reader.readAsText(f);
}
function applyImport() {
  let parsed: unknown;
  try { parsed = JSON.parse(importText.value); } catch { toast('JSON 格式不对，解析失败，请检查。', 'error'); return; }
  // 接受 {json,meaning,rule} 包裹(兼容旧 guide → 并入 rule),或裸对象(当作 json)
  let json: Record<string, JsonValue> = {};
  let meaning = '';
  let rule = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.json && typeof o.json === 'object' && !Array.isArray(o.json)) {
      json = o.json as Record<string, JsonValue>;
      meaning = typeof o.meaning === 'string' ? o.meaning : '';
      rule = typeof o.rule === 'string' ? o.rule : '';
      if (!meaning && !rule && typeof o.guide === 'string') rule = o.guide; // 兼容旧单一说明
    } else if (!o.kind) {
      json = o as Record<string, JsonValue>; // 裸对象
    }
  }
  if (!Object.keys(json).length && !meaning.trim() && !rule.trim()) { toast('没解析到可导入的结构', 'error'); return; }
  let tier = importTier.value;
  if (tier === 'char' && !charAvailable.value) tier = 'chat';
  const cur = memory.varTemplates[tier];
  const mergedJson = { ...cur.json, ...json }; // 顶层浅合并(同名整体覆盖)
  const mergedMeaning = [cur.meaning.trim(), meaning.trim()].filter(Boolean).join('\n\n');
  const mergedRule = [cur.rule.trim(), rule.trim()].filter(Boolean).join('\n\n');
  replaceVarsTemplate(tier, { json: mergedJson, meaning: mergedMeaning, rule: mergedRule });
  refreshInjection();
  if (editorTier.value === tier) loadTier(tier); // 正在编辑该层则刷新编辑器
  importOpen.value = false;
  toast(`已导入到${TIER_META[tier].label}模板`, 'success');
}
</script>

<template>
  <section class="bbs-page">
    <PageHeader icon="vars" title="变量" description="自定义变量的当前值，以及它们的初始结构和变化规则（模板）。">
      <template #actions>
        <button class="bbs-btn" type="button" :disabled="!hasAnyTemplate" title="导出模板（分享）" @click="openExport"><Icon name="upload" />导出模板</button>
        <button class="bbs-btn" type="button" title="导入模板" @click="openImport"><Icon name="download" />导入模板</button>
      </template>
    </PageHeader>
    <div class="bbs-ledger-meta">
      <span><strong>{{ Object.keys(memory.vars).length }}</strong>个当前顶层字段</span>
      <span class="bbs-ledger-note">当前值按聊天独立保存</span>
    </div>

    <!-- 当前状态：读取面板与模板编辑明确分区。 -->
    <section class="bbs-var-state" aria-labelledby="bbs-vars-state-heading">
    <div class="bbs-var-blockhead">
      <div class="bbs-var-section-title"><h2 id="bbs-vars-state-heading" class="bbs-var-sub">当前状态</h2></div>
      <button class="bbs-mini-btn" type="button" :disabled="!hasLeaf" title="手动编辑整份 JSON" @click="openEditState">
        <Icon name="edit" />编辑
      </button>
    </div>
    <pre v-if="hasState" class="bbs-json-view" tabindex="0" aria-label="当前变量 JSON 状态">{{ stateJson }}</pre>
    <div v-else class="bbs-var-emptyline"><Icon name="vars" /><div><h3>还没有变量</h3><p>可以在下面定义初始模板，也可以让 AI 在剧情里自己建（比如势力、关系）。</p></div></div>
    <p v-if="!hasLeaf" class="bbs-modal-hint bbs-var-statehint">有了摘要才能改当前值；现在显示的是初始状态。下面的模板随时可以改。</p>
    </section>

    <!-- 初始模板与说明 -->
    <section class="bbs-var-template" aria-labelledby="bbs-vars-template-heading">
    <div class="bbs-var-blockhead bbs-var-tmplhead">
      <div class="bbs-var-section-title"><h2 id="bbs-vars-template-heading" class="bbs-var-sub">初始模板与说明</h2></div>
      <span class="bbs-var-scope">聊天 &gt; 角色 &gt; 全局</span>
    </div>
    <p class="bbs-modal-hint bbs-var-tmpltip">
      初始结构 + 给 AI 的说明。三层合并（聊天 &gt; 角色 &gt; 全局）作为重放起点，AI 在剧情里用命令增删改。改初始值会影响整条聊天的当前值。
    </p>

    <div class="bbs-typegrid bbs-var-tierpick" aria-label="选择模板作用范围">
      <button
        v-for="t in TIER_ORDER"
        :key="t"
        class="bbs-typebtn"
        :class="{ on: editorTier === t }"
        :aria-pressed="editorTier === t"
        type="button"
        :disabled="t === 'char' && !charAvailable"
        @click="switchTier(t)"
      >
        <span class="bbs-tier-name">{{ TIER_META[t].label }}</span><small>{{ TIER_META[t].hint }}</small>
      </button>
    </div>
    <span class="bbs-modal-hint">
      {{ editorTier === 'char' && !charAvailable ? '当前无单一角色（群聊/未进入），暂不能编辑角色层' : TIER_META[editorTier].hint }}
    </span>

    <div class="bbs-modal-field">
      <div class="bbs-jte-fieldhead">
        <span class="bbs-modal-label">初始结构（可留空让 AI 从零建）</span>
        <div class="bbs-mode-toggle" aria-label="模板编辑模式">
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'tree' }" :aria-pressed="editorMode === 'tree'" type="button" @click="switchMode('tree')">结构</button>
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'source' }" :aria-pressed="editorMode === 'source'" type="button" @click="switchMode('source')">源码</button>
        </div>
      </div>
      <div v-if="editorMode === 'tree'" class="bbs-jte-wrap">
        <JsonTreeEditor v-model="editorTree" />
        <p v-if="!Object.keys(editorTree).length" class="bbs-jte-empty">空结构。点「加字段」搭出想追踪的结构，或留空让 AI 在剧情里自建。</p>
      </div>
      <textarea v-else v-model="editorJson" class="bbs-input bbs-json-edit" aria-label="初始结构 JSON 源码" spellcheck="false" rows="7"></textarea>
      <span v-if="jsonError" class="bbs-json-err">{{ jsonError }}</span>
    </div>
    <div class="bbs-var-guide-grid">
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">含义（各字段是什么；正文 AI 与摘要 AI 都会看到，用于理解当前值）</span>
      <textarea
        v-model="editorMeaning"
        class="bbs-input bbs-modal-textarea"
        rows="5"
        placeholder="如：xxx好感度指的是该角色对{{user}}的好感度，角色好感度的不同，行为表现也会不同。"
      ></textarea>
    </label>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">变化规则（何时怎么改、可否新建；只发摘要 AI，不进正文，避免正文复述变量）</span>
      <textarea
        v-model="editorRule"
        class="bbs-input bbs-modal-textarea"
        rows="5"
        placeholder="如：角色每次和{{user}}触发事件时，好感度都会变化，但每次浮动不得超过5"
      ></textarea>
    </label>
    </div>
    <div class="bbs-modal-foot bbs-var-savefoot">
      <p>修改初始值会影响整条聊天的当前值，请确认作用范围后保存。</p>
      <button
        class="bbs-btn bbs-btn-primary"
        type="button"
        :disabled="editorTier === 'char' && !charAvailable"
        @click="saveTemplate"
      >
        <Icon name="check" />保存{{ TIER_META[editorTier].label }}模板
      </button>
    </div>

    </section>

    <!-- 编辑当前值 -->
    <ModalMask :open="editStateOpen" @close="editStateOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑当前变量值">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑当前值</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="editStateOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">直接改整份 JSON，保存即写进最新摘要楼层（删该楼可回退）。</p>
        <textarea v-model="stateEdit" aria-label="编辑当前变量 JSON" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false"></textarea>
        <span v-if="stateEditErr" class="bbs-json-err">{{ stateEditErr }}</span>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="editStateOpen = false">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveState">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 导出 -->
    <ModalMask :open="exportOpen" @close="exportOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="导出变量模板">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">导出变量模板</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="exportOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">三层合并后的初始结构 + 说明（不含具体值）。复制发给别人即可分享。</p>
        <textarea class="bbs-input bbs-json-edit bbs-io-area" aria-label="导出的变量模板 JSON" readonly :value="exportText"></textarea>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="downloadExport"><Icon name="download" />下载文件</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="copyExport"><Icon name="check" />复制</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 导入 -->
    <ModalMask :open="importOpen" @close="importOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="导入变量模板">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">导入变量模板</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="importOpen = false"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">粘贴模板 JSON</span>
          <textarea v-model="importText" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false" placeholder="把分享来的变量模板 JSON 粘到这里，或用下面的文件选择"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">或从文件导入</span>
          <input class="bbs-input" type="file" accept="application/json,.json" @change="onImportFile" />
        </label>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">导入到哪层</span>
          <div class="bbs-typegrid">
            <button
              v-for="t in TIER_ORDER"
              :key="t"
              class="bbs-typebtn"
              :class="{ on: importTier === t }"
              type="button"
              :disabled="t === 'char' && !charAvailable"
              @click="importTier = t"
            >
              {{ TIER_META[t].label }}
            </button>
          </div>
          <span class="bbs-modal-hint">合并进该层模板（顶层同名字段会被覆盖）；说明会追加。</span>
        </div>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="importOpen = false">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importText.trim()" @click="applyImport">导入</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>

/* 页面本身保持文档流，滚动交给书页容器；不把工具栏与说明再套成卡片。 */
.bbs-page { display: flex; flex-direction: column; height: auto; min-width: 0; min-height: 100%; color: var(--bbs-ink); }
.bbs-page, .bbs-page * { box-sizing: border-box; }
.bbs-page .bbs-input { min-width: 0; max-width: 100%; }
.bbs-page button { font-family: inherit; }
.bbs-page button:focus-visible, .bbs-page input:focus-visible, .bbs-page textarea:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 3px; }
.bbs-page button:disabled { cursor: not-allowed; }
.bbs-page .bbs-btn { min-height: 38px; gap: 6px; white-space: normal; }
.bbs-ledger-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin: 18px 0; padding: 0 0 14px; border-bottom: 1px solid var(--bbs-line); font-size: 12px; line-height: 1.6; color: var(--bbs-ink-muted); }
.bbs-ledger-meta strong { margin-right: 4px; font-size: 19px; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--bbs-ink); }
.bbs-ledger-note { margin-left: auto; color: var(--bbs-accent); }
.bbs-search { display: flex; align-items: center; gap: 9px; flex: 1 1 200px; min-width: 0; color: var(--bbs-ink-muted); }
.bbs-search > .bbs-input { flex: 1; width: 100%; }
.bbs-filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 18px; }
.bbs-filter-tabs { display: flex; flex-wrap: wrap; gap: 4px; }
.bbs-filter-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 11px; border: 1px solid var(--bbs-line); border-radius: 9px; background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-size: 12px; cursor: pointer; }
.bbs-filter-tab[aria-pressed='true'] { background: var(--bbs-accent-soft); border-color: var(--bbs-accent); color: var(--bbs-accent); }
.bbs-filter-tab span { font-variant-numeric: tabular-nums; font-size: 11px; }
.bbs-item-act { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 36px; height: 36px; padding: 0; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--bbs-ink-soft); cursor: pointer; font-size: 15px; }
.bbs-item-act:hover:not(:disabled) { background: var(--bbs-surface-2); border-color: var(--bbs-line); color: var(--bbs-accent); }
.bbs-item-del:hover:not(:disabled) { background: var(--bbs-danger-soft); color: var(--bbs-danger); border-color: var(--bbs-danger); }
.bbs-empty { display: flex; flex: none; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 230px; padding: 34px 16px; margin: 12px 0; text-align: center; background: transparent; }
.bbs-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 54px; height: 54px; border-radius: 18px; background: var(--bbs-accent-soft); color: var(--bbs-accent); font-size: 25px; }
.bbs-empty h3 { margin: 5px 0 0; color: var(--bbs-ink); font-size: 16px; font-weight: 650; }
.bbs-empty p { max-width: 360px; margin: 0; color: var(--bbs-ink-muted); font-size: 13px; line-height: 1.8; }
.bbs-empty .bbs-btn { margin-top: 6px; }
.bbs-modal { min-width: 0; overflow-wrap: anywhere; }
.bbs-modal-head, .bbs-modal-foot { flex-wrap: wrap; }
.bbs-modal-textarea { resize: vertical; min-height: 80px; font-family: inherit; }
.bbs-modal-check { flex-direction: row; align-items: center; gap: 9px; cursor: pointer; }
.bbs-modal-check input { flex-shrink: 0; }
@media (max-width: 480px) {
  .bbs-ledger-meta { gap: 6px 14px; margin: 16px 0; }
  .bbs-ledger-note { flex-basis: 100%; margin-left: 0; }
  .bbs-search { flex-basis: 100%; }
  .bbs-filterbar { gap: 10px; }
  .bbs-item-act { width: 40px; height: 40px; }
  .bbs-page .bbs-btn { min-height: 42px; }
  .bbs-filter-tab { min-height: 40px; }
  .bbs-empty { min-height: 210px; padding: 26px 10px; }
}

.bbs-var-state, .bbs-var-template { min-width: 0; }
.bbs-var-blockhead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.bbs-var-section-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.bbs-var-sub { margin: 0; font-size: 16px; font-weight: 650; color: var(--bbs-ink); }
.bbs-mini-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 12px; border: 1px solid var(--bbs-line); border-radius: 9px; background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-size: 12px; cursor: pointer; }
.bbs-mini-btn:hover:not(:disabled) { border-color: var(--bbs-accent); background: var(--bbs-accent-soft); color: var(--bbs-accent); }
.bbs-mini-btn:disabled { opacity: .5; }
.bbs-json-view { margin: 0; width: 100%; min-width: 0; padding: 18px; border: 1px solid var(--bbs-line); border-left: 3px solid var(--bbs-accent); border-radius: 12px; background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-family: var(--bbs-font-mono); font-size: 12px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; min-height: 150px; max-height: 50vh; overflow: auto; tab-size: 2; }
.bbs-json-view:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 3px; }
.bbs-var-emptyline { display: flex; align-items: flex-start; gap: 14px; padding: 20px 0; font-size: 22px; color: var(--bbs-accent); }
.bbs-var-emptyline > div { min-width: 0; }
.bbs-var-emptyline h3 { margin: 0 0 7px; font-size: 14px; font-weight: 600; color: var(--bbs-ink); }
.bbs-var-emptyline p { margin: 0; font-size: 12px; color: var(--bbs-ink-muted); line-height: 1.8; }
.bbs-var-statehint { margin: 12px 0 0; }
.bbs-var-template { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--bbs-line); }
.bbs-var-scope { font-size: 11px; color: var(--bbs-ink-muted); }
.bbs-var-tmpltip { margin: 0 0 18px; }
.bbs-modal-hint { display: block; font-size: 12px; line-height: 1.8; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-typegrid { display: flex; flex-wrap: wrap; gap: 8px; }
.bbs-typebtn { flex: 1 1 0; min-width: 0; min-height: 40px; padding: 10px 12px; border: 1px solid var(--bbs-line); border-radius: 10px; background: var(--bbs-surface); color: var(--bbs-ink-soft); font-size: 13px; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; }
.bbs-typebtn:hover:not(:disabled) { border-color: var(--bbs-accent); }
.bbs-typebtn.on { background: var(--bbs-accent-soft); border-color: var(--bbs-accent); color: var(--bbs-accent); }
.bbs-typebtn:disabled { opacity: .5; }
.bbs-var-tierpick { margin-bottom: 10px; }
.bbs-var-tierpick .bbs-typebtn { text-align: left; }
.bbs-tier-name { display: block; margin-bottom: 5px; font-size: 14px; }
.bbs-typebtn small { display: block; font-size: 10px; line-height: 1.65; font-weight: 400; color: var(--bbs-ink-muted); }
.bbs-var-template > .bbs-modal-field { margin-top: 22px; }
.bbs-jte-fieldhead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.bbs-mode-toggle { display: inline-flex; flex-shrink: 0; padding: 3px; border: 1px solid var(--bbs-line); border-radius: 9px; background: var(--bbs-surface-2); }
.bbs-mode-btn { padding: 6px 12px; min-height: 32px; border: 0; border-radius: 6px; background: transparent; color: var(--bbs-ink-muted); font-size: 12px; cursor: pointer; }
.bbs-mode-btn.on { background: var(--bbs-accent); color: var(--bbs-accent-ink); }
.bbs-jte-wrap { min-width: 0; max-width: 100%; padding: 14px; border: 1px solid var(--bbs-line); border-radius: 12px; background: var(--bbs-surface); box-shadow: var(--bbs-card-shadow); }
.bbs-jte-empty { margin: 10px 0 0; font-size: 12px; color: var(--bbs-ink-muted); line-height: 1.8; }
.bbs-json-edit { display: block; width: 100%; resize: vertical; min-height: 150px; font-family: var(--bbs-font-mono); font-size: 12px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.bbs-json-err { display: block; padding: 8px 10px; border-left: 2px solid var(--bbs-danger); background: var(--bbs-danger-soft); font-size: 12px; color: var(--bbs-danger); overflow-wrap: anywhere; }
.bbs-var-guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }
.bbs-var-guide-grid .bbs-modal-field { display: flex; flex-direction: column; min-width: 0; margin: 0; }
.bbs-var-guide-grid .bbs-modal-label { flex: 1; line-height: 1.8; }
.bbs-var-guide-grid textarea { min-height: 140px; }
.bbs-var-savefoot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-top: 16px; margin-top: 20px; border-top: 1px solid var(--bbs-line); }
.bbs-var-savefoot p { flex: 1 1 180px; margin: 0; font-size: 11px; line-height: 1.8; color: var(--bbs-warning); }
.bbs-var-savefoot .bbs-btn { flex-shrink: 0; }
.bbs-io-area { min-height: 220px; }
/* 只作用于本页的结构编辑器，不改共享组件；窄屏把字段名、类型和值拆成两行。 */
.bbs-jte-wrap :deep(.bbs-jte), .bbs-jte-wrap :deep(.bbs-jte-field) { min-width: 0; }
.bbs-jte-wrap :deep(.bbs-jte-row) { flex-wrap: wrap; }
.bbs-jte-wrap :deep(.bbs-jte-add), .bbs-jte-wrap :deep(.bbs-jte-del) { min-height: 36px; }
@media (max-width: 640px) { .bbs-var-guide-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 480px) {
  .bbs-json-view { padding: 13px; font-size: 11px; }
  .bbs-typebtn { padding: 9px 7px; }
  .bbs-typebtn small { font-size: 10px; }
  .bbs-mini-btn, .bbs-mode-btn { min-height: 40px; }
  .bbs-jte-wrap { padding: 10px; }
  .bbs-jte-wrap :deep(.bbs-jte-row) { display: grid; grid-template-columns: minmax(0, 1fr) 78px 36px; gap: 6px; }
  .bbs-jte-wrap :deep(.bbs-jte-key), .bbs-jte-wrap :deep(.bbs-jte-idx) { grid-column: 1; min-width: 0; width: 100%; }
  .bbs-jte-wrap :deep(.bbs-jte-type) { grid-column: 2; width: 100%; min-width: 0; }
  .bbs-jte-wrap :deep(.bbs-jte-del) { grid-column: 3; grid-row: 1; width: 36px; height: 40px; }
  .bbs-jte-wrap :deep(.bbs-jte-val), .bbs-jte-wrap :deep(.bbs-jte-bool), .bbs-jte-wrap :deep(.bbs-jte-containertag) { grid-column: 1 / -1; grid-row: 2; width: 100%; min-height: 36px; }
  .bbs-jte-wrap :deep(.bbs-jte-nest) { margin-left: 0; padding-left: 6px; }
  .bbs-jte-wrap :deep(.bbs-jte-nest .bbs-jte-nest .bbs-jte-nest) { padding-left: 0; border-left: 0; }
  .bbs-var-savefoot .bbs-btn { width: 100%; justify-content: center; }
}
</style>
