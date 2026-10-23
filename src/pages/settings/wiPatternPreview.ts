/**
 * 「排除世界书内容 → 按条目名过滤」的命中预览。
 * 匹配方式与摘要时排除世界书条目相同（memory/engine.ts 的 isWorldInfoEntryExcluded）：
 * 规则按正则解析、不区分大小写；正则写法有误时按字面包含匹配。
 * 只读取当前聊天会用到的世界书（全局、角色、角色附加、聊天、用户角色绑定），读到的数据不修改。
 */
import { apiSettings } from '@/api/settings';
import { loadBook, refreshWorldHost, worldHost } from '@/worldbook/host';

/** 条目名是否命中规则。 */
export function wiPatternMatches(pattern: string, comment: string): boolean {
  const pat = pattern.trim();
  const name = comment.trim();
  if (!pat || !name) return false;
  try {
    return new RegExp(pat, 'i').test(name);
  } catch {
    return name.toLowerCase().includes(pat.toLowerCase());
  }
}

/** 规则能否按正则解析；不能时按字面包含匹配。 */
export function wiPatternIsRegex(pattern: string): boolean {
  try {
    new RegExp(pattern.trim(), 'i');
    return true;
  } catch {
    return false;
  }
}

/** 规则里有正则含义的符号（[ ] ( ) . * + ? ^ $ | \ { }）。 */
export function wiPatternHasSpecialChars(pattern: string): boolean {
  return /[[\]().*+?^$|\\{}]/.test(pattern);
}

export interface WiEntryName {
  book: string;
  comment: string;
}

export interface WiPatternPreview {
  /** 有条目名的条目总数 */
  total: number;
  /** 命中的条目 */
  hits: WiEntryName[];
}

export function previewWiPattern(pattern: string, entries: WiEntryName[]): WiPatternPreview {
  return { total: entries.length, hits: entries.filter(e => wiPatternMatches(pattern, e.comment)) };
}

/** 命中达到这个比例（且至少 5 条）时提示「命中较多」。 */
export function wiPatternHitsMany(preview: WiPatternPreview): boolean {
  return preview.hits.length >= 5 && preview.hits.length >= preview.total * 0.3;
}

export interface BoundEntryNames {
  /** 读取的世界书 */
  books: string[];
  entries: WiEntryName[];
  /** 读取失败的世界书 */
  failed: string[];
}

/**
 * 读取当前聊天会用到的世界书里各条目的名字。整本排除的书在预览时再按当时的名单去掉，
 * 这样在卡片里改了整本排除名单，不必重新读取。
 */
export async function loadBoundEntryNames(): Promise<BoundEntryNames> {
  await refreshWorldHost();
  const b = worldHost.bindings;
  const books = [...new Set([...b.global, b.charPrimary, ...b.charAux, b.chat, b.persona].map(n => n.trim()).filter(Boolean))];
  const entries: WiEntryName[] = [];
  const failed: string[] = [];
  for (const book of books) {
    try {
      const data = await loadBook(book);
      for (const entry of Object.values(data?.entries ?? {})) {
        const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
        if (comment) entries.push({ book, comment });
      }
    } catch {
      failed.push(book);
    }
  }
  return { books, entries, failed };
}

/** 预览一条规则：只看没有整本排除的书。 */
export function previewWiPatternIn(pattern: string, loaded: BoundEntryNames, excludedBooks: readonly string[] = apiSettings.excludedWorldNames): WiPatternPreview & { books: number } {
  const books = loaded.books.filter(b => !excludedBooks.includes(b) && !loaded.failed.includes(b));
  const entries = loaded.entries.filter(e => !excludedBooks.includes(e.book));
  return { ...previewWiPattern(pattern, entries), books: books.length };
}

const SPECIAL_NOTE = '规则按正则解析：[ ] ( ) . * + ? ^ $ | \\ 有特殊含义，按原样匹配请在前面加 \\，如 \\[NPC\\]。';

/** 输入规则时显示的预览说明；warn 为 true 时命中较多，用提醒样式显示。 */
export function describeWiPatternPreview(pattern: string, loaded: BoundEntryNames, excludedBooks: readonly string[] = apiSettings.excludedWorldNames): { text: string; warn: boolean } {
  const syntax = !wiPatternIsRegex(pattern) ? '这条规则不是有效的正则，按字面包含匹配。' : wiPatternHasSpecialChars(pattern) ? SPECIAL_NOTE : '';
  if (!loaded.books.length) return { text: '当前聊天没有使用世界书，无法预览命中的条目。' + syntax, warn: false };
  const p = previewWiPatternIn(pattern, loaded, excludedBooks);
  if (!p.books) {
    const why = loaded.books.every(b => loaded.failed.includes(b)) ? '世界书读取失败，无法预览命中的条目。' : '当前聊天使用的世界书都已整本排除。';
    return { text: why + syntax, warn: false };
  }
  const failedNote = loaded.failed.length ? `另有 ${loaded.failed.length} 本读取失败，没有计入。` : '';
  if (!p.hits.length) return { text: `当前聊天使用的 ${p.books} 本世界书中没有命中的条目。${failedNote}${syntax}`, warn: false };
  const names = p.hits.slice(0, 5).map(h => `「${h.comment}」`).join('');
  const many = wiPatternHitsMany(p);
  return {
    text: `当前聊天使用的 ${p.books} 本世界书中命中 ${p.hits.length} / ${p.total} 个条目：${names}${p.hits.length > 5 ? '等' : ''}。${many ? '命中较多，请确认没有把需要的条目一起排除。' : ''}${failedNote}${syntax}`,
    warn: many,
  };
}
