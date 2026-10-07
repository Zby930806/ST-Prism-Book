import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = { user:'主角', char:'角色', time:'2041/5/9 08:00', location:'', protagonist:{}, sceneFocus:null, lifeDetails:[], items:[], itemLog:[], scenes:[], npcs:[], openPlans:[], resolvedPlans:[], history:'', content:'', hasTimeTags:true, varsState:{}, varsMeaning:'', varsRule:'' };
beforeEach(() => Object.assign(apiSettings.prompts, { summary:'', resummary:'', resummary2:'' }));
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
const cases = [
  { name:'补充条件不扩大另一后果', source:'[1] 泄密则取消后续合作。[2] 泄密或迟交则扣本次补贴。', rule:'旧条款未被明确替代就独立保留' },
  { name:'明确替代不能冻结旧条款', source:'[1] 迟到需补做值班。[2] 双方明确取消补班要求，改为书面说明。', rule:'明确撤销或替代的只更新对应条款' },
  { name:'范围歧义不反转', source:'负责人说：只影响以后的安排，先前交付照旧。', rule:'此前/以后、当次/后续、部分/全部逐词对照' },
  { name:'离场后不添旧位置', source:'[1] 队员说要留在宿舍养伤。[2] 主角离开后没有队员的新消息。', rule:'没有本次位置证据，就不在摘要末尾补写离场者仍在旧处' },
  { name:'无信息检查不占篇幅', source:'他检查袖扣与文件袋，文件没有变化；随后取消公路运输，决定改走铁路。', rule:'留下动作不等于留下信息' },
  { name:'了结不复述旧惩罚', source:'此前约定迟还设备会暂停借用资格。今天提前归还，管理员验收收下。', rule:'只写归还及验收结果，不附加一遍旧惩罚' },
];
describe('v0.17 通用三层修订合同（不代表模型语义通过）', () => {
  for (const level of [0,1,2]) for (const c of cases) it('L'+level+' '+c.name, () => {
    const result = level ? p.buildResummaryPrompt({...args,level,content:c.source}) : p.buildSummaryPrompt({...args,content:c.source});
    expect(result.user).toContain(c.source);
    expect(result.system).toContain(c.rule);
    expect(result.system).not.toMatch(/林舟|小A|小B|归雁|钟楼|铜哨/);
  });
  it('物品描述不复制完整义务，字段模板同步分工', () => {
    expect(p.RULE_ITEMS).toContain('desc 只保留识别、功能、当前可用状态和必要来源');
    expect(p.RULE_ITEMS).toContain('借用期限、违约后果交给 summary 与符合准入的 plans');
    expect(p.buildSummaryPrompt(args).system).toContain('不复制借用条款或违约后果');
  });
  it('计划更新入口给出完整替换而非交叉条件', () => {
    expect(p.RULE_PLANS).toContain('content 是完整替换文本，不是新增半句');
    expect(p.RULE_PLANS).toContain('按后果及适用对象逐条定位');
    expect(p.RULE_SUMMARY_EXAMPLES).toContain('更新后：泄露资料则终止后续合作；泄露资料或迟交则扣本次补贴');
  });
  it('压缩示范删除无信息动作但保留决定、临时限制和必要数字', () => {
    expect(p.RULE_SUMMARY_EXAMPLES).toContain('改为远程提交，尚未执行；手伤仍不能负重');
    expect(p.RULE_SUMMARY_EXAMPLES).toContain('低于四十单位才可启动');
    expect(p.RULE_SUMMARY_EXAMPLES).toContain('只示范取舍，不把动作细节改写成“确认无误”保留');
  });
  it('局势与摘要分工不是强制填满句子或字数', () => {
    expect(p.RULE_SCENE_FOCUS).toContain('能用一句表达就不补第二句');
    expect(p.RULE_SUMMARY_WRITE).toContain('不按输入长度等比例缩写');
    expect(p.RULE_SUMMARY_WRITE).toContain('没有最低篇幅任务');
  });
  it('核查明确查范围词与异地人物，仍不要求完整逐字段表', () => {
    for (const check of [p.buildSummaryThinking('主角').checklist, p.RESUMMARY_THINKING_CHECKLIST]) {
      expect(check).toContain('保留的每个后果能否在来源中找到相同触发条件');
      expect(check).toContain('离场者有无本次定位证据');
    }
    expect(p.RESUMMARY_THINKING_CHECKLIST).not.toMatch(/plans\.update|items\.add/);
  });
  it('自定义三层模板不强行加入本次内置改版', () => {
    Object.assign(apiSettings.prompts,{summary:'CUSTOM {{content}}',resummary:'CUSTOM {{content}}',resummary2:'CUSTOM {{content}}'});
    for(const result of [p.buildSummaryPrompt(args),...[1,2].map(level=>p.buildResummaryPrompt({...args,level}))]) {
      expect(result.user).toContain('CUSTOM');
      expect(result.system).not.toContain('留下动作不等于留下信息');
    }
  });
});
