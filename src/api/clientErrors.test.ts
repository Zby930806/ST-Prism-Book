import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from './settings';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { ApiError, requestCompletion, requestViaMainApi, testChannel } from './client';

const channel: ApiChannel = {
  id: 'err-test', name: '测试渠道', url: 'https://example.invalid/v1', key: 'k',
  model: 'mock', temperature: 1, maxTokens: 1024, timeoutSec: 5,
  stream: false, prefill: true, excludeParams: [], reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hello' }];
const sse = (...chunks: unknown[]) => chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n\n') + '\n\n';
let generateRaw: ReturnType<typeof vi.fn>;

function respond(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch(cause => cause);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

beforeEach(() => {
  generateRaw = vi.fn();
  vi.spyOn(context, 'getContext').mockReturnValue({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    generateRaw,
  } as unknown as STContext);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected fetch')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('回复被截断、审核或为空', () => {
  it('非流式 finish_reason=length：报截断并带回半截内容、输出量与最大输出', async () => {
    respond(Response.json({ choices: [{ message: { content: '{"summary":"写到一半' }, finish_reason: 'length' }], usage: { completion_tokens: 1024 } }));
    const error = await failure(requestCompletion(channel, messages));
    expect(error).toMatchObject({ kind: 'truncated', partial: '{"summary":"写到一半' });
    expect(error.message).toContain('回复被截断');
    expect(error.message).toContain('当前最大输出是 1024 tokens');
    expect(error.detail).toBe('finish_reason=length · 已输出 1024 tokens · 最大输出设置 1024');
  });

  it('流式最后一个分块带 finish_reason=length 时同样报截断', async () => {
    respond(new Response(sse(
      { choices: [{ delta: { content: '{"summary":' } }] },
      { choices: [{ delta: { content: '"半截' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      '[DONE]',
    )));
    const onDelta = vi.fn();
    const error = await failure(requestCompletion({ ...channel, stream: true }, messages, { onDelta }));
    expect(error).toMatchObject({ kind: 'truncated', partial: '{"summary":"半截' });
    expect(onDelta).toHaveBeenLastCalledWith('{"summary":"半截');
  });

  it('思考占满输出额度、正文为空时说清是思考阶段用完了额度', async () => {
    respond(Response.json({ choices: [{ message: { content: '', reasoning_content: '一直在想…' }, finish_reason: 'length' }] }));
    const error = await failure(requestCompletion(channel, messages));
    expect(error.kind).toBe('truncated');
    expect(error.title).toContain('思考阶段');
    respond(new Response(sse({ choices: [{ delta: { reasoning_content: '想' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] })));
    expect((await failure(requestCompletion({ ...channel, stream: true }, messages))).title).toContain('思考阶段');
  });

  it('OpenRouter 的 native_finish_reason 与 Anthropic 的 stop_reason 也能识别', async () => {
    respond(Response.json({ choices: [{ message: { content: '半截' }, finish_reason: null, native_finish_reason: 'MAX_TOKENS' }] }));
    expect((await failure(requestCompletion(channel, messages))).kind).toBe('truncated');
    respond(Response.json({ content: [{ type: 'text', text: '半截' }], stop_reason: 'max_tokens' }));
    expect((await failure(requestCompletion(channel, messages))).partial).toBe('半截');
  });

  it('排除了 max_tokens 时不报具体上限，说明由服务商决定', async () => {
    respond(Response.json({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }));
    const error = await failure(requestCompletion({ ...channel, excludeParams: ['max_tokens'] }, messages));
    expect(error.hint).not.toContain('当前最大输出是');
    expect(error.detail).toContain('最大输出未发送');
  });

  it('内容审核拦截与空内容分别说明', async () => {
    respond(Response.json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }));
    expect(await failure(requestCompletion(channel, messages))).toMatchObject({ kind: 'filtered', title: '回复被服务商的内容审核拦截了' });
    respond(Response.json({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }));
    expect(await failure(requestCompletion(channel, messages))).toMatchObject({ kind: 'empty', title: 'API 返回了空内容' });
  });

  it('正常结束的回复照常返回', async () => {
    respond(Response.json({ choices: [{ message: { content: ' 完成 ' }, finish_reason: 'stop' }] }));
    await expect(requestCompletion(channel, messages)).resolves.toBe('完成');
  });
});

describe('酒馆代理与上游的各种错误形态', () => {
  it('非流式：酒馆把上游错误改写成 200 + statusText，据此还原原因', async () => {
    respond(Response.json({ error: { message: 'Unauthorized' }, quota_error: false }));
    expect(await failure(requestCompletion(channel, messages))).toMatchObject({ kind: 'auth', status: 401 });
    respond(Response.json({ error: { message: 'Too Many Requests' }, quota_error: true }));
    expect((await failure(requestCompletion(channel, messages))).kind).toBe('quota');
    respond(Response.json({ error: { message: 'Unknown error occurred' }, quota_error: false }));
    expect((await failure(requestCompletion(channel, messages))).hint).toContain('流式传输');
  });

  it('流式：酒馆把 401 改成 400，按 statusText 还原，并脱敏服务商原话', async () => {
    respond(new Response('{"error":{"message":"Incorrect API key provided: sk-abcdefgh12345678"}}', { status: 400, statusText: 'Unauthorized' }));
    const error = await failure(requestCompletion({ ...channel, stream: true }, messages));
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(error.detail).toContain('sk-***');
    expect(error.detail).not.toContain('abcdefgh12345678');
  });

  it('酒馆连不上上游时给出域名/连接层面的原因', async () => {
    respond(Response.json({ error: { message: 'request to https://api.bad.invalid/v1/chat/completions failed, reason: getaddrinfo ENOTFOUND api.bad.invalid', code: 'ENOTFOUND' } }, { status: 502 }));
    expect(await failure(requestCompletion(channel, messages))).toMatchObject({ kind: 'network', title: '找不到 API 服务器（域名解析失败）' });
  });

  it('非流式返回网页（不是 JSON）时提示地址指向了网页', async () => {
    respond(new Response('<html><title>Welcome</title></html>', { status: 200 }));
    expect(await failure(requestCompletion(channel, messages))).toMatchObject({ kind: 'format', title: 'API 返回的不是有效数据' });
  });

  it('开了流式但中转直接回整段 JSON：照常取出内容，错误信封也能识别', async () => {
    respond(new Response(JSON.stringify({ choices: [{ message: { content: '整段回复' }, finish_reason: 'stop' }] })));
    const onDelta = vi.fn();
    await expect(requestCompletion({ ...channel, stream: true }, messages, { onDelta })).resolves.toBe('整段回复');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('整段回复');
    respond(new Response(JSON.stringify({ error: { message: 'Bad Request' } })));
    expect(await failure(requestCompletion({ ...channel, stream: true }, messages))).toMatchObject({ kind: 'bad-request', status: 400 });
  });

  it('浏览器连不上酒馆本身时说明是酒馆服务器的问题', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await failure(requestCompletion(channel, messages))).toMatchObject({ kind: 'network', title: '连不上酒馆服务器' });
  });

  it('渠道没填完整时指出缺什么，不发请求', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect((await failure(requestCompletion({ ...channel, model: '' }, messages))).title).toBe('「测试渠道」还没有填写模型名');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('连接测试与主 API', () => {
  it('能连通但回复被截断时报「连接正常」并说明最大输出问题', async () => {
    respond(Response.json({ choices: [{ message: { content: '' , reasoning_content: '想' }, finish_reason: 'length' }] }));
    const result = await testChannel({ ...channel, maxTokens: 16 });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('连接正常，但测试回复被截断');
    expect(result.message).toContain('16 tokens');
    expect(result.warning).toBe(true);
    expect(result.detail).toContain('finish_reason=length');
  });

  it('密钥错误时测试失败并给出可读原因', async () => {
    respond(Response.json({ error: { message: 'Unauthorized' } }));
    const result = await testChannel(channel);
    expect(result).toMatchObject({ ok: false });
    expect(result.warning).toBeUndefined();
    expect(result.message).toContain('API 密钥无效或没有权限（HTTP 401）');
    expect(result.detail).toContain('HTTP 401');
  });

  it('非流式 404 也会尝试另一种 /v1 写法（还原状态码后才能触发）', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: 'Not Found' } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const draft = { ...channel, url: 'https://relay.example' };
    const result = await testChannel(draft);
    expect(result.ok).toBe(true);
    expect(draft.url).toBe('https://relay.example');
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).reverse_proxy).toBe('https://relay.example');
  });

  it('主 API 抛出 [object Object] 时不展示无意义的原文，引导看酒馆报错', async () => {
    generateRaw.mockRejectedValueOnce(new Error('[object Object]'));
    const error = await failure(requestViaMainApi(messages));
    expect(error).toMatchObject({ kind: 'upstream', title: '主 API 请求失败', detail: '' });
    expect(error.hint).toContain('酒馆弹出的报错');
    generateRaw.mockRejectedValueOnce(new Error('No message generated'));
    expect((await failure(requestViaMainApi(messages))).kind).toBe('empty');
    generateRaw.mockResolvedValueOnce('   ');
    expect((await failure(requestViaMainApi(messages))).title).toBe('主 API 返回了空内容');
  });
});
