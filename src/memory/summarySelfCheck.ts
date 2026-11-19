/**
 * 总结、二次总结写完后的核对:让模型对照输入逐个场合核对一遍,给出写错的句子和改正后的句子,这里按原句替换。
 *
 * 为什么不让模型直接重写一份:重写等于再合并一次,同样会写错别处,还可能把留下的事又删掉;
 * 只换写错的那一句,改动看得见,改不上的(原句对不上、改得太长、删掉了内容)就不改,最坏的结果是和没查一样。
 *
 * 只查「写错」:人物、日期、数量、地点、结果被写错。写得简略、省掉细节不算,不借这一步往回加内容。
 * 只改不删:第一版允许把「没有依据」的内容删掉,实测(deepseek-v4.1-flash,32 条)25 处改动里有 2 处因此丢了事实——
 * 一处是日期安错的两句话被整句删掉(应当改日期),一处是输入自己写反了人、总结写对了,核对时照着输入把这半句删了;
 * 后来还见过把安错日子的那句话换成当天别的事,字数没少,事情却没了。
 * 所以规则里不再有「删」;替换时拿掉内容的改动(明显变短,或一整句话被换成了别的话)也不接受,
 * 除非拿掉的话被同一次回复的另一项加到了别处(挪到正确的日子,见 applyFixes)。
 *
 * 核对以输入为准,看不到原文:输入自己写错的地方查不出来,总结碰巧写对了的还会被照着输入改回去(同一批实测里出现过一处)。
 */
import { extractJsonObject } from './json';

export interface SummaryFix {
  /** 总结里写错的那一句(模型从总结里照抄的)。 */
  wrong: string;
  /** 改正后的句子。 */
  right: string;
  /** 错在哪(只用于日志)。 */
  why: string;
}

export interface SkippedFix extends SummaryFix {
  reason: 'empty' | 'same' | 'too-short' | 'too-long' | 'drops' | 'not-found' | 'ambiguous' | 'too-many';
}

/** 规则。{{what}} 由调用方填「总结」或「二次总结」。 */
export const SELF_CHECK_RULES = `═══ 任务 ═══
材料里有【输入】（按时间先后排列的若干条记录，每条前面的括注是它的时间范围，不是其中每件事发生的时刻）和【{{what}}】（由这些记录合并成的一条）。【{{what}}】以后会代替【输入】发给续写模型，所以它不能把事实写错。请对照【输入】逐句核对【{{what}}】，找出写错的地方，给出改正后的句子。

═══ 只查这几类错 ═══
- 人物：谁做的、对谁做的、谁说的写错了，或者「他」「她」指错了人。一句话里连着写了几个动作的，逐个看每个动作是谁做的。
- 日期和时刻：把一件事安到了别的日子或时刻。
- 数量：次数、数目、金额写错了。
- 地点：写错了地方。
- 结果：没做成的写成做成了，打算、建议写成已经做了，条件、后果或原因被改动。
这些不算错，不要动：比【输入】简略，省掉了某件事或某个细节；换了说法但意思相同；同一个场合里几句话先后的细微调换。
【输入】自己写得含糊、有歧义或前后对不上的地方也不要动：只有【输入】写得明确、【{{what}}】和它明显不同，才算写错。拿不准的不报。

═══ 输出格式 ═══
先在 <thinking></thinking> 里逐个场合核对（写法见材料之后），再只输出一个 JSON 对象，不要 Markdown 围栏和其他说明文字：
{"fixes":[{"wrong":"写错的那一句","right":"改正后的这一句","why":"错在哪"}]}
- wrong：从【{{what}}】里原样照抄，一个字不改，必须能在【{{what}}】里找到；只抄写错的那一句或那半句，不抄一整段。一处错一项。
- right：用来替换 wrong 的句子。只把写错的地方改对，其余照原句，句式和长短尽量不变；改正用的事实必须出自【输入】，不补充【输入】里没有的内容，也不顺手添细节。
- 只改不删：这件事【输入】里有，只是人物、日期、数量或地点写错了，就把写错的地方改对，事情本身要留在句子里。日期安错了的，在这一句里把它的日期写对；也可以分成两项，一项把它从这一句里拿掉，一项把它加进它那天的句子里。只拿掉、不加回去的不算改正。
- 没有发现错处时输出 {"fixes":[]}。`;

/** 材料。{{content}} 与合并时发给模型的输入相同。 */
export const SELF_CHECK_INPUT = `【输入】（按时间先后；每条前的括注是它的时间范围）
{{content}}

【{{what}}】
{{summary}}`;

/**
 * 检查块的写法,放在材料之后。按场合一行一行过、没有出入的只写「对」:
 * 让模型逐句写下核对过程时,一次请求平均一分半钟、一万六千 token;这样写平均二十多秒,找到的错处相差不多。
 */
export const SELF_CHECK_NOTE = '先在 <thinking></thinking> 里按日期逐个场合核对，一个场合一行：人物、日期、数量、地点、结果都对得上的只写日期和「对」，有出入的写清错在哪；不抄原句，不复述【输入】。闭合之后再输出 JSON。开头已经有 <thinking> 时接着写，不要再开第二个。';
export const SELF_CHECK_PREFILL = '<thinking>';

export function buildSelfCheckPrompt(what: string, content: string, summary: string): { system: string; user: string; note: string; prefill: string } {
  // 三个占位符一次换完:材料或总结里即使带着 {{summary}} 这样的字样,也不会被再展开
  const values: Record<string, string> = { what, content, summary };
  return {
    system: SELF_CHECK_RULES.replaceAll('{{what}}', what),
    user: SELF_CHECK_INPUT.replace(/\{\{(what|content|summary)\}\}/g, (_, key: string) => values[key]),
    note: SELF_CHECK_NOTE,
    prefill: SELF_CHECK_PREFILL,
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\s*\n+\s*/g, '').trim();

/** 从模型交回的对象里取出改正项;格式不对(没有 fixes 数组)时返回 null。 */
export function readFixes(data: unknown): SummaryFix[] | null {
  const list = (data as { fixes?: unknown } | null)?.fixes;
  if (!Array.isArray(list)) return null;
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => ({ wrong: text(item.wrong), right: text(item.right), why: text(item.why) }));
}

/**
 * 解析核对的回复。先按摘要回复的通用办法取(去掉检查块,取第一个花括号到最后一个花括号);
 * 取不到时再找最后一个以 "fixes" 开头的对象:模型偶尔把 JSON 写进了检查块里,或者检查块没有闭合。
 */
export function parseSelfCheckReply(raw: string): SummaryFix[] | null {
  const direct = readFixes(extractJsonObject(raw));
  if (direct) return direct;
  const source = String(raw ?? '');
  const starts = [...source.matchAll(/\{\s*"fixes"/g)].map(m => m.index ?? 0);
  const end = source.lastIndexOf('}');
  for (const at of starts.reverse()) {
    if (end <= at) continue;
    const fixes = readFixes(extractJsonObject(source.slice(at, end + 1)));
    if (fixes) return fixes;
  }
  return null;
}

/** 一次最多改这么多处;报得再多,多半是模型把「写得简略」也当成了错。 */
const MAX_FIXES = 24;
/** wrong 太短时在总结里可能到处都是,不改。长度的算法见 lengthOf,下同。 */
const MIN_WRONG = 6;
/**
 * 改正后最多比原句短这么多,再短就算删掉了内容:两三个字已经可以是一个次数、一个地点。
 * 这样会挡掉一部分改得对的(去掉多写进去的一个人、把日期换成更短的写法),实测里每遍有两到四处;
 * 换来的是这一步不让总结里的事变少(实测的两组里没有出现丢事实的改动)。改对的改动绝大多数是换几个字或者变长,不受影响。
 */
const MAX_SHRINK = 1;
/** 被换掉的那一段有这么长、留在改正后句子里的不到一半,就是把一件事换成了别的话(长短差不多,事情却没了)。 */
const MIN_REPLACED = 16;
const KEPT_SHARE = 0.5;
/**
 * 拿掉的话有这么长、其中三成的四字片段出现在另一项加进去的内容里,才算被挪到了别处。
 * 挪的时候常把转述换回原话、把「他」换成名字,逐字相同的只有一部分;不相干的两句话则几乎没有相同的四字片段。
 */
const MIN_MOVED = 8;
const MOVED_SHARE = 0.3;
const GRAM = 4;
const PUNCT = '\\s，。、；：！？,.;:!?';
const EDGE = new RegExp(`^[${PUNCT}]+|[${PUNCT}]+$`, 'g');
const TAIL = new RegExp(`[${PUNCT}]+$`);
const MARKS = new RegExp(`[${PUNCT}「」『』“”"'（）()]`, 'g');
/** 一个字一个字地算长度的文字:汉字、假名、谚文。 */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const UNIT = new RegExp(`([${CJK}])|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');

/**
 * 一段话的长度,上面各条界限都按它算,不按字符数:汉字(假名、谚文)一个算 1;连着的字母或数字——一个英文单词、
 * 一个英文或拼音写的人名、一个数——最多算 2,不论拼出来多长(只有一个字母或一位数字的算 1);标点和空白不算。
 * 按字符数算的话,人物叫 Alexander 和 Eve 的总结里,把一个名字换成另一个会被当成删了六个字,
 * 「Alexander到Eve家吃饭」这半句也会被当成一整句话。
 */
function lengthOf(value: string): number {
  let total = 0;
  for (const unit of value.matchAll(UNIT)) total += unit[1] ? 1 : Math.min(2, Array.from(unit[0]).length);
  return total;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** 去掉标点后的字。 */
const plainChars = (value: string) => Array.from(value.replace(MARKS, ''));

function grams(value: string): Set<string> {
  const chars = plainChars(value);
  const out = new Set<string>();
  for (let i = 0; i + GRAM <= chars.length; i++) out.add(chars.slice(i, i + GRAM).join(''));
  return out;
}

/** list 里的四字片段有多大比例在 pool 里。 */
function share(list: string[], pool: Set<string>): number {
  return list.length ? list.filter(gram => pool.has(gram)).length / list.length : 0;
}

/** wrong 改成 right 时被拿掉的那一段:去掉两头与 right 相同的部分,wrong 里剩下的。 */
function removedPart(wrong: string, right: string): string {
  const a = Array.from(wrong);
  const b = Array.from(right);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return a.slice(head, a.length - tail).join('');
}

/** 这处改动是不是把内容拿掉了:明显变短,或者一整句话被换成了别的话。 */
function dropsContent(wrong: string, right: string): boolean {
  if (lengthOf(wrong) - lengthOf(right) > MAX_SHRINK) return true;
  const removed = removedPart(wrong, right);
  return lengthOf(removed) >= MIN_REPLACED && share([...grams(removed)], grams(right)) < KEPT_SHARE;
}

/**
 * 按原句替换。改不上的不改:原句在总结里找不到或出现不止一处、改正后的句子为空或长得离谱。
 * 模型抄原句时常多带或少带句末的标点,所以原样找不到时去掉两头的标点再找一次(改正后的句子同样去掉);
 * 原句找得到时,句末标点跟着原句走:原句没带而改正后的带了(模型顺手加的句号)就去掉,原句带了而改正后的没带就补上,
 * 免得句子中间多出一个句号,或者两句话连在一起。
 *
 * 拿掉内容的改动(明显变短,或一整句话被换成了别的话)放到最后处理:拿掉的那段话被另一项加到了别处
 * (一件事安错了日子,模型分两项把它挪到正确的日子),照改;别处没有,就是把这件事删掉了,不改——写错的句子留着,比事情没了要好。
 */
export function applyFixes(summary: string, fixes: SummaryFix[]): { text: string; applied: SummaryFix[]; skipped: SkippedFix[] } {
  let out = summary;
  const applied: SummaryFix[] = [];
  const skipped: SkippedFix[] = [];
  const dropping: Array<{ fix: SummaryFix; wrong: string; right: string }> = [];
  /** 各项改正新加进去的内容(四字片段),用来认出「挪走」 */
  const addedGrams = new Set<string>();
  const replace = (fix: SummaryFix, wrong: string, right: string): boolean => {
    const count = occurrences(out, wrong);
    if (count !== 1) { skipped.push({ ...fix, reason: count ? 'ambiguous' : 'not-found' }); return false; }
    out = out.replace(wrong, () => right);
    applied.push(fix);
    return true;
  };
  for (const fix of fixes) {
    const skip = (reason: SkippedFix['reason']) => { skipped.push({ ...fix, reason }); };
    if (applied.length + dropping.length >= MAX_FIXES) { skip('too-many'); continue; }
    if (!fix.right) { skip('empty'); continue; }
    if (fix.right === fix.wrong) { skip('same'); continue; }
    let wrong = fix.wrong;
    let right = fix.right;
    if (out.includes(wrong)) {
      const tail = wrong.match(TAIL)?.[0] ?? '';
      const rightTail = right.match(TAIL)?.[0] ?? '';
      if (!tail && rightTail) right = right.slice(0, -rightTail.length);
      else if (tail && !rightTail) right += tail;
    } else {
      wrong = wrong.replace(EDGE, '');
      right = right.replace(EDGE, '');
    }
    const wrongLength = lengthOf(wrong);
    if (wrongLength < MIN_WRONG) { skip('too-short'); continue; }
    if (!right || right === wrong) { skip('same'); continue; }
    if (lengthOf(right) > wrongLength * 2 + 40) { skip('too-long'); continue; }
    if (dropsContent(wrong, right)) { dropping.push({ fix, wrong, right }); continue; }
    if (replace(fix, wrong, right)) {
      const known = grams(wrong);
      for (const gram of grams(right)) if (!known.has(gram)) addedGrams.add(gram);
    }
  }
  for (const { fix, wrong, right } of dropping) {
    const removed = removedPart(wrong, right);
    const moved = lengthOf(removed) >= MIN_MOVED && share([...grams(removed)], addedGrams) >= MOVED_SHARE;
    if (!moved) { skipped.push({ ...fix, reason: 'drops' }); continue; }
    replace(fix, wrong, right);
  }
  return { text: out, applied, skipped };
}
