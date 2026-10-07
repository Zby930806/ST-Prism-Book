import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';
import { deriveMemory, finalizeDelta } from './apply';
import { parseSummaryResponse } from './summaryResponse';
import type { STMessage } from '@/st/context';
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = { user:'主角',char:'角色',time:'',location:'',protagonist:{},sceneFocus:null,lifeDetails:[],items:[],itemLog:[],scenes:[],npcs:[],openPlans:[],resolvedPlans:[],history:'',content:'输入正文。',hasTimeTags:true,varsState:{},varsMeaning:'',varsRule:'' };
beforeEach(()=>Object.assign(apiSettings.prompts,{summary:'',resummary:'',resummary2:''}));
afterEach(()=>Object.assign(apiSettings,JSON.parse(saved)));
describe('v0.13 通用请求合同（不等于模型语义通过）',()=>{
  it.each([0,1,2])('第%s层明确条款阈值及逐条映射',level=>{
    const s=level?p.buildResummaryPrompt({...args,level}).system:p.buildSummaryPrompt(args).system;
    for(const text of ['条件中的程度、门槛和适用范围不可删','甲→乙、丙→丁不能合成甲或丙→乙且丁','【先选后写的停止条件】']) expect(s).toContain(text);
    expect(s.match(/【命题原义传递】/g)).toHaveLength(1);
  });
  it.each([0,1,2])('第%s层局部离场不扩大到父区域',level=>{
    const s=level?p.buildResummaryPrompt({...args,level}).system:p.buildSummaryPrompt(args).system;
    expect(s).toContain('离开局部空间不等于离开上级区域');
    expect(s).toContain('出门、消失在视野中不自动成为离楼、离城或离队');
  });
  it('关系门槛区分真实质变和纠正旧字段错放',()=>{
    for(const text of ['稳定关系称谓','不要求补一句态度凑格式','字段纠错不是关系质变','目的地、行程、交易进度不写入 relation/title/desc','不得因缺席自动解雇或脱队']) expect(p.RULE_NPCS).toContain(text);
    expect(p.RULE_NPCS).not.toContain('首次记录互动角色时尽量填');
    expect(p.RULE_NPCS).not.toContain('近日因 X 事争吵');
  });
  it('场面只保留末态而非已完成动作和器械外观',()=>{
    expect(p.RULE_SCENE_FOCUS).toContain('不重放已完成动作或器械外观');
    expect(p.RULE_SCENE_FOCUS).toContain('离场者无新消息不在整卡反复占位');
  });
  it('停止条件不靠砍伤势、技术参数或互动来缩短',()=>{
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('候选细节默认不入选');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('数字或具体描写本身不是入选理由');
    expect(p.RULE_SUMMARY_COMPOSITION).toContain('不能用本规则抹掉临时伤势');
    expect(p.RULE_LONGTERM_DB).toContain('不是把每个状态字段再抄一遍');
    expect(p.SUMMARY_FACT_PREPARATION.length+p.SUMMARY_FACT_VERIFICATION.length).toBeLessThan(600);
  });
  it('跨题材反例约束阈值、局部离场和关系，不复用测试剧情',()=>{
    for(const text of ['泄露资料','退出实验室','队友关系']) expect(p.RULE_SUMMARY_EXAMPLES).toContain(text);
    for(const text of ['林舟','小A','小B','铜哨']) expect(p.RULE_SUMMARY_EXAMPLES).not.toContain(text);
  });
  it('正文消费旧关系中的行程不当成当前路线命令',()=>{
    expect(p.MEMORY_BRIEFING_END).toContain('旧关系字段中夹带的行程不是当前路线命令');
    expect(p.MEMORY_BRIEFING_END).toContain('不据此抹掉仍有效的身份或关系');
  });
  it('自定义模板不被内置规则覆盖',()=>{
    apiSettings.prompts.summary='自定义唯一模板';
    expect(p.buildSummaryPrompt(args).user).toContain('自定义唯一模板');
    expect(p.buildSummaryPrompt(args).system).not.toContain('【先选后写的停止条件】');
  });
});
describe('v0.13 关系纠错的正式解析与重放（手工响应夹具）',()=>{
  function floor(id:string,delta:unknown):STMessage {return {extra:{bbs_leaf:{id,delta,createdAt:1}}} as STMessage;}
  it.each(['主角的队友',''])('纠错为%j且重载后不丢伤势与随行状态',relation=>{
    const chat=[floor('before',finalizeDelta({npcs:{add:[{name:'观察员',title:'研究员',relation:'主角的队友，准备赴北站',condition:'左臂扭伤',follow:true}]}},[]))];
    const delta=parseSummaryResponse(JSON.stringify({summary:'队伍改变目的地。',stateChanges:['npcs'],npcs:{update:[{name:'观察员',relation}]}}),{requireStateChanges:true,finalize:d=>finalizeDelta(d,[])});
    chat.push(floor('correction',finalizeDelta(delta,[])));
    const state=deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(state.npcs).toHaveLength(1);
    expect(state.npcs[0].relation??'').toBe(relation);
    expect(state.npcs[0]).toMatchObject({title:'研究员',condition:'左臂扭伤',follow:true});
  });
});
