import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import type { ApiChannel } from '@/api/settings';
import type { STContext, STMessage } from '@/st/context';
import { bindEngine, currentSummaryPromise, engineState } from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

// 「回复结束后立即摘要」:按酒馆的事件顺序模拟生成开始、回复渲染、生成结束,核对摘要时机和续写、编辑、重抽后的处理。
const saved = JSON.stringify(settings.apiSettings);
const channel: ApiChannel = {
  id: 'reply-end', name: '摘要渠道', url: 'https://relay.example/v1', key: 'k', model: 'm', temperature: 1,
  maxTokens: 4096, timeoutSec: 60, stream: false, prefill: false, excludeParams: [], reasoningEffort: '',
};
const ai = (text: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra: {} });
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ok = (summary: string) => JSON.stringify({ summary, stateChanges: [] });
const sent = (call: number) => JSON.stringify(send.mock.calls[call]?.[1] ?? []);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

const handlers = new Map<string, Set<(...args: any[]) => void>>();
const eventNames = ['USER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED',
  'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'CHAT_CHANGED'];
const emit = (name: string, ...args: unknown[]) => handlers.get(name)?.forEach(fn => fn(...args));
const ctx = {
  chat: [] as STMessage[], name1: '林舟', name2: '角色', getCurrentChatId: () => 'reply-end-test', chatMetadata: {},
  saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  eventTypes: Object.fromEntries(eventNames.map(name => [name, name])),
  eventSource: {
    on: (name: string, fn: (...args: any[]) => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); },
    off: (name: string, fn: (...args: any[]) => void) => handlers.get(name)?.delete(fn),
  },
} as unknown as STContext;
let chat: STMessage[];
let send: MockInstance<typeof client.requestCompletion>;

/** 等定时器和在飞的摘要都走完。 */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(600);
    const run = currentSummaryPromise();
    if (run) await run;
  }
}
/** 一次产出新正文的生成:开始 → 改动聊天(新增或改写回复)→ 渲染 → 结束。 */
async function generate(type: string, change: () => void, options: { stop?: boolean; settle?: boolean } = {}) {
  emit('GENERATION_STARTED', type, {}, false);
  change();
  emit('CHARACTER_MESSAGE_RENDERED', chat.length - 1, type);
  if (options.stop) emit('GENERATION_STOPPED');
  emit('GENERATION_ENDED', chat.length);
  if (options.settle !== false) await settle();
}
const leafOf = (floor: number) => chat[floor].extra?.bbs_leaf as { id: string; text: string } | undefined;

beforeAll(() => {
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(channel);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  send = vi.spyOn(client, 'requestCompletion');
  bindEngine();
});
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100, autoSummaryEnabled: true, summarizeOnReplyEnd: true });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  chat = [user('出发吧。')];
  Object.assign(ctx, { chat, chatMetadata: {} });
  send.mockReset();
  recomputeDerived();
  Object.assign(engineState, { lastError: '', lastFailure: null });
});
afterEach(async () => {
  await settle();
  vi.clearAllTimers(); vi.useRealTimers();
});
afterAll(() => {
  Object.assign(settings.apiSettings, JSON.parse(saved));
  vi.restoreAllMocks();
});

describe('回复结束后立即摘要', () => {
  it('关闭时（默认）回复结束不摘要，发送下一条消息时才摘要上一条回复', async () => {
    settings.apiSettings.summarizeOnReplyEnd = false;
    send.mockResolvedValue(ok('林舟推门出发。'));
    await generate('normal', () => chat.push(ai('林舟推开门，雨已经停了。')));
    expect(send).not.toHaveBeenCalled(); expect(leafOf(1)).toBeUndefined();
    chat.push(user('继续。')); emit('USER_MESSAGE_RENDERED'); await settle();
    expect(send).toHaveBeenCalledTimes(1); expect(leafOf(1)?.text).toBe('林舟推门出发。');
  });

  it('打开后回复一结束就摘要这条回复；之后发送下一条消息不再重复请求', async () => {
    send.mockResolvedValue(ok('林舟推门出发。'));
    await generate('normal', () => chat.push(ai('林舟推开门，雨已经停了。')));
    expect(send).toHaveBeenCalledTimes(1); expect(sent(0)).toContain('林舟推开门，雨已经停了。');
    expect(leafOf(1)?.text).toBe('林舟推门出发。'); expect(engineState.lastError).toBe('');
    chat.push(user('继续。')); emit('USER_MESSAGE_RENDERED'); await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('停止生成、安静生成、扮演，以及关闭自动摘要时都不触发', async () => {
    send.mockResolvedValue(ok('不应写入'));
    await generate('normal', () => chat.push(ai('写到一半被停下的回复。')), { stop: true });
    await generate('quiet', () => {});
    await generate('impersonate', () => {});
    settings.apiSettings.autoSummaryEnabled = false;
    await generate('swipe', () => { chat[1].mes = '另一页回复。'; chat[1].swipe_id = 1; });
    expect(send).not.toHaveBeenCalled(); expect(leafOf(1)).toBeUndefined();
  });

  it('重抽时旧回复的摘要放弃写入且不报错，新回复结束后重新摘要', async () => {
    const first = deferred<string>();
    send.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok('林舟留在屋里。'));
    await generate('normal', () => chat.push(ai('林舟推开门，雨已经停了。')), { settle: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(send).toHaveBeenCalledTimes(1);
    // 酒馆重抽:删掉旧回复,同一位置生成新回复
    await generate('regenerate', () => chat.splice(1, 1, ai('林舟没有出门，留在屋里看雨。')), { settle: false });
    await vi.advanceTimersByTimeAsync(600);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    first.resolve(ok('林舟推门出发。'));
    await settle();
    expect(log.mock.calls.some(args => String(args[0]).includes('放弃写入'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2); expect(sent(1)).toContain('林舟没有出门');
    expect(leafOf(1)?.text).toBe('林舟留在屋里。'); expect(engineState.lastError).toBe('');
  });

  it('手动补摘期间正文被改，照常提示没有写入（只有立即摘要才静默放弃）', async () => {
    settings.apiSettings.summarizeOnReplyEnd = false;
    const pending = deferred<string>();
    send.mockReturnValueOnce(pending.promise);
    chat.push(ai('林舟推开门，雨已经停了。'));
    const { summarizeFloor } = await import('./engine');
    const task = summarizeFloor(1);
    await vi.advanceTimersByTimeAsync(0);
    chat[1].mes = '林舟推开门，外面在下雪。';
    pending.resolve(ok('林舟推门出发。'));
    await task;
    expect(engineState.lastError).toContain('摘要期间聊天或这层正文发生变化'); expect(leafOf(1)).toBeUndefined();
  });

  it('续写结束后按续写后的正文重写这层摘要，保留摘要 id', async () => {
    send.mockResolvedValueOnce(ok('林舟推门出发。')).mockResolvedValueOnce(ok('林舟推门出发，回头把门带上。'));
    await generate('normal', () => chat.push(ai('林舟推开门，雨已经停了。')));
    const id = leafOf(1)!.id;
    await generate('continue', () => { chat[1].mes += '她回头看了一眼，把门带上。'; });
    expect(send).toHaveBeenCalledTimes(2); expect(sent(1)).toContain('把门带上');
    expect(leafOf(1)).toMatchObject({ id, text: '林舟推门出发，回头把门带上。' }); expect(engineState.lastError).toBe('');
  });

  it('编辑过的回复在发送下一条消息时按新内容重写；已并入总结的不自动重写', async () => {
    send.mockResolvedValueOnce(ok('林舟推门出发。')).mockResolvedValueOnce(ok('林舟推门，外面在下雪。'));
    await generate('normal', () => chat.push(ai('林舟推开门，雨已经停了。')));
    chat[1].mes = '林舟推开门，外面在下雪。';
    chat.push(user('继续。')); emit('USER_MESSAGE_RENDERED'); await settle();
    expect(send).toHaveBeenCalledTimes(2); expect(sent(1)).toContain('外面在下雪');
    expect(leafOf(1)?.text).toBe('林舟推门，外面在下雪。');

    // 下一轮:回复已并入总结时,编辑后不自动重写,以免拆掉总结
    send.mockReset().mockResolvedValueOnce(ok('两人走到码头。'));
    await generate('normal', () => chat.push(ai('两人走到码头，船已经靠岸。')));
    memory.summaries.push({ id: 'l1-test', text: '总结', level: 1, createdAt: 1, auto: true, childIds: [leafOf(3)!.id] });
    chat[3].mes = '两人走到码头，船还没有来。';
    chat.push(user('等一等。')); emit('USER_MESSAGE_RENDERED'); await settle();
    expect(send).toHaveBeenCalledTimes(1); expect(leafOf(3)?.text).toBe('两人走到码头。');
  });

  it('设置缺失或类型不符时按关闭处理', () => {
    expect(settings.normalizeApiSettings(null).summarizeOnReplyEnd).toBe(false);
    expect(settings.normalizeApiSettings({ keepRecent: 3 }).summarizeOnReplyEnd).toBe(false);
    expect(settings.normalizeApiSettings({ summarizeOnReplyEnd: 'true' }).summarizeOnReplyEnd).toBe(false);
    expect(settings.normalizeApiSettings({ summarizeOnReplyEnd: true }).summarizeOnReplyEnd).toBe(true);
  });
});
