import { reactive, ref } from 'vue';
import type { ApiChannel } from '@/api/settings';
import { getContext } from '@/st/context';
import { notesSettings, settingsIssue as notesSettingsIssue } from '@/notes/settings';
import type { WorldbookPermission, WorldbookSettings } from './types';

export const WORLDBOOK_SETTINGS_KEY = 'prism_book_worldbook_settings';
export const worldbookSettingsIssue = ref('');

/** 新条目可选的插入位置（ST world_info_position 的数值；出口位置需要另填出口名，不提供）。 */
export const ENTRY_POSITIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '角色定义之前' },
  { value: 1, label: '角色定义之后' },
  { value: 2, label: '作者注之前' },
  { value: 3, label: '作者注之后' },
  { value: 4, label: '@深度' },
  { value: 5, label: '示例消息之前' },
  { value: 6, label: '示例消息之后' },
];
export const PERMISSIONS: ReadonlyArray<{ value: WorldbookPermission; label: string; hint: string }> = [
  { value: 'create', label: '只新增', hint: '只新建条目，不改已有条目；已有条目可能过时时给出提醒。' },
  { value: 'supplement', label: '可补充', hint: '可新建条目，也可在已有条目末尾追加内容、追加关键词。' },
  { value: 'modify', label: '可修改', hint: '在可补充的基础上，可替换已有条目中的一段原文或整段改写。' },
];
export const READ_BOUNDS = Object.freeze({
  maxFloors: [4, 100], maxChars: [4000, 120000], entryChars: [0, 40000], refChars: [0, 40000],
} as const);
export const AUTO_INTERVAL_BOUNDS = [2, 50] as const;

const defaults = (): WorldbookSettings => ({
  apiMode: 'notes',
  channel: {
    id: 'prism-worldbook-independent', name: '世界书专用 API', url: '', key: '', model: '',
    temperature: 0.4, maxTokens: 8000, timeoutSec: 180, stream: true,
    prefill: false, excludeParams: [], reasoningEffort: '',
  },
  permission: 'create',
  auto: { enabled: false, interval: 10 },
  newEntry: { position: 0, order: 100, depth: 4 },
  read: { maxFloors: 24, maxChars: 24000, entryChars: 6000, refChars: 4000 },
});
export const worldbookSettings = reactive<WorldbookSettings>(defaults());
let protectedSettings = false;
let committed = defaults();
const copy = (s: WorldbookSettings): WorldbookSettings => JSON.parse(JSON.stringify(s));
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
const int = (v: unknown, fallback: number, lo: number, hi: number) => Math.floor(bounded(v, fallback, lo, hi));

function recognized(raw: unknown): raw is Record<string, unknown> {
  return record(raw) && raw.version === 1 && (raw.apiMode === 'notes' || raw.apiMode === 'independent') && record(raw.channel);
}

export function normalizeWorldbookSettings(value: WorldbookSettings | Record<string, unknown>): WorldbookSettings {
  const d = defaults();
  const c = record(value.channel) ? value.channel : {};
  const auto = record(value.auto) ? value.auto : {};
  const entry = record(value.newEntry) ? value.newEntry : {};
  const read = record(value.read) ? value.read : {};
  const position = typeof entry.position === 'number' && ENTRY_POSITIONS.some(p => p.value === entry.position) ? entry.position : d.newEntry.position;
  const permission = PERMISSIONS.some(p => p.value === value.permission) ? value.permission as WorldbookPermission : d.permission;
  return {
    apiMode: value.apiMode === 'independent' ? 'independent' : 'notes',
    channel: {
      ...d.channel,
      url: typeof c.url === 'string' ? c.url.trim() : '',
      key: typeof c.key === 'string' ? c.key : '',
      model: typeof c.model === 'string' ? c.model.trim() : '',
      temperature: bounded(c.temperature, d.channel.temperature, 0, 2),
      maxTokens: int(c.maxTokens, d.channel.maxTokens, 256, 65535),
      timeoutSec: int(c.timeoutSec, d.channel.timeoutSec, 10, 600),
      stream: c.stream !== false, prefill: c.prefill === true,
      excludeParams: Array.isArray(c.excludeParams) ? c.excludeParams.filter((p): p is string => typeof p === 'string') : [],
      reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
    },
    permission,
    auto: { enabled: auto.enabled === true, interval: int(auto.interval, d.auto.interval, AUTO_INTERVAL_BOUNDS[0], AUTO_INTERVAL_BOUNDS[1]) },
    newEntry: { position, order: int(entry.order, d.newEntry.order, 0, 9999), depth: int(entry.depth, d.newEntry.depth, 0, 999) },
    read: {
      maxFloors: int(read.maxFloors, d.read.maxFloors, ...READ_BOUNDS.maxFloors),
      maxChars: int(read.maxChars, d.read.maxChars, ...READ_BOUNDS.maxChars),
      entryChars: int(read.entryChars, d.read.entryChars, ...READ_BOUNDS.entryChars),
      refChars: int(read.refChars, d.read.refChars, ...READ_BOUNDS.refChars),
    },
  };
}

function protect(): never {
  protectedSettings = true;
  worldbookSettingsIssue.value = '世界书设置的格式或版本认不出来，已只读保护，原设置没有被覆盖；请刷新页面后检查。';
  throw new Error(worldbookSettingsIssue.value);
}

export function hydrateWorldbookSettings(): void {
  protectedSettings = false;
  worldbookSettingsIssue.value = '';
  committed = defaults();
  Object.assign(worldbookSettings, copy(committed));
  const raw = getContext()?.extensionSettings?.[WORLDBOOK_SETTINGS_KEY];
  if (raw == null) return;
  if (!recognized(raw)) {
    try { protect(); } catch { /* 载入时只显示保护提示，不覆盖未知数据。 */ }
    return;
  }
  committed = normalizeWorldbookSettings(raw);
  Object.assign(worldbookSettings, copy(committed));
}

/** 整体保存当前设置；失败时回滚到上次保存的值。 */
export function saveWorldbookSettings(): void {
  if (protectedSettings) throw new Error(worldbookSettingsIssue.value);
  const ctx = getContext();
  if (!ctx?.extensionSettings || !ctx.saveSettingsDebounced) throw new Error('酒馆设置接口未就绪，世界书设置没有保存。');
  const settings = ctx.extensionSettings;
  const previous = settings[WORLDBOOK_SETTINGS_KEY];
  if (previous != null && !recognized(previous)) protect();
  const hadKey = Object.prototype.hasOwnProperty.call(settings, WORLDBOOK_SETTINGS_KEY);
  const next = normalizeWorldbookSettings(worldbookSettings);
  try {
    settings[WORLDBOOK_SETTINGS_KEY] = { version: 1, ...copy(next) };
    ctx.saveSettingsDebounced();
  } catch {
    if (hadKey) settings[WORLDBOOK_SETTINGS_KEY] = previous;
    else delete settings[WORLDBOOK_SETTINGS_KEY];
    Object.assign(worldbookSettings, copy(committed));
    worldbookSettingsIssue.value = '世界书设置保存失败，已回滚，请稍后再试。';
    throw new Error(worldbookSettingsIssue.value);
  }
  committed = copy(next);
  Object.assign(worldbookSettings, copy(next));
  worldbookSettingsIssue.value = '';
}

/** 改一部分设置并保存；失败时恢复原值后抛出。 */
export function updateWorldbookSettings(patch: (s: WorldbookSettings) => void): void {
  const previous = copy(worldbookSettings);
  try { patch(worldbookSettings); saveWorldbookSettings(); }
  catch (error) { Object.assign(worldbookSettings, previous); throw error; }
}

export function worldbookSettingsProtected(): boolean { return protectedSettings; }

/** 出错时说明去哪里改 API。 */
export function worldbookApiPath(): string {
  return worldbookSettings.apiMode === 'notes' ? '札记 → 独立 API 设置（世界书目前使用札记的 API）' : '世界书 → API 设置';
}

/** 默认借用札记的渠道配置（不要求启用札记），也可单独设置；绝不借用正文或摘要的 API。 */
export function resolveWorldbookChannel(): ApiChannel {
  if (protectedSettings) throw new Error(worldbookSettingsIssue.value);
  const notesMode = worldbookSettings.apiMode === 'notes';
  if (notesMode && notesSettingsIssue.value) throw new Error('世界书使用札记的 API，但札记设置处于保护或异常状态，请先检查札记设置。');
  const channel = notesMode ? notesSettings.channel : worldbookSettings.channel;
  const urlText = typeof channel.url === 'string' ? channel.url.trim() : '';
  const model = typeof channel.model === 'string' ? channel.model.trim() : '';
  if (!urlText || !model) {
    throw new Error(notesMode
      ? '世界书默认使用札记的 API，但札记的 API 地址或模型名还没有填写。请在「札记 → 独立 API 设置」中填写，或在本页「API 设置」中改用世界书专用 API（不会使用正文或摘要的 API）。'
      : '请在本页「API 设置」中填写世界书专用 API 的地址和模型名（不会使用正文或摘要的 API）。');
  }
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error('世界书使用的 API 地址不是有效的网址，请检查「' + worldbookApiPath() + '」。'); }
  if (!/^https?:\/\//i.test(urlText) || !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || /[?#\\\s]/.test(urlText) || /^https?:\/\/[^/]*@/i.test(urlText)) {
    throw new Error('API 地址要写完整的 http(s) 地址，不能带账号、? 参数或 #，请检查「' + worldbookApiPath() + '」。');
  }
  return { ...channel, url: urlText, model, excludeParams: [...channel.excludeParams] };
}

/** API 不可用的原因；可用时返回空串。 */
export function worldbookChannelIssue(): string {
  try { resolveWorldbookChannel(); return ''; } catch (error) { return error instanceof Error ? error.message : '世界书 API 不可用。'; }
}
