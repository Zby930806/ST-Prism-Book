import type { ApiChannel } from '@/api/settings';

/** 修改权限：只新增 / 可补充（追加内容、加关键词）/ 可修改（含替换和整段改写）。 */
export type WorldbookPermission = 'create' | 'supplement' | 'modify';
/** create 新建；append 追加；replace 替换原文中的一段；rewrite 整段改写；keys 只加关键词；flag 提醒（不写入）。 */
export type SuggestionKind = 'create' | 'append' | 'replace' | 'rewrite' | 'keys' | 'flag';
export type WriteKind = Exclude<SuggestionKind, 'flag'>;
/** undone：写入后被撤销。冲突与失效不存储，每次显示和应用时重新核对。 */
export type SuggestionStatus = 'pending' | 'applied' | 'ignored' | 'undone';

export interface WorldbookSettings {
  apiMode: 'notes' | 'independent';
  channel: ApiChannel;
  permission: WorldbookPermission;
  /** 自动建议：每 interval 个新的 AI 楼层在正文生成结束后运行一次（默认关）。 */
  auto: { enabled: boolean; interval: number };
  /** 新条目的插入位置（ST 的 position 数值）、顺序和 @深度时的深度。 */
  newEntry: { position: number; order: number; depth: number };
  /**
   * maxFloors/maxChars：新楼层的楼层数和字数上限（单层正文也最多读到 maxChars）；entryChars：相关条目全文上限；
   * refChars：参考世界书上限；indexChars：目标书条目索引的上限（放不下的条目只列 uid 和标题）。旧设置没有 indexChars，按默认 10000。
   */
  read: { maxFloors: number; maxChars: number; entryChars: number; refChars: number; indexChars: number };
}

/** 建议依据的楼层范围；hash 为范围内每层指纹的合并指纹。 */
export interface SourceRange { from: number; to: number; hash: string }

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  /** 已有条目的 uid（新建为 null）。可能为 0。 */
  uid: number | null;
  /** 新建：新条目标题；其余：生成时的条目标题（仅显示用）。 */
  title: string;
  /** 新建：关键词；追加、替换、改写、加关键词：新增的关键词。 */
  keys: string[];
  /** 新建：内容；追加：追加的文字；替换：替换后的文字；改写：改写后的完整内容；其余为空。 */
  content: string;
  /** 替换：条目原文中要替换的一段（逐字一致，只出现一次）。 */
  find: string;
  /** 依据说明（提醒的内容也写在这里）。 */
  reason: string;
  /** 依据所在的楼层。 */
  floors: number[];
  /** 生成时目标条目的内容指纹（内容与关键词）；新建为空串。应用前据此判断条目是否已被改动。 */
  base: string;
  status: SuggestionStatus;
  edited: boolean;
  /** 校验时做过的调整，如忽略了过短的关键词。 */
  warnings: string[];
}

export interface DroppedAction { label: string; reason: string }

export interface SuggestionBatch {
  id: string;
  createdAt: number;
  auto: boolean;
  book: string;
  permission: WorldbookPermission;
  source: SourceRange;
  suggestions: Suggestion[];
  /** 不合法或超出权限、被丢弃的动作及原因（仅显示）。 */
  dropped: DroppedAction[];
}

export interface EntrySnapshot { comment: string; content: string; key: string[] }

export interface AppliedRecord {
  id: string;
  at: number;
  book: string;
  batchId: string;
  suggestionId: string;
  kind: WriteKind;
  uid: number;
  title: string;
  /** 写入前的内容（新建为 null）。 */
  before: EntrySnapshot | null;
  after: EntrySnapshot;
  /** 新建条目写入后的主要字段签名；撤销时据此判断条目是否被改过。 */
  signature: string;
  source: SourceRange;
  undoneAt: number | null;
}

export interface WorldbookChatData {
  version: 1;
  /** 本聊天选择的写入目标；null 为默认（聊天绑定，其次角色主世界书）。 */
  target: string | null;
  /** 上次处理到的楼层及该层指纹。 */
  cursor: { floor: number; hash: string } | null;
  batches: SuggestionBatch[];
  applied: AppliedRecord[];
}

/** 世界书条目（只声明用到的字段，其余字段原样保留）。 */
export interface WorldEntry {
  uid: number;
  key?: unknown;
  keysecondary?: unknown;
  comment?: unknown;
  content?: unknown;
  constant?: unknown;
  disable?: unknown;
  position?: unknown;
  order?: unknown;
  depth?: unknown;
  [field: string]: unknown;
}
export interface WorldData { entries: Record<string, WorldEntry>; originalData?: unknown; [field: string]: unknown }
