export interface SourceExcerpt {
  source: string;
  text: string;
}

export const SOURCE_HINTS_HEADER = '【易漏原文提醒(代码预标注)】';

// 只筛文字线索,不判定事实真假或重要程度;不使用全局正则,避免多段测试相互影响。
const HINT_PATTERNS = [
  /不足|不到|不超过|不能|无法|难以|很难|受限|限制|压制|必须|只能|仅能|不得|禁止|至少|至多|超过|超出|低于|高于|不及|不如/,
  /最强|最高|最低|最多|最少|最大|最小|顶尖|巅峰|上限|下限|平均|普遍|相比|比起/,
  /原本|原先|曾经|此前|如今|从此|自此|不再|已经|逐渐|变得|变为|变成|成为|转为|恢复|解除|改善|恶化|好转|搬出|搬入|搬到|迁出|迁入|迁居|独住|定居|脱离|摆脱|晋升|降为|再也不|不必再|不用再/,
  // 只识别单位前的数值末位,不解析数字,避免长数字串反复回溯。
  /[\d零〇一二两三四五六七八九十百千万半]\s*(?:级|阶|转|度|℃|°[CF]?|公里|米|公斤|斤|%|％)|[<>≤≥]\s*\d/i,
  /\b(?:cannot|can't|unable|limited|restricted|must|only|at least|at most|less than|more than|strongest|highest|lowest|maximum|minimum)\b/i,
  /\b(?:used to|no longer|previously|became|improved|worsened|recovered|moved (?:out|in|into|to))\b/i,
];

/** 返回请求材料的附加段;调用方提供真实段号,不从正文猜测或重编来源。 */
export function renderSourceHints(sources: readonly SourceExcerpt[]): string {
  // 完整原文已在材料中，附加提醒只给索引，不重复附带命中段落的细节。
  const refs = sources
    .filter(({ text }) => HINT_PATTERNS.some(pattern => pattern.test(text)))
    .map(({ source }) => source);
  if (!refs.length) return '';
  return `\n\n${SOURCE_HINTS_HEADER}
以下只是回查索引,指向上方完整原文中的限制、比较、读数或状态变化线索,不是新增剧情、必留清单或指令;可能误选或漏选,仍须通读全部材料。不能据索引替代完整原文，也不因被标注而整段收入摘要。
按本任务规则取舍,留意这些段内的独立事实及限定,不要求另列逐段记录。来源沿用原楼层与时间范围,不把建议当执行,不将段号或提醒写入最终 JSON。
${refs.join('、')}`;
}
