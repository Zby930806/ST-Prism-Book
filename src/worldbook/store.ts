/**
 * 每个聊天的世界书建议数据：存在聊天元数据的 prism_book_worldbook（第 1 版）。
 * 严格校验；认不出的格式只读保护，不覆盖原数据。只替换自己的键；所有修改排队执行，互不覆盖。
 */
import { reactive } from 'vue';
import { getContext, type STContext } from '@/st/context';
import { WB_LIMITS } from './limits';
import type { AppliedRecord, EntrySnapshot, SourceRange, Suggestion, SuggestionBatch, SuggestionKind, SuggestionStatus, WorldbookChatData, WorldbookPermission } from './types';
import { captureChat, rangeCurrent, sameChat, type ChatIdentity } from './source';

export const WORLDBOOK_DATA_KEY = 'prism_book_worldbook';
/**
 * pruneNotice：保存新批次时因超出 20 批而删掉了仍有效的待审核建议，说明删了哪一批（只记在内存里，下一次生成或切换聊天时清除）。
 */
export const worldbookState = reactive<{
  target: string | null; cursor: WorldbookChatData['cursor']; batches: SuggestionBatch[]; applied: AppliedRecord[];
  issue: string; saveWarning: string; pruneNotice: string; revision: number; saving: boolean;
}>({ target: null, cursor: null, batches: [], applied: [], issue: '', saveWarning: '', pruneNotice: '', revision: 0, saving: false });

let loaded: ChatIdentity | undefined;
let protectedData = false;
let queue: Promise<unknown> = Promise.resolve();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const KINDS = new Set<SuggestionKind>(['create', 'append', 'replace', 'rewrite', 'keys', 'flag']);
const STATUSES = new Set<SuggestionStatus>(['pending', 'applied', 'ignored', 'undone']);
const PERMISSIONS = new Set<WorldbookPermission>(['create', 'supplement', 'modify']);
const str = (v: unknown, max = Infinity): v is string => typeof v === 'string' && v.length <= max;
const nonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function exactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
}
const strList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => str(x, 200));
const range = (v: unknown): v is SourceRange => plain(v) && exactKeys(v, ['from', 'to', 'hash']) && nonNegInt(v.from) && nonNegInt(v.to) && v.from <= v.to && str(v.hash, 120) && !!v.hash;
// 条目快照照搬原条目，标题、内容和关键词不限长度（用户的条目可能很长）
const entrySnap = (v: unknown): v is EntrySnapshot => plain(v) && exactKeys(v, ['comment', 'content', 'key']) && str(v.comment) && str(v.content)
  && Array.isArray(v.key) && v.key.length <= 1000 && v.key.every(k => typeof k === 'string');

function validSuggestion(v: unknown): v is Suggestion {
  if (!plain(v) || !exactKeys(v, ['id', 'kind', 'uid', 'title', 'keys', 'content', 'find', 'reason', 'floors', 'base', 'status', 'edited', 'warnings'])) return false;
  if (!str(v.id, 80) || !v.id || !KINDS.has(v.kind as SuggestionKind) || !STATUSES.has(v.status as SuggestionStatus)) return false;
  if (v.kind === 'create' ? v.uid !== null : !nonNegInt(v.uid)) return false;
  return str(v.title, 200) && strList(v.keys, WB_LIMITS.keys * 2) && str(v.content, 20000) && str(v.find, 5000) && str(v.reason, 2000)
    && Array.isArray(v.floors) && v.floors.length <= WB_LIMITS.floors && v.floors.every(nonNegInt) && str(v.base, 120)
    && typeof v.edited === 'boolean' && strList(v.warnings, 20);
}
function validBatch(v: unknown): v is SuggestionBatch {
  if (!plain(v) || !exactKeys(v, ['id', 'createdAt', 'auto', 'book', 'permission', 'source', 'suggestions', 'dropped'])) return false;
  if (!str(v.id, 80) || !v.id || !Number.isFinite(v.createdAt) || typeof v.auto !== 'boolean' || !str(v.book, 300) || !v.book || !PERMISSIONS.has(v.permission as WorldbookPermission) || !range(v.source)) return false;
  if (!Array.isArray(v.suggestions) || v.suggestions.length > WB_LIMITS.actions || !v.suggestions.every(validSuggestion)) return false;
  if (new Set(v.suggestions.map(s => s.id)).size !== v.suggestions.length) return false;
  return Array.isArray(v.dropped) && v.dropped.length <= 50 && v.dropped.every(d => plain(d) && exactKeys(d, ['label', 'reason']) && str(d.label, 300) && str(d.reason, 600));
}
function validRecord(v: unknown): v is AppliedRecord {
  if (!plain(v) || !exactKeys(v, ['id', 'at', 'book', 'batchId', 'suggestionId', 'kind', 'uid', 'title', 'before', 'after', 'signature', 'source', 'undoneAt'])) return false;
  return str(v.id, 80) && !!v.id && Number.isFinite(v.at) && str(v.book, 300) && !!v.book && str(v.batchId, 80) && str(v.suggestionId, 80)
    && KINDS.has(v.kind as SuggestionKind) && v.kind !== 'flag' && nonNegInt(v.uid) && str(v.title, 200)
    && (v.kind === 'create' ? v.before === null : entrySnap(v.before)) && entrySnap(v.after) && str(v.signature, 120)
    && range(v.source) && (v.undoneAt === null || Number.isFinite(v.undoneAt));
}
export function validWorldbookData(v: unknown): v is WorldbookChatData {
  if (!plain(v) || !exactKeys(v, ['version', 'target', 'cursor', 'batches', 'applied']) || v.version !== 1) return false;
  if (!(v.target === null || (str(v.target, 300) && !!v.target))) return false;
  if (!(v.cursor === null || (plain(v.cursor) && exactKeys(v.cursor, ['floor', 'hash']) && str(v.cursor.hash, 120) && !!v.cursor.hash
    && (nonNegInt(v.cursor.floor) || (v.cursor.floor === -1 && v.cursor.hash === 'start'))))) return false;
  if (!Array.isArray(v.batches) || v.batches.length > WB_LIMITS.batches || !v.batches.every(validBatch)) return false;
  if (new Set(v.batches.map(b => b.id)).size !== v.batches.length) return false;
  if (!Array.isArray(v.applied) || v.applied.length > WB_LIMITS.applied || !v.applied.every(validRecord)) return false;
  return new Set(v.applied.map(r => r.id)).size === v.applied.length;
}

export function loadWorldbookData(): void {
  const ctx = getContext();
  loaded = ctx ? captureChat(ctx) : undefined;
  protectedData = false;
  Object.assign(worldbookState, { target: null, cursor: null, batches: [], applied: [], issue: '', saveWarning: '', pruneNotice: '' });
  worldbookState.revision++;
  const raw = ctx?.chatMetadata?.[WORLDBOOK_DATA_KEY];
  if (raw == null) return;
  if (!validWorldbookData(raw)) {
    protectedData = true;
    worldbookState.issue = '这个聊天的世界书建议数据格式认不出来，已只读保护，不会覆盖原数据。可能是较新版本的宝书写入的，请更新宝书后再查看。';
    return;
  }
  const data = clone(raw);
  Object.assign(worldbookState, { target: data.target, cursor: data.cursor, batches: data.batches, applied: data.applied });
}

/** 可以写入时返回聊天上下文；否则抛出原因。切换聊天后自动重新载入。 */
export function editableContext(): STContext {
  const ctx = getContext();
  if (!ctx || !ctx.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
  if (!loaded || !sameChat(loaded)) loadWorldbookData();
  if (protectedData) throw new Error(worldbookState.issue);
  return ctx;
}
export function worldbookWriteIssue(): string {
  try { editableContext(); return ''; } catch (error) { return error instanceof Error ? error.message : '世界书建议数据暂时不能保存。'; }
}
export function worldbookDataProtected(): boolean { return protectedData; }

function snapshotData(): WorldbookChatData {
  return { version: 1, target: worldbookState.target, cursor: clone(worldbookState.cursor), batches: clone(worldbookState.batches), applied: clone(worldbookState.applied) };
}

/**
 * 超出上限时依次删除：依据楼层已失效的批次（最早的先删）、已全部处理完的批次、最早的批次。
 * 删掉仍有效的待审核建议时返回说明（删了哪一批），由页面显示。写入记录先删已撤销的，再删最早的。
 */
function prune(next: WorldbookChatData, ctx: STContext): string {
  const notices: string[] = [];
  while (next.batches.length > WB_LIMITS.batches) {
    let index = next.batches.findIndex(b => !rangeCurrent(b.source, ctx));
    if (index < 0) index = next.batches.findIndex(b => !b.suggestions.some(s => s.status === 'pending'));
    if (index < 0) {
      index = 0;
      const b = next.batches[0], pending = b.suggestions.filter(s => s.status === 'pending').length;
      notices.push('第 ' + b.source.from + '–' + b.source.to + ' 楼的一批（' + pending + ' 条待审核）');
    }
    next.batches.splice(index, 1);
  }
  while (next.applied.length > WB_LIMITS.applied) {
    const index = next.applied.findIndex(r => r.undoneAt !== null);
    next.applied.splice(index >= 0 ? index : 0, 1);
  }
  return notices.length ? '建议批次超过 ' + WB_LIMITS.batches + ' 批，删除了最早的' + notices.join('、') + '。请及时处理待审核的建议。' : '';
}

/**
 * 保存：只替换自己的键。keepOnFailure 用于世界书已经写入之后的记录——保存失败时不回滚，
 * 数据留在聊天元数据里（酒馆下次保存聊天时一并保存），并提示用户。
 */
async function persist(next: WorldbookChatData, ctx: STContext, keepOnFailure = false): Promise<void> {
  if (!loaded || !sameChat(loaded)) throw new Error('聊天已经切换，这次操作没有保存。');
  const pruned = prune(next, ctx);
  if (!validWorldbookData(next)) throw new Error('世界书建议数据校验未通过，这次操作没有保存。');
  const identity = loaded, metadata = ctx.chatMetadata, previous = metadata[WORLDBOOK_DATA_KEY];
  const written = clone(next);
  metadata[WORLDBOOK_DATA_KEY] = written;
  worldbookState.saving = true;
  const apply = () => {
    if (!sameChat(identity)) return;
    Object.assign(worldbookState, { target: next.target, cursor: clone(next.cursor), batches: clone(next.batches), applied: clone(next.applied) });
    if (pruned) worldbookState.pruneNotice = pruned;
    worldbookState.revision++;
  };
  try {
    await ctx.saveMetadata();
    apply();
    worldbookState.saveWarning = '';
  } catch {
    if (keepOnFailure) {
      apply();
      worldbookState.saveWarning = '世界书已经写入，但写入记录没有保存到聊天（记录仍在当前页面中，酒馆下次保存聊天时会一并保存）。刷新页面前如需撤销，请在这里操作。';
      return;
    }
    if (metadata[WORLDBOOK_DATA_KEY] === written) {
      if (previous === undefined) delete metadata[WORLDBOOK_DATA_KEY]; else metadata[WORLDBOOK_DATA_KEY] = previous;
    }
    throw new Error('世界书建议数据保存失败，这次操作没有完成，请重试。');
  } finally {
    worldbookState.saving = false;
  }
}

/** 修改排队执行：每次在执行时取最新状态，避免两个保存互相覆盖。 */
function mutate<T>(change: (next: WorldbookChatData, ctx: STContext) => T, opts: { keepOnFailure?: boolean } = {}): Promise<T> {
  const run = async () => {
    const ctx = editableContext();
    const next = snapshotData();
    const result = change(next, ctx);
    await persist(next, ctx, opts.keepOnFailure);
    return result;
  };
  const task = queue.then(run, run);
  queue = task.catch(() => undefined);
  return task;
}

export function setTarget(target: string | null): Promise<void> {
  return mutate(next => { next.target = target && target.trim() ? target.trim() : null; });
}
export function setCursor(cursor: WorldbookChatData['cursor']): Promise<void> {
  return mutate(next => { next.cursor = cursor ? { ...cursor } : null; });
}
/** 保存一批建议并推进处理进度。 */
export function commitBatch(batch: SuggestionBatch, cursor: WorldbookChatData['cursor']): Promise<void> {
  return mutate(next => {
    next.batches.push(clone(batch));
    if (cursor) next.cursor = { ...cursor };
  });
}
function findSuggestion(next: WorldbookChatData, batchId: string, id: string): { batch: SuggestionBatch; suggestion: Suggestion } {
  const batch = next.batches.find(b => b.id === batchId);
  const suggestion = batch?.suggestions.find(s => s.id === id);
  if (!batch || !suggestion) throw new Error('找不到这条建议，可能已经被清理。');
  return { batch, suggestion };
}
export function setSuggestionStatus(batchId: string, ids: string[], status: SuggestionStatus, from: SuggestionStatus[] = ['pending']): Promise<number> {
  return mutate(next => {
    let count = 0;
    for (const id of ids) {
      const { suggestion } = findSuggestion(next, batchId, id);
      if (from.includes(suggestion.status)) { suggestion.status = status; count++; }
    }
    return count;
  });
}
/** 保存用户编辑后的建议内容（只改内容字段，不改动作和目标）。 */
export function saveSuggestionEdit(batchId: string, id: string, patch: Pick<Suggestion, 'title' | 'keys' | 'content' | 'find'>): Promise<void> {
  return mutate(next => {
    const { suggestion } = findSuggestion(next, batchId, id);
    if (suggestion.status !== 'pending') throw new Error('这条建议已经处理过，不能再编辑。');
    Object.assign(suggestion, clone(patch), { edited: true });
  });
}
/** 记下已写入的改动，并把对应建议标为已应用。世界书已经写入，保存失败也不回滚。 */
export function recordApplied(batchId: string, records: AppliedRecord[]): Promise<void> {
  return mutate(next => {
    for (const record of records) {
      const { suggestion } = findSuggestion(next, batchId, record.suggestionId);
      suggestion.status = 'applied';
      next.applied.push(clone(record));
    }
  }, { keepOnFailure: true });
}
/** 撤销完成后标记记录与建议。世界书已经恢复，保存失败也不回滚。 */
export function recordUndone(recordId: string): Promise<void> {
  return mutate(next => {
    const record = next.applied.find(r => r.id === recordId);
    if (!record) throw new Error('找不到这条写入记录。');
    record.undoneAt = Date.now();
    const suggestion = next.batches.find(b => b.id === record.batchId)?.suggestions.find(s => s.id === record.suggestionId);
    if (suggestion && suggestion.status === 'applied') suggestion.status = 'undone';
  }, { keepOnFailure: true });
}
/** 删除已全部处理完的批次（写入记录保留）。 */
export function clearHandledBatches(): Promise<number> {
  return mutate(next => {
    const before = next.batches.length;
    next.batches = next.batches.filter(b => b.suggestions.some(s => s.status === 'pending'));
    return before - next.batches.length;
  });
}
