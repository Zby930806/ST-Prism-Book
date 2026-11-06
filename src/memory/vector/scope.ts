/**
 * 向量库的「选库 + 选 scope」逻辑。
 *
 * 角色隔离 = 每角色一个独立 <database>.sqlite:库名由角色 avatar(稳定唯一键)算出。
 * 删角色 = 删那一个库文件,不牵连其他角色。
 * 库内用 scope 区分集合:
 *   'chat:<chatId>'    当前聊天边玩边索引
 *   'bundle:<hash>'    带数据建新聊天冻结的快照(写在 metadata.bbs_bundles)
 */

import { getContext } from '@/st/context';

/** metadata 上存哈希包列表的字段名(随 chat 文件走,ST 原生分支会物理拷贝) */
export const BUNDLES_META_KEY = 'bbs_bundles';

/**
 * 把任意字符串(角色 avatar)折成合法库名。
 * 后端 DATABASE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/,avatar 含中文/大写/斜杠过不了,故 hash。
 * 用 FNV-1a(无需 crypto,前端同步算):稳定、同 avatar 永远同库。
 */
function avatarToDbName(avatar: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < avatar.length; i++) {
    h ^= avatar.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 再掺入长度做轻量去碰撞;转无符号 16 进制
  const hex = ((h >>> 0).toString(16) + (avatar.length & 0xffff).toString(16)).padStart(8, '0');
  return `bbs_vec_${hex}`;
}

/** 当前角色对应的向量库名;群聊/未进入角色时返回 null(不索引)。 */
export function currentVectorDb(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊暂不支持
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  const avatar = ch?.avatar;
  if (!avatar) return null;
  return avatarToDbName(avatar);
}

/** 当前聊天 id;未进入聊天返回 null。 */
export function currentChatId(): string | null {
  const ctx = getContext();
  return ctx?.getCurrentChatId?.() ?? null;
}

/** 当前聊天自己的 scope('chat:<chatId>');未进入聊天返回 null。 */
export function currentChatScope(): string | null {
  const id = currentChatId();
  return id ? `chat:${id}` : null;
}

/** 读当前聊天 metadata 上的哈希包列表(去重),无则空数组。 */
export function currentBundleHashes(): string[] {
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  const raw = meta?.[BUNDLES_META_KEY];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const h of raw) if (typeof h === 'string' && h) seen.add(h);
  return [...seen];
}

/** 召回范围 scopes = 当前聊天 + 各 bundle。未进入聊天返回空数组。 */
export function recallScopes(): string[] {
  const self = currentChatScope();
  if (!self) return [];
  return [self, ...currentBundleHashes().map(h => `bundle:${h}`)];
}

/**
 * 在当前聊天 metadata 上追加一个 bundle 哈希(累加、去重),并触发持久化。
 * 用于「带数据建新聊天」写入新聊天那一刻。
 */
export function appendBundleHash(metadata: Record<string, unknown>, parentHashes: string[], newHash: string): void {
  const merged = new Set<string>([...parentHashes, newHash].filter(Boolean));
  metadata[BUNDLES_META_KEY] = [...merged];
}
