<script setup lang="ts">
/** 世界书页底部设置：API、自动建议、修改权限、新条目默认值、读取范围。 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import BbsSelect from '@/components/BbsSelect.vue';
import Icon from '@/components/Icon.vue';
import SegmentedControl from '@/components/SegmentedControl.vue';
import type { ApiChannel } from '@/api/settings';
import { notesSettings } from '@/notes/settings';
import { useNotesModelCatalog } from '@/notes/modelCatalog';
import { openPageSection, pageFocus, takePageFocus } from '@/state/pageFocus';
import { getContext } from '@/st/context';
import {
  AUTO_INTERVAL_BOUNDS, ENTRY_POSITIONS, PERMISSIONS, READ_BOUNDS, updateWorldbookSettings, worldbookChannelIssue,
  worldbookSettings, worldbookSettingsIssue, worldbookSettingsProtected,
} from '@/worldbook/settings';
import { autoPauseNote, pendingCount, targetIssue, worldbookRun } from '@/worldbook/service';
import { hostApiIssue, worldHost } from '@/worldbook/host';
import { setCursor, worldbookState, worldbookWriteIssue } from '@/worldbook/store';
import { cursorBefore, newAiFloors } from '@/worldbook/source';
import type { WorldbookPermission, WorldbookSettings } from '@/worldbook/types';

const props = defineProps<{ locked: boolean; nextRead: string }>();
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作没有完成，请重试。');
const feedbackAt = ref('');
const notice = ref('');
const error = ref('');
function report(where: string) { feedbackAt.value = where; notice.value = ''; error.value = ''; }
const protectedSettings = computed(() => { void worldbookSettingsIssue.value; return worldbookSettingsProtected(); });

/* —— API —— */
const apiOpen = ref(false);
const apiPanel = ref<HTMLDetailsElement | null>(null);
const apiMode = ref<WorldbookSettings['apiMode']>(worldbookSettings.apiMode);
const apiDraft = reactive<ApiChannel>(copy(worldbookSettings.channel));
const apiBaseline = ref(JSON.stringify([apiMode.value, apiDraft]));
const apiDirty = computed(() => JSON.stringify([apiMode.value, apiDraft]) !== apiBaseline.value);
const { models, loading: modelsLoading, message: modelsMessage, error: modelsError, pull: pullModels, cancel: cancelModels } = useNotesModelCatalog(apiDraft);
const modelSearch = ref('');
const matchingModels = computed(() => models.value.filter(m => m.toLowerCase().includes(modelSearch.value.trim().toLowerCase())));
const visibleModels = computed(() => matchingModels.value.slice(0, 200));
const modelOptions = computed(() => visibleModels.value.map(m => ({ value: m, label: m })));
watch(() => [apiDraft.url, apiDraft.key], () => { modelSearch.value = ''; });
watch(apiMode, cancelModels);
watch(() => [worldbookSettings.apiMode, worldbookSettings.channel], () => {
  if (apiDirty.value) return;
  apiMode.value = worldbookSettings.apiMode; Object.assign(apiDraft, copy(worldbookSettings.channel));
  apiBaseline.value = JSON.stringify([apiMode.value, apiDraft]);
}, { deep: true });
const modeOptions = [
  { value: 'notes' as const, label: '用札记的 API（默认）' },
  { value: 'independent' as const, label: '世界书专用 API' },
];
const notesModel = computed(() => (notesSettings.channel.url.trim() && notesSettings.channel.model.trim() ? notesSettings.channel.model.trim() : ''));
const apiMeta = computed(() => (worldbookSettings.apiMode === 'notes' ? '用札记的 API' : worldbookSettings.channel.model || '专用 API 未填写'));
const apiIssue = computed(() => { void worldbookSettings.apiMode; void worldbookSettings.channel.url; void worldbookSettings.channel.model; void notesSettings.channel.url; void notesSettings.channel.model; return worldbookChannelIssue(); });
function channelIssue(c: ApiChannel): string {
  if (!c.url.trim() || !c.model.trim()) return '请填写 API 地址和模型名。';
  try {
    const url = new URL(c.url.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#\\\s]/.test(c.url.trim())) throw new Error();
  } catch { return 'API 地址要写完整的 http(s) 地址，不能带账号、? 参数或 #。'; }
  if (!Number.isFinite(c.temperature) || c.temperature < 0 || c.temperature > 2) return '温度要在 0–2 之间。';
  if (!Number.isSafeInteger(c.maxTokens) || c.maxTokens < 256 || c.maxTokens > 65535) return '最大输出要是 256–65535 之间的整数。';
  if (!Number.isSafeInteger(c.timeoutSec) || c.timeoutSec < 10 || c.timeoutSec > 600) return '超时要是 10–600 之间的整数（秒）。';
  return '';
}
function saveApi() {
  report('api');
  if (props.locked || protectedSettings.value) return;
  const issue = apiMode.value === 'independent' ? channelIssue(apiDraft) : '';
  if (issue) { error.value = issue; return; }
  try {
    updateWorldbookSettings(s => { s.apiMode = apiMode.value; s.channel = copy(apiDraft); });
    apiMode.value = worldbookSettings.apiMode; Object.assign(apiDraft, copy(worldbookSettings.channel));
    apiBaseline.value = JSON.stringify([apiMode.value, apiDraft]);
    notice.value = '世界书 API 设置已保存。';
  } catch (cause) { error.value = errorText(cause); }
}
function openApi() {
  apiOpen.value = true;
  void nextTick(() => requestAnimationFrame(() => {
    apiPanel.value?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    apiPanel.value?.querySelector('summary')?.focus({ preventScroll: true });
  }));
}
defineExpose({ openApi });
// 从设置页「札记与规划 API」卡片跳转过来：展开 API 设置，滚动到位并把焦点放在标题上。
watch(() => pageFocus.section, () => { if (takePageFocus('worldbook-api')) openApi(); }, { immediate: true });

/* —— 自动建议、权限、新条目默认值、读取范围：改了立即保存，失败回滚 —— */
function save(where: string, patch: (s: WorldbookSettings) => void, success: string) {
  report(where);
  try { updateWorldbookSettings(patch); notice.value = success; }
  catch (cause) { error.value = errorText(cause); }
}
function changeAuto(event: Event) {
  const input = event.target as HTMLInputElement;
  const on = input.checked;
  save('auto', s => { s.auto.enabled = on; }, on ? '已打开自动建议。' : '已关闭自动建议。');
  input.checked = worldbookSettings.auto.enabled;
}
function intInput(event: Event, lo: number, hi: number, label: string, apply: (n: number) => void, where: string, current: number) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!input.value.trim() || !Number.isSafeInteger(value) || value < lo || value > hi) {
    report(where); error.value = label + '要是 ' + lo + '–' + hi + ' 之间的整数。'; input.value = String(current); return;
  }
  save(where, () => apply(value), '已保存。');
  input.value = String(error.value ? current : value);
}
const aiSinceCursor = computed(() => { void worldbookState.revision; const ctx = getContext(); return ctx ? newAiFloors(ctx, worldbookState.cursor) : 0; });
const autoMeta = computed(() => (worldbookSettings.auto.enabled ? '开 · 每 ' + worldbookSettings.auto.interval + ' 个 AI 楼层' : '关'));
// 自动建议的状态：上次失败的原因 → 当前的配置问题 → 有待审核的建议时暂停 → 距下次运行还差多少
const autoHint = computed(() => {
  if (!worldbookSettings.auto.enabled) return worldbookRun.autoNote;
  if (worldbookRun.autoNote) return worldbookRun.autoNote;
  void worldHost.revision; void worldbookState.target;
  const config = hostApiIssue() || apiIssue.value || targetIssue();
  if (config) return '自动建议不会运行：' + config;
  const pending = pendingCount();
  if (pending) return autoPauseNote(pending);
  return '上次读取后新增 ' + aiSinceCursor.value + ' 个 AI 楼层，满 ' + worldbookSettings.auto.interval + ' 个时，在正文生成结束后自动生成一次建议。';
});

const permissionOptions = PERMISSIONS.map(p => ({ value: p.value, label: p.label, hint: p.hint }));
function changePermission(value: WorldbookPermission) {
  if (value === worldbookSettings.permission) return;
  save('permission', s => { s.permission = value; }, '修改权限已改为「' + PERMISSIONS.find(p => p.value === value)!.label + '」。已生成的建议在应用时按新的权限核对。');
}
const permissionLabel = computed(() => PERMISSIONS.find(p => p.value === worldbookSettings.permission)?.label ?? '');

const positionOptions = ENTRY_POSITIONS.map(p => ({ value: String(p.value), label: p.label }));
const positionLabel = computed(() => ENTRY_POSITIONS.find(p => p.value === worldbookSettings.newEntry.position)?.label ?? '');
function changePosition(value: string) {
  save('entry', s => { s.newEntry.position = Number(value); }, '新条目的插入位置已改为「' + ENTRY_POSITIONS.find(p => String(p.value) === value)?.label + '」。');
}
const entryMeta = computed(() => positionLabel.value + (worldbookSettings.newEntry.position === 4 ? ' ' + worldbookSettings.newEntry.depth : '') + ' · 顺序 ' + worldbookSettings.newEntry.order);

const readMeta = computed(() => worldbookSettings.read.maxFloors + ' 层 · ' + worldbookSettings.read.maxChars + ' 字');
const readFields = [
  { key: 'maxFloors' as const, label: '每次最多读取的楼层数', bounds: READ_BOUNDS.maxFloors },
  { key: 'maxChars' as const, label: '正文字数上限', bounds: READ_BOUNDS.maxChars },
  { key: 'entryChars' as const, label: '相关条目全文字数上限', bounds: READ_BOUNDS.entryChars },
  { key: 'refChars' as const, label: '参考世界书字数上限', bounds: READ_BOUNDS.refChars },
  { key: 'indexChars' as const, label: '目标书条目索引字数上限', bounds: READ_BOUNDS.indexChars },
];
const startFloor = ref<number | ''>('');
async function applyStart() {
  report('read');
  const ctx = getContext();
  const n = Number(startFloor.value);
  if (startFloor.value === '' || !Number.isSafeInteger(n) || n < 0) { error.value = '请填写要开始读取的楼号（0 或正整数）。'; return; }
  if (!ctx || n >= ctx.chat.length) { error.value = '当前聊天没有第 ' + n + ' 楼。'; return; }
  const issue = worldbookWriteIssue(); if (issue) { error.value = issue; return; }
  try { await setCursor(cursorBefore(ctx, n)); notice.value = '下次从第 ' + n + ' 楼开始读取。'; startFloor.value = ''; }
  catch (cause) { error.value = errorText(cause); }
}
async function clearCursor() {
  report('read');
  try { await setCursor(null); notice.value = '已清除读取进度，下次读取最近的楼层。'; }
  catch (cause) { error.value = errorText(cause); }
}
function goNotesApi() { openPageSection('notes', 'notes-api'); }
</script>

<template>
  <footer class="wb-footer" aria-label="世界书设置">
    <p v-if="worldbookSettingsIssue" class="bbs-callout is-danger" role="alert">{{ worldbookSettingsIssue }}</p>

    <details ref="apiPanel" class="bbs-disclosure" :open="apiOpen" @toggle="apiOpen = ($event.target as HTMLDetailsElement).open">
      <summary>API 设置 <span class="bbs-disclosure-meta">{{ apiMeta }}</span></summary>
      <p class="bbs-field-hint">默认使用札记中填写的 API（不需要启用札记），也可为世界书单独设置。不会使用正文或摘要的 API。密钥保存在酒馆的扩展设置（settings.json）中，分享 settings.json 或截图前需删除或遮盖；用「设置备份」导出的文件已去掉密钥。</p>
      <form class="wb-form" @submit.prevent="saveApi">
        <fieldset :disabled="locked || protectedSettings">
          <div class="wb-field">
            <span class="wb-field-label">使用的 API</span>
            <BbsSelect v-model="apiMode" :options="modeOptions" aria-label="世界书使用的 API" />
          </div>
          <div v-if="apiMode === 'notes'" class="wb-notes-api">
            <span>{{ notesModel ? '札记的 API：' + notesModel : '札记的 API 还没有填写地址和模型名。' }}</span>
            <button type="button" class="bbs-btn bbs-btn-sm" @click="goNotesApi"><Icon name="notes" />前往札记设置</button>
          </div>
          <template v-else>
            <label class="wb-field">API 地址<input v-model="apiDraft.url" class="bbs-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://your-api.example/v1" /></label>
            <label class="wb-field">API 密钥<input v-model="apiDraft.key" class="bbs-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="不需要密钥的服务可以留空" /></label>
            <div class="wb-actions">
              <button type="button" class="bbs-btn bbs-btn-sm" :disabled="modelsLoading || !apiDraft.url.trim()" @click="pullModels"><Icon name="refresh" />{{ modelsLoading ? '拉取中…' : '拉取模型列表' }}</button>
              <button v-if="modelsLoading" type="button" class="bbs-btn bbs-btn-sm" @click="cancelModels">取消拉取</button>
            </div>
            <label v-if="models.length" class="wb-field">搜索模型<input v-model="modelSearch" class="bbs-input" type="search" autocomplete="off" placeholder="输入关键词筛选" @input.stop /></label>
            <div v-if="modelOptions.length" class="wb-field">
              <span class="wb-field-label">从列表选择</span>
              <BbsSelect :model-value="visibleModels.includes(apiDraft.model) ? apiDraft.model : ''" :options="modelOptions" aria-label="世界书模型列表" @update:model-value="apiDraft.model = $event" />
            </div>
            <p v-if="matchingModels.length > 200" class="bbs-field-hint">匹配到 {{ matchingModels.length }} 个，仅显示前 200 个，可通过搜索缩小范围。</p>
            <label class="wb-field">模型名<input v-model="apiDraft.model" class="bbs-input" autocomplete="off" spellcheck="false" placeholder="也可填写服务商提供的模型名" /></label>
            <p v-if="modelsMessage" class="bbs-field-hint" role="status">{{ modelsMessage }}</p>
            <p v-if="modelsError" class="bbs-callout is-warning" role="alert">{{ modelsError }}</p>
            <div class="wb-grid">
              <label class="wb-field">温度<input v-model.number="apiDraft.temperature" class="bbs-input" type="number" min="0" max="2" step="0.1" inputmode="decimal" /></label>
              <label class="wb-field">最大输出（tokens）<input v-model.number="apiDraft.maxTokens" class="bbs-input" type="number" min="256" max="65535" step="1" inputmode="numeric" /></label>
              <label class="wb-field">超时（秒）<input v-model.number="apiDraft.timeoutSec" class="bbs-input" type="number" min="10" max="600" step="1" inputmode="numeric" /></label>
            </div>
            <label class="wb-switch-row"><span><strong>流式输出</strong><small>接口不支持时关闭。</small></span><input v-model="apiDraft.stream" type="checkbox" class="bbs-switch" aria-label="世界书 API 流式输出" /></label>
          </template>
          <button type="submit" class="bbs-btn bbs-btn-primary wb-save"><Icon name="check" />保存</button>
        </fieldset>
      </form>
      <p v-if="apiDirty" class="bbs-field-hint">API 设置尚未保存，生成时使用上次保存的设置。</p>
      <p v-else-if="apiIssue" class="bbs-callout is-warning">{{ apiIssue }}</p>
      <div v-if="feedbackAt === 'api' && (notice || error)" class="wb-inline">
        <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
        <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
      </div>
    </details>

    <details class="bbs-disclosure">
      <summary>自动建议 <span class="bbs-disclosure-meta">{{ autoMeta }}</span></summary>
      <label class="wb-switch-row">
        <span><strong>自动生成建议</strong><small>每隔若干个新的 AI 楼层，在正文生成结束后生成一次建议。建议同样需要审核后才写入。</small></span>
        <input type="checkbox" class="bbs-switch" :checked="worldbookSettings.auto.enabled" :disabled="locked || protectedSettings" aria-label="自动生成世界书建议" @change="changeAuto" />
      </label>
      <label class="wb-field wb-inline-field">每隔几个 AI 楼层（{{ AUTO_INTERVAL_BOUNDS[0] }}–{{ AUTO_INTERVAL_BOUNDS[1] }}）
        <input :value="worldbookSettings.auto.interval" class="bbs-input" type="number" :min="AUTO_INTERVAL_BOUNDS[0]" :max="AUTO_INTERVAL_BOUNDS[1]" step="1" inputmode="numeric" :disabled="locked || protectedSettings"
          @change="intInput($event, AUTO_INTERVAL_BOUNDS[0], AUTO_INTERVAL_BOUNDS[1], '间隔', n => { worldbookSettings.auto.interval = n; }, 'auto', worldbookSettings.auto.interval)" />
      </label>
      <p v-if="autoHint" class="bbs-field-hint" role="status">{{ autoHint }}</p>
      <p class="bbs-field-hint">安静生成、代写、试运行和切换聊天不触发；有待审核的建议时暂停，处理完后继续；失败不自动重试。生成完成后弹出提示，导航上的「世界书」显示角标。</p>
      <div v-if="feedbackAt === 'auto' && (notice || error)" class="wb-inline">
        <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
        <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
      </div>
    </details>

    <details class="bbs-disclosure">
      <summary>修改权限 <span class="bbs-disclosure-meta">{{ permissionLabel }}</span></summary>
      <SegmentedControl :model-value="worldbookSettings.permission" :options="permissionOptions" label="世界书修改权限" block @update:model-value="changePermission" />
      <p class="bbs-field-hint">决定模型能对已有条目做什么。提示词随档位变化；超出权限的建议在生成时丢弃，应用时按当前档位再核对一次。「提醒」只显示、不写入，各档都可能出现。</p>
      <div v-if="feedbackAt === 'permission' && (notice || error)" class="wb-inline">
        <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
        <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
      </div>
    </details>

    <details class="bbs-disclosure">
      <summary>新条目默认值 <span class="bbs-disclosure-meta">{{ entryMeta }}</span></summary>
      <p class="bbs-field-hint">新条目使用酒馆的条目模板，按关键词触发（不常驻），其余字段与在酒馆中新建的条目相同。</p>
      <div class="wb-grid">
        <div class="wb-field">
          <span class="wb-field-label">插入位置</span>
          <BbsSelect :model-value="String(worldbookSettings.newEntry.position)" :options="positionOptions" aria-label="新条目的插入位置" @update:model-value="changePosition" />
        </div>
        <label class="wb-field">顺序（0–9999）
          <input :value="worldbookSettings.newEntry.order" class="bbs-input" type="number" min="0" max="9999" step="1" inputmode="numeric" :disabled="locked || protectedSettings"
            @change="intInput($event, 0, 9999, '顺序', n => { worldbookSettings.newEntry.order = n; }, 'entry', worldbookSettings.newEntry.order)" />
        </label>
        <label v-if="worldbookSettings.newEntry.position === 4" class="wb-field">深度（0–999）
          <input :value="worldbookSettings.newEntry.depth" class="bbs-input" type="number" min="0" max="999" step="1" inputmode="numeric" :disabled="locked || protectedSettings"
            @change="intInput($event, 0, 999, '深度', n => { worldbookSettings.newEntry.depth = n; }, 'entry', worldbookSettings.newEntry.depth)" />
        </label>
      </div>
      <div v-if="feedbackAt === 'entry' && (notice || error)" class="wb-inline">
        <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
        <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
      </div>
    </details>

    <details class="bbs-disclosure">
      <summary>读取范围 <span class="bbs-disclosure-meta">{{ readMeta }}</span></summary>
      <p class="bbs-field-hint">每次读取上次处理之后的新楼层，超过上限时先读较早的，下次接着读；单层正文最多读到「正文字数上限」，超长的楼后半段不读，并在生成结果里注明。发送的还有目标世界书的条目索引（放不下的条目只列 uid 和标题）、关键词出现在本次正文里的条目全文，以及当前聊天启用的其他世界书中的相关条目（只读）；不发送整本世界书。</p>
      <div class="wb-grid">
        <label v-for="field in readFields" :key="field.key" class="wb-field">{{ field.label }}（{{ field.bounds[0] }}–{{ field.bounds[1] }}）
          <input :value="worldbookSettings.read[field.key]" class="bbs-input" type="number" :min="field.bounds[0]" :max="field.bounds[1]" step="1" inputmode="numeric" :disabled="locked || protectedSettings"
            @change="intInput($event, field.bounds[0], field.bounds[1], field.label, n => { worldbookSettings.read[field.key] = n; }, 'read', worldbookSettings.read[field.key])" />
        </label>
      </div>
      <div class="wb-progress">
        <p class="wb-progress-line">{{ nextRead }}</p>
        <div class="wb-progress-row">
          <label class="wb-field wb-inline-field">下次从第几楼开始读取
            <input v-model.number="startFloor" class="bbs-input" type="number" min="0" step="1" inputmode="numeric" :disabled="locked" placeholder="楼号" />
          </label>
          <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked || startFloor === ''" @click="applyStart">设定</button>
          <button type="button" class="bbs-btn bbs-btn-sm" :disabled="locked || !worldbookState.cursor" @click="clearCursor">清除读取进度</button>
        </div>
      </div>
      <div v-if="feedbackAt === 'read' && (notice || error)" class="wb-inline">
        <p v-if="notice" class="wb-status" role="status">{{ notice }}</p>
        <p v-if="error" class="bbs-callout is-danger" role="alert">{{ error }}</p>
      </div>
    </details>
  </footer>
</template>

<style scoped>
.wb-footer { margin-top: 32px; border-top: 1px solid var(--bbs-line); }
.wb-footer > details { border-bottom: 1px solid var(--bbs-line); }
.wb-footer > details > summary { font-size: 13.5px; }
.wb-footer > details[open] { padding-bottom: 16px; }
.wb-footer .bbs-disclosure-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-footer > details > .bbs-field-hint:first-of-type { margin-top: 0; }
.wb-footer > .bbs-callout { margin: 12px 0; }
.wb-form fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.wb-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 12px 0 0; font-size: 12.5px; color: var(--bbs-ink-soft); }
.wb-field-label { font-size: 12.5px; color: var(--bbs-ink-soft); }
.wb-footer .bbs-input { box-sizing: border-box; min-width: 0; max-width: 100%; }
.wb-inline-field { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.wb-inline-field .bbs-input { width: 96px; flex: 0 0 96px; text-align: center; }
.wb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); gap: 0 12px; }
.wb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.wb-notes-api { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--bbs-surface-2); font-size: 13px; color: var(--bbs-ink-soft); overflow-wrap: anywhere; }
.wb-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 48px; padding: 8px 0; cursor: pointer; }
.wb-switch-row strong { display: block; font-size: 13.5px; font-weight: 600; color: var(--bbs-ink); }
.wb-switch-row small { display: block; margin-top: 1px; font-size: 12.5px; color: var(--bbs-ink-muted); }
.wb-save { margin-top: 14px; }
.wb-progress { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: var(--bbs-surface-2); }
.wb-progress-line { margin: 0; font-size: 13px; line-height: 1.7; color: var(--bbs-ink-soft); }
.wb-progress-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wb-progress-row .wb-field { margin-top: 8px; }
.wb-progress-row .bbs-btn { margin-top: 8px; }
.wb-status { margin: 0 0 8px; padding: 1px 0 1px 12px; border-left: 2px solid var(--bbs-accent); font-size: 13px; line-height: 1.7; color: var(--bbs-ink-soft); }
.wb-inline { margin-top: 12px; }
.wb-inline > :last-child { margin-bottom: 0; }
.wb-footer :deep(.bbs-segctl) { margin-top: 4px; }
/* 窄屏上三档权限各占一行，说明文字不挤成窄条 */
@media (max-width: 480px) { .wb-footer :deep(.bbs-segctl.is-block .bbs-segctl-opt) { flex: 1 1 100%; } }
</style>
