import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceUrl = new URL('../src/memory/timeRel.ts', import.meta.url);
const sourcePath = fileURLToPath(sourceUrl);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    strict: true,
  },
});

const compileErrors = (transpiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
if (compileErrors.length) {
  const host = {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };
  throw new Error(ts.formatDiagnosticsWithColorAndContext(compileErrors, host));
}

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
const {
  calculateRelativeDays,
  parseStoryDate,
  relativeTimeLabel,
  weekdayLabel,
} = await import(moduleUrl);

let assertions = 0;

function equal(actual, expected, message) {
  assertions++;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertions++;
  const normalize = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(actual), normalize(expected), message);
}

function standard(year, month, day, calendarPrefix) {
  return {
    year,
    month,
    day,
    type: 'standard',
    ...(calendarPrefix ? { calendarPrefix } : {}),
  };
}

// 数字日期的既有格式。
const numericDates = [
  ['2024/9/30', standard(2024, 9, 30)],
  ['2024-9-30', standard(2024, 9, 30)],
  ['2024.9.30', standard(2024, 9, 30)],
  ['2024．9．30', standard(2024, 9, 30)],
  ['2024。9。30', standard(2024, 9, 30)],
  ['2024﹒9﹒30', standard(2024, 9, 30)],
  ['2024/09/03 08:30', standard(2024, 9, 3)],
  ['9/30', { month: 9, day: 30, type: 'standard' }],
  ['09-03 08:30', { month: 9, day: 3, type: 'standard' }],
  ['9.30 ', { month: 9, day: 30, type: 'standard' }],
];
for (const [input, expected] of numericDates) {
  deepEqual(parseStoryDate(input), expected, `数字日期解析失败: ${input}`);
}

// 年/月/日单位之间的分隔符做笛卡尔积，覆盖 26 × 26 = 676 种组合。
const acceptedSeparators = [
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  '·',
  ' · ',
  '・',
  '•',
  '‧',
  '∙',
  '⋅',
  '.',
  '．',
  '。',
  '﹒',
  '/',
  '／',
  ',',
  '，',
  '、',
  '_',
  '-',
  '—',
  '–',
  '－',
];
for (const yearMonthSep of acceptedSeparators) {
  for (const monthDaySep of acceptedSeparators) {
    const input = `元会历·3727年${yearMonthSep}9月${monthDaySep}30日 16:30`;
    deepEqual(
      parseStoryDate(input),
      standard(3727, 9, 30, '元会历·'),
      `带纪年分隔符解析失败: ${JSON.stringify(input)}`,
    );
  }
}

// 阿拉伯数字、中文数字、农历初日、廿/卅简写。
const chineseUnitDates = [
  ['3727年9月30日', standard(3727, 9, 30)],
  ['3727 年 9 月 30 日', standard(3727, 9, 30)],
  ['3727年·9月·30日', standard(3727, 9, 30)],
  ['元会历·3727年·9月30日', standard(3727, 9, 30, '元会历·')],
  ['元持十二年八月二十一日', standard(12, 8, 21, '元持')],
  ['永和十五年八月初七', standard(15, 8, 7, '永和')],
  ['庆历十年十月初十', standard(10, 10, 10, '庆历')],
  ['两年二月二日', standard(2, 2, 2)],
  ['廿年·廿月·一日', null],
  ['廿年十二月廿一日', standard(20, 12, 21)],
  ['卅年十二月卅一日', standard(30, 12, 31)],
  ['九月三十日', { month: 9, day: 30, type: 'standard' }],
  ['九月·初七', { month: 9, day: 7, type: 'standard' }],
  ['9 月／30 日 16:30', { month: 9, day: 30, type: 'standard' }],
];
for (const [input, expected] of chineseUnitDates) {
  deepEqual(parseStoryDate(input), expected, `中文单位日期解析失败: ${input}`);
}

// 周几括号和常见时间后缀不应改变日期部分。
const suffixDates = [
  '元会历·3727年·9月30日 16:30',
  '元会历·3727年·9月30日 16：30',
  '元会历·3727年·9月30日 下午四时',
  '元会历·3727年·9月30日(三) 16:30',
  '元会历·3727年·9月30日 （正文开始）',
];
for (const input of suffixDates) {
  deepEqual(parseStoryDate(input), standard(3727, 9, 30, '元会历·'), `日期后缀解析失败: ${input}`);
}

// 明确年份存在但完整年月日无效时必须失败关闭，不能偷偷降级为 M月D日。
const malformedExplicitYears = [
  '元会历·3727年★9月30日',
  '3727年:9月30日',
  '3727年秋9月30日',
  '3727年9月',
  '3727年0月30日',
  '3727年13月30日',
  '3727年9月0日',
  '3727年9月32日',
  '二〇二四年九月三十日',
];
for (const input of malformedExplicitYears) {
  equal(parseStoryDate(input), null, `显式年份不应降级: ${input}`);
  equal(
    relativeTimeLabel(input, '元会历·3728年·2月1日 08:00'),
    '',
    `无效显式年份不应生成相对时间: ${input}`,
  );
}

// 用户报告的精确回归场景，以及所有支持分隔符的同构写法。
equal(
  calculateRelativeDays('元会历·3727年·9月30日 16:45', '元会历·3728年·2月1日 08:00'),
  124,
  '跨年天数方向错误',
);
equal(
  relativeTimeLabel('元会历·3727年·9月30日 16:45', '元会历·3728年·2月1日 08:00'),
  '4个月前',
  '用户报告场景应为 4 个月前',
);
equal(
  relativeTimeLabel('元会历·3728年·2月1日 08:00', '元会历·3727年·9月30日 16:45'),
  '4个月后',
  '用户报告场景反向计算错误',
);
for (const separator of acceptedSeparators) {
  const event = `元会历·3727年${separator}9月${separator}30日 16:45`;
  const now = `元会历·3728年${separator}2月${separator}1日 08:00`;
  equal(calculateRelativeDays(event, now), 124, `分隔符跨年天数错误: ${JSON.stringify(separator)}`);
  equal(relativeTimeLabel(event, now), '4个月前', `分隔符跨年标签错误: ${JSON.stringify(separator)}`);
}

// 日、周、月、年边界和闰年。
const relativeCases = [
  ['2024/1/1', '2024/1/1', '今天'],
  ['2024/1/1', '2024/1/2', '昨天'],
  ['2024/1/1', '2024/1/3', '前天'],
  ['2024/1/1', '2024/1/4', '大前天'],
  ['2024/1/2', '2024/1/1', '明天'],
  ['2024/1/3', '2024/1/1', '后天'],
  ['2024/1/4', '2024/1/1', '大后天'],
  ['2023/12/31', '2024/1/1', '昨天'],
  ['2024/2/28', '2024/3/1', '前天'],
  ['2023/2/28', '2023/3/1', '昨天'],
  ['2024/1/15', '2024/2/20', '上个月15号'],
  ['2024/1/1', '2024/4/15', '3个月前'],
  ['2023/6/1', '2024/6/1', '去年6月1日'],
  ['2022/6/1', '2024/6/1', '前年6月1日'],
  ['2024/4/15', '2024/1/1', '3个月后'],
];
for (const [event, now, expected] of relativeCases) {
  equal(relativeTimeLabel(event, now), expected, `相对时间错误: ${event} -> ${now}`);
}

const dayDiffCases = [
  ['2024/2/28', '2024/3/1', 2],
  ['2023/2/28', '2023/3/1', 1],
  ['2000/2/28', '2000/3/1', 2],
  ['1900/2/28', '1900/3/1', 1],
  ['2023/12/31', '2024/1/1', 1],
  ['2024/1/1', '2023/12/31', -1],
  ['3727年9月30日', '3728年2月1日', 124],
  ['元持十二年八月初七', '元持十二年八月初十', 3],
];
for (const [from, to, expected] of dayDiffCases) {
  equal(calculateRelativeDays(from, to), expected, `天数差错误: ${from} -> ${to}`);
}

// 架空月份只允许同月比较，跨月应放弃。
deepEqual(parseStoryDate('霜月3日'), { monthId: '霜月', day: 3, type: 'fantasy', raw: '霜月3日' });
equal(relativeTimeLabel('霜月3日', '霜月5日'), '前天');
equal(relativeTimeLabel('霜月3日', '雪月5日'), '');
equal(calculateRelativeDays('霜月3日', '雪月5日'), null);

// 周几只对无纪年前缀、带完整年份的标准日期生效。
equal(weekdayLabel('2024/1/1'), '周一');
equal(weekdayLabel('2024年·1月·1日'), '周一');
equal(weekdayLabel('1月1日'), '');
equal(weekdayLabel('元会历·2024年·1月·1日'), '');
equal(weekdayLabel('霜月3日'), '');

console.log(`timeRel tests passed: ${assertions} assertions`);
