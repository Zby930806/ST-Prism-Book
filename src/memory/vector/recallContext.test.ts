import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext } from '@/st/context';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  issue: '', active: true,
  index: vi.fn(), rewrite: vi.fn(), embed: vi.fn(), search: vi.fn(), rerank: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/api/settings', () => ({
  engineActiveHere: () => mocks.active,
  apiSettings: { memoryBudgetTokens: 6000, vector: { enabled: true, recall: {
    injectionDepth: 1, minAiFloors: 0, rerankCandidates: 10, embeddingThreshold: 0.3,
    rerankThreshold: 0.5, fullTextCount: 3, finalRecallCount: 5,
  } } },
}));
vi.mock('../store', () => ({ memoryWriteIssue: () => mocks.issue }));
vi.mock('../engine', () => ({ isAiFloor: () => false, resolveKeepStart: () => 0 }));
vi.mock('../apply', () => ({ getLeaf: () => null, leafValid: () => false }));
vi.mock('../budget', () => ({
  estimateTokens: (s: string) => s.length, slotBudget: () => 5000,
  fitMemoryUnits: (chunks: string[]) => ({ text: chunks.join('\n'), indices: chunks.map((_, i) => i) }),
}));
vi.mock('../prompts', () => ({ MEMORY_BRIEFING_NOTE: '', MEMORY_BRIEFING_END: '' }));
vi.mock('../timeTag', () => ({
  cleanBody: (s: string) => s, compactTimeLabel: (s: string) => s,
  latestStoryTime: () => '', splitTimeLabel: () => ({}),
}));
vi.mock('../timeRel', () => ({ relativeTimeLabel: () => '' }));
vi.mock('./index', () => ({ ensureRecallIndex: mocks.index }));
vi.mock('./rewrite', () => ({ rewriteQuery: mocks.rewrite }));
vi.mock('./embed', () => ({
  embedTexts: mocks.embed, encodeFloat32Base64: () => 'vector', rerankDocuments: mocks.rerank,
}));
vi.mock('./store', () => ({ vecSearch: mocks.search }));
vi.mock('./scope', () => ({
  currentVectorDb: () => 'db', currentBundleHashes: () => ['bundle'],
  currentChatId: () => mocks.context.getCurrentChatId(),
  currentChatScope: () => `chat:${mocks.context.getCurrentChatId()}`,
  recallScopes: () => [`chat:${mocks.context.getCurrentChatId()}`, 'bundle'],
}));

import { clearRecallInjection, runVectorRecall } from './recall';
import { resetRecallDebug, snapshotRecallDebug } from './debug';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const rewriteResult = { intent: '回忆', queries: ['旧事'] };
const results = { results: [{ leafId: 'leaf', scope: 'bundle', similarity: 0.9, queryIndex: 0,
  document: '保留的旧记忆', mesFull: null, storyTime: null, msgIndex: 0 }] };
const stages = [
  ['index', undefined], ['rewrite', rewriteResult], ['embed', [new Float32Array([1])]],
  ['search', results], ['rerank', [{ index: 0, score: 0.9 }]],
] as const;
const slot = vi.fn();
let storage: Map<string, string>;
function useChat(id: string) {
  mocks.context = {
    chat: [{ mes: `输入-${id}`, is_user: true, is_system: false, name: 'User' }],
    chatMetadata: {}, getCurrentChatId: () => id, setExtensionPrompt: slot,
  } as unknown as STContext;
}
function snapshot() {
  return { calls: slot.mock.calls.map(call => [...call]), debug: snapshotRecallDebug(), cache: [...storage] };
}

beforeEach(() => {
  vi.resetAllMocks();
  useChat('A');
  clearRecallInjection();
  slot.mockClear();
  resetRecallDebug();
  mocks.issue = ''; mocks.active = true;
  mocks.index.mockResolvedValue(undefined);
  mocks.rewrite.mockResolvedValue(rewriteResult);
  mocks.embed.mockResolvedValue([new Float32Array([1])]);
  mocks.search.mockResolvedValue(results);
  mocks.rerank.mockResolvedValue([{ index: 0, score: 0.9 }]);
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => { clearRecallInjection(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('召回上下文/代次隔离（全部本地 mock）', () => {
  it('正常召回及缓存复用保留原行为', async () => {
    await runVectorRecall();
    expect(slot.mock.lastCall?.[1]).toContain('保留的旧记忆');
    expect(storage.size).toBe(1);
    await runVectorRecall();
    expect(mocks.rewrite).toHaveBeenCalledTimes(1);
    expect(snapshotRecallDebug().status).toContain('复用缓存');
  });

  it.each(['chat', 'metadata', 'id'] as const)('只替换 %s 也禁止索引后的重写外发', async kind => {
    const pending = deferred<void>();
    mocks.index.mockReturnValueOnce(pending.promise);
    const run = runVectorRecall();
    const signal = mocks.index.mock.calls[0][0] as AbortSignal;
    if (kind === 'chat') mocks.context.chat = [...mocks.context.chat];
    if (kind === 'metadata') mocks.context.chatMetadata = {};
    if (kind === 'id') mocks.context.getCurrentChatId = () => 'B';
    const before = snapshot();
    pending.resolve();
    await run;
    expect(mocks.rewrite).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it.each(stages)('%s 恢复时已切聊天，旧成功不得继续外发/写槽/debug/cache', async (stage, value) => {
    const pending = deferred<unknown>();
    mocks[stage].mockReturnValueOnce(pending.promise);
    const run = runVectorRecall();
    await vi.waitFor(() => expect(mocks[stage]).toHaveBeenCalledTimes(1));
    useChat('B');
    const before = snapshot();
    pending.resolve(value);
    await run;
    const next = stages[stages.findIndex(([name]) => name === stage) + 1];
    if (next) expect(mocks[next[0]]).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it.each(['protected', 'disabled'] as const)('相同聊天变成 %s 时，重写后不再发 embedding', async kind => {
    const pending = deferred<typeof rewriteResult>();
    mocks.rewrite.mockReturnValueOnce(pending.promise);
    const run = runVectorRecall();
    await vi.waitFor(() => expect(mocks.rewrite).toHaveBeenCalledOnce());
    if (kind === 'protected') mocks.issue = '未知 delta 未确认';
    else mocks.active = false;
    pending.resolve(rewriteResult);
    await run;
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(slot.mock.lastCall?.[1]).toBe('');
    expect(storage.size).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('新聊天可以启动，旧任务迟到 %s 不污染新结果', async outcome => {
    const pending = deferred<unknown>();
    mocks.rerank.mockReturnValueOnce(pending.promise);
    const old = runVectorRecall();
    await vi.waitFor(() => expect(mocks.rerank).toHaveBeenCalledOnce());
    const oldSignal = mocks.rerank.mock.calls[0][3] as AbortSignal;
    useChat('B'); // 即使 CHAT_CHANGED 清槽监听还未执行，新 run 也能取代旧 owner
    await runVectorRecall();
    expect(oldSignal.aborted).toBe(true);
    const before = snapshot();
    if (outcome === 'resolve') pending.resolve([{ index: 0, score: 1 }]);
    else pending.reject(new Error('旧重排失败'));
    await old;
    expect(snapshot()).toEqual(before);
    expect(slot.mock.lastCall?.[1]).toContain('保留的旧记忆');
  });

  it('清槽立即取消，旧 finally 不释放同聊天新 run，同输入重入仍等待且不重复计费', async () => {
    const a = deferred<void>(); const b = deferred<void>();
    mocks.index.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const old = runVectorRecall();
    const oldSignal = mocks.index.mock.calls[0][0] as AbortSignal;
    clearRecallInjection();
    const next = runVectorRecall();
    await old; // 底层故意不响应 abort,调用仍应及时结束
    expect(oldSignal.aborted).toBe(true);
    let joinedDone = false;
    const joined = runVectorRecall().then(() => { joinedDone = true; });
    await Promise.resolve();
    expect(joinedDone).toBe(false);
    expect(mocks.index).toHaveBeenCalledTimes(2);
    b.resolve();
    await Promise.all([next, joined]);
    const before = snapshot();
    a.resolve();
    await Promise.resolve();
    expect(snapshot()).toEqual(before);
  });

  it('同聊天新输入取代旧 run，旧外部 signal 不能取消新 run', async () => {
    const pending = deferred<void>();
    mocks.index.mockReturnValueOnce(pending.promise);
    const external = new AbortController();
    const old = runVectorRecall(external.signal);
    const oldSignal = mocks.index.mock.calls[0][0] as AbortSignal;
    mocks.context.chat[0].mes = '新输入';
    await runVectorRecall();
    expect(oldSignal.aborted).toBe(true);
    const before = snapshot();
    external.abort(); pending.resolve(); await old;
    expect(snapshot()).toEqual(before);
  });

  it('外部取消及时结束，未完成请求不阻挡下一次正常召回', async () => {
    const pending = deferred<void>();
    mocks.index.mockReturnValueOnce(pending.promise);
    const external = new AbortController();
    const old = runVectorRecall(external.signal);
    const inner = mocks.index.mock.calls[0][0] as AbortSignal;
    external.abort(); await old;
    expect(inner.aborted).toBe(true);
    expect(mocks.rewrite).not.toHaveBeenCalled();
    await runVectorRecall();
    const before = snapshot(); pending.resolve(); await Promise.resolve();
    expect(snapshot()).toEqual(before);
  });

  it('当前 run 真实失败仍清槽并可重试，真实重排失败仍降级', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.rewrite.mockRejectedValueOnce(new Error('重写失败'));
    await runVectorRecall();
    expect(slot.mock.lastCall?.[1]).toBe('');
    expect(snapshotRecallDebug().status).toContain('重写失败');
    mocks.rerank.mockRejectedValueOnce(new Error('未配重排'));
    await runVectorRecall();
    expect(slot.mock.lastCall?.[1]).toContain('保留的旧记忆');
    expect(storage.size).toBe(1);
  });

  it('缓存写槽回调中切聊天后，不再恢复旧 debug 或改状态', async () => {
    await runVectorRecall();
    const before = snapshotRecallDebug();
    slot.mockImplementationOnce(() => { useChat('B'); });
    await runVectorRecall();
    expect(snapshotRecallDebug()).toEqual(before);
    expect(mocks.rewrite).toHaveBeenCalledTimes(1);
  });
});
