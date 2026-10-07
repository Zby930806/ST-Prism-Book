import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';
import { renderSourceHints } from './sourceHints';
const saved=JSON.stringify(apiSettings);
const args:Parameters<typeof p.buildSummaryPrompt>[0]={user:'主角',char:'角色',time:'',location:'',protagonist:{},sceneFocus:null,lifeDetails:[],items:[],itemLog:[],scenes:[],npcs:[],openPlans:[],resolvedPlans:[],history:'',content:'实际输入。',hasTimeTags:true,varsState:{},varsMeaning:'',varsRule:''};
beforeEach(()=>Object.assign(apiSettings.prompts,{summary:'',resummary:'',resummary2:''}));
afterEach(()=>Object.assign(apiSettings,JSON.parse(saved)));
describe('v0.14 保真操作与信息取舍合同（不等于模型语义实测）',()=>{
  it.each([0,1,2])('第%s层优先复制关键限定而不是逐字段自由改述',level=>{
    const s=level?p.buildResummaryPrompt({...args,level}).system:p.buildSummaryPrompt(args).system;
    expect(s.match(/【关键短语保真】/g)).toHaveLength(1);
    for(const text of ['先从材料复制关键短语','禁止凭记忆另写一套近义表述','条件、对象、后果与时段作为一组','同一原句的限定不能在另一个字段里消失']) expect(s).toContain(text);
  });
  it.each([0,1,2])('第%s层未知空间宁可粗略不补地图',level=>{
    const s=level?p.buildResummaryPrompt({...args,level}).system:p.buildSummaryPrompt(args).system;
    expect(s).toContain('方位词必须连同被修饰对象和参照物一起取自材料');
    expect(s).toContain('不能用城市常识、地名中的方向字或行进目标补出所在方位');
  });
  it('精简不靠删伤势/阈值，末态快照不复写全程',()=>{
    expect(p.RULE_SUMMARY_WRITE).toContain('不是详写原文的缩小版');
    expect(p.RULE_SCENE_FOCUS).toContain('能用一句表达就不补第二句');
    expect(p.RULE_SCENE_FOCUS).toContain('已经结束且不再限制下一步的过程不重播');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('不能用本规则抹掉临时伤势');
    expect(p.RULE_FACT_TRANSFER).toContain('条件中的程度、门槛和适用范围不可删');
  });
  it('三种最终核查先回源对词再删冗余，无新输出schema',()=>{
    for(const s of [p.buildSummaryThinking('测试者').checklist,p.RESUMMARY_THINKING_CHECKLIST]){
      expect(s).toContain('回源对词：时段、程度、方位保留原限定');
      expect(s).toContain('再删无结果的检查与收纳');
    }
    expect(p.RESUMMARY_THINKING_CHECKLIST.length).toBeLessThan(1300);
    expect(p.SUMMARY_FACT_PREPARATION.length+p.SUMMARY_FACT_VERIFICATION.length).toBeLessThan(600);
  });
  it('三种自定义模板保留且不被新内置写法替代',()=>{
    Object.assign(apiSettings.prompts,{summary:'自定义单楼 {{content}}',resummary:'自定义一级 {{content}}',resummary2:'自定义高层 {{content}}'});
    for(const [i,s] of [p.buildSummaryPrompt(args),p.buildResummaryPrompt({...args,level:1}),p.buildResummaryPrompt({...args,level:2})].entries()){
      expect(s.user).toContain(['自定义单楼','自定义一级','自定义高层'][i]);
      expect(s.system).not.toContain('【关键短语保真】');
    }
  });
});
describe('v0.14 原文提醒仅索引，不复制整段或代替完整正文',()=>{
  it.each([
    {name:'约定',text:'负责人说：迟交超过三天扣当期津贴；泄密取消以后的合作。'},
    {name:'伤势',text:'她仍然无法抬起左臂，但脚踝已经恢复。'},
    {name:'科幻',text:'Only signals above 40 dB can open the outer gate.'},
  ])('$name保留来源标识、不抽取或改写条款',({text})=>{
    const x=renderSourceHints([{source:'[M4-P8]',text}]);
    expect(x).toContain('[M4-P8]');
    expect(x).not.toContain(text);
    expect(x).toContain('只是回查索引');
    expect(x).toContain('不能据索引替代完整原文');
  });
  it('五千字的单段在提醒中只留原段号，不扩大输入',()=>{
    const x=renderSourceHints([{source:'[12]',text:'此前'+ '描写'.repeat(2500)}]);
    expect(x).toContain('[12]');
    expect(x.length).toBeLessThan(400);
    expect(x).not.toContain('描写');
  });
  it('重复正文的不同来源仍各可定位，不合并跨时段证据',()=>{
    const x=renderSourceHints([{source:'[M1-P2]',text:'至少等待三天。'},{source:'[M5-P2]',text:'至少等待三天。'}]);
    expect(x.split('[M1-P2]')).toHaveLength(2);
    expect(x.split('[M5-P2]')).toHaveLength(2);
    expect(x).not.toContain('至少等待三天。');
  });
});
