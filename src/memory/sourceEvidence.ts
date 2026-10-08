/** 保守识别成对的 * / ** / *** / _ / __ / ___，不是 Markdown 转纯文本器。
 * 不移除转义、代码、链接、删除线等内容；不把单词内下划线或未配对符号当排版。
 * 仅支持长度相同、正确嵌套的强调定界符；不确定的 Markdown 仍要求照录。
 */
function withoutEmphasis(text: string): string {
  const stack: { marker: string; index: number }[] = [];
  const removed: { index: number; length: number }[] = [];
  let code = '';
  let previousEnd = 0;
  for (const match of text.matchAll(/\\[\s\S]|`+|~{3,}|\*+|_+/g)) {
    const marker = match[0];
    const index = match.index;
    // 强调不能跨越空行；代码内的所有字符保留，不解释强调。
    if (/\r?\n[ \t]*\r?\n/.test(text.slice(previousEnd, index))) stack.length = 0;
    previousEnd = index + marker.length;
    if (marker.startsWith('\\')) continue;
    if (code) {
      if (marker === code) code = '';
      continue;
    }
    if (marker[0] === '`' || marker[0] === '~') { code = marker; continue; }
    if (marker.length > 3) continue;
    const before = text[index - 1] ?? '';
    const after = text[index + marker.length] ?? '';
    const beforeSpace = !before || /\s/u.test(before);
    const afterSpace = !after || /\s/u.test(after);
    const beforePunct = /[\p{P}\p{S}]/u.test(before);
    const afterPunct = /[\p{P}\p{S}]/u.test(after);
    const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
    const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
    const canOpen = left && (marker[0] !== '_' || !right || beforePunct);
    const canClose = right && (marker[0] !== '_' || !left || afterPunct);
    const opener = stack.at(-1);
    if (canClose && opener?.marker === marker) {
      stack.pop();
      removed.push({ index: opener.index, length: marker.length }, { index, length: marker.length });
    } else if (canOpen) stack.push({ marker, index });
  }
  let result = '';
  let start = 0;
  for (const range of removed.sort((a, b) => a.index - b.index)) {
    result += text.slice(start, range.index);
    start = range.index + range.length;
  }
  return result + text.slice(start);
}

function normalizeEvidence(text: string): string {
  return withoutEmphasis(text)
    .replace(/\s+/gu, ' ').trim()
    // 汉字/标点旁的空白可来自缩进与折行；保留拉丁单词间的边界，不能 now here -> nowhere。
    .replace(/(?<=[\p{Script=Han}\p{P}]) | (?=[\p{Script=Han}\p{P}])/gu, '');
}

/** 同一原消息内的连续引文匹配；不得把多条消息或程序提示拼成证据。 */
export function createSourceEvidenceMatcher(content: string | readonly string[]): (quote: string) => boolean {
  const sources = typeof content === 'string' ? [content] : content;
  const normalizedSources = new Map<number, string>();
  return quote => {
    const exact = quote.trim();
    if (!exact) return false;
    if (sources.some(source => source.includes(exact))) return true;
    const normalizedQuote = normalizeEvidence(quote);
    if (!normalizedQuote) return false;
    return sources.some((source, index) => {
      if (!normalizedSources.has(index)) normalizedSources.set(index, normalizeEvidence(source));
      return normalizedSources.get(index)!.includes(normalizedQuote);
    });
  };
}
