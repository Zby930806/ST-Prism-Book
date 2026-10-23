import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { addLifeDetail, appendOpToLatestLeaf } from './apply';
import { buildStateInjectionText } from './inject';
import { memory, recomputeDerived } from './store';
import { cleanBody, clampToTimeTags } from './timeTag';
import { createEmptyMemory, type StoredDelta } from './types';

// 原先 scripts/test-memory-regressions.mjs 用源码字符串守卫的四件事,这里改成行为测试。
const saved = JSON.stringify(settings.apiSettings);
let seq = 0;
const leaf = (delta: StoredDelta, timeEnd?: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: '正文。',
  extra: { bbs_leaf: { id: 'regression-' + ++seq, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1, ...(timeEnd ? { timeEnd } : {}) } } });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '角色', getCurrentChatId: () => 'regression',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  Object.assign(settings.apiSettings.injection, { protagonist: true, lifeDetails: true, sceneFocus: true });
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('记忆重放与注入的回归行为', () => {
  it('主角年龄锚点经重算进入派生状态,注入时按当前故事时间推算', () => {
    useChat([leaf({ time: '2020/1/1 08:00', protagonist: { age: '25' } }, '2020/1/1 08:00'), leaf({ time: '2025/3/1 08:00' }, '2025/3/1 08:00')]);
    expect(memory.protagonist).toMatchObject({ age: '25', ageTime: '2020/1/1 08:00' });
    expect(buildStateInjectionText()).toContain('年龄:约30岁(2020年时25岁)');
  });

  it('手动写入的生活小档案和局势卡生效;没有任何操作时返回失败', () => {
    useChat([leaf({ time: '2026/9/13 10:00' })]);
    expect(addLifeDetail({ subject: 'user', text: '早上只喝黑咖啡', anchors: ['咖啡'] })).toBe(true);
    expect(memory.lifeDetails.map(d => d.text)).toEqual(['早上只喝黑咖啡']);
    expect(appendOpToLatestLeaf({ sceneFocus: { situation: '两人在门口道别', participants: ['林舟', '艾琳'] } })).toBe(true);
    expect(memory.state.sceneFocus).toMatchObject({ situation: '两人在门口道别', participants: ['林舟', '艾琳'] });
    expect(buildStateInjectionText()).toContain('局面:两人在门口道别');
    expect(appendOpToLatestLeaf({ sceneFocus: null })).toBe(true);
    expect(memory.state.sceneFocus).toBeNull();
    expect(appendOpToLatestLeaf({})).toBe(false);
  });

  it('统一正文清洗会去掉柏宝绘标签', () => {
    const mes = '第一行\n<bbi_image>tag<size>portrait</size></bbi_image>\n第二行';
    expect(clampToTimeTags(mes)).toBe('第一行\n第二行');
    expect(cleanBody('<bbs_start>上午</bbs_start>前文<bbi_image>tag</bbi_image>后文<bbs_end>中午</bbs_end>')).toBe('(起始时间:上午)前文后文(结束时间:中午)');
  });
});
