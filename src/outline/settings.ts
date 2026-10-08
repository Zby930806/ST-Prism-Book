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
  outlineSettingsIssue.value = '大纲设置格式或版本无法识别，已只读保护，未覆盖原设置；请刷新后检查。';
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
  if (!ctx?.extensionSettings || !ctx.saveSettingsDebounced) throw new Error('酒馆设置接口尚未就绪，大纲配置未保存。');
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
    outlineSettingsIssue.value = '大纲设置保存失败，已回滚，请稍后重试。';
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
  if (outlineSettings.apiMode === 'notes' && notesSettingsIssue.value) throw new Error('札记设置处于保护或异常状态，请先检查札记设置。');
  const channel = outlineSettings.apiMode === 'notes' ? notesSettings.channel : outlineSettings.channel;
  const urlText = typeof channel.url === 'string' ? channel.url.trim() : '';
  const model = typeof channel.model === 'string' ? channel.model.trim() : '';
  if (!urlText || !model) throw new Error('请先填写所选大纲渠道的 API 地址和模型；不会回退到正文或摘要 API。');
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error('大纲 API 地址无效。'); }
  if (!/^https?:\/\//i.test(urlText) || !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || /[?#\\\s]/.test(urlText) || /^https?:\/\/[^/]*@/i.test(urlText)) {
    throw new Error('请填写不含凭据、查询参数或片段的有效 HTTP(S) API 地址。');
  }
  return { ...channel, url: urlText, model, excludeParams: [...channel.excludeParams] };
}
