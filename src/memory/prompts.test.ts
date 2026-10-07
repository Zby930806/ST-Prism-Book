import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import {
  buildResummaryPrompt,
  buildSummaryPrompt,
  buildSummaryThinking,
  RESUMMARY_PROMPT,
  RESUMMARY2_PROMPT,
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

beforeEach(() => {
  Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
});

afterEach(() => {
  Object.assign(apiSettings.prompts, originalPrompts);
  apiSettings.verbosity = originalVerbosity;
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
    for (const heading of ['档案与快照分工', '在场核对', '物品/计划/变量']) {
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
    for (const rule of [RULE_ITEMS, RULE_SCENES, RULE_NPCS, RULE_PLANS, RULE_SCENE_FOCUS]) expect(system).toContain(rule.replaceAll('{{user}}', args.user));
    expect(THINKING_CHECKLIST).toContain('物品/计划/变量按本楼新事件更新记录,不重复结算');
    expect(THINKING_CHECKLIST).toContain('暂时离场不删除NPC');
    expect(THINKING_CHECKLIST).toContain('已取消/失败与已完成分清');
    expect(THINKING_CHECKLIST).toContain('只有新证据才能刷新位置、衣着和伤势');
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
      '不删重要参数、有效伤势及互动',
    ]) expect(SUMMARY_FACT_VERIFICATION).toContain(rule);
    // Unchanged evidence invariants remain in the shared system rules, not duplicated in the short final check.
    expect(RULE_SUMMARY_FIDELITY).toContain('保留证据强度、程度与说话人');
    expect(RULE_SUMMARY_FIDELITY).toContain('推测、可能、声称、打算不升级为事实或完成');
    expect(RULE_SUMMARY_FIDELITY).toContain('不能改写剩余命题的关系');
    expect(RULE_SUMMARY_COMPOSITION).toContain('不让动作细节挤掉关键事实及其限定');
    expect(SUMMARY_FACT_PREPARATION + SUMMARY_FACT_VERIFICATION).not.toMatch(/例如|比如|孤儿院|联赛|二转|三转/);
  });

  it('uses brief visible records and keeps each checklist within a compact size budget', () => {
    for (const [checklist, maxChars] of [
      [THINKING_CHECKLIST, 6500],
      [RESUMMARY_THINKING_CHECKLIST, 1300],
    ] as const) {
      expectFactWorkflow(checklist);
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
    expect(THINKING_CHECKLIST).toContain('不逐字段输出“无变化”');
  });

  it('gives compression its own checklist and prefill without ledger updates', () => {
    expectFactWorkflow(RESUMMARY_THINKING_CHECKLIST);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('待融合摘要就是本次事实来源');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('不得恢复输入中已缺失的事实');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('需要定位时沿用输入的 [编号]');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('不逐段填表');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('根键只有 summary');
    expect(RESUMMARY_THINKING_CHECKLIST).not.toContain('items.add');
    expect(RESUMMARY_THINKING_PREFILL).toBe('<thinking>');
  });

  it('checks state operations without permitting off-screen invention', () => {
    for (const rule of ['明确变化同时更新对应状态', '删除、清空或 resolve 须有依据', '整体覆盖保留未失效的旧要点', '只有新证据才能刷新位置、衣着和伤势', '不重复结算']) expect(THINKING_CHECKLIST).toContain(rule);
    expect(THINKING_CHECKLIST).not.toContain('主要 NPC 离场演变');
    expect(RULE_SCENES).toContain('当次观察、实时读数、短暂在场或一次遭遇不能改写为地点的长期属性');
    expect(RULE_SCENES).toContain('不能为满足 desc 必填而编造恒常特征');
  });

  it('separates deadlines from outcomes and scene observations from decisions', () => {
    for (const rule of ['不同纪年或模糊期限不可可靠比较时不强判', '已过期但结果未确认,保持原条目', '不得自动 resolve', '不能用现实日期替代故事时间']) expect(THINKING_CHECKLIST).toContain(rule);
    expect(RULE_SCENE_FOCUS).toContain('其余可选');
    expect(RULE_SCENE_FOCUS).toContain('明确预告/约定/已启动等待结果');
    expect(RULE_SCENE_FOCUS).toContain('禁止预测未发生剧情');
  });

  it('keeps admission evidence in the field rules instead of repeating it', () => {
    expect(RULE_SCENE_FOCUS).toContain('只有明确的、正在持续的社交张力才写');
    expect(RULE_SCENE_FOCUS).toContain('无则省略');
    expect(RULE_SCENES).toContain('不能为满足 desc 必填而编造恒常特征');
    expect(RULE_SCENES).toContain('当次观察、实时读数、短暂在场或一次遭遇不能改写为地点的长期属性');
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
    expect(SUMMARY_PROMPT).toContain('按**本楼开始前**的状态算好');
    expect(SUMMARY_PROMPT).toContain('离场去向未明填空字符串');
    expect(SUMMARY_PROMPT).toContain('同步修正 participants');
    expect(THINKING_CHECKLIST).toContain('在场核对');
    expect(THINKING_CHECKLIST).toContain('去向不明明确清空location');
  });

  it('frames the briefing as past-only context that does not cap relationships or set prose style', () => {
    expect(MEMORY_BRIEFING_END).toContain('不是上限');
    expect(MEMORY_BRIEFING_END).toContain('继续发展或转折');
    expect(MEMORY_BRIEFING_END).toContain('不要模仿压缩记录的句式');
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
    expect(prompt).toContain(verbosity === 'detailed' ? '150-300' : '80-150');
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
      expect(parts.system.split(RULE_SUMMARY_COMPOSITION)).toHaveLength(2);
    }
    // The existing caller sends this system checklist for both template paths.
    expectFactWorkflow(THINKING_CHECKLIST);
  });

  it('uses the same built-in state contract and character budget for every floor', () => {
    const parts = buildSummaryPrompt(args);
    expect(parts.system).toContain('stateChanges');
    expect(parts.system).toContain('【状态核对】');
    expect(parts.system).toContain(apiSettings.verbosity === 'concise' ? '150 字符' : '300 字符');
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
    const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
    const prompt = combined(parts);
    expectFactWorkflow(RESUMMARY_THINKING_CHECKLIST);
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
      expect(parts.system.split(RULE_SUMMARY_COMPOSITION)).toHaveLength(2);
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
      expect(system.split(RULE_SUMMARY_COMPOSITION)).toHaveLength(2);
      expect(system.split(RULE_SUMMARY_FIDELITY)).toHaveLength(2);
      expect(system).toContain('先选事件,再写句子');
      expect(system).toContain('篇幅是上限而非填满任务');
      expect(system).not.toMatch(/语言冷峻|厚实段落|信息密度极高/);
    }
    expect(systems[0]).toContain(verbosity === 'concise' ? '最多 150 字符' : '最多 300 字符');
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
    for (const checklist of [THINKING_CHECKLIST, RESUMMARY_THINKING_CHECKLIST]) {
      expect(checklist).toContain(SUMMARY_FACT_VERIFICATION);
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
      expect(output.system + output.user).not.toContain(RULE_SUMMARY_COMPOSITION);
      expect(output.system + output.user).not.toContain(RULE_SUMMARY_FIDELITY);
    }
  });
});


describe('v0.5 伤势保留及通用压缩示范', () => {
  it('主角与NPC共用恢复证据规则,不把临时理解成可随意删除', () => {
    for (const template of [RULE_PROTAGONIST, RULE_NPCS]) expect(template).toContain(RULE_HEALTH_STATE);
    for (const clause of ['临时不等于不重要', '超过预计休养天数时均保留', '没有新证据就省略 condition',
      '不是自动失效时间', '闪回中的健康不能覆盖当前伤势', '保留其他尚未解除的伤情和限制',
      '不等于所有伤势痊愈', '历史受伤与当前已恢复可以并存']) expect(RULE_HEALTH_STATE).toContain(clause);
  });
  it('外貌、装备与伤情分开,允许显式纠错而不复活旧伤', () => {
    expect(RULE_NPCS).toContain('刀鞘、佩刀等当下装备不属于固定外貌');
    expect(RULE_NPCS).toContain('desc 省略=保持,空字符串=明确清空');
    expect(RULE_NPCS).toContain('不能仅凭旧 desc 把已痊愈伤势重新写回 condition');
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
    expect(RULE_NPCS).toContain('locationEvidence');
    expect(RULE_NPCS).toContain('主角换景、定点NPC未同行且无新消息 → 不重报旧 location');
    expect(RULE_NPCS).toContain('不能机械抄【当前地点】');
    expect(RULE_NPCS).not.toContain('被留在原地而主角离开 → 必须更新');
  });
  it.each([SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT].map((template, i) => ({ template, level: i })))('第 $level 层均保留程度、来源和临时性规则', ({ template }) => {
    for (const clause of ['极少≠零', '至少≠约', '人物口述保留来源', '保留时间适用范围', '没放过去两个', '场景 desc']) expect(template).toContain(clause);
  });
  it('地点临时管制必须带时间范围和来源，不固化为永久制度', () => {
    for (const clause of ['当日临检/管制', '时间范围', '据掌柜称', '永久通行制度', '临时状态优先留在 summary/sceneFocus']) expect(RULE_SCENES).toContain(clause);
  });
});


describe('v0.9 通用交易、来源和地理规则', () => {
  it('物品按主角归属及实际转移记账，不把NPC财产或计划入账', () => {
    for (const clause of ['不是全体人物的财产表', 'NPC互相交易', '借出/归还/赠出/支付不算获得', '首次提到已有物品不等于刚获得', '从口袋取出再放回不增减']) expect(RULE_ITEMS).toContain(clause);
  });
  it('增量、绝对余额和未知数分开，免债或结清不虚构付款', () => {
    for (const clause of ['本次新增量而非结算后总量', '用 update.qty 写剩余总量', '不能反推原有量或剩余量', '不以默认1、支出量或欠款冒充余额', '免债/结清/不退款不等于收款或付款']) expect(RULE_ITEMS).toContain(clause);
    expect(SUMMARY_PROMPT).toContain('本次转入量(必填正数,非余额)');
  });
  it('地点结构与临时所见分开，不能以先后移动推断包含关系', () => {
    for (const clause of ['稳定与临时事实混在一句时必须拆分', '先后到访', '不证明包含关系', '不能为补齐路径新造父级', '无法对应已知节点则给 []']) expect(RULE_SCENES).toContain(clause);
  });
  it('一句话局势仍分清口述、判断、所见，不统一改写成得知', () => {
    expect(RULE_SCENE_FOCUS).toContain('所见写所见,口述写“某人称”,判断写“某人认为/估计”');
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) expect(template).toContain('压缩到一句话也须逐命题保留来源');
  });
  it.each(['detailed', 'concise'] as const)('正式模板同时包含通用规则，不依赖具体故事：%s', verbosity => {
    apiSettings.verbosity = verbosity;
    const rendered = buildSummaryPrompt(args);
    expect(rendered.system + rendered.user).toContain('不是全体人物的财产表');
    expect(rendered.system + rendered.user).toContain('不以默认1、支出量或欠款冒充余额');
    expect(rendered.system + rendered.user).toContain('先后到访');
    expect(rendered.system + rendered.user).toContain('所见写所见');
  });
});
