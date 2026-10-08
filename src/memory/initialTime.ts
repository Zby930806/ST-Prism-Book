import { getContext } from '@/st/context';
import { engineState, isAiFloor } from './engine';
import { memory, memoryWriteIssue, recomputeDerived } from './store';
import { refreshInjection } from './inject';
import { FICTIONAL_OPENING_TIME, INITIAL_TIME_KEY, INITIAL_TIME_ORIGIN_KEY, initialStoryTime, latestStoryTime, storyTimeValue } from './timeTag';
import { MEMORY_KEY, MEMORY_VERSION } from './types';

const savingMetadata = new WeakSet<object>();
const initializing = new WeakMap<object, Promise<void>>();

/** 空 v3 容器/变量模板不等于历史；未知结构与非空缓存仍保护。 */
function hasStoredHistory(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const data = raw as Record<string, unknown>;
  if (data.version !== MEMORY_VERSION || !Array.isArray(data.summaries) || data.summaries.length) return true;
  const empty = (v: unknown): boolean => v == null || v === '' ||
    (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.values(v).every(empty));
  const caches = ['state', 'protagonist', 'items', 'plans', 'lifeDetails', 'scenes', 'npcs', 'itemLog', 'vars'];
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
  if (savingMetadata.has(ctx.chatMetadata)) throw new Error('开场时间正在保存，请保存完成后再开始。');
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
  if (ctx.chatMetadata && savingMetadata.has(ctx.chatMetadata)) return '开场时间正在保存，请勿重复提交。';
  if (engineState.running) return '摘要任务进行中，请稍后设置。';
  if (memory.summaries.length || ctx.chat.some(m => m.extra?.bbs_leaf) ||
      ctx.chat.filter(isAiFloor).length > 1) {
    const first = ctx.chat.findIndex(m => m.extra?.bbs_leaf);
    return `已有聊天不回填开场日期。${first >= 0 ? `开场已自动摘要时，请展开下方 #${first} 逐楼摘要，点击编辑补填起止时间。` : '请在对应逐楼摘要中编辑起止时间。'}无需重建旧 L1/L2。`;
  }
  return '';
}

/** 显式保存用户给定时间；仅更新独立聊天元数据，不修改任何消息或摘要。 */
export async function saveInitialStoryTime(value: string): Promise<void> {
  const issue = initialTimeEditIssue();
  if (issue) throw new Error(issue);
  const time = storyTimeValue(value);
  if (!time || time.length > 80 || /[<>\r\n]/.test(time)) throw new Error('请填写你确认的开场时间（可虚构、不必补全年份），不要填未知、标签或多行文本。');
  await persistInitialStoryTime(time, 'user');
}

async function persistInitialStoryTime(time: string, origin: 'user' | 'fictional'): Promise<void> {
  const ctx = getContext()!;
  if (!ctx.chatMetadata || typeof ctx.saveMetadata !== 'function') throw new Error('宿主缺少可靠元数据保存接口，未修改。');
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
    throw new Error('开场时间保存未确认成功，请重新打开本聊天核对；未修改任何聊天正文或摘要。');
  } finally {
    savingMetadata.delete(meta);
  }
  const current = getContext();
  if (current?.chatMetadata !== meta || current?.chat !== chat || current?.getCurrentChatId?.() !== id) return;
  recomputeDerived();
  refreshInjection();
}
