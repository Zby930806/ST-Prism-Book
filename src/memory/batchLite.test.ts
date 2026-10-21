import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import type { ChatMsg } from '@/api/client';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { batchBackfill, batchState, currentSummaryPromise, engineState, planBatchBackfill, resummarizeNow } from './engine';
import { deriveMemory } from './apply';
import { memory, recomputeDerived } from './store';
import { INITIAL_TIME_KEY } from './timeTag';
import { createEmptyMemory, type SummaryDelta } from './types';

const saved = JSON.stringify(settings.apiSettings);
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ai = (text: string, extra: Record<string, unknown> = {}): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra });
/** n 轮「用户 + AI」;AI 楼在奇数下标 1、3、5… */
function chatOf(n: number, body = (i: number) => `第${i}层正文。`): STMessage[] {
  const chat: STMessage[] = [];
  for (let i = 0; i < n; i++) chat.push(user(`第${i}层用户发言。`), ai(body(i)));
  return chat;
}
const aiFloors = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => 2 * (from + k) + 1);
function useChat(chat: STMessage[], chatMetadata: Record<string, unknown> = {}) {
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'lite-test',
    chatMetadata, saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
function response(summary: string, delta: SummaryDelta = {}) {
  return JSON.stringify({ summary, ...delta, stateChanges: Object.keys(delta).filter(k => !['time', 'timeStart', 'timeEnd'].includes(k)) });
}
const textOf = (messages: ChatMsg[]) => messages.map(m => m.content).join('\n');
const isLite = (messages: ChatMsg[]) => messages.some(m => m.content.includes('【合并摘要的事实整理与核查】'));
const isResummary = (messages: ChatMsg[]) => messages.some(m => m.content.includes('【总结与二次总结的事实整理与核查】'));
const liteFloorsOf = (messages: ChatMsg[]) => [...(messages.find(m => m.role === 'user')?.content ?? '').matchAll(/═══ 楼层 #(\d+) ═══/g)].map(m => Number(m[1]));
const liteReply = (floors: number[], time = (f: number) => `第${f}天`) =>
  JSON.stringify({ floors: floors.map(f => ({ floor: f, summary: `楼层${f}的简要摘要。`, timeStart: time(f), timeEnd: time(f) })) });

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100, leafKeepRecent: 3, resummaryThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => {
    if (isLite(messages)) return liteReply(liteFloorsOf(messages));
    if (isResummary(messages)) return JSON.stringify({ summary: '合并后的总结。' });
    return response('逐层摘要。');
  });
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('批量补摘计划', () => {
  it('不合并时每层一步', () => {
    const chat = chatOf(4);
    const plan = planBatchBackfill(chat, aiFloors(0, 3));
    expect(plan.steps).toEqual(aiFloors(0, 3).map(f => ({ lite: false, floors: [f] })));
    expect(plan).toMatchObject({ liteFloors: 0, liteSteps: 0, fullFloors: 4 });
  });

  it('最近 N 层逐层；更早的按组合并，组数一定时尽量均分', () => {
    const chat = chatOf(30);
    const plan = planBatchBackfill(chat, aiFloors(0, 29), { lite: true, fullRecent: 5, maxFloors: 10 });
    expect(plan.steps.filter(s => s.lite).map(s => s.floors)).toEqual([aiFloors(0, 8), aiFloors(9, 17), aiFloors(18, 24)]);
    expect(plan.steps.filter(s => !s.lite).map(s => s.floors[0])).toEqual(aiFloors(25, 29));
    expect(plan).toMatchObject({ liteFloors: 25, liteSteps: 3, fullFloors: 5 });
    expect(plan.steps.map(s => s.floors[0])).toEqual([...plan.steps.map(s => s.floors[0])].sort((a, b) => a - b));
  });

  it('中间隔着已有摘要的楼层另起一组，零散缺口逐层摘要，步骤保持楼层顺序', () => {
    const chat = chatOf(20);
    const floors = [...aiFloors(0, 9), ...aiFloors(11, 12), ...aiFloors(14, 19)];
    const plan = planBatchBackfill(chat, floors, { lite: true, fullRecent: 0, maxFloors: 10 });
    expect(plan.steps).toEqual([
      { lite: true, floors: aiFloors(0, 9) },
      { lite: false, floors: [aiFloors(11, 11)[0]] },
      { lite: false, floors: [aiFloors(12, 12)[0]] },
      { lite: true, floors: aiFloors(14, 19) },
    ]);
  });

  it('原文超过字数上限就提前分组', () => {
    const chat = chatOf(6, i => `第${i}层。` + '长'.repeat(400));
    const plan = planBatchBackfill(chat, aiFloors(0, 5), { lite: true, fullRecent: 0, maxFloors: 10, maxChars: 1000 });
    expect(plan.steps.map(s => s.floors.length)).toEqual([2, 2, 2]);
  });

  it('最近楼层数为 0 时全部合并；不少于 AI 楼数时全部逐层', () => {
    const chat = chatOf(8);
    expect(planBatchBackfill(chat, aiFloors(0, 7), { lite: true, fullRecent: 0, maxFloors: 10 }).liteFloors).toBe(8);
    expect(planBatchBackfill(chat, aiFloors(0, 7), { lite: true, fullRecent: 8, maxFloors: 10 }).liteFloors).toBe(0);
  });
});

describe('较早楼层合并摘要', () => {
  it('合并请求只写摘要和时间，最近楼层仍逐层完整摘要', async () => {
    const chat = chatOf(30);
    useChat(chat);
    Object.assign(settings.apiSettings, { batchFullRecent: 5, batchMaxFloors: 10 });

    expect(await batchBackfill({ lite: true })).toEqual({ done: 30, total: 30, cancelled: false });

    const calls = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]);
    const lite = calls.filter(isLite);
    expect(lite.map(liteFloorsOf)).toEqual([aiFloors(0, 8), aiFloors(9, 17), aiFloors(18, 24)]);
    expect(calls.filter(m => !isLite(m))).toHaveLength(5);
    expect(chat[1].extra?.bbs_leaf).toMatchObject({ lite: true, text: '楼层1的简要摘要。', timeStart: '第1天', timeEnd: '第1天', delta: { time: '第1天' } });
    expect(chat[51].extra?.bbs_leaf?.text).toBe('逐层摘要。');
    expect(chat[51].extra?.bbs_leaf?.lite).toBeUndefined();
    expect(deriveMemory(chat, 50)).toMatchObject({ items: [], npcs: [], plans: [] });

    const system = lite[0].filter(m => m.role === 'system').map(m => m.content).join('\n');
    expect(system).toContain('【逐层分开】');
    expect(system).toContain('summary 不超过 300 字（含标点）');
    expect(system).not.toContain('【物品规则】');
    const first = lite[0].find(m => m.role === 'user')!.content;
    expect(first).toContain('【用户·林舟】');
    expect(first).toContain('[M2-P1] 第0层正文。');
    expect(first).toContain('(无,这是开篇)');
    // 后一组的前情提要带上前一组刚写好的摘要
    expect(lite[1].find(m => m.role === 'user')!.content).toContain('楼层17的简要摘要。');
    expect(lite[0].at(-1)).toMatchObject({ role: 'assistant' });
    expect(batchState).toMatchObject({ lite: true, steps: 8, stepsDone: 8, stage: '' });
  });

  it('时间以正文标签为准；已设开场时间时，缺失的时间沿用上一层', async () => {
    const tagged = chatOf(6, i => i < 3 ? `<bbs_start>2031/4/${i + 1} 08:00</bbs_start>第${i}层正文。<bbs_end>2031/4/${i + 1} 09:00</bbs_end>` : `第${i}层正文。`);
    useChat(tagged, { [INITIAL_TIME_KEY]: '2031/4/1 07:00' });
    Object.assign(settings.apiSettings, { batchFullRecent: 0, batchMaxFloors: 10 });
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => JSON.stringify({
      floors: liteFloorsOf(messages).map(f => f === 7 ? { floor: f, summary: `楼层${f}。`, timeStart: '2031/4/5 10:00', timeEnd: '2031/4/5 11:00' } : { floor: f, summary: `楼层${f}。`, timeStart: '模型写的时间', timeEnd: '模型写的时间' })
        .map(item => (item.floor === 9 || item.floor === 11 ? { floor: item.floor, summary: item.summary } : item)),
    }));

    expect(await batchBackfill({ lite: true })).toMatchObject({ done: 6 });
    expect(tagged[1].extra?.bbs_leaf).toMatchObject({ timeStart: '2031/4/1 08:00', timeEnd: '2031/4/1 09:00' });
    expect(tagged[5].extra?.bbs_leaf).toMatchObject({ timeStart: '2031/4/3 08:00', timeEnd: '2031/4/3 09:00' });
    expect(tagged[7].extra?.bbs_leaf).toMatchObject({ timeStart: '2031/4/5 10:00', timeEnd: '2031/4/5 11:00' });
    expect(tagged[9].extra?.bbs_leaf).toMatchObject({ timeStart: '2031/4/5 11:00', timeEnd: '2031/4/5 11:00', delta: { time: '2031/4/5 11:00' } });
    expect(tagged[11].extra?.bbs_leaf).toMatchObject({ timeStart: '2031/4/5 11:00', timeEnd: '2031/4/5 11:00' });
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].find(m => m.role === 'user')!.content;
    expect(sent).toContain('(起始时间:2031/4/1 08:00)');
    expect(sent).toContain('【这些楼层之前的主线时间】2031/4/1 07:00');
  });

  it('漏写楼层时附原因重试，仍失败就停下，这组楼层保持待摘要', async () => {
    const chat = chatOf(12);
    useChat(chat);
    Object.assign(settings.apiSettings, { batchFullRecent: 0, batchMaxFloors: 12, summaryMaxRetries: 1 });
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => liteReply(liteFloorsOf(messages).slice(0, -1)));

    expect(await batchBackfill({ lite: true })).toEqual({ done: 0, total: 12, cancelled: false });
    const calls = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]);
    expect(calls).toHaveLength(2);
    expect(textOf(calls[1])).toContain('上一次摘要结果未通过校验');
    expect(textOf(calls[1])).toContain('漏掉了楼层 #23');
    expect(engineState.lastError).toContain('楼层 #1–#23 合并摘要未保存');
    expect(chat.some(m => m.extra?.bbs_leaf)).toBe(false);
  });

  it('回复被截断时停下，提示里给出调小每次合并楼层数的改法', async () => {
    const chat = chatOf(12);
    useChat(chat);
    Object.assign(settings.apiSettings, { batchFullRecent: 0, batchMaxFloors: 12 });
    vi.mocked(client.requestViaMainApi).mockResolvedValue('<thinking>核对</thinking>{"floors":[{"floor":1,"summary":"写到一半');

    expect(await batchBackfill({ lite: true })).toEqual({ done: 0, total: 12, cancelled: false });
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(engineState.lastFailure?.title).toContain('楼层 #1–#23 合并摘要未完成');
    expect(engineState.lastFailure?.hint).toContain('每次合并的楼层数');
    expect(chat.some(m => m.extra?.bbs_leaf)).toBe(false);
  });

  it('每组写完就合并总结，后面请求的前情提要保持精简', async () => {
    const chat = chatOf(20);
    useChat(chat);
    Object.assign(settings.apiSettings, { batchFullRecent: 0, batchMaxFloors: 10, leafBatchThreshold: 4, leafKeepRecent: 0 });

    expect(await batchBackfill({ lite: true })).toMatchObject({ done: 20 });
    const lite = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]).filter(isLite);
    expect(lite).toHaveLength(2);
    const second = lite[1].find(m => m.role === 'user')!.content;
    expect(second).toContain('合并后的总结。');
    expect(second).toContain('楼层17的简要摘要。');
    expect(second).not.toContain('楼层1的简要摘要。');
    const l1 = memory.summaries.filter(s => s.level === 1);
    expect(l1).toHaveLength(5);
    expect(l1[0].childIds).toEqual(aiFloors(0, 3).map(f => chat[f].extra!.bbs_leaf!.id));
    expect(engineState.lastError).toBe('');
  });

  it('总结请求失败时停下：已写入的摘要保留，原因留在 lastError', async () => {
    const chat = chatOf(20);
    useChat(chat);
    Object.assign(settings.apiSettings, { batchFullRecent: 0, batchMaxFloors: 10, leafBatchThreshold: 4, leafKeepRecent: 0 });
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (isLite(messages)) return liteReply(liteFloorsOf(messages));
      return '';
    });

    expect(await batchBackfill({ lite: true })).toEqual({ done: 10, total: 20, cancelled: false });
    const calls = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]);
    expect(calls.filter(isLite)).toHaveLength(1);
    expect(calls.filter(isResummary)).toHaveLength(1);
    expect(engineState.lastError).toContain('总结失败');
    expect(chat.filter(m => m.extra?.bbs_leaf?.lite)).toHaveLength(10);
  });

  it('不选合并时与原来的逐层补摘相同', async () => {
    const chat = chatOf(30);
    useChat(chat);
    expect(await batchBackfill({})).toMatchObject({ done: 30 });
    const calls = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]);
    expect(calls.filter(isLite)).toHaveLength(0);
    expect(calls).toHaveLength(30);
    expect(batchState.lite).toBe(false);
  });
});

describe('上层合并按楼层先后排序', () => {
  it('生成时间与楼层顺序不一致时，按楼层合并', async () => {
    const chat = [0, 1, 2, 3].map(i => ai(`第${i}层`, { bbs_leaf: { id: `leaf-${i}`, text: `摘要${i}`, delta: {}, createdAt: 10 + i, swipe: 0, v: 1 } }));
    useChat(chat);
    memory.summaries.push(
      { id: 'late', text: '后段总结', level: 1, auto: true, createdAt: 1, childIds: ['leaf-2', 'leaf-3'] },
      { id: 'early', text: '前段总结', level: 1, auto: true, createdAt: 2, childIds: ['leaf-0', 'leaf-1'] },
    );
    settings.apiSettings.resummaryThreshold = 2;

    expect(await resummarizeNow()).toBe(1);
    expect(memory.summaries.at(-1)).toMatchObject({ level: 2, childIds: ['early', 'late'] });
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].find(m => m.role === 'user')!.content;
    expect(sent.indexOf('前段总结')).toBeLessThan(sent.indexOf('后段总结'));
  });
});
