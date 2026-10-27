import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';

const original = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = {
  user: '主角', char: '角色', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [], openPlans: [], resolvedPlans: [],
  history: '', content: '输入正文。', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
beforeEach(() => Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' }));
afterEach(() => Object.assign(apiSettings, JSON.parse(original)));

// 这些是正式请求的规则传播检查，不是模型理解测试。
describe('v0.10 共享事实边界与冲突消除', () => {
  it.each(['detailed', 'concise'] as const)('三层请求各消费一次空间证据规则且不扩大预算: %s', verbosity => {
    apiSettings.verbosity = verbosity;
    const systems = [p.buildSummaryPrompt(args).system, p.buildResummaryPrompt({ ...args, level: 1 }).system,
      p.buildResummaryPrompt({ ...args, level: 2 }).system];
    for (const system of systems) {
      expect(system.match(/【空间事实边界】/g)).toHaveLength(1);
      for (const rule of ['分段移动按先后保留', '不得把多段方向合成一个新方向', '参照物不明就不补方位',
        '目的地不等于已到达', '看见、邻近、出发或到访顺序不证明地理包含']) expect(system).toContain(rule);
    }
    expect(p.THINKING_CHECKLIST.length).toBeLessThan(6500);
    expect(p.RESUMMARY_THINKING_CHECKLIST.length).toBeLessThan(1300);
    expect(p.SUMMARY_FACT_PREPARATION.length + p.SUMMARY_FACT_VERIFICATION.length).toBeLessThan(600);
  });
  it('检索重写也不扩大方位与目标的确定性', () => {
    expect(p.QUERY_REWRITE_SYSTEM).toContain('【空间事实边界】');
    expect(p.QUERY_REWRITE_SYSTEM).toContain('目的地不等于已到达');
    expect(p.QUERY_REWRITE_SYSTEM).toContain('问题中也不得预设未经证实的归属、因果或已完成状态');
    expect(p.QUERY_REWRITE_TAIL).toContain('不将移动目的地当作已到达');
    // 检索只用跟提问有关的几句，不再整段带摘要专用的空间规则。
    expect(p.QUERY_REWRITE_SYSTEM).not.toContain(p.RULE_SPATIAL_EVIDENCE);
    expect(p.QUERY_REWRITE_SYSTEM).not.toContain('摘要末尾');
  });
  it('检索重写写明输出的用途:Q 与逐楼摘要比相似度,INTENT 覆盖每条 Q;摘要有损时仍查细节,只输出纯文本行', () => {
    for (const rule of ['每条 Q 与这些摘要比对相似度', 'INTENT 用来判断取回的每一段旧剧情与需求是否相关',
      '只一句带过、而当前剧情需要细节的旧事,正是要查的内容', 'INTENT 先写需要回忆什么,覆盖每条 Q 的要点',
      '每条只查一件事', '只输出纯文本行', '不输出解释、序号、Markdown 标记或续写']) expect(p.QUERY_REWRITE_SYSTEM).toContain(rule);
    // 示例不再带对打分无用的元叙述
    expect(p.QUERY_REWRITE_SYSTEM).not.toContain('当前窗口没有约定内容');
    expect(p.QUERY_REWRITE_TAIL.startsWith('以上是最近对话。')).toBe(true);
    expect(p.QUERY_REWRITE_TAIL).toContain('覆盖每条 Q 的要点');
    expect(p.QUERY_REWRITE_TAIL).toContain('不用 Markdown 标记');
    // 未接入设置页的宏说明已删除
    expect(p).not.toHaveProperty('QUERY_REWRITE_MACROS');
  });
  it('检索重写固定5条查询,示例也是5条;不再按需减少条数', () => {
    expect(p.QUERY_REWRITE_SYSTEM).toContain('固定写5条查询');
    expect(p.QUERY_REWRITE_SYSTEM).toContain('之后恰好5行');
    expect(p.QUERY_REWRITE_TAIL).toContain('之后恰好5行');
    for (const text of [p.QUERY_REWRITE_SYSTEM, p.QUERY_REWRITE_TAIL]) {
      expect(text).not.toMatch(/按需1—3|不硬凑数量|只给一条/);
    }
    const example = p.QUERY_REWRITE_SYSTEM.slice(p.QUERY_REWRITE_SYSTEM.indexOf('例(人名只演示格式)'));
    expect(example.match(/^Q: /gm)).toHaveLength(5);
    expect(example.match(/^INTENT: (.+)$/m)?.[1].length).toBeLessThanOrEqual(200);
  });
  it('地点建档不再允许以短期现场状态凑描述', () => {
    // 1.4.4 起建点不要求描述:写不出稳定特征就只建节点,描述仍不收临时状态
    for (const rule of ['临时情况即使加了日期也不作为地点特征', '写不出就省略 desc 只建节点,不编、不凑',
      '发生改变其意义的关键事件时 update', '关键事件保留时间或阶段,不伪造日期']) expect(p.RULE_SCENES).toContain(rule);
    expect(p.RULE_SCENES).not.toContain('无稳定要点则不新建');
    expect(p.RULE_SCENES).not.toContain('确需记入 desc,必须保留时间范围');
  });
  it('既有地点纠错不继续累积旧的临时或无据描述', () => {
    expect(p.RULE_SCENES).toContain('只保留仍成立的稳定要点和重要历史事件,已证伪或过时的临时内容不继承');
    expect(p.RULE_SCENES).toContain('旧描述全是错填的临时状态时,desc 填空字符串清除,节点保留');
  });
  it('路径宁可短而有据，不为完整层级制造父级', () => {
    for (const rule of ['按常识或世界地图补出的上级', '新地点可以单独作顶级',
      '真在两地之间赶路、连上级都确认不了时才给 []', '已记录的地点后来查明从属于另一地点 → reparent']) expect(p.RULE_SCENES).toContain(rule);
    expect(p.RULE_SCENES).not.toContain('后来角色出门到');
  });
  it('物品既支持取得与支出，也允许不增数量的寄存和属性变化', () => {
    expect(p.RULE_ITEMS).toContain('数量、归属、保管位置或可用状态确有变化才写 items');
    expect(p.RULE_ITEMS).not.toContain('只有正文里**新发生**的获取/消耗/损坏才写 items');
    expect(p.RULE_ITEMS).toContain('只消耗其中一件不等于清空整组');
    expect(p.RULE_ITEMS).toContain('已有条目去向不明时省略 carried/location');
  });
  it('状态对账不强迫把首次提到的旧库存记成新获得', () => {
    expect(p.SUMMARY_PROMPT).toContain('首次提到旧持有物不强制 add');
    expect(p.SUMMARY_PROMPT).not.toContain('首次见到的重要人物/持有物须建档');
  });
  it('字段整体覆盖不能以完整为理由补齐未知值', () => {
    for (const rule of ['整体覆盖仅指保留未失效的已知信息', '未知项省略,不是必须填空',
      '叙述者知道不等于所有人物知情']) expect(p.RULE_LONGTERM_DB).toContain(rule);
    expect(p.RULE_NPCS).toContain('不能从一次举动推断固定性格');
    expect(p.RULE_PLANS).toContain('证据不足时不建计划,但不能在摘要里判定对方敷衍');
  });
  it('变量创建服从用户规则，不把自由创建变成见事就加字段', () => {
    expect(p.RULE_VARS).toContain('允许创建不等于必须创建');
    expect(p.RULE_VARS).toContain('既有路径同义事实不重复另建');
  });
  it('局势卡取本楼结束状态，排除回忆、被提及者和上一场角色', () => {
    expect(p.RULE_SCENE_FOCUS).toContain('本楼结束时的局面');
    expect(p.RULE_SCENE_FOCUS).toContain('远程联络、回忆、被提及不算在场');
  });
  it('正文简报不将地理或当时的临时管制永续化', () => {
    expect(p.MEMORY_BRIEFING_END).toContain('临时管制、天气和人群只在记录时点成立');
    expect(p.MEMORY_BRIEFING_END).toContain('不把目的地当成已到达');
  });
  it('用户自定义模板仍独立，不强塞本轮内置共享规则', () => {
    Object.assign(apiSettings.prompts, { summary: '定制 {{content}}', resummary: '定制 {{content}}', resummary2: '定制 {{content}}' });
    for (const result of [p.buildSummaryPrompt(args), p.buildResummaryPrompt({ ...args, level: 1 }), p.buildResummaryPrompt({ ...args, level: 2 })]) {
      expect(result.system + result.user).not.toContain('【空间事实边界】');
      expect(result.user).toContain('定制 输入正文。');
    }
  });
});

// v0.11：检查的是请求合同，真实模型语义仍由实际重建验收。
describe('v0.11 全字段保真与取舍合同', () => {
  it('输出协议只禁止额外审计字段，不删除剧情来源措辞', () => {
    expect(p.SUMMARY_OUTPUT_PROTOCOL).toContain('不要新增核查编号、来源列表或审计字段');
    expect(p.SUMMARY_OUTPUT_PROTOCOL).toContain('人物称述、推测与限定属于剧情事实');
    expect(p.SUMMARY_OUTPUT_PROTOCOL).not.toContain('不把来源标记或核查记录写进最终 JSON');
  });
  it.each([0, 1, 2])('第%s层正式请求都要求逐字段保真和不派生时差', level => {
    const system = level ? p.buildResummaryPrompt({ ...args, level }).system : p.buildSummaryPrompt(args).system;
    expect(system).toContain('保真逐字段独立成立');
    expect(system).toContain('到达阈值不等于超过阈值');
    expect(system).toContain('不自行增加提前/迟到多少天或持续多久');
    expect(system).toContain('不因摘要保留了来源就允许其他字段省略');
  });
  it('地点描述和路径同样逐个空间关系取证', () => {
    expect(p.RULE_SPATIAL_EVIDENCE).toContain('方位修饰只管原句对应对象');
    expect(p.RULE_SPATIAL_EVIDENCE).toContain('没有同一地点证据就不把两个名称合并');
    expect(p.RULE_SCENES).toContain('当次摆设');
    expect(p.RULE_SCENES).toContain('上下级要有依据');
    expect(p.SUMMARY_PROMPT).toContain('"path": ["上级区域","具体地点"]');
  });
  it('结果复核覆盖补丁字段，紧预算删除命题而不是来源', () => {
    expect(p.SUMMARY_FACT_VERIFICATION).toContain('summary及每个状态字段');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('删除后是否改变事件结果、行动选择、有效限制或关系边界');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('装饰性图样、材质与普通保管动作');
  });
});
