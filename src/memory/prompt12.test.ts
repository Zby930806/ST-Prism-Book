import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';
import { deriveMemory, finalizeDelta } from './apply';
import { parseSummaryResponse } from './summaryResponse';
import type { STMessage } from '@/st/context';
import type { MemPlan } from './types';
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = { user:'主角', char:'角色', time:'', location:'', protagonist:{}, sceneFocus:null, lifeDetails:[], items:[], itemLog:[], scenes:[], npcs:[], openPlans:[], resolvedPlans:[], history:'', content:'输入正文。', hasTimeTags:true, varsState:{}, varsMeaning:'', varsRule:'' };
beforeEach(() => Object.assign(apiSettings.prompts, {summary:'',resummary:'',resummary2:''}));
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
function parse(plans: unknown, before: MemPlan[]) {
  return finalizeDelta(parseSummaryResponse(JSON.stringify({summary:'安排发生调整。',stateChanges:['plans'],plans}), {requireStateChanges:true,finalize:d=>finalizeDelta(d,before)}), before);
}
function floor(id: string, delta: unknown): STMessage { return {extra:{bbs_leaf:{id,delta,createdAt:1}}} as STMessage; }
function seed() { return [floor('origin', finalizeDelta({plans:{add:[{kind:'plan',content:'工程队待许可后检修设备',targetTime:'周二'},{kind:'plan',content:'档案员递交报告'}]}},[]))]; }
describe('v0.12 跨字段与取舍请求合同（非模型语义测试）',()=>{
  it.each([0,1,2])('第%s层来源、条款范围和概率程度同源', level=>{
    const s=level?p.buildResummaryPrompt({...args,level}).system:p.buildSummaryPrompt(args).system;
    for(const clause of ['【命题原义传递】','把来源和限定随命题一起复制','此前/此后、已发生/将发生不可互换','极可能不能降成可能','没有提供具体参数的核对/检查不算新增情报','历史衣着若不用于识别或对照则删']) expect(s).toContain(clause);
    expect(s.match(/【命题原义传递】/g)).toHaveLength(1);
  });
  it('局势卡示意不再诱导把多来源压成单一确认',()=>{
    expect(p.SUMMARY_PROMPT).toContain('末态行动/阻碍;口述与判断各带来源,不合并背书');
    expect(p.RULE_SCENE_FOCUS).toContain('无需复述沿途全部情报');
  });
  it('旧计划先对账，暂缓与被替代不混为同一种结案',()=>{
    for(const clause of ['每楼先核对旧条目,再考虑新增','同一事项改期、暂缓或改变执行条件','plans.update','替代旧方案且不再执行旧方案','未定期限用空字符串清除']) expect(p.RULE_PLANS).toContain(clause);
    expect(p.RULE_PLANS).not.toContain('彻底不可能再发生');
  });
  it('地点先删除临时修饰，再判断是否值得建档',()=>{
    expect(p.RULE_SCENES).toContain('先去掉临时修饰再判断准入');
    expect(p.RULE_SCENES).toContain('一次停留不证明长期用途或容量');
  });
});
describe('v0.12 计划调整的正式解析与重放',()=>{
  it('短编号固化稳定ID，暂缓与取消后重新编号仍更新正确事项',()=>{
    const chat=seed(); const before=deriveMemory(chat).plans;
    const d=parse({update:[{id:'p1',content:'工程队暂缓检修设备，待许可后另定日期',targetTime:''}],resolve:[{id:'p2',outcome:'cancelled',reason:'报告已撤回，无需递交'}]},before);
    expect(d.plans?.update?.[0].id).toBe(before[0].id);
    chat.push(floor('delay',d)); const reloaded=deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(reloaded.plans[0]).toMatchObject({id:before[0].id,status:'open',content:'工程队暂缓检修设备，待许可后另定日期'});
    expect(reloaded.plans[0].targetTime).toBeUndefined();
    expect(reloaded.plans[1].status).toBe('resolved');
    const resumed=parse({update:[{id:'p1',content:'许可已获批，工程队于周五检修设备',targetTime:'周五'}]},reloaded.plans.filter(x=>x.status==='open'));
    chat.push(floor('resume',resumed));
    expect(deriveMemory(chat).plans[0]).toMatchObject({id:before[0].id,status:'open',targetTime:'周五'});
    expect(deriveMemory(chat).plans).toHaveLength(2);
  });
  it('前一条结案后p2变p1仍指向原事项，不污染已结案历史',()=>{
    const chat=seed(); const before=deriveMemory(chat).plans;
    chat.push(floor('first-close',parse({resolve:[{id:'p1',outcome:'done',reason:'检修完成'}]},before)));
    const open=deriveMemory(chat).plans.filter(p=>p.status==='open');
    const update=parse({update:[{id:'p1',content:'档案员改为线上递交报告'}]},open);
    expect(update.plans?.update?.[0].id).toBe(before[1].id);
    chat.push(floor('report-change',update));
    expect(deriveMemory(chat).plans[0]).toMatchObject({content:before[0].content,status:'resolved'});
    expect(deriveMemory(chat).plans[1].content).toBe('档案员改为线上递交报告');
  });
  it('只有摘要关键词不自动猜出取消或暂缓操作',()=>{
    const chat=seed(); const before=deriveMemory(chat).plans;
    const delta=parseSummaryResponse(JSON.stringify({summary:'他们讨论取消原安排，尚未决定。',stateChanges:[]}),{requireStateChanges:true,finalize:d=>finalizeDelta(d,before)});
    chat.push(floor('discussion',finalizeDelta(delta,before)));
    expect(deriveMemory(chat).plans).toEqual(before);
  });
  it('省略目标时间保留原期限，未知ID及已结案存储操作不创建或改写计划',()=>{
    const chat=seed(); const before=deriveMemory(chat).plans;
    chat.push(floor('change',parse({update:[{id:'p1',content:'工程队待许可后检修设备，新增断电要求'}]},before)));
    expect(deriveMemory(chat).plans[0].targetTime).toBe('周二');
    chat.push(floor('close',parse({resolve:[{id:'p1',outcome:'done',reason:'检修已完成'}]},deriveMemory(chat).plans)));
    chat.push(floor('stale',{plans:{update:[{id:before[0].id,content:'不应改写'},{id:'missing',content:'不应新建'}]}}));
    expect(deriveMemory(chat).plans[0].content).toContain('新增断电要求');
    expect(deriveMemory(chat).plans).toHaveLength(2);
  });
  it.each([{id:'p9',content:'未知编号'},{id:'p1',content:''},{id:'p1',content:{text:'非法对象'}},{id:'p1',content:'改期',targetTime:null}])('无效调整触发重试而非静默丢字段: %j', entry=>{
    expect(()=>parse({update:[entry]},deriveMemory(seed()).plans)).toThrow();
  });
  it('同一ID重复调整或同时结案拒绝歧义操作',()=>{
    const before=deriveMemory(seed()).plans;
    expect(()=>parse({update:[{id:'p1',content:'暂缓'},{id:'p1',content:'继续'}]},before)).toThrow();
    expect(()=>parse({update:[{id:'p1',content:'暂缓'}],resolve:[{id:'p1',outcome:'cancelled',reason:'撤销'}]},before)).toThrow();
  });
});
