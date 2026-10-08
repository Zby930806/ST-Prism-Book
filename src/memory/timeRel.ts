/**
 * 故事内时间的「相对时间」推断 —— 移植自旧插件 Horae 的 timeUtils,只保留中文、去掉多语言层。
 *
 * 用途:历史摘要注入与摘要页展示时,在绝对时间前加一个相对前缀(如「昨天」「3天前」),
 * 让主模型与用户都能直观感知「这段剧情距离现在多久」。
 *
 * 设计底线(沿用 Horae):时间是 AI 写的自由文本。
 *  - 数字日历(1988/9/29、1988年9月29日、9/29、带历法前缀的 X年M月D日)→ 精确算天数差。
 *  - 架空日历(霜月3日 这类非数字月名、含 XX/?? 的占位)→ 仅同月可算,跨架空月放弃。
 *  - 纯时辰无日期、彻底解析不出 → 返回空串,调用方降级为「不加前缀」。
 * 一句话:宁可不标,绝不标错。
 */

/** 中文周几(0=周日) */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** 解析出的故事日期:standard 可精确换算,fantasy 仅同月可比 */
interface StoryDate {
  type: 'standard' | 'fantasy' | 'relative';
  year?: number;
  month?: number;
  day?: number | null;
  /** 架空月标识(如「霜月」),fantasy 跨月比对用 */
  monthId?: string;
  /** 历法前缀(如「庆历」),仅展示用,不参与换算 */
  calendarPrefix?: string;
  raw?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * 带「年月日」单位的日期字段之间允许出现的装饰分隔符。
 *
 * AI 常把纪年写成「元会历·3728年·2月1日」或「2024年／9月／30日」。
 * 这里只允许空白和常见点号、斜线、逗号、横线，且必须位于明确的 年→月 / 月→日
 * 单位边界，不做全局替换，避免误伤历法前缀和架空月名。
 */
const DATE_FIELD_SEPARATOR = '[\\s·・•‧∙⋅.．。﹒/／,，、_\\-—–－]*';

/** 把全角/中文句点等日期分隔符规范成 /,便于后续正则统一处理 */
function normalizeNumericDateSeparators(dateStr: string): string {
  if (!dateStr) return dateStr;
  return dateStr
    // 长格式(4 位年起):日数后只要不再跟数字/点即认,容忍后接逗号、中文、括号等
    //(如「2025.11.1, 多云」「2025.11.1晴」);4 位年开头几乎不会是小数/版本号,放宽很安全。
    .replace(/^(\d{4,})[.．。﹒](\d{1,2})[.．。﹒](\d{1,2})(?![\d.．。﹒])/, '$1/$2/$3')
    // 短格式(M.D):歧义大(「1.5个小时」是小数非日期),仍要求后接空白或结尾,保守。
    .replace(/^(\d{1,2})[.．。﹒](\d{1,2})(?=$|\s)/, '$1/$2');
}

/** 看起来是结构化数字日期(用于排除「霜月3日」误判为架空) */
function looksLikeStructuredNumericDate(dateStr: string): boolean {
  if (!dateStr) return false;
  return (
    /^(?:\d{4,}[/.\-．。﹒]\d{1,2}[/.\-．。﹒]\d{1,2}|\d{1,2}[/.\-．。﹒]\d{1,2})(?=$|\s)/.test(dateStr) ||
    new RegExp(
      `^\\d+\\s*年${DATE_FIELD_SEPARATOR}\\d{1,2}\\s*月${DATE_FIELD_SEPARATOR}\\d{1,2}\\s*日?(?=$|\\s)`,
    ).test(dateStr) ||
    new RegExp(`^\\d{1,2}\\s*月${DATE_FIELD_SEPARATOR}\\d{1,2}\\s*日?(?=$|\\s)`).test(dateStr)
  );
}

/** 从架空日期串里抽「日数」(阿拉伯优先,无则取首个数字) */
function extractDayNumber(dateStr: string): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d+)\s*[日号]/) || dateStr.match(/第\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const any = dateStr.match(/(\d+)/);
  if (any) return parseInt(any[1], 10);
  return null;
}

/** 从架空日期串里抽「月标识」(如「霜月」) */
function extractMonthIdentifier(dateStr: string): string | null {
  if (!dateStr) return null;
  const m = dateStr.match(/([^\s\d]+月)/);
  if (m) return m[1];
  const num = dateStr.match(/(?:\d{4}[/\-])?(\d{1,2})[/\-]\d{1,2}/);
  if (num) return num[1] + '月';
  return null;
}

/** 中文数字字面 → 值(0-9);「两」按 2,「〇/零」按 0 */
const CN_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字字符集(供正则拼接;含「廿」=20、「卅」=30) */
const CN_NUM_CLASS = '[一二三四五六七八九十两零〇廿卅]';

/**
 * 解析 1-99 的中文数字(十、十一、二十、二十一、廿一、卅 等);纯阿拉伯数字直接 parseInt。
 * 仅覆盖日期/月份/小年份所需范围,失败返回 null。
 */
function cnNumToInt(raw: string): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // 农历「初」前缀:初一~初九=个位、初十=10。剥掉「初」后剩「七」「十」交给下面正常解析。
  const str = s
    .replace(/^初/, '')
    .replace(/廿/g, '二十')
    .replace(/卅/g, '三十'); // 廿/卅 展开成「二十/三十」
  if (!str) return null; // 仅「初」无数字
  // 含「十」:先处理,覆盖「十」(=10)、「十五」、「二十」、「二十一」等;单字「十」也走这里
  const shiIdx = str.indexOf('十');
  if (shiIdx >= 0) {
    // 「十X」=1X(十在首位 → 十位为 1);「X十」「X十Y」→ 十位取前一字
    const tens = shiIdx === 0 ? 1 : CN_DIGIT[str[shiIdx - 1]];
    const onesPart = str.slice(shiIdx + 1);
    const ones = onesPart ? CN_DIGIT[onesPart] : 0;
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (str.length === 1) return CN_DIGIT[str] ?? null; // 纯个位(含〇/两)
  return null; // 无「十」又非单字 → 不在支持范围
}

/** 解析故事内日期字符串;解析不出返回 null */
export function parseStoryDate(dateStr: string): StoryDate | null {
  if (!dateStr) return null;
  let s = dateStr.trim();
  // 去掉 AI 写的周几标注「(三)」
  s = s.replace(/\s*\([日一二三四五六]\)\s*/g, ' ').trim();
  s = normalizeNumericDateSeparators(s);

  // 插件的新开场虚构时间轴：只在同一故事相对轴内比较，不映射公历/星期。
  const relative = s.match(/^故事第([1-9]\d*)天(?:\s|$)/);
  if (relative) {
    const day = Number(relative[1]);
    return Number.isSafeInteger(day) ? { type: 'relative', day, raw: s } : null;
  }

  // 含 XX/?? 占位 → 架空
  if (/[xX]{2}|[?？]{2}/.test(s)) {
    return { type: 'fantasy', raw: dateStr.trim() };
  }

  // 标准:YYYY/M/D
  const full = s.match(/^(\d{4,})[/\-](\d{1,2})[/\-](\d{1,2})/);
  if (full) {
    const year = parseInt(full[1], 10);
    const month = parseInt(full[2], 10);
    const day = parseInt(full[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day, type: 'standard' };
  }

  // 标准:M/D
  const short = s.match(/^(\d{1,2})[/\-](\d{1,2})(?:\s|$)/);
  if (short) {
    const month = parseInt(short[1], 10);
    const day = parseInt(short[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day, type: 'standard' };
  }

  // 数字字段:阿拉伯数字或中文数字(含十/廿/卅),由 cnNumToInt 统一解析。
  const NUM = `(?:\\d+|${CN_NUM_CLASS}+)`;
  // 日字段额外允许农历「初」前缀(初七、初十);cnNumToInt 会剥掉「初」再解析。
  const DAY = `(?:初)?${NUM}`;

  // 标准:X年M月D日(年/月/日均可中文,带可选历法前缀,如「元持十二年八月二十一日」「永和十五年八月初七」)
  const yearCn = s.match(
    new RegExp(`(${NUM})\\s*年${DATE_FIELD_SEPARATOR}(${NUM})\\s*月${DATE_FIELD_SEPARATOR}(${DAY})\\s*日?`),
  );
  if (yearCn) {
    const year = cnNumToInt(yearCn[1]);
    const month = cnNumToInt(yearCn[2]);
    const day = cnNumToInt(yearCn[3]);
    if (year != null && month != null && day != null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const prefixEnd = s.indexOf(yearCn[0]);
      const calendarPrefix = s.substring(0, prefixEnd).trim() || undefined;
      return { year, month, day, type: 'standard', calendarPrefix };
    }
  }

  // 明确写了年份却没能完整解析时，禁止继续降级成无年份的 M月D日。
  // 否则「3727年★9月30日」会静默丢掉 3727，再与另一个无年份日期按同一年比较，
  // 跨年方向就可能完全颠倒。此处宁可不标相对时间，也不基于残缺日期猜算。
  if (new RegExp(`(?:${NUM})\\s*年`).test(s)) return null;

  // 标准:M月D日(月/日可中文,日可带「初」)
  const cn = s.match(new RegExp(`(${NUM})\\s*月${DATE_FIELD_SEPARATOR}(${DAY})\\s*日?`));
  if (cn) {
    const month = cnNumToInt(cn[1]);
    const day = cnNumToInt(cn[2]);
    if (month != null && day != null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { month, day, type: 'standard' };
    }
  }

  // 架空日历
  if (looksLikeStructuredNumericDate(s)) return null;
  const monthId = extractMonthIdentifier(s);
  const dayNum = extractDayNumber(s);
  if (monthId || dayNum !== null) {
    return { monthId: monthId ?? undefined, day: dayNum, type: 'fantasy', raw: dateStr.trim() };
  }

  return null;
}

/**
 * 计算 from→to 的天数差(to - from,正=to 更晚)。
 * 解析不出或跨架空月无法判定 → 返回 null。
 */
export function calculateRelativeDays(fromDate: string, toDate: string): number | null {
  if (!fromDate || !toDate) return null;

  // 先剥掉尾部时刻(15:00 / 下午 / 酉时…),只比日期
  const stripTime = (x: string): string =>
    normalizeNumericDateSeparators(
      x
        .trim()
        .replace(/\s+\d{1,2}[:：]\d{2}.*$/, '')
        .replace(/\s+(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|子时|丑时|寅时|卯时|辰时|巳时|午时|未时|申时|酉时|戌时|亥时).*$/i, '')
        .trim(),
    );
  if (stripTime(fromDate) === stripTime(toDate)) return 0;

  const from = parseStoryDate(fromDate);
  const to = parseStoryDate(toDate);
  if (!from || !to) return null;
  if (from.type === 'relative' || to.type === 'relative') {
    return from.type === 'relative' && to.type === 'relative' ? to.day! - from.day! : null;
  }

  // 标准日历:精确算(用 setFullYear 避开 Date 对小年份的偏移)
  if (from.type === 'standard' && to.type === 'standard') {
    const defaultYear = 2024;
    const fromYear = from.year || to.year || defaultYear;
    const toYear = to.year || from.year || defaultYear;
    const fromObj = new Date(0);
    fromObj.setFullYear(fromYear, (from.month ?? 1) - 1, from.day ?? 1);
    const toObj = new Date(0);
    toObj.setFullYear(toYear, (to.month ?? 1) - 1, to.day ?? 1);
    return Math.round((toObj.getTime() - fromObj.getTime()) / DAY_MS);
  }

  // 架空日历:仅同月可算,跨架空月名易误判 → 放弃
  if (from.type === 'fantasy' || to.type === 'fantasy') {
    const fromMonth = from.monthId ?? from.month;
    const toMonth = to.monthId ?? to.month;
    if (from.day != null && to.day != null) {
      if (fromMonth && toMonth && fromMonth !== toMonth) return null;
      return to.day - from.day;
    }
    return null;
  }

  return null;
}

/** 标准日历的两端转成 Date(供周/月/年语义判定);任一非标准则返回 null */
function toDatePair(fromDate: string, toDate: string): { from: Date; to: Date } | null {
  const from = parseStoryDate(fromDate);
  const to = parseStoryDate(toDate);
  if (from?.type !== 'standard' || to?.type !== 'standard') return null;
  const defaultYear = new Date().getFullYear();
  const fromYear = from.year || to.year || defaultYear;
  const toYear = to.year || from.year || defaultYear;
  const f = new Date(0);
  f.setFullYear(fromYear, (from.month ?? 1) - 1, from.day ?? 1);
  const t = new Date(0);
  t.setFullYear(toYear, (to.month ?? 1) - 1, to.day ?? 1);
  return { from: f, to: t };
}

/** 以「周一」为周起点算周差 */
function weekDiffByMonday(from: Date, to: Date): number {
  const weekStart = (d: Date): number => {
    const wd = d.getDay();
    const offset = wd === 0 ? -6 : 1 - wd;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  };
  return Math.round((weekStart(to) - weekStart(from)) / WEEK_MS);
}

/** 自然月差 */
function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * 算某个故事内时间的「周几」(周日…周六),仅在**纯数字公历且带年份**时给出,否则空串。
 *
 * 严格门槛(与相对时间口语档同一套考量,见 relativeTimeLabel 的 calendarPrefix 注释):
 *  - 必须 type==='standard':架空日历(霜月/含 XX 占位)算不出星期。
 *  - 必须有 year:M/D 这类无年份的写法定不了具体哪一天,星期无从谈起。
 *  - 必须无 calendarPrefix:庆历/元持/星历… 是古风/赛博纪年,套公历星期既出戏,
 *    且小年份(year=12)getDay() 算的是公元 12 年真实星期、值不可控 → 一律不标。
 * 用 setFullYear 建 Date(避开 Date 对小年份的偏移),与 toDatePair 同款。
 * 一句话:能确定到公历某一天才标星期,否则宁可不标。
 */
export function weekdayLabel(timeStr?: string): string {
  const s = timeStr?.trim();
  if (!s) return '';
  const d = parseStoryDate(s);
  if (!d || d.type !== 'standard' || d.year == null || d.calendarPrefix) return '';
  const obj = new Date(0);
  obj.setFullYear(d.year, (d.month ?? 1) - 1, d.day ?? 1);
  return `周${WEEKDAY_NAMES[obj.getDay()]}`;
}

/**
 * 把「事件时间 event」相对「现在 now」格式化成相对前缀文本。
 * 解析不出 / 无法判定 → 返回空串(调用方据此不加前缀)。
 */
export function relativeTimeLabel(eventTime?: string, nowTime?: string): string {
  const ev = eventTime?.trim();
  const now = nowTime?.trim();
  if (!ev || !now) return '';

  // days = now - event,正=事件在过去
  const days = calculateRelativeDays(ev, now);
  if (days === null || days === undefined) return '';

  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days === 3) return '大前天';
  if (days === -1) return '明天';
  if (days === -2) return '后天';
  if (days === -3) return '大后天';

  // 「上周X/上个月X号/去年X月X日」等是公历口语,套到带历法前缀的古风/赛博时间(元持/庆历/星历…)上
  // 既出戏、对小年份的 getDay() 还是乱算的。故带前缀时不取 pair → 跳过这些档,降级为通用「N天前/N个月前/N年前」。
  // 纯数字日期(含 2099/12/31 这类赛博时间)无前缀,按公历照常显示口语档。
  const fromHasPrefix = !!parseStoryDate(ev)?.calendarPrefix;
  const toHasPrefix = !!parseStoryDate(now)?.calendarPrefix;
  const pair = fromHasPrefix || toHasPrefix ? null : toDatePair(ev, now);

  if (days > 0) {
    // 过去方向
    if (days < 4) return `${days}天前`;
    if (days >= 4 && days <= 13 && pair) {
      const wd = weekDiffByMonday(pair.from, pair.to);
      if (wd === 1) return `上周${WEEKDAY_NAMES[pair.from.getDay()]}`;
      if (wd === 2) return `上上周${WEEKDAY_NAMES[pair.from.getDay()]}`;
    }
    if (days >= 7 && days < 60 && pair && monthDiff(pair.from, pair.to) === 1) {
      return `上个月${pair.from.getDate()}号`;
    }
    if (days >= 300 && pair) {
      const yearDiff = pair.to.getFullYear() - pair.from.getFullYear();
      if (yearDiff === 1) return `去年${pair.from.getMonth() + 1}月${pair.from.getDate()}日`;
      if (yearDiff === 2) return `前年${pair.from.getMonth() + 1}月${pair.from.getDate()}日`;
    }
    if (days < 30) return `${days}天前`;
    if (days < 365) {
      const md = pair ? monthDiff(pair.from, pair.to) : 0;
      const months = md > 0 ? md : Math.floor(days / 30);
      return `${months}个月前`;
    }
    const years = Math.floor(days / 365);
    const remainMonths = Math.round((days % 365) / 30);
    if (remainMonths > 0 && years < 5) return `${years}年${remainMonths}个月前`;
    return `${years}年前`;
  }

  // 未来方向
  const abs = Math.abs(days);
  if (abs < 4) return `${abs}天后`;
  if (abs >= 4 && abs <= 13 && pair) {
    const wd = weekDiffByMonday(pair.from, pair.to);
    if (wd === -1) return `下周${WEEKDAY_NAMES[pair.from.getDay()]}`;
    if (wd === -2) return `下下周${WEEKDAY_NAMES[pair.from.getDay()]}`;
  }
  if (abs >= 7 && abs < 60 && pair && monthDiff(pair.from, pair.to) === -1) {
    return `下个月${pair.from.getDate()}号`;
  }
  if (abs < 30) return `${abs}天后`;
  if (abs < 365) {
    const md = pair ? monthDiff(pair.from, pair.to) : 0;
    const months = md < 0 ? Math.abs(md) : Math.floor(abs / 30);
    return `${months}个月后`;
  }
  const years = Math.floor(abs / 365);
  const remainMonths = Math.round((abs % 365) / 30);
  if (remainMonths > 0 && years < 5) return `${years}年${remainMonths}个月后`;
  return `${years}年后`;
}

/* ============ 年龄推算(锚点制) ============ */

/**
 * 从年龄原文解析出可推算的数字(全串匹配,防「二十出头」「25%」误判)。
 * 允许「约」前缀与「岁」后缀;其余写法(二十出头/年近三十…)视为模糊值,返回 null。
 */
function parseAgeNumber(raw: string): number | null {
  const m = raw.trim().match(new RegExp(`^(?:约|大约)?\\s*(\\d{1,3}|${CN_NUM_CLASS}+)\\s*岁?$`));
  if (!m) return null;
  const n = cnNumToInt(m[1]);
  return n != null && n > 0 && n < 1000 ? n : null;
}

/** 锚点时间的简短标注:能解析出年份 → 「(前缀)X年」;否则剥掉时刻后的原文;再不行空串。 */
function anchorLabel(ageTime: string): string {
  const d = parseStoryDate(ageTime);
  if (d?.type === 'standard' && d.year != null) return `${d.calendarPrefix ?? ''}${d.year}年`;
  return ageTime.trim();
}

/**
 * 按「年龄锚点」推算当前显示年龄。年龄不是状态而是时间的函数:
 * 存储永远是「记录时的原文 + 锚点时间」,显示时相对当前故事时间推算,
 * 时间跳跃自动长岁,AI 忘不忘更新都不影响正确性。
 *  - 锚点到现在不足一年(或缺锚点/缺当前时间)→ 原样返回原文。
 *  - 跨了 N 年且原文是可解析数字 → 「约(N+原值)岁(锚点年时原值岁)」——不知生日,±1 岁误差,「约」是诚实的。
 *  - 模糊年龄(二十出头)/ 架空历算不出 / 时间倒流 → 原文 + 锚点括注,把推算留给读者/主模型。
 * 沿用「宁可不标,绝不标错」底线。age 空 → 空串。
 */
export function ageDisplay(age?: string, ageTime?: string, now?: string): string {
  const raw = age?.trim();
  if (!raw) return '';
  const anchor = ageTime?.trim();
  const cur = now?.trim();
  if (!anchor || !cur) return raw;

  const days = calculateRelativeDays(anchor, cur);
  const num = parseAgeNumber(raw);
  if (days != null && days >= 0 && days < 365) return raw; // 不足一年:原样
  if (days != null && days >= 365 && num != null) {
    const est = num + Math.floor(days / 365);
    const label = anchorLabel(anchor);
    return label ? `约${est}岁(${label}时${num}岁)` : `约${est}岁`;
  }
  // 算不出(架空跨月/时间倒流/模糊年龄跨年):原文 + 锚点括注,不猜
  const label = anchorLabel(anchor);
  return label ? `${raw}(${label}时)` : raw;
}
