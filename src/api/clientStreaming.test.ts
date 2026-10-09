import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from './settings';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { ApiError, requestCompletion } from './client';

const channel: ApiChannel = {
  id: 'stream-test', name: '测试渠道', url: 'https://example.invalid', key: '',
  model: 'mock', temperature: 1, maxTokens: 1024, timeoutSec: 2,
  stream: true, prefill: true, excludeParams: [], reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hello' }];
const encoder = new TextEncoder();
const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

function mockResponse(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  });
  const fetchMock = mockResponse(new Response(body));
  return { body, controller, cancel, fetchMock };
}

beforeEach(() => {
  vi.spyOn(context, 'getContext').mockReturnValue({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  } as unknown as STContext);
  // 所有测试都必须使用本地 mock,意外调用 fetch 时直接失败。
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected fetch')));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requestCompletion streaming progress', () => {
  it('在 EOF 前逐次回调累计原文,最终返回值仍去除首尾空白', async () => {
    const { body, controller } = openStream();
    const onDelta = vi.fn();
    const promise = requestCompletion(channel, messages, { onDelta });
    controller.enqueue(encoder.encode(`${event('  你')}\n\n`));
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledExactlyOnceWith('  你'));
    controller.enqueue(encoder.encode(`${event('好 ')}\n\n`));
    await vi.waitFor(() => expect(onDelta).toHaveBeenLastCalledWith('  你好 '));
    controller.close();
    await expect(promise).resolves.toBe('你好');
    expect(onDelta.mock.calls).toEqual([['  你'], ['  你好 ']]);
    expect(body.locked).toBe(false);
  });

  it('跨字节分块解码中文和 emoji,解析没有换行的 EOF 尾行', async () => {
    const bytes = encoder.encode(`${event('你🙂')}\r\n\r\n${event('好')}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    mockResponse(new Response(body));
    const onDelta = vi.fn();
    await expect(requestCompletion(channel, messages, { onDelta })).resolves.toBe('你🙂好');
    expect(onDelta.mock.calls).toEqual([['你🙂'], ['你🙂好']]);
  });

  it('未传回调的旧调用也保留没有换行的最后一个事件', async () => {
    mockResponse(new Response(`${event('legacy')}`));
    await expect(requestCompletion(channel, messages)).resolves.toBe('legacy');
  });

  it('忽略心跳、坏 JSON、role、空增量及非文本内容,兼容 message/text 字段', async () => {
    mockResponse(new Response([
      ': heartbeat', 'event: message', 'data: {bad json}',
      'data: {"choices":[{"delta":{"role":"assistant"}}]}', event(''),
      'data: {"choices":[{"delta":{"content":42}}]}', event('A'),
      'data: {"choices":[{"message":{"content":"B"}}]}',
      'data: {"choices":[{"text":"C"}]}', 'data: [DONE]', '',
    ].join('\n')));
    const onDelta = vi.fn();
    await expect(requestCompletion(channel, messages, { onDelta })).resolves.toBe('ABC');
    expect(onDelta.mock.calls).toEqual([['A'], ['AB'], ['ABC']]);
  });

  it('DONE 终止读取,不等待连接关闭也不拼接之后的事件', async () => {
    const { body, controller, cancel } = openStream();
    controller.enqueue(encoder.encode(`${event('ok')}\n\ndata: [DONE]\n\n${event('ignored')}\n`));
    const onDelta = vi.fn();
    await expect(requestCompletion(channel, messages, { onDelta })).resolves.toBe('ok');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('ok');
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it.each(['\n\n', ''])('错误事件不会被当作 JSON 噪声吞掉 (ending=%j)', async ending => {
    const body = new Response(`${event('partial')}\n\ndata: {"error":{"message":"upstream failed"}}${ending}`);
    mockResponse(body);
    const onDelta = vi.fn();
    const error = await requestCompletion(channel, messages, { onDelta }).catch(cause => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.detail).toContain('upstream failed');
    expect(error.message).toContain('API 返回了错误');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('partial');
    expect(body.body?.locked).toBe(false);
  });

  it('回调异常正常传播并释放 reader,不被 JSON 容错吞掉', async () => {
    const { body, controller, cancel } = openStream();
    controller.enqueue(encoder.encode(`${event('hello')}\n`));
    const error = new Error('callback failed');
    await expect(requestCompletion(channel, messages, { onDelta: () => { throw error; } })).rejects.toBe(error);
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('空流继续抛出空内容错误', async () => {
    mockResponse(new Response('data: [DONE]'));
    const onDelta = vi.fn();
    await expect(requestCompletion(channel, messages, { onDelta })).rejects.toMatchObject({ kind: 'empty', title: 'API 返回了空内容' });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('非流式请求维持原有返回值,不触发流式回调', async () => {
    mockResponse(Response.json({ choices: [{ message: { content: '  complete  ' } }] }));
    const onDelta = vi.fn();
    await expect(requestCompletion({ ...channel, stream: false }, messages, { onDelta })).resolves.toBe('complete');
    expect(onDelta).not.toHaveBeenCalled();
  });
});

describe('stream reader edge cases', () => {
  it('没有可读 body 时仍兼容 JSON 回退并通知一次', async () => {
    mockResponse({
      ok: true, body: null,
      json: async () => ({ choices: [{ message: { content: ' fallback ' } }] }),
    } as Response);
    const onDelta = vi.fn();
    await expect(requestCompletion(channel, messages, { onDelta })).resolves.toBe('fallback');
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('fallback');
  });

  it('网络读取异常不被吞掉,且不把缓冲区里的残缺事件当作 EOF 成功返回', async () => {
    const { body, controller } = openStream();
    const onDelta = vi.fn();
    const error = new Error('connection lost');
    const promise = requestCompletion(channel, messages, { onDelta });
    const rejection = expect(promise).rejects.toBe(error);
    controller.enqueue(encoder.encode(`${event('partial')}\n${event('not committed')}`));
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledExactlyOnceWith('partial'));
    controller.error(error);
    await rejection;
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('底层 cancel 永不完成也不会阻塞超时错误返回', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    mockResponse(new Response(body));
    const onDelta = vi.fn();
    const promise = requestCompletion(channel, messages, { onDelta });
    const rejection = expect(promise).rejects.toThrow('API 请求超时（超过 2 秒）');
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onDelta).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stream cancellation and timeout', () => {
  it('外部取消能打断等待中的读取,保留 AbortError 而非超时错误', async () => {
    const { body, controller, cancel, fetchMock } = openStream();
    const external = new AbortController();
    const onDelta = vi.fn();
    const promise = requestCompletion(channel, messages, { signal: external.signal, onDelta });
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.enqueue(encoder.encode(`${event('partial')}\n`));
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledTimes(1));
    external.abort();
    await rejection;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(onDelta.mock.calls).toEqual([['partial']]);
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('回调内取消后,同一缓冲区中的后续事件不再触发回调', async () => {
    const external = new AbortController();
    mockResponse(new Response(`${event('A')}\n${event('B')}\n`));
    const onDelta = vi.fn(() => external.abort());
    await expect(requestCompletion(channel, messages, { signal: external.signal, onDelta }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('A');
  });

  it('已经取消的 signal 不产生增量回调', async () => {
    const external = new AbortController();
    external.abort();
    mockResponse(new Response(`${event('ignored')}\n`));
    const onDelta = vi.fn();
    await expect(requestCompletion(channel, messages, { signal: external.signal, onDelta }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('超时覆盖等待中的流式读取,保留已有错误文案并清理计时器', async () => {
    vi.useFakeTimers();
    const { body, controller, cancel, fetchMock } = openStream();
    const onDelta = vi.fn();
    const promise = requestCompletion(channel, messages, { onDelta });
    const rejection = expect(promise).rejects.toThrow('API 请求超时（超过 2 秒）');
    controller.enqueue(encoder.encode(`${event('partial')}\n`));
    await vi.advanceTimersByTimeAsync(0);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('partial');
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('正常完成移除外部取消监听并清理超时计时器', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    const fetchMock = mockResponse(new Response(`${event('ok')}\n`));
    await expect(requestCompletion(channel, messages, { signal: external.signal })).resolves.toBe('ok');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    external.abort();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it('非流式 JSON 读取仍受超时控制', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    } as Response)));
    const promise = requestCompletion({ ...channel, stream: false }, messages);
    const rejection = expect(promise).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
