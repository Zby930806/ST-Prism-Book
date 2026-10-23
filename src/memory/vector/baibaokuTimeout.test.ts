import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/st/context', () => ({ getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) }));

import { isBaiBaoKuAvailable, vecSearch, vecUpsert } from '@/api/baibaoku';

const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('柏宝库请求的超时', () => {
  it('检索请求 30 秒没有返回时报错,写明哪个请求、等了多久', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hang);
    const pending = vecSearch('db', ['chat:A'], ['v'], { topK: 5 });
    const check = expect(pending).rejects.toMatchObject({ code: 'timeout', message: '柏宝库请求超时（vec/search，超过 30 秒），请确认柏宝库后端正常运行' });
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
  });

  it('响应头到了但正文迟迟不来,同样按超时报错', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    } as unknown as Response));
    const pending = vecSearch('db', ['chat:A'], ['v']);
    const check = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
  });

  it('写入请求的时限更宽(60 秒)', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hang);
    let settled = false;
    const pending = vecUpsert('db', 'chat:A', []);
    pending.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('正常返回时照旧取出数据;后端报错时带上后端的原话', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { results: [] } }), { status: 200 }));
    await expect(vecSearch('db', ['chat:A'], ['v'])).resolves.toEqual({ results: [] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'E_DB', message: 'database locked' } }), { status: 500 }));
    await expect(vecSearch('db', ['chat:A'], ['v'])).rejects.toMatchObject({ code: 'E_DB', message: 'database locked' });
  });

  it('探测后端是否就绪:5 秒没有返回按未安装处理', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hang);
    const pending = isBaiBaoKuAvailable();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(false);
  });
});
