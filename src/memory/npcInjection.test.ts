import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { BUDGET_NOTICE, estimateTokens, slotBudget } from './budget';
import { ABSENT_NPC_CHUNK, ABSENT_NPC_LIMIT, buildStateInjectionText, fmtNpcContextBlocks } from './inject';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type MemNpc, type StoredDelta } from './types';

// 发给正文模型的人物三段:主角、主要角色、NPC 名册;只检查注入文本,不代表正文模型的表现。
const saved = JSON.stringify(apiSettings);
let seq = 0;
const leaf = (delta: StoredDelta): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: '正文。',
  extra: { bbs_leaf: { id: 'inj-' + ++seq, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } as LeafExtra } });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '沈遥', name2: '角色', getCurrentChatId: () => 'inject-tiers' } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
}
const scene = (): StoredDelta => ({ time: '2031/5/8 20:00', location: '酒馆', locationPath: ['港口', '酒馆'],
  scenes: { add: [{ path: ['港口'], desc: '港城' }, { path: ['港口', '酒馆'], desc: '酒馆' }, { path: ['港口', '码头'], desc: '码头' }, { path: ['王都'], desc: '远方' }] } });

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  apiSettings.summaryOnlyMode = false;
  apiSettings.memoryBudgetTokens = 6000;
  Object.assign(apiSettings.injection, { scenes: true, npcs: true, protagonist: true, npcAffinity: true, injuryReminder: true });
});
afterEach(() => { Object.assign(apiSettings, JSON.parse(saved)); vi.restoreAllMocks(); });

describe('人物分三段注入', () => {
  it('主角、主要角色、NPC 名册各成一段,顺序固定', () => {
    useChat([leaf({ ...scene(), protagonist: { identity: '旅行者' }, npcs: { add: [
      { name: '洛伊', important: true, title: '领航员', follow: true },
      { name: '酒保A', title: '酒保', location: '酒馆' },
    ] } })]);
    const text = buildStateInjectionText();
    const order = ['[主角当前状态]', '[主要角色]', '[NPC名册]'].map(h => text.indexOf(h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.slice(text.indexOf('[主要角色]'), text.indexOf('[NPC名册]'))).not.toContain('酒保A');
  });
  it('主要角色有记录时附外貌与性格,不论在场与否', () => {
    useChat([leaf({ ...scene(), npcs: { add: [{ name: '洛伊', important: true, title: '领航员', desc: '银灰短发,左眉有疤', personality: '谨慎寡言', location: '王都' }] } })]);
    const text = buildStateInjectionText();
    expect(text).toContain('洛伊(领航员) —— 外貌:银灰短发,左眉有疤;性格:谨慎寡言');
  });
  it('NPC 在场发完整信息(含外貌),无名角色在场也发', () => {
    useChat([leaf({ ...scene(), npcs: { add: [{ name: '酒保A', title: '酒保', desc: '络腮胡', location: '酒馆' }] } })]);
    const text = buildStateInjectionText();
    expect(text).toContain('[NPC名册]');
    expect(text).toContain('酒保A(酒保) —— 络腮胡');
  });
  it('不在场:有名字的保留一行,「职业 + 字母」的不发', () => {
    useChat([leaf({ ...scene(), npcs: { add: [
      { name: '梅芙', title: '修表师', desc: '红发', location: '王都', condition: '右臂轻伤' },
      { name: '守卫B', title: '城门守卫', desc: '高个', location: '王都' },
      { name: '小A', title: '学徒', location: '王都' },
    ] } })]);
    const text = buildStateInjectionText();
    expect(text).toContain('[NPC名册·其他已知角色]');
    expect(text).toContain('  - 梅芙(修表师) [在:王都] 身体状态(最后记录):右臂轻伤');
    expect(text).not.toContain('红发');
    expect(text).not.toContain('守卫B');
    // 「小A」这类常见名字不按标签处理
    expect(text).toContain('小A(学徒)');
  });
});

describe('不在场名单的人数上限与预算', () => {
  const crowd = (count: number): STMessage[] => [leaf(scene()), ...Array.from({ length: count }, (_, i) => leaf({ npcs: { add: [{ name: `旅人${String(i).padStart(2, '0')}号`, title: '过路客商', location: '王都' }] } }))];
  it(`按最近出场列出前 ${ABSENT_NPC_LIMIT} 人,其余只说明数量;每 ${ABSENT_NPC_CHUNK} 行一个预算单元`, () => {
    useChat(crowd(30));
    const blocks = fmtNpcContextBlocks(memory.npcs, memory.scenes, memory.state.location, memory.state.locationPath, memory.state.time);
    const lines = blocks.absent.join('\n').split('\n').filter(l => l.startsWith('  - '));
    expect(lines).toHaveLength(ABSENT_NPC_LIMIT);
    expect(lines[0]).toContain('旅人29号');
    expect(blocks.absent.join('\n')).not.toContain('旅人05号');
    expect(blocks.absent.join('\n')).toContain('另有 6 位较久未出场的角色未列出');
    expect(blocks.absent).toHaveLength(Math.ceil((ABSENT_NPC_LIMIT + 1) / ABSENT_NPC_CHUNK));
    expect(blocks.absent[1].startsWith('[NPC名册·其他已知角色(续)]')).toBe(true);
  });
  it('预算紧张时先省略不在场名单的块,计划与在场角色保留', () => {
    apiSettings.memoryBudgetTokens = 2000;
    const chat = crowd(30);
    chat.push(leaf({ npcs: { add: [{ name: '洛伊', important: true, title: '领航员' }] }, plans: { add: [{ kind: 'plan', content: '入夜后去钟塔核实署名。' }] } }));
    useChat(chat);
    const text = buildStateInjectionText();
    expect(estimateTokens(text)).toBeLessThanOrEqual(slotBudget('state'));
    expect(text).toContain('入夜后去钟塔核实署名');
    expect(text).toContain('洛伊(领航员)');
    expect(text).toContain(BUDGET_NOTICE);
  });
  it('近期正文提到名字或旧名的不在场角色不受人数上限限制,排在最前', () => {
    const chat = crowd(30);
    chat[1].extra!.bbs_leaf!.delta.npcs!.add![0].formerNames = ['船工A'];
    chat.push({ name: '沈遥', is_user: true, is_system: false, mes: '还记得旅人01号和那个船工A吗?' });
    useChat(chat);
    const blocks = fmtNpcContextBlocks(memory.npcs, memory.scenes, memory.state.location, memory.state.locationPath, memory.state.time, { mentionText: chat.at(-1)!.mes });
    const lines = blocks.absent.join('\n').split('\n').filter(l => l.startsWith('  - '));
    expect(lines).toHaveLength(ABSENT_NPC_LIMIT);
    // 被提到的(含按旧名提到的)按最近出场排在最前,其余仍按最近出场补足
    expect(lines[0]).toContain('旅人01号');
    expect(lines[1]).toContain('旅人00号');
    expect(lines[2]).toContain('旅人29号');
    expect(blocks.absent.join('\n')).toContain('另有 6 位较久未出场的角色未列出');
    // 状态注入用最近几楼的正文判断
    expect(buildStateInjectionText()).toContain('旅人01号');
  });
  it('摘要模式与 NPC 名册开关照旧生效', () => {
    useChat([leaf({ ...scene(), npcs: { add: [{ name: '洛伊', important: true, desc: '银灰短发' }] } })]);
    apiSettings.injection.npcs = false;
    expect(buildStateInjectionText()).not.toContain('银灰短发');
    apiSettings.injection.npcs = true;
    apiSettings.summaryOnlyMode = true;
    expect(buildStateInjectionText()).toBe('');
  });
});

describe('旧数据兼容', () => {
  it('旧聊天的 important 标记照旧是主要角色,其余进 NPC 名册,不需要重建', () => {
    const old: MemNpc[] = [];
    useChat([leaf({ ...scene(), npcs: { add: [{ name: '旧主角团成员', important: true, title: '剑士' }, { name: '旧配角', title: '店主', location: '酒馆' }] } })]);
    old.push(...memory.npcs);
    expect(old.find(n => n.name === '旧主角团成员')?.important).toBe(true);
    const text = buildStateInjectionText();
    expect(text.indexOf('旧主角团成员')).toBeGreaterThan(text.indexOf('[主要角色]'));
    expect(text.indexOf('旧配角')).toBeGreaterThan(text.indexOf('[NPC名册]'));
  });
});

describe('地点信息拆成两个预算单元', () => {
  it('当前所在放在前面,其他已知地点排在不在场角色之后、变量之前', () => {
    useChat([leaf({ ...scene(), npcs: { add: [{ name: '梅芙', title: '修表师', location: '王都' }] }, varOps: [{ op: 'set', path: '金币', value: 5 }] })]);
    const text = buildStateInjectionText();
    const current = text.indexOf('当前所在(由大到小):港口(港城) › 酒馆(酒馆)');
    const others = text.indexOf('其他已知地点(仅列名称):');
    expect(current).toBeGreaterThan(0);
    expect(current).toBeLessThan(text.indexOf('未了结的计划/悬念'));
    expect(others).toBeGreaterThan(text.indexOf('[NPC名册·其他已知角色]'));
    expect(others).toBeLessThan(text.indexOf('自定义变量'));
  });
  it('预算紧张时先省略其他地点的长列表,当前所在保留', () => {
    apiSettings.memoryBudgetTokens = 2000;
    const many = Array.from({ length: 300 }, (_, i) => ({ path: ['王都', `第${i}号仓库区`], desc: '仓库' }));
    useChat([leaf({ ...scene(), scenes: { add: [...scene().scenes!.add!, ...many] } })]);
    const text = buildStateInjectionText();
    expect(estimateTokens(text)).toBeLessThanOrEqual(slotBudget('state'));
    expect(text).toContain('当前所在(由大到小):港口(港城) › 酒馆(酒馆)');
    expect(text).not.toContain('第299号仓库区');
    expect(text).toContain(BUDGET_NOTICE);
  });
});
