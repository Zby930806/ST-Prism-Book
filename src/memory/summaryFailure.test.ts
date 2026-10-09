import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import { classifyHttpFailure, truncatedReply } from '@/api/errors';
import type { ApiChannel } from '@/api/settings';
import type { STContext, STMessage } from '@/st/context';
import { checkResummary, currentSummaryPromise, engineState, summarizeFloor } from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

const saved = JSON.stringify(settings.apiSettings);
const channel: ApiChannel = {
  id: 'main-channel', name: '主力', url: 'https://relay.example/v1', key: 'k', model: 'm', temperature: 1,
  maxTokens: 4096, timeoutSec: 60, stream: false, prefill: true, excludeParams: [], reasoningEffort: '',
};
const ai = (text: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra: {} });
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ok = (summary: string) => JSON.stringify({ summary, stateChanges: [] });
let chat: STMessage[];

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 2, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  chat = [user('出发吧。'), ai('林舟推开门，雨已经停了。')];
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'failure-test', chatMetadata: {},
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  recomputeDerived();
  Object.assign(engineState, { lastError: '', lastFailure: null });
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

function useChannel() {
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(channel);
  return vi.spyOn(client, 'requestCompletion');
}
function useMainApi() {
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  return vi.spyOn(client, 'requestViaMainApi');
}

describe('摘要失败说清楚原因和去哪里改', () => {
  it('副 API 截断：说明是哪一楼、被截断、当前上限和渠道位置，不重复请求', async () => {
    const send = useChannel().mockRejectedValue(truncatedReply({ finishReason: 'length', maxTokens: 4096 }, '{"summary":"林舟推开'));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(engineState.lastError).toContain('楼层 #1 摘要未完成：回复被截断');
    expect(engineState.lastError).toContain('当前最大输出是 4096 tokens');
    expect(engineState.lastError).toContain('「设置 → 副 API → 主力」');
    expect(engineState.lastFailure).toMatchObject({ message: engineState.lastError, detail: expect.stringContaining('finish_reason=length') });
    expect(chat[1].extra?.bbs_leaf).toBeUndefined();
  });

  it('截断发生在完整 JSON 之后时照常保存结果', async () => {
    useChannel().mockRejectedValue(truncatedReply({ finishReason: 'length', maxTokens: 4096 }, ok('林舟推门出发。') + '\n补充说明写到一半'));
    await summarizeFloor(1);
    expect(engineState.lastError).toBe('');
    expect(chat[1].extra?.bbs_leaf).toMatchObject({ text: '林舟推门出发。' });
  });

  it('主 API 拿不到结束原因：从半截 JSON 判断为截断，并建议改用可设上限的副 API', async () => {
    const send = useMainApi().mockResolvedValue('<thinking>核对完毕</thinking>{"summary":"林舟推开门，雨');
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(engineState.lastError).toContain('楼层 #1 摘要未完成：回复不完整（JSON 写到一半就结束了）');
    expect(engineState.lastError).toContain('副 API');
  });

  it('密钥错误不重试；服务端临时故障按设置重试', async () => {
    const send = useChannel().mockRejectedValue(classifyHttpFailure({ status: 401 }));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(engineState.lastError).toContain('楼层 #1 摘要未完成：API 密钥无效或没有权限（HTTP 401）');
    send.mockReset().mockRejectedValueOnce(classifyHttpFailure({ status: 503 })).mockResolvedValueOnce(ok('林舟出发。'));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toBe('');
    expect(chat[1].extra?.bbs_leaf).toMatchObject({ text: '林舟出发。' });
  });

  it('模型拒答（没有 JSON）仍走校验纠错，最后说明没有按格式输出', async () => {
    settings.apiSettings.summaryMaxRetries = 1;
    const send = useMainApi().mockResolvedValue('抱歉，我无法总结这段内容。');
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].some(m => m.content.includes('上一次摘要结果未通过校验'))).toBe(true);
    expect(engineState.lastError).toContain('楼层 #1 摘要未保存');
    expect(engineState.lastFailure).toBeNull();
  });
});

describe('总结失败的说明', () => {
  beforeEach(() => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, leafKeepRecent: 0, summaryMaxRetries: 0 });
    chat.splice(0, chat.length, ai('第一楼'), ai('第二楼'));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: 'leaf-' + i, text: '摘要' + i, delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
  });

  it.each([
    ['好的，我来总结。', '总结失败：模型没有按要求输出 JSON'],
    ['{"summary":"两楼合在一起写到一半', '总结未完成：回复不完整（JSON 写到一半就结束了）'],
  ])('%s', async (reply, expected) => {
    useMainApi().mockResolvedValue(reply);
    expect(await checkResummary()).toBe(0);
    expect(engineState.lastError).toContain(expected);
    expect(memory.summaries).toHaveLength(0);
  });
});
