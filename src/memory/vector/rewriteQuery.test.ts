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
      queryRewriteRoute: 'direct' as 'backend' | 'direct' | undefined,
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

import {
  assembleReply, isLocalAddress, parseResponse, resetRewriteParamMemory, REWRITE_DIRECT_RETRY_AFTER_MS, REWRITE_OTHER_ROUTE_TIMEOUT_SEC, rewriteQuery,
} from './rewrite';

const BACKEND = '/api/backends/chat-completions/generate';
const DIRECT = 'https://example.test/v1/chat/completions';
const HOST_HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' };

const reply = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason: 'stop' }] }), { status: 200 });
const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };
/** 服务商的报错(浏览器直连拿到的那种,带 Content-Type)。 */
const rejected = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: JSON_TYPE });
/**
 * 酒馆流式转发时原样转来的服务商回复:只有状态码、状态说明和正文,没有 Content-Type(构造时自动补上的要删掉)。
 * 服务商的 401 会被酒馆改成 400,状态说明不变。
 */
const relayed = (status: number, body: unknown, statusText = '') => {
  const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText });
  response.headers.delete('content-type');
  return response;
};
const relayedError = (status: number, message: string, statusText = '') => relayed(status, { error: { message } }, statusText);
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;
const sentUrls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(call => String(call[0]));
/** 流式回复:每段正文一条 data 行,最后一条带结束原因(和 token 用量),以 [DONE] 结束。 */
const sse = (pieces: string[], opts: { usage?: Record<string, unknown>; finish?: string; reasoning?: string[] } = {}) => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const lines = [
    chunk({ role: 'assistant', content: '' }),
    ...(opts.reasoning ?? []).map(r => chunk({ reasoning_content: r })),
    ...pieces.map(p => chunk({ content: p })),
    chunk({}, opts.finish ?? 'stop', opts.usage ? { usage: opts.usage } : {}),
    'data: [DONE]\n\n',
  ];
  return relayed(200, lines.join(''), 'OK');
};
/** 酒馆非流式转发时把上游的报错改写成 200 加状态说明(总带着 quota_error 字段)。 */
const envelope = (statusText: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { message: statusText }, quota_error: false, ...extra }), { status: 200, headers: JSON_TYPE });
/** 酒馆用 send / sendStatus 生成的响应都带 ETag(转发来的没有)。 */
const HOST_ETAG = { ETag: 'W/"2f-prismTestEtag"' };
/** 酒馆发请求或读回复时自己出的错:502 加错误对象。给了 code 就是请求库(node-fetch)报的连接错误的样子:type 为 system,带 errno 和 code。 */
const hostError = (message: string, code?: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { message, ...(code ? { type: 'system', errno: code, code } : {}), ...extra } }), { status: 502, statusText: 'Bad Gateway', headers: { ...JSON_TYPE, ...HOST_ETAG } });
const refused = () => hostError(`Connection refused: request to ${DIRECT} failed, reason: connect ECONNREFUSED 203.0.113.9:443`, 'ECONNREFUSED');
const hangUntilAborted = (signals: AbortSignal[] = []) => (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  signals.push(init.signal!);
  init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
/** 恢复被个别测试改过的设置。 */
function resetSettings(route: 'backend' | 'direct', retries: number): void {
  const v = mocks.settings.vector;
  v.embedding.url = 'https://example.test/v1';
  Object.assign(v.queryRewrite, { url: '', key: '', model: 'chat-model', timeoutSec: 90, retries });
  v.queryRewriteRoute = route;
}

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

describe('查询重写请求(浏览器直连)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetRewriteParamMemory();
    mocks.ctx = { chat: [{ name: 'User', is_user: true, is_system: false, mes: '还记得那个约定吗？' }], getRequestHeaders: () => HOST_HEADERS } as unknown as STContext;
    resetSettings('direct', 1);
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
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：模型不存在，或当前密钥不能使用这个模型（HTTP 400）[\s\S]*does not exist/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['嵌在 JSON 里', JSON.stringify({ detail: [{ type: 'missing', loc: ['body', 'messages', 0, 'name'], msg: 'Field required', input: { model: 'chat-model', stream: false, top_p: 0.8, enable_thinking: false } }] })],
    ['转义过的 JSON', JSON.stringify({ error: { message: `Invalid request body: ${JSON.stringify({ model: 'chat-model', stream: false, top_p: 0.8, enable_thinking: false })}` } })],
    ['Python 字典的写法', JSON.stringify({ error: { message: "Invalid request: {'model': 'chat-model', 'stream': False, 'top_p': 0.8, 'enable_thinking': False}" } })],
  ])('报错里回显的请求体(%s)不算点了参数的名', async (_name, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 422, headers: JSON_TYPE }));
    await expect(rewriteQuery()).rejects.toThrow(/HTTP 422/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('回显之外另有点名的照样去掉:和发出去的值不一样的键值不算回显', async () => {
    fetchMock
      .mockResolvedValueOnce(rejected(400, 'Invalid request {"model": "chat-model", "stream": false, "top_p": 0.8}: unknown field `enable_thinking`'))
      .mockResolvedValueOnce(rejected(400, 'Bad request {"model": "chat-model", "stream": false}. Expected "top_p": 1 for this model'))
      .mockResolvedValueOnce(reply('Q: 查询'));
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(sentBody(fetchMock, 1)).not.toHaveProperty('enable_thinking');
    expect(sentBody(fetchMock, 1)).toHaveProperty('top_p', 0.8);
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('top_p');
  });

  it('回显的 top_p 被服务端换了一种写法(0.800000011920929)也认得', async () => {
    fetchMock.mockResolvedValueOnce(rejected(400, 'Bad request body: {"model": "chat-model", "top_p": 0.800000011920929, "stream": false}'));
    await expect(rewriteQuery()).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Invalid parameter: "enable_thinking": false is not supported by this model', ['enable_thinking']],
    ["Unsupported parameters: {'enable_thinking': False}", ['enable_thinking']],
    ['Unrecognized request arguments supplied: {"enable_thinking":false,"top_p":0.8}', ['enable_thinking', 'top_p']],
  ])('只列出被拒的键值(%s)不是回显,照样算点名:去掉再发', async (message, removed) => {
    fetchMock.mockResolvedValueOnce(rejected(400, message)).mockResolvedValueOnce(reply('Q: 查询'));
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const param of ['enable_thinking', 'top_p']) {
      if (removed.includes(param)) expect(sentBody(fetchMock, 1), param).not.toHaveProperty(param);
      else expect(sentBody(fetchMock, 1), param).toHaveProperty(param);
    }
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

  it('只由浏览器发出,不经酒馆后端;连不上时提示可以改走酒馆后端', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/浏览器无法访问这个地址[\s\S]*「请求方式」改成「酒馆后端转发」/);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(sentUrls(fetchMock)).toEqual([DIRECT, DIRECT]);
  });

  it('本机或局域网地址不补发', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.embedding.url = 'http://127.0.0.1:11434/v1';
    fetchMock.mockImplementation(hangUntilAborted());
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    await check;
    expect(sentUrls(fetchMock)).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);
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
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    const check = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(20000); // 第一次超时,补发的那次还在等
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false); // 还有一个请求在等,不报错
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

describe('流式回复的还原', () => {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}`;

  it('逐行读 data,拼接正文,取最后的结束原因和 token 用量;读到 [DONE] 为止', () => {
    const text = [
      ': keep-alive',
      'event: message',
      chunk({ role: 'assistant', content: '' }),
      '',
      chunk({ content: null }),
      chunk({ content: 'INTENT: 意图\n' }),
      'data: 这一行不是 JSON',
      chunk({ content: [{ type: 'text', text: 'Q: ' }, '查询'] }),
      `data:${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
      chunk({}, {}, 'stop'),
      'data: [DONE]',
      chunk({ content: '结束之后的内容不算' }),
    ].join('\r\n');
    expect(assembleReply(text)).toEqual({
      reply: { choices: [{ message: { content: 'INTENT: 意图\nQ: 查询' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    });
  });

  it('思考内容单独记下(reasoning_content 或 reasoning),不混进正文', () => {
    const text = [chunk({ reasoning_content: '先想' }), chunk({ reasoning: '再想' }), chunk({ content: 'Q: 查询' }, {}, 'stop')].join('\n\n');
    expect(assembleReply(text)).toEqual({
      reply: { choices: [{ message: { content: 'Q: 查询', reasoning_content: '先想再想' }, finish_reason: 'stop' }], usage: undefined },
    });
  });

  it('补全接口的写法(choices[0].text)和 native_finish_reason 也认', () => {
    const text = `data: ${JSON.stringify({ choices: [{ text: 'Q: 查询' }] })}\n\ndata: ${JSON.stringify({ choices: [{ text: '', native_finish_reason: 'STOP' }] })}\n\n`;
    expect(assembleReply(text)).toEqual({ reply: { choices: [{ message: { content: 'Q: 查询' }, finish_reason: 'STOP' }], usage: undefined } });
  });

  it('最后一块把全文放进 message 再发一遍时不重复追加;只有一块、全文在 message 里时照常取', () => {
    const repeated = [chunk({ content: 'Q: 一' }), chunk({ content: '二' }), `data: ${JSON.stringify({ choices: [{ message: { content: 'Q: 一二' }, finish_reason: 'stop' }] })}`].join('\n\n');
    expect(assembleReply(repeated)).toMatchObject({ reply: { choices: [{ message: { content: 'Q: 一二' }, finish_reason: 'stop' }] } });
    const single = `data: ${JSON.stringify({ choices: [{ message: { content: 'Q: 整段' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n`;
    expect(assembleReply(single)).toMatchObject({ reply: { choices: [{ message: { content: 'Q: 整段' } }] } });
  });

  it('既没有结束原因也没有 [DONE]:标记为没有结束标记;有其中一个就不标', () => {
    const body = [chunk({ content: 'Q: 第一条\nQ: 写到一' })].join('\n\n');
    expect(assembleReply(body)).toMatchObject({ incomplete: 'unmarked', reply: { choices: [{ message: { content: 'Q: 第一条\nQ: 写到一' } }] } });
    expect(assembleReply(`${body}\n\ndata: [DONE]\n`)).not.toHaveProperty('incomplete');
    expect(assembleReply(`${body}\n\n${chunk({}, {}, 'stop')}\n`)).not.toHaveProperty('incomplete');
    // 最后一块 finish_reason 为 null、但有 [DONE]
    expect(assembleReply(`${chunk({ content: 'Q: 完整的' })}\n\ndata: [DONE]\n`)).toEqual({ reply: { choices: [{ message: { content: 'Q: 完整的' }, finish_reason: undefined }], usage: undefined } });
  });

  it('最后一条 data 行的 JSON 没写完就断了:标记为中断;中间有读不成的行、后面照常结束的不标', () => {
    const half = `${chunk({ content: 'Q: 第一条\n' })}\n\ndata: {"choices":[{"delta":{"content":"Q: 写到`;
    expect(assembleReply(half)).toMatchObject({ incomplete: 'cut', reply: { choices: [{ message: { content: 'Q: 第一条\n' } }] } });
    // 第一条 data 行就没写完
    expect(assembleReply('data: {"choices":[{"delta":{"content":"IN')).toEqual({ incomplete: 'cut', reply: { choices: [{ message: { content: '' }, finish_reason: undefined }], usage: undefined } });
    // 半截的一行之后还有完整的块和结束原因:不算中断
    const recovered = `data: {"choices":[{"delta":\n\n${chunk({ content: 'Q: 查询' }, {}, 'stop')}\n`;
    expect(assembleReply(recovered)).toEqual({ reply: { choices: [{ message: { content: 'Q: 查询' }, finish_reason: 'stop' }], usage: undefined } });
    // 半截的一行之后还有完整的块,但没有结束标记:按没有结束标记算,不算最后一块没写完
    expect(assembleReply(`data: {"choices":[{"delta":\n\n${chunk({ content: 'Q: 查询' })}\n`)).toMatchObject({ incomplete: 'unmarked' });
  });

  it('只有 [DONE]:是流式格式但没有内容,按空回复而不是无效数据', () => {
    expect(assembleReply('data: [DONE]\n\n')).toEqual({ reply: { choices: [{ message: { content: '' }, finish_reason: undefined }], usage: undefined } });
  });

  it.each([
    ['只有心跳注释', ': ping\n\n: ping\n\n'],
    ['data 行都读不成 JSON', 'data: 不是 JSON\n\n'],
  ])('%s:是流式格式但没有内容也没有结束标记,不算无效数据', (_name, text) => {
    expect(assembleReply(text)).toEqual({ incomplete: 'unmarked', reply: { choices: [{ message: { content: '' }, finish_reason: undefined }], usage: undefined } });
  });

  it('流里带着报错时返回报错和那一段原文;error 为空或带着正常回复的不算', () => {
    const payload = '{"error":{"message":"rate limit reached"}}';
    expect(assembleReply(`${chunk({ content: 'Q: 一半' })}\n\ndata: ${payload}\n\ndata: [DONE]\n`)).toEqual({ error: { error: { message: 'rate limit reached' } }, raw: payload });
    const harmless = [
      `data: ${JSON.stringify({ error: null, choices: [{ delta: { content: 'Q: 一' } }] })}`,
      `data: ${JSON.stringify({ error: {}, choices: [{ delta: { content: '二' } }] })}`,
      `data: ${JSON.stringify({ error: {} })}`,
      `data: ${JSON.stringify({ error: { message: '不该当成报错' }, choices: [{ delta: { content: '三' }, finish_reason: 'stop' }] })}`,
    ].join('\n\n');
    expect(assembleReply(harmless)).toMatchObject({ reply: { choices: [{ message: { content: 'Q: 一二三' } }] } });
  });

  it('流中途出错的一块同时带着 error 和「出错」一类的结束原因:按报错处理,不把写到一半的正文当成回复', () => {
    const failed = JSON.stringify({ id: 'c1', error: { code: 'server_error', message: 'Provider disconnected unexpectedly' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
    expect(assembleReply(`${chunk({ content: 'Q: 第一条\nQ: 写到一' })}\n\ndata: ${failed}\n\ndata: [DONE]\n`)).toEqual({ error: JSON.parse(failed), raw: failed });
    const native = JSON.stringify({ error: { message: 'out of capacity' }, choices: [{ delta: {}, native_finish_reason: 'insufficient_system_resource' }] });
    expect(assembleReply(`data: ${native}\n\n`)).toEqual({ error: JSON.parse(native), raw: native });
    // 只有结束原因、没有 error:照常返回,结束原因留给调用方判断
    expect(assembleReply(`${chunk({ content: 'Q: 一' })}\n\n${chunk({}, {}, 'error')}\n\ndata: [DONE]\n`)).toEqual({ reply: { choices: [{ message: { content: 'Q: 一' }, finish_reason: 'error' }], usage: undefined } });
    // error 是空对象的不算
    const empty = JSON.stringify({ error: {}, choices: [{ delta: { content: 'Q: 二' }, finish_reason: 'error' }] });
    expect(assembleReply(`data: ${empty}\n\n`)).toMatchObject({ reply: { choices: [{ message: { content: 'Q: 二' }, finish_reason: 'error' }] } });
  });

  it('event: error 之后的那条 data 当成报错,即使里面没有 error 字段', () => {
    const payload = '{"type":"overloaded_error","message":"Overloaded"}';
    expect(assembleReply(`event: error\ndata: ${payload}\n\n`)).toEqual({ error: { error: { type: 'overloaded_error', message: 'Overloaded' } }, raw: payload });
    // 空行之后事件名作废
    expect(assembleReply(`event: error\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'Q: 查询' }, finish_reason: 'stop' }] })}\n\n`)).toMatchObject({ reply: {} });
  });

  it('没有 data 行时按整段 JSON 处理:回复原样返回,带 error 的算报错;前面有心跳注释也一样', () => {
    const whole = { choices: [{ message: { content: 'Q: 查询' }, finish_reason: 'stop' }] };
    expect(assembleReply(JSON.stringify(whole))).toEqual({ reply: whole });
    expect(assembleReply(JSON.stringify(whole, null, 2))).toEqual({ reply: whole });
    expect(assembleReply(`: ping\n\n${JSON.stringify(whole)}`)).toEqual({ reply: whole });
    const failed = JSON.stringify({ error: { message: 'Bad Request' }, quota_error: false });
    expect(assembleReply(failed)).toEqual({ error: { error: { message: 'Bad Request' }, quota_error: false }, raw: failed });
    expect(assembleReply(`: ping\n\n${failed}`)).toEqual({ error: { error: { message: 'Bad Request' }, quota_error: false }, raw: failed });
    // 既有 error 又有正常回复的整段 JSON 算回复(与浏览器直连的判断一致)
    const both = { error: { message: 'warning' }, choices: [{ message: { content: 'Q: 查询' } }] };
    expect(assembleReply(JSON.stringify(both))).toEqual({ reply: both });
  });

  it('正文之后跟着一段不带 data 前缀的报错:按报错处理', () => {
    const failed = '{"error":{"message":"upstream closed"}}';
    expect(assembleReply(`${chunk({ content: 'Q: 一半' })}\n\n${failed}\n`)).toEqual({ error: { error: { message: 'upstream closed' } }, raw: failed });
  });

  it.each(['', '<html><body>首页</body></html>', '"只是一个字符串"', '123', 'null', '[1,2]'])('不是有效数据时返回 null:%s', text => {
    expect(assembleReply(text)).toBeNull();
  });
});

describe('查询重写请求(经酒馆后端转发)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetRewriteParamMemory();
    mocks.ctx = { chat: [{ name: 'User', is_user: true, is_system: false, mes: '还记得那个约定吗？' }], getRequestHeaders: () => HOST_HEADERS } as unknown as STContext;
    resetSettings('backend', 0);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const backendBodies = () => fetchMock.mock.calls
    .filter(call => String(call[0]) === BACKEND)
    .map(call => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
  const failureOf = () => rewriteQuery().then(() => null, (e: Error) => e);
  /** 后端依次返回 backend 里的响应,直连依次返回 direct 里的;用完之后再有请求就报错。 */
  const routed = (backend: Array<() => Response>, direct: Array<(() => Response) | Error> = []) => {
    let b = 0, d = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const step = String(url) === BACKEND ? backend[b++] : direct[d++];
      if (!step) throw new Error(`没有预料到的请求：${String(url)}`);
      if (step instanceof Error) throw step;
      return step();
    });
  };

  it('请求发给酒馆后端:custom 源,流式传输,密钥放在附加请求头里,enable_thinking 放在附加请求体里', async () => {
    fetchMock.mockResolvedValueOnce(sse(['INTENT: 意图\n', 'Q: 查询']));
    const result = await rewriteQuery();
    expect(result).toMatchObject({ intent: '意图', queries: ['查询'] });
    expect(result.stats).toMatchObject({ route: 'backend', fellBack: false, hedged: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BACKEND);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(HOST_HEADERS);
    const body = sentBody(fetchMock, 0);
    expect(body).toMatchObject({
      chat_completion_source: 'custom', custom_url: 'https://example.test/v1',
      model: 'chat-model', temperature: 0.1, top_p: 0.8, max_tokens: 8192, stream: true, tool_choice: 'none',
    });
    expect(JSON.parse(String(body.custom_include_headers))).toEqual({ Authorization: 'Bearer k' });
    expect(JSON.parse(String(body.custom_include_body))).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty('enable_thinking');
    expect(body).not.toHaveProperty('reverse_proxy');
    expect(body).not.toHaveProperty('proxy_password');
    // 最后一楼是用户发言:收尾提示并进这一条,末尾不是相邻的两条 user
    expect(body.messages).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '还记得那个约定吗？\n\n收尾提示' },
    ]);
  });

  it('两种请求方式发出的消息相同:开头一条 system,之后 user、assistant 交替', async () => {
    mocks.ctx = {
      chat: [
        { name: 'Char', is_user: false, is_system: false, mes: '开场白' },
        { name: 'User', is_user: true, is_system: false, mes: '第一句' },
        { name: 'User', is_user: true, is_system: false, mes: '第二句' },
      ],
      getRequestHeaders: () => HOST_HEADERS,
    } as unknown as STContext;
    fetchMock.mockResolvedValueOnce(sse(['Q: 查询']));
    await rewriteQuery();
    resetSettings('direct', 0);
    fetchMock.mockResolvedValueOnce(reply('Q: 查询'));
    await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    const expected = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '[最近对话开始]' },
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: '第一句\n\n第二句\n\n收尾提示' },
    ];
    expect(sentBody(fetchMock, 0).messages).toEqual(expected);
    expect(sentBody(fetchMock, 1).messages).toEqual(expected);
  });

  it.each([undefined, '', 'Backend', 'proxy', null, true])('没有保存过请求方式的旧设置、认不出的值(%j)都按浏览器直连:只由浏览器发出,连不上也不改走酒馆后端', async value => {
    (mocks.settings.vector as { queryRewriteRoute: unknown }).queryRewriteRoute = value;
    fetchMock.mockResolvedValueOnce(reply('Q: 查询'));
    const result = await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([DIRECT]);
    expect(sentBody(fetchMock, 0)).toMatchObject({ stream: false, enable_thinking: false, top_p: 0.8 });
    expect(result.stats).toMatchObject({ route: 'direct', fellBack: false });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const failure = await failureOf();
    expect(failure?.message).toMatch(/浏览器无法访问这个地址[\s\S]*「请求方式」改成「酒馆后端转发」/);
    expect(sentUrls(fetchMock)).toEqual([DIRECT]);
  });

  it('明确设成酒馆后端转发才经后端发出', async () => {
    mocks.settings.vector.queryRewriteRoute = 'backend';
    fetchMock.mockResolvedValueOnce(reply('Q: 查询'));
    await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('地址写到 /chat/completions 或以 / 结尾时,交给酒馆的是基础地址;密钥为空也带上请求头', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'https://other.test/v1/chat/completions/', key: 'k2' });
    fetchMock.mockImplementation(async () => reply('Q: 查询'));
    await rewriteQuery();
    expect(sentBody(fetchMock, 0)).toMatchObject({ custom_url: 'https://other.test/v1' });
    expect(JSON.parse(String(sentBody(fetchMock, 0).custom_include_headers))).toEqual({ Authorization: 'Bearer k2' });

    mocks.settings.vector.embedding.key = '';
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1', key: '' });
    try {
      await rewriteQuery();
    } finally {
      mocks.settings.vector.embedding.key = 'k';
    }
    expect(sentBody(fetchMock, 1)).toMatchObject({ custom_url: 'http://127.0.0.1:11434/v1' });
    expect(JSON.parse(String(sentBody(fetchMock, 1).custom_include_headers))).toEqual({ Authorization: 'Bearer ' });
  });

  it.each(['localhost:11434/v1', 'api.example.test:8443/v1', 'htp://example.test/v1'])('地址没有以 http:// 或 https:// 开头(%s):直接说明,不发请求', async url => {
    Object.assign(mocks.settings.vector.queryRewrite, { url });
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写的地址（留空时是 Embedding 的地址）要以 http:\/\/ 或 https:\/\/ 开头/);
    mocks.settings.vector.queryRewriteRoute = 'direct';
    await expect(rewriteQuery()).rejects.toThrow(/要以 http:\/\/ 或 https:\/\/ 开头/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('流式回复:各段正文拼起来解析,token 用量接口给了就记下', async () => {
    fetchMock.mockResolvedValueOnce(sse(['INTENT: 找', '那个约定\nQ: 约定', '的内容\nQ: 第二条'], { usage: { prompt_tokens: 1200, completion_tokens: 80 } }));
    const result = await rewriteQuery();
    expect(result).toMatchObject({ intent: '找那个约定', queries: ['约定的内容', '第二条'] });
    expect(result.stats).toMatchObject({ promptTokens: 1200, completionTokens: 80, thinking: false, route: 'backend' });

    fetchMock.mockResolvedValueOnce(sse(['Q: 没有用量']));
    const plain = (await rewriteQuery()).stats!;
    expect(plain.promptTokens).toBeUndefined();
    expect(plain.completionTokens).toBeUndefined();
    expect(plain.thinking).toBe(false);
  });

  it('流式回复里有思考内容时记下;只有思考、没有正文时按原因报错', async () => {
    fetchMock.mockResolvedValueOnce(sse(['Q: 查询'], { reasoning: ['先想', '一想'] }));
    expect((await rewriteQuery()).stats).toMatchObject({ thinking: true });
    fetchMock.mockResolvedValueOnce(sse([], { reasoning: ['想了很久'] }));
    await expect(rewriteQuery()).rejects.toThrow(/只输出了思考过程/);
    fetchMock.mockResolvedValueOnce(sse([], { reasoning: ['想了很久'], finish: 'length' }));
    await expect(rewriteQuery()).rejects.toThrow(/输出额度在思考阶段就用完了[\s\S]*当前最大输出是 8192 tokens/);
  });

  it('流式回复是空的:建议改成浏览器直连再试,不提查询重写没有的「流式传输」开关', async () => {
    fetchMock.mockResolvedValueOnce(sse([]));
    const failure = await failureOf();
    expect(failure?.message).toMatch(/API 返回了空内容[\s\S]*把 Query 重写的「请求方式」改成「浏览器直连」再试/);
    expect(failure?.message).not.toContain('开关');
  });

  it('流式回复没有结束标记(既没有结束原因也没有 [DONE]):内容照用,最后一行也不丢;没有可用内容时报「没有正常结束」', async () => {
    const unmarked = (content: string) => relayed(200, `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    fetchMock.mockResolvedValueOnce(unmarked('INTENT: 意图\nQ: 第一条\nQ: 第二条'));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '意图', queries: ['第一条', '第二条'] });
    fetchMock.mockResolvedValueOnce(unmarked('Q: 只有一行'));
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['只有一行'] });
    fetchMock.mockResolvedValueOnce(unmarked('INTENT: 只写了半'));
    const failure = await failureOf();
    expect(failure?.message).toMatch(/Query 重写：服务商的回复没有正常结束。可能是服务商中途中断了回复，或这个接口的流式输出不兼容[\s\S]*改成「浏览器直连」再试/);
    // 只有心跳、一条正文都没有就结束了
    fetchMock.mockResolvedValueOnce(relayed(200, ': ping\n\n: ping\n\n'));
    await expect(rewriteQuery()).rejects.toThrow(/服务商的回复没有正常结束/);
    fetchMock.mockResolvedValueOnce(unmarked('<think>还在想'));
    await expect(rewriteQuery()).rejects.toThrow(/服务商的回复没有正常结束/);
  });

  it('流式回复的最后一块没写完就断了:写到一半的最后一行不要,前面完整的照用;一行完整的都没有时报中断', async () => {
    const cut = (content: string) => relayed(200, `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: {"choices":[{"delta":{"content":"后面的`);
    fetchMock.mockResolvedValueOnce(cut('INTENT: 意图\nQ: 第一条\nQ: 第二条写到一'));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '意图', queries: ['第一条'] });
    fetchMock.mockResolvedValueOnce(cut('INTENT: 意图\nQ: 第一条\n'));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '意图', queries: ['第一条'] });
    fetchMock.mockResolvedValueOnce(cut('INTENT: 意图\nQ: 第一条写到一'));
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：服务商中途中断了回复/);
    fetchMock.mockResolvedValueOnce(relayed(200, 'data: {"choices":[{"delta":{"content":"IN'));
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：服务商中途中断了回复/);
  });

  it('结束原因是出错一类(error、insufficient_system_resource):最后一行不要;一行完整的都没有时报中断', async () => {
    fetchMock.mockResolvedValueOnce(sse(['INTENT: 意图\nQ: 第一条\n', 'Q: 第二条写到一'], { finish: 'error' }));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '意图', queries: ['第一条'] });
    fetchMock.mockResolvedValueOnce(sse(['Q: 写到一'], { finish: 'insufficient_system_resource' }));
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：服务商中途中断了回复/);
    fetchMock.mockResolvedValueOnce(sse([], { finish: 'error' }));
    await expect(rewriteQuery()).rejects.toThrow(/服务商中途中断了回复/);
    // 流中途出错的一块带着 error:按服务商的报错处理,带原话,不重试
    mocks.settings.vector.queryRewrite.retries = 2;
    const failed = { error: { code: 502, message: 'Provider disconnected unexpectedly' }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] };
    routed([() => relayed(200, `data: ${JSON.stringify({ choices: [{ delta: { content: 'Q: 写到一' } }] })}\n\ndata: ${JSON.stringify(failed)}\n\ndata: [DONE]\n\n`)]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：服务商出错（HTTP 502）[\s\S]*Provider disconnected unexpectedly/);
    expect(sentUrls(fetchMock).slice(-1)).toEqual([BACKEND]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('服务无视 stream、直接回整段 JSON 时照常解析', async () => {
    fetchMock.mockResolvedValueOnce(reply('INTENT: 意图\nQ: 查询'));
    await expect(rewriteQuery()).resolves.toMatchObject({ intent: '意图', queries: ['查询'] });
  });

  it('服务商拒绝请求时,酒馆把状态码和原话原样转来:报原话,不重试,不另发请求', async () => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([() => relayedError(400, 'The model `chat-model` does not exist', 'Bad Request')]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：模型不存在，或当前密钥不能使用这个模型（HTTP 400）[\s\S]*does not exist/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('一般的 400:说明里是查询重写的常见原因,不提副 API 渠道的设置,也不说看不到原文', async () => {
    routed([() => relayedError(400, 'something odd happened', 'Bad Request')]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/Query 重写：服务商拒绝了这次请求（HTTP 400）。常见原因是模型名不对[\s\S]*或接口不接受某个参数。（HTTP 400 · something odd happened）/);
    expect(failure?.message).not.toMatch(/副 API|预填充|看不到/);
  });

  it('带着原话的 404 按通用的说明报,不套用只有状态说明时的说法', async () => {
    routed([() => relayedError(404, 'page not found', 'Not Found')]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/Query 重写：接口地址不对（HTTP 404）[\s\S]*page not found/);
    expect(failure?.message).not.toMatch(/或模型不存在|看不到/);
  });

  it('enable_thinking 被拒收:按原文去掉再发,本次会话记住', async () => {
    routed([
      () => relayedError(400, 'Unrecognized request argument supplied: enable_thinking'),
      () => reply('Q: 查询'),
      () => reply('Q: 第二次'),
    ]);
    const first = await rewriteQuery();
    expect(first.queries).toEqual(['查询']);
    expect(first.stats).toMatchObject({ route: 'backend', fellBack: false });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
    expect(backendBodies()[0]).toHaveProperty('custom_include_body');
    expect(backendBodies()[1]).not.toHaveProperty('custom_include_body');
    expect(backendBodies()[1]).toMatchObject({ top_p: 0.8, stream: true });
    await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, BACKEND]);
    expect(backendBodies()[2]).not.toHaveProperty('custom_include_body');
  });

  it('三个可选参数先后被拒收时各去掉一次,一共发四个请求;成功之后都记住', async () => {
    routed([
      () => relayedError(400, 'unknown parameter: enable_thinking'),
      () => relayedError(422, 'top_p is not supported for this model'),
      () => relayedError(400, 'Streaming is not supported'),
      () => reply('Q: 查询'),
      () => reply('Q: 第二轮'),
    ]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(backendBodies()).toHaveLength(4);
    expect(backendBodies()[3]).not.toHaveProperty('custom_include_body');
    expect(backendBodies()[3]).not.toHaveProperty('top_p');
    expect(backendBodies()[3]).toHaveProperty('stream', false);
    await rewriteQuery();
    expect(backendBodies().map(b => [b.stream, 'custom_include_body' in b, 'top_p' in b])[4]).toEqual([false, false, false]);
  });

  it('原文同时点了可选参数的名、又提到流式传输:先去掉点名的参数,流式照用', async () => {
    routed([
      () => relayedError(400, 'Unknown parameter(s): enable_thinking. Supported: model, messages, temperature, max_tokens, stream', 'Bad Request'),
      () => sse(['Q: 查询']),
    ]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(backendBodies().map(b => [b.stream, 'custom_include_body' in b, 'top_p' in b])).toEqual([[true, true, true], [true, false, true]]);
  });

  it('去掉之后服务商仍然点同一个参数的名:不再重复发送', async () => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed(Array.from({ length: 8 }, () => () => relayedError(400, 'enable_thinking has been removed from this API', 'Bad Request')));
    await expect(rewriteQuery()).rejects.toThrow(/HTTP 400[\s\S]*enable_thinking has been removed/);
    expect(backendBodies().map(b => 'custom_include_body' in b)).toEqual([true, false]);
  });

  it('试着改用非流式的那一次酒馆服务器连不上、改由直连:直连成功不算试成功,不记「不支持流式传输」;直连带原话拒绝就报直连的', async () => {
    const noStream = () => relayedError(400, 'Streaming is not supported by this model', 'Bad Request');
    routed([noStream, refused, () => sse(['Q: 后端的查询'])], [() => reply('Q: 直连的查询'), new TypeError('Failed to fetch')]);
    expect((await rewriteQuery()).queries).toEqual(['直连的查询']);
    // 下一轮先用直连,它连不上了,回到后端:仍然先用流式
    expect((await rewriteQuery()).queries).toEqual(['后端的查询']);
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, true]);

    resetRewriteParamMemory();
    fetchMock.mockReset();
    routed([noStream, refused], [() => rejected(400, 'direct says no')]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/HTTP 400[\s\S]*direct says no/);
    expect(failure?.message).not.toMatch(/Streaming is not supported|已经试过改用非流式/);
  });

  it('状态不是 400、422 时,正文提到参数名也不去掉参数', async () => {
    routed([() => relayedError(409, 'conflict while applying top_p')]);
    await expect(rewriteQuery()).rejects.toThrow(/HTTP 409/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it.each([
    ['嵌在 JSON 里', { detail: [{ type: 'missing', loc: ['body', 'messages', 0, 'name'], msg: 'Field required', input: { model: 'chat-model', stream: true, top_p: 0.8, enable_thinking: false } }] }],
    ['转义过的 JSON', { error: { message: `Extra inputs are not permitted: ${JSON.stringify({ model: 'chat-model', stream: true, top_p: 0.8, enable_thinking: false })}` } }],
    ['Python 字典的写法', { error: { message: "Extra inputs are not permitted: {'model': 'chat-model', 'stream': True, 'top_p': 0.8, 'enable_thinking': False}" } }],
  ])('报错里回显的请求体(%s)不算点了参数的名,也不算提到了流式传输', async (_name, echoed) => {
    routed([() => relayed(422, echoed, 'Unprocessable Entity')]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/服务商拒绝了这次请求（HTTP 422）/);
    expect(failure?.message).not.toContain('流式');
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it.each([
    'Streaming is not supported by this model',
    'stream is not supported',
    'streamed responses are not supported',
    'This model does not support streams',
    "This endpoint doesn't support streaming yet",
    'SSE is not supported',
    '该模型不支持流式输出',
    'Unrecognized request argument supplied: stream',
    "'stream' must be false for this model",
    'Invalid parameter: stream',
    "'stream' is not a valid parameter",
    'Streaming is disabled for this model',
    'This model only supports non-streaming requests',
    'only non stream mode is supported',
    'Please set "stream": false and retry',
    'Use stream=false with this deployment',
    'stream 参数必须为 false',
    '该模型仅支持非流式调用',
    '请关闭流式输出后重试',
    // 只列出被拒的键值,不是整段回显
    "Invalid value for 'stream': true",
    'Parameter "stream": true is not allowed for this model',
    // 回显了请求体,另外让把 stream 改成 false:和发出去的值不一样,不算回显
    'Bad request for {"model": "chat-model", "top_p": 0.8}: please set "stream": false',
    // 认不出是不是在说不支持,提到了就试
    'stream cannot be used here',
    'max_tokens must be less than 4096 when stream is enabled',
  ])('400 的原话提到了流式传输(%s):改用非流式试一次,原样重发成功了才记住', async message => {
    routed([() => relayedError(400, message), () => reply('Q: 查询'), () => reply('Q: 第二轮')]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(backendBodies().map(shape)).toEqual([[true, true, true], [false, true, true]]);
    await rewriteQuery();
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, false]);
  });

  it('回显了请求体的 400、422(里面有 "role": "user" 这样的字样)不说成角色顺序的问题,按一般的拒绝说明', async () => {
    const echoed = { detail: 'Field required', error: { message: 'Field required. Request body: {"model": "chat-model", "messages": [{"role": "user", "content": "还记得那个约定吗？"}]}' } };
    routed([() => relayed(422, echoed, 'Unprocessable Entity')]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/服务商拒绝了这次请求（HTTP 422）。常见原因是/);
    expect(failure?.message).not.toMatch(/角色顺序|预填充/);
  });

  it.each([
    'upstream connect error or disconnect/reset before headers',
    'Invalid value for stream_options',
    'stream_options is not supported',
    'downstream service unavailable',
    'The model `qwen-stream` is not supported',
    'Expected Accept header to include text/event-stream, which is not supported here',
    'upstream: false positives are not supported',
    'This feature is disabled for your account',
    '该渠道已被禁用，暂不可用',
  ])('没有提到流式传输的 400(%s,upstream、stream_options、带 -stream 的模型名都不算提到):不试非流式', async message => {
    routed([() => relayedError(400, message)]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/HTTP 400/);
    expect(failure?.message).not.toMatch(/看不到|非流式/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it.each([
    ["Invalid 'max_tokens': not allowed to exceed 4096 in stream mode", /最大输出超过了这个模型的上限（HTTP 400）。请把[\s\S]*已经试过改用非流式重发，仍被拒绝/],
    ['该模型不支持流式输出', /模型不存在，或当前密钥不能使用这个模型（HTTP 400）[\s\S]*已经试过改用非流式重发，仍被拒绝/],
    ['Unknown parameter(s): foo. Supported: model, messages, temperature, max_tokens, stream', /已经试过改用非流式重发，仍被拒绝[\s\S]*改成「浏览器直连」再试，那样能看到原话/],
    ['temperature is not supported (stream=true)', /服务商拒绝了这次请求（HTTP 400）。常见原因是[\s\S]*已经试过改用非流式重发，仍被拒绝/],
    ['failed to read response stream: unexpected EOF', /服务商拒绝了这次请求（HTTP 400）[\s\S]*已经试过改用非流式重发，仍被拒绝/],
  ])('提到了流式传输、非流式重发仍被拒绝(%s):报最初那条带原话的拒绝并写明试过非流式,不记住', async (message, expected) => {
    routed([
      () => relayedError(400, message, 'Bad Request'),
      () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Bad Request'),
      () => relayedError(400, message, 'Bad Request'),
      () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Bad Request'),
    ]);
    const failure = await failureOf();
    expect(failure?.message).toContain(message.slice(0, 30));
    expect(failure?.message).toMatch(expected);
    expect(failure?.message).not.toMatch(/这个服务不支持流式传输|这是改用非流式重发那一次的结果/);
    // 非流式重发一次,再按三种组合各试着去掉一次
    expect(backendBodies().map(shape)).toEqual([[true, true, true], [false, true, true], [false, false, true], [false, true, false], [false, false, false]]);
    // 下一轮:什么都没记住,照旧先用流式、参数照带
    await failureOf();
    expect(shape(backendBodies()[5])).toEqual([true, true, true]);
    expect(sentUrls(fetchMock).every(url => url === BACKEND)).toBe(true);
  });

  it('不支持流式传输是按接口地址和模型记的:换了模型重新用流式', async () => {
    routed([() => relayedError(400, 'Streaming is not supported by this model'), () => reply('Q: 一'), () => reply('Q: 二'), () => reply('Q: 三')]);
    await rewriteQuery();
    await rewriteQuery();
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, false]);
    mocks.settings.vector.queryRewrite.model = 'other-model';
    await rewriteQuery();
    expect(backendBodies()[3]).toMatchObject({ model: 'other-model', stream: true });
  });

  /** 先让这个地址和模型记住「不支持流式传输」:流式被拒,非流式重发成功。之后的请求都是非流式的。 */
  const nonStreamOnly = (later: Array<() => Response>) => [() => relayedError(400, 'Streaming is not supported by this model'), () => reply('Q: 非流式成功'), ...later];
  const shape = (b: Record<string, unknown>) => [b.stream, 'custom_include_body' in b, 'top_p' in b];

  it('记住不支持流式传输之后酒馆只转来状态说明:报错写明看不到原文;400 时按三种组合各试着去掉一次,不成功不记', async () => {
    routed(nonStreamOnly([
      () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Unprocessable Entity'), () => envelope('Bad Request'),
      () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Bad Request'), () => envelope('Bad Request'),
    ]));
    await rewriteQuery();
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：服务商拒绝了这次请求（HTTP 400）[\s\S]*或接口不接受某个参数。这个服务不支持流式传输，经酒馆后端转发时看不到它的报错原文/);
    // 原样发一次,再试:只去掉 enable_thinking、只去掉 top_p、两个都去掉
    expect(backendBodies().slice(2).map(shape)).toEqual([[false, true, true], [false, false, true], [false, true, false], [false, false, false]]);
    // 下一轮:试过的没有记住,两个参数照带,再各试一次
    await expect(rewriteQuery()).rejects.toThrow(/HTTP 400/);
    expect(backendBodies().slice(6).map(shape)).toEqual([[false, true, true], [false, false, true], [false, true, false], [false, false, false]]);
    expect(sentUrls(fetchMock).every(url => url === BACKEND)).toBe(true);
  });

  it.each([
    ['只去掉 enable_thinking 就成功', 1, [false, true]],
    ['只去掉 top_p 才成功:enable_thinking 照带', 2, [true, false]],
    ['两个都去掉才成功', 3, [false, false]],
  ])('试着改用非流式、看不到原话,再试着去掉可选参数(%s):只记试成功的那种参数组合,不记「不支持流式传输」', async (_name, failures, kept) => {
    const [thinking, topP] = kept as boolean[];
    routed([
      () => relayedError(400, 'Unknown parameter(s) in request. Supported: model, messages, temperature, max_tokens, stream'),
      ...Array.from({ length: failures as number }, () => () => envelope('Bad Request')),
      () => reply('Q: 查询'),
      // 下一轮:带着记住的参数先用流式。这个服务其实支持流式传输,直接成功
      () => sse(['Q: 第二轮']),
      () => sse(['Q: 第三轮']),
    ]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(backendBodies()).toHaveLength((failures as number) + 2);
    expect(shape(backendBodies().at(-1)!)).toEqual([false, thinking, topP]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['第二轮'] });
    expect(shape(backendBodies().at(-1)!)).toEqual([true, thinking, topP]);
    await rewriteQuery();
    expect(shape(backendBodies().at(-1)!)).toEqual([true, thinking, topP]);
  });

  it('盲试成功之后下一轮先用流式仍被拒绝:再试非流式,这次原样重发成功,才记住「不支持流式传输」', async () => {
    const noStream = () => relayedError(400, 'Streaming is not supported by this model');
    routed([
      noStream, () => envelope('Bad Request'), () => reply('Q: 第一轮'),
      noStream, () => reply('Q: 第二轮'),
      () => reply('Q: 第三轮'),
    ]);
    await rewriteQuery();
    await rewriteQuery();
    await rewriteQuery();
    expect(backendBodies().map(shape)).toEqual([
      [true, true, true], [false, true, true], [false, false, true],
      [true, false, true], [false, false, true],
      [false, false, true],
    ]);
  });

  it('记住不支持流式传输之后盲试成功:试成功的参数也记住', async () => {
    routed(nonStreamOnly([() => envelope('Bad Request'), () => envelope('Bad Request'), () => reply('Q: 查询'), () => reply('Q: 下一轮')]));
    await rewriteQuery();
    await rewriteQuery();
    await rewriteQuery();
    expect(backendBodies().slice(2).map(shape)).toEqual([[false, true, true], [false, false, true], [false, true, false], [false, true, false]]);
  });

  it('记住不支持流式传输之后回复是空的:不提流式输出不兼容(这一次不是流式取得的)', async () => {
    routed(nonStreamOnly([() => reply('')]));
    await rewriteQuery();
    const failure = await failureOf();
    expect(failure?.message).toMatch(/API 返回了空内容[\s\S]*换一个模型/);
    expect(failure?.message).not.toMatch(/流式|浏览器直连/);
  });

  it('已经去掉过 enable_thinking 的,盲试只剩去掉 top_p 这一种', async () => {
    routed([
      () => relayedError(400, 'Unrecognized request argument supplied: enable_thinking'),
      () => relayedError(400, 'Streaming is not supported by this model'),
      () => envelope('Bad Request'), () => envelope('Bad Request'),
    ]);
    await expect(rewriteQuery()).rejects.toThrow(/已经试过改用非流式重发，仍被拒绝[\s\S]*Streaming is not supported by this model/);
    expect(backendBodies().map(shape)).toEqual([[true, true, true], [true, false, true], [false, false, true], [false, false, false]]);
  });

  it('记住不支持流式传输之后,别的状态不试参数:地址不对、没有状态说明、密钥不对各按状态说明报,都注明看不到原文', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1' });
    routed(nonStreamOnly([
      () => envelope('Not Found'),
      () => envelope('Unknown error occurred'),
      () => envelope('Unauthorized'),
      () => envelope('Forbidden'),
      () => envelope('Payment Required'),
    ]));
    await rewriteQuery();
    await expect(rewriteQuery()).rejects.toThrow(/接口地址不对，或模型不存在（HTTP 404）[\s\S]*看不到它的报错原文/);
    await expect(rewriteQuery()).rejects.toThrow(/酒馆没有转发具体原因[\s\S]*看不到它的报错原文/);
    await expect(rewriteQuery()).rejects.toThrow(/API 密钥无效或没有权限（HTTP 401）。请检查密钥有没有填错或过期[\s\S]*这个服务不支持流式传输，经酒馆后端转发时看不到它的报错原文/);
    await expect(rewriteQuery()).rejects.toThrow(/API 密钥无效或没有权限（HTTP 403）[\s\S]*看不到它的报错原文/);
    await expect(rewriteQuery()).rejects.toThrow(/账户余额或额度不足（HTTP 402）[\s\S]*看不到它的报错原文/);
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, false, false, false, false, false]);
  });

  it('试着改用非流式、转来的是别的状态(不是 400、422):报非流式那一次的,附上最初那条的原话,不说「这个服务不支持流式传输」,也不记', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1' });
    const refusal = () => relayedError(400, "Invalid 'max_tokens': not allowed to exceed 4096 in stream mode", 'Bad Request');
    routed([refusal, () => envelope('Not Found'), refusal, () => envelope('Internal Server Error'), refusal, () => envelope('Too Many Requests')]);
    const missing = await failureOf();
    expect(missing?.message).toMatch(/接口地址不对，或模型不存在（HTTP 404）[\s\S]*这是改用非流式重发那一次的结果（流式请求先被拒绝，原话见后）；经酒馆后端转发时看不到非流式这一次的原话[\s\S]*（HTTP 404 · Not Found；流式请求被拒绝时的原话：HTTP 400 · Invalid 'max_tokens': not allowed to exceed 4096 in stream mode）/);
    expect(missing?.message).not.toContain('这个服务不支持流式传输');
    const broken = await failureOf();
    expect(broken?.message).toMatch(/服务商出错（HTTP 500）[\s\S]*这是改用非流式重发那一次的结果[\s\S]*流式请求被拒绝时的原话：HTTP 400 · Invalid 'max_tokens'/);
    const limited = await failureOf();
    expect(limited?.message).toMatch(/被服务商限流（HTTP 429）[\s\S]*这是改用非流式重发那一次的结果[\s\S]*not allowed to exceed 4096 in stream mode/);
    expect(limited?.message).not.toContain('这个服务不支持流式传输');
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, true, false, true, false]);
  });

  it('试着改用非流式的那一次超时:报超时,不记;下一轮照旧先用流式', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1', timeoutSec: 5 });
    let calls = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1 || calls === 3) return Promise.resolve(relayedError(400, 'Streaming is not supported by this model'));
      if (calls === 2) return hangUntilAborted()(url, init);
      return Promise.resolve(reply('Q: 查询'));
    });
    const pending = failureOf();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending)?.message).toMatch(/Query 重写：请求超时（超过 5 秒）/);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    // 本机地址、后端取回过答复:超时后不换直连
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, BACKEND, BACKEND]);
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, true, false]);
  });

  it('试着改用非流式的那一次被酒馆拒绝:报酒馆的拒绝,不记', async () => {
    routed([
      () => relayedError(400, 'Streaming is not supported by this model'),
      () => new Response('Forbidden', { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'text/plain; charset=utf-8', ...HOST_ETAG } }),
      () => sse(['Q: 查询']),
    ]);
    await expect(rewriteQuery()).rejects.toThrow(/酒馆服务器拒绝了这次请求（HTTP 403）/);
    await rewriteQuery();
    expect(backendBodies().map(b => b.stream)).toEqual([true, false, true]);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, BACKEND]);
  });

  it('记住不支持流式传输之后:限流按重试次数重试,酒馆标了额度不足的不重试', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    routed(nonStreamOnly([
      () => envelope('Too Many Requests'),
      () => envelope('Too Many Requests'),
      () => envelope('Too Many Requests', { quota_error: true }),
    ]));
    await rewriteQuery();
    const limited = rewriteQuery();
    const checkLimited = expect(limited).rejects.toThrow(/被服务商限流（HTTP 429）[\s\S]*看不到它的报错原文/);
    await vi.advanceTimersByTimeAsync(1000);
    await checkLimited;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await expect(rewriteQuery()).rejects.toThrow(/余额或额度不足/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('用 200 报错(流式里的一段,或整段 JSON)按拒绝处理,带服务商的原话,不重试', async () => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([
      () => relayed(200, 'data: {"error":{"message":"The model `chat-model` does not exist"}}\n\ndata: [DONE]\n\n'),
      () => relayed(200, { error: { message: 'insufficient balance' } }),
      () => relayed(200, { error: { message: 'network error while calling the model' } }),
    ]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：[\s\S]*does not exist/);
    await expect(rewriteQuery()).rejects.toThrow(/余额或额度不足[\s\S]*insufficient balance/);
    // 原话里有 network 字样也不说成「酒馆连不上」
    const failure = await failureOf();
    expect(failure?.message).toMatch(/API 返回了错误[\s\S]*network error while calling the model/);
    expect(failure?.message).not.toContain('连不上');
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, BACKEND]);
  });

  it.each([429, 500, 503])('用 200 报错、error.code 是状态码(%s)时照它说明原因,但不按它重试(两种请求方式一样)', async code => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([() => relayed(200, `data: {"error":{"message":"The service said no","code":${code}}}\n\n`)]);
    const pending = failureOf();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending)?.message).toMatch(new RegExp(`（HTTP ${code}）[\\s\\S]*The service said no`));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mocks.settings.vector.queryRewriteRoute = 'direct';
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'The service said no', code } }), { status: 200 }));
    const direct = failureOf();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await direct)?.message).toMatch(new RegExp(`（HTTP ${code}）[\\s\\S]*The service said no`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('用 200 报错又没有写原因:不提副 API 渠道的「流式传输」开关', async () => {
    routed([() => relayed(200, { error: true })]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/Query 重写：API 返回了错误，没有说明原因。可以重试；仍然失败时请核对 API 地址、模型名和密钥/);
    expect(failure?.message).not.toMatch(/流式|酒馆/);
  });

  it('用 200 报错、原文点了可选参数的名:同样去掉再发;提到不支持流式传输的不算(没有明确的拒绝状态)', async () => {
    routed([
      () => relayed(200, { error: { message: 'unknown field "enable_thinking"' } }),
      () => reply('Q: 查询'),
      () => relayed(200, 'data: {"error":{"message":"stream error: streaming is not supported right now"}}\n\n'),
    ]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(backendBodies()[1]).not.toHaveProperty('custom_include_body');
    await expect(rewriteQuery()).rejects.toThrow(/stream error/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, BACKEND]);
    expect(backendBodies()[2]).toHaveProperty('stream', true);
  });

  it('限流和服务商出错按重试次数重试(状态和原话都是服务商的);额度不足不重试', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    routed([
      () => relayedError(503, 'overloaded'), () => reply('Q: 查询'),
      () => relayedError(429, 'rate limit reached'), () => relayedError(429, 'rate limit reached'),
      () => relayedError(429, 'You exceeded your current quota (insufficient_quota)'),
    ]);
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ queries: ['查询'] });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);

    const limited = rewriteQuery();
    const checkLimited = expect(limited).rejects.toThrow(/被服务商限流（HTTP 429）[\s\S]*rate limit reached/);
    await vi.advanceTimersByTimeAsync(1000);
    await checkLimited;
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await expect(rewriteQuery()).rejects.toThrow(/余额或额度不足/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('服务商自己的 500、502(原话里带着证书、连接之类的词)按服务商出错报并重试,不当成酒馆连不上', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    for (const [status, message] of [[500, 'x509: certificate signed by unknown authority'], [502, 'fetch failed'], [502, 'connection refused by model backend']] as const) {
      resetRewriteParamMemory();
      fetchMock.mockReset();
      routed([() => relayedError(status, message), () => relayedError(status, message)]);
      const pending = failureOf();
      await vi.advanceTimersByTimeAsync(1000);
      const failure = await pending;
      expect(failure?.message, message).toMatch(new RegExp(`Query 重写：服务商出错（HTTP ${status}）`));
      expect(failure?.message, message).toContain(message);
      expect(sentUrls(fetchMock), message).toEqual([BACKEND, BACKEND]);
    }
  });

  it('超时后不重试;后端这次会话从没取回过答复时,把浏览器直连当第二条路试一次,它也不通就报超时', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1', timeoutSec: 5, retries: 2 });
    fetchMock.mockImplementation((url: string, init: RequestInit) => (String(url) === BACKEND ? hangUntilAborted()(url, init) : Promise.reject(new TypeError('Failed to fetch'))));
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/Query 重写：请求超时（超过 5 秒）/);
    await vi.advanceTimersByTimeAsync(8000);
    await check;
    const local = 'http://127.0.0.1:11434/v1/chat/completions';
    // 后端只发了一次(超时不重试);直连按重试次数试了三次
    expect(sentUrls(fetchMock)).toEqual([BACKEND, local, local, local]);
  });

  /** 酒馆白名单拒绝页(1.12.13 起都是这一份模板)和主机白名单拒绝页(1.14 起)的正文。 */
  const WHITELIST_PAGE = '<!DOCTYPE html>\n<html>\n<head>\n    <title>Forbidden</title>\n</head>\n<body>\n    <h1>Forbidden</h1>\n    <p>\n        If you are the system administrator, add your IP address to the\n        whitelist or disable whitelist mode by editing\n        <code>config.yaml</code> in the root directory of your installation.\n    </p>\n</body>\n</html>\n';
  const HOST_PAGE = '<!DOCTYPE html>\n<html>\n<body>\n    <h1>Forbidden</h1>\n    <p>add the hostname you are accessing from to the host whitelist, or disable host whitelisting in the\n        <code>config.yaml</code> file located in the root directory of your installation.</p>\n</body>\n</html>\n';
  const CSRF_PAGE = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Forbidden</pre>\n</body>\n</html>\n';
  const HTML_TYPE = { 'Content-Type': 'text/html; charset=utf-8' };
  const CSP_NONE = { 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' };

  it.each([
    ['未登录:纯文本 Forbidden', () => new Response('Forbidden', { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'text/plain; charset=utf-8', ...HOST_ETAG } }), 403],
    ['CSRF 校验没过(默认启动方式的出错页)', () => new Response(CSRF_PAGE, { status: 403, headers: { ...HTML_TYPE, ...CSP_NONE } }), 403],
    ['CSRF 校验没过(开发模式带原因)', () => new Response('<!DOCTYPE html>\n<html lang="en">\n<body>\n<pre>ForbiddenError: Invalid CSRF token. Please refresh the page and try again.</pre>\n</body>\n</html>\n', { status: 403, headers: { ...HTML_TYPE, ...CSP_NONE } }), 403],
    ['不在白名单里', () => new Response(WHITELIST_PAGE, { status: 403, headers: { ...HTML_TYPE, ...HOST_ETAG } }), 403],
    ['主机名不在白名单里(这种没有 ETag)', () => new Response(HOST_PAGE, { status: 403, headers: HTML_TYPE }), 403],
    ['基本认证没过', () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }), 401],
    // 反向代理去掉了那些响应头时,靠正文认
    ['只剩正文:纯文本 Forbidden', () => new Response(' Forbidden\n', { status: 403 }), 403],
    ['只剩正文:出错页', () => new Response(CSRF_PAGE, { status: 403, headers: HTML_TYPE }), 403],
    ['只剩正文:带 CSRF 字样', () => new Response('invalid csrf token', { status: 403 }), 403],
    ['只剩正文:白名单页', () => new Response(WHITELIST_PAGE, { status: 403, headers: HTML_TYPE }), 403],
    // 正文认不出来,但带着酒馆自己生成的响应才有的记号
    ['正文认不出,有 ETag', () => new Response('Access denied by a server plugin', { status: 403, headers: HOST_ETAG }), 403],
    ['正文认不出,出错页的内容安全策略', () => new Response('<h1>Nope</h1>', { status: 403, headers: { ...HTML_TYPE, ...CSP_NONE } }), 403],
    ['JSON 正文,有 ETag', () => new Response(JSON.stringify({ error: 'User is disabled' }), { status: 403, headers: { ...JSON_TYPE, ...HOST_ETAG } }), 403],
  ])('酒馆自己拒绝请求(%s)时提示刷新页面,不另由浏览器直连再试', async (_name, response, status) => {
    routed([response]);
    await expect(rewriteQuery()).rejects.toThrow(new RegExp(`酒馆服务器拒绝了这次请求（HTTP ${status}）[\\s\\S]*刷新页面`));
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it.each([
    ['服务商的 403 网页(按 IP 拦截时常见的样子)', () => new Response('<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n', { status: 403, statusText: 'Forbidden', headers: HTML_TYPE })],
    ['服务商的纯文本 403', () => new Response('Access denied', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })],
    ['别的内容安全策略不算酒馆的记号', () => new Response('<h1>Blocked</h1>', { status: 403, headers: { ...HTML_TYPE, 'Content-Security-Policy': "default-src 'self'" } })],
    ['JSON 正文里碰巧有酒馆页面上的字样', () => new Response(JSON.stringify({ error: { message: 'csrf check failed, see config.yaml' } }), { status: 403, headers: JSON_TYPE })],
  ])('反向代理给转来的回复补上了 Content-Type 时,%s 仍按服务商的拒绝处理:由浏览器直连再试', async (_name, response) => {
    routed([response], [() => reply('Q: 直连的查询')]);
    const result = await rewriteQuery();
    expect(result.queries).toEqual(['直连的查询']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
  });

  it('酒馆不接受这个请求(HTTP 400,正文是 { error: true })时照实说明,不重试,不去掉参数,也不改用直连', async () => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([() => new Response(JSON.stringify({ error: true }), { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } })]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：酒馆没有接受这次请求（HTTP 400）/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('返回的不是有效数据(地址指向了网站首页之类)时照实报错,不重试,不改用直连', async () => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([() => relayed(200, '<html><body>首页</body></html>')]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写接口返回的不是有效数据，请确认地址指向对话接口/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('浏览器连不上酒馆时照实报错,不改用直连', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(rewriteQuery()).rejects.toThrow(/连不上酒馆服务器/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('浏览器连不上酒馆时按重试次数再试', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(reply('Q: 查询'));
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ queries: ['查询'] });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it('酒馆服务器连不上这个地址时改由浏览器直连(非流式);直连成功后本次会话先用直连', async () => {
    routed([refused], [() => reply('Q: 直连的查询'), () => reply('Q: 第二轮')]);
    const first = await rewriteQuery();
    expect(first.queries).toEqual(['直连的查询']);
    expect(first.stats).toMatchObject({ route: 'direct', fellBack: true });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    expect(sentBody(fetchMock, 1)).toMatchObject({ model: 'chat-model', enable_thinking: false, top_p: 0.8, stream: false });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k' });
    const second = await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT]);
    expect(second.stats).toMatchObject({ route: 'direct', fellBack: true });
  });

  it('连接出错先按重试次数重试,仍连不上才改用直连', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    routed([refused, refused], [() => reply('Q: 直连的查询')]);
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ queries: ['直连的查询'] });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, DIRECT]);
  });

  it.each([
    ['拒绝连接', 'ECONNREFUSED', `request to ${DIRECT} failed, reason: connect ECONNREFUSED 203.0.113.9:443`, /API 服务器拒绝连接/],
    ['域名解析不了', 'ENOTFOUND', `request to ${DIRECT} failed, reason: getaddrinfo ENOTFOUND example.test`, /找不到 API 服务器（域名解析失败）/],
    ['连接超时', 'ETIMEDOUT', `request to ${DIRECT} failed, reason: connect ETIMEDOUT 203.0.113.9:443`, /连接 API 服务器超时/],
    ['证书不对', 'DEPTH_ZERO_SELF_SIGNED_CERT', `request to ${DIRECT} failed, reason: self-signed certificate`, /连接 API 时证书校验失败/],
    ['证书的域名不符(代码以 ERR_ 开头)', 'ERR_TLS_CERT_ALTNAME_INVALID', `request to ${DIRECT} failed, reason: Hostname/IP does not match certificate's altnames: Host: example.test. is not in the cert's altnames: DNS:other.test`, /连接 API 时证书校验失败/],
    ['连接被重置', 'ECONNRESET', `request to ${DIRECT} failed, reason: socket hang up`, /酒馆连不上 API 服务器/],
    // 按错误代码归类:地址里的 dns、tls 字样不会把说明带偏
    ['地址里带 dns 字样、被拒绝连接', 'ECONNREFUSED', 'request to https://my-box.duckdns.org/v1/chat/completions failed, reason: connect ECONNREFUSED 203.0.113.9:443', /API 服务器拒绝连接/],
    ['地址里带 tls 字样、连接超时', 'ETIMEDOUT', 'request to https://tls.example.test/v1/chat/completions failed, reason: connect ETIMEDOUT 203.0.113.9:443', /连接 API 服务器超时/],
    ['地址里带 dns 字样、网络不可达', 'ENETUNREACH', 'request to https://dns.example.test/v1/chat/completions failed, reason: connect ENETUNREACH 203.0.113.9:443', /酒馆连不上 API 服务器/],
    ['https 的地址写到了 http 的端口', 'EPROTO', `request to ${DIRECT} failed, reason: write EPROTO 0098:error:0A00010B:SSL routines:ssl3_get_record:wrong version number`, /连接 API 时证书校验失败。请确认地址的 http \/ https 写对了/],
  ])('酒馆以 502 返回请求库的连接错误(%s)算连不上:改用直连;直连也不通时报后端的原因并注明', async (_name, code, message, title) => {
    routed([() => hostError(message, code)], [() => reply('Q: 直连的查询')]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['直连的查询'] });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);

    resetRewriteParamMemory();
    routed([() => hostError(message, code)], [new TypeError('Failed to fetch')]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(title);
    expect(failure?.message).toMatch(/改由浏览器直连也没有成功/);
  });

  it.each([
    ['说明里像是连接问题、却没有请求库的错误类型', () => hostError('fetch failed'), 'fetch failed'],
    ['只有 E 开头的错误代码', () => hostError('request failed', undefined, { code: 'EHOSTDOWN' }), 'EHOSTDOWN'],
    ['读回复读到一半断开(已经连上了)', () => hostError(`Invalid response body while trying to fetch ${DIRECT}: Premature close`, undefined, { type: 'system', code: 'ERR_STREAM_PREMATURE_CLOSE' }), 'Premature close'],
    ['读回复读到一半断开(只有 ERR_ 开头的代码看得出来)', () => hostError('Premature close', undefined, { type: 'system', code: 'ERR_STREAM_PREMATURE_CLOSE' }), 'Premature close'],
    ['读回复时连接被重置(已经连上了)', () => hostError(`Invalid response body while trying to fetch ${DIRECT}: read ECONNRESET`, undefined, { type: 'system', code: 'ECONNRESET' }), 'read ECONNRESET'],
    ['其他 ERR_ 开头的参数错误', () => hostError('The "url" argument must be of type string. Received undefined', undefined, { code: 'ERR_INVALID_ARG_TYPE' }), 'ERR_INVALID_ARG_TYPE'],
    ['认不出类型和代码,靠酒馆响应的记号', () => hostError('Cannot read properties of undefined'), 'Cannot read properties'],
    // 反向代理去掉了 ETag 时,靠请求库的错误类型或代码认
    ['没有 ETag,有请求库的错误类型', () => new Response(JSON.stringify({ error: { message: 'Invalid response body while trying to fetch upstream: aborted', type: 'system' } }), { status: 502, headers: JSON_TYPE }), 'aborted'],
    ['没有 ETag,有错误代码', () => new Response(JSON.stringify({ error: { message: 'request failed', code: 'EPIPE' } }), { status: 502, headers: JSON_TYPE }), 'EPIPE'],
  ])('酒馆转发时出的别的错(%s)不算连不上,也不说成服务商出错:照实说明,不改用直连', async (_name, response, detail) => {
    routed([response]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/Query 重写：酒馆转发这次请求时出错（HTTP 502）。多半是服务商中途断开了连接，或返回了酒馆读不了的内容/);
    expect(failure?.message).toContain(detail);
    expect(failure?.message).not.toContain('服务商出错');
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('酒馆转发时出的别的错按重试次数重试', async () => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    routed([() => hostError(`Invalid response body while trying to fetch ${DIRECT}: Premature close`, undefined, { type: 'system', code: 'ERR_STREAM_PREMATURE_CLOSE' }), () => reply('Q: 查询')]);
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ queries: ['查询'] });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it.each([
    ['不是 502', () => new Response(JSON.stringify({ error: { message: 'connect ECONNREFUSED 10.0.0.1:443', type: 'system', code: 'ECONNREFUSED' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }), 500],
    ['没有 Content-Type(是转来的服务商回复)', () => relayed(502, { error: { message: 'connect ECONNREFUSED 10.0.0.1:443', type: 'system', code: 'ECONNREFUSED' } }), 502],
    ['没有 Content-Type 的 502 网页(转来的服务商网页)', () => relayed(502, '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', 'Bad Gateway'), 502],
    ['带 Content-Type、却没有酒馆记号的 502(可能是反向代理补了类型的服务商回复)', () => new Response(JSON.stringify({ error: { message: 'upstream model crashed', type: 'server_error' } }), { status: 502, headers: JSON_TYPE }), 502],
    ['服务商的错误体里也有 code,但不是 Node 错误代码的样子', () => new Response(JSON.stringify({ error: { message: 'upstream model crashed', code: 'server_error' } }), { status: 502, headers: JSON_TYPE }), 502],
    ['服务商的错误体里 code 是数字', () => new Response(JSON.stringify({ error: { message: 'bad gateway from provider', code: 502 } }), { status: 502, headers: JSON_TYPE }), 502],
  ])('502 一类的响应认不出是酒馆自己的(%s):按服务商出错报,不改用直连', async (_name, response, status) => {
    routed([response]);
    await expect(rewriteQuery()).rejects.toThrow(new RegExp(`Query 重写：服务商出错（HTTP ${status}）`));
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it.each([502, 503, 504])('带 Content-Type 的 %s 网页(多半是酒馆前面的反向代理连不上酒馆):两种可能都说,按重试次数重试,不改用直连', async status => {
    vi.useFakeTimers();
    mocks.settings.vector.queryRewrite.retries = 1;
    const page = () => new Response(`<html><head><title>${status} Bad Gateway</title></head><body><center>nginx — your IP is not allowed in this region</center></body></html>`, { status, headers: { 'Content-Type': 'text/html' } });
    routed([page, page], [() => reply('Q: 不该用到')]);
    const pending = failureOf();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending)?.message).toMatch(new RegExp(`Query 重写：网关返回了出错页（HTTP ${status}）。可能是酒馆前面的反向代理连不上酒馆（请确认酒馆还在运行），也可能是服务商出错`));
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it('地址或密钥的格式酒馆发不出去(ERR_ 开头的错误代码):报清楚是哪一项,不当成连不上', async () => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([
      () => hostError('Invalid URL', undefined, { code: 'ERR_INVALID_URL', input: 'http://exa mple.test/v1/chat/completions' }),
      () => hostError('Invalid character in header content ["Authorization"]', undefined, { code: 'ERR_INVALID_CHAR' }),
    ]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：API 地址格式不对。请检查地址里有没有空格、中文标点或多余的字符/);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：API 密钥里有不能使用的字符/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it.each([
    'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
    'Unexpected token < in JSON at position 0',
    'Unexpected end of JSON input',
    'Unterminated string in JSON at position 512',
    'Expected \',\' or \'}\' after property value in JSON at position 10',
  ])('改用非流式之后,上游返回的内容酒馆读不成 JSON(%s):按无效数据报错,不重试,不改用直连', async message => {
    mocks.settings.vector.queryRewrite.retries = 2;
    routed([() => relayedError(400, 'stream is not supported'), () => hostError(message)]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写接口返回的不是有效数据，请确认地址指向对话接口/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it('非流式转发时的 502 都是酒馆自己的(服务商的报错那时是 200 加状态说明):认不出类型和代码、没有 ETag 也照实说明', async () => {
    routed([
      () => relayedError(400, 'stream is not supported'),
      () => new Response(JSON.stringify({ error: { message: 'socket closed before the response was complete' } }), { status: 502, headers: JSON_TYPE }),
    ]);
    const failure = await failureOf();
    expect(failure?.message).toMatch(/Query 重写：酒馆转发这次请求时出错（HTTP 502）[\s\S]*socket closed before/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it('流式转发时 502 的说明里提到 JSON,也不当成无效数据', async () => {
    routed([() => hostError('Invalid JSON payload received by upstream')]);
    await expect(rewriteQuery()).rejects.toThrow(/酒馆转发这次请求时出错（HTTP 502）[\s\S]*Invalid JSON payload/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
  });

  it('后端和直连都连不上时报后端的原因,注明直连也没有成功;下一轮仍先走后端', async () => {
    routed([refused, () => reply('Q: 查询')], [new TypeError('Failed to fetch')]);
    await expect(rewriteQuery()).rejects.toThrow(/Query 重写：API 服务器拒绝连接[\s\S]*改由浏览器直连也没有成功/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    const next = await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
    expect(next.stats).toMatchObject({ route: 'backend', fellBack: false });
  });

  it('先用直连之后,直连连不上时回到后端,之后仍先走后端', async () => {
    routed([refused, () => reply('Q: 后端的查询'), () => reply('Q: 下一轮')], [() => reply('Q: 直连的查询'), new TypeError('Failed to fetch')]);
    await rewriteQuery();
    const back = await rewriteQuery();
    expect(back.queries).toEqual(['后端的查询']);
    expect(back.stats).toMatchObject({ route: 'backend', fellBack: false });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT, BACKEND]);
    await rewriteQuery();
    expect(sentUrls(fetchMock)[4]).toBe(BACKEND);
  });

  it('先用直连之后两条路都连不上:报后端的原因,下一轮回到先走后端', async () => {
    routed([refused, refused, () => reply('Q: 下一轮')], [() => reply('Q: 直连的查询'), new TypeError('Failed to fetch')]);
    await rewriteQuery();
    await expect(rewriteQuery()).rejects.toThrow(/API 服务器拒绝连接[\s\S]*改由浏览器直连也没有成功/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT, BACKEND]);
    await rewriteQuery();
    expect(sentUrls(fetchMock)[4]).toBe(BACKEND);
  });

  it('改用直连后原文点了可选参数的名:去掉之后这一轮接着走直连,不回头再试后端', async () => {
    routed([refused], [() => rejected(400, 'Unrecognized request argument supplied: enable_thinking'), () => reply('Q: 查询')]);
    await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT]);
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('enable_thinking');
    expect(sentBody(fetchMock, 2)).toHaveProperty('top_p', 0.8);
  });

  describe('服务商的拒绝可能只针对酒馆服务器这一路', () => {
    it('密钥不对:酒馆把 401 改成 400 转来(状态说明仍是 Unauthorized),按密钥问题报原话;换一条路结果也一样,不另由直连再试', async () => {
      routed([() => relayedError(400, 'Invalid token', 'Unauthorized'), () => relayedError(400, 'Invalid token', 'Unauthorized')]);
      await expect(rewriteQuery()).rejects.toThrow(/API 密钥无效或没有权限（HTTP 401）[\s\S]*Invalid token/);
      await expect(rewriteQuery()).rejects.toThrow(/Invalid token/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
    });

    it.each([
      { error: { message: 'Incorrect API key provided: sk-abc***' } },
      { error: { message: 'Invalid token' } },
      { code: 30014, message: 'Token is invalid.', data: null },
      { error: { message: 'User not found.', code: 401 } },
      { error: { message: 'No auth credentials found' } },
      { error: { message: 'Authentication Fails, Your api key: ****abcd is invalid', type: 'authentication_error' } },
      { error: { message: '无效的令牌 (request id: 20261120)' } },
      { error: { message: '该令牌状态不可用' } },
      { error: { message: 'Invalid credentials' } },
      { error: { message: "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth, or as the password field (with blank username) if you're accessing the API from your browser. You can obtain an API key from your account page." } },
      { error: { code: '1002', message: 'Authorization Token非法，请确认Authorization Token正确传递。' } },
      { error: { code: '1001', message: 'Header中未收到Authorization参数，无法进行身份验证。' } },
    ])('状态说明没有传过来(酒馆前面有 HTTP/2 的反向代理)时,原话是密钥、令牌没有通过认证的 400 也按密钥问题报:%j', async body => {
      routed([() => relayed(400, body)]);
      await expect(rewriteQuery()).rejects.toThrow(/Query 重写：API 密钥无效或没有权限（HTTP 401）/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND]);
    });

    it('服务商不发状态说明时酒馆转出来是 Bad Request:正文里的 code 是 401 的仍按密钥问题报;只凭原话不改判', async () => {
      routed([
        () => relayed(400, { error: { message: 'User not found.', code: 401 } }, 'Bad Request'),
        () => relayed(400, { error: { message: 'Invalid token' } }, 'Bad Request'),
      ]);
      await expect(rewriteQuery()).rejects.toThrow(/Query 重写：API 密钥无效或没有权限（HTTP 401）[\s\S]*User not found/);
      await expect(rewriteQuery()).rejects.toThrow(/服务商拒绝了这次请求（HTTP 400）[\s\S]*Invalid token/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
    });

    it.each([
      ['状态说明是 Bad Request', 'Bad Request'],
      ['状态说明没有传过来', ''],
    ])('严格校验参数的服务对 enable_thinking 回 400(%s),原话里带着 forbidden、permitted:照样去掉参数再发,不当成密钥问题', async (_name, statusText) => {
      const strict = { object: 'error', message: "[{'type': 'extra_forbidden', 'loc': ('body', 'enable_thinking'), 'msg': 'Extra inputs are not permitted', 'input': False}]", type: 'BadRequestError', code: 400 };
      for (const url of ['https://example.test/v1', 'http://127.0.0.1:8000/v1']) {
        resetRewriteParamMemory();
        fetchMock.mockReset();
        Object.assign(mocks.settings.vector.queryRewrite, { url });
        routed([() => relayed(400, strict, statusText), () => sse(['Q: 查询']), () => sse(['Q: 第二轮'])]);
        const result = await rewriteQuery();
        expect(result.queries).toEqual(['查询']);
        expect(result.stats).toMatchObject({ route: 'backend', fellBack: false });
        expect(backendBodies().map(shape)).toEqual([[true, true, true], [true, false, true]]);
        await rewriteQuery();
        expect(shape(backendBodies()[2])).toEqual([true, false, true]);
        expect(sentUrls(fetchMock).every(u => u === BACKEND)).toBe(true);
      }
    });

    it('点了可选参数名的 400,原话即使带着密钥一类的字样也是真正的 400:去掉参数再发', async () => {
      routed([() => relayedError(400, 'Unauthorized field: enable_thinking'), () => sse(['Q: 查询'])]);
      await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
      expect(backendBodies().map(shape)).toEqual([[true, true, true], [true, false, true]]);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
    });

    it.each([
      ['Bad Request', "role 'system' is forbidden for this model"],
      ['', "role 'system' is forbidden for this model"],
      ['Bad Request', 'You do not have permission to set logit_bias'],
      ['', 'Access denied for parameter logprobs'],
      ['Bad Request', 'Invalid token'],
      ['', 'max_tokens 参数错误'],
      ['', 'Invalid token: unexpected character at position 5'],
      ['', '输入 token 数量错误：超过模型限制'],
      ['', 'Unauthorized parameter: logprobs'],
    ])('真正的 400(状态说明「%s」,原话 %s)不改判成密钥问题,也不另由直连再试', async (statusText, message) => {
      routed([() => relayedError(400, message, statusText)], [() => reply('Q: 不该用到')]);
      const failure = await failureOf();
      expect(failure?.message).toMatch(/（HTTP 400）/);
      expect(failure?.message).not.toMatch(/密钥|HTTP 401/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND]);
    });

    it.each([
      [403, 'Country, region, or territory not supported'],
      [403, 'Forbidden'],
      [451, 'Unavailable'],
      [400, 'User location is not supported for the API use.'],
      [400, '该 IP 不在白名单内'],
      [400, '您所在的区域暂不支持使用该服务'],
      [404, 'Service is not available in your area'],
      [400, 'VPN or proxy detected'],
      [429, 'Requests from blocked IPs are rejected'],
      [400, 'Your IP address is not allowed to access this API'],
      [400, 'Requests from mainland China are not supported'],
      [400, '中国大陆暂不提供服务'],
      [400, '该地区不提供服务'],
      [400, 'This service is geo-restricted'],
      [400, 'Access is blocked based on your geographic location'],
    ])('后端被服务商按来路拒绝(%s %s)而直连成功:用直连的结果,本次会话先用直连', async (status, message) => {
      routed([() => relayedError(status, message)], [() => reply('Q: 直连的查询'), () => reply('Q: 第二轮')]);
      const first = await rewriteQuery();
      expect(first.queries).toEqual(['直连的查询']);
      expect(first.stats).toMatchObject({ route: 'direct', fellBack: true });
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
      await rewriteQuery();
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT]);
    });

    it('401 的原话说到来源 IP(酒馆把它改成 400 转来)也由直连再试;用 200 报的错同样看原话', async () => {
      routed([() => relayedError(400, 'API key is not allowed from this IP', 'Unauthorized')], [() => reply('Q: 直连的查询')]);
      expect((await rewriteQuery()).queries).toEqual(['直连的查询']);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);

      resetRewriteParamMemory();
      fetchMock.mockReset();
      routed([() => relayed(200, { error: { message: 'Your region is not supported' } })], [() => reply('Q: 直连的查询')]);
      expect((await rewriteQuery()).queries).toEqual(['直连的查询']);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    });

    it.each([
      [400, 'The us-east-1 region is temporarily overloaded'],
      [400, '该模型不在分组的模型白名单中'],
      [400, 'TCP/IP connection to model backend failed'],
      [400, 'Request blocked by content policy'],
      [404, 'The model does not exist in this region yet'],
      [400, '<html><head><script>window.location="/login?blocked=1"</script></head><body>Your IP 203.0.113.9 is not allowed</body></html>'],
      [502, '<html><head><title>502 Bad Gateway</title></head><body>cloudflare — Your IP: 203.0.113.9 — access to this region is restricted</body></html>'],
      [500, 'Requests from your region are not supported'],
      [503, 'IP blocked'],
      [400, '上游代理拒绝了请求'],
      [400, '模型代理服务不可用'],
      [400, 'Proxy error: upstream is not available'],
      [400, 'Requests about geopolitical topics are not allowed'],
      [400, 'George is not allowed to use this model'],
      // 整段回显了请求体:聊天内容里什么词都可能出现,不按原话判
      [422, 'Field required. Request body: {"model": "chat-model", "messages": [{"role": "user", "content": "这个国家的区域被拒绝进入"}]}'],
    ])('与来路无关的拒绝、网页、5xx 和回显了聊天内容的报错(%s %s):不另由直连再试', async (status, message) => {
      routed([() => relayed(status, message.startsWith('<') ? message : { error: { message } })], [() => reply('Q: 不该用到')]);
      await expect(rewriteQuery()).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(sentUrls(fetchMock)).toEqual([BACKEND]);
    });

    it('服务商返回的 403(包括纯文本 Forbidden;流式转发来的没有 Content-Type)不当成酒馆的拒绝', async () => {
      routed([() => relayed(403, 'Forbidden', 'Forbidden')], [() => rejected(403, 'Forbidden')]);
      const failure = await failureOf();
      expect(failure?.message).toMatch(/API 密钥无效或没有权限（HTTP 403）/);
      expect(failure?.message).not.toContain('酒馆服务器拒绝');
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    });

    it('直连不通:只试一次(不按重试次数重试),报后端转来的拒绝;十分钟内不再试直连', async () => {
      vi.useFakeTimers();
      mocks.settings.vector.queryRewrite.retries = 2;
      routed(
        [() => relayedError(403, 'region not supported'), () => relayedError(403, 'region not supported'), () => relayedError(403, 'region not supported')],
        [new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), new TypeError('Failed to fetch')],
      );
      const failAfter = async (ms: number) => {
        const pending = failureOf();
        await vi.advanceTimersByTimeAsync(ms);
        return pending;
      };
      expect((await failAfter(0))?.message).toMatch(/HTTP 403[\s\S]*region not supported/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
      expect((await failAfter(0))?.message).toMatch(/region not supported/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
      await vi.advanceTimersByTimeAsync(REWRITE_DIRECT_RETRY_AFTER_MS);
      expect((await failAfter(0))?.message).toMatch(/region not supported/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND, BACKEND, DIRECT]);
    });

    it('反向代理给转来的回复补上了 Content-Type 时,JSON 形式的 403 仍按服务商的拒绝处理', async () => {
      routed([() => rejected(403, 'Forbidden: region not supported')], [() => rejected(403, 'Forbidden: region not supported')]);
      const failure = await failureOf();
      expect(failure?.message).toMatch(/API 密钥无效或没有权限（HTTP 403）[\s\S]*region not supported/);
      expect(failure?.message).not.toContain('酒馆服务器拒绝');
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    });

    it('后端 403、直连也 403(例如密钥没有这个模型的权限):后端成功之前,每一轮都会由直连再试一次', async () => {
      const denied = () => relayedError(403, 'The API key is not permitted to use this model');
      routed([denied, denied, () => sse(['Q: 换了模型']), denied], [() => rejected(403, 'The API key is not permitted to use this model'), () => rejected(403, 'The API key is not permitted to use this model')]);
      await expect(rewriteQuery()).rejects.toThrow(/HTTP 403/);
      await expect(rewriteQuery()).rejects.toThrow(/HTTP 403/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND, DIRECT]);
      // 后端成功过一次之后不再试
      await rewriteQuery();
      await expect(rewriteQuery()).rejects.toThrow(/HTTP 403/);
      expect(sentUrls(fetchMock).slice(4)).toEqual([BACKEND, BACKEND]);
    });

    it('后端带着原话按来路拒绝、直连也被拒绝(说法不同):仍报后端转来的那条', async () => {
      routed([() => relayedError(403, 'backend says: region not supported')], [() => rejected(403, '直连这边的说法')]);
      const failure = await failureOf();
      expect(failure?.message).toMatch(/HTTP 403[\s\S]*backend says: region not supported/);
      expect(failure?.message).not.toContain('直连这边的说法');
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    });

    it('先用直连时直连连不上、回到后端又被拒绝:不再回头试直连', async () => {
      routed([refused, () => relayedError(403, 'region not supported')], [() => reply('Q: 直连'), new TypeError('Failed to fetch')]);
      await rewriteQuery();
      await expect(rewriteQuery()).rejects.toThrow(/region not supported/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT, BACKEND]);
    });

    it('直连的原文点了可选参数的名:去掉之后接着走直连', async () => {
      routed(
        [() => relayedError(403, 'region not supported')],
        [() => rejected(400, 'Unrecognized request argument supplied: enable_thinking'), () => reply('Q: 查询')],
      );
      await expect(rewriteQuery()).resolves.toMatchObject({ queries: ['查询'] });
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT]);
      expect(sentBody(fetchMock, 2)).not.toHaveProperty('enable_thinking');
    });

    it('后端在本次会话里成功过之后再被拒绝:不另由直连再试', async () => {
      routed([() => reply('Q: 后端'), () => relayedError(403, 'region not supported')]);
      await rewriteQuery();
      await expect(rewriteQuery()).rejects.toThrow(/region not supported/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
    });

    it('本机或局域网地址、与来路无关的拒绝:不另由直连再试', async () => {
      routed([() => relayedError(400, 'The model `chat-model` does not exist'), () => relayedError(403, 'forbidden by local policy')]);
      await expect(rewriteQuery()).rejects.toThrow(/does not exist/);
      Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://192.168.1.20:11434/v1' });
      await expect(rewriteQuery()).rejects.toThrow(/HTTP 403/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
    });

    it('试着改用非流式之后酒馆只转来状态说明,直连给出同样状态的拒绝:报直连的,里面有原话', async () => {
      const noStream = () => relayedError(400, 'Streaming is not supported by this model');
      routed(
        [noStream, () => envelope('Forbidden'), noStream, () => envelope('Forbidden')],
        [() => rejected(403, 'region not supported'), () => rejected(404, 'not found')],
      );
      await expect(rewriteQuery()).rejects.toThrow(/HTTP 403[\s\S]*region not supported/);
      // 直连给的是另一种拒绝时仍报后端的
      const failure = await failureOf();
      expect(failure?.message).toMatch(/API 密钥无效或没有权限（HTTP 403）[\s\S]*看不到非流式这一次的原话[\s\S]*流式请求被拒绝时的原话：HTTP 400 · Streaming is not supported by this model/);
      expect(failure?.message).not.toContain('not found');
      expect(backendBodies().map(b => b.stream)).toEqual([true, false, true, false]);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, DIRECT, BACKEND, BACKEND, DIRECT]);
    });

    it('由直连再试时最多等 45 秒,不补发、不重试;等不到就报后端转来的拒绝', async () => {
      vi.useFakeTimers();
      Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 90, retries: 2 });
      fetchMock.mockImplementation((url: string, init: RequestInit) => (String(url) === BACKEND ? Promise.resolve(relayedError(403, 'region not supported')) : hangUntilAborted()(url, init)));
      const box: { error?: Error } = {};
      rewriteQuery().then(() => undefined, (e: Error) => { box.error = e; });
      await vi.advanceTimersByTimeAsync(REWRITE_OTHER_ROUTE_TIMEOUT_SEC * 1000 - 1000);
      expect(box.error).toBeUndefined();
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(box.error?.message).toMatch(/HTTP 403[\s\S]*region not supported/);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    });

    it('由直连再试的时候停止生成:取消,不报后端转来的拒绝', async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation((url: string, init: RequestInit) => (String(url) === BACKEND ? Promise.resolve(relayedError(403, 'region not supported')) : hangUntilAborted()(url, init)));
      const external = new AbortController();
      const pending = rewriteQuery(external.signal).then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
      external.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect((await pending)?.message).toMatch(/已取消/);
    });
  });

  /** 走后端的请求挂住、直连立即返回 direct() 的结果;返回一个发起一轮并等到补发之后的函数。 */
  const slowBackend = (direct: () => Promise<Response>, backend: (n: number) => Promise<Response> | null) => {
    let backendCalls = 0;
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (String(url) !== BACKEND) return direct();
      return backend(++backendCalls) ?? hangUntilAborted(signals)(url, init);
    });
    return { signals };
  };
  const roundWithHedge = async () => {
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(12000);
    return pending;
  };

  it('后端这次会话还没有答复过时,公网地址 12 秒没有返回,补发的一次由浏览器直连发出;一轮不改变先后', async () => {
    vi.useFakeTimers();
    let hang = true;
    const { signals } = slowBackend(async () => reply('Q: 直连补发'), () => (hang ? null : Promise.resolve(reply('Q: 后端'))));
    const result = await roundWithHedge();
    expect(result.queries).toEqual(['直连补发']);
    expect(result.stats).toMatchObject({ hedged: true, route: 'direct', fellBack: true });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    expect(signals[0].aborted).toBe(true);
    hang = false;
    const next = await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
    expect(next.stats).toMatchObject({ hedged: false, route: 'backend', fellBack: false });
  });

  it('后端一直没有答复、连续两轮靠直连补发取得结果后,本次会话先用直连', async () => {
    vi.useFakeTimers();
    slowBackend(async () => reply('Q: 直连补发'), () => null);
    await roundWithHedge();
    await roundWithHedge();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND, DIRECT]);
    const direct = await rewriteQuery();
    expect(sentUrls(fetchMock).slice(4)).toEqual([DIRECT]);
    expect(direct.stats).toMatchObject({ hedged: false, route: 'direct', fellBack: true });
  });

  it('后端答复过之后,慢的时候补发照旧经后端发出,不换成直连;后端超时后的下一轮重新试直连', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20 });
    // 后端各次请求的表现:第 1 次挂住(由直连补发取得结果);第 2 次正常;第 3 次挂住、第 4 次(补发)正常;
    // 第 5、6 次都挂住(超时);第 7 次挂住(由直连补发取得结果);第 8 次正常
    const plan = ['hang', 'reply', 'hang', 'reply', 'hang', 'hang', 'hang', 'reply'];
    slowBackend(async () => reply('Q: 直连补发'), n => (plan[n - 1] === 'reply' ? Promise.resolve(reply(`Q: 后端第${n}次`)) : null));
    await roundWithHedge();
    await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
    const slow = await roundWithHedge();
    expect(slow.queries).toEqual(['后端第4次']);
    expect(slow.stats).toMatchObject({ hedged: true, route: 'backend', fellBack: false });
    expect(sentUrls(fetchMock).slice(3)).toEqual([BACKEND, BACKEND]);
    // 两个后端请求都没有返回:超时
    const stuck = rewriteQuery();
    const check = expect(stuck).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(32000);
    await check;
    expect(sentUrls(fetchMock).slice(5)).toEqual([BACKEND, BACKEND]);
    // 超时之后不再当作「酒馆服务器连得上」:下一轮的补发重新试直连
    const rescued = await roundWithHedge();
    expect(sentUrls(fetchMock).slice(7)).toEqual([BACKEND, DIRECT]);
    expect(rescued.stats).toMatchObject({ hedged: true, route: 'direct', fellBack: true });
    // 中间后端答复过,靠直连补发的轮数重新计:这才是第 1 轮,下一轮仍先走后端
    const next = await rewriteQuery();
    expect(sentUrls(fetchMock).slice(9)).toEqual([BACKEND]);
    expect(next.queries).toEqual(['后端第8次']);
  });

  it('直连补发不通时改回经后端补发', async () => {
    vi.useFakeTimers();
    // 每一轮:第一个后端请求挂住,补发的后端请求返回
    slowBackend(() => Promise.reject(new TypeError('Failed to fetch')), n => (n % 2 === 0 ? Promise.resolve(reply('Q: 后端补发')) : null));
    const first = await roundWithHedge();
    expect(first.queries).toEqual(['后端补发']);
    expect(first.stats).toMatchObject({ hedged: true, route: 'backend', fellBack: false });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
    await roundWithHedge();
    expect(sentUrls(fetchMock).slice(3)).toEqual([BACKEND, BACKEND]);
  });

  it('直连补发不通、后端也一直没有答复:十分钟内的补发不再试直连,之后再试', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20 });
    slowBackend(() => Promise.reject(new TypeError('Failed to fetch')), () => null);
    const failedRound = async () => {
      const pending = rewriteQuery();
      const check = expect(pending).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(33000);
      await check;
    };
    await failedRound();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
    await failedRound();
    expect(sentUrls(fetchMock).slice(3)).toEqual([BACKEND, BACKEND]);
    await vi.advanceTimersByTimeAsync(REWRITE_DIRECT_RETRY_AFTER_MS);
    await failedRound();
    expect(sentUrls(fetchMock).slice(5)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('直连补发拖了很久才失败时不再经后端补发，两次都失败报第一个请求的错', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20 });
    fetchMock.mockImplementation(hangUntilAborted());
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/Query 重写：请求超时（超过 20 秒）/);
    await vi.advanceTimersByTimeAsync(20000); // 第一个请求（后端）超时，直连补发的那次还在等
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    await vi.advanceTimersByTimeAsync(12000); // 直连补发的那次也超时
    await check;
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
  });

  it('直连补发过了几秒才连不上、第一个请求随后超时：报超时，不把直连的失败算到后端头上', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20 });
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (String(url) === BACKEND) return hangUntilAborted()(url, init);
      return new Promise<Response>((_resolve, reject) => { setTimeout(() => reject(new TypeError('Failed to fetch')), 6000); });
    });
    const pending = rewriteQuery();
    const check = expect(pending).rejects.toThrow(/Query 重写：请求超时（超过 20 秒）/);
    await vi.advanceTimersByTimeAsync(20000);
    await check;
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
  });

  it('直连补发被服务商拒绝时不采用,仍等后端', async () => {
    vi.useFakeTimers();
    slowBackend(async () => rejected(403, 'origin not allowed'), n => (n % 2 === 0 ? Promise.resolve(reply('Q: 后端补发')) : null));
    const result = await roundWithHedge();
    expect(result.queries).toEqual(['后端补发']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('本机或局域网地址不补发;后端等到超时还没有答复过,才把浏览器直连当第二条路', async () => {
    vi.useFakeTimers();
    const local = 'http://192.168.1.20:11434/v1/chat/completions';
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://192.168.1.20:11434/v1' });
    fetchMock.mockImplementation((url: string, init: RequestInit) => (String(url) === BACKEND ? hangUntilAborted()(url, init) : Promise.resolve(reply('Q: 直连的查询'))));
    const pending = rewriteQuery();
    await vi.advanceTimersByTimeAsync(60000);
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
    await vi.advanceTimersByTimeAsync(30000);
    const result = await pending;
    expect(result.queries).toEqual(['直连的查询']);
    expect(result.stats).toMatchObject({ route: 'direct', fellBack: true, hedged: false });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, local]);
    // 之后本次会话先用直连
    await rewriteQuery();
    expect(sentUrls(fetchMock)).toEqual([BACKEND, local, local]);
  });

  it('停止生成时取消请求,不改用直连;补发之后停止时两个请求都取消', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(hangUntilAborted(signals));
    const external = new AbortController();
    const pending = rewriteQuery(external.signal);
    const check = expect(pending).rejects.toThrow(/已取消/);
    await vi.advanceTimersByTimeAsync(3000);
    external.abort();
    await check;
    expect(sentUrls(fetchMock)).toEqual([BACKEND]);
    expect(signals[0].aborted).toBe(true);

    const second = new AbortController();
    const hedgedRound = rewriteQuery(second.signal);
    const checkSecond = expect(hedgedRound).rejects.toThrow(/已取消/);
    await vi.advanceTimersByTimeAsync(13000);
    expect(sentUrls(fetchMock).slice(1)).toEqual([BACKEND, DIRECT]);
    second.abort();
    await checkSecond;
    expect(signals.slice(1).every(s => s.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sentUrls(fetchMock)).toHaveLength(3);
  });

  it('开始之前就已经停止生成:不发任何请求', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => reply('Q: 不该发出'));
    const external = new AbortController();
    external.abort();
    const pending = rewriteQuery(external.signal);
    const check = expect(pending).rejects.toThrow(/已取消/);
    await vi.advanceTimersByTimeAsync(60000);
    await check;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('查询重写请求(后备线路的时序)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetRewriteParamMemory();
    mocks.ctx = { chat: [{ name: 'User', is_user: true, is_system: false, mes: '还记得那个约定吗？' }], getRequestHeaders: () => HOST_HEADERS } as unknown as STContext;
    resetSettings('backend', 0);
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20 });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 一个请求的表现:立刻返回、挂住直到被取消、立刻失败,或过一会儿再返回或失败。 */
  type Step = (() => Response) | 'hang' | Error | { after: number; then: (() => Response) | Error };
  const play = (step: Step | undefined, init: RequestInit): Promise<Response> => {
    if (step === undefined || step === 'hang') return hangUntilAborted()('', init);
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === 'function') return Promise.resolve(step());
    return new Promise<Response>((resolve, reject) => {
      const outcome = step.then;
      const timer = setTimeout(() => (outcome instanceof Error ? reject(outcome) : resolve(outcome())), step.after);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  };
  /** 后端、直连各按顺序给出表现;用完之后的请求都挂住。 */
  const scripted = (backend: Step[], direct: Step[]) => {
    let b = 0, d = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => (String(url) === BACKEND ? play(backend[b++], init) : play(direct[d++], init)));
  };
  const blocked = new TypeError('Failed to fetch');
  const bodiesTo = (target: string) => fetchMock.mock.calls
    .filter(call => String(call[0]) === target)
    .map(call => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
  /**
   * 发起一轮,把时间拨到 ms 之后取结果(成功时在 result,失败时在 error)。
   * 到时候还没有结果就直接报错,免得挂到测试超时。
   */
  const run = async (ms: number, signal?: AbortSignal) => {
    const box: { outcome?: { result: Awaited<ReturnType<typeof rewriteQuery>> | null; error: Error | null } } = {};
    rewriteQuery(signal).then(result => { box.outcome = { result, error: null }; }, (error: Error) => { box.outcome = { result: null, error }; });
    await vi.advanceTimersByTimeAsync(ms);
    if (!box.outcome) throw new Error(`过了 ${ms} 毫秒这一轮还没有结果;已发出的请求:${sentUrls(fetchMock).join(' → ')}`);
    return box.outcome;
  };
  const timedOutLate = (after: number): Step => ({ after, then: () => hostError(`request to ${DIRECT} failed, reason: connect ETIMEDOUT 203.0.113.9:443`, 'ETIMEDOUT') });

  it('已经改成先用直连之后,直连偶尔断一次不会被停用:下一轮的补发照常走直连', async () => {
    scripted([], [() => reply('Q: 一'), () => reply('Q: 二'), blocked, blocked, () => reply('Q: 恢复')]);
    expect((await run(12000)).result?.queries).toEqual(['一']);
    expect((await run(12000)).result?.queries).toEqual(['二']);
    // 第三轮先用直连,这时网络断了:直连连不上,回到后端;后端仍然挂着,补发的直连也没连上,这一轮报超时
    const broken = await run(40000);
    expect(broken.error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(4)).toEqual([DIRECT, BACKEND, DIRECT, BACKEND]);
    // 第四轮:直连取得过答复,不套用十分钟的停用,12 秒后照常由直连补发
    const recovered = await run(12000);
    expect(recovered.result?.queries).toEqual(['恢复']);
    expect(recovered.result?.stats).toMatchObject({ route: 'direct', fellBack: true, hedged: true });
    expect(sentUrls(fetchMock).slice(8)).toEqual([BACKEND, DIRECT]);
  });

  it('直连起初不通、后来取得了答复:先前记下的「不通」不再算数', async () => {
    scripted(['hang', 'hang', refused, 'hang'], [blocked, () => reply('Q: 直连'), blocked, () => reply('Q: 补发')]);
    // 第一轮:后端挂住,直连补发不通(从没取得过答复,记下「不通」),改回经后端补发,都超时
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    // 第二轮:酒馆服务器明确连不上,改由直连,这次通了
    expect((await run(0)).result?.queries).toEqual(['直连']);
    // 第三轮先用直连,偶尔断一次,回到后端;后端挂住,12 秒后的补发仍然走直连
    const third = await run(12000);
    expect(third.result?.queries).toEqual(['补发']);
    expect(sentUrls(fetchMock).slice(-3)).toEqual([DIRECT, BACKEND, DIRECT]);
  });

  it('后端一直挂住、直连补发被限流:这一轮报限流(不是超时),下一轮照常由直连补发', async () => {
    scripted([], [() => rejected(429, 'rate limited'), () => reply('Q: 下一轮')]);
    const limited = await run(40000);
    expect(limited.error?.message).toMatch(/被服务商限流（HTTP 429）/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
    const next = await run(12000);
    expect(next.result?.queries).toEqual(['下一轮']);
    expect(sentUrls(fetchMock).slice(3)).toEqual([BACKEND, DIRECT]);
  });

  it('后端一直挂住、直连补发得到点名参数的拒绝:立刻去掉参数重发,重发先走直连;这只算一轮', async () => {
    scripted([], [() => rejected(400, 'Unrecognized request argument supplied: enable_thinking'), () => reply('Q: 查询')]);
    const { result } = await run(12000);
    expect(result?.queries).toEqual(['查询']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT]);
    expect(bodiesTo(DIRECT)[0]).toHaveProperty('enable_thinking', false);
    expect(bodiesTo(DIRECT)[1]).not.toHaveProperty('enable_thinking');
    // 靠直连取得结果只算一轮,下一轮仍先走后端;这个参数经后端也不再带
    scripted([() => reply('Q: 后端')], []);
    expect((await run(0)).result?.queries).toEqual(['后端']);
    expect(sentUrls(fetchMock).at(-1)).toBe(BACKEND);
    expect(bodiesTo(BACKEND).at(-1)).not.toHaveProperty('custom_include_body');
    expect(bodiesTo(BACKEND).at(-1)).toHaveProperty('top_p', 0.8);
  });

  it('后端一直挂住、直连补发说密钥不对:后端超时后报服务商的原话,不报超时', async () => {
    scripted([], [() => rejected(401, 'Token is invalid')]);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/API 密钥无效或没有权限（HTTP 401）[\s\S]*Token is invalid/);
    // 直连给过答复,不算不通:下一轮照常由直连补发
    scripted([], [() => reply('Q: 改对了')]);
    expect((await run(12000)).result?.queries).toEqual(['改对了']);
    expect(sentUrls(fetchMock).slice(-2)).toEqual([BACKEND, DIRECT]);
  });

  it('后端一直挂住、直连补发返回的不是有效数据:后端超时后报无效数据', async () => {
    scripted([], [() => new Response('<html><body>首页</body></html>', { status: 200 })]);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/不是有效数据/);
  });

  it.each([
    'This model only support stream mode, please enable the stream parameter',
    'Non-streaming requests are rejected for this model',
    '该模型不支持非流式调用',
  ])('只支持流式传输的模型拒绝了直连补发(直连是非流式的;%s):后端超时就报超时,不拿这条拒绝当原因', async message => {
    scripted([], [() => rejected(400, message)]);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/请求超时/);
    expect(error?.message).not.toContain(message.slice(0, 12));
  });

  it('直连补发的拒绝只是回显了请求体里的 stream:不算提到流式传输,后端超时后照样报它', async () => {
    const echoed = { error: { message: 'Field required: messages.0.name', input: { model: 'chat-model', stream: false } } };
    scripted([], [() => new Response(JSON.stringify(echoed), { status: 422, headers: JSON_TYPE })]);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/服务商拒绝了这次请求（HTTP 422）[\s\S]*Field required/);
    expect(error?.message).not.toContain('超时');
  });

  it('后端过了一会儿才报连不上、直连补发被只支持流式传输的模型拒绝:报后端的原因,注明直连也没有成功(不说没有连上)', async () => {
    scripted([timedOutLate(15000)], [() => rejected(400, 'This model only support stream mode, please enable the stream parameter')]);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/连接 API 服务器超时[\s\S]*改由浏览器直连也没有成功/);
    expect(error?.message).not.toContain('连上');
    // 直连很快就被拒绝,补发改回经后端发出
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('后端慢、最后按来路拒绝,补发的直连一直没有返回(随后被取消):这一轮不再另由直连试,被取消的也不算直连不通', async () => {
    scripted(
      [{ after: 15000, then: () => relayedError(403, 'region not supported') }, { after: 15000, then: () => relayedError(403, 'region not supported') }],
      ['hang', () => reply('Q: 直连的查询')],
    );
    const { error } = await run(15000);
    expect(error?.message).toMatch(/HTTP 403[\s\S]*region not supported/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    // 下一轮:后端答复过,不再由直连补发;被拒绝之后照常由直连再试一次
    const next = await run(15000);
    expect(next.result?.queries).toEqual(['直连的查询']);
    expect(sentUrls(fetchMock).slice(2)).toEqual([BACKEND, BACKEND, DIRECT]);
  });

  it('按来路拒绝之后由直连再试、直连一直没有返回:每次等满 45 秒,连着两次之后停用十分钟', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 90 });
    const refusal = () => relayedError(403, 'region not supported');
    scripted([refusal, refusal, refusal, refusal], []);
    const waited = async () => {
      const box: { error?: Error } = {};
      rewriteQuery().then(() => undefined, (e: Error) => { box.error = e; });
      await vi.advanceTimersByTimeAsync(REWRITE_OTHER_ROUTE_TIMEOUT_SEC * 1000 - 1000);
      const early = box.error;
      await vi.advanceTimersByTimeAsync(1000);
      return { early, error: box.error };
    };
    const first = await waited();
    expect(first.early).toBeUndefined();
    expect(first.error?.message).toMatch(/region not supported/);
    const second = await waited();
    expect(second.early).toBeUndefined();
    expect(second.error?.message).toMatch(/region not supported/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND, DIRECT]);
    // 第三轮:直连停用了,立刻报后端转来的拒绝
    expect((await run(0)).error?.message).toMatch(/region not supported/);
    expect(sentUrls(fetchMock).slice(4)).toEqual([BACKEND]);
    await vi.advanceTimersByTimeAsync(REWRITE_DIRECT_RETRY_AFTER_MS);
    const later = await waited();
    expect(later.early).toBeUndefined();
    expect(sentUrls(fetchMock).slice(5)).toEqual([BACKEND, DIRECT]);
  });

  it('后端过了一会儿才报连不上、直连补发已经被服务商拒绝:报服务商的原话,之后先用直连', async () => {
    scripted([timedOutLate(15000)], [() => rejected(401, 'Token is invalid'), () => reply('Q: 改对了')]);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/API 密钥无效或没有权限（HTTP 401）[\s\S]*Token is invalid/);
    const next = await run(0);
    expect(next.result?.queries).toEqual(['改对了']);
    expect(sentUrls(fetchMock).at(-1)).toBe(DIRECT);
    expect(next.result?.stats).toMatchObject({ route: 'direct', hedged: false });
  });

  it('后端只是慢、最后带着原话拒绝:报后端转来的原话;补发时直连已经试过,不因为这次拒绝再试一遍', async () => {
    scripted(
      [{ after: 15000, then: () => relayedError(403, 'region not supported by this provider') }],
      [() => rejected(403, 'origin not allowed'), () => reply('Q: 不该用到')],
    );
    const { error } = await run(15000);
    expect(error?.message).toMatch(/HTTP 403[\s\S]*region not supported by this provider/);
    expect(error?.message).not.toContain('origin not allowed');
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('直连从没取得过答复:等到超时一次不停用,连着两次才停用十分钟', async () => {
    scripted([], []); // 两条路都一直挂住
    // 第一轮:后端超时,直连补发也超时
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    // 第二轮:直连只超时过一次(可能只是服务商偶尔卡住),补发照常走直连;这次又超时
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(2)).toEqual([BACKEND, DIRECT]);
    // 第三轮:连着两次超时,停用,补发改回经后端
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(4)).toEqual([BACKEND, BACKEND]);
    // 十分钟后再试直连
    await vi.advanceTimersByTimeAsync(REWRITE_DIRECT_RETRY_AFTER_MS);
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(6)).toEqual([BACKEND, DIRECT]);
    // 停用过后重新计数:又超时一次不会立刻再停用
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(8)).toEqual([BACKEND, DIRECT]);
  });

  it('直连补发还在等、后端先返回时,被取消的直连不算不通', async () => {
    scripted([{ after: 15000, then: () => reply('Q: 后端') }, 'hang', 'hang'], ['hang', () => reply('Q: 直连补发')]);
    expect((await run(15000)).result?.queries).toEqual(['后端']);
    // 后端答复过之后超时一次(补发照旧经后端,这一轮报超时),再下一轮的补发仍然会试直连
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(2)).toEqual([BACKEND, BACKEND]);
    const next = await run(12000);
    expect(next.result?.queries).toEqual(['直连补发']);
  });

  it('两条路都不通、直连是挂住的:直连只试一次,报后端的原因并注明直连也没有成功', async () => {
    scripted([timedOutLate(15000)], ['hang']);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/连接 API 服务器超时[\s\S]*改由浏览器直连也没有成功/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
  });

  it('补发时直连试过没成,后端超时后不再把直连从头试一遍', async () => {
    scripted([], [() => reply('Q: 一'), blocked, () => reply('Q: 不该用到')]);
    expect((await run(12000)).result?.queries).toEqual(['一']);
    const { error } = await run(40000);
    expect(error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(2)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('直连补发不按重试次数重试:几秒内失败的来得及改回经后端补发', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { retries: 2 });
    scripted(['hang', () => reply('Q: 后端补发')], [{ after: 3000, then: blocked }, { after: 3000, then: blocked }, { after: 3000, then: blocked }]);
    const { result } = await run(15000);
    expect(result?.queries).toEqual(['后端补发']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('直连补发遇到服务商出错也只发一次,随即改回经后端补发', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { retries: 2 });
    scripted(['hang', () => reply('Q: 后端补发')], [() => rejected(503, 'overloaded'), () => rejected(503, 'overloaded'), () => rejected(503, 'overloaded')]);
    const { result } = await run(12000);
    expect(result?.queries).toEqual(['后端补发']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, BACKEND]);
  });

  it('超时比补发的时间点还短(没来得及补发):后端从没取回过答复时把直连当第二条路,之后先用直连', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 5 });
    scripted([], [() => reply('Q: 直连'), () => reply('Q: 第二轮')]);
    const first = await run(5000);
    expect(first.result?.queries).toEqual(['直连']);
    expect(first.result?.stats).toMatchObject({ route: 'direct', fellBack: true, hedged: false });
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT]);
    expect((await run(0)).result?.queries).toEqual(['第二轮']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, DIRECT, DIRECT]);
  });

  it('后端取回过答复之后再超时(本机地址):不改用直连', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1' });
    scripted([() => reply('Q: 一')], [() => reply('Q: 不该用到')]);
    expect((await run(0)).result?.queries).toEqual(['一']);
    const { error } = await run(20000);
    expect(error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND]);
  });

  it('后端超时后改试直连的时候停止生成:取消,不报超时', async () => {
    const local = 'http://127.0.0.1:11434/v1/chat/completions';
    Object.assign(mocks.settings.vector.queryRewrite, { url: 'http://127.0.0.1:11434/v1', timeoutSec: 5 });
    scripted([], ['hang']);
    const external = new AbortController();
    const pending = rewriteQuery(external.signal).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(6000);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, local]);
    external.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending)?.message).toMatch(/已取消/);
  });

  it('先用直连之后直连等到超时:后端这次会话成功过,下一轮回到先走后端', async () => {
    scripted(
      [() => reply('Q: 后端一'), 'hang', 'hang', 'hang', 'hang', () => reply('Q: 后端又好了')],
      [() => reply('Q: 直连一'), () => reply('Q: 直连二'), 'hang', 'hang'],
    );
    expect((await run(0)).result?.queries).toEqual(['后端一']);
    expect((await run(40000)).error?.message).toMatch(/请求超时/); // 两个后端请求都挂住
    expect((await run(12000)).result?.queries).toEqual(['直连一']);
    expect((await run(12000)).result?.queries).toEqual(['直连二']); // 连续两轮靠直连,之后先用直连
    expect((await run(40000)).error?.message).toMatch(/请求超时/); // 这一轮两个直连请求都挂住
    expect(sentUrls(fetchMock).slice(-2)).toEqual([DIRECT, DIRECT]);
    const back = await run(0);
    expect(back.result?.queries).toEqual(['后端又好了']);
    expect(sentUrls(fetchMock).at(-1)).toBe(BACKEND);
  });

  it('先用直连之后直连等到超时:后端这次会话从没成功过,仍然先用直连', async () => {
    scripted([], [() => reply('Q: 一'), () => reply('Q: 二'), 'hang', 'hang', () => reply('Q: 直连恢复')]);
    await run(12000);
    await run(12000);
    expect((await run(40000)).error?.message).toMatch(/请求超时/);
    expect(sentUrls(fetchMock).slice(-2)).toEqual([DIRECT, DIRECT]);
    const next = await run(0);
    expect(next.result?.queries).toEqual(['直连恢复']);
    expect(sentUrls(fetchMock).at(-1)).toBe(DIRECT);
  });

  it('后端答复过之后,酒馆服务器在连接阶段就失败(过一阵才报连接超时):不等补发的那个请求,直接换直连', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 90 });
    scripted([() => reply('Q: 后端'), timedOutLate(21000), 'hang'], [() => reply('Q: 直连')]);
    expect((await run(0)).result?.queries).toEqual(['后端']);
    const { result } = await run(21000);
    expect(result?.queries).toEqual(['直连']);
    expect(sentUrls(fetchMock).slice(1)).toEqual([BACKEND, BACKEND, DIRECT]);
  });

  it('后端答复过之后,一个请求连上之后被重置:另一个后端请求照样等,它成功就用它', async () => {
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 90 });
    const reset: Step = { after: 14000, then: () => hostError(`request to ${DIRECT} failed, reason: socket hang up`, 'ECONNRESET') };
    scripted([() => reply('Q: 后端'), reset, { after: 4000, then: () => reply('Q: 补发的') }], [() => reply('Q: 不该用到')]);
    expect((await run(0)).result?.queries).toEqual(['后端']);
    const { result } = await run(16000);
    expect(result?.queries).toEqual(['补发的']);
    expect(sentUrls(fetchMock).slice(1)).toEqual([BACKEND, BACKEND]);
  });

  it('酒馆自己的拒绝不算后端答复过:下一轮慢的时候补发仍然试直连', async () => {
    for (const refusal of [
      () => new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
      () => new Response(JSON.stringify({ error: true }), { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } }),
    ]) {
      resetRewriteParamMemory();
      fetchMock.mockReset();
      scripted([refusal], [() => reply('Q: 直连补发')]);
      expect((await run(0)).error?.message).toMatch(/Query 重写：酒馆/);
      const next = await run(12000);
      expect(next.result?.queries).toEqual(['直连补发']);
      expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, DIRECT]);
    }
  });

  it('返回的不是有效数据也说明酒馆服务器连得上这个地址:之后慢的时候补发照旧经后端', async () => {
    scripted(
      [() => relayed(200, '<html><body>首页</body></html>'), 'hang', () => reply('Q: 后端补发')],
      [() => reply('Q: 不该用到')],
    );
    expect((await run(0)).error?.message).toMatch(/不是有效数据/);
    const next = await run(12000);
    expect(next.result?.queries).toEqual(['后端补发']);
    expect(sentUrls(fetchMock)).toEqual([BACKEND, BACKEND, BACKEND]);
  });
});

describe('查询重写请求(浏览器直连,补发与报错)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetRewriteParamMemory();
    mocks.ctx = { chat: [{ name: 'User', is_user: true, is_system: false, mes: '还记得那个约定吗？' }], getRequestHeaders: () => HOST_HEADERS } as unknown as STContext;
    resetSettings('direct', 0);
    Object.assign(mocks.settings.vector.queryRewrite, { timeoutSec: 20 });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  /** 发起一轮,立刻取结果(不需要等待的情形)。 */
  const now = async () => {
    const box: { result?: Awaited<ReturnType<typeof rewriteQuery>>; error?: Error } = {};
    rewriteQuery().then(result => { box.result = result; }, (error: Error) => { box.error = error; });
    await vi.advanceTimersByTimeAsync(0);
    return box;
  };

  it('补发之后先返回的不是有效数据:立刻报错,不等另一个请求(与改动前一致)', async () => {
    fetchMock
      .mockImplementationOnce(hangUntilAborted())
      .mockResolvedValueOnce(new Response('<html><body>首页</body></html>', { status: 200 }));
    const box: { error?: Error | null } = {};
    rewriteQuery().then(() => { box.error = null; }, (e: Error) => { box.error = e; });
    await vi.advanceTimersByTimeAsync(12000);
    expect(box.error?.message).toMatch(/不是有效数据/);
  });

  it('补发的那次连不上、第一个请求随后返回:用第一个请求的结果(与改动前一致)', async () => {
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>(resolve => { setTimeout(() => resolve(reply('Q: 第一个请求')), 15000); }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const box: { queries?: string[] } = {};
    rewriteQuery().then(result => { box.queries = result.queries; }, () => { box.queries = []; });
    await vi.advanceTimersByTimeAsync(15000);
    expect(box.queries).toEqual(['第一个请求']);
  });

  it('补发后两个都失败:报先失败的那个(与改动前一致)', async () => {
    fetchMock
      .mockImplementationOnce(hangUntilAborted())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const pending = rewriteQuery().then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect((await pending)?.message).toMatch(/浏览器无法访问这个地址/);
  });

  it('请求不带流式传输;报错里说不支持流式传输也不当成可以去掉的参数', async () => {
    fetchMock.mockResolvedValueOnce(rejected(400, 'stream is not supported for this model'));
    const { error } = await now();
    expect(error?.message).toMatch(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock, 0)).toHaveProperty('stream', false);
  });

  it('服务商用 200 报错时按拒绝处理,带它的原话;原文点了可选参数的名就去掉再发', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'insufficient balance' } }), { status: 200 }));
    expect((await now()).error?.message).toMatch(/余额或额度不足[\s\S]*insufficient balance/);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unknown field "top_p"' } }), { status: 200 }))
      .mockResolvedValueOnce(reply('Q: 查询'));
    expect((await now()).result?.queries).toEqual(['查询']);
    expect(sentBody(fetchMock, 2)).not.toHaveProperty('top_p');
    expect(sentBody(fetchMock, 2)).toHaveProperty('enable_thinking', false);
    // 既有 error 又有正常回复的算回复
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'warning' }, choices: [{ message: { content: 'Q: 照常' } }] }), { status: 200 }));
    expect((await now()).result?.queries).toEqual(['照常']);
  });

  it('服务商自己的 500(原话里带着证书之类的词)按服务商出错报并重试,不说成浏览器无法访问', async () => {
    mocks.settings.vector.queryRewrite.retries = 1;
    fetchMock.mockImplementation(async () => rejected(500, 'x509: certificate signed by unknown authority'));
    const box: { error?: Error } = {};
    rewriteQuery().then(() => undefined, (e: Error) => { box.error = e; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(box.error?.message).toMatch(/Query 重写：服务商出错（HTTP 500）[\s\S]*x509/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('回复是空的:建议重试或换模型,不提查询重写没有的「流式传输」开关;一般的 400 也不提副 API 渠道的设置', async () => {
    fetchMock.mockResolvedValueOnce(reply(''));
    const empty = (await now()).error;
    expect(empty?.message).toMatch(/API 返回了空内容[\s\S]*换一个模型/);
    expect(empty?.message).not.toMatch(/流式|开关/);
    fetchMock.mockResolvedValueOnce(rejected(400, 'something odd happened'));
    const bad = (await now()).error;
    expect(bad?.message).toMatch(/服务商拒绝了这次请求（HTTP 400）。常见原因是模型名不对[\s\S]*或接口不接受某个参数/);
    expect(bad?.message).not.toMatch(/副 API|预填充/);
    // 直连不用流式传输:原话提到流式传输也不建议改成直连
    fetchMock.mockResolvedValueOnce(rejected(400, 'stream cannot be used here'));
    expect((await now()).error?.message).not.toContain('浏览器直连');
  });

  it('接口对角色顺序仍有要求(发出去的消息已经交替):说明多半是模板不接受 system,不提副 API 渠道的「发送预填充」', async () => {
    fetchMock.mockResolvedValueOnce(rejected(400, 'Conversation roles must alternate user/assistant/user/assistant/...'));
    const failure = (await now()).error;
    expect(failure?.message).toMatch(/Query 重写：服务商拒绝了这次请求（HTTP 400）。这个接口对消息的角色顺序有要求。Query 重写发出的消息是开头一条 system，之后 user 和 assistant 交替；仍被拒绝时，多半是这个模型的对话模板不接受 system 消息，可以换一个对话模型或接口。（HTTP 400 · Conversation roles must alternate/);
    expect(failure?.message).not.toMatch(/预填充|渠道|常见原因|不一定满足/);
  });

  it.each([
    'System role not supported',
    'Error rendering prompt with jinja template: "System role not supported".',
    "Unsupported value: 'messages[0].role' does not support 'system' with this model.",
    'System messages are not supported by this model',
  ])('接口不接受 system 消息(%s):写明这一点,不按一般的拒绝说明', async message => {
    fetchMock.mockResolvedValueOnce(rejected(400, message));
    const failure = (await now()).error;
    expect(failure?.message).toMatch(/Query 重写：服务商拒绝了这次请求（HTTP 400）。这个接口不接受 system 消息，而 Query 重写的提示词放在开头的 system 消息里，可以换一个对话模型或接口。（HTTP 400 · /);
    expect(failure?.message).not.toMatch(/常见原因|角色顺序/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('只是提到 system、或在回显的请求体里带着这句话的 400:照一般的拒绝说明', async () => {
    fetchMock.mockResolvedValueOnce(rejected(400, 'The system is busy, this operation is not supported right now'));
    expect((await now()).error?.message).toMatch(/服务商拒绝了这次请求（HTTP 400）。常见原因是/);
    fetchMock.mockResolvedValueOnce(rejected(400, 'Bad request. Body: {"model": "chat-model", "messages": [{"role": "user", "content": "system role not supported"}]}'));
    const echoed = (await now()).error;
    expect(echoed?.message).toMatch(/服务商拒绝了这次请求（HTTP 400）。常见原因是/);
    expect(echoed?.message).not.toMatch(/不接受 system 消息/);
  });

  it('最大输出超过上限的说明照旧', async () => {
    fetchMock.mockResolvedValueOnce(rejected(400, 'max_tokens is too large: 100000 > 8192'));
    expect((await now()).error?.message).toMatch(/Query 重写：最大输出超过了这个模型的上限（HTTP 400）/);
  });

  it('用 200 报错又没有写原因:说明里不提酒馆和「流式传输」开关', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: true }), { status: 200 }));
    const failure = (await now()).error;
    expect(failure?.message).toMatch(/Query 重写：API 返回了错误，没有说明原因。可以重试/);
    expect(failure?.message).not.toMatch(/流式|酒馆/);
  });

  it('结束原因是出错一类:最后一行可能只写了一半,不拿去检索;一行完整的都没有时报中断(非流式回复同样处理)', async () => {
    const cut = (content: string, finish: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });
    fetchMock.mockResolvedValueOnce(cut('INTENT: 意图\nQ: 第一条\nQ: 第二条写到一', 'insufficient_system_resource'));
    expect((await now()).result).toMatchObject({ intent: '意图', queries: ['第一条'] });
    fetchMock.mockResolvedValueOnce(cut('Q: 写到一', 'error'));
    expect((await now()).error?.message).toMatch(/Query 重写：服务商中途中断了回复/);
    // 正常结束的回复最后一行不带换行,照用
    fetchMock.mockResolvedValueOnce(cut('Q: 第一条\nQ: 第二条', 'stop'));
    expect((await now()).result?.queries).toEqual(['第一条', '第二条']);
  });
});

describe('本机或局域网地址的判断', () => {
  it.each([
    'http://localhost:11434/v1/chat/completions',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
    'http://0.0.0.0:11434/v1',
    'http://10.0.0.8:8000/v1',
    'http://172.16.3.4/v1',
    'http://172.31.255.1/v1',
    'http://192.168.1.20:1234/v1',
    'http://169.254.10.1/v1',
    'http://100.100.5.6:11434/v1',
    'http://[fd12:3456::1]/v1',
    'http://[fe80::1]/v1',
    'http://ollama:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://nas.local:8080/v1',
    'http://box.lan/v1',
    'not a url',
    '',
  ])('%s 算本机或局域网', url => {
    expect(isLocalAddress(url)).toBe(true);
  });

  it.each([
    'https://api.siliconflow.cn/v1/chat/completions',
    'https://example.test/v1',
    'http://172.32.0.1/v1',
    'http://172.15.0.1/v1',
    'http://192.169.1.1/v1',
    'http://100.128.0.1/v1',
    'http://8.8.8.8/v1',
    'https://[2001:db8::1]/v1',
    'https://localhost.example.com/v1',
  ])('%s 算公网', url => {
    expect(isLocalAddress(url)).toBe(false);
  });
});
