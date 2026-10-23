import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from './settings';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { ApiError, requestCompletion } from './client';
import { isRetryable, partialReply, timeoutFailure } from './errors';

// 流式请求的超时按「多久没有收到数据」计算；非流式请求仍按整次请求计算。
const channel: ApiChannel = {
  id: 'timeout-test', name: '测试渠道', url: 'https://example.invalid', key: '',
  model: 'mock', temperature: 1, maxTokens: 1024, timeoutSec: 10,
  stream: true, prefill: false, excludeParams: [], reasoningEffort: '',
};
const messages = [{ role: 'user' as const, content: 'hello' }];
const encoder = new TextEncoder();
const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
  return { controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(context, 'getContext').mockReturnValue({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  } as unknown as STContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('流式请求按空闲时长计时', () => {
  it('持续收到正文时不受超时设置限制，总时长超过超时也照常完成', async () => {
    const { controller } = openStream();
    const promise = requestCompletion(channel, messages);
    // 每 8 秒来一段（小于 10 秒的超时），总共 40 秒
    for (let i = 0; i < 5; i++) {
      controller.enqueue(encoder.encode(event(String(i))));
      await vi.advanceTimersByTimeAsync(8000);
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    await expect(promise).resolves.toBe('01234');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('心跳、SSE 注释和思考增量同样算作有数据', async () => {
    const { controller } = openStream();
    const promise = requestCompletion(channel, messages);
    for (let i = 0; i < 3; i++) {
      controller.enqueue(encoder.encode(i === 1 ? `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] })}\n\n` : ': keep-alive\n\n'));
      await vi.advanceTimersByTimeAsync(9000);
    }
    controller.enqueue(encoder.encode(event('好') + 'data: [DONE]\n\n'));
    await expect(promise).resolves.toBe('好');
  });

  it('一直只有心跳、整次超过总上限（超时的 3 倍，至少 600 秒）时中断', async () => {
    const { controller } = openStream();
    const promise = requestCompletion(channel, messages);
    const rejection = expect(promise).rejects.toThrow('API 请求超时（流式输出超过 600 秒仍未结束）');
    for (let t = 0; t < 600; t += 5) {
      controller.enqueue(encoder.encode(': keep-alive\n\n'));
      await vi.advanceTimersByTimeAsync(5000);
    }
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('收到部分正文后停住：报空闲超时，带回已收到的正文，且不再按同样的时限自动重试', async () => {
    const { controller } = openStream();
    const promise = requestCompletion(channel, messages);
    const caught = promise.catch(error => error);
    controller.enqueue(encoder.encode(event('写到一半')));
    await vi.advanceTimersByTimeAsync(10000);
    const error = await caught;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'timeout', title: 'API 请求超时（超过 10 秒没有收到新内容）', partial: '写到一半' });
    expect(partialReply(error)).toBe('写到一半');
    expect(isRetryable(error)).toBe(false);
  });

  it('非流式请求仍按整次请求计时', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    } as Response)));
    const promise = requestCompletion({ ...channel, stream: false }, messages);
    const rejection = expect(promise).rejects.toThrow('API 请求超时（超过 10 秒）');
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
  });
});

describe('超时错误的说明与重试', () => {
  it('没有收到任何内容的超时照常可以重试', () => {
    const error = timeoutFailure('API 请求', 30, { mode: 'idle', received: false });
    expect(error.title).toBe('API 请求超时（超过 30 秒没有收到回复）');
    expect(isRetryable(error)).toBe(true);
    expect(partialReply(error)).toBe('');
    expect(timeoutFailure('拉取模型', 20).title).toBe('拉取模型超时（超过 20 秒）');
  });
});
