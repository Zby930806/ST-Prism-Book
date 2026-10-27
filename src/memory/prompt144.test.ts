import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';

// 1.4.4 参照原版柏宝书 1.3.5 修订的提示词合同:只验证发给模型的规则与兼容补充,不代表模型语义通过。
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = { user: '主角', char: '角色', time: '', location: '', protagonist: {}, sceneFocus: null, lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [], openPlans: [], resolvedPlans: [], history: '', content: '输入正文。', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '' };
beforeEach(() => Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' }));
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
const system = () => p.buildSummaryPrompt(args).system;

describe('1.4.4 单楼摘要规则', () => {
  it('角色位置不再附原句,也不再要求状态清单', () => {
    expect(system()).not.toMatch(/locationEvidence|stateChanges|定位证据/);
    expect(p.buildSummaryThinking('主角').checklist).not.toMatch(/locationEvidence|stateChanges|定位证据/);
    expect(p.RULE_KNOWLEDGE + p.RULE_CONFLICTS).not.toContain('stateChanges');
  });

  it('地点:到过的有名地点都建节点,描述可省;locationPath 退到能确认的上级;主角离开某处默认仍在上级区域', () => {
    for (const rule of ['只记到过的有名地点', '一条 add 写到最细一级即可,中间各级系统自动补建', '写不出就省略 desc 只建节点,不编、不凑',
      '对不上最细一级就退到能确认的上级', '真在两地之间赶路、连上级都确认不了时才给 []', '主角离开某处后默认仍在它的上级区域里(出了客栈仍在城西区)',
      '出发不等于到达', '"desc": "稳定特征一两句(可选;写不出就省略,不编)"']) expect(system()).toContain(rule);
    expect(p.RULE_SPATIAL_EVIDENCE).toContain('{{user}}默认仍在其上级区域内,他人离开视野而去向未写明就保持未知');
    expect(p.RULE_SPATIAL_EVIDENCE).not.toContain('也不能反向断言仍在上级区域');
  });

  it('首次记录当面互动的角色时,位置通常就是主角本楼所在地点;只被提起的不算同处', () => {
    for (const rule of ['正与主角当面互动的角色,location 通常就填主角本楼所在地点', '只被提起、通话或传信联系的角色不算同处',
      '所在地点(当面互动通常就是主角本楼所在地点;正文没交代就省略)']) expect(system()).toContain(rule);
    expect(system()).not.toContain('不能机械抄【当前地点】');
  });

  it('物品数不清时按包装记一份,部分用掉改描述', () => {
    for (const rule of ['数不清的不猜具体数,按包装记一份', '「一袋碎银」→ 钱袋 ×1', '按包装记的 → update desc 写剩多少,qty 不动',
      '原数量未知时不猜,按包装记的改 desc 写剩多少', '数不清的按包装算 1 份']) expect(system()).toContain(rule);
    expect(system()).not.toContain('“若干”“一把钱”等不能擅换成1个计数单位');
  });

  it('计划:客观上彻底不可能可以结案,离场、过期、暂时受阻不算;update 的写法有示例', () => {
    expect(p.RULE_PLANS).toContain('因客观事实已彻底不可能再发生(如约定的对象已死;离场、过期、暂时受阻都不算)');
    expect(p.RULE_PLANS).toContain('仍有效、未提及或结果未明 → 省略,不得因离场/过期/时间流逝自动结案');
    expect(p.RULE_PLANS).toContain('content「七日内还清 50 金,逾期扣押马车」(只改期限,后果照抄)');
  });

  it('局势卡:日常写氛围、剧情写处境,并给出正反例', () => {
    for (const rule of ['日常、陪伴类剧情写互动氛围', '剧情向写处境', '✗「先到酒馆打听消息', '✓「据守卫称北门已封」', '危险或行动难度本身也不算']) expect(p.RULE_SCENE_FOCUS).toContain(rule);
  });

  it('状态核对写明换地方、到新地点和名册人物变化都要更新对应字段', () => {
    for (const rule of ['换了地方须更新 location 与 locationPath', '到达新的有名地点须 scenes.add', '名册人物本楼换装、受伤或恢复、挪了地方须 npcs.update']) expect(system()).toContain(rule);
  });

  it('核查清单逐项盘点,顺序固定,宏都已展开', () => {
    const checklist = p.buildSummaryThinking('主角').checklist;
    let last = -1;
    for (const item of ['1. 本楼定位', '2. 主角盘点', '3. 人物盘点', '4. 局势盘点', '5. 物品盘点', '6. 生活小档案盘点', '7. 计划与悬念盘点',
      '8. 信息差与冲突', '9. 变量盘点', '10. 对照本楼原文', '11. 档案与快照分工', '12. 时间沿用证据与精度']) {
      const at = checklist.indexOf(item);
      expect(at, item).toBeGreaterThan(last);
      last = at;
    }
    expect(checklist).not.toMatch(/\{\{\w+\}\}/);
    expect(p.buildSummaryThinking('主角').prefill).toContain('按核查清单逐项盘点');
  });
});

describe('1.4.4 总结、二次总结与正文简报', () => {
  it('总结与二次总结的核查清单只讲压缩,不带单楼的状态字段与收纳规则', () => {
    expect(p.RESUMMARY_THINKING_CHECKLIST).toContain(p.RESUMMARY_FACT_REVIEW);
    expect(p.RESUMMARY_THINKING_CHECKLIST).not.toMatch(/状态字段|普通收纳和收场动作|离场者/);
    expect(p.BATCH_SUMMARY_THINKING_CHECKLIST).not.toMatch(/每个状态字段|离场者/);
  });

  it('二次总结优先保留怀孕、死亡、重要物品得失、地点变化等有持续后果的客观状态', () => {
    expect(p.buildResummaryPrompt({ ...args, level: 2 }).system).toContain('怀孕、死亡、重要物品得失、地点变化等有持续后果的客观状态');
  });

  it('关系线保留:必须保留具体语义,同类互动可以合并', () => {
    expect(p.RULE_RELATION_MOMENTUM).toContain('也必须保留其具体语义,不得以“没有新事件”为由压缩掉;同类互动可以合并');
    expect(p.RULE_RELATION_MOMENTUM).toContain('不要求每次互动各占一句');
  });

  it('正文简报:最后确认的位置与着装都可能已变', () => {
    expect(p.MEMORY_BRIEFING_END).toContain('最后确认的位置与着装可能已变');
  });

  it.each([0, 1, 2])('第 %s 层发送时 {{user}} 都已展开', level => {
    const sent = level ? p.buildResummaryPrompt({ ...args, level }).system : system();
    expect(sent).not.toMatch(/\{\{\w+\}\}/);
    expect(sent).toContain('主角默认仍在其上级区域内');
  });

  it('合并摘要发送时 {{user}} 也已展开', () => {
    const sent = p.buildBatchSummaryPrompt({ user: '主角', char: '角色', time: '', history: '', content: '═══ 楼层 #1 ═══\n正文。' }).system;
    expect(sent).not.toMatch(/\{\{\w+\}\}/);
    expect(sent).toContain('主角默认仍在其上级区域内');
  });
});

describe('旧自定义模板的写法更正', () => {
  it('模板还教伤情片段补丁时补一段伤情写法更正', () => {
    apiSettings.prompts.summary = '旧模板:已有伤情时改用 conditionPatch,不整段覆盖。{{content}}';
    const sent = system();
    expect(sent).toContain('【棱镜宝书伤情写法更正】');
    expect(sent).toContain('condition 一律整段覆盖');
    expect(sent).toContain('以本更正为准');
  });

  it('模板还要求定位原句时补一段位置写法更正,并展开主角名', () => {
    apiSettings.prompts.summary = '旧模板:非空 location 必填 locationEvidence。{{content}}';
    const sent = system();
    expect(sent).toContain('【棱镜宝书角色位置写法更正】');
    expect(sent).toContain('location 通常就填主角本楼所在地点');
    expect(sent).not.toMatch(/\{\{\w+\}\}/);
  });

  it('模板没有这些旧写法时不补;内置模板也不补', () => {
    apiSettings.prompts.summary = '定制 {{content}}';
    expect(system()).not.toMatch(/伤情写法更正|角色位置写法更正/);
    apiSettings.prompts.summary = '';
    expect(system()).not.toMatch(/伤情写法更正|角色位置写法更正/);
  });
});
