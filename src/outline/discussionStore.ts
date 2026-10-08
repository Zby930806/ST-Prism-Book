import { reactive } from 'vue';
import { getContext, type STContext } from '@/st/context';
import { captureOutlineSource, outlineInputUnchanged, sameOutlineChat, type OutlineSource } from './source';

export type DiscussionMessage = { role: 'user' | 'assistant'; content: string };
export const DISCUSSION_DATA_KEY = 'prism_book_outline_discussion';
export const discussionState = reactive<{
  messages: DiscussionMessage[]; revision: number; saving: boolean; issue: string;
}>({ messages: [], revision: 0, saving: false, issue: '' });

type DiscussionData = { version: 1; messages: DiscussionMessage[] };
type Pending = { written: DiscussionData; fingerprint: string | undefined; previous: unknown; hadPrevious: boolean };
const pending = new WeakMap<STContext['chatMetadata'], Pending>();
let loaded: OutlineSource | undefined;
let storedFingerprint: string | undefined;
let protectedData = false;
// 不把公开 reactive 对象作为下一次写入的数据源，避免视图意外修改持久化历史。
let messages: DiscussionMessage[] = [];
const copyMessages = (value: DiscussionMessage[]) => value.map(message => ({ ...message }));
const fingerprint = (value: unknown): string | undefined => {
  try { return JSON.stringify(value); } catch { return '[不可序列化的讨论数据]'; }
};
const owns = (record: Pending, metadata: STContext['chatMetadata']): boolean => {
  if (metadata[DISCUSSION_DATA_KEY] !== record.written || fingerprint(record.written) !== record.fingerprint) return false;
  try { decode(record.written); return true; } catch { return false; }
};
const READ_ONLY = '当前聊天讨论版本或格式无法识别，已只读保护，不会覆盖原数据。';
const SAVE_FAILED = '讨论保存失败，已有记录保持不变，请重试。';
const CHAT_CHANGED = '聊天已切换，请回原聊天检查讨论保存结果。';
const SESSION_CHANGED = '讨论已重新载入，请核对当前聊天的保存结果。';
const CONFLICT = '保存期间讨论被其它操作修改，已重新载入，请核对。';
class DiscussionError extends Error {}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function validContent(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= limit && !!value.trim();
}
function decode(value: unknown): DiscussionData {
  if (!exactKeys(value, ['version', 'messages']) || value.version !== 1 || !Array.isArray(value.messages))
    throw new DiscussionError(READ_ONLY);
  const raw = value.messages;
  if (raw.length > 24 || raw.length % 2 !== 0 || Reflect.ownKeys(raw).length !== raw.length + 1)
    throw new DiscussionError(READ_ONLY);
  const decoded: DiscussionMessage[] = [];
  let total = 0;
  for (let index = 0; index < raw.length; index++) {
    const message: unknown = raw[index], role = index % 2 === 0 ? 'user' : 'assistant';
    if (!exactKeys(message, ['role', 'content']) || message.role !== role ||
        !validContent(message.content, role === 'user' ? 4000 : 8000)) throw new DiscussionError(READ_ONLY);
    total += message.content.length;
    if (total > 48000) throw new DiscussionError(READ_ONLY);
    decoded.push({ role, content: message.content });
  }
  return { version: 1, messages: decoded };
}

/** 兼容尚无 sidecar 的旧聊天；读取永远不迁移、不保存、不改旧大纲 key。 */
export function loadOutlineDiscussion(): void {
  const ctx = getContext();
  loaded = ctx ? captureOutlineSource(ctx) : undefined;
  protectedData = false;
  messages = [];
  discussionState.messages = [];
  discussionState.issue = '';
  discussionState.revision++;
  const inFlight = ctx && pending.get(ctx.chatMetadata);
  discussionState.saving = !!inFlight;
  // saveMetadata 尚未成功时，重载也不能把临时写入 metadata 的记录展示为已保存。
  const raw = ctx && inFlight && owns(inFlight, ctx.chatMetadata)
    ? inFlight.previous : ctx?.chatMetadata?.[DISCUSSION_DATA_KEY];
  storedFingerprint = fingerprint(raw);
  if (raw === undefined) return;
  try {
    messages = decode(raw).messages;
    discussionState.messages = copyMessages(messages);
  } catch {
    protectedData = true;
    discussionState.issue = READ_ONLY;
  }
}

function editable(): STContext {
  const ctx = getContext();
  if (!ctx || !ctx.getCurrentChatId()) throw new DiscussionError('请先打开一个已保存的聊天。');
  if (!loaded || !sameOutlineChat(loaded)) {
    loadOutlineDiscussion();
    throw new DiscussionError('聊天已切换，请在当前聊天重新操作讨论。');
  }
  if (protectedData) throw new DiscussionError(READ_ONLY);
  if (pending.has(ctx.chatMetadata)) throw new DiscussionError('讨论正在保存，请稍后重试。');
  const raw = ctx.chatMetadata[DISCUSSION_DATA_KEY];
  let invalid = false;
  // JSON fingerprint 不包含 symbol / 不可枚举字段，仍须检查当前值的严格 schema。
  try { if (raw !== undefined) decode(raw); } catch { invalid = true; }
  if (invalid || fingerprint(raw) !== storedFingerprint) {
    loadOutlineDiscussion();
    throw new DiscussionError('讨论已在其它操作中改变，请核对重新载入的版本。');
  }
  return ctx;
}
export function discussionWriteIssue(): string {
  try { editable(); return ''; }
  catch (error) { return error instanceof DiscussionError ? error.message : '讨论存储不可用。'; }
}

async function persist(next: DiscussionData, ctx: STContext): Promise<void> {
  const source = captureOutlineSource(ctx), session = loaded, revision = discussionState.revision;
  const metadata = ctx.chatMetadata, previousFingerprint = storedFingerprint;
  const record: Pending = {
    written: { version: 1, messages: copyMessages(next.messages) }, fingerprint: undefined,
    previous: metadata[DISCUSSION_DATA_KEY],
    hadPrevious: Object.prototype.hasOwnProperty.call(metadata, DISCUSSION_DATA_KEY),
  };
  record.fingerprint = fingerprint(record.written);
  const currentSession = () => sameOutlineChat(source) && loaded === session && discussionState.revision === revision;
  let committed = false;
  pending.set(metadata, record);
  discussionState.saving = true;
  try {
    metadata[DISCUSSION_DATA_KEY] = record.written;
    await ctx.saveMetadata();
    committed = true;
    if (!sameOutlineChat(source)) throw new DiscussionError(CHAT_CHANGED);
    if (!currentSession()) throw new DiscussionError(SESSION_CHANGED);
    if (!owns(record, metadata)) {
      pending.delete(metadata);
      loadOutlineDiscussion();
      throw new DiscussionError(CONFLICT);
    }
    storedFingerprint = record.fingerprint;
    messages = copyMessages(next.messages);
    discussionState.messages = copyMessages(messages);
    discussionState.issue = '';
    discussionState.revision++;
  } catch (error) {
    // 只回滚自己仍持有的临时值，绝不覆盖并发写入者，也不读可变 ctx 的新 metadata。
    if (!committed && owns(record, metadata)) {
      if (record.hadPrevious) metadata[DISCUSSION_DATA_KEY] = record.previous;
      else delete metadata[DISCUSSION_DATA_KEY];
      if (currentSession()) {
        storedFingerprint = previousFingerprint;
        discussionState.issue = SAVE_FAILED;
      }
    }
    if (committed && error instanceof DiscussionError) throw error;
    if (!sameOutlineChat(source)) throw new DiscussionError(CHAT_CHANGED);
    if (!currentSession()) throw new DiscussionError(SESSION_CHANGED);
    discussionState.issue = SAVE_FAILED;
    // 宿主异常可能含 API key、响应正文或用户内容，永不回显。
    throw new DiscussionError(SAVE_FAILED);
  } finally {
    if (pending.get(metadata) === record) pending.delete(metadata);
    // 旧保存的 finally 不能清除新聊天的 saving / issue / revision。
    if (loaded?.metadata === metadata && sameOutlineChat(loaded)) discussionState.saving = pending.has(metadata);
  }
}

export async function appendDiscussionTurn(
  question: string, answer: string, expectedRevision: number, source: OutlineSource,
): Promise<void> {
  const ctx = editable();
  if (discussionState.revision !== expectedRevision || !outlineInputUnchanged(source, true))
    throw new DiscussionError('聊天、正文或讨论已经变化，旧讨论结果未采用。');
  if (!validContent(question, 4000)) throw new DiscussionError('讨论问题须为1到4000字，不能仅含空白。');
  if (!validContent(answer, 8000)) throw new DiscussionError('讨论回复须为1到8000字，不能仅含空白。');
  const next = copyMessages(messages);
  next.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  const total = next.reduce((sum, message) => sum + message.content.length, 0);
  // 存储不是请求上下文窗口：超限必须由用户决定清空，不能静默淘汰旧问答。
  if (next.length > 24) throw new DiscussionError('讨论最多保存12轮（24条消息），请先确认清空讨论后再继续；已有记录未改动。');
  if (total > 48000) throw new DiscussionError('讨论总内容不能超过48000字，请缩短本轮内容或先确认清空讨论；已有记录未改动。');
  await persist({ version: 1, messages: next }, ctx);
}

/** 仅由 UI 明确确认后调用；空记录仍以 version 1 sidecar 保存。 */
export async function clearOutlineDiscussion(expectedRevision: number): Promise<void> {
  const ctx = editable();
  if (discussionState.revision !== expectedRevision) throw new DiscussionError('讨论版本已变化，请重新载入后操作。');
  await persist({ version: 1, messages: [] }, ctx);
}
