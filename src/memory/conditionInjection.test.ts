import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { deriveMemory, classifyNpcPresence } from './apply';
import { buildStateInjectionText, refreshInjection } from './inject';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';
import { estimateTokens, slotBudget } from './budget';

const saved = JSON.stringify(apiSettings);
let seq = 0;
function message(delta: StoredDelta): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes: '正式记录', extra: {
    bbs_leaf: { id: 'condition-visibility-' + ++seq, text: '事件。', delta, createdAt: seq, swipe: 0, v: 1 },
  } };
}
function useChat(chat: STMessage[]) {
  const slots = new Map<string, string>();
  const ctx = { chat, chatMetadata: {}, getCurrentChatId: () => 'visibility',
    setExtensionPrompt: (key: string, value: string) => slots.set(key, value),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return slots;
}
function fixture(location = '观测站', important = false) {
  return [message({ time: '2042/5/6 10:00', location: '基地', scenes: { add: [
    { path: ['基地'], desc: '设施群' }, { path: ['基地', '医务室'], desc: '诊治用房' },
    { path: ['基地', '观测站'], desc: '观测用房' },
  ] }, npcs: { add: [{ name: '岑岚', location: '医务室', condition: '左腿骨折；不能负重',
    outfit: '紫色披风', desc: '银色长发', important }] } }), message({ location, locationPath: location === '观测站' ? ['基地', '观测站'] : [] })];
}
beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  apiSettings.summaryOnlyMode = false;
  apiSettings.memoryBudgetTokens = 6000;
  Object.assign(apiSettings.injection, { scenes: true, npcs: true });
});
afterEach(() => { Object.assign(apiSettings, JSON.parse(saved)); vi.restoreAllMocks(); });

describe('离场伤势的正式重放与状态注入', () => {
  it('未知位置的普通角色保留最后伤势，不补回在场或外貌装备', () => {
    const chat = fixture('外海航线'); useChat(chat);
    const text = buildStateInjectionText();
    expect(text).toContain('身体状态(最后记录):左腿骨折；不能负重');
    expect(text).toContain('当前位置未确认');
    expect(text).not.toContain('紫色披风'); expect(text).not.toContain('银色长发');
    expect(deriveMemory(chat).npcs[0].locationStale).toBe(true);
  });
  it('同区域但未照面的普通角色也保留行动限制', () => {
    const chat = fixture();
    chat.push(message({ npcs: { update: [{ name: '岑岚', location: '医务室' }] } }));
    useChat(chat);
    const s = deriveMemory(chat);
    expect(classifyNpcPresence(s.npcs[0], s.scenes, s.state.location, s.state.locationPath)).toBe('nearby');
    expect(buildStateInjectionText()).toContain('身体状态(最后记录):左腿骨折；不能负重');
  });
  it('经过多日不自动康复，正式刷新槽位消费同一条件', () => {
    const chat = [...fixture('外海航线'), message({ time: '2042/6/6 10:00' })];
    const slots = useChat(chat); refreshInjection();
    expect(slots.get('baibai_book_memory_state')).toContain('身体状态(最后记录):左腿骨折；不能负重');
    expect(slots.get('baibai_book_memory_state')).toContain('离场和时间流逝不是康复或恶化的证据');
  });
  it('后续有据更新或清空的存储结果替代旧伤势，不重新拼回历史', () => {
    const chat = [...fixture('外海航线'), message({ npcs: { update: [{ name: '岑岚', condition: '左腿仍疼；已可短距离行走' }] } })];
    useChat(chat);
    expect(buildStateInjectionText()).toContain('身体状态(最后记录):左腿仍疼；已可短距离行走');
    expect(buildStateInjectionText()).not.toContain('不能负重');
    chat.push(message({ npcs: { update: [{ name: '岑岚', condition: '' }] } })); recomputeDerived();
    expect(buildStateInjectionText()).not.toContain('身体状态(最后记录):');
  });
  it.each(['npcs', 'scenes', 'summaryOnly'] as const)('关闭%s时不绕过开关注入条件', key => {
    useChat(fixture('外海航线'));
    if (key === 'summaryOnly') apiSettings.summaryOnlyMode = true; else apiSettings.injection[key] = false;
    expect(buildStateInjectionText()).not.toContain('左腿骨折');
  });
  it.each([false, true])('在场/重要角色不重复附加离场字段 important=%s', important => {
    const chat = fixture('医务室', important); chat.pop();
    chat.push(message({ location: '医务室', npcs: { update: [{ name: '岑岚', location: '医务室' }] } })); useChat(chat);
    expect(buildStateInjectionText().match(/左腿骨折/g)).toHaveLength(1);
  });
  it('长条件受原预算约束，不按字符截断否定条件', () => {
    const chat = fixture('外海航线');
    chat.push(message({ npcs: { update: [{ name: '岑岚', condition: '未经检查不能负重；'.repeat(300) }] } }));
    useChat(chat); apiSettings.memoryBudgetTokens = 2000;
    const text = buildStateInjectionText();
    expect(estimateTokens(text)).toBeLessThanOrEqual(slotBudget('state'));
    expect(text).not.toContain('未经检查不能负重');
  });
});
