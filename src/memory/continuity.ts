/**
 * 连续性提醒:摘要发现某楼正文与已有记录不一致(叶子上的 conflicts),
 * 用户在楼层面板选「提醒正文模型」后,下一次生成时注入一次,让正文按原记录继续;
 * 那次回复到达后标为已提醒,不再注入。
 *
 * 状态存在叶子 conflicts[i].status 上,随聊天保存:pending=等下一次生成注入,reminded=已注入,ignored=已忽略。
 * 刷新页面后待注入的提醒仍在,下一次生成照样带上。
 */
import { getContext } from '@/st/context';
import { engineActiveHere } from '@/api/settings';
import { getLeaf, leafValid } from './apply';
import { derivedMeta, memoryWriteIssue, scheduleLeafFlush } from './store';
import type { LeafConflict } from './types';

const NOTE_KEY = 'prism_book_continuity_note';
// 同 inject.ts:extension_prompt_types.IN_CHAT = 1,extension_prompt_roles.SYSTEM = 0
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
/** 贴近最新消息,正文模型更容易看到 */
const NOTE_DEPTH = 1;
const MAX_NOTES = 6;

/** 当前聊天里等待注入的冲突(只看各楼当前页的有效叶子)。 */
function pendingConflicts(): Array<{ floor: number; index: number; conflict: LeafConflict }> {
  const chat = getContext()?.chat ?? [];
  const out: Array<{ floor: number; index: number; conflict: LeafConflict }> = [];
  for (let floor = 0; floor < chat.length; floor++) {
    if (!leafValid(chat[floor])) continue;
    const list = getLeaf(chat[floor])?.conflicts;
    if (!Array.isArray(list)) continue;
    list.forEach((conflict, index) => { if (conflict?.status === 'pending') out.push({ floor, index, conflict }); });
  }
  return out.slice(-MAX_NOTES);
}

const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 注入正文模型的提醒文字;没有待注入的返回空串。 */
export function continuityNoteText(): string {
  const items = pendingConflicts();
  if (!items.length) return '';
  const lines = items.map(({ conflict: c }) => `- ${oneLine(c.about)}:按「${oneLine(c.record)}」继续,不沿用「${oneLine(c.text)}」。`);
  return `[连续性提醒·仅本次]\n以下内容以已有记录为准(先前正文与记录不一致,且没有交代变化):\n${lines.join('\n')}\n这是写作参考,不要在正文中提及或解释这条提醒。`;
}

/** 按当前状态刷新注入槽(没有待注入的提醒、插件停用或数据保护时清空)。 */
export function refreshContinuityNote(): void {
  const ctx = getContext();
  if (!ctx?.setExtensionPrompt) return;
  const text = engineActiveHere() && !memoryWriteIssue() ? continuityNoteText() : '';
  ctx.setExtensionPrompt(NOTE_KEY, text, IN_CHAT, NOTE_DEPTH, false, ROLE_SYSTEM, null);
}

function writeStatus(floor: number, index: number, status: NonNullable<LeafConflict['status']>): boolean {
  const m = getContext()?.chat?.[floor];
  const leaf = getLeaf(m);
  if (!m || !leaf || !Array.isArray(leaf.conflicts) || !leaf.conflicts[index]) return false;
  leaf.conflicts = leaf.conflicts.map((c, i) => (i === index ? { ...c, status } : c));
  m.extra = { ...(m.extra ?? {}), bbs_leaf: leaf };
  return true;
}

/**
 * 用户在楼层面板处理一条冲突:pending=提醒正文模型,ignored=忽略,open=撤销。
 * 写进叶子并保存;数据保护时不写,返回 false。
 */
export function setConflictStatus(floor: number, index: number, status: 'pending' | 'ignored' | 'open'): boolean {
  if (memoryWriteIssue()) return false;
  if (!writeStatus(floor, index, status)) return false;
  derivedMeta.rev++; // 让楼层面板重读叶子
  scheduleLeafFlush();
  refreshContinuityNote();
  return true;
}

/** 本次生成是否带上了提醒:生成开始时登记,回复到达时据此标为已提醒。 */
let armed = false;

/** 生成拦截器调用:刷新注入槽;会产出回复的生成且有待注入提醒时登记。 */
export function prepareContinuityNote(type: string | undefined): void {
  refreshContinuityNote();
  if (type === 'quiet' || type === 'impersonate') return;
  armed = !!continuityNoteText();
}

/** 回复到达后:带上过的提醒标为已提醒,清空注入槽。 */
export function markContinuitySent(): void {
  if (!armed) return;
  armed = false;
  if (memoryWriteIssue()) return;
  const items = pendingConflicts();
  let changed = false;
  for (const { floor, index } of items) changed = writeStatus(floor, index, 'reminded') || changed;
  if (changed) {
    derivedMeta.rev++;
    scheduleLeafFlush();
  }
  refreshContinuityNote();
}

let bound = false;
/** 启动链调用一次:回复到达时收尾,切换聊天时按新聊天刷新。 */
export function bindContinuityNote(): void {
  if (bound) return;
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx.eventTypes) return;
  const received = ctx.eventTypes.MESSAGE_RECEIVED;
  const changed = ctx.eventTypes.CHAT_CHANGED;
  if (received) ctx.eventSource.on(received, (_id: unknown, type: unknown) => {
    if (type === 'first_message') return;
    try { markContinuitySent(); } catch (e) { console.warn('[棱镜宝书] 连续性提醒收尾失败(不影响回复)', e); }
  });
  if (changed) ctx.eventSource.on(changed, () => { armed = false; setTimeout(refreshContinuityNote, 0); });
  bound = true;
}
