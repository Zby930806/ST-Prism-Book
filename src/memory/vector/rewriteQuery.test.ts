import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext } from '@/st/context';

const mocks = vi.hoisted(() => ({
  ctx: null as unknown as STContext,
  settings: {
    vector: {
      embedding: { url: 'https://example.test/v1', key: 'k', model: 'emb', timeoutSec: 10, retries: 1 },
      rerank: { url: '', key: '', model: 'rr', timeoutSec: 20, retries: 1 },
      queryRewrite: { url: '', key: '', model: 'chat-model', timeoutSec: 90, retries: 1 },
      queryRewriteMaxTokens: 8192,
      queryRewriteJailbreak: false,
    },
  },
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.ctx }));
vi.mock('@/api/settings', () => ({
  apiSettings: mocks.settings,
  resolveVectorModel: (role: 'embedding' | 'rerank' | 'queryRewrite') => {
    const v = mocks.settings.vector;
    const cfg = v[role];
    return { url: cfg.url || v.embedding.url, key: cfg.key || v.embedding.key, model: cfg.model, timeoutSec: cfg.timeoutSec, retries: cfg.retries };
  },
}));
vi.mock('../apply', () => ({
  deriveMemory: () => ({ protagonist: {}, items: [], npcs: [], plans: [] }),
  getLeaf: () => null,
  leafValid: () => false,
}));
vi.mock('../engine', () => ({ resolveKeepStart: () => 0 }));
vi.mock('../inject', () => ({ renderHistoryNodes: () => '', selectHistoryNodesBefore: () => [] }));
vi.mock('../prompts', () => ({
  fmtItems: () => '', fmtNpcs: () => '', fmtPlans: () => '', fmtProtagonist: () => '',
  QUERY_REWRITE_SYSTEM: '系统提示', QUERY_REWRITE_TAIL: '收尾提示',
}));
vi.mock('../store', () => ({ memory: { summaries: [] } }));
vi.mock('../timeTag', () => ({ cleanBody: (s: string) => s }));
vi.mock('@/memory/taskContext', () => ({ taskContextPrompt: () => '' }));

import { parseResponse, resetRewriteParamMemory, rewriteQuery } from './rewrite';

const reply = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason: 'stop' }] }), { status: 200 });
const rejected = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;

describe('查询重写的解析', () => {
  it('认出加粗、标题、引用、编号等 Markdown 写法', () => {
    expect(parseResponse('**INTENT:** 需要回忆甲乙的约定\n**Q:** 甲乙约定的内容')).toMatchObject({
      intent: '需要回忆甲乙的约定', queries: ['甲乙约定的内容'],
    });
    expect(parseResponse('### INTENT: 意图\n### Q: 标题写法').queries).toEqual(['标题写法']);
    expect(parseResponse('> Q：引用写法\n- **Q1**: 加粗编号\nQ2. 句点编号\nQ3、顿号编号\n1. Q: 列表编号').queries)
      .toEqual(['引用写法', '加粗编号', '句点编号', '顿号编号', '列表编号']);
    expect(parseResponse('INTENT: *意图*\nQ: **查询**')).toMatchObject({ intent: '意图', queries: ['查询'] });
  });

  it('普通文字行不会被当成查询', () => {
    expect(parseResponse('Quick note: 这不是查询\nQueue 里没有东西').queries).toEqual([]);
  });

  it('闭合的思考块整段去掉;只有结尾标签时它之前都算思考', () => {
    expect(parseResponse('<think>INTENT: 思考里的\nQ: 思考里的</think>\nQ: 正文里的').queries).toEqual(['正文里的']);
    const onlyClose = parseResponse('先想一想 Q: 假的\n</think>\nINTENT: 真的意图\nQ: 真的查询');
    expect(onlyClose).toMatchObject({ intent: '真的意图', queries: ['真的查询'], thinkingOnly: false });
  });

  it('思考块没有闭合时按没有正文处理', () => {
    const out = parseResponse('<think>\n分析中……\nQ: 思考里的查询');
    expect(out.queries).toEqual([]);
    expect(out.thinkingOnly).toBe(true);
    expect(parseResponse('INTENT: 先写的意图\nQ: 先写的查询\n<think>还在想').queries).toEqual(['先写的查询']);
  });

  it('INTENT 超长时清空并记下;Q 超长整条丢弃并计数', () => {
    const out = parseResponse(`INTENT: ${'意'.repeat(401)}\nQ: ${'长'.repeat(221)}\nQ: 正常的查询`);
    expect(out).toMatchObject({ intent: '', intentDropped: true, queries: ['正常的查询'], queryLines: 2, droppedLong: 1 });
  });
});

describe('查询重写请求', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetRewriteParamMemory();
    mocks.ctx = { chat: [{ name: 'User', is_user: true, is_system: false, mes: '还记得那个约定吗？' }] } as unknown as STContext;
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 90, retries: 1 });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('enable_thinking 被拒收时去掉它重试一次,并在本次会话内记住这个地址', async () => {
    fetchMock
      .mockResolvedValueOnce(rejected(400, 'Unrecognized request argument supplied: enable_thinking'))
      .mockResolvedValueOnce(reply('INTENT: 意图\nQ: 查询'))
      .mockResolvedValueOnce(reply('INTENT: 意图\nQ: 第二次'));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '意图', queries: ['查询'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 0)).toMatchObject({ enable_thinking: false, top_p: 0.8 });
    expect(sentBody(fetchMock, 1)).not.toHaveProperty('enable_thinking');
    expect(sentBody(fetchMock, 1)).toHaveProperty('top_p', 0.8);
    await rewriteQuery();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('enable_thinking');
  });

  it('两个可选参数先后被拒收时各去掉一次', async () => {
    fetchMock
      .mockResolvedValueOnce(rejected(400, 'unknown parameter: enable_thinking'))
      .mockResolvedValueOnce(rejected(422, 'top_p is not supported for this model'))
      .mockResolvedValueOnce(reply('Q: 查询'));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '', queries: ['查询'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('enable_thinking');
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('top_p');
  });

  it('报错与可选参数无关时直接报错,不重试', async () => {
    fetchMock.mockResolvedValueOnce(rejected(400, 'The model `chat-model` does not exist'));
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('超时后不再重试', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 1, retries: 2 });
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('服务商出错时仍按重试次数重试', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(reply('Q: 查询'));
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ intent: '', queries: ['查询'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['<think>\n分析……\nQ: 思考里的', /只有思考过程/],
    ['好的，我来帮你找找。', /没有检索语句（需要以「Q:」开头的行）/],
    [`Q: ${'长'.repeat(230)}`, /都超过 220 字/],
  ])('没有可用检索语句时按原因报错:%s', async (content, message) => {
    fetchMock.mockResolvedValueOnce(reply(content));
    await expect(rewriteQuery()).rejects.toThrow(message);
  });

  it('正文为空、只有思考内容时说明原因', async () => {
    fetchMock.mockResolvedValueOnce(reply('', { reasoning_content: '想了很久' }));
    await expect(rewriteQuery()).rejects.toThrow(/只输出了思考过程/);
  });

  it('记下请求规模:发送字数、token 用量和是否带了思考内容', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'INTENT: 意图\nQ: 查询', reasoning_content: '先想想' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 40 } },
    }), { status: 200 }));
    const result = await rewriteQuery();
    expect(result.stats).toMatchObject({ promptTokens: 1200, completionTokens: 80, reasoningTokens: 40, thinking: true, trimmed: false });
    expect(result.stats!.inputChars).toBeGreaterThan(0);

    fetchMock.mockResolvedValueOnce(reply('INTENT: 意图\nQ: 查询'));
    const plain = (await rewriteQuery()).stats!;
    expect(plain.thinking).toBe(false);
    expect(plain.promptTokens).toBeUndefined();
  });

  const hangUntilAborted = (signals: AbortSignal[]) => (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signals.push(init.signal!);
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

  it('第一次请求 12 秒还没返回时补发一次,先返回的算数,另一个取消', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementationOnce(hangUntilAborted(signals)).mockResolvedValueOnce(reply('INTENT: 意图\nQ: 补发的查询'));
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(11000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.queries).toEqual(['补发的查询']);
    expect(result.stats?.hedged).toBe(true);
    expect(signals[0].aborted).toBe(true);
  });

  it('补发后两次都失败才报错;外部取消时两次都取消', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20, retries: 0 });
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(hangUntilAborted(signals));
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(20000); // 第一次超时,补发的那次还在等
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12000); // 补发的那次也超时
    await check;

    const external = new AbortController();
    const cancelled = rewriteQuery(external.signal);
    const checkCancel = expect(cancelled).rejects.toThrow(/已取消/);
    await vi.advanceTimersByTimeAsync(12000);
    external.abort();
    await checkCancel;
    expect(signals.slice(-2).every(s => s.aborted)).toBe(true);
  });
});
