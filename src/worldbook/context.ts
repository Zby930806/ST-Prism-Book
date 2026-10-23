/**
 * 世界书建议的请求内容。不发整本书：
 * - 目标书：条目索引（uid、标题、关键词、内容开头），放不下的条目只列 uid 和标题（另有上限）；关键词出现在本次正文里的条目和常驻条目附全文，有字数上限；
 * - 参考书：当前聊天启用的其他世界书中被本次正文触发的条目和常驻条目，只读，有字数上限；
 * - 角色卡描述（只读）和本次读取的新楼层正文（单层最多读到「正文字数上限」）。
 * 只读输入，不修改任何数据。返回全文完整发送（没有截断）的条目 uid，只有这些条目允许整段改写。
 */
import type { ChatMsg } from '@/api/client';
import type { STContext } from '@/st/context';
import { cleanBody } from '@/memory/timeTag';
import { WB_LIMITS as L } from './limits';
import { entryConstant, entryContent, entryDisabled, entryKeys, entryTitle, listEntries, triggerHits } from './entries';
import { buildWorldbookSystem } from './prompt';
import { PERMISSION_LABELS } from './protocol';
import type { ReadPlan } from './source';
import { cleanLength } from './source';
import type { WorldData, WorldEntry, WorldbookPermission, WorldbookSettings } from './types';

export interface BookSnapshot { name: string; data: WorldData }
export interface ContextInput {
  ctx: STContext;
  target: BookSnapshot;
  /** 当前聊天启用的其他世界书（不含目标书）。 */
  references: BookSnapshot[];
  plan: ReadPlan;
  read: WorldbookSettings['read'];
  permission: WorldbookPermission;
  contentBoundary: boolean;
}
/**
 * omitted：索引里没有完整列出的条目数；compact：其中只列了 uid 和标题的条目数；
 * truncatedFloors：超过单层上限、后半段没有读取的楼层。
 */
export interface ContextStats { floors: number; chars: number; indexed: number; omitted: number; compact: number; related: number; references: number; truncatedFloors: number[] }

const TRUNCATED = '…（以下截断）';
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return max <= TRUNCATED.length ? value.slice(0, max) : value.slice(0, max - TRUNCATED.length) + TRUNCATED;
}
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function indexLine(e: WorldEntry): string {
  const keys = entryKeys(e);
  const keyText = keys.length ? clip(keys.slice(0, 6).join('、'), 60) : '（无）';
  const flags = [entryConstant(e) ? '常驻' : '', entryDisabled(e) ? '已停用' : ''].filter(Boolean).join('、');
  const opening = oneLine(entryContent(e));
  return '[uid ' + e.uid + '] ' + (clip(oneLine(entryTitle(e)), 40) || '（无标题）') + ' ｜ 关键词：' + keyText + (flags ? ' ｜ ' + flags : '')
    + ' ｜ 开头：' + (clip(opening, L.indexOpening) || '（空）');
}

function fullEntry(e: WorldEntry, max: number): string {
  const flags = [entryConstant(e) ? '常驻' : '', entryDisabled(e) ? '已停用' : ''].filter(Boolean).join('、');
  return '[uid ' + e.uid + '] ' + (oneLine(entryTitle(e)) || '（无标题）') + (flags ? '（' + flags + '）' : '')
    + '\n关键词：' + (entryKeys(e).join('、') || '（无）') + '\n内容：\n' + clip(entryContent(e), max);
}

/** 本次正文：楼号 + 说话方 + 清洗后的正文（单层上限 floorText 字，默认跟随「正文字数上限」）。 */
export function floorBlocks(ctx: STContext, floors: number[], floorText: number = L.floorText): string[] {
  return floors.map(i => {
    const m = ctx.chat[i];
    return '第' + i + '楼 ' + (m.is_user ? '用户' : '正文') + '：\n' + clip(cleanBody(m.mes ?? ''), floorText);
  });
}

/** 被正文触发的条目（按命中关键词数排序），其后是没有命中的常驻条目。 */
export function relatedEntries(entries: WorldEntry[], scan: string): WorldEntry[] {
  const lower = scan.toLowerCase();
  const hit = entries.map(e => ({ e, hits: triggerHits(e, scan, lower) })).filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || Number(a.e.uid) - Number(b.e.uid)).map(x => x.e);
  const constant = entries.filter(e => entryConstant(e) && !hit.includes(e));
  return [...hit, ...constant];
}

export function buildWorldbookContext(input: ContextInput): { messages: ChatMsg[]; stats: ContextStats; fullUids: Set<number> } {
  const { ctx, target, references, plan, read } = input;
  // 单层正文跟随「正文字数上限」：超长的楼最多占满整个预算，不再固定截在 8000 字
  const floorText = Math.max(1, read.maxChars);
  const blocks = floorBlocks(ctx, plan.floors, floorText);
  const truncatedFloors = plan.floors.filter(i => !!ctx.chat[i] && cleanLength(ctx.chat[i]) > floorText);
  const scan = blocks.join('\n');
  const entries = listEntries(target.data);
  const related = relatedEntries(entries, scan);

  // 目标书索引：放得下就全部按 uid 列出；放不下时相关条目优先，其余按 uid 补足
  const lines = new Map(entries.map(e => [e, indexLine(e)]));
  const indexBudget = read.indexChars ?? L.index;
  let chosen = entries;
  const total = entries.reduce((n, e) => n + lines.get(e)!.length + 1, 0);
  if (total > indexBudget) {
    const picked = new Set<WorldEntry>();
    let budget = indexBudget;
    for (const e of [...related, ...entries]) {
      if (picked.has(e)) continue;
      const cost = lines.get(e)!.length + 1;
      if (cost > budget) continue;
      picked.add(e); budget -= cost;
    }
    chosen = entries.filter(e => picked.has(e));
  }
  const omitted = entries.length - chosen.length;
  const index = chosen.map(e => lines.get(e)!).join('\n');
  // 没列进索引的条目：按「[uid] 标题」紧凑列出（另有上限），让模型知道它们存在，避免新建重复的条目
  const compactLines: string[] = [];
  const chosenSet = new Set(chosen);
  let compactBudget: number = L.compactIndex;
  for (const e of entries) {
    if (chosenSet.has(e)) continue;
    const line = '[uid ' + e.uid + '] ' + (clip(oneLine(entryTitle(e)), 40) || '（无标题）');
    if (line.length + 1 > compactBudget) break;
    compactLines.push(line); compactBudget -= line.length + 1;
  }
  const hidden = omitted - compactLines.length;

  const fullTexts: string[] = [];
  const fullUids = new Set<number>();
  let entryBudget = read.entryChars;
  for (const e of related) {
    if (entryBudget <= 0) break;
    const max = Math.min(L.entryFull, Math.max(200, entryBudget - 80));
    const textBlock = fullEntry(e, max);
    if (fullTexts.length && textBlock.length > entryBudget) continue;
    fullTexts.push(textBlock); entryBudget -= textBlock.length;
    if (entryContent(e).length <= max) fullUids.add(Number(e.uid));
  }

  const compactPart = compactLines.length
    ? '\n\n[其余条目：索引放不下，只列 uid 和标题，内容没有发送]\n' + compactLines.join('；')
      + '\n（对其余条目只能用 flag 提醒，或按 uid 追加内容、关键词；不要为它们新建同名或主题重复的条目。）'
    : '';
  const targetPart = '[目标世界书：' + target.name + '，共 ' + entries.length + ' 条]\n'
    + (entries.length ? '条目索引：\n' + index + compactPart + (hidden > 0 ? '\n（另有 ' + hidden + ' 条连标题也没有列出；不要为没有列出的条目提建议。）' : '') : '（这本世界书还没有条目。）')
    + '\n\n[相关条目全文：关键词出现在本次正文里的条目和常驻条目；末尾标「以下截断」的只发送了开头]\n'
    + (fullTexts.length ? fullTexts.join('\n\n') : '（没有）');

  const refLines: string[] = [];
  let refBudget = read.refChars, refOmitted = 0;
  for (const book of read.refChars > 0 ? references : []) {
    for (const e of relatedEntries(listEntries(book.data), scan)) {
      if (entryDisabled(e)) continue;
      const line = '《' + book.name + '》' + (oneLine(entryTitle(e)) || '（无标题）') + ' ｜ 关键词：' + (clip(entryKeys(e).join('、'), 60) || '（无）')
        + ' ｜ ' + clip(oneLine(entryContent(e)), L.refEntry);
      if (line.length > refBudget) { refOmitted++; continue; }
      refLines.push(line); refBudget -= line.length + 1;
    }
  }

  const id = ctx.characterId;
  const character = !ctx.groupId && id !== undefined && id !== '' ? ctx.characters?.[Number(id)] : undefined;
  let card = typeof character?.description === 'string' ? character.description : '';
  try { if (card && typeof ctx.substituteParams === 'function') card = ctx.substituteParams(card); } catch { /* 宏展开失败时用原文 */ }

  const messages: ChatMsg[] = [
    { role: 'system', content: buildWorldbookSystem(input.permission, { contentBoundary: input.contentBoundary }) },
    { role: 'user', content: targetPart },
  ];
  if (refLines.length || refOmitted) {
    messages.push({ role: 'user', content: '[参考世界书：当前聊天启用的其他世界书，只读，用于核对已有设定]\n' + refLines.join('\n')
      + (refOmitted ? '\n（另有 ' + refOmitted + ' 条相关条目超出预算，没有列出。）' : '') });
  }
  if (card.trim()) messages.push({ role: 'user', content: '[角色卡描述：只读，用于核对已有设定]\n' + clip(card.trim(), L.card) });
  const first = plan.floors[0], last = plan.floors[plan.floors.length - 1];
  messages.push({ role: 'user', content: '[新的剧情正文：第 ' + first + '–' + last + ' 楼，按楼层先后排列]\n' + blocks.join('\n\n') });
  messages.push({ role: 'user', content: '请分析上面的新剧情正文，按系统说明只输出 JSON。当前修改权限：' + PERMISSION_LABELS[input.permission] + '。' });
  return {
    messages,
    stats: { floors: plan.floors.length, chars: blocks.reduce((n, b) => n + b.length, 0), indexed: chosen.length, omitted, compact: compactLines.length, related: fullTexts.length, references: refLines.length, truncatedFloors },
    fullUids,
  };
}
