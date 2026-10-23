import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import type { ApiChannel } from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import type { ChatMsg } from '@/api/client';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import {
  batchBackfill, bindEngine, checkResummary, currentSummaryPromise, engineState, floorCoveredByImport, regenerateFloor,
  resummarizeNow, resummaryHold, summarizeFloor,
} from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type StoredDelta } from './types';

// 批量补摘、总结、重新摘要的引擎规则;模拟响应只验证流程,不代表真实模型的输出。
const saved = JSON.stringify(settings.apiSettings);
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ai = (text: string, extra: Record<string, unknown> = {}): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra });
const leafMsg = (id: string, extra: Partial<LeafExtra> = {}): STMessage => ai(`${id}的正文。`, {
  bbs_leaf: { id, text: `${id}的旧摘要`, delta: {}, createdAt: 1, swipe: 0, v: 1, ...extra },
});
/** n 轮「用户 + AI」;AI 楼在奇数下标 1、3、5… */
function chatOf(n: number): STMessage[] {
  const chat: STMessage[] = [];
  for (let i = 0; i < n; i++) chat.push(user(`第${i}层用户发言。`), ai(`第${i}层正文。`));
  return chat;
}
const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
function useChat(chat: STMessage[], chatMetadata: Record<string, unknown> = {}) {
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'engine-rules', chatMetadata,
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    eventTypes: Object.fromEntries(['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'CHAT_CHANGED'].map(n => [n, n])),
    eventSource: { on: (name: string, fn: (...args: unknown[]) => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); } },
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const isLite = (messages: ChatMsg[]) => messages.some(m => m.content.includes('【合并摘要的事实整理与核查】'));
const isResummary = (messages: ChatMsg[]) => messages.some(m => m.content.includes('【总结与二次总结的事实整理与核查】'));
const liteFloorsOf = (messages: ChatMsg[]) => [...(messages.find(m => m.role === 'user')?.content ?? '').matchAll(/═══ 楼层 #(\d+) ═══/g)].map(m => Number(m[1]));
const summaryReply = (summary = '逐层摘要。') => JSON.stringify({ summary, stateChanges: [] });
const userText = (messages: ChatMsg[]) => messages.find(m => m.role === 'user')?.content ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, {
    summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100, leafKeepRecent: 0,
    resummaryThreshold: 100, higherResummaryThreshold: 100, autoSummaryEnabled: true,
  });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  Object.assign(engineState, { lastError: '', lastFailure: null });
  Object.assign(resummaryHold, { active: false, chatId: '', level: 0, ids: [], settingsKey: '', message: '' });
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => {
    if (isLite(messages)) return JSON.stringify({ floors: liteFloorsOf(messages).map(f => ({ floor: f, summary: `楼层${f}的简要摘要。` })) });
    if (isResummary(messages)) return JSON.stringify({ summary: '合并后的总结。' });
    return summaryReply();
  });
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('批量补摘与总结的节奏', () => {
  it('逐层补摘每楼写完跑一轮总结，后面楼层的前情不再带着全部逐楼摘要', async () => {
    const chat = chatOf(10);
    useChat(chat);
    Object.assign(settings.apiSettings, { leafBatchThreshold: 4 });
    expect(await batchBackfill({})).toMatchObject({ done: 10, total: 10 });
    const calls = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]);
    expect(calls.filter(isResummary)).toHaveLength(2);
    expect(memory.summaries.filter(s => s.level === 1)).toHaveLength(2);
    // 最后一楼的请求:前情是两条总结加一条逐楼摘要,而不是前面九条逐楼摘要
    const last = userText(calls.filter(m => !isResummary(m)).at(-1)!);
    expect(last).toContain('合并后的总结。');
    expect(last.split('逐层摘要。').length - 1).toBe(1);
  });

  it('重建时只合并覆盖楼层都早于下一个待重建楼层的摘要，合并后不会马上作废', async () => {
    const chat = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => leafMsg(id));
    useChat(chat);
    memory.summaries.push({ id: 'old-l1', text: '旧总结', level: 1, auto: true, childIds: ['a', 'b', 'c', 'd'], createdAt: 0 });
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2 });
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 6, total: 6 });
    const resummaries = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]).filter(isResummary);
    const l1 = memory.summaries.filter(s => s.level === 1);
    // 每次总结请求都留下来了:没有被下一楼的重建作废后重做
    expect(resummaries).toHaveLength(l1.length);
    expect(l1.map(s => s.childIds)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(memory.summaries.some(s => s.id === 'old-l1')).toBe(false);
  });

  it('结束时把能合并的都合并完（逐层补摘也是）', async () => {
    const chat = chatOf(4);
    useChat(chat);
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, resummaryThreshold: 2 });
    expect(await batchBackfill({})).toMatchObject({ done: 4 });
    expect(memory.summaries.filter(s => s.level === 1)).toHaveLength(2);
    expect(memory.summaries.filter(s => s.level === 2)).toHaveLength(1);
  });

  it('逐层补摘中途总结偶尔失败、之后合并成功时，结束后不留下过时的报错', async () => {
    const chat = chatOf(4);
    useChat(chat);
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2 });
    let failOnce = true;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (isResummary(messages)) {
        if (failOnce) { failOnce = false; throw new Error('连接中断'); }
        return JSON.stringify({ summary: '合并后的总结。' });
      }
      return summaryReply();
    });
    expect(await batchBackfill({})).toMatchObject({ done: 4, total: 4 });
    expect(vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]).filter(isResummary).length).toBeGreaterThan(2);
    expect(memory.summaries.filter(s => s.level === 1)).toHaveLength(2);
    expect(resummaryHold.active).toBe(false);
    expect(engineState.lastError).toBe('');
  });

  it('合并摘要的前情不截断：较早的导入历史在后面各组也带上', async () => {
    const chat = chatOf(22);
    useChat(chat);
    const imported = '导入的旧剧情开端。' + '早年往事。'.repeat(3000);
    memory.summaries.push({ id: 'imported', text: imported, level: 2, auto: false, childIds: [], imported: true, importedFloorStart: 0, importedFloorEnd: 1, createdAt: 0 });
    recomputeDerived();
    Object.assign(settings.apiSettings, { batchFullRecent: 0, batchMaxFloors: 10 });
    expect(await batchBackfill({ lite: true })).toMatchObject({ done: 21, total: 21 });
    const lite = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0]).filter(isLite);
    expect(lite.length).toBeGreaterThan(1);
    for (const request of lite) expect(userText(request)).toContain('导入的旧剧情开端。');
  });

  it('清洗后没有故事正文的楼层不请求、不中断批量，结束后写明改法', async () => {
    const chat = chatOf(4);
    chat[3].mes = '<thinking>只有思考</thinking>';
    useChat(chat);
    expect(await batchBackfill({})).toMatchObject({ done: 3, total: 3 });
    expect(chat[3].extra?.bbs_leaf).toBeUndefined();
    expect(chat[5].extra?.bbs_leaf).toBeDefined();
    expect(engineState.lastError).toContain('楼层 #3 清洗后没有故事正文');
    expect(engineState.lastError).toContain('标为番外');
  });
});

describe('总结失败后暂停自动重发', () => {
  const channel = { id: 'res', name: '总结渠道', url: 'https://relay.example/v1', key: 'k', model: 'm', temperature: 1, maxTokens: 4096,
    timeoutSec: 60, stream: false, prefill: false, excludeParams: [], reasoningEffort: '' } as ApiChannel;
  function fourLeaves() {
    const chat = ['a', 'b', 'c', 'd'].map(id => leafMsg(id));
    useChat(chat);
    Object.assign(settings.apiSettings, { leafBatchThreshold: 4 });
    vi.mocked(settings.getChannelForTask).mockReturnValue(channel);
    return chat;
  }

  it('截断:同一批节点、设置没变时不再自动重发；改了最大输出或手动重试才再请求', async () => {
    fourLeaves();
    const send = vi.spyOn(client, 'requestCompletion').mockResolvedValue('{"summary":"写到一半');
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(resummaryHold).toMatchObject({ active: true, level: 0, ids: ['a', 'b', 'c', 'd'] });
    const message = engineState.lastError;
    expect(message).toContain('总结未完成');
    // 自动路径:不再发同一个请求
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    // 改了最大输出:设置变了,照常再试
    channel.maxTokens = 9000;
    await checkResummary();
    expect(send).toHaveBeenCalledTimes(2);
    // 手动「重试总结」不受暂停限制
    send.mockResolvedValue(JSON.stringify({ summary: '合并后的总结。' }));
    expect(await resummarizeNow()).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(resummaryHold.active).toBe(false);
    channel.maxTokens = 4096;
  });

  it('服务商临时故障不暂停：下次照常自动重试', async () => {
    fourLeaves();
    const send = vi.spyOn(client, 'requestCompletion').mockRejectedValue(Object.assign(new Error('503'), { name: 'Error' }));
    await checkResummary();
    await checkResummary();
    expect(send).toHaveBeenCalledTimes(2);
    expect(resummaryHold.active).toBe(false);
  });

  it('切换聊天后清除暂停记录，切回来时照常再试一次', async () => {
    fourLeaves();
    const send = vi.spyOn(client, 'requestCompletion').mockResolvedValue('{"summary":"写到一半');
    await checkResummary();
    expect(resummaryHold.active).toBe(true);
    bindEngine();
    handlers.get('CHAT_CHANGED')?.forEach(fn => fn());
    expect(resummaryHold.active).toBe(false);
    await checkResummary();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('重新摘要沿用单独保存的手动修改和迁移状态', () => {
  const manualOps: StoredDelta = { items: { add: [{ name: '手动添加的灯笼', qty: 1 }] } };
  const migratedDelta: StoredDelta = { plans: { add: [{ kind: 'plan', content: '迁移来的约定' }] } };
  it('楼层面板重新摘要:替换叶子时沿用 manualOps 和 migratedDelta', async () => {
    const chat = [leafMsg('m', { manualOps, migratedDelta } as Partial<LeafExtra>)];
    useChat(chat);
    expect(await regenerateFloor(0)).toBe(true);
    const leaf = chat[0].extra!.bbs_leaf as LeafExtra & { manualOps?: StoredDelta; migratedDelta?: StoredDelta };
    expect(leaf.text).toBe('逐层摘要。');
    expect(leaf.manualOps).toEqual(manualOps);
    expect(leaf.migratedDelta).toEqual(migratedDelta);
  });
  it('重建记忆:手动修改保留，迁移状态按正文重新推算后替换(不沿用,免得重复累加)', async () => {
    const chat = [leafMsg('m', { manualOps, migratedDelta } as Partial<LeafExtra>)];
    useChat(chat);
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 1 });
    const leaf = chat[0].extra!.bbs_leaf as LeafExtra & { manualOps?: StoredDelta; migratedDelta?: StoredDelta };
    expect(leaf.manualOps).toEqual(manualOps);
    expect(leaf.migratedDelta).toBeUndefined();
  });
  it('手动新增的角色带着补档结果：重新摘要时补档结果随手动修改一起沿用', async () => {
    const manual: StoredDelta = { npcs: { add: [{ name: '梅芙' }] } };
    const enriched = [{ name: '梅芙', fields: { desc: '银灰短发' }, source: 'manual' as const }];
    const chat = [leafMsg('m', { manualOps: manual, enriched } as Partial<LeafExtra>)];
    useChat(chat);
    expect(memory.npcs.find(n => n.name === '梅芙')?.desc).toBe('银灰短发');
    expect(await regenerateFloor(0)).toBe(true);
    const leaf = chat[0].extra!.bbs_leaf as LeafExtra;
    expect(leaf.text).toBe('逐层摘要。');
    expect(leaf.enriched).toEqual(enriched);
    expect(memory.npcs.find(n => n.name === '梅芙')?.desc).toBe('银灰短发');
  });
  it('重新摘要后「没写入的内容」换成新结果的（没有就去掉）', async () => {
    const chat = [leafMsg('m', { dropped: [{ kind: 'item', name: '旧', reason: 'missing' }] } as Partial<LeafExtra>)];
    useChat(chat);
    expect(await regenerateFloor(0)).toBe(true);
    expect((chat[0].extra!.bbs_leaf as { dropped?: unknown }).dropped).toBeUndefined();
  });
});

describe('楼层面板的单楼摘要', () => {
  it('由导入的旧总结覆盖的楼层不单独摘要，返回 skipped，也不带出之前留下的错误', async () => {
    const chat = chatOf(2);
    useChat(chat);
    memory.summaries.push({ id: 'imported', text: '旧总结', level: 2, auto: false, childIds: [], imported: true, importedFloorStart: 0, importedFloorEnd: 1, createdAt: 0 });
    engineState.lastError = '之前的错误';
    expect(floorCoveredByImport(1)).toBe(true);
    expect(floorCoveredByImport(3)).toBe(false);
    expect(await summarizeFloor(1)).toBe('skipped');
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(await summarizeFloor(3)).toBe('done');
    expect(engineState.lastError).toBe('');
  });
});

describe('在酒馆里直接删楼后作废的总结有提示', () => {
  it('删除被总结收纳的楼层后，提示作废了几条、哪一层', async () => {
    const chat = ['a', 'b', 'c'].map(id => leafMsg(id));
    useChat(chat);
    bindEngine();
    memory.summaries.push(
      { id: 'l1', text: '总结', level: 1, auto: true, childIds: ['a', 'b'], createdAt: 2 },
      { id: 'l2', text: '二次总结', level: 2, auto: true, childIds: ['l1'], createdAt: 3 },
    );
    chat.splice(0, 1);
    handlers.get('MESSAGE_DELETED')?.forEach(fn => fn(0));
    await vi.advanceTimersByTimeAsync(250);
    expect(memory.summaries).toEqual([]);
    expect(notices.toast).toHaveBeenCalledWith(expect.stringContaining('2 条总结（L1 1 条、L2 1 条）已作废'), 'info');
  });
});

describe('手动修改跟着有效摘要走（事件接线）', () => {
  const ops = { npcs: { add: [{ name: '梅芙' }] } } as StoredDelta;
  function bindWith(chat: STMessage[]) {
    const ctx = useChat(chat);
    (ctx as unknown as { eventTypes: Record<string, string> }).eventTypes = Object.fromEntries(
      ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'CHAT_CHANGED', 'GENERATION_STARTED'].map(n => [n, n]));
    handlers.clear();
    bindEngine();
    return ctx;
  }
  const leafOf = (m: STMessage) => m.extra!.bbs_leaf as LeafExtra;

  it('翻页后，原页摘要上的手动修改移到之前最近一条有效摘要', async () => {
    const first = leafMsg('a'), last = leafMsg('b', { manualOps: ops });
    const chat = [user('开场。'), first, user('继续。'), last];
    bindWith(chat);
    const original = JSON.parse(JSON.stringify(last.extra));
    (last as unknown as { swipe_info: unknown[] }).swipe_info = [{ extra: original }, { extra: {} }];
    last.swipe_id = 1; last.extra = {};
    handlers.get('MESSAGE_SWIPED')?.forEach(fn => fn(3));
    await vi.advanceTimersByTimeAsync(250);
    expect(leafOf(first).manualOps?.npcs?.add?.[0].name).toBe('梅芙');
    expect(memory.npcs.map(n => n.name)).toEqual(['梅芙']);
  });

  it('重新生成末尾回复前，先把它摘要上的手动修改移走；翻页生成不提前移动', async () => {
    const first = leafMsg('a'), last = leafMsg('b', { manualOps: ops });
    const chat = [user('开场。'), first, user('继续。'), last];
    bindWith(chat);
    handlers.get('GENERATION_STARTED')?.forEach(fn => fn('swipe', {}, false));
    expect(leafOf(last).manualOps).toBeTruthy();
    handlers.get('GENERATION_STARTED')?.forEach(fn => fn('regenerate', {}, false));
    expect(leafOf(last).manualOps).toBeUndefined();
    expect(leafOf(first).manualOps?.npcs?.add?.[0].name).toBe('梅芙');
    chat.pop();
    recomputeDerived();
    expect(memory.npcs.map(n => n.name)).toEqual(['梅芙']);
  });

  it('末尾是用户楼时（重新生成失败后恢复），不移动前一条回复的手动修改', () => {
    const first = leafMsg('a'), mid = leafMsg('b', { manualOps: ops });
    const chat = [user('开场。'), first, user('继续。'), mid, user('再来。')];
    bindWith(chat);
    handlers.get('GENERATION_STARTED')?.forEach(fn => fn('regenerate', {}, false));
    expect(leafOf(mid).manualOps).toBeTruthy();
  });
});
