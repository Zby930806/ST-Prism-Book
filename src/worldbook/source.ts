/** 世界书建议读取的楼层：上次处理之后的新楼层，带楼层数和字数上限；依据范围的指纹用于判断失效。 */
import type { STContext, STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { fingerprint } from '@/notes/protocol';
import { messageHash } from '@/notes/source';
import { cleanBody } from '@/memory/timeTag';
import { isAiFloor } from '@/memory/engine';
import type { SourceRange, WorldbookChatData } from './types';

/** 清洗后的正文长度（按消息对象缓存，正文不变时不重复清洗；长聊天里每次重算读取范围也不卡）。 */
const cleanLengths = new WeakMap<STMessage, { mes: string; length: number }>();
export function cleanLength(m: STMessage): number {
  const mes = m.mes ?? '';
  const cached = cleanLengths.get(m);
  if (cached && cached.mes === mes) return cached.length;
  const length = cleanBody(mes).length;
  cleanLengths.set(m, { mes, length });
  return length;
}

/** 参与分析的楼层：正文与用户原话；跳过插件提示楼、番外楼、酒馆系统消息和用户隐藏的楼层。 */
export function readableFloor(m: STMessage | undefined): boolean {
  if (!m || m.extra?.bbs_internal_notice || m.extra?.bbs_omit) return false;
  if (m.is_system && !m.extra?.bbs_hidden) return false;
  return cleanLength(m) > 0;
}

/** 楼层范围的指纹：范围内每一层（含跳过的楼层）的单层指纹合并。楼层被改写、重抽、删除或前移后都会变化。 */
export function rangeHash(ctx: STContext, from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i <= to; i++) parts.push(ctx.chat[i] ? messageHash(ctx.chat[i]) : 'missing');
  return fingerprint(parts.join('|'));
}
export function makeRange(ctx: STContext, from: number, to: number): SourceRange {
  return { from, to, hash: rangeHash(ctx, from, to) };
}
export function rangeCurrent(range: SourceRange, ctx: STContext | null = getContext()): boolean {
  return !!ctx && Array.isArray(ctx.chat) && ctx.chat.length > range.to && range.from >= 0 && range.from <= range.to
    && rangeHash(ctx, range.from, range.to) === range.hash;
}

/** 手动设定「从第 0 楼开始读取」时的处理记录。 */
export const START_CURSOR = { floor: -1, hash: 'start' } as const;

/** 上次处理到的楼层是否原样存在；不存在或已改动时从那一层重新读起。 */
export function cursorStart(ctx: STContext, cursor: WorldbookChatData['cursor']): number | null {
  if (!cursor) return null;
  if (cursor.floor < 0) return 0;
  const m = ctx.chat[cursor.floor];
  if (m && messageHash(m) === cursor.hash) return cursor.floor + 1;
  return Math.max(0, Math.min(cursor.floor, ctx.chat.length));
}
/** 「下次从第 floor 楼开始读取」对应的处理记录。 */
export function cursorBefore(ctx: STContext, floor: number): WorldbookChatData['cursor'] {
  if (floor <= 0) return { ...START_CURSOR };
  const prev = Math.min(floor, ctx.chat.length) - 1;
  return { floor: prev, hash: messageHash(ctx.chat[prev]) };
}

export interface ReadPlan {
  /** 要发送的楼层（按楼层先后）。 */
  floors: number[];
  /** first：本聊天第一次读取，读最近的楼层；new：上次处理之后的新楼层；reread：没有新楼层，重读最近的楼层。 */
  mode: 'first' | 'new' | 'reread';
  /** 新楼层超过上限时还没读到的层数（下次继续）。 */
  remaining: number;
  /** 第一次读取时更早、没有读取的楼层数。 */
  older: number;
}

/**
 * 计算本次读取的楼层。
 * - 有处理记录：读之后的新楼层，超过上限时先读较早的（下次接着读），保证按顺序处理；
 * - 第一次：读最近的楼层；
 * - 没有新楼层：手动生成时重读最近的楼层，自动建议不运行（返回 null）。
 * 字数按每层清洗后的正文计，单层最多 floorText 字；至少读一层。
 */
export function planRead(ctx: STContext, cursor: WorldbookChatData['cursor'], limits: { maxFloors: number; maxChars: number }, opts: { allowReread: boolean; floorText: number }): ReadPlan | null {
  const all: number[] = [];
  for (let i = 0; i < ctx.chat.length; i++) if (readableFloor(ctx.chat[i])) all.push(i);
  if (!all.length) return null;
  const start = cursorStart(ctx, cursor);
  const size = (i: number) => Math.min(opts.floorText, cleanLength(ctx.chat[i]));
  // 从列表一端开始按字数取整层，至少取一层
  const take = (list: number[], fromEnd: boolean): number[] => {
    const out: number[] = [];
    let budget = limits.maxChars;
    const order = fromEnd ? [...list].reverse() : list;
    for (const i of order) {
      if (out.length >= limits.maxFloors) break;
      const cost = size(i);
      if (out.length && cost > budget) break;
      out.push(i); budget -= cost;
    }
    return fromEnd ? out.reverse() : out;
  };
  if (start === null) {
    const floors = take(all, true);
    return { floors, mode: 'first', remaining: 0, older: all.length - floors.length };
  }
  const fresh = all.filter(i => i >= start);
  if (!fresh.length) {
    if (!opts.allowReread) return null;
    return { floors: take(all, true), mode: 'reread', remaining: 0, older: 0 };
  }
  const floors = take(fresh, false);
  return { floors, mode: 'new', remaining: fresh.length - floors.length, older: 0 };
}

/** 上次处理之后新增的 AI 楼层数（自动建议的计数）。没有处理记录时计全部 AI 楼层。 */
export function newAiFloors(ctx: STContext, cursor: WorldbookChatData['cursor']): number {
  const start = cursorStart(ctx, cursor) ?? 0;
  let count = 0;
  for (let i = start; i < ctx.chat.length; i++) if (isAiFloor(ctx.chat[i])) count++;
  return count;
}
export function totalAiFloors(ctx: STContext): number {
  let count = 0;
  for (const m of ctx.chat) if (isAiFloor(m)) count++;
  return count;
}

/** 捕获聊天身份（引用与 id），异步结果回来时据此判断是否还是同一个聊天。 */
export function captureChat(ctx: STContext) {
  return { chat: ctx.chat, metadata: ctx.chatMetadata, id: ctx.getCurrentChatId(), character: ctx.characterId, group: ctx.groupId };
}
export type ChatIdentity = ReturnType<typeof captureChat>;
export function sameChat(identity: ChatIdentity): boolean {
  const now = getContext();
  return !!now && now.chat === identity.chat && now.chatMetadata === identity.metadata && now.getCurrentChatId() === identity.id
    && now.characterId === identity.character && now.groupId === identity.group;
}
