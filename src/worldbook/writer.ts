/**
 * 写入与撤销。
 * - 写入前重新读取这本书，按内容指纹核对目标条目仍是建议所依据的内容；条目已改动或已删除时标为冲突，不写入。
 * - 只改动建议涉及的字段（内容、关键词；新建条目用酒馆的条目模板），其余条目和字段原样保留。
 * - 用酒馆原生接口立即保存，再刷新世界书编辑器；保存后向服务器读取核对。
 * - 撤销：条目自写入后没被改过才恢复原样（新建的条目则删除）；被改过就说明原因，不硬覆盖。
 */
import { reactive } from 'vue';
import { worldbookSettings } from './settings';
import { entryTemplate, fetchServerCopy, freeUid, loadBook, NO_TEMPLATE_MESSAGE, refreshWorldHost, removeOriginalData, saveBook, syncOriginalData, worldHost } from './host';
import { editableContext, recordApplied, recordUndone, worldbookState } from './store';
import { captureChat, rangeCurrent, sameChat } from './source';
import { KIND_LABELS, permissionBlock } from './protocol';
import { appendText, entryBase, entryContent, entryKeys, entrySignature, entryTitle, findEntry, keyForm, listEntries, occurrences, rawKeys, sameSnapshot, snapshot } from './entries';
import type { AppliedRecord, Suggestion, SuggestionBatch, WorldData, WorldEntry, WriteKind } from './types';

export const writerState = reactive({ busy: false });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function missingBookMessage(book: string): string {
  return '世界书「' + book + '」不存在：可能已被删除或改名。请在本页「写入目标」中重新选择世界书；这批建议是按原来那本书生成的，可以忽略后重新生成。';
}

/** 冲突原因：建议不能按原样写入时返回说明，否则返回空串。界面显示与写入共用。 */
export function suggestionConflict(s: Suggestion, data: WorldData): string {
  if (s.kind === 'create') {
    const same = listEntries(data).find(e => entryTitle(e).toLowerCase() === s.title.trim().toLowerCase());
    if (!same) return '';
    return entryContent(same).trim() === s.content.trim()
      ? '世界书中已有相同的条目（uid ' + same.uid + '），可能已经写入过。'
      : '世界书中已有同名条目「' + entryTitle(same) + '」（uid ' + same.uid + '）。';
  }
  const found = findEntry(data, s.uid ?? -1);
  if (!found) return '条目 uid ' + s.uid + ' 已不在世界书中（可能已被删除）。';
  if (entryBase(found.entry) !== s.base) return '条目自建议生成后已被修改，为避免覆盖，不能按这条建议写入。可以忽略，或重新生成建议。';
  if (s.kind === 'replace' && occurrences(entryContent(found.entry), s.find) !== 1) return '条目中找不到要替换的原文，或这段原文不止一处。';
  return '';
}

/** 新增的关键词（条目中已有的不重复添加，不区分大小写）。 */
export function newKeys(entry: WorldEntry | null, keys: string[]): string[] {
  const seen = new Set((entry ? entryKeys(entry) : []).map(keyForm));
  const out: string[] = [];
  for (const k of keys) { const v = k.trim(); if (v && !seen.has(keyForm(v))) { seen.add(keyForm(v)); out.push(v); } }
  return out;
}

/** 写入后的内容（不修改传入的条目）。 */
export function changedContent(s: Suggestion, current: string): string {
  if (s.kind === 'append') return appendText(current, s.content);
  if (s.kind === 'rewrite') return s.content;
  if (s.kind === 'replace') {
    const at = current.indexOf(s.find);
    return at < 0 ? current : current.slice(0, at) + s.content + current.slice(at + s.find.length);
  }
  return current;
}

/** 改前改后预览：before 为当前条目内容（新建为空），after 为写入后的内容。 */
export function previewChange(s: Suggestion, data: WorldData | null): { before: string; after: string; keys: string[]; entry: WorldEntry | null } {
  if (s.kind === 'create') return { before: '', after: s.content, keys: s.keys, entry: null };
  const entry = data ? findEntry(data, s.uid ?? -1)?.entry ?? null : null;
  const before = entry ? entryContent(entry) : '';
  return { before, after: entry ? changedContent(s, before) : '', keys: newKeys(entry, s.keys), entry };
}

class Conflict extends Error {}

function buildRecord(batch: SuggestionBatch, s: Suggestion, uid: number, title: string, before: AppliedRecord['before'], entry: WorldEntry, at: number): AppliedRecord {
  return {
    id: crypto.randomUUID(), at, book: batch.book, batchId: batch.id, suggestionId: s.id, kind: s.kind as WriteKind, uid,
    title: title.length > 200 ? title.slice(0, 199) + '…' : title, before, after: snapshot(entry), signature: entrySignature(entry), source: { ...batch.source }, undoneAt: null,
  };
}

/** 把一条建议写进内存中的世界书数据；冲突时抛出 Conflict。 */
function applyOne(data: WorldData, s: Suggestion, batch: SuggestionBatch, template: Record<string, unknown> | null, at: number): AppliedRecord {
  const conflict = suggestionConflict(s, data);
  if (conflict) throw new Conflict(conflict);
  if (s.kind === 'create') {
    if (!template) throw new Error(NO_TEMPLATE_MESSAGE);
    const uid = freeUid(data);
    if (uid === null) throw new Error('这本世界书找不到可用的 uid，没有新建。');
    const defaults = worldbookSettings.newEntry;
    const entry: WorldEntry = { ...clone(template), uid, comment: s.title, content: s.content, key: [...s.keys], addMemo: true, position: defaults.position, order: defaults.order };
    if (defaults.position === 4) entry.depth = defaults.depth;
    data.entries[String(uid)] = entry;
    return buildRecord(batch, s, uid, s.title, null, entry, at);
  }
  const found = findEntry(data, s.uid!)!;
  const entry = found.entry, uid = Number(entry.uid);
  const before = snapshot(entry);
  const content = changedContent(s, entryContent(entry));
  if (content !== entryContent(entry)) { entry.content = content; syncOriginalData(data, uid, 'content', content); }
  const added = newKeys(entry, s.keys);
  if (added.length) { entry.key = [...rawKeys(entry), ...added]; syncOriginalData(data, uid, 'keys', entry.key); }
  return buildRecord(batch, s, uid, entryTitle(entry) || s.title, before, entry, at);
}

/** 保存后向服务器读取核对：true 一致，false 不一致，null 无法核对。 */
async function verify(book: string, check: (data: WorldData) => boolean): Promise<boolean | null> {
  const copy = await fetchServerCopy(book);
  if (!copy) { console.warn('[棱镜宝书] 世界书保存后未能向服务器读取核对：' + book); return null; }
  return check(copy);
}

export interface ApplyIssue { id: string; title: string; reason: string; conflict: boolean }
export interface ApplyOutcome { applied: string[]; issues: ApplyIssue[]; verified: boolean | null }

async function exclusive<T>(task: () => Promise<T>): Promise<T> {
  if (writerState.busy) throw new Error('正在写入世界书，请稍等。');
  writerState.busy = true;
  try { return await task(); } finally { writerState.busy = false; }
}

/**
 * 应用一批中的若干条建议：一次读取、一次保存。返回已应用的建议和未应用的原因。
 * 依据的楼层被改写、重抽或删除后（批次失效），默认不应用；用户核对后选择「仍然应用」时传 allowStale。
 */
export function applySuggestions(batchId: string, ids: string[], opts: { allowStale?: boolean } = {}): Promise<ApplyOutcome> {
  return exclusive(async () => {
    const ctx = editableContext();
    const identity = captureChat(ctx);
    const batch = worldbookState.batches.find(b => b.id === batchId);
    if (!batch) throw new Error('找不到这批建议，可能已经被清理。');
    const wanted = batch.suggestions.filter(s => ids.includes(s.id) && s.status === 'pending' && s.kind !== 'flag');
    if (!wanted.length) throw new Error('没有可以应用的建议。');
    if (!opts.allowStale && !rangeCurrent(batch.source, ctx)) throw new Error('这批建议依据的楼层（第 ' + batch.source.from + '–' + batch.source.to + ' 楼）已被改写、重抽或删除。请核对建议内容后点「仍然应用」，或点「从第 ' + batch.source.from + ' 楼重新读取」后重新生成。');
    const issues: ApplyIssue[] = [];
    const allowed = wanted.filter(s => {
      const blocked = permissionBlock(s.kind, worldbookSettings.permission);
      if (blocked) issues.push({ id: s.id, title: s.title, reason: blocked, conflict: false });
      return !blocked;
    });
    if (!allowed.length) return { applied: [], issues, verified: null };
    await refreshWorldHost();
    if (worldHost.names && !worldHost.names.includes(batch.book)) throw new Error(missingBookMessage(batch.book));
    const data = await loadBook(batch.book);
    if (!data) throw new Error(missingBookMessage(batch.book));
    const template = allowed.some(s => s.kind === 'create') ? await entryTemplate() : null;
    const records: AppliedRecord[] = [];
    const at = Date.now();
    for (const s of allowed) {
      try { records.push(applyOne(data, s, batch, template, at)); }
      catch (error) { issues.push({ id: s.id, title: s.title, reason: error instanceof Error ? error.message : '没有写入。', conflict: error instanceof Conflict }); }
    }
    if (!records.length) return { applied: [], issues, verified: null };
    if (!sameChat(identity)) throw new Error('聊天已经切换，没有写入。');
    await saveBook(batch.book, data);
    const verified = await verify(batch.book, copy => records.every(r => { const e = findEntry(copy, r.uid)?.entry; return !!e && sameSnapshot(e, r.after); }));
    void refreshWorldHost();
    if (verified === false) throw new Error('世界书「' + batch.book + '」保存后核对未通过：服务器上的内容与写入的不一致，可能没有保存成功。请刷新酒馆页面后在世界书面板中检查条目，再决定是否重新应用。');
    if (!sameChat(identity)) throw new Error('世界书已经写入，但聊天已经切换，写入记录没有保存到原聊天；请在酒馆的世界书面板中核对。');
    await recordApplied(batch.id, records);
    return { applied: records.map(r => r.suggestionId), issues, verified };
  });
}

/** 撤销一次写入。返回结果说明；不能撤销时抛出原因。 */
export function undoApplied(recordId: string): Promise<string> {
  return exclusive(async () => {
    const ctx = editableContext();
    const identity = captureChat(ctx);
    const record = worldbookState.applied.find(r => r.id === recordId);
    if (!record) throw new Error('找不到这条写入记录。');
    if (record.undoneAt !== null) throw new Error('这次写入已经撤销过。');
    // 写入记录按时间先后追加;同一毫秒内的两次写入按记录顺序区分先后,不能当成同时。
    const index = worldbookState.applied.indexOf(record);
    const later = worldbookState.applied.find((r, i) => r.id !== record.id && r.book === record.book && r.uid === record.uid && r.undoneAt === null
      && (r.at > record.at || (r.at === record.at && i > index)));
    if (later) throw new Error('这个条目之后还有一次写入（' + KIND_LABELS[later.kind] + '），请先撤销较新的那次。');
    await refreshWorldHost();
    if (worldHost.names && !worldHost.names.includes(record.book)) throw new Error('世界书「' + record.book + '」不存在：可能已被删除或改名，无法撤销。');
    const data = await loadBook(record.book);
    if (!data) throw new Error('读不到世界书「' + record.book + '」，可能已被删除或改名，无法撤销。');
    const found = findEntry(data, record.uid);
    let message: string;
    if (record.kind === 'create') {
      if (!found) {
        await recordUndone(record.id);
        return '条目「' + record.title + '」已不在世界书中（可能已手动删除），记录已标为撤销。';
      }
      if (entrySignature(found.entry) !== record.signature) throw new Error('条目「' + record.title + '」在写入后被修改过（内容、关键词、位置或开关等），没有删除，以免丢掉之后的修改。如需删除，请在酒馆的世界书面板中操作。');
      delete data.entries[found.key];
      removeOriginalData(data, record.uid);
      message = '已撤销：删除了新建的条目「' + record.title + '」。';
    } else {
      if (!found) throw new Error('条目 uid ' + record.uid + ' 已不在世界书中，无法撤销。');
      if (!sameSnapshot(found.entry, record.after)) throw new Error('条目「' + record.title + '」在写入后被修改过（内容或关键词与写入时不同），没有撤销，以免覆盖之后的修改。');
      const before = record.before!;
      found.entry.content = before.content;
      found.entry.key = [...before.key];
      syncOriginalData(data, record.uid, 'content', before.content);
      syncOriginalData(data, record.uid, 'keys', before.key);
      message = '已撤销：条目「' + record.title + '」恢复到写入前的内容。';
    }
    if (!sameChat(identity)) throw new Error('聊天已经切换，没有撤销。');
    await saveBook(record.book, data);
    const verified = await verify(record.book, copy => {
      const e = findEntry(copy, record.uid)?.entry;
      return record.kind === 'create' ? !e : !!e && sameSnapshot(e, record.before!);
    });
    void refreshWorldHost();
    if (verified === false) throw new Error('世界书「' + record.book + '」保存后核对未通过：服务器上的内容与撤销后的不一致，可能没有保存成功。请刷新酒馆页面后在世界书面板中检查。');
    if (sameChat(identity)) await recordUndone(record.id);
    return message;
  });
}
