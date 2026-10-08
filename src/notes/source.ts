import { getContext } from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { clampToTimeTags } from '@/memory/timeTag';
import { fingerprint } from './protocol';
const hashes = new WeakMap<STMessage, { mes: string; swipe: number; role: string; hash: string }>();
export function sourceHash(ctx: STContext, floor: number): string {
  return fingerprint(ctx.chat.slice(0, floor+1).map(m => {
    const swipe = m.swipe_id ?? 0, role = (m.is_user ? 'user' : m.is_system && !m.extra?.bbs_hidden ? 'system' : 'assistant') + ':' + m.name;
    const prev = hashes.get(m);
    if (prev && prev.mes === m.mes && prev.swipe === swipe && prev.role === role) return prev.hash;
    const hash = fingerprint(role+'|'+swipe+'|'+clampToTimeTags(m.mes));
    hashes.set(m, { mes: m.mes, swipe, role, hash }); return hash;
  }).join('|'));
}
export function sameChat(ctx: STContext): boolean {
  const now = getContext();
  return !!now && now.chat === ctx.chat && now.getCurrentChatId() === ctx.getCurrentChatId() && now.characterId === ctx.characterId && now.groupId === ctx.groupId;
}
export function latestStoryFloor(ctx: STContext): number {
  for (let i=ctx.chat.length-1;i>=0;i--) { const m=ctx.chat[i]; if (!m.is_user && !m.is_system && !m.extra?.bbs_internal_notice && !m.extra?.bbs_omit && clampToTimeTags(m.mes)) return i; }
  return -1;
}
