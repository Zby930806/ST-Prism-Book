import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  vector: {
    embedding: { url: 'https://example.test/v1', key: 'k', model: 'emb', timeoutSec: 10, retries: 1 },
    rerank: { url: '', key: '', model: 'rr', timeoutSec: 20, retries: 1 },
    queryRewrite: { url: '', key: '', model: 'chat', timeoutSec: 90, retries: 1 },
  },
}));
vi.mock('@/api/settings', () => ({
  resolveVectorModel: (role: 'embedding' | 'rerank' | 'queryRewrite') => {
    const v = mocks.vector;
    const cfg = v[role];
    return { url: cfg.url || v.embedding.url, key: cfg.key || v.embedding.key, model: cfg.model, timeoutSec: cfg.timeoutSec, retries: cfg.retries };
  },
}));

import { classifyHttpFailure } from '@/api/errors';
import { embedTexts, fetchWithTimeoutRetry, rerankDocuments, resetRerankSupport, vectorFailure } from './embed';

const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetRerankSupport();
  Object.assign(mocks.vector.rerank, { url: '', key: '', model: 'rr', timeoutSec: 20, retries: 1 });
  Object.assign(mocks.vector.embedding, { timeoutSec: 10, retries: 1 });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('带超时与重试的请求', () => {
  it('默认超时会重试;retryOnTimeout=false 时超时直接报错', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hang);
    const retried = fetchWithTimeoutRetry('u', {}, { timeoutSec: 1, retries: 1, label: 'Embedding' });
    const retriedCheck = expect(retried).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(1000 + 800 + 1000);
    await retriedCheck;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    const once = fetchWithTimeoutRetry('u', {}, { timeoutSec: 1, retries: 3, label: 'Query 重写', retryOnTimeout: false });
    const onceCheck = expect(once).rejects.toThrow(/Query 重写：请求超时（超过 1 秒）/);
    await vi.advanceTimersByTimeAsync(1000);
    await onceCheck;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('响应头到了但正文迟迟不来,同样按超时处理', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => Promise.resolve({
      status: 200, statusText: 'OK', headers: new Headers(),
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    } as unknown as Response));
    const pending = fetchWithTimeoutRetry('u', {}, { timeoutSec: 1, retries: 0, label: 'Embedding' });
    const check = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });

  it('设置页暂时为空的超时与重试次数按 10 秒、不重试处理,不会变成 1 秒超时', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hang);
    const pending = fetchWithTimeoutRetry('u', {}, { timeoutSec: '' as unknown as number, retries: '' as unknown as number, label: 'Embedding' });
    let settled = false;
    pending.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).rejects.toThrow(/超过 10 秒/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('错误带上分类和状态码,供调用方决定是否逐条重试或跳过重排', () => {
    const e = vectorFailure('Rerank', classifyHttpFailure({ status: 404, direct: true }));
    expect(e).toMatchObject({ name: 'EmbedError', kind: 'not-found', status: 404 });
    expect(e.message).toContain('Rerank：接口地址不对');
  });
});

describe('Embedding 返回的向量数量', () => {
  it('数量与请求不一致时报错,不按错位的向量写入', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 }));
    await expect(embedTexts(['甲', '乙'])).rejects.toThrow(/返回了 1 个向量，请求的是 2 条文本/);
  });
});

describe('重排接口不可用时的会话记忆', () => {
  const ok = () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 });

  it('没有填写模型时报 config 类错误', async () => {
    mocks.vector.rerank.model = '';
    await expect(rerankDocuments('q', ['文档'], 1)).rejects.toMatchObject({ kind: 'config', message: '未填写 Rerank 模型' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('返回 404 后本次会话不再请求,改了模型会重新尝试', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(rerankDocuments('q', ['文档'], 1)).rejects.toMatchObject({ status: 404 });
    const skipped = await rerankDocuments('q', ['文档'], 1).catch(e => e);
    expect(skipped).toMatchObject({ kind: 'unsupported' });
    // 接口原因之后接一句会话内不再请求的说明,句号衔接、没有多余的空格
    expect(skipped.message).toMatch(/^Rerank：接口地址不对.*。本次会话内不再请求重排；修改 Rerank 的地址、密钥或模型后会重新尝试。$/);
    expect(skipped.message).not.toMatch(/\s本次会话内|。。/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mocks.vector.rerank.model = 'rr-2';
    fetchMock.mockResolvedValueOnce(ok());
    await expect(rerankDocuments('q', ['文档'], 1)).resolves.toEqual([{ index: 0, score: 0.9 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超时、服务端出错这类临时失败不记忆,下次照常请求', async () => {
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    mocks.vector.rerank.retries = 0;
    await expect(rerankDocuments('q', ['文档'], 1)).rejects.toMatchObject({ status: 503 });
    await expect(rerankDocuments('q', ['文档'], 1)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
