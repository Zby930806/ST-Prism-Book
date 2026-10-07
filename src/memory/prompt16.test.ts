import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = { user:'主角', char:'角色', time:'2040/6/8 08:00', location:'', protagonist:{}, sceneFocus:null, lifeDetails:[], items:[], itemLog:[], scenes:[], npcs:[], openPlans:[], resolvedPlans:[], history:'', content:'', hasTimeTags:true, varsState:{}, varsMeaning:'', varsRule:'' };
beforeEach(() => Object.assign(apiSettings.prompts, { summary:'', resummary:'', resummary2:'' }));
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
const cases = [
  { name:'适用范围与歧义', text:'损坏封签则以后的往来全部作废；此前交付未受影响。', rule:'歧义未消除时只保留必要原话和限定' },
  { name:'对象与方位', text:'大厅中央是临时展台，固定楼梯位于大厅边缘。', rule:'中央的展台、边缘的楼梯不能互换位置' },
  { name:'范围与动作时间', text:'[1] (2040/6/8 09:10 – 2040/6/8 09:40) 她收起文件离开。', rule:'范围端点不分配给动作' },
  { name:'结果与有效限制', text:'队员反复检查搭扣后决定改走栈桥；脚踝扭伤仍不能负重。', rule:'先确定共用事实，再分发到摘要和必要状态字段' },
];
describe('v0.16 请求合同（不代表模型语义通过）', () => {
  for (const level of [0,1,2]) for (const c of cases) it('L'+level+' '+c.name, () => {
    const result = level ? p.buildResummaryPrompt({...args,level,content:c.text}) : p.buildSummaryPrompt({...args,content:c.text});
    expect(result.user).toContain(c.text);
    expect(result.system).toContain(c.rule);
    expect(p.SUMMARY_TASK_ORDER).toBeTypeOf('string');
    expect(result.system.split(p.SUMMARY_TASK_ORDER)).toHaveLength(2);
    expect(result.system.indexOf(p.SUMMARY_TASK_ORDER)).toBeLessThan(result.system.indexOf('【压缩保真】'));
    expect(result.system).not.toMatch(/林舟|小A|小B|归雁|钟楼/);
  });
  it('系统、核查和预填充遵循同一事实优先顺序', () => {
    const result = p.buildSummaryPrompt(args);
    expect(result.system.indexOf(p.SUMMARY_TASK_ORDER)).toBeLessThan(result.system.indexOf('"summary":'));
    const { checklist, prefill } = p.buildSummaryThinking(args.user);
    expect(checklist.indexOf(p.SUMMARY_FACT_PREPARATION)).toBeLessThan(checklist.indexOf('档案与快照分工'));
    expect(prefill).toContain('先确定共用事实');
    expect(prefill).not.toContain('再整理摘要');
    expect(checklist).toContain('横向核对同一事实');
    expect(checklist.indexOf('横向核对同一事实')).toBeGreaterThan(checklist.indexOf('档案与快照分工'));
  });
  it('时间标签协议口禁止端点摊派并保留冲突', () => {
    expect(p.TIME_RULE_WITH_TAGS).toContain('范围端点不分配给动作');
    expect(p.TIME_RULE_WITH_TAGS).toContain('标签与正文冲突时不擅自选一方');
    expect(p.buildSummaryPrompt({...args,hasTimeTags:false}).system).toContain('范围端点不分配给动作');
  });
  it('快照去重与字段示范一致，不重播来路', () => {
    expect(p.RULE_SCENE_FOCUS).toContain('situation 只写末态，不重述到达末态的经过');
    expect(p.RULE_SCENE_FOCUS).toContain('pendingBeat 不重复 situation');
    expect(p.buildSummaryPrompt(args).system).toContain('独立于 situation 的明确后续事项；重复则省略');
    expect(p.RULE_SCENE_FOCUS).toContain('整卡覆盖');
    expect(p.RULE_SCENE_FOCUS).toContain('所见写所见,口述写“某人称”,判断写“某人认为/估计”');
  });
  it('组织指令用中性记录词，总结核查不混入状态操作', () => {
    for (const result of [p.buildSummaryPrompt(args), ...[1,2].map(level => p.buildResummaryPrompt({...args,level}))]) {
      expect(result.system + result.user).not.toMatch(/账本|记账|旧账|对账|已结算的账|算过的账/);
    }
    expect(p.RESUMMARY_THINKING_CHECKLIST).not.toMatch(/pendingBeat|situation/);
    expect(p.RESUMMARY_THINKING_CHECKLIST).toContain('合并前后是否仍绑定原对象');
    expect(p.RULE_NPCS).toContain('不能把“账目了结”改成“已付余款”');
  });
  it('不把新内置组织方式强加到自定义三层模板', () => {
    Object.assign(apiSettings.prompts, {summary:'CUSTOM {{content}}',resummary:'CUSTOM {{content}}',resummary2:'CUSTOM {{content}}'});
    for (const result of [p.buildSummaryPrompt(args), ...[1,2].map(level => p.buildResummaryPrompt({...args,level}))]) {
      expect(result.user).toContain('CUSTOM');
      expect(result.system + result.user).not.toContain(p.SUMMARY_TASK_ORDER);
    }
  });
});
