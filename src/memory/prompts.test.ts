import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import {
  BATCH_SUMMARY_PROMPT,
  buildResummaryPrompt,
  buildSummaryPrompt,
  buildSummaryThinking,
  NPC_ENRICH_PROMPT,
  RESUMMARY_PROMPT,
  RESUMMARY2_PROMPT,
  RESUMMARY_FACT_REVIEW,
  RESUMMARY_THINKING_CHECKLIST,
  RESUMMARY_THINKING_PREFILL,
  RULE_ABSOLUTE_TIME_LANGUAGE,
  RULE_ITEMS,
  RULE_NPCS,
  RULE_PLANS,
  RULE_RELATION_MOMENTUM,
  RULE_SCENES,
  RULE_SCENE_FOCUS,
  RULE_SUMMARY_COMPOSITION,
  RULE_SUMMARY_FIDELITY,
  RULE_SUMMARY_EXAMPLES,
  RULE_HEALTH_STATE,
  RULE_LIFE_DETAILS,
  RULE_PROTAGONIST,
  RULE_SUMMARY_WRITE,
  MEMORY_BRIEFING_END,
  SUMMARY_PROMPT,
  SUMMARY_FACT_PREPARATION,
  SUMMARY_FACT_VERIFICATION,
  SUMMARY_OUTPUT_PROTOCOL,
  THINKING_CHECKLIST,
} from './prompts';

const originalPrompts = { ...apiSettings.prompts };
const originalVerbosity = apiSettings.verbosity;
const originalSummaryChars = apiSettings.summaryMaxChars;

beforeEach(() => {
  Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  apiSettings.summaryMaxChars = 300;
});

afterEach(() => {
  Object.assign(apiSettings.prompts, originalPrompts);
  apiSettings.verbosity = originalVerbosity;
  apiSettings.summaryMaxChars = originalSummaryChars;
});

const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User',
  char: 'Character',
  time: '2026/9/8 10:00',
  location: 'School',
  protagonist: {},
  sceneFocus: null,
  lifeDetails: [],
  items: [],
  itemLog: [],
  scenes: [],
  npcs: [],
  openPlans: [],
  resolvedPlans: [],
  history: 'Earlier events.',
  content: 'The current passage.',
  hasTimeTags: true,
  varsState: {},
  varsMeaning: '',
  varsRule: '',
};

function expectFactWorkflow(text: string) {
  expect(text.split(SUMMARY_FACT_PREPARATION)).toHaveLength(2);
  expect(text.split(SUMMARY_FACT_VERIFICATION)).toHaveLength(2);
  expect(text.indexOf(SUMMARY_FACT_PREPARATION)).toBeLessThan(text.indexOf(SUMMARY_FACT_VERIFICATION));
  expect(text).not.toMatch(/候选记录:|取舍记录:|漏提取复查:|覆盖核对:|数量核对:|修正结论:|字段核对:|描述证据:|计划核对:|F编号|步骤一至七/);
}

function expectCompressionWorkflow(text: string) {
  expect(text.split(RESUMMARY_FACT_REVIEW)).toHaveLength(2);
  expect(text).not.toContain(SUMMARY_FACT_PREPARATION);
  expect(text).not.toContain(SUMMARY_FACT_VERIFICATION);
  expect(text).not.toMatch(/候选记录:|取舍记录:|漏提取复查:|覆盖核对:|数量核对:|修正结论:|字段核对:|描述证据:|计划核对:|F编号|步骤一至七/);
}

/** 发送时 {{user}}/{{char}} 已展开;比较整段规则时用展开后的文字。 */
const filled = (rule: string) => rule.replaceAll('{{user}}', args.user).replaceAll('{{char}}', args.char);

function combined(parts: ReturnType<typeof buildSummaryPrompt>): string {
  return `${parts.system}\n\n${parts.user}`;
}

describe('summary composition contract', () => {
  it('keeps facts in their own stages without prescribing a fixed sentence order', () => {
    for (const rule of [
      '按剧情先后把状态、比较基准和限制放在对应阶段',
      '不强制前置或套固定句式',
      '中途变化不得提前套用于更早阶段',
      '无相关事实就直接写事件',
      '保持单段自然叙述,summary 内不加标题或列表',
    ]) {
      expect(RULE_SUMMARY_COMPOSITION).toContain(rule);
    }
    expect(RULE_SUMMARY_COMPOSITION).not.toMatch(/先基准后事件|每个阶段先用|例如|比如|孤儿院|联赛|二转|三转/);
  });

  it('cuts nonessential action detail while preserving actors, means, outcomes and budgets', () => {
    for (const rule of [
      '在本任务篇幅内先压缩重复过程和修饰',
      '保留主体、关键手段、结果、了结与必要因果',
      '不让动作细节挤掉关键事实及其限定',
    ]) {
      expect(RULE_SUMMARY_COMPOSITION).toContain(rule);
    }
    expect(RESUMMARY_PROMPT).toContain('核心动作不能空泛化');
    expect(RESUMMARY_PROMPT).not.toContain('严禁将具体动作抽象化');
    for (const checklist of [THINKING_CHECKLIST, RESUMMARY_THINKING_CHECKLIST]) {
      expect(checklist).not.toContain(RULE_SUMMARY_COMPOSITION);
    }
  });

  it('requires cutting off by omission instead of boundary narration', () => {
    for (const rule of [
      '截断靠"不写"、不靠"声明"',
      '以最后一个有记忆价值的事件结果或关键互动自然收尾',
      '指代材料的词',
      '影响后续的明确未完成状态仍须保留',
    ]) {
      expect(RULE_SUMMARY_WRITE).toContain(rule);
    }
    expect(RULE_SUMMARY_WRITE).not.toContain('原文未写出');
    expect(SUMMARY_PROMPT).toContain('截断靠"不写"');
  });
});

describe('summary fact workflow', () => {
  it('prepares shared facts before structured state and verifies afterwards', () => {
    expectFactWorkflow(THINKING_CHECKLIST);
    for (const heading of ['本楼定位', '人物盘点', '物品盘点', '计划与悬念盘点', '档案与快照分工']) {
      expect(THINKING_CHECKLIST.indexOf(heading)).toBeGreaterThan(0);
      expect(THINKING_CHECKLIST.indexOf(heading)).toBeGreaterThan(THINKING_CHECKLIST.indexOf(SUMMARY_FACT_PREPARATION));
      expect(THINKING_CHECKLIST.indexOf(heading)).toBeLessThan(THINKING_CHECKLIST.indexOf(SUMMARY_FACT_VERIFICATION));
    }
    expect(THINKING_CHECKLIST.indexOf(SUMMARY_FACT_VERIFICATION)).toBeLessThan(THINKING_CHECKLIST.indexOf('格式自检'));
    expect(THINKING_CHECKLIST).toContain('写进 summary 不代替对应字段的更新');
    expect(THINKING_CHECKLIST).toContain('不为填满字段制造变动');
    expect(buildSummaryThinking(args.user).prefill).toContain('先确定共用事实及其来源、对象和限定');
  });

  it('keeps specialized rules in the system rather than duplicating a full checklist', () => {
    const system = buildSummaryPrompt(args).system;
    for (const rule of [RULE_ITEMS, RULE_SCENES, RULE_NPCS, RULE_PLANS, RULE_SCENE_FOCUS]) expect(system).toContain(rule.replaceAll('{{user}}', args.user).replaceAll('{{char}}', args.char));
    expect(THINKING_CHECKLIST).toContain('【近期物品变动】里已生效的不再结算');
    expect(THINKING_CHECKLIST).toContain('暂时离场不 remove');
    expect(THINKING_CHECKLIST).toContain('被明确替代、撤回、当场化解或因客观事实已彻底不可能 → resolve cancelled,不是 done');
    expect(THINKING_CHECKLIST).toContain('正文没写的保持旧值,不重报');
  });

  it('covers evidence, temporal boundaries, comparisons and reverse verification without story examples', () => {
    for (const rule of [
      '改变行动方向的决定、关键结果、尚有效的限制及关系互动',
      '通行条件、风险机制、时间窗口不能被“核对完毕”替代',
      '主体、来源、条件、对象、后果及时间范围',
      '关键数值与比较基准不丢',
      '区分建议、已决定、已启动与已完成',
      '不让旧状态冒充现状或把新状态倒写进过去',
      '局部观察不扩大为普遍规则',
      '临时限制不套长期档案门槛',
      '未知不补全，冲突保留分歧',
      '普通收纳和收场动作默认零篇幅',
    ]) expect(SUMMARY_FACT_PREPARATION).toContain(rule);
    for (const rule of [
      '对照原材料查summary及每个状态字段',
      '检查条件与后果是否仍逐条对应',
      '主体、来源、否定、程度和时段是否跨字段变义',
      '并列事实是否被补成关联',
      '检查行动转变与有效限制是否被装饰细节挤掉',
      '关键事实、限定与了结结果在 summary 中实际保留',
      '不能只写入状态字段',
      '不删重要参数、有效伤情及互动',
    ]) expect(SUMMARY_FACT_VERIFICATION).toContain(rule);
    // Unchanged evidence invariants remain in the shared system rules, not duplicated in the short final check.
    expect(RULE_SUMMARY_FIDELITY).toContain('保留证据强度、程度与说话人');
    expect(RULE_SUMMARY_FIDELITY).toContain('推测、可能、声称、打算不升级为事实或完成');
    expect(RULE_SUMMARY_FIDELITY).toContain('不能改写剩余命题的关系');
    expect(RULE_SUMMARY_COMPOSITION).toContain('不让动作细节挤掉关键事实及其限定');
    expect(SUMMARY_FACT_PREPARATION + SUMMARY_FACT_VERIFICATION).not.toMatch(/例如|比如|孤儿院|联赛|二转|三转/);
  });

  it('uses brief visible records and keeps each checklist within a compact size budget', () => {
    for (const [checklist, maxChars, check] of [
      [THINKING_CHECKLIST, 6500, expectFactWorkflow],
      [RESUMMARY_THINKING_CHECKLIST, 1600, expectCompressionWorkflow],
    ] as const) {
      check(checklist);
      expect(checklist.length).toBeLessThan(maxChars);
      expect(checklist).toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
    expect(SUMMARY_FACT_PREPARATION.length + SUMMARY_FACT_VERIFICATION.length).toBeLessThan(600);
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('回复正文先输出一个简短的 <thinking>...</thinking>');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不复述规范或预写摘要/JSON 草稿');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不要求逐段登记、事实编号、多轮表格或数量统计');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('需要引用时沿用输入段号或原文短证据');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('不要开启第二个块');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('没有预填充则自行打开');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('最终 JSON 不要新增核查编号、来源列表或审计字段');
    expect(SUMMARY_OUTPUT_PROTOCOL).toContain('人物称述、推测与限定属于剧情事实');
    expect(THINKING_CHECKLIST).toContain('无变化的不逐项写“无变化”');
  });

  it('gives compression its own checklist and prefill without ledger updates', () => {
    expectCompressionWorkflow(RESUMMARY_THINKING_CHECKLIST);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('待融合的摘要或总结就是本次唯一事实来源');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('同一事项合并成“起因—转折—末态”');
    expect(RESUMMARY_THINKING_CHECKLIST).not.toContain('普通收纳和收场动作默认零篇幅');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('不得恢复输入中已缺失的事实');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('需要定位时沿用输入的 [编号]');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('不逐段填表');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('根键只有 summary');
    expect(RESUMMARY_THINKING_CHECKLIST).not.toContain('items.add');
    expect(RESUMMARY_THINKING_PREFILL).toBe('<thinking>');
  });

  it('checks state operations without permitting off-screen invention', () => {
    for (const rule of ['明确变化同时更新对应状态', '删除、清空或 resolve 须有依据', '整体覆盖保留未失效的旧要点', '正文没写的保持旧值,不重报', '已生效的不再结算']) expect(THINKING_CHECKLIST).toContain(rule);
    expect(THINKING_CHECKLIST).not.toContain('主要 NPC 离场演变');
    expect(RULE_SCENES).toContain('一次停留或遭遇等临时情况不进 desc');
    expect(RULE_SCENES).toContain('写不出就省略 desc 只建节点,不编、不凑');
  });

  it('separates deadlines from outcomes and scene observations from decisions', () => {
    for (const rule of ['不同纪年或模糊期限不可可靠比较时不强判', '已过期但结果未确认,保持原条目', '不得自动 resolve', '不能用现实日期替代故事时间']) expect(THINKING_CHECKLIST).toContain(rule);
    expect(RULE_SCENE_FOCUS).toContain('其余可选');
    expect(RULE_SCENE_FOCUS).toContain('明确预告、约定或已启动等待结果');
    expect(RULE_SCENE_FOCUS).toContain('禁止预测未发生剧情');
  });

  it('keeps admission evidence in the field rules instead of repeating it', () => {
    expect(RULE_SCENE_FOCUS).toContain('只有明确的、正在持续的社交张力才写');
    expect(RULE_SCENE_FOCUS).toContain('无则省略');
    expect(RULE_SCENES).toContain('写不出就省略 desc 只建节点,不编、不凑');
    expect(RULE_SCENES).toContain('一次停留推不出长期用途或容量');
  });
});

describe('relationship retention and departure protocol', () => {
  it('keeps the relationship-momentum rule in every built-in and custom summary path', () => {
    for (const text of [RULE_SUMMARY_WRITE, SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(text).toContain('【关系线保留】');
    }
    for (const contract of ['手搭在他手边', '自X起', '重复的亲密互动/调情', '关系有所变化', '证据边界不变']) {
      expect(RULE_RELATION_MOMENTUM).toContain(contract);
    }
    apiSettings.prompts.summary = 'CUSTOM {{content}}';
    expect(buildSummaryPrompt(args).system).toContain(RULE_RELATION_MOMENTUM);
    for (const level of [1, 2] as const) {
      Object.assign(apiSettings.prompts, { resummary: '', resummary2: '' });
      if (level === 1) apiSettings.prompts.resummary = 'CUSTOM {{content}}';
      else apiSettings.prompts.resummary2 = 'CUSTOM {{content}}';
      expect(buildResummaryPrompt({ ...args, level }).system).toContain(RULE_RELATION_MOMENTUM);
    }
  });

  it('no longer treats intimacy or flirting as deletable repeated process when it forms a trend', () => {
    expect(RESUMMARY_PROMPT).toContain('关系线(与上面同优');
    expect(RESUMMARY2_PROMPT).toContain('承载关系推进/退缩的亲密互动与调情');
    expect(RESUMMARY2_PROMPT).not.toContain('购物、换衣、调情等过程');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('关系线保留');
    expect(THINKING_CHECKLIST).toContain('关系线保留');
  });

  it('ships the departure protocol: presence markers, unknown whereabouts and sceneFocus reconciliation', () => {
    for (const contract of ['〔在场〕/〔同区域〕/〔不在场〕', '在场核对', '所在不明', 'location 填空字符串', 'sceneFocus.participants 改成与实际在场名单一致']) {
      expect(RULE_NPCS).toContain(contract);
    }
    expect(SUMMARY_PROMPT).toContain('按本楼开始前的状态算好');
    expect(SUMMARY_PROMPT).toContain('离场去向未明填空字符串');
    expect(SUMMARY_PROMPT).toContain('participants 同步修正');
    expect(THINKING_CHECKLIST).toContain('离场同步 follow/location');
    expect(THINKING_CHECKLIST).toContain('去向不明明确清空 location');
  });

  it('frames the briefing as past-only context that does not cap relationships or set prose style', () => {
    expect(MEMORY_BRIEFING_END).toContain('不是上限');
    expect(MEMORY_BRIEFING_END).toContain('继续发展或转折');
    expect(MEMORY_BRIEFING_END).toContain('不要模仿压缩记录的句式');
  });

  it('keeps the briefing end short while retaining each reminder', () => {
    // 每次生成正文都会发并占注入预算:只留结论,但位置、计划、伤情、知情范围的提醒都要在。
    // 伤情:离场本身不等于康复或恶化,但不再要求时间流逝后一直维持原伤(由伤势进展提醒配合)。
    // prism.18 起加了一句「只在相关时体现」,上限从 260 放宽到 280,仍要求简短(最低注入预算下框定文字挤占状态份额)。
    expect(Array.from(MEMORY_BRIEFING_END).length).toBeLessThan(280);
    for (const reminder of ['自然续写', '不要复述简报', '最后确认的位置与着装可能已变', '不等于马上执行', '遵守其中的暂缓和前提',
      '离场不等于康复或恶化', '伤情随时间按轻重好转', '人物只知道自己经历或得知的事', '文风跟随角色卡']) {
      expect(MEMORY_BRIEFING_END).toContain(reminder);
    }
    expect(MEMORY_BRIEFING_END).not.toContain('时间流逝不是康复');
  });

  it('injuries stay in the briefing but are written only when relevant', () => {
    // 伤情事实照常注入;写作指引只在牵涉伤处、影响行动或被人提及时体现,与本轮无关时不写。
    expect(MEMORY_BRIEFING_END).toContain('身体状态按最后记录');
    for (const clause of ['只在牵涉伤处', '影响行动', '被人提及时带出', '与本轮无关不写']) {
      expect(MEMORY_BRIEFING_END).toContain(clause);
    }
    expect(MEMORY_BRIEFING_END).not.toMatch(/每轮(都)?(描写|体现|提及)伤/);
  });
});

describe.each(['detailed', 'concise'] as const)('prompt assembly (%s)', verbosity => {
  beforeEach(() => {
    apiSettings.verbosity = verbosity;
  });

  it.each([false, true])('keeps single-floor templates and time rules intact (custom=%s)', custom => {
    if (custom) apiSettings.prompts.summary = 'CUSTOM SUMMARY {{content}} {{summary_words}}';
    const parts = buildSummaryPrompt(args);
    const prompt = combined(parts);
    expect(prompt).toContain(args.content);
    // 每楼摘要字数取「摘要字数」设置(默认 300),不随档位变化;旧宏 summary_words 为一半到全额。
    expect(prompt).toContain(custom ? '150-300' : 'summary 不超过 300 字（含标点）');
    expect(prompt).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    expect(prompt).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(prompt).not.toMatch(/\{\{(?:content|summary_words)\}\}/);
    expect(parts.user).not.toContain(RULE_SUMMARY_COMPOSITION);
    if (custom) {
      expect(prompt).toContain('CUSTOM SUMMARY');
      expect(parts.system).not.toContain(RULE_SUMMARY_COMPOSITION);
    } else {
      expect(prompt).toContain('持续事实与背景参照');
      expect(parts.system.split(filled(RULE_SUMMARY_COMPOSITION))).toHaveLength(2);
    }
    // The existing caller sends this system checklist for both template paths.
    expectFactWorkflow(THINKING_CHECKLIST);
  });

  it('uses the same built-in state contract and character budget for every floor', () => {
    const parts = buildSummaryPrompt(args);
    expect(parts.system).not.toContain('stateChanges');
    expect(parts.system).toContain('【状态核对】');
    expect(parts.system).toContain('summary 不超过 300 字（含标点）');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it.each([
    [1, false], [1, true],
    [2, false], [2, true],
    [3, false], [3, true],
  ] as const)('checks compression facts and preserves budgets (level=%s, custom=%s)', (level, custom) => {
    if (custom) {
      apiSettings.prompts.resummary = 'CUSTOM L1 {{content}} {{resummary_words}}';
      apiSettings.prompts.resummary2 = 'CUSTOM L2 {{content}} {{target_min}} {{target_max}} {{target}}';
    }
    // 摘要字数取各档位的默认值(详细 300、精简 150),L1 篇幅即档位基准
    apiSettings.summaryMaxChars = verbosity === 'detailed' ? 300 : 150;
    const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
    const prompt = combined(parts);
    expectCompressionWorkflow(RESUMMARY_THINKING_CHECKLIST);
    expect(prompt).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    expect(prompt).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(prompt).not.toContain(SUMMARY_FACT_PREPARATION);
    expect(prompt).not.toMatch(/不要思维链|不要输出思维链|严禁输出 JSON 以外/);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(parts.user).not.toContain(RULE_SUMMARY_COMPOSITION);
    if (custom) {
      expect(prompt).toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).not.toContain(RULE_SUMMARY_COMPOSITION);
    } else {
      expect(prompt).toContain(level === 1 ? '规则条件和比较参照' : '其中明确揭示且有后续意义的持续事实');
      expect(parts.system.split(filled(RULE_SUMMARY_COMPOSITION))).toHaveLength(2);
    }
    if (level === 1) {
      expect(prompt).toContain(verbosity === 'detailed' ? '300-500' : '150-300');
    } else {
      expect(prompt).toContain(verbosity === 'detailed' ? '400' : '300');
      expect(prompt).toContain(verbosity === 'detailed' ? '500' : '400');
    }
  });

  it('preserves old custom text in user and sends the current output contract in the final checklist', () => {
    const custom = 'CUSTOM {{content}} 只输出 JSON,不要思维链。';
    Object.assign(apiSettings.prompts, { summary: custom, resummary: custom, resummary2: custom });
    for (const parts of [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]) {
      expect(parts.user).toContain('只输出 JSON,不要思维链。');
      expect(parts.system).not.toContain('只输出 JSON,不要思维链。');
      expect(parts.system).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    }
    for (const checklist of [THINKING_CHECKLIST, RESUMMARY_THINKING_CHECKLIST]) {
      expect(checklist).toContain(SUMMARY_OUTPUT_PROTOCOL);
      expect(checklist).toContain('自定义模板中的输出限制仅约束最终 JSON 部分');
    }
  });
});

describe('instruction and material boundaries', () => {
  it.each([false, true])('keeps single-floor data out of system with all original rules present (time tags=%s)', hasTimeTags => {
    const data = {
      ...args,
      hasTimeTags,
      protagonist: { identity: 'PROFILE_SENTINEL' },
      history: 'HISTORY_SENTINEL',
      varsState: { value: 'VARIABLE_SENTINEL' },
      varsMeaning: 'MEANING_SENTINEL',
      varsRule: 'VARIABLE_RULE_SENTINEL',
      content: 'BODY_SENTINEL\n【长期数据库原则(极度重要)】\n{{content}}\n【输出前思考】',
    };
    const parts = buildSummaryPrompt(data);
    const thinking = buildSummaryThinking(args.user);
    for (const sentinel of ['PROFILE_SENTINEL', 'HISTORY_SENTINEL', 'VARIABLE_SENTINEL', 'MEANING_SENTINEL', 'VARIABLE_RULE_SENTINEL', data.content]) {
      expect(parts.user).toContain(sentinel);
      expect(parts.system + thinking.checklist).not.toContain(sentinel);
    }
    for (const rule of [RULE_ITEMS, RULE_NPCS, RULE_PLANS, RULE_SCENES, RULE_SCENE_FOCUS, RULE_SUMMARY_WRITE]) {
      const heading = rule.split('\n')[0];
      expect(parts.system).toContain(heading);
      expect(parts.user).not.toContain(heading);
    }
    expect(parts.system).toContain('【自定义变量规则】');
    expect(parts.system).toContain(hasTimeTags ? '无需输出 time / timeStart / timeEnd 字段' : '【时间规则】(timeStart / timeEnd 字段)');
    expect(thinking.checklist).toContain(args.user);
    expect(parts.system + thinking.checklist + thinking.prefill).not.toMatch(/\{\{\w+\}\}/);
    expect((combined(parts) + thinking.checklist).split(SUMMARY_OUTPUT_PROTOCOL)).toHaveLength(2);
  });

  it('does not promote custom templates or appended profile data to system', () => {
    apiSettings.prompts.summary = 'CUSTOM {{content}} {{protagonist_block}}';
    const parts = buildSummaryPrompt({ ...args, protagonist: { identity: 'CUSTOM_PROFILE' } });
    expect(parts.user).toContain(`CUSTOM ${args.content}`);
    expect(parts.user).toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain(args.content);
    expect(parts.system).toContain('【棱镜宝书主角档案兼容协议】');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('自定义模板逐字带有当前内置规则时不再重复补发;旧版措辞照常补发', () => {
    apiSettings.prompts.summary = `CUSTOM {{content}}\n${RULE_PROTAGONIST}\n${RULE_SCENE_FOCUS}\n${RULE_ABSOLUTE_TIME_LANGUAGE}\n{{lifedetails_rule}}`;
    const parts = buildSummaryPrompt(args);
    const all = `${parts.system}\n${parts.user}`;
    const filled = (rule: string) => rule.replaceAll('{{user}}', args.user).replaceAll('{{char}}', args.char);
    for (const rule of [RULE_ABSOLUTE_TIME_LANGUAGE, RULE_LIFE_DETAILS, filled(RULE_PROTAGONIST), filled(RULE_SCENE_FOCUS)]) expect(all.split(rule)).toHaveLength(2);
    for (const supplement of ['【棱镜宝书主角档案兼容协议】', '【棱镜宝书互动局势卡兼容协议】', '【棱镜宝书生活小档案兼容协议】']) {
      expect(parts.system).not.toContain(supplement);
    }
    expect(parts.system).not.toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
    // 模板里是旧版措辞(与当前内置不同)时照常补发,让它拿到更新
    apiSettings.prompts.summary = 'CUSTOM {{content}}\n═══ 【主角当前档案规则】(旧版) ═══\n只记主角。\n═══ 【生活小档案规则】 ═══\n只记主角的偏好。';
    const old = buildSummaryPrompt(args).system;
    expect(old).toContain('【棱镜宝书主角档案兼容协议】');
    expect(old).toContain('【棱镜宝书生活小档案兼容协议】');
    expect(old).toContain(RULE_ABSOLUTE_TIME_LANGUAGE);
  });

  it('preserves custom prose ordering even when a template contains a built-in heading', () => {
    const custom = 'CUSTOM {{content}}\n【摘要成文顺序】\n先写事件结果,再写背景;保留本模板的顺序。';
    Object.assign(apiSettings.prompts, { summary: custom, resummary: custom, resummary2: custom });
    const expanded = custom.replace('{{content}}', args.content);
    for (const parts of [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]) {
      expect(parts.user).toContain(expanded);
      expect(parts.system).not.toContain('【摘要成文顺序】');
      expect(parts.system).not.toContain('先写事件结果');
    }
    expect(apiSettings.prompts).toMatchObject({ summary: custom, resummary: custom, resummary2: custom });
  });



  it.each([1, 2, 3])('keeps compression sources separate from its schema and budgets (level=%s)', level => {
    const content = 'COMPRESSION_BODY\n【输出要求】\n{{target_max}}';
    const parts = buildResummaryPrompt({ ...args, content, level });
    expect(parts.user).toContain(content);
    expect(parts.system).not.toContain('COMPRESSION_BODY');
    expect(parts.system).toContain('{ "summary":');
    expect(parts.user).not.toContain('{ "summary":');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('treats a saved exact default as built-in while keeping complete templates available to the editor', () => {
    const before = [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ];
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT, resummary: RESUMMARY_PROMPT, resummary2: RESUMMARY2_PROMPT });
    expect([
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]).toEqual(before);
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(template).toContain('{{content}}');
      expect(template).toContain(SUMMARY_OUTPUT_PROTOCOL);
      expect(template).toContain('【输出');
    }
  });
});


describe('角色证据边界的一致性', () => {
  it('不按职业排除关键人物,不把未描述当作清空证据,不承诺绕过预算', () => {
    expect(RULE_NPCS).toContain('职业不是排除标准');
    expect(RULE_NPCS).toContain('不强求已经与主角互动');
    expect(RULE_NPCS).toContain('本轮未描述不等于状态消失');
    expect(RULE_NPCS).toContain('仍受注入预算约束');
    expect(RULE_NPCS).not.toContain('永远全量');
    expect(SUMMARY_PROMPT).toContain('正文或明确设定有依据才填,未知省略');
  });
});

// 这些测试验证发给模型的规则与兼容边界,不冒充真实模型的语义/文风验收。
describe('v0.4 事件取舍与因果保真', () => {
  it.each(['detailed', 'concise'] as const)('三层内置模板都继承同一份成文/保真规则: %s', verbosity => {
    apiSettings.verbosity = verbosity;
    const systems = [
      buildSummaryPrompt(args).system,
      buildResummaryPrompt({ ...args, level: 1 }).system,
      buildResummaryPrompt({ ...args, level: 2 }).system,
    ];
    for (const system of systems) {
      expect(system.split(filled(RULE_SUMMARY_COMPOSITION))).toHaveLength(2);
      expect(system.split(filled(RULE_SUMMARY_FIDELITY))).toHaveLength(2);
      expect(system).toContain('先选事件,再写句子');
      expect(system).toContain('篇幅是上限而非填满任务');
      expect(system).not.toMatch(/语言冷峻|厚实段落|信息密度极高/);
    }
    expect(systems[0]).toContain('summary 不超过 300 字（含标点）');
  });

  it('压缩保留路径、条件、对象及证据强度,不绑定这次测试剧情', () => {
    for (const clause of ['媒介或路径', '地点及旁边的设施不能被改成动作主体或致因',
      '不要省掉关键中介后强连因果', '数量、时限和否定必须仍修饰原来的对象',
      '推测、可能、声称、打算不升级为事实或完成', '闪回不刷新当前状态',
      '归还、取消、拒绝、失败与免除不是同一种完成']) {
      expect(RULE_SUMMARY_FIDELITY).toContain(clause);
    }
    expect(RULE_SUMMARY_COMPOSITION).not.toMatch(/小A|小B|林舟|归雁|钟楼|遮雨棚|2031/);
  });

  it('优先舍弃机械动作但不误删技术情报、关系边界或未完成状态', () => {
    expect(RULE_SUMMARY_COMPOSITION).toContain('关键技术情报、数值和关系证据可保留');
    expect(RULE_SUMMARY_COMPOSITION).toContain('反复取放、检查、收纳物品不是多次新进展');
    expect(RULE_SUMMARY_COMPOSITION).toContain('拒绝、回应、承诺和边界保留具体语义');
    expect(RULE_SUMMARY_COMPOSITION).toContain('不要为多塞细节而删虚词、堆分号');
    expect(RULE_SUMMARY_WRITE).toContain('不必保留末尾整理物品或继续吃饭等收场动作');
    expect(RULE_SUMMARY_WRITE).toContain('不能因此删去未进入、未归还等关键否定');
    expect(RULE_SUMMARY_WRITE).not.toContain('最后留一处');
  });

  it('上层按阶段融合,不强制逐动作标时或擅补心理因果', () => {
    expect(RESUMMARY_PROMPT).toContain('按事件阶段而非原摘要逐条拼接');
    expect(RESUMMARY_PROMPT).toContain('不必逐动作标时');
    expect(RESUMMARY_PROMPT).toContain('期限、预约与影响顺序判断的具体时刻不得抹掉');
    expect(RESUMMARY_PROMPT).toContain('情绪或信任变化仅在输入明确说明时保留');
    expect(RESUMMARY2_PROMPT).toContain('不照抄下层摘要的动作清单');
  });

  it('最后复核检查不误改因果,不增加新的输出字段', () => {
    expect(SUMMARY_FACT_VERIFICATION).toContain('不把邻近设施写成致因');
    expect(THINKING_CHECKLIST).toContain(SUMMARY_FACT_VERIFICATION);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(RESUMMARY_FACT_REVIEW);
    for (const checklist of [THINKING_CHECKLIST, RESUMMARY_THINKING_CHECKLIST]) {
      expect(checklist).not.toContain(RULE_SUMMARY_FIDELITY);
    }
  });

  it('不会用新文风规则覆盖用户自定义模板', () => {
    apiSettings.prompts.summary = 'CUSTOM SUMMARY {{content}}';
    apiSettings.prompts.resummary = 'CUSTOM L1 {{content}}';
    apiSettings.prompts.resummary2 = 'CUSTOM L2 {{content}}';
    const outputs = [buildSummaryPrompt(args), ...[1, 2].map(level => buildResummaryPrompt({ ...args, level }))];
    for (const output of outputs) {
      expect(output.user).toContain('CUSTOM');
      expect(output.system + output.user).not.toContain(filled(RULE_SUMMARY_COMPOSITION));
      expect(output.system + output.user).not.toContain(filled(RULE_SUMMARY_FIDELITY));
    }
  });
});


describe('v0.5 伤势保留及通用压缩示范', () => {
  it('主角与NPC共用恢复证据规则,不把临时理解成可随意删除', () => {
    // 全文只在主角规则里出现一次,NPC 规则引用它,内置请求和自定义模板的兼容协议都不重复发送。
    expect(RULE_PROTAGONIST).toContain(RULE_HEALTH_STATE);
    expect(RULE_NPCS).not.toContain(RULE_HEALTH_STATE);
    expect(RULE_NPCS).toContain('按上方【临时伤情与恢复证据】,与主角同一标准');
    expect(RULE_HEALTH_STATE).toContain('主角与 NPC 通用');
    const system = buildSummaryPrompt(args).system;
    expect(system.split(RULE_HEALTH_STATE)).toHaveLength(2);
    // 主角规则开头会引用后文的【NPC 规则】,这里比较的是 NPC 规则一节本身的位置。
    expect(system.indexOf(RULE_HEALTH_STATE)).toBeLessThan(system.indexOf('═══ 【NPC 规则】'));
    apiSettings.prompts.summary = 'CUSTOM {{content}}';
    expect(buildSummaryPrompt(args).system.split(RULE_HEALTH_STATE)).toHaveLength(2);
    for (const clause of ['临时不等于不重要', '超过预计休养天数时均保留', '没有新证据就省略 condition',
      '不是自动失效时间', '闪回中的健康不能覆盖当前伤情', '保留其他尚未解除的伤情和限制',
      '不等于所有伤情痊愈', '历史受伤与当前已恢复可以并存']) expect(RULE_HEALTH_STATE).toContain(clause);
  });
  it('外貌、装备与伤情分开,允许显式纠错而不复活旧伤', () => {
    expect(RULE_NPCS).toContain('刀鞘、佩刀等当下装备不属于固定外貌');
    expect(RULE_NPCS).toContain('desc 省略=保持,空字符串=明确清空');
    expect(RULE_NPCS).toContain('不能仅凭旧 desc 把已痊愈伤情重新写回 condition');
    expect(RULE_HEALTH_STATE).toContain('稳定体貌未知就省略');
  });
  it.each(['detailed', 'concise'] as const)('三层共享示范且不扩散进自定义模板: %s', verbosity => {
    apiSettings.verbosity = verbosity;
    for (const system of [buildSummaryPrompt(args).system, buildResummaryPrompt({ ...args, level: 1 }).system,
      buildResummaryPrompt({ ...args, level: 2 }).system]) {
      expect(system.split(RULE_SUMMARY_EXAMPLES)).toHaveLength(2);
      expect(system).toContain('不要把“若…则…”擅改为“只有…才…”');
      expect(system).toContain('不复用人物、物品或情节');
    }
    Object.assign(apiSettings.prompts, { summary: '用户模板', resummary: '用户模板', resummary2: '用户模板' });
    for (const output of [buildSummaryPrompt(args), buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 })]) expect(output.system + output.user).not.toContain(RULE_SUMMARY_EXAMPLES);
  });
});


describe('v0.8 位置时效与程度来源限定', () => {
  it('内置NPC规则不再强迫未同行者重复确认旧地点', () => {
    expect(RULE_NPCS).not.toContain('locationEvidence');
    expect(RULE_NPCS).toContain('主角换景而定点角色未同行、此前打算留守或暂无新消息 → 不重报旧 location');
    expect(RULE_NPCS).toContain('location 通常就填{{user}}本楼所在地点');
    expect(RULE_NPCS).toContain('只被提起、通话或传信联系的角色不算同处');
    expect(RULE_NPCS).not.toContain('被留在原地而主角离开 → 必须更新');
  });
  it.each([SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT].map((template, i) => ({ template, level: i })))('第 $level 层均保留程度、来源和临时性规则', ({ template }) => {
    for (const clause of ['极少≠零', '至少≠约', '人物口述保留来源', '保留时间适用范围', '没放过去两个', '场景 desc']) expect(template).toContain(clause);
  });
  it('地点临时管制不进描述，口述保留来源，不固化为长期规律', () => {
    for (const clause of ['临检或管制', '据掌柜称', '一次停留或遭遇等临时情况不进 desc', '写 summary 或 sceneFocus']) expect(RULE_SCENES).toContain(clause);
    expect(RULE_SUMMARY_FIDELITY).toContain('当日临检、眼前所见不升级为长期规律');
  });
});


describe('v0.9 通用交易、来源和地理规则', () => {
  it('物品按主角归属及实际转移记账，不把NPC财产或计划入账', () => {
    for (const clause of ['不是全体人物的财产表', 'NPC互相交易', '借出/归还/赠出/支付不算获得', '首次提到早就带着的东西不是刚获得', '从口袋取出再放回不增减']) expect(RULE_ITEMS).toContain(clause);
  });
  it('增量、绝对余额和未知数分开，免债或结清不虚构付款', () => {
    for (const clause of ['不是加完的总数', 'update.qty 写剩下的总数', '原数未知时拿支出量、欠款或默认 1 反推余额', '免债、结清、不退款既不是收款也不是付款', '按包装记一份']) expect(RULE_ITEMS).toContain(clause);
    expect(SUMMARY_PROMPT).toContain('本次新增量(必填正数,不是加完的总数;数不清的按包装算 1 份)');
  });
  it('地点结构与临时所见分开，不能以先后移动推断包含关系', () => {
    for (const clause of ['稳定与临时事实混在一句时拆开', '先后到访不等于从属', '相邻或望见', '按常识或世界地图补出的上级', '真在两地之间赶路、连上级都确认不了时才给 []']) expect(RULE_SCENES).toContain(clause);
  });
  it('一句话局势仍分清口述、判断、所见，不统一改写成得知', () => {
    expect(RULE_SCENE_FOCUS).toContain('所见写所见,口述写「某人称」,判断写「某人认为」');
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) expect(template).toContain('压缩到一句话也须逐命题保留来源');
  });
  it.each(['detailed', 'concise'] as const)('正式模板同时包含通用规则，不依赖具体故事：%s', verbosity => {
    apiSettings.verbosity = verbosity;
    const rendered = buildSummaryPrompt(args);
    expect(rendered.system + rendered.user).toContain('不是全体人物的财产表');
    expect(rendered.system + rendered.user).toContain('原数未知时拿支出量、欠款或默认 1 反推余额');
    expect(rendered.system + rendered.user).toContain('先后到访');
    expect(rendered.system + rendered.user).toContain('所见写所见');
  });
});

// 字数只是写给模型的要求;是否保存不看字数(见 summaryResponse.test / summaryRebuild.test)。
describe('每楼摘要字数要求', () => {
  it.each(['detailed', 'concise'] as const)('字数来自「摘要字数」设置，不跟档位走: %s', verbosity => {
    apiSettings.verbosity = verbosity;
    apiSettings.summaryMaxChars = 450;
    const system = buildSummaryPrompt(args).system;
    expect(system).toContain('summary 不超过 450 字（含标点）');
    expect(system).toContain('没有最低篇幅任务');
    expect(system).not.toMatch(/\{\{\w+\}\}/);
    apiSettings.prompts.summary = 'CUSTOM {{content}} {{summary_max_chars}} {{summary_words}}';
    expect(buildSummaryPrompt(args).user).toContain(`CUSTOM ${args.content} 450 225-450`);
  });

  it('输入框暂时为空或超出范围时，请求里仍是有效字数', () => {
    for (const [value, expected] of [[Number.NaN, 300], ['' as unknown as number, 300], [5, 50], [99999, 2000], [333.4, 333]] as const) {
      apiSettings.summaryMaxChars = value;
      expect(buildSummaryPrompt(args).system).toContain(`summary 不超过 ${expected} 字（含标点）`);
    }
  });

  it('L1 总结篇幅随摘要字数等比放大(1–3 倍),默认值不变;二次总结仍按输入比例', () => {
    for (const [verbosity, chars, words] of [
      ['detailed', 300, '300-500'], ['detailed', 50, '300-500'], ['detailed', 450, '450-750'], ['detailed', 800, '800-1333'], ['detailed', 2000, '900-1500'],
      ['concise', 150, '150-300'], ['concise', 300, '150-300'], ['concise', 800, '400-800'], ['concise', 1200, '450-900'],
    ] as const) {
      apiSettings.verbosity = verbosity;
      apiSettings.summaryMaxChars = chars;
      const system = buildResummaryPrompt({ ...args, level: 1 }).system;
      expect(system).toContain(`${words} 字为参考范围`);
      expect(system).toContain('信息少可更短');
      apiSettings.prompts.resummary = 'CUSTOM {{content}} {{resummary_words}}';
      expect(buildResummaryPrompt({ ...args, level: 1 }).user).toContain(`CUSTOM ${args.content} ${words}`);
      apiSettings.prompts.resummary = '';
    }
    apiSettings.summaryMaxChars = 800;
    for (const [verbosity, max] of [['detailed', '500'], ['concise', '400']] as const) {
      apiSettings.verbosity = verbosity;
      expect(buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level: 2 }).system).toContain(`summary 不得超过 ${max} 字`);
    }
  });

  it('不再要求「宁可明显短于上限」，调大摘要字数后可以写得更详细，仍不为凑字数填充', () => {
    for (const text of [RULE_SUMMARY_COMPOSITION, buildSummaryPrompt(args).system]) {
      expect(text).not.toContain('宁可明显短于上限');
      expect(text).toContain('篇幅是上限而非填满任务');
    }
    expect(RULE_SUMMARY_WRITE).toContain('没有最低篇幅任务');
  });
});

describe('提示词细节修订', () => {
  it('带时间标签时 JSON 示意里没有注释行;无标签时照常给出两端时间字段', () => {
    const withTags = buildSummaryPrompt({ ...args, hasTimeTags: true }).system;
    expect(withTags).not.toMatch(/^\s*\/\//m);
    expect(withTags).toContain('无需输出 time / timeStart / timeEnd 字段');
    expect(withTags).toMatch(/"summary": "本轮剧情摘要,见【摘要撰写规则】。",\n\n {2}"location"/);
    const noTags = buildSummaryPrompt({ ...args, hasTimeTags: false }).system;
    expect(noTags).toMatch(/"summary": "本轮剧情摘要,见【摘要撰写规则】。",\n {2}"timeStart": "本段开始时的故事内时间/);
    expect(noTags).toMatch(/"timeEnd": "本段结束时的故事内时间,见下方【时间规则】。",\n {2}"location"/);
  });
  it('合并摘要写明 floor 填标题里的楼层编号,不是段落编号里的消息序号', () => {
    expect(BATCH_SUMMARY_PROMPT).toContain('floor 填该层标题「═══ 楼层 #编号 ═══」里的楼层编号,不是段落编号 [M消息序号-P段号] 里的消息序号');
  });
  it('核查清单的时间口径与无标签时的时间规则一致,保留「回忆不推进主线」', () => {
    expect(THINKING_CHECKLIST).toContain('时间沿用证据与精度,没有新依据时沿用当前锚点,不补造未知部分,回忆不推进主线');
    expect(THINKING_CHECKLIST).not.toContain('未知留空');
  });
  it('回看原文补档案写明各字段的长度上限', () => {
    for (const rule of ['不超过 60 字', '不超过 240 字', '不超过 160 字', '外貌 240 字、性格 160 字、身份 60 字']) expect(NPC_ENRICH_PROMPT).toContain(rule);
  });
});
