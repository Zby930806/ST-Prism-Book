import { getContext, type STContext } from '@/st/context';
import { sourceHash } from '@/notes/source';

/** 捕获值而非依赖宿主可变的 context 对象，避免切聊后旧闭包认领新聊天。 */
export function captureOutlineSource(ctx: STContext) {
  return {
    chat: ctx.chat, metadata: ctx.chatMetadata, id: ctx.getCurrentChatId(),
    character: ctx.characterId, group: ctx.groupId,
    floor: ctx.chat.length - 1, hash: sourceHash(ctx, ctx.chat.length - 1),
  };
}
export type OutlineSource = ReturnType<typeof captureOutlineSource>;
export function sameOutlineChat(source: OutlineSource): boolean {
  const ctx = getContext();
  return !!ctx && ctx.chat === source.chat && ctx.chatMetadata === source.metadata &&
    ctx.getCurrentChatId() === source.id && ctx.characterId === source.character && ctx.groupId === source.group;
}
export function outlineInputUnchanged(source: OutlineSource, exact = false): boolean {
  const ctx = getContext();
  return !!ctx && sameOutlineChat(source) && (!exact || ctx.chat.length === source.floor + 1) &&
    ctx.chat.length > source.floor && sourceHash(ctx, source.floor) === source.hash;
}
