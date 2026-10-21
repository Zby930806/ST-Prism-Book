/**
 * 无名角色标签:正文没给名字的登场人物以「职业或身份 + 大写字母」为名,如「酒保A」「守卫B」「Bartender A」。
 * 纯函数、无运行时依赖(scripts/test-memory-regressions.mjs 以独立模块方式加载引用它的 npcRelations.ts)。
 *
 * 判定从严,宁可漏判:标签前缀须至少两个字符,汉字前缀直接接字母,拉丁前缀与字母之间要有空格。
 * 「小A」「ANNA」这类常见名字不算标签。用途:不在场时不发给正文模型、按职业词回看原文。
 */
const FULL_WIDTH_A = 0xff21;

function halfWidthLetter(ch: string): string {
  const code = ch.charCodeAt(0);
  return code >= FULL_WIDTH_A && code < FULL_WIDTH_A + 26 ? String.fromCharCode(code - FULL_WIDTH_A + 65) : ch;
}

/** 是标签就返回前缀(职业或身份词),否则返回空串。 */
export function npcLabelBase(name: string | undefined): string {
  const raw = (name ?? '').trim();
  if (raw.length < 3) return '';
  const last = halfWidthLetter(raw[raw.length - 1]);
  if (!/^[A-Z]$/.test(last)) return '';
  const head = raw.slice(0, -1);
  // 汉字(含日文假名、韩文)前缀直接接字母:酒保A、守卫B
  const cjk = head.match(/^([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}·・]{2,})$/u);
  if (cjk) return cjk[1];
  // 拉丁前缀与字母之间有空格:Bartender A
  const latin = head.match(/^([A-Za-z][A-Za-z' -]*[A-Za-z]) $/);
  return latin && latin[1].length >= 2 ? latin[1] : '';
}

export function isNpcLabelName(name: string | undefined): boolean {
  return !!npcLabelBase(name);
}

/**
 * 回看原文时检索的词:名字本身、改名前用过的名字;标签再加职业词。
 * 少于两个字的词不检索(单字会命中大量无关文字)。去重后按出现先后返回。
 */
export function npcSearchTerms(name: string, formerNames: readonly string[] = []): string[] {
  const out: string[] = [];
  const push = (term: string) => {
    const t = term.trim();
    if (Array.from(t).length >= 2 && !out.includes(t)) out.push(t);
  };
  for (const n of [name, ...formerNames]) {
    push(n);
    const base = npcLabelBase(n);
    if (base) push(base);
  }
  return out;
}

/** 正文是否提到这个角色(名字、旧名或标签的职业词);用于判断本楼是否需要完整档案。单字名字照常匹配。 */
export function npcMentioned(text: string, name: string, formerNames: readonly string[] = []): boolean {
  if (!text) return false;
  for (const n of [name, ...formerNames]) {
    const t = n.trim();
    if (t && text.includes(t)) return true;
    const base = npcLabelBase(t);
    if (base && text.includes(base)) return true;
  }
  return false;
}
