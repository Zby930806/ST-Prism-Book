import { reactive, ref } from 'vue';
import type { ApiChannel } from '@/api/settings';
import { getContext } from '@/st/context';
import { notesSettings, settingsIssue as notesSettingsIssue } from '@/notes/settings';
import type { OutlineSettings } from './types';

export const OUTLINE_SETTINGS_KEY = 'prism_book_outline_settings';
export const outlineSettingsIssue = ref('');
const defaults = (): OutlineSettings => ({
  apiMode: 'notes',
  channel: {
    id: 'prism-outline-independent', name: '独立大纲 API', url: '', key: '', model: '',
    temperature: 0.7, maxTokens: 6000, timeoutSec: 180, stream: true,
    prefill: false, excludeParams: [], reasoningEffort: '',
  },
});
export const outlineSettings = reactive<OutlineSettings>(defaults());
let protectedSettings = false;
let committed = defaults();
const copy = (s: OutlineSettings): OutlineSettings => ({ ...s, channel: { ...s.channel, excludeParams: [...s.channel.excludeParams] } });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

function recognized(raw: unknown): raw is Record<string, unknown> {
  return record(raw) && raw.version === 1 && (raw.apiMode === 'notes' || raw.apiMode === 'independent') && record(raw.channel);
}

function normalize(value: OutlineSettings | Record<string, unknown>): OutlineSettings {
  const d = defaults();
  const c = record(value.channel) ? value.channel : {};
  return {
    apiMode: value.apiMode === 'independent' ? 'independent' : 'notes',
    channel: {
      ...d.channel,
      url: typeof c.url === 'string' ? c.url.trim() : '',
      key: typeof c.key === 'string' ? c.key : '',
      model: typeof c.model === 'string' ? c.model.trim() : '',
      temperature: bounded(c.temperature, 0.7, 0, 2),
      maxTokens: Math.floor(bounded(c.maxTokens, 6000, 256, 65535)),
      timeoutSec: Math.floor(bounded(c.timeoutSec, 180, 10, 600)),
      stream: c.stream !== false, prefill: c.prefill === true,
      excludeParams: Array.isArray(c.excludeParams) ? c.excludeParams.filter((p): p is string => typeof p === 'string') : [],
      reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
    },
  };
}

function protect(): never {
  protectedSettings = true;
  outlineSettingsIssue.value = '大纲设置的格式或版本认不出来，已经只读保护，原设置没有被覆盖；请刷新后检查。';
  throw new Error(outlineSettingsIssue.value);
}

export function hydrateOutlineSettings(): void {
  protectedSettings = false;
  outlineSettingsIssue.value = '';
  committed = defaults();
  Object.assign(outlineSettings, copy(committed));
  const raw = getContext()?.extensionSettings?.[OUTLINE_SETTINGS_KEY];
  if (raw == null) return;
  if (!recognized(raw)) {
    try { protect(); } catch { /* 载入只显示保护提示，不覆盖未知数据。 */ }
    return;
  }
  committed = normalize(raw);
  Object.assign(outlineSettings, copy(committed));
}

export function saveOutlineSettings(): void {
  if (protectedSettings) throw new Error(outlineSettingsIssue.value);
  const ctx = getContext();
  if (!ctx?.extensionSettings || !ctx.saveSettingsDebounced) throw new Error('酒馆设置接口未就绪，大纲设置没有保存。');
  const settings = ctx.extensionSettings;
  const previous = settings[OUTLINE_SETTINGS_KEY];
  if (previous != null && !recognized(previous)) protect();
  const hadKey = Object.prototype.hasOwnProperty.call(settings, OUTLINE_SETTINGS_KEY);
  const next = normalize(outlineSettings);
  try {
    settings[OUTLINE_SETTINGS_KEY] = { version: 1, ...copy(next) };
    ctx.saveSettingsDebounced();
  } catch {
    if (hadKey) settings[OUTLINE_SETTINGS_KEY] = previous;
    else delete settings[OUTLINE_SETTINGS_KEY];
    Object.assign(outlineSettings, copy(committed));
    outlineSettingsIssue.value = '大纲设置保存失败，已回滚，请稍后再试。';
    throw new Error(outlineSettingsIssue.value);
  }
  committed = copy(next);
  Object.assign(outlineSettings, copy(next));
  outlineSettingsIssue.value = '';
}

/** 仅借用札记渠道配置，不要求札记启用，也绝不借用正文/摘要渠道。 */
export function resolveOutlineChannel(): ApiChannel {
  if (protectedSettings) throw new Error(outlineSettingsIssue.value);
  if (outlineSettings.apiMode !== 'notes' && outlineSettings.apiMode !== 'independent') throw new Error('大纲 API 模式无效。');
  if (outlineSettings.apiMode === 'notes' && notesSettingsIssue.value) throw new Error('大纲用的是札记的 API，但札记设置现在处于保护或异常状态，请先检查札记设置。');
  const channel = outlineSettings.apiMode === 'notes' ? notesSettings.channel : outlineSettings.channel;
  const urlText = typeof channel.url === 'string' ? channel.url.trim() : '';
  const model = typeof channel.model === 'string' ? channel.model.trim() : '';
  if (!urlText || !model) {
    throw new Error(outlineSettings.apiMode === 'notes'
      ? '大纲默认用札记的 API，但札记还没填好地址和模型。请到「札记 → 独立 API 设置」里填写，或在下方「规划 API 设置」改用专用 API（不会改用正文或摘要的 API）。'
      : '请在下方「规划 API 设置」里填写专用 API 的地址和模型（不会改用正文或摘要的 API）。');
  }
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error('规划用的 API 地址不是有效的网址。'); }
  if (!/^https?:\/\//i.test(urlText) || !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || /[?#\\\s]/.test(urlText) || /^https?:\/\/[^/]*@/i.test(urlText)) {
    throw new Error('API 地址要写完整的 http(s) 地址，不能带账号、? 参数或 #。');
  }
  return { ...channel, url: urlText, model, excludeParams: [...channel.excludeParams] };
}
