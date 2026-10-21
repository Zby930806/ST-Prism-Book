/**
 * 世界书建议的模型输出协议：一个 JSON 对象 {"actions":[…]}。
 * - 用真正的 JSON 解析，不删除 // 之类的“注释”（内容里的网址不会让整批作废）；只剥离字符串之外的思考块与代码围栏，
 *   解析失败时只做一次不改动字符串内容的修复（去掉字符串之外的尾随逗号）。
 * - 已有条目一律按 uid 指定（可以为 0），不做名字匹配；uid 必须存在于目标世界书。
 * - 动作逐条校验：不合法、超出修改权限的动作丢弃并记下原因，其余照常采用。权限在写入时还会再核对一次。
 */
import { WB_LIMITS as L } from './limits';
import { entryBase, entryContent, entryKeys, entryTitle, findEntry, keyForm, listEntries, occurrences } from './entries';
import type { DroppedAction, Suggestion, SuggestionKind, WorldData, WorldEntry, WorldbookPermission } from './types';

export class WorldbookProtocolError extends Error {}

export const KIND_LABELS: Record<SuggestionKind, string> = {
  create: '新建', append: '追加', replace: '替换', rewrite: '改写', keys: '加关键词', flag: '提醒',
};
export const PERMISSION_LABELS: Record<WorldbookPermission, string> = { create: '只新增', supplement: '可补充', modify: '可修改' };
/** 各档修改权限允许的动作（代码强制执行，不只靠提示词）。提醒只显示、不写入，各档都允许。 */
export const ALLOWED_KINDS: Record<WorldbookPermission, ReadonlySet<SuggestionKind>> = {
  create: new Set<SuggestionKind>(['create', 'flag']),
  supplement: new Set<SuggestionKind>(['create', 'append', 'keys', 'flag']),
  modify: new Set<SuggestionKind>(['create', 'append', 'keys', 'replace', 'rewrite', 'flag']),
};
/** 该权限下允许写入的动作，用于提示「不允许」时说明。 */
export function permissionBlock(kind: SuggestionKind, permission: WorldbookPermission): string {
  if (ALLOWED_KINDS[permission].has(kind)) return '';
  return '当前修改权限为「' + PERMISSION_LABELS[permission] + '」，不允许' + KIND_LABELS[kind] + '已有条目（可在本页底部「修改权限」中调整）。';
}

const FIELDS: Record<SuggestionKind, string[]> = {
  create: ['action', 'title', 'keys', 'content', 'reason', 'floors'],
  append: ['action', 'uid', 'text', 'addKeys', 'reason', 'floors'],
  replace: ['action', 'uid', 'find', 'text', 'addKeys', 'reason', 'floors'],
  rewrite: ['action', 'uid', 'content', 'addKeys', 'reason', 'floors'],
  keys: ['action', 'uid', 'addKeys', 'reason', 'floors'],
  flag: ['action', 'uid', 'reason', 'floors'],
};
/** 不支持的动作给出明确原因，而不是笼统的「不认识」。 */
const UNSUPPORTED: Record<string, string> = {
  delete: '第一版不支持删除条目。', remove: '第一版不支持删除条目。', disable: '第一版不支持停用条目。', enable: '第一版不支持启用或停用条目。',
  set_field: '第一版不支持修改条目的常驻、位置等字段。', update: '不支持 update，请使用 append、replace 或 rewrite。', patch: '不支持 patch，请使用 append、replace 或 rewrite。',
};

// —— JSON 提取 ——

/** 去掉字符串之外的 <think>/<thinking> 块；回复以未闭合的思考块开头时视为不完整。预填充时只有结尾标签，丢弃它之前的内容。 */
function stripThinking(reply: string): string {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < reply.length; i++) {
    const c = reply[i];
    if (!quoted && c === '<') {
      const block = reply.slice(i).match(/^<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/i);
      if (block) { i += block[0].length - 1; continue; }
      if (/^<(think|thinking)\b/i.test(reply.slice(i)) && !out.trim()) throw new WorldbookProtocolError('回复只有没写完的思考过程，没有结果；多半是输出达到了长度上限，可调大该 API 的「最大输出」后重试。');
    }
    out += c;
    if (escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  const close = Math.max(out.toLowerCase().lastIndexOf('</think>'), out.toLowerCase().lastIndexOf('</thinking>'));
  if (close >= 0 && out.slice(0, close).indexOf('{') < 0) out = out.slice(close).replace(/^<\/think(?:ing)?>/i, '');
  return out.trim();
}

/** 从 start 处的 { 或 [ 开始找到配对的结束括号（跳过字符串内容）；找不到返回 -1。 */
function matchBracket(text: string, start: number): number {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 去掉字符串之外的尾随逗号（`,}` `,]`），字符串里的内容一字不动。 */
function stripTrailingCommas(text: string): string {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

export function extractReplyJson(reply: string): unknown {
  if (typeof reply !== 'string' || !reply.trim()) throw new WorldbookProtocolError('模型没有返回内容。');
  if (reply.length > L.reply) throw new WorldbookProtocolError('回复超过 ' + L.reply + ' 字，没有采用；请调低「最大输出」或减少读取的楼层后重试。');
  let text = stripThinking(reply);
  // 代码围栏只去掉开头一行；结尾由括号配对确定，内容里出现 ``` 也不会截错
  const fenceAt = text.indexOf('```'), bracketAt = text.search(/[{[]/);
  if (fenceAt >= 0 && (bracketAt < 0 || fenceAt < bracketAt)) text = text.slice(fenceAt).replace(/^```[^\n{[]*\n?/, '');
  const start = text.search(/[{[]/);
  if (start < 0) throw new WorldbookProtocolError('回复中没有 JSON。模型可能没有按格式输出，可以重新生成。');
  const end = matchBracket(text, start);
  if (end < 0) throw new WorldbookProtocolError('回复中的 JSON 不完整，多半是输出达到了长度上限。可调大该 API 的「最大输出」，或减少读取的楼层后重试。');
  const json = text.slice(start, end + 1);
  if (json.length > L.json) throw new WorldbookProtocolError('回复中的 JSON 超过 ' + L.json + ' 字，没有采用。');
  try { return JSON.parse(json); } catch { /* 再试一次不改动字符串的修复 */ }
  try { return JSON.parse(stripTrailingCommas(json)); } catch {
    throw new WorldbookProtocolError('回复中的 JSON 语法有误，无法解析。可以重新生成；经常出现时可换用更稳定的模型。');
  }
}

// —— 动作校验 ——

export interface ValidationInput {
  /** 生成时发给模型的目标世界书。 */
  data: WorldData;
  permission: WorldbookPermission;
  /** 本次读取的楼层范围，依据楼层只保留范围内的。 */
  range: { from: number; to: number };
  newId?: () => string;
}
export interface ValidationResult { suggestions: Suggestion[]; dropped: DroppedAction[] }

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const clip = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 1) + '…';
class Drop extends Error {}
const drop = (reason: string): never => { throw new Drop(reason); };

export function readUid(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d{1,7}$/.test(v.trim())) return Number(v.trim());
  return null;
}
function readText(v: unknown, field: string, min: number, max: number): string {
  if (v === undefined || v === null) return min > 0 ? drop('缺少 ' + field + '。') : '';
  if (typeof v !== 'string') return drop(field + ' 应为文字。');
  const value = v.trim();
  if (value.length < min) return drop(field + ' 不能为空。');
  if (value.length > max) return drop(field + ' 超过 ' + max + ' 字。');
  return value;
}

/** 关键词：接受数组或用逗号、顿号分隔的文字；去重，忽略过短、过长和已存在的，最多 limit 个。 */
export function readKeys(v: unknown, existing: string[], warnings: string[], limit = L.keys): string[] {
  if (v === undefined || v === null) return [];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、]/) : drop('关键词应为文字数组。');
  const seen = new Set(existing.map(keyForm));
  const out: string[] = [], short: string[] = [], long: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return drop('关键词应为文字。');
    const key = item.trim();
    if (!key) continue;
    if (key.length < 2) { short.push(key); continue; }
    if (key.length > L.key) { long.push(clip(key, 20)); continue; }
    if (seen.has(keyForm(key))) continue;
    seen.add(keyForm(key)); out.push(key);
  }
  if (short.length) warnings.push('忽略了过短的关键词：' + short.join('、'));
  if (long.length) warnings.push('忽略了超过 ' + L.key + ' 字的关键词：' + long.join('、'));
  if (out.length > limit) { warnings.push('关键词超过 ' + limit + ' 个，只保留前 ' + limit + ' 个。'); out.length = limit; }
  return out;
}
function readFloors(v: unknown, range: { from: number; to: number }, warnings: string[]): number[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  const all = list.map(readUid).filter((n): n is number => n !== null);
  const inside = [...new Set(all.filter(n => n >= range.from && n <= range.to))].sort((a, b) => a - b).slice(0, L.floors);
  if (all.some(n => n < range.from || n > range.to)) warnings.push('部分依据楼层不在本次读取的范围内，已忽略。');
  return inside;
}
function normalizeTitle(s: string): string { return s.trim().toLowerCase(); }

/** 校验模型给出的动作，返回采用的建议和丢弃的动作。 */
export function validateActions(value: unknown, input: ValidationInput): ValidationResult {
  const actions = Array.isArray(value) ? value : isPlain(value) && Array.isArray(value.actions) ? value.actions : null;
  if (!actions) throw new WorldbookProtocolError('回复的 JSON 里没有 actions 数组。');
  const newId = input.newId ?? (() => crypto.randomUUID());
  const entries = listEntries(input.data);
  const suggestions: Suggestion[] = [], dropped: DroppedAction[] = [];
  const touched = new Set<number>(), flagged = new Set<number>(), titles = new Set<string>();
  actions.forEach((raw, index) => {
    let label = '第 ' + (index + 1) + ' 条';
    try {
      if (!isPlain(raw)) drop('不是 JSON 对象。');
      const name = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
      const uidHint = readUid(raw.uid);
      const known = own(FIELDS, name) ? KIND_LABELS[name as SuggestionKind] : name ? clip(name, 20) : '动作';
      if (name === 'create' && typeof raw.title === 'string' && raw.title.trim()) label = '新建「' + clip(raw.title.trim(), 30) + '」';
      else if (uidHint !== null) label = known + ' uid ' + uidHint;
      if (!name) drop('缺少 action。');
      if (own(UNSUPPORTED, name)) drop(UNSUPPORTED[name]);
      if (!own(FIELDS, name)) drop('不认识的动作「' + clip(name, 20) + '」。');
      const kind = name as SuggestionKind;
      if (suggestions.length >= L.actions) drop('超过单次 ' + L.actions + ' 条的上限。');
      const blocked = permissionBlock(kind, input.permission);
      if (blocked) drop(blocked);
      const warnings: string[] = [];
      // 别名：追加、替换的文字写成 content，新增关键词写成 keys
      const extra = Object.keys(raw).filter(k => !FIELDS[kind].includes(k) && !(kind !== 'create' && k === 'keys') && !(kind === 'append' && k === 'content'));
      if (extra.length) warnings.push('忽略了不支持的字段：' + extra.map(k => clip(k, 20)).join('、'));
      const reason = typeof raw.reason === 'string' ? clip(raw.reason.trim(), L.reason) : '';
      const floors = readFloors(raw.floors, input.range, warnings);
      const base: Suggestion = { id: newId(), kind, uid: null, title: '', keys: [], content: '', find: '', reason, floors, base: '', status: 'pending', edited: false, warnings };

      if (kind === 'create') {
        const title = readText(raw.title, 'title', 1, L.title);
        const existing = entries.find(e => normalizeTitle(entryTitle(e)) === normalizeTitle(title));
        if (existing) drop('目标世界书中已有同名条目「' + clip(entryTitle(existing), 30) + '」（uid ' + existing.uid + '）。需要补充时，可把修改权限调到「可补充」后重新生成。');
        if (titles.has(normalizeTitle(title))) drop('本批已有同名的新建条目。');
        const keys = readKeys(raw.keys, [], warnings);
        if (!keys.length) drop('没有可用的关键词。');
        const content = readText(raw.content, 'content', 1, L.create);
        titles.add(normalizeTitle(title));
        suggestions.push({ ...base, title, keys, content });
        return;
      }

      const uid = readUid(raw.uid);
      if (uid === null) drop('缺少 uid，或 uid 不是非负整数。已有条目只能按 uid 指定。');
      const found = findEntry(input.data, uid!);
      if (!found) drop('目标世界书中没有 uid 为 ' + uid + ' 的条目。');
      const entry = found!.entry as WorldEntry;
      const content = entryContent(entry);
      const title = clip(entryTitle(entry) || '（无标题）', 200);
      if (kind === 'flag') {
        if (!reason) drop('提醒没有写明原因。');
        if (flagged.has(uid!)) drop('同一条目已有一条提醒。');
        flagged.add(uid!);
        suggestions.push({ ...base, uid: uid!, title, base: entryBase(entry) });
        return;
      }
      if (touched.has(uid!)) drop('本批中同一条目已有一条修改建议。');
      const addKeys = readKeys(raw.addKeys ?? raw.keys, entryKeys(entry), warnings);
      const common = { ...base, uid: uid!, title, keys: addKeys, base: entryBase(entry) };
      if (kind === 'append') {
        const text = readText(raw.text ?? raw.content, 'text', 1, L.append);
        if (content.includes(text)) drop('条目中已有这段内容。');
        suggestions.push({ ...common, content: text });
      } else if (kind === 'replace') {
        const find = readText(raw.find, 'find', 1, L.find);
        const count = occurrences(content, find);
        if (!count) drop('条目原文中找不到 find 指定的文字（需要逐字一致）。');
        if (count > 1) drop('find 指定的文字在条目中出现了 ' + count + ' 次，无法确定替换哪一处。');
        const text = readText(raw.text, 'text', 0, L.replace);
        if (text === find) drop('替换前后的文字相同。');
        suggestions.push({ ...common, find, content: text });
      } else if (kind === 'rewrite') {
        const next = readText(raw.content, 'content', 1, L.rewrite);
        if (next === content.trim()) drop('改写后的内容与原文相同。');
        suggestions.push({ ...common, content: next });
      } else {
        if (!addKeys.length) drop('要加的关键词都已存在或不可用。');
        suggestions.push(common);
      }
      touched.add(uid!);
    } catch (error) {
      if (!(error instanceof Drop)) throw error;
      dropped.push({ label: clip(label, 120), reason: clip(error.message, 300) });
    }
  });
  return { suggestions, dropped };
}

export function parseWorldbookReply(reply: string, input: ValidationInput): ValidationResult {
  return validateActions(extractReplyJson(reply), input);
}

/**
 * 编辑建议后的校验：与模型输出用同一套规则。entry 为目标条目的当前内容（新建为 null），
 * book 用于检查同名条目。返回整理后的字段；不合格时抛出说明。
 */
export function normalizeEdit(kind: SuggestionKind, patch: { title: string; keys: string[] | string; content: string; find: string }, entry: WorldEntry | null, data: WorldData | null): { title: string; keys: string[]; content: string; find: string } {
  const warnings: string[] = [];
  try {
    if (kind === 'flag') return drop('提醒不能编辑。');
    if (kind === 'create') {
      const title = readText(patch.title, '标题', 1, L.title);
      const same = data ? listEntries(data).find(e => normalizeTitle(entryTitle(e)) === normalizeTitle(title)) : undefined;
      if (same) drop('目标世界书中已有同名条目「' + clip(entryTitle(same), 30) + '」（uid ' + same.uid + '）。');
      const keys = readKeys(patch.keys, [], warnings);
      if (!keys.length) drop('至少填写一个关键词（两个字以上）。');
      return { title, keys, content: readText(patch.content, '内容', 1, L.create), find: '' };
    }
    if (!entry) return drop('目标条目已不存在。');
    const content = entryContent(entry);
    const keys = readKeys(patch.keys, entryKeys(entry), warnings);
    if (kind === 'append') {
      const text = readText(patch.content, '追加内容', 1, L.append);
      if (content.includes(text)) drop('条目中已有这段内容。');
      return { title: '', keys, content: text, find: '' };
    }
    if (kind === 'replace') {
      const find = readText(patch.find, '原文片段', 1, L.find);
      const count = occurrences(content, find);
      if (!count) drop('条目原文中找不到这段文字（需要逐字一致）。');
      if (count > 1) drop('这段文字在条目中出现了 ' + count + ' 次，请多选几个字，让它只出现一次。');
      const text = readText(patch.content, '替换为', 0, L.replace);
      if (text === find) drop('替换前后的文字相同。');
      return { title: '', keys, content: text, find };
    }
    if (kind === 'rewrite') {
      const next = readText(patch.content, '改写后的内容', 1, L.rewrite);
      if (next === content.trim()) drop('改写后的内容与原文相同。');
      return { title: '', keys, content: next, find: '' };
    }
    if (!keys.length) drop('要加的关键词都已存在或不可用（每个至少两个字）。');
    return { title: '', keys, content: '', find: '' };
  } catch (error) {
    if (error instanceof Drop) throw new Error(error.message);
    throw error;
  }
}
