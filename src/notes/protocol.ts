import type { NoteQuestion } from './types';
/** 正文与摘要共享的戏外札记边界。截断未闭合块也不作为剧情读取。 */
export function stripAftertalk(text: string): string {
  return text.replace(/<aftertalk\b[^>]*>[\s\S]*?(?:<\/aftertalk\s*>|$)/gi, '').trim();
}
export function extractAftertalk(text: string): string[] {
  return Array.from(text.matchAll(/<aftertalk\b[^>]*>([\s\S]*?)<\/aftertalk\s*>/gi), m => m[1].trim()).filter(Boolean);
}
/** 全角的英文字母、数字和标点换成半角，全角空格换成空格；逐字一一对应，位置不变。只用于识别 Ｑ１ 这类写法。 */
function foldWidth(text: string): string {
  return text.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}
/** 原来就认的写法：行首只有列表符号或 **，Q1–Q4 后紧跟 . 、 : ）之类的标点。 */
const STRICT_HEAD = /^[ \t]*(?:[-*]\s*)?(?:\*\*)?(Q[1-4])(?:\*\*)?[ \t]*[.．、:：)）][ \t]*/;
/** 放宽的写法（在全半角统一后的行上识别）：行首可有 #、>、序号、列表符号和【】，Q 编号后可接空格或常见标点。 */
const LOOSE_HEAD = /^[ \t]*(?:(?:#{1,6}|>|[-*+•·]|\d{1,2}[.、)])[ \t]*)*(?:\*\*)?(【)?(?:\*\*)?Q([1-4])(?![0-9])(?:\*\*)?(】)?(?:\*\*)?([ \t]*[.、:)][ \t]*|[ \t]+)?/;
const PROPOSAL_MARKERS = [/(?:\*\*)?凝嘤嘤暂定(?:写法)?(?:\*\*)?\s*[：:]/, /(?:\*\*)?暂定(?:写法)?(?:\*\*)?\s*[：:]/];
const proposalMarker = (body: string) => PROPOSAL_MARKERS[0].exec(body) ?? PROPOSAL_MARKERS[1].exec(body);
/** 「想问用户」小节：标题行之后到「收尾」之前；找不到标题时为全文。 */
function questionSection(text: string): { start: number; end: number } {
  const title = /^[ \t]*(?:[#>*+-]+[ \t]*)?(?:\*\*|【)?[ \t]*想问用户[^\n]*$/m.exec(text);
  if (!title) return { start: 0, end: text.length };
  const start = title.index + title[0].length;
  const tail = /^[ \t]*(?:[#>*+-]+[ \t]*)?(?:\*\*|【)?[ \t]*(?:凝嘤嘤)?收尾/m.exec(text.slice(start));
  return { start, end: tail ? start + tail.index : text.length };
}
/**
 * 识别札记里的 Q1–Q4 编号问题。先找「想问用户」小节，只在这一节里识别（进度清单里引用的 Q 编号不算）；找不到时用全文。
 * 原来的写法照常识别；用放宽后的写法（Markdown 标题、【Q1】、序号、全角数字、编号后只有空格等）识别出来的，正文里要有「暂定」标记才算。
 */
export function parseQuestions(text: string): NoteQuestion[] {
  const { start, end } = questionSection(text);
  const folded = foldWidth(text);
  let heads: Array<{ id: string; at: number; bodyAt: number; loose: boolean }> = [];
  for (let at = start; at < end;) {
    const lineEnd = Math.min(end, (text.indexOf('\n', at) + 1 || text.length + 1) - 1);
    const line = text.slice(at, lineEnd);
    const strict = STRICT_HEAD.exec(line);
    if (strict) heads.push({ id: strict[1], at, bodyAt: at + strict[0].length, loose: false });
    else {
      const loose = LOOSE_HEAD.exec(folded.slice(at, lineEnd));
      // 【Q1】可以直接接文字；其余写法编号后须有空格或标点
      if (loose && (loose[3] || loose[4]) && (!loose[1] || loose[3])) heads.push({ id: 'Q' + loose[2], at, bodyAt: at + loose[0].length, loose: true });
    }
    at = lineEnd + 1;
  }
  const bodyOf = (list: typeof heads, i: number) => text.slice(list[i].bodyAt, list[i + 1]?.at ?? end).split(/\n\s*(?:收尾|凝嘤嘤收尾)[：:]/)[0].trim();
  // 放宽写法识别出的、正文里没有「暂定」的不算问题，它的文字并回上一题
  heads = heads.filter((h, i) => !h.loose || !!proposalMarker(bodyOf(heads, i)));
  const seen = new Set<string>();
  return heads.flatMap((h, i) => {
    if (seen.has(h.id)) return [];
    seen.add(h.id);
    const body = bodyOf(heads, i);
    // 模型偶尔漏写「凝嘤嘤」只写「暂定:」，这时按「暂定」加冒号认提案；问题里「先暂定一个地点」这类不带冒号的不算。
    const marker = proposalMarker(body);
    return [{ id: h.id, label: h.id, prompt: (marker ? body.slice(0, marker.index) : body).trim(), proposal: marker ? body.slice(marker.index + marker[0].length).trim() : '' }];
  });
}
/** 模型回复「本轮无需新增札记」（可带标点、括号或空白）时为 true：这样的回复不保存成札记。 */
export function isNoNoteReply(text: string): boolean {
  const compact = text.replace(/[\s。．.!！?？、，,：:;；…「」『』“”"'*_#>【】()（）~～-]/g, '');
  return ['本轮无需新增札记', '本轮无需札记', '无需新增札记', '本轮不需要新增札记'].includes(compact);
}
/** 非安全用途的双32位来源指纹，包含全部正文而非只取首尾。 */
export function fingerprint(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i=0;i<text.length;i++) { const c=text.charCodeAt(i); a=Math.imul(a^c,16777619); b=Math.imul(b,33)^c; }
  return text.length.toString(36)+':'+(a>>>0).toString(36)+':'+(b>>>0).toString(36);
}
export function noteText(reply: string): string {
  const clean = reply.replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
  if (clean.length > 80000) throw new Error('札记返回过长（超过 8 万字），没有保存；请调低最大输出。');
  const blocks = extractAftertalk(clean);
  if (blocks.length) return blocks.join('\n\n');
  // 写到一半被截断时只有开头标签，去掉标签、保留已写出的内容。
  const open = /<aftertalk\b[^>]*>([\s\S]*)$/i.exec(clean);
  return open ? open[1].trim() : clean;
}
