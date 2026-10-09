// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getContext } from '@/st/context';
import type { STContext } from '@/st/context';
import { ApiError, fetchModels } from './client';

vi.mock('@/st/context', () => ({ getContext: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' };
const getRequestHeaders = vi.fn(() => headers);
const channel = { url: 'https://notes.example', key: 'notes-only-key', timeoutSec: 2 };

function rejectOnAbort<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('mock request aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset().mockRejectedValue(new Error('未配置 fetch mock；禁止真实网络'));
  getRequestHeaders.mockClear();
  vi.mocked(getContext).mockReset().mockReturnValue({ getRequestHeaders } as unknown as STContext);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchModels：ST status 代理契约', () => {
  it('不需要 model，只把独立渠道地址/key 发给 ST status，不发生成请求或直连上游', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
    const draft = Object.freeze({ ...channel });
    expect(await fetchModels(draft)).toEqual(['model-a', 'model-b']);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/backends/chat-completions/status', {
      method: 'POST', headers, signal: expect.any(AbortSignal),
      body: JSON.stringify({
        chat_completion_source: 'openai', reverse_proxy: 'https://notes.example/v1', proxy_password: 'notes-only-key',
      }),
    });
    expect(getRequestHeaders).toHaveBeenCalledTimes(1);
    expect(draft).toEqual(channel);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['  https://notes.example///  ', 'https://notes.example/v1'],
    ['https://notes.example/v1/', 'https://notes.example/v1'],
    ['https://notes.example/v1/chat/completions/', 'https://notes.example/v1'],
    ['https://notes.example/v2/coding/chat/completions', 'https://notes.example/v2/coding'],
    ['https://notes.example/v2/coding/', 'https://notes.example/v2/coding'],
    ['https://notes.example/V1/CHAT/COMPLETIONS', 'https://notes.example/V1'],
    ['http://localhost:8000', 'http://localhost:8000/v1'],
  ])('规范化 %s → %s，且不改写调用方草稿', async (url, expected) => {
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    const draft = { ...channel, url, model: 'do-not-change' };
    const before = { ...draft };
    await fetchModels(draft);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      chat_completion_source: 'openai', reverse_proxy: expected, proxy_password: channel.key,
    });
    expect(draft).toEqual(before);
  });

  it('允许空 key，不借用其它渠道的凭据', async () => {
    fetchMock.mockResolvedValue(Response.json({ models: ['local-model'] }));
    expect(await fetchModels({ url: 'http://localhost:8000/v1', key: '' })).toEqual(['local-model']);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).proxy_password).toBe('');
  });

  it.each([
    [{ data: [{ id: 'b' }, 'a', null, {}, { id: 123 }, '', 42, { id: '' }] }, ['a', 'b']],
    [{ models: [{ id: 'b' }, 'a'] }, ['a', 'b']],
    [{ data: [], models: ['not-used'] }, []],
    [{ data: { id: 'not-an-array' } }, []],
    [{ models: 'not-an-array' }, []],
    [{}, []],
    [null, []],
  ])('兼容 data/models 数组并过滤非法 ID：%j', async (payload, expected) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    expect(await fetchModels(channel)).toEqual(expected);
  });

  it('缺少上下文或地址时拒绝请求，不访问网络', async () => {
    vi.mocked(getContext).mockReturnValue(null);
    await expect(fetchModels(channel)).rejects.toMatchObject({ name: 'ApiError', kind: 'config', title: '酒馆上下文还没准备好' });
    vi.mocked(getContext).mockReturnValue({ getRequestHeaders } as unknown as STContext);
    await expect(fetchModels({ url: '', key: '' })).rejects.toMatchObject({ name: 'ApiError', kind: 'config', message: '请先填写 API 地址。' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 405, 429, 500])('HTTP %s 保留 ApiError.status，且不自动尝试其它地址', async status => {
    fetchMock.mockResolvedValue(new Response('upstream error details', { status }));
    const error = await fetchModels(channel).catch(cause => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('HTTP 错误正文读取失败仍保留状态码', async () => {
    const response = new Response(null, { status: 401 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('body read failed'));
    fetchMock.mockResolvedValue(response);
    await expect(fetchModels(channel)).rejects.toMatchObject({ name: 'ApiError', status: 401 });
  });

  it('200 错误信封抛 ApiError，交由展示层脱敏', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: true, message: 'private upstream details' }));
    await expect(fetchModels(channel)).rejects.toBeInstanceOf(ApiError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('JSON 解析失败与网络异常转成可读说明，并清理超时定时器', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not JSON</html>'));
    await expect(fetchModels(channel)).rejects.toMatchObject({ name: 'ApiError', kind: 'format', title: 'API 返回的不是有效数据' });
    fetchMock.mockRejectedValueOnce(new TypeError('mock network failure'));
    await expect(fetchModels(channel)).rejects.toMatchObject({ name: 'ApiError', kind: 'network', title: '连不上酒馆服务器' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('酒馆模型列表代理只回 { error: true } 时说明可能原因，并允许手填', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: true, data: { data: [] } }));
    const error = await fetchModels(channel).catch(cause => cause);
    expect(error).toMatchObject({ name: 'ApiError', kind: 'upstream', title: '服务商没有返回模型列表' });
    expect(error.message).toContain('手动填写模型名');
  });
});

describe('fetchModels：超时和外部取消', () => {
  it.each(['fetch', 'json'] as const)('超时覆盖 %s 阶段，并中止底层 signal', async stage => {
    let signal!: AbortSignal;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init!.signal!;
      if (stage === 'fetch') return rejectOnAbort<Response>(signal);
      const response = Response.json({ data: [] });
      vi.spyOn(response, 'json').mockImplementation(() => rejectOnAbort(signal));
      return response;
    });
    const pending = fetchModels(channel);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'ApiError', kind: 'timeout', title: '拉取模型超时（超过 2 秒）' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0, -1, NaN, Infinity])('无效 timeoutSec=%s 使用 180 秒默认值', async timeoutSec => {
    fetchMock.mockImplementation((_url, init) => rejectOnAbort<Response>(init!.signal!));
    const pending = fetchModels({ ...channel, timeoutSec });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'ApiError', kind: 'timeout', title: '拉取模型超时（超过 180 秒）' });
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    await vi.advanceTimersByTimeAsync(179999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'json'] as const)('外部取消打断 %s，保留 AbortError，不误报为超时', async stage => {
    const external = new AbortController();
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    fetchMock.mockImplementation(async (_url, init) => {
      if (stage === 'fetch') return rejectOnAbort<Response>(init!.signal!);
      const response = Response.json({ data: [] });
      vi.spyOn(response, 'json').mockImplementation(() => rejectOnAbort(init!.signal!));
      return response;
    });
    const pending = fetchModels(channel, { signal: external.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'mock request aborted' });
    await vi.advanceTimersByTimeAsync(0);
    const internalSignal = fetchMock.mock.calls[0][1]!.signal!;
    expect(internalSignal).not.toBe(external.signal);
    expect(internalSignal.aborted).toBe(false);
    external.abort();
    expect(internalSignal.aborted).toBe(true);
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('已取消的外部 signal 在调用时立即传递取消', async () => {
    const external = new AbortController();
    external.abort();
    fetchMock.mockImplementation((_url, init) => rejectOnAbort<Response>(init!.signal!));
    await expect(fetchModels(channel, { signal: external.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('请求结束后移除外部 abort 监听器并清理计时器（成功=%s）', async success => {
    const external = new AbortController();
    const add = vi.spyOn(external.signal, 'addEventListener');
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    fetchMock.mockResolvedValue(success ? Response.json({ data: ['one'] }) : new Response('', { status: 401 }));
    if (success) await expect(fetchModels(channel, { signal: external.signal })).resolves.toEqual(['one']);
    else await expect(fetchModels(channel, { signal: external.signal })).rejects.toMatchObject({ status: 401 });
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    external.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(false);
  });
});
