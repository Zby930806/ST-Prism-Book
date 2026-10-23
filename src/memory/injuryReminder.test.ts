import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { deriveMemory, editNpc } from './apply';
import { buildStateInjectionText } from './inject';
import { fmtInjuryReminder, injuryElapsed, INJURY_DAY_LEVELS, INJURY_FLOOR_LEVELS, INJURY_REMINDER_TAIL } from './injuryReminder';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type StoredDelta } from './types';

// 伤势进展提醒只改发给正文模型的文字,不改记录;这里检查锚点、阈值与重置,不代表正文模型的写法。
const saved = JSON.stringify(apiSettings);
let seq = 0;
const leaf = (delta: StoredDelta, time?: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: '正文。',
  extra: { bbs_leaf: { id: 'injury-' + ++seq, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1, ...(time ? { timeEnd: time } : {}) } as LeafExtra } });
const user = (): STMessage => ({ name: '沈遥', is_user: true, is_system: false, mes: '继续。' });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '沈遥', name2: '角色', getCurrentChatId: () => 'injury',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
}
const scene = (): StoredDelta => ({ location: '医务室', locationPath: ['基地', '医务室'],
  scenes: { add: [{ path: ['基地'], desc: '设施' }, { path: ['基地', '医务室'], desc: '诊室' }, { path: ['基地', '观测站'], desc: '观测' }, { path: ['外港'], desc: '远方' }] } });
const injured = (time = '2042/5/6 10:00') => leaf({ ...scene(), time, protagonist: { condition: '左腿扭伤' }, npcs: { add: [
  { name: '岑岚', condition: '右臂骨折,夹板固定', location: '医务室' },
  { name: '远客', condition: '感冒发烧', location: '外港' },
  { name: '洛伊', important: true, condition: '肩伤', location: '外港' },
] } }, time);
// 跨日后定点角色的位置需本楼重新确认(既有在场规则),这里同楼确认岑岚仍在医务室
const nextDay = (time: string) => leaf({ time, npcs: { update: [{ name: '岑岚', location: '医务室' }] } }, time);
// 提醒块以独占一行的标题开头;[主要角色]标题里也会提到「[伤势进展提醒]」,按块标题定位
const reminder = () => { const t = buildStateInjectionText(); const i = t.indexOf('[伤势进展提醒]\n'); return i < 0 ? '' : t.slice(i, t.indexOf(INJURY_REMINDER_TAIL, i) + INJURY_REMINDER_TAIL.length); };

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  apiSettings.summaryOnlyMode = false;
  apiSettings.memoryBudgetTokens = 6000;
  Object.assign(apiSettings.injection, { scenes: true, npcs: true, protagonist: true, injuryReminder: true });
});
afterEach(() => { Object.assign(apiSettings, JSON.parse(saved)); vi.restoreAllMocks(); });

describe('伤情派生锚点', () => {
  it('伤情一变就盖锚点:时间取叶子的结束时间,楼层取所在楼层;模型输出不能自带', () => {
    const chat = [injured(), user(), leaf({ time: '2042/5/7 09:00', npcs: { update: [{ name: '岑岚', condition: '右臂骨折,夹板固定' }] } }, '2042/5/7 09:00')];
    const st = deriveMemory(chat);
    expect(st.protagonist).toMatchObject({ condition: '左腿扭伤', conditionTime: '2042/5/6 10:00', conditionFloor: 0 });
    // 同样的伤情再写一遍不算变化,锚点不刷新
    expect(st.npcs.find(n => n.name === '岑岚')).toMatchObject({ conditionTime: '2042/5/6 10:00', conditionFloor: 0 });
    chat.push(user(), leaf({ time: '2042/5/8 09:00', npcs: { update: [{ name: '岑岚', condition: '右臂骨折,已拆夹板' }] } }, '2042/5/8 09:00'));
    expect(deriveMemory(chat).npcs.find(n => n.name === '岑岚')).toMatchObject({ conditionTime: '2042/5/8 09:00', conditionFloor: 4 });
    chat.push(leaf({ npcs: { update: [{ name: '岑岚', condition: '' }] } }));
    const healed = deriveMemory(chat).npcs.find(n => n.name === '岑岚')!;
    expect(healed.condition).toBeUndefined();
    expect(healed.conditionTime).toBeUndefined();
    expect(healed.conditionFloor).toBeUndefined();
  });
  it('手动改名沿用原伤情时间;手动改伤情才重新计时', () => {
    const chat = [injured(), user(), leaf({ time: '2042/5/9 10:00' }, '2042/5/9 10:00')];
    useChat(chat);
    expect(editNpc('岑岚', { name: '岑医生' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '岑医生')?.conditionTime).toBe('2042/5/6 10:00');
    expect(editNpc('岑医生', { condition: '右臂好转' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '岑医生')?.conditionTime).toBe('2042/5/9 10:00');
  });
});

describe('伤势进展提醒的阈值', () => {
  it('同一天内不提醒;满一天提醒并写明是谁、什么伤、记录于何时、过了多久', () => {
    useChat([injured(), user(), leaf({ time: '2042/5/6 22:00' }, '2042/5/6 22:00')]);
    expect(reminder()).toBe('');
    useChat([injured(), user(), nextDay('2042/5/7 09:00')]);
    const text = reminder();
    expect(text).toContain('- 沈遥:左腿扭伤(记录于 2042/5/6 10:00,已过约 1 天)');
    expect(text).toContain('- 岑岚:右臂骨折,夹板固定(记录于 2042/5/6 10:00,已过约 1 天)');
    expect(text).toContain('好转、继续休养、留下后遗症或痊愈');
    expect(text).toContain('不要无限期重复同样的伤情描写,也不要无故加重');
  });
  it('只提醒主角、主要角色和在场/同区域的 NPC;不在场的普通 NPC 不提醒', () => {
    useChat([injured(), user(), nextDay('2042/5/8 09:00')]);
    const text = reminder();
    expect(text).toContain('洛伊:肩伤');
    expect(text).not.toContain('远客');
    expect(text.indexOf('沈遥')).toBeLessThan(text.indexOf('洛伊'));
    expect(text.indexOf('洛伊')).toBeLessThan(text.indexOf('岑岚'));
    // 有提醒时,[主要角色]标题注明伤情按提醒处理,不与「离场后不凭空推测」冲突
    expect(buildStateInjectionText()).toContain('伤情按[伤势进展提醒]处理');
  });
  it(`过得越久措辞越重:满 ${INJURY_DAY_LEVELS[1]} 天按轻重区分,满 ${INJURY_DAY_LEVELS[2]} 天应已痊愈`, () => {
    useChat([injured(), user(), leaf({ time: '2042/5/14 09:00' }, '2042/5/14 09:00')]);
    expect(reminder()).toContain('已过约 8 天);轻伤多半已好转或痊愈,重伤仍在恢复,按伤情轻重体现');
    expect(reminder()).not.toContain('大多应已明显好转或痊愈');
    useChat([injured(), user(), leaf({ time: '2042/7/6 09:00' }, '2042/7/6 09:00')]);
    expect(reminder()).toContain('已过约 2 个月);时间很久,除确属长期伤病或后遗症外应已痊愈');
  });
  it(`没有故事时间时按回复楼层数兜底:满 ${INJURY_FLOOR_LEVELS[0]} 层才提醒`, () => {
    const untimed = () => leaf({ ...scene(), protagonist: { condition: '左腿扭伤' } });
    const chat = [untimed(), ...Array.from({ length: INJURY_FLOOR_LEVELS[0] - 1 }, () => leaf({}))];
    useChat(chat);
    expect(reminder()).toBe('');
    chat.push(user(), leaf({}));
    useChat(chat);
    expect(reminder()).toContain(`- 沈遥:左腿扭伤(记录后已过 ${INJURY_FLOOR_LEVELS[0]} 个回复楼层,故事时间不明)`);
  });
  it('故事时间不明时不按楼层升级:一百多个回复楼层后仍只发一级中性提醒,保留不要无限期重复的说明', () => {
    const chat = [leaf({ ...scene(), protagonist: { condition: '左腿扭伤' } }), ...Array.from({ length: 120 }, () => leaf({}))];
    useChat(chat);
    const text = reminder();
    expect(text).toContain('- 沈遥:左腿扭伤(记录后已过 120 个回复楼层,故事时间不明)\n');
    expect(text).not.toMatch(/应已痊愈|时间已久|多半已好转/);
    expect(text).toContain('不要无限期重复同样的伤情描写');
    expect(injuryElapsed({ name: '甲', condition: '伤', conditionFloor: 0 }, '', () => 500)).toMatchObject({ level: 1, floors: 500 });
  });
  it('伤情记录更新后重新计时,提醒随之消失', () => {
    const chat = [injured(), user(), leaf({ time: '2042/5/9 09:00' }, '2042/5/9 09:00')];
    useChat(chat);
    expect(reminder()).toContain('沈遥:左腿扭伤');
    chat.push(user(), leaf({ time: '2042/5/9 10:00', protagonist: { condition: '左腿好转,能慢走' } }, '2042/5/9 10:00'));
    useChat(chat);
    expect(reminder()).not.toContain('沈遥');
  });
  it('开关关闭、仅摘要模式或对应名册不注入时都不提醒;记录本身不变', () => {
    const chat = [injured(), user(), leaf({ time: '2042/5/9 09:00' }, '2042/5/9 09:00')];
    useChat(chat);
    apiSettings.injection.injuryReminder = false;
    expect(reminder()).toBe('');
    expect(buildStateInjectionText()).not.toContain('伤情按[伤势进展提醒]处理');
    apiSettings.injection.injuryReminder = true;
    apiSettings.injection.npcs = false;
    expect(reminder()).toContain('沈遥');
    expect(reminder()).not.toContain('岑岚');
    apiSettings.summaryOnlyMode = true;
    expect(buildStateInjectionText()).toBe('');
    expect(memory.protagonist.condition).toBe('左腿扭伤');
  });
  it('提醒只要求写到伤处或相关行动时体现进展,与本轮无关时不必提及', () => {
    // 提醒在伤情记录更新前每轮都在;措辞不能让正文为回应提醒而每轮硬写伤情。
    expect(INJURY_REMINDER_TAIL).toContain('下次写到伤处或相关行动时');
    expect(INJURY_REMINDER_TAIL).toContain('按轻重和经过的时间体现进展');
    expect(INJURY_REMINDER_TAIL).toContain('与本轮情节无关时不必提及伤情');
    expect(INJURY_REMINDER_TAIL).not.toContain('在正文中合理体现进展');
  });
  it('时间倒退或无法比较时不按天提醒', () => {
    expect(injuryElapsed({ name: '甲', condition: '伤', conditionTime: '2042/5/9', conditionFloor: 0 }, '2042/5/1', () => 50)).toMatchObject({ level: 0 });
    expect(injuryElapsed({ name: '甲', condition: '伤', conditionTime: '霜月3日', conditionFloor: 0 }, '雪月9日', () => 12)).toMatchObject({ level: 1, floors: 12 });
    expect(fmtInjuryReminder([{ name: '甲', condition: '' }], '2042/5/9', () => 99)).toBe('');
  });
});
