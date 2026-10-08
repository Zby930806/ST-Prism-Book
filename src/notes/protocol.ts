import type { NoteQuestion } from './types';
/** 正文与摘要共享的戏外札记边界。截断未闭合块也不作为剧情读取。 */
export function stripAftertalk(text: string): string {
  return text.replace(/<aftertalk\b[^>]*>[\s\S]*?(?:<\/aftertalk\s*>|$)/gi, '').trim();
}
export function extractAftertalk(text: string): string[] {
  return Array.from(text.matchAll(/<aftertalk\b[^>]*>([\s\S]*?)<\/aftertalk\s*>/gi), m => m[1].trim()).filter(Boolean);
}
export function parseQuestions(text: string): NoteQuestion[] {
  const headings = Array.from(text.matchAll(/^[ \t]*(?:[-*]\s*)?(?:\*\*)?(Q[1-4])(?:\*\*)?[ \t]*[.．、:：)）][ \t]*/gm));
  const seen = new Set<string>();
  return headings.flatMap((m, i) => {
    const id = m[1]; if (seen.has(id)) return []; seen.add(id);
    const body = text.slice(m.index! + m[0].length, headings[i+1]?.index ?? text.length).split(/\n\s*(?:收尾|凝嘤嘤收尾)[：:]/)[0].trim();
    const marker = /(?:\*\*)?凝嘤嘤暂定(?:写法)?(?:\*\*)?\s*[：:]/.exec(body);
    return [{ id, label: id, prompt: (marker ? body.slice(0, marker.index) : body).trim(), proposal: marker ? body.slice(marker.index + marker[0].length).trim() : '' }];
  });
}
/** 非安全用途的双32位来源指纹，包含全部正文而非只取首尾。 */
export function fingerprint(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i=0;i<text.length;i++) { const c=text.charCodeAt(i); a=Math.imul(a^c,16777619); b=Math.imul(b,33)^c; }
  return text.length.toString(36)+':'+(a>>>0).toString(36)+':'+(b>>>0).toString(36);
}
export function noteText(reply: string): string {
  const clean = reply.replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
  if (clean.length > 80000) throw new Error('札记返回过长，未保存；请降低输出上限。');
  return extractAftertalk(clean).join('\n\n') || clean;
}
