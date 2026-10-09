// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import type { EffectScope } from 'vue';
import { ApiError, fetchModels } from '@/api/client';
import { useNotesModelCatalog } from './modelCatalog';

vi.mock('@/st/context', () => ({ getContext: vi.fn() }));
vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  fetchModels: vi.fn(),
}));

const fetchModelsMock = vi.mocked(fetchModels);
const scopes: EffectScope[] = [];
const secret = 'sk-private-draft-key';
const upstream = `https://private.example/v1?key=${secret} <html>upstream-secret</html>`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<{ url: string; key: string; timeoutSec: number; model: string }> = {}) {
  const source = reactive({
    url: 'https://notes.example/v2/coding', key: secret, timeoutSec: 17,
    model: 'keep-current-model', ...overrides,
  });
  const scope = effectScope();
  scopes.push(scope);
  const catalog = scope.run(() => useNotesModelCatalog(source))!;
  return { source, scope, catalog };
}

function state(catalog: ReturnType<typeof useNotesModelCatalog>) {
  return {
    models: catalog.models.value, loading: catalog.loading.value,
    message: catalog.message.value, error: catalog.error.value,
  };
}

beforeEach(() => {
  fetchModelsMock.mockReset().mockRejectedValue(new Error('未配置模型列表 mock'));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试禁止真实网络')));
});

afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('札记模型列表：草稿隔离与只读行为', () => {
  it.each(['', 'keep-current-model'])('不要求预填 model，且不更改原模型（%s）', async model => {
    fetchModelsMock.mockResolvedValue([' z-model ', 'a-model', 'z-model', '', '  ', ' a-model ']);
    const { source, catalog } = setup({ model, url: '  https://notes.example/v2/coding  ' });
    const before = { ...source };
    expect(state(catalog)).toEqual({ models: [], loading: false, message: '', error: '' });
    expect(fetchModelsMock).not.toHaveBeenCalled();

    await catalog.pull();

    expect(fetchModelsMock).toHaveBeenCalledExactlyOnceWith(
      { url: 'https://notes.example/v2/coding', key: secret, timeoutSec: 17 },
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchModelsMock.mock.calls[0][0]).not.toBe(source);
    expect(catalog.models.value).toEqual(['a-model', 'z-model']);
    expect(catalog.message.value).toBe('拉到 2 个模型，从列表里选一个，再点保存。');
    expect(catalog.error.value).toBe('');
    expect(catalog.loading.value).toBe(false);
    expect(source).toEqual(before);
  });

  it('不同札记草稿的地址、key 和列表互不串用，快照不随草稿改变', async () => {
    const pending = deferred<string[]>();
    fetchModelsMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(['second-model']);
    const first = setup();
    const second = setup({ url: 'https://other.example/v1', key: 'other-key', timeoutSec: 8 });
    const firstPull = first.catalog.pull();
    await second.catalog.pull();
    first.source.key = 'edited-key';

    expect(fetchModelsMock.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      { url: 'https://notes.example/v2/coding', key: secret, timeoutSec: 17 },
      { url: 'https://other.example/v1', key: 'other-key', timeoutSec: 8 },
    ]);
    pending.resolve(['first-stale-model']);
    await firstPull;
    expect(first.catalog.models.value).toEqual([]);
    expect(second.catalog.models.value).toEqual(['second-model']);
    expect(first.source.model).toBe('keep-current-model');
    expect(second.source.model).toBe('keep-current-model');
  });

  it('无鉴权端点允许空 key，timeoutSec 可省略', async () => {
    fetchModelsMock.mockResolvedValue([]);
    const source = reactive({ url: 'http://localhost:8000/v1', key: '' });
    const scope = effectScope();
    scopes.push(scope);
    const catalog = scope.run(() => useNotesModelCatalog(source))!;
    await catalog.pull();
    expect(fetchModelsMock.mock.calls[0][0]).toEqual({ ...source, timeoutSec: undefined });
    expect(catalog.error.value).toBe('');
  });

  it.each(['', '   ', '/relative', 'not-a-url', 'ftp://notes.example',
    'https://user:password@notes.example', 'https://notes.example?key=secret', 'https://notes.example#fragment',
  ])('拒绝不安全或不完整地址：%s', async url => {
    const { source, catalog } = setup({ url });
    await catalog.pull();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(catalog.error.value).toBe('先填好 API 地址：要写完整的 http(s) 地址，不能带账号、? 参数或 #。');
    expect(catalog.loading.value).toBe(false);
    expect(source.model).toBe('keep-current-model');
  });

  it.each([{ list: [] }, { list: ['', ' ', '\t'] }])('空列表或清洗后空列表保留手填入口：$list', async ({ list }) => {
    fetchModelsMock.mockResolvedValue(list);
    const { source, catalog } = setup();
    await catalog.pull();
    expect(state(catalog)).toEqual({
      models: [], loading: false, error: '',
      message: '接口没有返回任何模型，可以直接手动填写模型名。',
    });
    expect(source.model).toBe('keep-current-model');
  });

  it.each([
    [401, '密钥无效或没有权限，请检查 API 密钥。'],
    [403, '密钥无效或没有权限，请检查 API 密钥。'],
    [404, '这个地址没有提供模型列表。'],
    [405, '这个地址没有提供模型列表。'],
    [429, '请求太频繁，被限流了，稍后再试。'],
    [500, '检查地址、网络或超时设置后再试。'],
  ] as const)('HTTP %s 只显示状态码和固定恢复提示，不回显上游内容', async (status, reason) => {
    fetchModelsMock.mockRejectedValue(new ApiError(upstream, status));
    const { source, catalog } = setup();
    await catalog.pull();
    expect(catalog.error.value).toBe(`拉取模型列表失败（HTTP ${status}）：${reason}也可以直接手动填写模型名。`);
    expect(catalog.models.value).toEqual([]);
    expect(catalog.message.value).toBe('');
    expect(catalog.loading.value).toBe(false);
    expect(source.model).toBe('keep-current-model');
  });

  it.each([
    new Error(upstream), new ApiError(upstream), new SyntaxError(upstream),
    new DOMException(upstream, 'AbortError'), upstream, { message: upstream, status: 401 },
  ])('未知异常不展示原文或非 ApiError 的 status：%j', async cause => {
    fetchModelsMock.mockRejectedValue(cause);
    const { source, catalog } = setup();
    await catalog.pull();
    expect(state(catalog)).toEqual({
      models: [], loading: false, message: '',
      error: '拉取模型列表失败：检查地址、网络或超时设置后再试。也可以直接手动填写模型名。',
    });
    expect(source.model).toBe('keep-current-model');
  });

  it('重拉清除旧列表/提示，失败后可重试并清除旧错误', async () => {
    const failed = deferred<string[]>();
    fetchModelsMock.mockResolvedValueOnce(['old']).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(['new']);
    const { catalog } = setup();
    await catalog.pull();
    const retry = catalog.pull();
    expect(state(catalog)).toEqual({ models: [], loading: true, message: '', error: '' });
    failed.reject(new ApiError(upstream, 401));
    await retry;
    expect(catalog.error.value).toContain('HTTP 401');
    const recovered = catalog.pull();
    expect(catalog.error.value).toBe('');
    await recovered;
    expect(catalog.models.value).toEqual(['new']);
    expect(catalog.loading.value).toBe(false);
  });
});

describe('札记模型列表：取消及过期请求隔离', () => {
  it('连续重复点击只产生一个请求', async () => {
    const pending = deferred<string[]>();
    fetchModelsMock.mockReturnValue(pending.promise);
    const { catalog } = setup();
    const first = catalog.pull();
    await Promise.all([catalog.pull(), catalog.pull()]);
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
    expect(catalog.loading.value).toBe(true);
    pending.resolve(['one']);
    await first;
    expect(catalog.models.value).toEqual(['one']);
    expect(catalog.loading.value).toBe(false);
  });

  for (const action of ['cancel', 'url', 'key', 'dispose'] as const) {
    it.each(['resolve', 'reject'] as const)(`${action} 同步失效并忽略迟到的 %s`, async outcome => {
      // 故意不响应 abort，验证 requestId 防线，而非依赖 fetch 恰好及时取消。
      const old = deferred<string[]>();
      const fresh = deferred<string[]>();
      fetchModelsMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
      const { source, scope, catalog } = setup();
      const oldPull = catalog.pull();
      const oldSignal = fetchModelsMock.mock.calls[0][1]!.signal!;
      if (action === 'cancel') catalog.cancel();
      else if (action === 'dispose') scope.stop();
      else if (action === 'url') source.url = 'https://changed.example/v1';
      else source.key = 'changed-key';

      // 不 await nextTick：同一事件里改草稿后必须立即允许重新拉取。
      expect(oldSignal.aborted).toBe(true);
      expect(state(catalog)).toEqual({ models: [], loading: false, message: '', error: '' });
      const freshPull = action === 'dispose' ? undefined : catalog.pull();
      if (outcome === 'resolve') old.resolve(['stale']);
      else old.reject(new ApiError(upstream, 401));
      await oldPull;
      expect(state(catalog)).toEqual({ models: [], loading: action !== 'dispose', message: '', error: '' });

      if (freshPull) {
        expect(fetchModelsMock).toHaveBeenCalledTimes(2);
        expect(fetchModelsMock.mock.calls[1][0]).toEqual({ url: source.url, key: source.key, timeoutSec: 17 });
        expect(fetchModelsMock.mock.calls[1][1]!.signal!.aborted).toBe(false);
        fresh.resolve(['fresh']);
        await freshPull;
        expect(catalog.models.value).toEqual(['fresh']);
        expect(catalog.error.value).toBe('');
        expect(catalog.loading.value).toBe(false);
      }
      expect(source.model).toBe('keep-current-model');
    });
  }

  it.each(['resolve', 'reject'] as const)('新请求先完成时，旧请求迟到 %s 不覆盖新列表与提示', async outcome => {
    const old = deferred<string[]>();
    fetchModelsMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(['fresh']);
    const { source, catalog } = setup();
    const oldPull = catalog.pull();
    source.key = 'new-key';
    await catalog.pull();
    const completed = state(catalog);
    if (outcome === 'resolve') old.resolve(['stale']);
    else old.reject(new Error(upstream));
    await oldPull;
    expect(state(catalog)).toEqual(completed);
  });

  for (const action of ['url', 'key', 'dispose'] as const) {
    it.each(['success', 'error'] as const)(`${action} 清除已完成的 %s 状态`, async outcome => {
      if (outcome === 'success') fetchModelsMock.mockResolvedValueOnce(['old']);
      else fetchModelsMock.mockRejectedValueOnce(new ApiError(upstream, 403));
      const { source, scope, catalog } = setup();
      await catalog.pull();
      if (outcome === 'success') {
        expect(catalog.models.value).toEqual(['old']);
        expect(catalog.message.value).not.toBe('');
      } else expect(catalog.error.value).not.toBe('');
      if (action === 'dispose') scope.stop();
      else source[action] += '-changed';
      expect(state(catalog)).toEqual({ models: [], loading: false, message: '', error: '' });
      expect(source.model).toBe('keep-current-model');
    });
  }
});
