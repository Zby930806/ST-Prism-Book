/**
 * 总结、二次总结写完后核对:每条输入有没有被写到。
 *
 * 合并出来的总结会顶替它的输入发给续写模型,某条输入整条没被写到,那几楼的事就从记忆里消失了,而且没有任何提示。
 * 实测(deepseek-v4.1-flash,各种写法合计一千多次合并)整条输入没被写到的情况有这几种:
 *  - 模型把正文拆成几个字段,只有第一段在 summary 里(2 次;engine.ts 现在会把后面几段接回去);
 *  - 写到字数上限就停,后面三分之二的日子没有写(2 次);
 *  - 两条总结合并成二次总结时只写了其中一条,另一条(十二楼)一个字没提(2 次,新旧提示词各一次);
 *  - 交回的是「没有收到材料」这类说明(1 次);
 *  - 十二条摘要里漏掉其中一条(按字数上限硬压时每二十几次合并出现一次)。
 *
 * 做法:每条输入取它独有的片段(连续 4 个字,别的输入里都没有),数总结里出现了多少个。
 *  - 写到了的输入总会有不少片段原样出现(人名加动作、日期、数字、原话)。照抄得多还是少因模型而异,所以不定死数目,
 *    而是和同一次合并里写得最全的那条输入比:按那条的命中比例,这条输入本该出现多少个片段(参照数);
 *    实际出现的不到参照数的百分之一、也不到 3 个,就算没写到。
 *  - 参照数太小(输入很短,或这次合并整体上改写得多、原样出现的片段少)时不判断:看不出来,不冤枉。
 *  - 总结里的片段几乎没有一个出自输入(unrelatedToInputs),是交回了说明文字或写成了别的内容,另算。
 * 用同一批实测结果核对:事情留全了的合并(两百多次)没有一次被误判,上面几种情况都能查出来。
 * 只用于精简版内置提示词(旧版和自定义模板允许整件事不写,不在这里核对)。
 */

const GRAM = 4;
/** 太短的输入(一句话的摘要)独有片段太少,不判断。 */
const MIN_INPUT_CHARS = 30;
const MIN_UNIQUE_GRAMS = 8;
/** 参照数低于它不判断:一条写到了、只是比最全的那条简略好几倍的输入,这时也可能只出现一两个片段。 */
const MIN_EXPECTED_HITS = 30;
const MIN_HITS = 3;
const MIN_SHARE_OF_EXPECTED = 0.01;
/** unrelatedToInputs:输入和总结至少要有这么多内容才判断;总结的片段出自输入的不到这个比例,算对不上(实测正常的最低 21%,出问题的那次是 0;改写得再多,日期、专名和照抄的原话也总有相同的)。 */
const MIN_TOTAL_INPUT_CHARS = 200;
const MIN_SUMMARY_GRAMS = 40;
const UNRELATED_SHARE = 0.02;
const NOISE = /[\s，。、；：？！…—「」『』“”"'（）()《》〈〉·,.;:?!\-]/g;

const plain = (text: string) => String(text ?? '').replace(NOISE, '');

function grams(text: string): Set<string> {
  const chars = plain(text);
  const out = new Set<string>();
  for (let i = 0; i + GRAM <= chars.length; i++) out.add(chars.slice(i, i + GRAM));
  return out;
}

/** 没有被写到的输入的序号(从 0 起,按输入的先后)。 */
export function uncoveredInputs(inputs: string[], summary: string): number[] {
  const sets = inputs.map(grams);
  const written = grams(summary);
  const counts = inputs.map((input, i) => {
    let unique = 0;
    let hits = 0;
    for (const gram of sets[i]) {
      if (sets.some((other, j) => j !== i && other.has(gram))) continue;
      unique++;
      if (written.has(gram)) hits++;
    }
    return { unique, hits, judged: plain(input).length >= MIN_INPUT_CHARS && unique >= MIN_UNIQUE_GRAMS };
  });
  // 写得最全的那条输入的命中比例:这次合并里「写到了」大致是什么样子
  const best = Math.max(0, ...counts.filter(c => c.judged).map(c => c.hits / c.unique));
  const missing: number[] = [];
  counts.forEach((c, i) => {
    if (!c.judged) return;
    const expected = c.unique * best;
    if (expected >= MIN_EXPECTED_HITS && c.hits < Math.max(MIN_HITS, expected * MIN_SHARE_OF_EXPECTED)) missing.push(i);
  });
  return missing;
}

/** 汉字在文字里占的比例:输入和总结不是同一种文字(英文的摘要、中文的总结)时,片段本来就对不上,不能据此判断。 */
function hanShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter(ch => /\p{Script=Han}/u.test(ch)).length / letters.length;
}

/**
 * 总结和输入对不上:总结里的片段几乎没有一个能在输入里找到。
 * 输入太少、总结太短,或两边不是同一种文字时不判断(返回 false)。
 */
export function unrelatedToInputs(inputs: string[], summary: string): boolean {
  const source = inputs.join('\n');
  if (plain(source).length < MIN_TOTAL_INPUT_CHARS) return false;
  const written = grams(summary);
  if (written.size < MIN_SUMMARY_GRAMS) return false;
  if ((hanShare(source) >= 0.5) !== (hanShare(summary) >= 0.5)) return false;
  const known = grams(source);
  let shared = 0;
  for (const gram of written) if (known.has(gram)) shared++;
  return shared / written.size < UNRELATED_SHARE;
}
