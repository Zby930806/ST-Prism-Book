/** 世界书条目的纯函数：读取字段、内容指纹、关键词匹配、改前改后对比。 */
import { fingerprint } from '@/notes/protocol';
import type { EntrySnapshot, WorldData, WorldEntry } from './types';

const text = (v: unknown): string => typeof v === 'string' ? v : '';
export const entryTitle = (e: WorldEntry): string => text(e.comment).trim();
export const entryContent = (e: WorldEntry): string => text(e.content);
export const entryKeys = (e: WorldEntry): string[] => Array.isArray(e.key) ? e.key.filter((k): k is string => typeof k === 'string').map(k => k.trim()).filter(Boolean) : [];
export const entryDisabled = (e: WorldEntry): boolean => e.disable === true;
export const entryConstant = (e: WorldEntry): boolean => e.constant === true;

/** 按 uid 找条目：先看同名键，再按 uid 字段找（文件里键与 uid 不一致时也能找到）。uid 可以为 0。 */
export function findEntry(data: WorldData, uid: number): { key: string; entry: WorldEntry } | null {
  if (!Number.isInteger(uid) || uid < 0) return null;
  const direct = data.entries[String(uid)];
  if (direct && typeof direct === 'object' && Number(direct.uid) === uid) return { key: String(uid), entry: direct };
  for (const [key, entry] of Object.entries(data.entries)) {
    if (entry && typeof entry === 'object' && Number(entry.uid) === uid) return { key, entry };
  }
  return null;
}

/** 有效条目，按 uid 升序。 */
export function listEntries(data: WorldData): WorldEntry[] {
  return Object.values(data.entries)
    .filter((e): e is WorldEntry => !!e && typeof e === 'object' && Number.isInteger(Number(e.uid)) && Number(e.uid) >= 0)
    .sort((a, b) => Number(a.uid) - Number(b.uid));
}

/** 建议依据的内容指纹：内容与关键词。应用前与当前条目比对，不一致即为冲突。 */
export function entryBase(e: WorldEntry): string {
  return fingerprint(JSON.stringify([entryContent(e), entryKeys(e)]));
}

/** 原样的关键词数组（只去掉非文字项），写入和撤销时保持用户原来的写法。 */
export const rawKeys = (e: WorldEntry): string[] => Array.isArray(e.key) ? e.key.filter((k): k is string => typeof k === 'string') : [];

export function snapshot(e: WorldEntry): EntrySnapshot {
  return { comment: text(e.comment), content: entryContent(e), key: rawKeys(e) };
}
export function sameSnapshot(e: WorldEntry, s: EntrySnapshot): boolean {
  return entryContent(e) === s.content && JSON.stringify(rawKeys(e)) === JSON.stringify(s.key);
}

/** 新建条目的主要字段签名。撤销新建时核对：这些字段都没变才删除。 */
const SIGNATURE_FIELDS = ['comment', 'content', 'key', 'keysecondary', 'constant', 'disable', 'selective', 'position', 'order', 'depth', 'role', 'probability', 'useProbability', 'group'];
export function entrySignature(e: WorldEntry): string {
  return fingerprint(JSON.stringify(SIGNATURE_FIELDS.map(f => e[f] ?? null)));
}

/** 关键词去重比较用的形式。 */
export const keyForm = (k: string): string => k.trim().toLowerCase();

/** 酒馆的正则关键词写法 /pattern/flags。 */
function regexKey(key: string): RegExp | null {
  const m = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(key);
  if (!m) return null;
  try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')); } catch { return null; }
}

/** 关键词是否出现在文本中：普通关键词不区分大小写按包含匹配，正则关键词按 /…/ 写法匹配。 */
export function keyMatches(key: string, haystack: string, lower = haystack.toLowerCase()): boolean {
  const k = key.trim();
  if (!k) return false;
  const re = regexKey(k);
  if (re) return re.test(haystack);
  return lower.includes(k.toLowerCase());
}
/** 条目被文本触发的关键词数（只看主关键词，不模拟次要关键词、概率和递归）。 */
export function triggerHits(e: WorldEntry, haystack: string, lower = haystack.toLowerCase()): number {
  let hits = 0;
  for (const key of entryKeys(e)) if (keyMatches(key, haystack, lower)) hits++;
  return hits;
}

/** 文字在原文中出现的次数（逐字匹配）。 */
export function occurrences(source: string, part: string): number {
  if (!part) return 0;
  let count = 0;
  for (let at = source.indexOf(part); at >= 0; at = source.indexOf(part, at + part.length)) count++;
  return count;
}

/** 追加内容：原内容去掉末尾空白后另起一行。 */
export function appendText(content: string, addition: string): string {
  const base = content.replace(/\s+$/, '');
  return base ? base + '\n' + addition.trim() : addition.trim();
}

/** 合并关键词：保留原有顺序，跳过已有的（不区分大小写）。 */
export function mergeKeys(current: string[], added: string[]): string[] {
  const seen = new Set(current.map(keyForm));
  const out = [...current];
  for (const k of added) {
    const v = k.trim();
    if (v && !seen.has(keyForm(v))) { seen.add(keyForm(v)); out.push(v); }
  }
  return out;
}

export type DiffPart = { text: string; type: 'same' | 'removed' | 'added' };

/** 按句切分（句末标点、换行之后断开），保留原文字符，拼回去与原文一致。 */
export function splitSentences(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\n' || '。！？!?；;'.includes(c)) {
      let end = i + 1;
      while (end < value.length && '”’」』）)'.includes(value[end])) end++;
      out.push(value.slice(start, end)); start = end; i = end - 1;
    }
  }
  if (start < value.length) out.push(value.slice(start));
  return out;
}

/**
 * 句子级对比：返回改前（same/removed）和改后（same/added）两列，用于「改前改后对比」。
 * 句子数过多时退回整段对比，避免长条目卡住界面。
 */
export function diffSentences(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  const a = splitSentences(before), b = splitSentences(after);
  if (a.length * b.length > 250_000) return { before: [{ text: before, type: before === after ? 'same' : 'removed' }], after: [{ text: after, type: before === after ? 'same' : 'added' }] };
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const left: DiffPart[] = [], right: DiffPart[] = [];
  const push = (list: DiffPart[], part: DiffPart) => {
    const last = list[list.length - 1];
    if (last && last.type === part.type) last.text += part.text; else list.push({ ...part });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(left, { text: a[i], type: 'same' }); push(right, { text: b[j], type: 'same' }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push(left, { text: a[i], type: 'removed' }); i++; }
    else { push(right, { text: b[j], type: 'added' }); j++; }
  }
  for (; i < n; i++) push(left, { text: a[i], type: 'removed' });
  for (; j < m; j++) push(right, { text: b[j], type: 'added' });
  return { before: left, after: right };
}
