import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as settings from '@/api/settings';
import {
  batchSummaryChecklist, BATCH_SUMMARY_THINKING_CHECKLIST, buildBatchSummaryPrompt, buildResummaryPrompt, buildSummaryPrompt,
  buildSummaryThinking, builtinPrompt, compactLength, builtinStyleFor, promptStyle, RESUMMARY2_PROMPT, RESUMMARY2_PROMPT_COMPACT, RESUMMARY_PROMPT, RESUMMARY_PROMPT_COMPACT,
  RESUMMARY_THINKING_CHECKLIST, RULE_CONTENT_BOUNDARY, RULE_NPC_INTIMACY, SUMMARY_PROMPT, SUMMARY_PROMPT_COMPACT, THINKING_CHECKLIST, THINKING_PREFILL, usesBuiltinSummary,
} from './prompts';
import { INTIMACY_SUMMARY_RULE } from './promptIntimacy';
import {
  COMPACT_BATCH_THINKING_CHECKLIST, COMPACT_RESUMMARY2_CHECKLIST, COMPACT_RESUMMARY_CHECKLIST, COMPACT_SUMMARY_WRITING, COMPACT_THINKING_CHECKLIST, COMPACT_THINKING_PREFILL,
} from './promptsCompact';

// 内置提示词版本:精简版(1.4.18 起)与旧版并存,在设置里切换。这里核对切换、组装和开关,不代表真实模型的输出。
const saved = {
  promptStyle: settings.apiSettings.promptStyle,
  prompts: { ...settings.apiSettings.prompts },
  injection: { ...settings.apiSettings.injection },
  summaryMaxChars: settings.apiSettings.summaryMaxChars,
  verbosity: settings.apiSettings.verbosity,
  resummaryMaxChars: settings.apiSettings.resummaryMaxChars,
  resummary2MaxChars: settings.apiSettings.resummary2MaxChars,
};
const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: '林舟', char: '苏晚', time: '2026/9/12 20:00', location: '晚风书屋', protagonist: { gender: '男' }, sceneFocus: null,
  lifeDetails: [], items: [{ name: '钥匙', qty: 1 }], itemLog: [], scenes: [{ path: ['晚风书屋'] }],
  npcs: [{ name: '苏晚', important: true, follow: true, presence: 'present', intimacy: '共1次;9/12 她家 1次:戴套' }],
  openPlans: [{ kind: 'plan', content: '周末去看海' }], resolvedPlans: [], history: '', content: '【角色·苏晚】\n[M2-P1] 她点了点头。',
  hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
const CLASSIC_HEADERS = ['【物品规则】', '【摘要撰写规则】', '【输出铁律】', '【关系线保留】', '【压缩保真】'];
const COMPACT_HEADERS = ['═══ summary 怎么写 ═══', '═══ 状态更新 ═══', '【角色 npcs】', '【物品 items】', '【计划与悬念 plans】'];
const leftover = (text: string) => text.match(/\{\{\w+\}\}/g);

beforeEach(() => {
  settings.apiSettings.promptStyle = 'compact';
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  Object.assign(settings.apiSettings, { summaryMaxChars: 300, verbosity: 'detailed', resummaryMaxChars: 0, resummary2MaxChars: 0 });
  settings.apiSettings.injection.intimacy = true;
});
afterEach(() => {
  settings.apiSettings.promptStyle = saved.promptStyle;
  Object.assign(settings.apiSettings.prompts, saved.prompts);
  Object.assign(settings.apiSettings.injection, saved.injection);
  Object.assign(settings.apiSettings, { summaryMaxChars: saved.summaryMaxChars, verbosity: saved.verbosity, resummaryMaxChars: saved.resummaryMaxChars, resummary2MaxChars: saved.resummary2MaxChars });
});

describe('内置提示词版本:设置与选用', () => {
  it('设置项只接受两个值,其他值按默认', () => {
    expect(settings.normalizeApiSettings({}).promptStyle).toBe(settings.DEFAULT_PROMPT_STYLE);
    expect(settings.normalizeApiSettings({ promptStyle: 'classic' }).promptStyle).toBe('classic');
    expect(settings.normalizeApiSettings({ promptStyle: 'compact' }).promptStyle).toBe('compact');
    expect(settings.normalizeApiSettings({ promptStyle: 'short' }).promptStyle).toBe(settings.DEFAULT_PROMPT_STYLE);
  });

  it('没有自定义时按设置;保存的文本与某一版内置逐字相同时按那一版', () => {
    expect(promptStyle()).toBe('compact');
    expect(builtinStyleFor('summary')).toBe('compact');
    expect(builtinPrompt('summary')).toBe(SUMMARY_PROMPT_COMPACT);
    expect(builtinPrompt('summary', 'classic')).toBe(SUMMARY_PROMPT);
    settings.apiSettings.promptStyle = 'classic';
    expect(builtinStyleFor('resummary')).toBe('classic');
    expect(builtinPrompt('resummary')).toBe(RESUMMARY_PROMPT);
    expect(builtinPrompt('resummary2')).toBe(RESUMMARY2_PROMPT);
    // 把另一版的内置原文存成自定义:仍算内置,按原文那一版发送
    settings.apiSettings.prompts.summary = `\n${SUMMARY_PROMPT_COMPACT}\n`;
    expect(builtinStyleFor('summary')).toBe('compact');
    expect(usesBuiltinSummary()).toBe(true);
    expect(buildSummaryPrompt(args).system).toContain('═══ summary 怎么写 ═══');
    settings.apiSettings.promptStyle = 'compact';
    settings.apiSettings.prompts.summary = SUMMARY_PROMPT;
    expect(builtinStyleFor('summary')).toBe('classic');
    expect(buildSummaryPrompt(args).system).toContain('【摘要撰写规则】');
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    expect(builtinStyleFor('summary')).toBeNull();
    expect(usesBuiltinSummary()).toBe(false);
  });

  it('两版的完整模板都以内容边界开头,互不包含对方的章节', () => {
    for (const text of [SUMMARY_PROMPT_COMPACT, RESUMMARY_PROMPT_COMPACT, RESUMMARY2_PROMPT_COMPACT]) expect(text.startsWith(RULE_CONTENT_BOUNDARY)).toBe(true);
    for (const header of CLASSIC_HEADERS) expect(SUMMARY_PROMPT_COMPACT).not.toContain(header);
    for (const header of COMPACT_HEADERS) {
      expect(SUMMARY_PROMPT_COMPACT).toContain(header);
      expect(SUMMARY_PROMPT).not.toContain(header);
    }
  });
});

describe('精简版:单楼摘要请求', () => {
  it.each([true, false])('规则、材料和核对步骤都用精简版,宏全部展开(发送内容边界=%s)', contentBoundary => {
    const { system, user } = buildSummaryPrompt(args, { contentBoundary });
    expect(system.startsWith(RULE_CONTENT_BOUNDARY)).toBe(contentBoundary);
    expect(system).toContain('═══ 任务 ═══');
    for (const header of COMPACT_HEADERS) expect(system).toContain(header);
    for (const header of CLASSIC_HEADERS) expect(system).not.toContain(header);
    // 目标是上限的四分之三:模型数不准字数,只给上限时会写超
    expect(system).toContain('一般写到 230 字左右，最多不超过 300 字（含标点）');
    expect(system).toContain('林舟以外的人物都记在这里');
    expect(leftover(system)).toBeNull();
    expect(leftover(user)).toBeNull();
    expect(user).toContain('【本楼之前的记录】');
    expect(user).toContain('- 当前时间：2026/9/12 20:00');
    expect(user).toContain('- 当前地点：晚风书屋');
    expect(user).toContain('p1. [计划] 周末去看海');
    expect(user).toContain('与主角的亲密记录:共1次;9/12 她家 1次:戴套');
    expect(user.trimEnd().endsWith('[M2-P1] 她点了点头。')).toBe(true);
    // 规则在 system,材料在 user,互不混入
    expect(system).not.toContain('她点了点头');
    expect(user).not.toContain('═══ 任务 ═══');
  });

  it('篇幅约为旧版的三分之一', () => {
    const compact = buildSummaryPrompt(args, { contentBoundary: false }).system.length + buildSummaryThinking('林舟').checklist.length;
    settings.apiSettings.promptStyle = 'classic';
    const classic = buildSummaryPrompt(args, { contentBoundary: false }).system.length + buildSummaryThinking('林舟').checklist.length;
    expect(compact).toBeLessThan(13500);
    expect(compact / classic).toBeLessThan(0.4);
  });

  it('时间:正文带标签时不要求输出时间字段,没有标签时两个字段每楼必填', () => {
    const tagged = buildSummaryPrompt(args).system;
    expect(tagged).toContain('系统直接读取，不要输出 timeStart 和 timeEnd');
    expect(tagged).not.toContain('timeStart"');
    expect(tagged).toContain('\nsummary 必填。其余字段只在本楼有变化时才出现');
    expect(tagged).toContain('没有任何状态变化时，只输出 { "summary": "……" }。');
    const untagged = buildSummaryPrompt({ ...args, hasTimeTags: false }).system;
    expect(untagged).toContain('"timeStart": "本楼开始时的故事内时间"');
    expect(untagged).toContain('【时间 timeStart / timeEnd】本楼正文没有时间标记，这两个字段每楼都要填（时间没有推进也要填，不按「没有变化就省略」处理）');
    // 「没有变化就省略」的通用约定不包括时间:必填字段、最小输出和示例都带上两个时间字段。
    // 只写「summary 必填」时,实测没有时间标签的楼层约一半不填时间
    expect(untagged).toContain('\nsummary、timeStart、timeEnd 每楼都必填。其余字段只在本楼有变化时才出现');
    expect(untagged).toContain('没有任何状态变化时，只输出 { "summary": "……", "timeStart": "……", "timeEnd": "……" }。');
    expect(untagged).toContain('6. 计划：p2 兑现。\n10. 时间：正文写的是三月初七傍晚，没有再往后推，开始和结束都填它。\n输出字段：summary、timeStart、timeEnd、location、locationPath、scenes、npcs、items、plans\n</thinking>');
    expect(tagged).toContain('6. 计划：p2 兑现。\n输出字段：summary、location、locationPath、scenes、npcs、items、plans\n</thinking>');
    // 没有线索时照抄材料里那一项的时间:写成「填「当前时间」」时,实测有回复把这四个字当成了值
    expect(untagged).toContain('两个字段都照抄材料里「当前时间」一项的时间');
    expect(untagged).not.toContain('填「当前时间」');
    expect(untagged).toContain('阿青独自进了城南的听雨茶楼。","timeStart":"三月初七 傍晚","timeEnd":"三月初七 傍晚","location":"听雨茶楼"');
    expect(tagged).toContain('阿青独自进了城南的听雨茶楼。","location":"听雨茶楼"');
    expect(leftover(untagged)).toBeNull();
    expect(leftover(tagged)).toBeNull();
    // 核对步骤:没有标签时多一步时间,排在各项核对之后、「输出字段」一行之前(插在「地点」后面时,实测新地点的建档变少);有标签(缺省)时没有这一步
    const TIME_STEP = '\n10. 时间：本楼正文没有时间标记，timeStart 和 timeEnd 都要填具体的时间；正文没有新的时间线索时，照抄材料里「当前时间」一项的时间。';
    const FIELDS_LINE = '\n最后一行写「输出字段：」，列出这次 JSON 要带的全部字段名';
    const withTags = buildSummaryThinking('林舟').checklist;
    const noTags = buildSummaryThinking('林舟', false, false).checklist;
    expect(withTags).not.toContain('时间：');
    expect(withTags.split(FIELDS_LINE)).toHaveLength(2);
    expect(noTags).toBe(withTags.replace(FIELDS_LINE, TIME_STEP + FIELDS_LINE));
    expect(noTags).toMatch(/不建。\n2\. 主角：/);
    expect(leftover(noTags)).toBeNull();
  });

  it('了解清单和自定义变量:开启或配置后才出现规则、字段和材料', () => {
    const base = buildSummaryPrompt(args);
    for (const mark of ['knowledge', '了解清单', '"vars"', '【自定义变量 vars】']) expect(base.system + base.user).not.toContain(mark);
    const more = buildSummaryPrompt({ ...args, knowledge: [], varsState: { 声望: 3 }, varsMeaning: '声望:数字', varsRule: '完成委托 +1' });
    expect(more.system).toContain('【了解清单 knowledge】');
    expect(more.system).toContain('"knowledge": {');
    expect(more.system).toContain('【自定义变量 vars】');
    expect(more.system).toContain('"vars": [');
    expect(more.user).toContain('- 角色对主角的了解（编号 k1、k2…）：');
    expect(more.user).toContain('- 自定义变量（JSON 状态树，已结算到本楼之前）：');
    expect(more.user).toContain('- 变量变化规则：\n完成委托 +1');
    expect(leftover(more.system + more.user)).toBeNull();
    // JSON 示意仍是一个闭合的对象:可选字段接在 conflicts 之后
    expect(more.system).toMatch(/"conflicts": \[[^\n]+\],\n {2}"knowledge": \{[\s\S]+?\n {2}\},\n {2}"vars": \[[^\n]+\]\n\}/);
  });

  it('核对步骤和预填用精简版;了解清单开启时多一行', () => {
    const { checklist, prefill } = buildSummaryThinking('林舟');
    expect(checklist.startsWith('【核对步骤】')).toBe(true);
    expect(checklist).toContain('1. 地点：本楼结束时林舟在哪？');
    expect(checklist).toContain('都用 scenes.add 新建，locationPath 里不留没建档的地名');
    expect(checklist).toContain('7. 生活小档案：林舟或主要角色有没有明说');
    expect(checklist).toContain('9. summary：');
    // 字数上限在紧挨输出的位置再说一次
    expect(checklist).toContain('超过 300 字就按「可以删」再删。\n最后一行写「输出字段：」');
    // 核对的最后列出这次要带的字段,JSON 照着输出。实测(deepseek-v4.1-flash)没有这一行时,约一成到过新地点的楼层在核对里写了「新建」,
    // JSON 里却没有 scenes;示例的检查块也带这一行
    expect(checklist.endsWith('最后一行写「输出字段：」，列出这次 JSON 要带的全部字段名：上面决定新建、更新、移除或了结的每一项，都要有对应的字段（新地点对应 scenes，新人物对应 npcs，以此类推）。JSON 照这一行输出，一个不漏。')).toBe(true);
    expect(buildSummaryPrompt(args).system).toContain('\n输出字段：summary、location、locationPath、scenes、npcs、items、plans\n</thinking>');
    expect(checklist).not.toContain('了解清单：');
    expect(leftover(checklist)).toBeNull();
    expect(prefill).toBe(COMPACT_THINKING_PREFILL);
    expect(prefill.endsWith('1. 地点：')).toBe(true);
    const withKnowledge = buildSummaryThinking('林舟', true).checklist;
    expect(withKnowledge).toContain('   了解清单：本楼有谁亲耳听到、亲眼看到或被人告知了林舟的名字');
    expect(withKnowledge.indexOf('了解清单：')).toBeLessThan(withKnowledge.indexOf('4. 局势：'));
    expect(leftover(withKnowledge)).toBeNull();
  });

  it('旧版不受影响:选旧版时规则、清单和预填与原来相同', () => {
    settings.apiSettings.promptStyle = 'classic';
    const { system, user } = buildSummaryPrompt(args);
    for (const header of CLASSIC_HEADERS) expect(system).toContain(header);
    for (const header of COMPACT_HEADERS) expect(system).not.toContain(header);
    expect(user).toContain('【当前已知状态(该楼层之前的已知信息,只读参考,不要视为本轮新增事实)】');
    const thinking = buildSummaryThinking('林舟');
    expect(thinking.checklist).toBe(THINKING_CHECKLIST.replaceAll('{{user}}', '林舟'));
    expect(thinking.prefill).toBe(THINKING_PREFILL);
    // 旧版清单不随有无时间标签变化
    expect(buildSummaryThinking('林舟', false, false).checklist).toBe(thinking.checklist);
  });
});

describe('精简版:亲密记录', () => {
  const MARKS = ['intimacy', '亲密记录', '亲密情节', '性行为', '戴套'];

  it('开启时字段规则和摘要要求与旧版共用同一段文字,各出现一次;未成年不记的限制仍在', () => {
    const { system } = buildSummaryPrompt(args, { contentBoundary: false });
    expect(system.split(RULE_NPC_INTIMACY.replaceAll('{{user}}', '林舟'))).toHaveLength(2);
    expect(system.split(INTIMACY_SUMMARY_RULE)).toHaveLength(2);
    expect(system).toContain('"intimacy": "与主角的亲密记录", ');
    // 这条限制不依赖内容边界那一段(对 DeepSeek 系列默认不发送):字段规则和摘要要求里各一句
    expect(system.split('未成年或年龄不明的角色')).toHaveLength(3);
    expect(buildSummaryThinking('林舟').checklist).toContain('   亲密记录：本楼正文有没有明确写到林舟和某个角色发生性行为');
    for (const level of [1, 2]) {
      const parts = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level }, { contentBoundary: false });
      expect(parts.system).toContain('- 亲密情节的事实：输入里写明的每一次性行为');
    }
    // 核对步骤里各有一行:总结逐次列出来,二次总结写进大事记里所在场合的那一项
    expect(buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level: 1 }).checklist).toContain('3. 输入里写明的每一次性行为，一次一行：日期、次数、是否戴套、是否在体内');
    expect(buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 总结', level: 2 }).checklist).toContain('2. 输入里写明的每一次性行为：日期、次数、是否戴套、是否在体内，以及事后的服药和避孕约定。写 timeline 时放进所在场合的那一项');
    expect(buildBatchSummaryPrompt({ user: '林舟', char: '苏晚', time: '', history: '', content: '楼层' }).system).toContain('- 亲密情节的硬事实:');
  });

  it('关闭后各类请求里都没有相关文字,材料也不带出旧记录', () => {
    settings.apiSettings.injection.intimacy = false;
    const summary = buildSummaryPrompt(args, { contentBoundary: false });
    const texts = [
      summary.system, summary.user, buildSummaryThinking('林舟').checklist,
      ...[1, 2].flatMap(level => {
        const parts = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level }, { contentBoundary: false });
        return [parts.system, parts.checklist];
      }),
      buildBatchSummaryPrompt({ user: '林舟', char: '苏晚', time: '', history: '', content: '楼层' }, { contentBoundary: false }).system,
      batchSummaryChecklist(),
    ];
    for (const text of texts) for (const mark of MARKS) expect(text).not.toContain(mark);
    expect(summary.system).not.toContain('未成年');
    // 去掉后前后文仍然连贯:字段示意和清单的编号不留空洞
    expect(summary.system).toContain('"ties": "与其他角色的长期关系", "outfit": "当前着装"');
    expect(buildSummaryThinking('林舟').checklist).toMatch(/重逢？\n4\. 局势：/);
    const first = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level: 1 });
    expect(first.system).toMatch(/写明谁对谁说了什么。\n其余的细节默认不写。/);
    expect(first.checklist).toMatch(/人物去向、谁知道什么。\n写 summary 时每个日期的场合至少一句/);
    const second = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 总结', level: 2 });
    expect(second.system).toMatch(/列出各自的日期。\n人名、地名、物品名、数字、日期和期限/);
    expect(second.checklist).toMatch(/数一数一共多少个。\n然后输出 JSON：timeline 里上面每个日期的场合都要有一项/);
  });
});

describe('精简版:总结、二次总结与合并摘要', () => {
  // 12 条、共 3508 字:自动时上限是输入的一半(1750),目标是上限的四分之三(1310),平摊到每条约 110 字、约为原来的四成
  const content = Array.from({ length: 12 }, (_, i) => `[${i + 1}] (9/${i + 1}) ${'甲'.repeat(280)}`).join('\n\n');

  it('总结:上限自动时放宽到输入的一半,另给目标和每条输入的份额;清单末尾再说一次', () => {
    expect(content.length).toBe(3508);
    const parts = buildResummaryPrompt({ user: '林舟', char: '苏晚', content, level: 1 }, { contentBoundary: false });
    expect(parts.system).toContain('材料是按时间先后排列的若干条楼层摘要');
    // 上限照档位的 1000 字硬给时,实测写出约 1200 字,有分量的情节丢 4%、细节丢三分之一;不给上限时总结成了输入的照抄
    expect(parts.system).toContain('输入共约 3508 字。总结写到 1310 字左右，最多不超过 1750 字（按 summary 字符串计，含标点，原话也算在内）。平均每条输入在总结里只占 110 字左右，约为它原来篇幅的四成：事多的一条可以长些，事少的一条一两句就够；内容少可以更短，不凑字数。');
    expect(parts.system).toContain('═══ 取舍 ═══\n必须留下：\n- 每个场合的主要事件和结果');
    // 办完了的事不再列为可以删:实测那样写时整件事会从总结里消失
    expect(parts.system).toContain('已经办完、没有后续的事也留这一句，不因为了结了就不写。');
    expect(parts.system).toContain('其余的细节默认不写。拿不准时问一句：删掉它，续写的人会不会接错');
    expect(parts.system).not.toContain('已经了结而且对后面没有影响的事');
    expect(parts.system).not.toContain('【关系线保留】');
    expect(parts.user).toContain('【待合并的楼层摘要】');
    expect(parts.user.endsWith(content)).toBe(true);
    expect(parts.checklist.startsWith(COMPACT_RESUMMARY_CHECKLIST)).toBe(true);
    // 核对步骤开头先说明回复的两个部分:只在末尾写「闭合后输出 JSON」时,实测有回复把 JSON 写进检查块或闭合后就结束
    expect(parts.checklist).toContain('现在处理上面的材料。回复分两部分：先是一个 <thinking>…</thinking> 检查块，闭合之后是一个 JSON 对象；JSON 写在检查块外面，只有它会被保存。开头已经有 <thinking> 时接着写，不要再开第二个。正文全部写在 summary 这一个字段里。');
    expect(parts.checklist.endsWith('\n本次 summary 写到 1310 字左右，最多不超过 1750 字（含标点，原话也算在内）；平均每条输入只占 110 字左右，约为原来的四成。')).toBe(true);
    // 写完后由 engine 核对每条输入有没有被写到(只有精简版内置提示词)
    expect(parts.coverage).toBe(true);
    expect(leftover(parts.system + parts.user + parts.checklist)).toBeNull();
  });

  it('总结:设置里填了具体字数时以它为上限,不再放宽;精简档自动时放宽到四成;输入本来就短时只说上限', () => {
    settings.apiSettings.resummaryMaxChars = 800;
    const fixed = buildResummaryPrompt({ user: '林舟', char: '苏晚', content, level: 1 });
    expect(fixed.system).toContain('总结写到 600 字左右，最多不超过 800 字');
    expect(fixed.checklist.endsWith('\n本次 summary 写到 600 字左右，最多不超过 800 字（含标点，原话也算在内）；平均每条输入只占 50 字左右，约为原来的两成。')).toBe(true);
    Object.assign(settings.apiSettings, { resummaryMaxChars: 0, verbosity: 'concise' });
    expect(buildResummaryPrompt({ user: '林舟', char: '苏晚', content, level: 1 }).system).toContain('总结写到 1050 字左右，最多不超过 1400 字');
    settings.apiSettings.verbosity = 'detailed';
    const short = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 两人在书屋盘点。\n\n[2] 第二天去了物流点。', level: 1 });
    expect(short.system).toContain('字。总结不超过 1000 字（按 summary 字符串计，含标点，原话也算在内）；内容少可以更短，不凑字数。');
    expect(short.checklist.endsWith('\n本次 summary 不超过 1000 字（含标点，原话也算在内）。')).toBe(true);
    expect(compactLength(false, 1000, content)).toMatchObject({ ceiling: 1750, aim: 1310 });
    expect(compactLength(true, 1500, content)).toMatchObject({ ceiling: 1750, aim: 1310 });
  });

  it('二次总结:写成按日期排列的大事记,只输出 timeline 一个数组;只给目标,不给硬上限', () => {
    const parts = buildResummaryPrompt({ user: '林舟', char: '苏晚', content, level: 2 }, { contentBoundary: false });
    expect(parts.system).toContain('材料是按时间先后排列的若干条剧情总结');
    expect(parts.system).toContain('二次总结只留骨架：每个场合发生了什么、定下了什么、什么变了，一件不少；场合里的细节这一级不带。');
    expect(parts.system).toContain('═══ 写成大事记 ═══\n把这段剧情写成一份按日期排列的大事记，放在 timeline 里：逐个场合，一个场合一项。每项以日期开头（有时刻的带上），用一两句话写清谁、在哪里、做了什么、结果怎样');
    // 办完了的事也要有一项:按「到结束时还有没有用」来选时,实测有分量的情节丢一到三成
    expect(parts.system).toContain('输入里的每一个场合（一次见面、一次通话、一天里的一件事）都要有一项，已经办完、没有后续的事也写。');
    expect(parts.system).not.toContain('到这段剧情结束时还有没有用');
    // 一项只写一天:两天并在一项里时,实测有原话被安到了第二天
    expect(parts.system).toContain('一项只写一天的事：过了夜的，第二天的事另起一项，不把两天的事并在一项里');
    // 不另列「结束时仍然有效的事」,项也不拆成事件、约定几个字段:实测前者错得最多,后者把一个场合里的先后打乱
    expect(parts.system).toContain('{\n  "timeline": ["日期：这个场合的一两句话", "下一个场合的日期：……"]\n}');
    for (const gone of ['"state"', '仍然有效的事，一件一项', '"event"', '"agreed"', '{ "summary": "总结正文" }']) expect(parts.system).not.toContain(gone);
    // 给了硬上限时,实测出现过写到上限就停、后面的日子整段没写
    expect(parts.system).toContain('输入共约 3508 字。timeline 加起来写到 1310 字左右（含标点），约为输入的四成；场合多时可以超过，不为了凑字数把一项写长。');
    expect(parts.system).not.toContain('最多不超过');
    expect(parts.user).toContain('【待合并的总结】');
    expect(parts.checklist.startsWith(COMPACT_RESUMMARY2_CHECKLIST)).toBe(true);
    // 检查块只点日期,不在里面打草稿:让它先把大事记列一遍时,检查块偶尔写到三五万字
    expect(parts.checklist).toContain('检查块里简短写下（几行就够，不复述输入，不打草稿）：\n1. 按先后点出输入里各个场合的日期，数一数一共多少个。');
    expect(parts.checklist).toContain('然后输出 JSON：timeline 里上面每个日期的场合都要有一项，一项一两句话。');
    expect(parts.checklist.endsWith('\n本次 timeline 加起来写到 1310 字左右（含标点），约为输入的四成；场合多时可以超过。\n这一步最常见的错误，是把输入里的句子整段搬进各项，一项写到两三百字：这样的输出通不过校验，要退回重写。一项只写一个场合的一两句话，不超过一百个字，场合里的细节这一级不带。')).toBe(true);
    expect(parts.coverage).toBe(true);
    expect(leftover(parts.system + parts.user + parts.checklist)).toBeNull();
  });

  it('旧版的清单末尾只重申上限,不给目标字数;自定义模板的清单不加字数(篇幅以模板为准)', () => {
    settings.apiSettings.promptStyle = 'classic';
    const classic = buildResummaryPrompt({ user: '林舟', char: '苏晚', content, level: 1 });
    expect(classic.checklist.startsWith(RESUMMARY_THINKING_CHECKLIST)).toBe(true);
    expect(classic.checklist).toContain('\n本次 summary 不超过 1000 字（含标点，原话也算在内）。');
    expect(classic.checklist).not.toContain('字左右');
    settings.apiSettings.prompts.resummary = 'CUSTOM {{content}} {{resummary_words}} {{resummary_max}} {{input_chars}}';
    const custom = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: 'abc', level: 1 });
    expect(custom.user).toBe('CUSTOM abc 600-1000 1000 3');
    expect(custom.checklist).toBe(RESUMMARY_THINKING_CHECKLIST);
  });

  it('合并摘要:规则和清单随版本切换,与单楼摘要共用 summary 的写法', () => {
    const input = { user: '林舟', char: '苏晚', time: '2026/9/12', history: '', content: '═══ 楼层 #3 ═══\n[M3-P1] 正文' };
    const compact = buildBatchSummaryPrompt(input, { contentBoundary: false });
    expect(compact.system).toContain('请为每一楼分别写一条摘要');
    expect(compact.system).toContain(COMPACT_SUMMARY_WRITING.replace('{{summary_max_chars}}', '300').replace('{{summary_aim}}', '230'));
    expect(compact.system).not.toContain('"npcs"');
    expect(compact.user).toContain('【这些楼层之前的主线时间】2026/9/12');
    expect(batchSummaryChecklist()).toBe(COMPACT_BATCH_THINKING_CHECKLIST);
    expect(leftover(compact.system + compact.user)).toBeNull();
    settings.apiSettings.promptStyle = 'classic';
    expect(buildBatchSummaryPrompt(input).system).toContain('【逐层分开】');
    expect(batchSummaryChecklist()).toBe(BATCH_SUMMARY_THINKING_CHECKLIST);
  });
});

describe('自定义模板与版本', () => {
  it('照旧版改写的自定义摘要模板:选精简版时仍补发旧版的兼容协议,清单用旧版', () => {
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const { system, user } = buildSummaryPrompt(args);
    expect(system).toContain('【棱镜宝书主角档案兼容协议】');
    expect(system).toContain('【主要角色规则】');
    expect(user.startsWith('CUSTOM 【角色·苏晚】')).toBe(true);
    expect(buildSummaryThinking('林舟').checklist).toBe(THINKING_CHECKLIST.replaceAll('{{user}}', '林舟'));
  });

  it('照精简版改写的自定义摘要模板:不补发旧版协议,材料和清单用精简版', () => {
    settings.apiSettings.promptStyle = 'classic'; // 版本设置不影响已自定义的模板
    settings.apiSettings.prompts.summary = SUMMARY_PROMPT_COMPACT.replace('不超过 {{summary_max_chars}} 字（含标点）', '不超过 200 字');
    expect(builtinStyleFor('summary')).toBeNull();
    const { system, user } = buildSummaryPrompt(args);
    // 模板自带内容边界:system 只放一句占位,规则和材料都在 user
    expect(system).not.toContain('兼容协议');
    expect(system).not.toContain(RULE_CONTENT_BOUNDARY);
    expect(system.length).toBeLessThan(80);
    expect(user).toContain('不超过 200 字');
    expect(user).toContain('- 生活小档案（编号 d1、d2…）：');
    expect(user).not.toContain('【主角当前档案（本楼之前）】');
    expect(leftover(user)).toBeNull();
    const thinking = buildSummaryThinking('林舟');
    // 自定义模板的篇幅以模板为准:核对步骤里不加字数提醒
    expect(thinking.checklist).toBe(COMPACT_THINKING_CHECKLIST.replaceAll('{{user}}', '林舟').replace('{{time_check}}', '').replace('{{knowledge_check}}', '').replace('{{summary_cap_check}}', ''));
    expect(thinking.checklist).not.toContain('再删');
    expect(thinking.prefill).toBe(COMPACT_THINKING_PREFILL);
  });

  it('照精简版改写、去掉了内容边界和名册的模板:补上内容边界,名册接在材料后面', () => {
    const body = SUMMARY_PROMPT_COMPACT.slice(RULE_CONTENT_BOUNDARY.length).trim();
    settings.apiSettings.prompts.summary = body.replace(/- 角色名册[^\n]*\n\{\{npcs_block\}\}\n/, '');
    const { system, user } = buildSummaryPrompt(args);
    expect(system).toBe(RULE_CONTENT_BOUNDARY);
    expect(user).toContain('【角色名册（本楼之前；〔〕里是位置标记，[随行] 表示正跟着主角）】\n  主角:林舟');
    expect(buildSummaryPrompt(args, { contentBoundary: false }).system).not.toContain('【内容边界');
  });

  it('照精简版改写的自定义总结模板:清单用精简版,不加字数;写完后不核对每条输入有没有写到', () => {
    settings.apiSettings.prompts.resummary = RESUMMARY_PROMPT_COMPACT.replace('总结不是把每条摘要各缩短一点再接起来。', '总结不是把每条摘要各缩短一点再接起来。多写对话。');
    const parts = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level: 1 });
    expect(parts.user).toContain('多写对话。');
    // 模板里的 {{length_rule}} 照常填入
    expect(parts.user).toContain('字。总结不超过 1000 字（按 summary 字符串计，含标点，原话也算在内）；内容少可以更短，不凑字数。');
    expect(parts.system.length).toBeLessThan(80);
    expect(parts.checklist).toBe(COMPACT_RESUMMARY_CHECKLIST);
    // 自定义模板可以要求整件事不写,所以不做「每条输入都要写到」的核对
    expect(parts.coverage).toBeUndefined();
    // 照精简版改写的二次总结模板:核对步骤用二次总结那一份
    settings.apiSettings.prompts.resummary2 = RESUMMARY2_PROMPT_COMPACT.replace('只写一次；', '只写一次；多写对话。');
    const second = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 总结', level: 2 });
    expect(second.user).toContain('多写对话。');
    expect(second.user).toContain('"timeline": [');
    expect(second.checklist).toBe(COMPACT_RESUMMARY2_CHECKLIST);
    expect(second.coverage).toBeUndefined();
    expect(leftover(second.user + second.checklist)).toBeNull();
    expect(leftover(parts.user)).toBeNull();
    // 旧版内置:不核对
    settings.apiSettings.promptStyle = 'classic';
    Object.assign(settings.apiSettings.prompts, { resummary: '', resummary2: '' });
    expect(buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level: 1 }).coverage).toBeUndefined();
  });
});
