import type { OutlineContent } from './types';

const INVALID = '大纲格式无效：请仅提供规定字段，并检查文字长度、章节数量及 JSON 总长度。';
function fail(): never { throw new Error(INVALID); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every(k => Object.prototype.hasOwnProperty.call(value, k))) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return fail();
  const result = value.trim();
  if (!result || result.length > max) return fail();
  return result;
}
function list<T>(value: unknown, min: number, max: number, read: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail();
  // Array.from 同时校验稀疏数组的空洞，不让 map 跳过必填项。
  return Array.from(value, read);
}

/** 只接受内容，不容许模型写入 enabled/currentChapter 等面板状态。 */
export function validateOutlineContent(value: unknown): OutlineContent {
  try {
    const root = object(value, ['title', 'premise', 'constraints', 'chapters']);
    if (JSON.stringify(value).length > 24000) return fail();
    return {
      title: text(root.title, 120), premise: text(root.premise, 2000),
      constraints: list(root.constraints, 0, 12, v => text(v, 600)),
      chapters: list(root.chapters, 1, 12, v => {
        const chapter = object(v, ['title', 'goal', 'approach', 'beats', 'exitCriteria']);
        return {
          title: text(chapter.title, 120), goal: text(chapter.goal, 1200),
          approach: text(chapter.approach, 1600),
          beats: list(chapter.beats, 1, 8, b => text(b, 800)),
          exitCriteria: text(chapter.exitCriteria, 1000),
        };
      }),
    };
  } catch { return fail(); } // 不回显解析异常、未知字段名或模型原文。
}

/** 只剥离 JSON 字符串之外的闭合思考块，字符串中的字面文本保持原样。 */
function withoutThinking(reply: string): string {
  let result = '', quoted = false, escaped = false;
  for (let i = 0; i < reply.length; i++) {
    const c = reply[i];
    if (!quoted && c === '<') {
      const block = reply.slice(i).match(/^<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/i);
      if (block) { i += block[0].length - 1; continue; }
    }
    result += c;
    if (escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  return result.trim();
}

export function parseOutlineReply(reply: string): OutlineContent {
  if (typeof reply !== 'string' || reply.length > 50000) throw new Error('大纲回复无效或超过 50000 字，请缩短后重试。');
  let json = withoutThinking(reply);
  if (json.startsWith('```')) {
    const fence = json.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!fence) return fail();
    json = fence[1].trim();
  }
  if (!json || json.length > 24000) return fail();
  let value: unknown;
  try { value = JSON.parse(json); } catch { return fail(); }
  return validateOutlineContent(value);
}
