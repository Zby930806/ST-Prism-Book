import type { DiscussionMessage } from './discussionStore';
import { activeDiscussionPersona } from './persona';

/**
 * 规划讨论的显示辅助。模型回复常带 Markdown（标题、列表、粗体等），这里解析成结构化数据，
 * 由模板逐项渲染，不使用 v-html；无法识别的符号原样显示。只用前瞻、不用后顾断言，兼容旧版 iOS。
 */
export type InlinePart = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type ListItem = { depth: number; marker: string; parts: InlinePart[] };
export type DiscussionBlock =
  | { kind: 'p'; lines: InlinePart[][] }
  | { kind: 'h'; parts: InlinePart[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'quote'; lines: InlinePart[][] }
  | { kind: 'code'; text: string }
  | { kind: 'hr' };

const INLINE = /(\*\*|__)(?=\S)([^\n]*?\S)\1|`([^`\n]+)`|\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g;

export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const push = (part: InlinePart) => {
    if (!part.text) return;
    const last = parts[parts.length - 1];
    if (last && !last.bold && !last.italic && !last.code && !part.bold && !part.italic && !part.code) last.text += part.text;
    else parts.push(part);
  };
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    // 单个星号的斜体：左侧紧挨字母数字或星号时（如 a*b*c、***）按原文处理。
    if (match[4] !== undefined && start > 0 && /[\w*]/.test(text[start - 1])) continue;
    push({ text: text.slice(index, start) });
    if (match[2] !== undefined) push({ text: match[2], bold: true });
    else if (match[3] !== undefined) push({ text: match[3], code: true });
    else push({ text: match[4], italic: true });
    index = start + match[0].length;
  }
  push({ text: text.slice(index) });
  return parts;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
// 无序：- * + · 后须有空格；• ● ○ ◦ ▪ 可直接接文字。有序：1. 1) 1、 1）；「1.」后紧跟数字的视为小数。
const BULLET = /^(\s*)(?:[-*+·]\s+|[•●○◦▪]\s*)(\S.*)$/;
const ORDERED = /^(\s*)(\d{1,3})(?:\.(?!\d)|[)、）])\s*(\S.*)$/;

function indentDepth(indent: string): number {
  return Math.min(2, Math.floor(indent.replace(/\t/g, '    ').length / 2));
}

/** 把一条回复解析为段落、标题、列表、引用、代码块与分隔线。 */
export function parseDiscussionText(text: string): DiscussionBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DiscussionBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  // 列表项先存原文，续行拼接后再做行内解析。
  let list: { ordered: boolean; items: Array<Omit<ListItem, 'parts'> & { raw: string }> } | null = null;
  const flushParagraph = () => { if (paragraph.length) blocks.push({ kind: 'p', lines: paragraph.map(parseInline) }); paragraph = []; };
  const flushQuote = () => { if (quote.length) blocks.push({ kind: 'quote', lines: quote.map(parseInline) }); quote = []; };
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(({ raw, ...item }) => ({ ...item, parts: parseInline(raw) })) });
    list = null;
  };
  const flushAll = () => { flushParagraph(); flushQuote(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fence = raw.match(FENCE);
    if (fence) {
      flushAll();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) { flushAll(); continue; }
    if (RULE.test(line)) { flushAll(); blocks.push({ kind: 'hr' }); continue; }
    const heading = line.match(HEADING);
    if (heading) { flushAll(); blocks.push({ kind: 'h', parts: parseInline(heading[1]) }); continue; }
    const quoted = line.match(QUOTE);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    const ordered = line.match(ORDERED);
    const bullet = ordered ? null : line.match(BULLET);
    if (ordered || bullet) {
      flushParagraph(); flushQuote();
      if (!list) list = { ordered: !!ordered, items: [] };
      list.items.push(ordered
        ? { depth: indentDepth(ordered[1]), marker: `${ordered[2]}.`, raw: ordered[3] }
        : { depth: indentDepth(bullet![1]), marker: '•', raw: bullet![2] });
      continue;
    }
    // 列表项下缩进的续行并入上一项。
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1].raw += ' ' + line.trim();
      continue;
    }
    flushQuote(); flushList();
    paragraph.push(line.trim());
  }
  flushAll();
  return blocks;
}

/** 列表与卡片里的一行预览：去掉 Markdown 记号，合并空白，超长截断。 */
export function plainPreview(text: string, max = 80): string {
  const plain = text
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+·]\s+|[•●○◦▪]\s*|\d{1,3}(?:\.(?!\d)|[)、）])\s*)/gm, '')
    .replace(/(\*\*|__)(\S[^\n]*?)\1/g, '$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}

const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 消息旁的时间：当天只写时分，前一天写「昨天」，今年内写月日，更早的加年份。 */
export function discussionTimeLabel(at: number, now = Date.now()): string {
  const time = new Date(at), today = new Date(now);
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  if (sameDay(time, today)) return clock;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(time, yesterday)) return `昨天 ${clock}`;
  const day = `${time.getMonth() + 1}月${time.getDate()}日 ${clock}`;
  return time.getFullYear() === today.getFullYear() ? day : `${time.getFullYear()}年${day}`;
}

/** 完整日期时间，用于悬停提示和复制的文本。 */
export function discussionFullTime(at: number): string {
  const time = new Date(at);
  return `${time.getFullYear()}年${time.getMonth() + 1}月${time.getDate()}日 ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** 「复制全部讨论」的文本：按轮次排列，标明说话人；有时间的附上时间。 */
export function discussionTranscript(messages: DiscussionMessage[]): string {
  return messages.map(message => {
    const who = message.role === 'user' ? '你' : activeDiscussionPersona().name;
    const when = message.at ? `（${discussionFullTime(message.at)}）` : '';
    return `${who}${when}：\n${message.content.trim()}`;
  }).join('\n\n');
}

/**
 * 回复按空行拆成一条条气泡，像连发的消息；代码块里的空行不拆。
 * 一整条回复里没有空行时只有一条。拆出来的每条都是完整的 Markdown 片段，各自交给 parseDiscussionText 渲染。
 */
export function splitReplyBubbles(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const bubbles: string[] = [];
  let current: string[] = [];
  let fence = '';
  const flush = () => {
    const chunk = current.join('\n').trim();
    if (chunk) bubbles.push(chunk);
    current = [];
  };
  for (const line of lines) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && (!fence || mark[0] === fence[0] && mark.length >= fence.length)) fence = fence ? '' : mark;
    if (!fence && !mark && !line.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return bubbles.length ? bubbles : [text.trim()];
}
