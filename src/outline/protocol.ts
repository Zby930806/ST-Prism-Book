import type { OutlineContent } from './types';
import { OUTLINE_LIMITS as L } from './limits';

class OutlineValidationError extends Error {}
// 路径仅来自本地协议字段和数组下标，不使用模型提供的未知键或值。
const FIELD_LABELS: Record<string, string> = { title: '阶段标题', goal: '阶段目标', approach: '发展方式', beats: '剧情要点', exitCriteria: '推进条件' };
function fail(reason: string): never {
  const match = reason.match(/^chapters\[(\d+)\]\.([A-Za-z]+)/);
  const location = match && FIELD_LABELS[match[2]] ? '（第' + (Number(match[1]) + 1) + '阶段·' + FIELD_LABELS[match[2]] + '）' : '';
  throw new OutlineValidationError('大纲格式无效：' + reason + location);
}
function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path + ' 应为对象。');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(path + ' 应为普通对象。');
  const own = Reflect.ownKeys(value);
  const missing = keys.find(k => !Object.prototype.hasOwnProperty.call(value, k));
  if (missing) return fail(path + '.' + missing + ' 缺失。');
  if (own.length !== keys.length) return fail(path + ' 存在不支持的字段；请只保留规定字段。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, path: string): string {
  if (typeof value !== 'string') return fail(path + ' 应为文本。');
  const result = value.trim();
  if (!result) return fail(path + ' 不能为空白。');
  if (result.length > max) return fail(path + ' 超过' + max + '字，请精简。');
  return result;
}
function list<T>(value: unknown, min: number, max: number, path: string, read: (v: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(path + ' 应为' + min + '～' + max + '项的数组。');
  // Array.from 同时校验稀疏数组的空洞，不让 map 跳过必填项。
  return Array.from(value, (v, i) => read(v, path + '[' + i + ']'));
}

/** 只接受内容，不容许模型写入 enabled/currentChapter 等面板状态。用户手动编辑保存、已存数据的校验都用这套严格规则。 */
export function validateOutlineContent(value: unknown): OutlineContent {
  try {
    const root = object(value, ['title', 'premise', 'constraints', 'chapters'], '大纲');
    if (JSON.stringify(value).length > L.json) return fail('总 JSON 超过' + L.json + '字符，请精简或减少规划阶段数。');
    return {
      title: text(root.title, L.title, 'title'), premise: text(root.premise, L.premise, 'premise'),
      constraints: list(root.constraints, 0, L.constraints, 'constraints', (v, p) => text(v, L.constraint, p)),
      chapters: list(root.chapters, 1, L.chapters, 'chapters', (v, p) => {
        const chapter = object(v, ['title', 'goal', 'approach', 'beats', 'exitCriteria'], p);
        return {
          title: text(chapter.title, L.title, p + '.title'), goal: text(chapter.goal, L.goal, p + '.goal'),
          approach: text(chapter.approach, L.approach, p + '.approach'),
          beats: list(chapter.beats, 1, L.beats, p + '.beats', (b, bp) => text(b, L.beat, bp)),
          exitCriteria: text(chapter.exitCriteria, L.exitCriteria, p + '.exitCriteria'),
        };
      }),
    };
  } catch (error) {
    if (error instanceof OutlineValidationError) throw error;
    return fail('内容无法读取，请检查是否为完整的标准 JSON 对象。');
  } // 不回显解析异常、未知字段名或模型原文。
}

/* ============ 模型回复：宽松提取与整理 ============ */

/**
 * 去掉 JSON 字符串之外已闭合的思考块（字符串中的字面文本保持原样）。
 * 有没闭合的 <think> 时判为不完整；预填充时只有结尾标签，丢弃它之前的内容。
 */
function withoutThinking(reply: string): string {
  let result = '', quoted = false, escaped = false, strayClose = -1;
  for (let i = 0; i < reply.length; i++) {
    const c = reply[i];
    if (!quoted && c === '<') {
      const rest = reply.slice(i);
      const block = rest.match(/^<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/i);
      if (block) { i += block[0].length - 1; continue; }
      if (/^<(think|thinking)\b/i.test(rest)) fail('回复中的思考过程没有写完（缺少结束标签），没有可用的大纲。多半是输出达到了长度上限，可调大该 API 的「最大输出」后重试。');
      const close = rest.match(/^<\/(?:think|thinking)\s*>/i);
      if (close) { strayClose = result.length + close[0].length; result += close[0]; i += close[0].length - 1; continue; }
    }
    result += c;
    if (escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  return (strayClose >= 0 ? result.slice(strayClose) : result).trim();
}

/** 从 start 处的 { 找到配对的 }（跳过字符串内容）；找不到返回 -1。 */
function matchBrace(text: string, start: number): number {
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

function parseObjectAt(text: string, start: number): { value: Record<string, unknown>; end: number } | null {
  const end = matchBrace(text, start);
  if (end < 0) return null;
  const json = text.slice(start, end + 1);
  for (const candidate of [json, stripTrailingCommas(json)]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return { value: value as Record<string, unknown>, end };
    } catch { /* 再试下一种 */ }
  }
  return null;
}

/**
 * 与世界书建议相同的提取方式：去掉已闭合的思考块，跳过 JSON 前后的说明文字和代码围栏，取第一个完整的大纲 JSON 对象
 * （含 chapters 或 premise 字段的对象；大纲里面的阶段对象等不算）。大纲被包在别的对象里时（如 {"outline": {…}}）照样取出。
 * 没闭合的 <think> 判为不完整；出现多个完整的大纲 JSON 对象时无法确定用哪一个，也拒绝。
 */
export function extractOutlineJson(reply: string): Record<string, unknown> {
  if (typeof reply !== 'string' || reply.length > L.reply) throw new Error('大纲回复无效或超过 ' + L.reply + ' 字符，请缩短后重试。');
  const text = withoutThinking(reply);
  const outlineLike = (v: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(v, 'chapters') || Object.prototype.hasOwnProperty.call(v, 'premise');
  let found: { value: Record<string, unknown>; end: number } | null = null;
  let otherObject = false, attempts = 0;
  for (let at = text.indexOf('{'); at >= 0 && attempts < 200; at = text.indexOf('{', at + 1), attempts++) {
    const parsed = parseObjectAt(text, at);
    if (!parsed) continue;
    // 不是大纲的对象不整块跳过，继续往里找：模型偶尔把大纲包在 {"outline": …} 之类的外层对象里
    if (!outlineLike(parsed.value)) { otherObject = true; continue; }
    if (found) return fail('回复中有多个大纲 JSON 对象，无法确定使用哪一个；请重新生成。');
    if (parsed.end - at + 1 > L.json) return fail('总 JSON 超过' + L.json + '字符，请精简或减少规划阶段数。');
    found = parsed;
    at = parsed.end;
  }
  if (found) return found.value;
  const broken = 'JSON 语法无效或不完整。若输出被截断，可减少阶段数或调大该 API 的「最大输出」后重试。';
  if (/"(?:chapters|premise)"\s*:/.test(text)) return fail(broken);
  if (otherObject) return fail('回复中的 JSON 不是大纲（缺少 title、premise、chapters 等字段），请重新生成。');
  if (text.includes('{')) return fail(broken);
  return fail('回复中没有大纲 JSON，请重新生成。');
}

/** 截到上限：超过时只保留前面的部分，并记一条调整说明。 */
function fitText(value: unknown, max: number, path: string, label: string, warnings: string[]): string {
  if (typeof value !== 'string') return fail(path + ' 应为文本。');
  const result = value.trim();
  if (!result) return fail(path + ' 不能为空白。');
  if (result.length <= max) return result;
  warnings.push(label + '超过' + max + '字，已截断。');
  return result.slice(0, max).trimEnd();
}

/**
 * 整理模型输出（只用于模型回复，不用于用户保存的编辑）：忽略多余字段，超长文本截断，超出项数的数组只保留前面的，
 * 并把这些调整写成警告随草稿显示。缺少必填内容、类型不对或整理后仍超过总长度上限时照常报错。
 */
export function normalizeOutlineReply(value: unknown): { content: OutlineContent; warnings: string[] } {
  const warnings: string[] = [];
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('大纲 应为对象。');
    const root = value as Record<string, unknown>;
    const rootKeys = ['title', 'premise', 'constraints', 'chapters'];
    const missing = ['title', 'premise', 'chapters'].find(k => !Object.prototype.hasOwnProperty.call(root, k));
    if (missing) return fail('大纲.' + missing + ' 缺失。');
    let extra = Object.keys(root).filter(k => !rootKeys.includes(k)).length;
    let constraints: string[] = [];
    if (root.constraints === undefined) warnings.push('回复没有 constraints（整体约束），按没有约束处理。');
    else if (!Array.isArray(root.constraints)) return fail('constraints 应为0～' + L.constraints + '项的数组。');
    else {
      const items = root.constraints.filter((c): c is string => typeof c === 'string' && !!c.trim());
      if (items.length < root.constraints.length) warnings.push('整体约束中有 ' + (root.constraints.length - items.length) + ' 项不是有效文字，已舍弃。');
      if (items.length > L.constraints) warnings.push('整体约束超过' + L.constraints + '条，只保留前' + L.constraints + '条。');
      constraints = items.slice(0, L.constraints).map((c, i) => fitText(c, L.constraint, 'constraints[' + i + ']', '第' + (i + 1) + '条整体约束', warnings));
    }
    if (!Array.isArray(root.chapters) || !root.chapters.length) return fail('chapters 应为1～' + L.chapters + '项的数组。');
    if (root.chapters.length > L.chapters) warnings.push('规划阶段超过' + L.chapters + '个，只保留前' + L.chapters + '个。');
    const chapters = Array.from(root.chapters.slice(0, L.chapters), (raw, i) => {
      const p = 'chapters[' + i + ']', name = '第' + (i + 1) + '阶段';
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(p + ' 应为对象。');
      const chapter = raw as Record<string, unknown>;
      const keys = ['title', 'goal', 'approach', 'beats', 'exitCriteria'];
      const lack = keys.find(k => !Object.prototype.hasOwnProperty.call(chapter, k));
      if (lack) return fail(p + '.' + lack + ' 缺失。');
      extra += Object.keys(chapter).filter(k => !keys.includes(k)).length;
      if (!Array.isArray(chapter.beats)) return fail(p + '.beats 应为1～' + L.beats + '项的数组。');
      const beats = chapter.beats.filter((b): b is string => typeof b === 'string' && !!b.trim());
      if (!beats.length) return fail(p + '.beats 应为1～' + L.beats + '项的数组。');
      if (beats.length > L.beats) warnings.push(name + '的剧情要点超过' + L.beats + '条，只保留前' + L.beats + '条。');
      return {
        title: fitText(chapter.title, L.title, p + '.title', name + '·阶段标题', warnings),
        goal: fitText(chapter.goal, L.goal, p + '.goal', name + '·阶段目标', warnings),
        approach: fitText(chapter.approach, L.approach, p + '.approach', name + '·发展方式', warnings),
        beats: beats.slice(0, L.beats).map((b, j) => fitText(b, L.beat, p + '.beats[' + j + ']', name + '·第' + (j + 1) + '条剧情要点', warnings)),
        exitCriteria: fitText(chapter.exitCriteria, L.exitCriteria, p + '.exitCriteria', name + '·推进条件', warnings),
      };
    });
    if (extra) warnings.unshift('忽略了回复中 ' + extra + ' 个不支持的字段。');
    const content = validateOutlineContent({
      title: fitText(root.title, L.title, 'title', '规划标题', warnings),
      premise: fitText(root.premise, L.premise, 'premise', '整体发展方向', warnings),
      constraints, chapters,
    });
    return { content, warnings };
  } catch (error) {
    if (error instanceof OutlineValidationError) throw error;
    return fail('内容无法读取，请检查是否为完整的标准 JSON 对象。');
  }
}

/** 解析模型的规划回复：宽松提取第一个完整的 JSON 对象，再整理；返回内容和调整说明。 */
export function parseOutlineReply(reply: string): { content: OutlineContent; warnings: string[] } {
  return normalizeOutlineReply(extractOutlineJson(reply));
}
