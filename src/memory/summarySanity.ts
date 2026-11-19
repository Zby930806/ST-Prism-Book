/**
 * 模型交回的 summary 是不是明显不像一条摘要。
 *
 * 格式合法、内容却不是摘要的回复偶尔会出现:把拒答的话、对提示词的复述或格式示意里的占位文字填进了 summary。
 * 照常保存的话,这一楼(或这一批摘要)的内容就从记忆里消失了,而且没有任何提示。
 * 实测(deepseek-v4.1-flash,约 480 条逐楼摘要、650 条总结与二次总结)各出现过一次:
 *   「检查必需项是否齐全，然后只输出 JSON。」(这一楼原文 1849 字)
 *   「（由于任务要求包含我无法生成的露骨性内容，未能完成完整摘要。）」(输入的摘要 1200 多字)
 *
 * 只拦下面几种,其余一概放行。摘要写得短、写得差都不归这里管:很长的正文几句话写完是允许的。
 *   1. 引号之外是助手拒答的口吻(200 字以内);或者整条很短,说的是没能写出摘要、总结(60 字以内),或是对输出要求的复述(80 字以内)。
 *   2. 整段就是格式示意里的占位文字,或只有省略号。
 *   3. 相对原文短到不可能是摘要:单楼原文不少于 400 字而摘要不到 10 字;合并的输入不少于 800 字而总结不到 40 字。
 * 误拦的代价是这一楼一直存不上,所以口吻一类的规则都写得很窄:要同时出现「我 + 做不到 + 内容/请求/摘要」这类搭配,
 * 或者整条短到只剩这一句。剧情里的「他熬到半夜仍无法完成总结，被主管叫去谈话」「作为 AI,她不懂眼泪」「我无法继续前行」都不算。
 * 返回原因(给重试时的纠正提示和报错用);没有问题返回空字符串。
 */

/** 助手拒答、道歉的口吻。只在引号之外匹配,人物说的话不算。 */
const REFUSAL_VOICE = new RegExp([
  // 我无法生成……内容 / 我不能完成这个请求 / 我无法为这段材料生成摘要
  '(我|本助手|本模型)(无法|不能|不会|没办法|没有办法)(为[^。！？，]{0,10})?(生成|提供|撰写|协助|处理|完成|继续|总结|概括|描述|输出)[^。！？]{0,16}(内容|摘要|总结|请求|回复|回应|材料)',
  // 抱歉,我无法……
  '(抱歉|对不起)[，,]?\\s*(我|这|该|此)[^。！？]{0,12}(无法|不能|不予|不便)',
  '作为(一个|一名)?(AI|人工智能)?\\s*(语言模型|助手)[，,]\\s*我',
  "i['’]?m sorry,? but i (can['’]?t|cannot|am unable|won['’]?t)",
  "i (cannot|can['’]?t|am unable to|won['’]?t) (assist|comply|fulfill|help|provide|generate|continue|write|create|summarize)( you)?( with)? (this|that|your|the|such) (request|content|summary|task|material)",
  'as an ai( language model| assistant)?,? i',
].join('|'), 'i');

/** 说自己没能写出摘要、总结(「未能完成完整摘要」「无法生成这份总结」)。剧情里也可能有「总结」这份文件,所以只在整条很短时算。 */
const TASK_NOT_DONE = /(未能|无法|不能)(生成|提供|完成|撰写)(这|该|此|本)?(次|份|条|段|楼|层)?的?(完整)?的?(摘要|总结)/;

/** 对输出要求的复述。 */
const INSTRUCTION_ECHO = /只输出\s*(一个\s*)?JSON|输出(一个)?\s*JSON\s*对象|检查必需项|不要\s*Markdown\s*围栏/i;

/** 提示词的格式示意里用过的占位文字(两版内置提示词),以及只有省略号的情况。 */
const PLACEHOLDER = /^(本楼的剧情摘要|总结正文|该楼的摘要|该层的摘要[^。]*|摘要正文|summary|[.…。·\s]+)$/i;

const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g;

export function implausibleSummary(summary: string, sourceChars: number, kind: 'floor' | 'merge'): string {
  const text = String(summary ?? '').trim();
  const length = Array.from(text).length;
  const source = Number.isFinite(sourceChars) ? Math.max(0, Math.floor(sourceChars)) : 0;
  const narration = text.replace(QUOTED, '');
  if ((length <= 200 && REFUSAL_VOICE.test(narration)) || (length <= 60 && TASK_NOT_DONE.test(narration)) || (length <= 80 && INSTRUCTION_ECHO.test(narration))) {
    return '内容是拒答或对输出要求的复述，不是剧情';
  }
  if (PLACEHOLDER.test(text.replace(/^[（(【\[]|[）)】\]]$/g, ''))) return '内容是格式示意里的占位文字';
  const [minSource, minLength] = kind === 'floor' ? [400, 10] : [800, 40];
  if (source >= minSource && length < minLength) {
    return `只有 ${length} 字，而${kind === 'floor' ? '这一楼原文' : '输入'}有 ${source} 字`;
  }
  return '';
}
