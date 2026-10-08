import type { OutlineContent } from './types';
import { OUTLINE_LIMITS as L } from './limits';

class OutlineValidationError extends Error {}
// 路径仅来自本地协议字段和数组下标，不使用模型提供的未知键或值。
function fail(reason: string): never {
  const match = reason.match(/^chapters\[(\d+)\]\.([A-Za-z]+)/);
  const labels: Record<string, string> = { title: '阶段标题', goal: '阶段目标', approach: '发展方式', beats: '剧情要点', exitCriteria: '推进条件' };
  const location = match && labels[match[2]] ? '（第' + (Number(match[1]) + 1) + '阶段·' + labels[match[2]] + '）' : '';
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

/** 只接受内容，不容许模型写入 enabled/currentChapter 等面板状态。 */
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
  if (typeof reply !== 'string' || reply.length > L.reply) throw new Error('大纲回复无效或超过 ' + L.reply + ' 字符，请缩短后重试。');
  let json = withoutThinking(reply);
  if (json.startsWith('```')) {
    const fence = json.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!fence) return fail('只接受一个完整的 json 或无语言标签代码围栏，不附前后说明。');
    json = fence[1].trim();
  }
  if (!json) return fail('回复中没有大纲 JSON，请重新生成。');
  if (json.length > L.json) return fail('总 JSON 超过' + L.json + '字符，请精简或减少规划阶段数。');
  let value: unknown;
  try { value = JSON.parse(json); } catch { return fail('JSON 语法无效或不完整；请检查是否夹有说明文字。若输出被截断，可减少阶段数或提高 API 输出上限后手动重试。'); }
  return validateOutlineContent(value);
}
