import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import type { ApiChannel } from '@/api/settings';
import type { STContext, STMessage } from '@/st/context';
import { bindEngine, currentSummaryPromise, engineState, RENDERED_RECOMPUTE_DELAY_MS } from './engine';
import { derivedMeta, memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

// 借用主 API 的摘要与正文生成:酒馆的 generateRaw 在请求期间把全局「最大回复」临时改掉,
// 所以借用请求要排队,且不能和正文生成同时进行。
const ok = (summary: string) => JSON.stringify({ summary, stateChanges: [] });
const ai = (text: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra: {} });
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const body = { dataset: {} as Record<string, string> };
const setGenerating = (on: boolean) => { if (on) body.dataset.generating = 'true'; else delete body.dataset.generating; };

const handlers = new Map<string, Set<(...args: any[]) => void>>();
const eventNames = ['USER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED',
  'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'CHAT_CHANGED'];
const emit = (name: string, ...args: unknown[]) => handlers.get(name)?.forEach(fn => fn(...args));
const generateRaw = vi.fn<(params: { prompt: unknown; responseLength?: number }) => Promise<string>>();
const ctx = {
  chat: [] as STMessage[], name1: '林舟', name2: '角色', getCurrentChatId: () => 'main-api-test', chatMetadata: {},
  saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(), generateRaw,
  eventTypes: Object.fromEntries(eventNames.map(name => [name, name])),
  eventSource: {
    on: (name: string, fn: (...args: any[]) => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); },
    off: (name: string, fn: (...args: any[]) => void) => handlers.get(name)?.delete(fn),
  },
} as unknown as STContext;
let chat: STMessage[];
let channelFor: MockInstance<typeof settings.getChannelForTask>;

async function settle() {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(600);
    const run = currentSummaryPromise();
    if (run) await run;
  }
}
const leafOf = (floor: number) => chat[floor].extra?.bbs_leaf as { text: string } | undefined;

beforeAll(() => {
  vi.stubGlobal('document', { body });
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  channelFor = vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  bindEngine();
});
beforeEach(() => {
  vi.useFakeTimers();
  setGenerating(false);
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, summaryMaxRetries: 0, leafBatchThreshold: 100, autoSummaryEnabled: true, summarizeOnReplyEnd: false, mainApiPrefill: true });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  chat = [user('出发吧。'), ai('林舟推开门，雨已经停了。')];
  Object.assign(ctx, { chat, chatMetadata: {} });
  channelFor.mockReturnValue(null);
  generateRaw.mockReset();
  generateRaw.mockResolvedValue(ok('林舟推门出发。'));
  recomputeDerived();
  Object.assign(engineState, { lastError: '', lastFailure: null });
});
afterEach(async () => {
  setGenerating(false);
  await settle();
  emit('CHAT_CHANGED');
  vi.clearAllTimers(); vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('借用主 API 的请求排队、避开正文生成', () => {
  const messages = [{ role: 'user' as const, content: '整理' }];

  it('同时发出的借用请求一个一个发：前一个结束后才调用下一个', async () => {
    const first = deferred<string>();
    generateRaw.mockReturnValueOnce(first.promise).mockResolvedValueOnce('第二个');
    const a = client.requestViaMainApi(messages);
    const b = client.requestViaMainApi(messages);
    await vi.advanceTimersByTimeAsync(0);
    expect(generateRaw).toHaveBeenCalledTimes(1);
    expect(client.mainApiBusy()).toBe(true);
    first.resolve('第一个');
    await expect(a).resolves.toBe('第一个');
    await expect(b).resolves.toBe('第二个');
    expect(generateRaw).toHaveBeenCalledTimes(2);
    await client.whenMainApiIdle();
    expect(client.mainApiBusy()).toBe(false);
  });

  it('前一个失败也不挡住后面的请求', async () => {
    generateRaw.mockRejectedValueOnce(new Error('status 400')).mockRejectedValueOnce(new Error('status 400')).mockResolvedValueOnce('后一个');
    const a = client.requestViaMainApi(messages);
    const b = client.requestViaMainApi(messages);
    await expect(a).rejects.toThrow();
    await expect(b).resolves.toBe('后一个');
  });

  it('酒馆在生成正文时先等生成结束再发', async () => {
    setGenerating(true);
    const pending = client.requestViaMainApi(messages);
    await vi.advanceTimersByTimeAsync(client.MAIN_API_GATE_POLL_MS * 4);
    expect(generateRaw).not.toHaveBeenCalled();
    setGenerating(false);
    await vi.advanceTimersByTimeAsync(client.MAIN_API_GATE_POLL_MS);
    await expect(pending).resolves.toBe(ok('林舟推门出发。'));
    expect(generateRaw).toHaveBeenCalledTimes(1);
  });

  it('生成拦截器运行期间照常发（正文还没组装提示词），拦截器结束后再来的请求要等', async () => {
    setGenerating(true);
    const release = client.holdGenerationForMainApi();
    await expect(client.requestViaMainApi(messages)).resolves.toBe(ok('林舟推门出发。'));
    release();
    release(); // 重复调用无副作用
    const later = client.requestViaMainApi(messages);
    await vi.advanceTimersByTimeAsync(client.MAIN_API_GATE_POLL_MS * 2);
    expect(generateRaw).toHaveBeenCalledTimes(1);
    setGenerating(false);
    await vi.advanceTimersByTimeAsync(client.MAIN_API_GATE_POLL_MS);
    await later;
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });

  it('酒馆一直卡在生成状态时，最多等五分钟就发', async () => {
    setGenerating(true);
    const pending = client.requestViaMainApi(messages);
    await vi.advanceTimersByTimeAsync(client.MAIN_API_GATE_MAX_WAIT_MS - client.MAIN_API_GATE_POLL_MS);
    expect(generateRaw).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(client.MAIN_API_GATE_POLL_MS * 2);
    await pending;
    expect(generateRaw).toHaveBeenCalledTimes(1);
  });
});

describe('摘要借用主 API 时，上一条回复的摘要推迟到这次生成结束后', () => {
  it('发消息时不和正文同时借用主 API；生成结束后摘上一条回复', async () => {
    chat.push(user('继续。'));
    emit('USER_MESSAGE_RENDERED');
    setGenerating(true);
    emit('GENERATION_STARTED', 'normal', {}, false);
    await settle();
    expect(generateRaw).not.toHaveBeenCalled();
    chat.push(ai('他们沿着河岸走到渡口。'));
    emit('CHARACTER_MESSAGE_RENDERED', chat.length - 1, 'normal');
    emit('GENERATION_ENDED', chat.length);
    setGenerating(false);
    await settle();
    expect(generateRaw).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generateRaw.mock.calls[0][0].prompt)).toContain('林舟推开门，雨已经停了。');
    expect(leafOf(1)?.text).toBe('林舟推门出发。');
    // 刚写好的回复不摘（与发消息时摘上一条的范围相同）
    expect(leafOf(3)).toBeUndefined();
  });

  it('别的生成先结束、酒馆仍在生成时继续等，等这次生成结束再摘', async () => {
    chat.push(user('继续。'));
    emit('USER_MESSAGE_RENDERED');
    setGenerating(true);
    emit('GENERATION_STARTED', 'normal', {}, false);
    emit('GENERATION_ENDED', chat.length); // 例如别的扩展的安静生成先结束,酒馆仍处于生成状态
    await settle();
    expect(generateRaw).not.toHaveBeenCalled();
    chat.push(ai('他们沿着河岸走到渡口。'));
    emit('GENERATION_ENDED', chat.length);
    setGenerating(false);
    await settle();
    expect(generateRaw).toHaveBeenCalledTimes(1);
    expect(leafOf(1)?.text).toBe('林舟推门出发。');
  });

  it('切换聊天后不再补推迟的摘要', async () => {
    chat.push(user('继续。'));
    emit('USER_MESSAGE_RENDERED');
    emit('CHAT_CHANGED');
    emit('GENERATION_ENDED', chat.length);
    await settle();
    expect(generateRaw).not.toHaveBeenCalled();
  });

  it('指派了副 API 渠道时照旧：发消息时就在后台摘上一条回复', async () => {
    const send = vi.spyOn(client, 'requestCompletion').mockResolvedValue(ok('林舟推门出发。'));
    channelFor.mockReturnValue({
      id: 'channel', name: '摘要渠道', url: 'https://relay.example/v1', key: 'k', model: 'm', temperature: 1,
      maxTokens: 4096, timeoutSec: 60, stream: false, prefill: false, excludeParams: [], reasoningEffort: '',
    } as ApiChannel);
    chat.push(user('继续。'));
    emit('USER_MESSAGE_RENDERED');
    setGenerating(true);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(generateRaw).not.toHaveBeenCalled();
    expect(leafOf(1)?.text).toBe('林舟推门出发。');
    send.mockRestore();
  });
});

describe('脚本重绘楼层时合并重算', () => {
  it('连发的回复渲染事件只重算一次派生缓存', async () => {
    const before = derivedMeta.rev;
    for (let i = 0; i < 50; i++) emit('CHARACTER_MESSAGE_RENDERED', 1);
    expect(derivedMeta.rev).toBe(before);
    await vi.advanceTimersByTimeAsync(RENDERED_RECOMPUTE_DELAY_MS);
    expect(derivedMeta.rev).toBe(before + 1);
  });
});
