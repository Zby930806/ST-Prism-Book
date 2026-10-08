import { reactive, ref } from 'vue';
import { getContext } from '@/st/context';
import type { NotesSettings } from './types';
export const NOTES_SETTINGS_KEY = 'prism_book_notes_settings';
export const settingsIssue = ref('');
const defaults = (): NotesSettings => ({ enabled: false, autoGenerate: false, injectConfirmed: false, recentFloors: 8, memoryChars: 12000,
  channel: { id: 'prism-notes-independent', name: '双子札记独立 API', url: '', key: '', model: '', temperature: 0.8, maxTokens: 3000, timeoutSec: 180, stream: true, prefill: false, excludeParams: [], reasoningEffort: '' } });
export const notesSettings = reactive<NotesSettings>(defaults());
let protectedSettings = false;
const bounded = (v: unknown, fallback: number, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
function normalize(value: Partial<NotesSettings>): NotesSettings {
  const d = defaults(), c = value.channel ?? d.channel;
  return { enabled: value.enabled === true, autoGenerate: value.autoGenerate === true, injectConfirmed: value.injectConfirmed === true,
    recentFloors: Math.floor(bounded(value.recentFloors,8,1,40)), memoryChars: Math.floor(bounded(value.memoryChars,12000,1000,40000)),
    channel: { ...d.channel, url: typeof c.url === 'string' ? c.url.trim() : '', key: typeof c.key === 'string' ? c.key : '', model: typeof c.model === 'string' ? c.model.trim() : '',
      temperature: bounded(c.temperature,.8,0,2), maxTokens: Math.floor(bounded(c.maxTokens,3000,256,16000)), timeoutSec: Math.floor(bounded(c.timeoutSec,180,10,600)), stream: c.stream !== false } };
}
export function hydrateNotesSettings(): void {
  settingsIssue.value = ''; protectedSettings = false; Object.assign(notesSettings, defaults());
  const raw = getContext()?.extensionSettings?.[NOTES_SETTINGS_KEY];
  if (raw == null) return;
  if (typeof raw !== 'object' || Array.isArray(raw) || (raw as any).version !== 1 || typeof (raw as any).channel !== 'object' || !(raw as any).channel) {
    protectedSettings = true; settingsIssue.value = '札记设置格式无法识别，已只读保护，未覆盖原设置。'; return;
  }
  Object.assign(notesSettings, normalize(raw));
}
export function saveNotesSettings(): void {
  if (protectedSettings) throw new Error(settingsIssue.value);
  const ctx = getContext();
  if (!ctx?.extensionSettings || !ctx.saveSettingsDebounced) throw new Error('酒馆设置接口尚未就绪，配置未保存。');
  Object.assign(notesSettings, normalize(notesSettings));
  const previous = ctx.extensionSettings[NOTES_SETTINGS_KEY];
  if (previous != null && (typeof previous !== 'object' || (previous as any).version !== 1)) throw new Error('札记设置版本已变化，未覆盖，请刷新后检查。');
  ctx.extensionSettings[NOTES_SETTINGS_KEY] = { version: 1, ...JSON.parse(JSON.stringify(notesSettings)) };
  try { ctx.saveSettingsDebounced(); settingsIssue.value = ''; }
  catch { if (previous === undefined) delete ctx.extensionSettings[NOTES_SETTINGS_KEY]; else ctx.extensionSettings[NOTES_SETTINGS_KEY] = previous; settingsIssue.value = '札记设置保存失败，请稍后重试。'; throw new Error(settingsIssue.value); }
}
export function validateNotesChannel(): void {
  if (protectedSettings) throw new Error(settingsIssue.value);
  const c = notesSettings.channel;
  if (!c.url.trim() || !c.model.trim()) throw new Error('请先填写札记自己的 API 地址和模型；不会借用正文或摘要 API。');
  let url: URL; try { url = new URL(c.url); } catch { throw new Error('札记 API 地址无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含账号、查询参数或片段的 HTTP(S) API 地址。');
}
