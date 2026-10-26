import { getContext, type STMessage } from '@/st/context';
import { getLeaf, leafValid } from './apply';
import { engineState, isAiFloor, pendingAiFloors } from './engine';
import { memory, memoryWriteIssue, recomputeDerived } from './store';
import { refreshInjection } from './inject';
import { clampToTimeTags, FICTIONAL_OPENING_TIME, INITIAL_TIME_KEY, INITIAL_TIME_ORIGIN_KEY, initialStoryTime, latestStoryTime, parseTimeRange, storyTimeValue } from './timeTag';
import { MEMORY_KEY, MEMORY_VERSION } from './types';
import { scheduleVectorIndex } from './vector';
import { invalidateRecallCache } from './vector/cache';

const savingMetadata = new WeakSet<object>();
const savingChat = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

/** 空 v3 容器/变量模板不等于历史；未知结构与非空缓存仍保护。 */
function hasStoredHistory(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const data = raw as Record<string, unknown>;
  if (data.version !== MEMORY_VERSION || !Array.isArray(data.summaries) || data.summaries.length) return true;
  const empty = (v: unknown): boolean => v == null || v === '' ||
    (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.values(v).every(empty));
  const caches = ['state', 'protagonist', 'items', 'plans', 'lifeDetails', 'secrets', 'knowledge', 'scenes', 'npcs', 'itemLog', 'vars'];
  return Object.entries(data).some(([key, value]) => {
    if (['version', 'summaries', 'varsTemplate', 'varTemplates'].includes(key)) return false;
    return !caches.includes(key) || !empty(value);
  });
}

/** 只在开始生成/自动开场摘要时调用；加载旧聊天、手动补摘/重建不调用。 */
export async function ensureOpeningStoryTime(): Promise<void> {
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.() || !ctx.chatMetadata) return;
  const pending = initializing.get(ctx.chatMetadata);
  if (pending) return pending;
  if (savingMetadata.has(ctx.chatMetadata)) throw new Error('开场时间还在保存，请稍等再开始。');
  if (initialStoryTime() || latestStoryTime(ctx.chat) || memoryWriteIssue()) return;
  // 空 v3 森林/变量模板可属于新开场，只有实际历史或未知格式才拒绝初始化。
  if (hasStoredHistory(ctx.chatMetadata[MEMORY_KEY]) || memory.summaries.length || ctx.chat.some(m => m.extra?.bbs_leaf) ||
      ctx.chat.filter(isAiFloor).length > 1 || ctx.chat.filter(m => m.is_user).length > 1) return;
  if (typeof ctx.saveMetadata !== 'function') return; // 旧宿主无可靠持久化接口，不伪称完成初始化。
  const meta = ctx.chatMetadata;
  const task = persistInitialStoryTime(FICTIONAL_OPENING_TIME, 'fictional');
  initializing.set(meta, task);
  try { await task; } finally { if (initializing.get(meta) === task) initializing.delete(meta); }
}

/** 初始化只属于尚未建档的新开场，绝不通过重写旧聊天/旧 L1/L2 修时钟。 */
export function initialTimeEditIssue(): string {
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) return '请先打开聊天。';
  const issue = memoryWriteIssue();
  if (issue) return issue;
  if (ctx.chatMetadata && savingMetadata.has(ctx.chatMetadata)) return '开场时间正在保存，请稍等。';
  if (engineState.running) return '摘要正在进行，请稍后再设置。';
  if (memory.summaries.length || ctx.chat.some(m => m.extra?.bbs_leaf) ||
      ctx.chat.filter(isAiFloor).length > 1) {
    const first = ctx.chat.findIndex(m => m.extra?.bbs_leaf);
    return `这个聊天已经开始了，开场时间不能再改。${first >= 0 ? `要修正时间的话，请在摘要列表里编辑 #${first} 楼的起止时间。` : '要修正时间的话，请编辑对应楼层摘要的起止时间。'}不需要全部重新摘要。`;
  }
  return '';
}

/** 显式保存用户给定时间；仅更新独立聊天元数据，不修改任何消息或摘要。 */
export async function saveInitialStoryTime(value: string): Promise<void> {
  const issue = initialTimeEditIssue();
  if (issue) throw new Error(issue);
  const time = storyTimeValue(value);
  if (!time || time.length > 80 || /[<>\r\n]/.test(time)) throw new Error('请填一个具体的开场时间（可以是虚构的，不用写年份），不要填“未知”、标签或多行文字。');
  await persistInitialStoryTime(time, 'user');
}

/* ============ 旧聊天补设「当前故事时间」 ============
 * 已经开始的聊天不能再设开场时间：之后的单层摘要先用「最近一层的已知时间」，没有才用开场时间，
 * 给旧聊天补开场时间会让模型以为现在仍是开场那一刻；补摘或重新摘要更早的楼层时也会拿到它。
 * 所以旧聊天改为设定「截至最新一层摘要的故事时间」：写进这层摘要的结束时间（以及它记录的状态时间），
 * 只在这两处原本为空时写入。之后的楼层按「最近一层的已知时间」从这里往后推算；
 * 更早楼层的补摘、重新摘要只看它们之前的楼层，不会拿到这个时间；已有摘要里写好的时间不改动。
 */

/** 最近一层带故事时间的楼层（正文时间标签或有效摘要的时间，与 latestStoryTime 同口径）；没有为 -1。 */
function latestTimedFloor(chat: STMessage[]): number {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.extra?.bbs_omit || typeof m?.mes !== 'string' || !m.mes) continue;
    const tag = parseTimeRange(clampToTimeTags(m.mes));
    if (tag.end || tag.start) return i;
    const leaf = getLeaf(m);
    if (leaf && leafValid(m) && (storyTimeValue(leaf.timeEnd) || storyTimeValue(leaf.timeStart) || storyTimeValue(leaf.timeLabel))) return i;
  }
  return -1;
}

/**
 * 旧聊天能否补设当前故事时间。可以时 floor 为要记录时间的楼层（最新一层有效摘要），issue 为空；
 * 不能时 floor 为 -1，issue 写明原因和怎么做。
 */
export function currentStoryTimeTarget(): { floor: number; issue: string } {
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) return { floor: -1, issue: '请先打开聊天。' };
  const issue = memoryWriteIssue();
  if (issue) return { floor: -1, issue };
  if ((ctx.chatMetadata && savingMetadata.has(ctx.chatMetadata)) || (ctx.chat && savingChat.has(ctx.chat))) return { floor: -1, issue: '故事时间正在保存，请稍等。' };
  if (engineState.running) return { floor: -1, issue: '摘要正在进行，请稍后再设置。' };
  const chat = ctx.chat ?? [];
  const known = latestStoryTime(chat) || initialStoryTime() || storyTimeValue(memory.state.time) || '';
  const timedFloor = latestTimedFloor(chat);
  if (known || timedFloor >= 0) {
    const where = timedFloor >= 0 ? `，来自 #${timedFloor} 楼` : '';
    return { floor: -1, issue: `这个聊天已经有故事时间${known ? `（${known}${where}）` : ''}。要修正的话，请在摘要列表里编辑那层摘要的起止时间；时间来自正文里的时间标签时，修改那层正文的标签。不需要全部重新摘要。` };
  }
  let floor = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (!chat[i]?.extra?.bbs_omit && leafValid(chat[i])) { floor = i; break; }
  }
  if (floor < 0) return { floor: -1, issue: '这个聊天还没有楼层摘要，故事时间没有地方记录。请先补摘最新的楼层，再在这里设定当前故事时间。' };
  const after = pendingAiFloors(chat).filter(f => f > floor);
  if (after.length > 1) {
    return { floor: -1, issue: `#${after[0]}–#${after[after.length - 1]} 还有 ${after.length} 层没有摘要。请先补摘到最新，再设定当前故事时间，免得时间记到较早的楼层上。` };
  }
  return { floor, issue: '' };
}

/**
 * 旧聊天补设当前故事时间：写进最新一层有效摘要的结束时间和状态时间（两处原本都为空），
 * 不改正文，不改其他摘要，不重新摘要。返回记录时间的楼层。
 */
export async function saveCurrentStoryTime(value: string): Promise<number> {
  const target = currentStoryTimeTarget();
  if (target.issue) throw new Error(target.issue);
  const time = storyTimeValue(value);
  if (!time || time.length > 80 || /[<>\r\n]/.test(time)) throw new Error('请填一个具体的故事时间（可以是虚构的，不用写年份），不要填“未知”、标签或多行文字。');
  const ctx = getContext()!;
  if (typeof ctx.saveChat !== 'function') throw new Error('当前酒馆版本没有可靠的保存接口，没有修改。');
  const chat = ctx.chat;
  const meta = ctx.chatMetadata;
  const id = ctx.getCurrentChatId();
  const message = chat[target.floor];
  const leaf = getLeaf(message);
  if (!leaf || storyTimeValue(leaf.timeEnd) || storyTimeValue(leaf.timeStart) || storyTimeValue(leaf.delta?.time)) {
    throw new Error('这层摘要的时间刚刚有了变化，没有修改。请重新打开摘要页核对。');
  }
  const previousExtra = message.extra;
  const next = { ...leaf, timeEnd: time, delta: { ...leaf.delta, time } };
  message.extra = { ...(message.extra ?? {}), bbs_leaf: next };
  savingChat.add(chat);
  try {
    await ctx.saveChat();
  } catch {
    // 只撤回自己写入的那份；外部已经换过的不动
    if (message.extra?.bbs_leaf === next) message.extra = previousExtra;
    if (getContext()?.chat === chat) recomputeDerived();
    throw new Error('当前故事时间没能确认保存成功，请重新打开这个聊天看一下；聊天正文和其他摘要都没有改动。');
  } finally {
    savingChat.delete(chat);
  }
  const current = getContext();
  if (current?.chat !== chat || current?.chatMetadata !== meta || current?.getCurrentChatId?.() !== id) return target.floor;
  recomputeDerived();
  refreshInjection();
  invalidateRecallCache(); // 摘要时间变了：召回里的时间标注要重算
  scheduleVectorIndex(); // 向量文档包含摘要时间，按需重新索引这一条
  return target.floor;
}

async function persistInitialStoryTime(time: string, origin: 'user' | 'fictional'): Promise<void> {
  const ctx = getContext()!;
  if (!ctx.chatMetadata || typeof ctx.saveMetadata !== 'function') throw new Error('当前酒馆版本没有可靠的保存接口，没有修改。');
  const meta = ctx.chatMetadata;
  const old = meta[INITIAL_TIME_KEY];
  const oldOrigin = meta[INITIAL_TIME_ORIGIN_KEY];
  const id = ctx.getCurrentChatId();
  const chat = ctx.chat;
  savingMetadata.add(meta);
  meta[INITIAL_TIME_KEY] = time;
  meta[INITIAL_TIME_ORIGIN_KEY] = origin;
  try { await ctx.saveMetadata(); }
  catch {
    // 外部已改为新值时不回滚，不能覆盖另一写入者。
    if (meta[INITIAL_TIME_KEY] === time && meta[INITIAL_TIME_ORIGIN_KEY] === origin) {
      if (old === undefined) delete meta[INITIAL_TIME_KEY]; else meta[INITIAL_TIME_KEY] = old;
      if (oldOrigin === undefined) delete meta[INITIAL_TIME_ORIGIN_KEY]; else meta[INITIAL_TIME_ORIGIN_KEY] = oldOrigin;
    }
    throw new Error('开场时间没能确认保存成功，请重新打开这个聊天看一下；聊天正文和摘要都没有改动。');
  } finally {
    savingMetadata.delete(meta);
  }
  const current = getContext();
  if (current?.chatMetadata !== meta || current?.chat !== chat || current?.getCurrentChatId?.() !== id) return;
  recomputeDerived();
  refreshInjection();
}
