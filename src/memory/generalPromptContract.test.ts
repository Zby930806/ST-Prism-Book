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
    expect(p.QUERY_REWRITE_SYSTEM).toContain('问题中也不得预设未经证实的归属、因果或已完成状态');
    expect(p.QUERY_REWRITE_TAIL).toContain('不将移动目的地当作已到达');
  });
  it('地点建档不再允许以短期现场状态凑描述', () => {
    for (const rule of ['临时现场状态即使加了日期也不作为地点特征入档', '空间结构、用途或稳定特征',
      '无稳定要点则不新建', '关键历史事件须确已发生并改变地点意义']) expect(p.RULE_SCENES).toContain(rule);
    expect(p.RULE_SCENES).not.toContain('确需记入 desc,必须保留时间范围');
  });
  it('既有地点纠错不继续累积旧的临时或无据描述', () => {
    expect(p.RULE_SCENES).toContain('完整覆盖只保留仍成立的稳定要点和重要历史事件');
    expect(p.RULE_SCENES).toContain('清除错填的临时状态或无依据描述');
  });
  it('路径宁可短而有据，不为完整层级制造父级', () => {
    for (const rule of ['完整是指已证实的父子链,不是补齐世界地图', '缺少父级证据可独立记录地点',
      '在途且无法确认所属节点时给 []', '只有新的明确归属证据才 reparent']) expect(p.RULE_SCENES).toContain(rule);
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
    expect(p.RULE_SCENE_FOCUS).toContain('以本楼结束时的场面为准');
    expect(p.RULE_SCENE_FOCUS).toContain('远程联络、回忆和被提及不等于肉身在场');
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
    expect(p.RULE_SCENES).toContain('不以临时摆放物给地点增加固定设施');
    expect(p.SUMMARY_PROMPT).toContain('已证实父子链,允许独立地点');
  });
  it('结果复核覆盖补丁字段，紧预算删除命题而不是来源', () => {
    expect(p.SUMMARY_FACT_VERIFICATION).toContain('summary及每个状态字段');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('删除后是否改变事件结果、行动选择、有效限制或关系边界');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('装饰性图样、材质与普通保管动作');
  });
});
