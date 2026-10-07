import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';
const saved=JSON.stringify(apiSettings);
const args:Parameters<typeof p.buildSummaryPrompt>[0]={user:'主角',char:'角色',time:'2040/6/8 08:00',location:'',protagonist:{},sceneFocus:null,lifeDetails:[],items:[],itemLog:[],scenes:[],npcs:[],openPlans:[],resolvedPlans:[],history:'',content:'',hasTimeTags:true,varsState:{},varsMeaning:'',varsRule:''};
beforeEach(()=>Object.assign(apiSettings.prompts,{summary:'',resummary:'',resummary2:''}));
afterEach(()=>Object.assign(apiSettings,JSON.parse(saved)));
const fixtures=[
 {name:'科研条款',content:'[1] 泄露数据会终止后续合作。[2] 泄露数据或迟交超过三日会取消本次补贴。',rule:'共享条件不代表共享后果'},
 {name:'星际通行',content:'[1] 舱门只开一半，须侧身通过；辐射低于40才可停留。[2] 小队决定放弃原通道，改走检修桥。',rule:'改变行动方向的决定'},
 {name:'生活并列',content:'[1] 午后有维修人员进楼，她在家等一位朋友。',rule:'同句并列不证明同行、归属或因果'},
 {name:'本段时点',content:'[1] (2040/6/8 08:15 – 2040/6/8 08:35) 两人离开车站。',rule:'段落起止是范围，不是每个事件的发生时刻'},
];
describe('v0.15 三层通用请求合同（仅验证指令与材料传递，不代表模型理解）',()=>{
 for(const level of [0,1,2]) for(const f of fixtures) it('L'+level+' '+f.name,()=>{
   const built=level?p.buildResummaryPrompt({...args,level,content:f.content}):p.buildSummaryPrompt({...args,content:f.content});
   expect(built.user).toContain(f.content);
   expect(built.system).toContain(f.rule);
   expect(built.system).toContain('最小合并单位是完整命题');
   expect(built.system).toContain('不要求沿用含糊的交易用语');
   expect(built.system).not.toMatch(/林舟|小A|小B|归雁|钟楼/);
 });
 it('单楼不受长期计划准入门槛限制，快照不重复下一步',()=>{
   expect(p.RULE_SUMMARY_WRITE).toContain('即时决定即使不够资格新增长期计划，也须进入摘要');
   expect(p.RULE_SCENE_FOCUS).toContain('pendingBeat 不重复 situation');
   expect(p.RULE_PLANS).toContain('先逐条修改完整条款，再组合成 content');
 });
 it('总结按事件链重建而不是摘要逐段缩写',()=>{
   const s=p.buildResummaryPrompt({...args,level:1}).system;
   expect(s).toContain('【总结流程：按事项重组】');
   expect(s).toContain('同一事项先保留初始目标、改变决定的依据与最后结果');
   expect(s).not.toContain('同一天内的首个事件标明完整日期与时间');
   expect(s).not.toContain('沿用某段括注的起始时间');
 });
 it('二次总结有独立阶段化取舍，临时伤势与否定不丢',()=>{
   const s=p.buildResummaryPrompt({...args,level:2}).system;
   expect(s).toContain('【二次总结流程：阶段与有效后果】');
   expect(s).toContain('临时但尚未解除的伤势或限制仍属有效后果');
   expect(s).toContain('每个阶段只保留改变走向的节点与必要的代表性互动');
   expect(s).toContain('不能把尚未执行的方案写成经历');
 });
 it('最终检查同步语义关系而非只核对字词',()=>{
   for(const s of [p.buildSummaryThinking('测试者').checklist,p.RESUMMARY_THINKING_CHECKLIST]){
     expect(s).toContain('检查条件与后果是否仍逐条对应');
     expect(s).toContain('行动转变与有效限制是否被装饰细节挤掉');
   }
 });
});
