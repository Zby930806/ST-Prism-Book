import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { deriveMemory, editNpc, finalizeDelta } from './apply';
import { buildStateInjectionText } from './inject';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';
const saved=JSON.stringify(apiSettings);
let seq=0;
const floor=(delta:StoredDelta):STMessage=>({name:'角色',is_user:false,is_system:false,mes:'测试正文。',extra:{bbs_leaf:{id:'profile-fix-'+ ++seq,text:'测试摘要。',delta,createdAt:seq,swipe:0,v:1}}});
function fixture(){return [floor({location:'研究基地',npcs:{add:[{name:'观察员',title:'研究员',relation:'主角的队友，准备赴北站',condition:'左臂扭伤',follow:true}]}})];}
function useChat(chat:STMessage[]){
  const ctx={chat,chatMetadata:{},name1:'主角',name2:'角色',getCurrentChatId:()=> 'profile-fix-test',saveChat:vi.fn().mockResolvedValue(undefined),saveMetadataDebounced:vi.fn(),saveMetadata:vi.fn().mockResolvedValue(undefined)} as unknown as STContext;
  vi.spyOn(context,'getContext').mockReturnValue(ctx); recomputeDerived(); return ctx;
}
beforeEach(()=>{vi.useFakeTimers();Object.assign(memory,createEmptyMemory());apiSettings.summaryOnlyMode=false;apiSettings.memoryBudgetTokens=6000;apiSettings.vector.enabled=false;apiSettings.injection.npcs=true;});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();Object.assign(apiSettings,JSON.parse(saved));Object.assign(memory,createEmptyMemory());});
describe('v0.13 档案纠错的正式消费及手动入口（隔离内存宿主）',()=>{
  it.each(['relation','title'] as const)('%s 空串从重放进入正文注入且不清除其他字段',field=>{
    const chat=fixture();chat.push(floor(finalizeDelta({npcs:{update:[{name:'观察员',[field]:''}]}},[])));useChat(JSON.parse(JSON.stringify(chat)));
    expect(memory.npcs[0][field]).toBeUndefined();
    const sent=buildStateInjectionText();expect(sent).toContain('左臂扭伤');
    expect(sent).not.toContain(field==='relation'?'准备赴北站':'研究员');
    expect(memory.npcs[0].follow).toBe(true);
  });
  it('手动清除两个错填字段保存空补丁，序列化重载不复活',()=>{
    const chat=fixture();useChat(chat);expect(editNpc('观察员',{relation:'',title:''})).toBe(true);
    const state=deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(state.npcs[0].relation).toBeUndefined();expect(state.npcs[0].title).toBeUndefined();expect(state.npcs[0].condition).toBe('左臂扭伤');
  });
  it('手动仅改名继承稳定关系与身份，不误删未知字段',()=>{
    const chat=fixture();useChat(chat);expect(editNpc('观察员',{name:'记录员'})).toBe(true);
    const state=deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(state.npcs).toHaveLength(1);expect(state.npcs[0]).toMatchObject({name:'记录员',relation:'主角的队友，准备赴北站',title:'研究员',condition:'左臂扭伤'});
  });
  it('普通更新不自动按关键词删掉旧关系中的行程',()=>{
    const chat=fixture();chat.push(floor(finalizeDelta({npcs:{update:[{name:'观察员',outfit:'灰色大衣'}]}},[])));
    expect(deriveMemory(chat).npcs[0]).toMatchObject({relation:'主角的队友，准备赴北站',title:'研究员',outfit:'灰色大衣'});
  });
  it.each([{label:'null',value:null},{label:'缺省',value:undefined},{label:'对象',value:{}},{label:'数组',value:[]}])('非法或缺省文本$label不当成清空',({value})=>{
    const chat=fixture();chat.push(floor(finalizeDelta({npcs:{update:[{name:'观察员',relation:value,title:value}]}} as unknown as StoredDelta,[])));
    expect(deriveMemory(chat).npcs[0]).toMatchObject({relation:'主角的队友，准备赴北站',title:'研究员'});
  });
});
