import { reactive } from 'vue';
import { getContext, type STContext } from '@/st/context';
import { sourceHash } from '@/notes/source';
import { validateOutlineContent } from './protocol';
import { captureOutlineSource, sameOutlineChat, type OutlineSource } from './source';
import { renderOutlineGuidance } from './injection';
import type { OutlineActive, OutlineContent, OutlineData, OutlineDraft } from './types';

export const OUTLINE_DATA_KEY = 'prism_book_outline';
export const outlineState = reactive<{
  draft: OutlineDraft | null; active: OutlineActive | null; issue: string; revision: number; saving: boolean;
}>({ draft: null, active: null, issue: '', revision: 0, saving: false });
let loaded: OutlineSource | undefined;
let protectedData = false;
let storedFingerprint: string | undefined;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fingerprint = (value: unknown): string | undefined => {
  try { return JSON.stringify(value); } catch { return '[不可序列化的大纲数据]'; }
};

function validateRecord(value: unknown, active: boolean): OutlineDraft | OutlineActive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const keys = ['id', 'createdAt', 'sourceFloor', 'sourceHash', 'brief', 'content', ...(active ? ['enabled', 'currentChapter'] : [])];
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) throw new Error();
  const v = value as OutlineActive;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 160 || !Number.isFinite(v.createdAt) ||
      !Number.isInteger(v.sourceFloor) || v.sourceFloor < -1 || typeof v.sourceHash !== 'string' ||
      !v.sourceHash || v.sourceHash.length > 120 || typeof v.brief !== 'string' || v.brief.length > 8000) throw new Error();
  const record: OutlineDraft = { id: v.id, createdAt: v.createdAt, sourceFloor: v.sourceFloor,
    sourceHash: v.sourceHash, brief: v.brief, content: validateOutlineContent(v.content) };
  if (!active) return record;
  if (typeof v.enabled !== 'boolean' || !Number.isInteger(v.currentChapter) ||
      v.currentChapter < 0 || v.currentChapter > record.content.chapters.length) throw new Error();
  return { ...record, enabled: v.enabled, currentChapter: v.currentChapter };
}
function decode(value: unknown): OutlineData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const v = value as OutlineData;
  if (Reflect.ownKeys(value).length !== 3) throw new Error();
  if (v.version !== 1 || !('draft' in v) || !('active' in v)) throw new Error();
  return { version: 1, draft: v.draft === null ? null : validateRecord(v.draft, false) as OutlineDraft,
    active: v.active === null ? null : validateRecord(v.active, true) as OutlineActive };
}
export function loadOutline(): void {
  const ctx = getContext();
  loaded = ctx ? captureOutlineSource(ctx) : undefined;
  protectedData = false; outlineState.draft = null; outlineState.active = null; outlineState.issue = '';
  outlineState.revision++;
  const raw = ctx?.chatMetadata?.[OUTLINE_DATA_KEY];
  storedFingerprint = fingerprint(raw);
  if (raw === undefined) return;
  try { const data = decode(raw); outlineState.draft = copy(data.draft); outlineState.active = copy(data.active); }
  catch { protectedData = true; outlineState.issue = '当前聊天大纲版本或格式无法识别，已只读保护，不会覆盖原数据。'; }
}
function editable(): STContext {
  const ctx = getContext();
  if (!ctx || !ctx.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
  if (!loaded || !sameOutlineChat(loaded)) { loadOutline(); throw new Error('聊天已切换，请在当前聊天重新操作大纲。'); }
  if (protectedData) throw new Error(outlineState.issue);
  if (outlineState.saving) throw new Error('大纲正在保存，请稍后重试。');
  if (fingerprint(ctx.chatMetadata[OUTLINE_DATA_KEY]) !== storedFingerprint) {
    loadOutline(); throw new Error('大纲已在其它操作中改变，请核对重新载入的版本。');
  }
  return ctx;
}
export function outlineWriteIssue(): string {
  try { editable(); return ''; } catch (error) { return error instanceof Error ? error.message : '大纲存储不可用。'; }
}
export function outlineSourceCurrent(record: OutlineDraft): boolean {
  const ctx = getContext();
  return !!ctx && !!loaded && sameOutlineChat(loaded) && ctx.chat.length > record.sourceFloor &&
    sourceHash(ctx, record.sourceFloor) === record.sourceHash;
}
export function outlineStorageCurrent(): boolean {
  const ctx = getContext();
  return !!ctx && !!loaded && !protectedData && sameOutlineChat(loaded) &&
    fingerprint(ctx.chatMetadata[OUTLINE_DATA_KEY]) === storedFingerprint;
}
const snapshot = (): OutlineData => ({ version: 1, draft: copy(outlineState.draft), active: copy(outlineState.active) });

async function persist(next: OutlineData, ctx: STContext): Promise<void> {
  const source = captureOutlineSource(ctx), metadata = ctx.chatMetadata;
  const previous = metadata[OUTLINE_DATA_KEY], previousFingerprint = storedFingerprint;
  const written = copy(next), writtenFingerprint = fingerprint(written);
  let committed = false;
  outlineState.saving = true;
  metadata[OUTLINE_DATA_KEY] = written;
  // 状态尚未提交时，禁用当前注入，防止生成读取未持久化的启用决定。
  try {
    await ctx.saveMetadata();
    committed = true;
    if (!sameOutlineChat(source)) throw new Error('聊天已切换，请回原聊天检查大纲保存结果。');
    if (metadata[OUTLINE_DATA_KEY] !== written || fingerprint(written) !== writtenFingerprint) {
      loadOutline(); throw new Error('保存期间大纲被其它操作修改，已重新载入，请核对。');
    }
    storedFingerprint = writtenFingerprint;
    outlineState.draft = copy(next.draft); outlineState.active = copy(next.active);
    outlineState.issue = ''; outlineState.revision++;
  } catch (error) {
    // 仅恢复自己写入的那份对象；不覆盖新聊天或并发写入者。
    if (!committed && metadata[OUTLINE_DATA_KEY] === written && fingerprint(written) === writtenFingerprint) {
      if (previous === undefined) delete metadata[OUTLINE_DATA_KEY]; else metadata[OUTLINE_DATA_KEY] = previous;
      if (sameOutlineChat(source)) {
        storedFingerprint = previousFingerprint;
        outlineState.issue = '大纲保存失败，已有大纲保持不变，请重试。';
      }
    }
    if (!sameOutlineChat(source)) throw new Error('聊天已切换，请回原聊天检查大纲保存结果。');
    if (error instanceof Error && /保存期间大纲/.test(error.message)) throw error;
    throw new Error('大纲保存失败，请重试。');
  } finally { outlineState.saving = false; }
}

/** 生成链携带完整来源与revision；任何编辑/切聊/并发草稿都不会被旧回复覆盖。 */
export async function commitGeneratedOutline(draft: OutlineDraft, expectedRevision: number): Promise<void> {
  const ctx = editable();
  if (outlineState.revision !== expectedRevision || !outlineSourceCurrent(draft) || draft.sourceFloor !== ctx.chat.length - 1)
    throw new Error('聊天、正文或大纲已经变化，旧生成结果未采用。');
  const next = snapshot(); next.draft = validateRecord(draft, false) as OutlineDraft;
  await persist(next, ctx);
}
export async function saveOutlineDraft(content: OutlineContent, brief: string, expectedRevision: number): Promise<void> {
  const ctx = editable();
  if (outlineState.revision !== expectedRevision) throw new Error('大纲版本已变化，请重新载入后编辑。');
  if (typeof brief !== 'string' || brief.length > 8000) throw new Error('创作要求最多8000字。');
  const next = snapshot();
  next.draft = { id: crypto.randomUUID(), createdAt: Date.now(), sourceFloor: ctx.chat.length - 1,
    sourceHash: sourceHash(ctx, ctx.chat.length - 1), brief: brief.trim(), content: validateOutlineContent(content) };
  await persist(next, ctx);
}
export async function activateOutlineDraft(expectedDraftId: string): Promise<void> {
  const ctx = editable(), draft = outlineState.draft;
  if (!draft || draft.id !== expectedDraftId) throw new Error('待启用草稿已改变，请重新核对后确认。');
  if (!outlineSourceCurrent(draft)) throw new Error('草稿参考的历史正文已变化，请核对并重新保存草稿后再启用。');
  const next = snapshot(); next.active = { ...copy(draft), currentChapter: 0, enabled: true };
  renderOutlineGuidance(next.active);
  await persist(next, ctx);
}
export async function setOutlineEnabled(enabled: boolean): Promise<void> {
  const ctx = editable(); if (!outlineState.active) throw new Error('请先确认启用一份大纲。');
  const next = snapshot(); const active = next.active!;
  if (enabled && !outlineSourceCurrent(active)) throw new Error('参考正文已变化，请先核对后重新启用。');
  if (enabled && active.currentChapter >= active.content.chapters.length) throw new Error('大纲已结束，请先选择要继续的章节。');
  active.enabled = enabled;
  renderOutlineGuidance(active);
  await persist(next, ctx);
}
export async function setOutlineChapter(index: number): Promise<void> {
  const ctx = editable(); const next = snapshot(); const active = next.active;
  if (!active || !Number.isInteger(index) || index < 0 || index > active.content.chapters.length) throw new Error('大纲章节序号无效。');
  // 历史失效后不因切章自动恢复；末章结束只改变规划进度，不写剧情事实。
  if (!outlineSourceCurrent(active) || index === active.content.chapters.length) active.enabled = false;
  active.currentChapter = index;
  renderOutlineGuidance(active);
  await persist(next, ctx);
}
export async function reconfirmOutline(): Promise<void> {
  const ctx = editable(); const next = snapshot(); const active = next.active;
  if (!active || active.currentChapter >= active.content.chapters.length) throw new Error('没有可重新启用的当前章节。');
  active.sourceFloor = ctx.chat.length - 1; active.sourceHash = sourceHash(ctx, active.sourceFloor); active.enabled = true;
  renderOutlineGuidance(active);
  await persist(next, ctx);
}
