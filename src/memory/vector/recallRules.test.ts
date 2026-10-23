import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import type { LeafForIndex } from './index';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  historyUnlimited: false,
  historyLeaves: [] as string[],
  vector: {
    enabled: true,
    embedding: { url: 'u', key: 'k', model: 'emb', timeoutSec: 10, retries: 1 },
    rerank: { url: '', key: '', model: 'rr', timeoutSec: 20, retries: 1 },
    queryRewrite: { url: '', key: '', model: 'chat', timeoutSec: 90, retries: 1 },
    recall: {} as Record<string, unknown>,
  },
  leaves: [] as LeafForIndex[],
  memory: {
    npcs: [] as { name: string }[], items: [] as { name: string }[], scenes: [] as { name: string }[], summaries: [],
    state: { location: '', locationPath: undefined as string[] | undefined, sceneFocus: null },
  },
  index: vi.fn(), rewrite: vi.fn(), embed: vi.fn(), search: vi.fn(), rerank: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/api/settings', () => ({ engineActiveHere: () => true, apiSettings: { memoryBudgetTokens: 0, vector: mocks.vector } }));
vi.mock('../store', () => ({ memoryWriteIssue: () => '', memory: mocks.memory }));
vi.mock('../engine', () => ({ isAiFloor: (m: STMessage) => !!m && !m.is_user, resolveKeepStart: (chat: STMessage[]) => chat.length }));
vi.mock('../apply', () => ({
  getLeaf: (m: STMessage | undefined) => m?.extra?.bbs_leaf ?? null,
  leafValid: (m: STMessage | undefined) => !!m?.extra?.bbs_leaf,
  classifyNpcPresence: () => 'absent',
}));
vi.mock('../budget', () => ({
  estimateTokens: (s: string) => s.length,
  slotBudget: (slot: string) => (slot === 'history' && mocks.historyUnlimited ? Infinity : 5000),
  BUDGET_NOTICE: '[预算提示]',
}));
vi.mock('../inject', () => ({ selectInjectionNodes: () => mocks.historyLeaves.map(id => ({ kind: 'leaf', id })) }));
vi.mock('../prompts', () => ({ MEMORY_BRIEFING_NOTE: '〔开头说明〕', MEMORY_BRIEFING_END: '〔私密简报结束〕旧的长结束语' }));
vi.mock('../timeTag', () => ({
  cleanBody: (s: string) => s, compactTimeLabel: (s: string) => s, latestStoryTime: () => '', splitTimeLabel: () => ({}),
}));
vi.mock('../timeRel', () => ({ relativeTimeLabel: () => '' }));
vi.mock('./index', () => ({ ensureRecallIndex: mocks.index, collectLeaves: () => mocks.leaves }));
vi.mock('./rewrite', () => ({ rewriteQuery: mocks.rewrite }));
vi.mock('./embed', () => ({ embedTexts: mocks.embed, encodeFloat32Base64: () => 'v', rerankDocuments: mocks.rerank }));
vi.mock('./store', () => ({ vecSearch: mocks.search }));
vi.mock('./scope', () => ({
  currentVectorDb: () => 'db', currentBundleHashes: () => ['bundle'],
  currentChatId: () => 'A', currentChatScope: () => 'chat:A', recallScopes: () => ['chat:A', 'bundle'],
}));

import { buildRecallText, clearRecallInjection, RECALL_BRIEFING_END, recallStopSignal, runVectorRecall } from './recall';
import { RECALL_STOPPED, recallDebug, snapshotRecallDebug } from './debug';
import { recallStatusText } from './recallView';

const RECALL = {
  injectionDepth: 1, minAiFloors: 0, rerankCandidates: 10, embeddingThreshold: 0.8,
  rerankThreshold: 0.9, fullTextCount: 2, finalRecallCount: 5, keywordRoute: false, presentBoost: false, stickyTurns: 0,
};
const cfg = (patch: Record<string, unknown> = {}) => ({ ...RECALL, ...patch }) as never;
const slot = vi.fn();
const injected = () => String(slot.mock.lastCall?.[1] ?? '');
type Hit = { leafId: string; scope: string; similarity: number; rerankScore: number; reranked?: boolean; route?: 'vector' | 'keyword' | 'both' | 'sticky';
  similarityKnown?: boolean; keywordScore?: number; queryIndex: number; document: string; mesFull: string | null; storyTime: string | null; msgIndex: number };
const ranked = (leafId: string, patch: Partial<Hit> = {}): Hit => ({
  leafId, scope: 'chat:A', similarity: 0.5, rerankScore: 0.5, queryIndex: 0, document: `${leafId}的摘要`, mesFull: `${leafId}的原文`, storyTime: null, msgIndex: 3, ...patch,
});
const vecHit = (leafId: string, similarity: number, patch: Partial<Hit> = {}) => ({
  leafId, scope: 'chat:A', similarity, queryIndex: 0, document: `${leafId}的摘要`, mesFull: `${leafId}的原文`, storyTime: null, msgIndex: 3, ...patch,
});
const leaf = (i: number, document: string): LeafForIndex => ({ leafId: `L${i}`, docHash: '', payloadHash: '', document, mesFull: `#${i}原文`, storyTime: '', msgIndex: i });
function useChat(chat: STMessage[] = [{ name: 'AI', is_user: false, is_system: false, mes: '上一轮' }, { name: 'User', is_user: true, is_system: false, mes: '去看看' }]) {
  mocks.context = { chat, chatMetadata: {}, name1: '主角', name2: '角色', getCurrentChatId: () => 'A', setExtensionPrompt: slot } as unknown as STContext;
}

let storage: Map<string, string>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.vector.recall = { ...RECALL };
  Object.assign(mocks.vector.embedding, { model: 'emb', timeoutSec: 10, retries: 1 });
  Object.assign(mocks.vector.rerank, { timeoutSec: 20, retries: 1 });
  Object.assign(mocks.vector.queryRewrite, { timeoutSec: 90, retries: 1 });
  mocks.historyUnlimited = false;
  mocks.historyLeaves = [];
  mocks.leaves = [];
  Object.assign(mocks.memory, { npcs: [], items: [], scenes: [] });
  useChat();
  clearRecallInjection();
  slot.mockClear();
  mocks.index.mockResolvedValue(undefined);
  mocks.rewrite.mockResolvedValue({ intent: '回忆', queries: ['旧事'] });
  mocks.embed.mockResolvedValue([new Float32Array([1, 0])]);
  mocks.search.mockResolvedValue({ results: [] });
  mocks.rerank.mockRejectedValue(new Error('rerank 未配置'));
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});
afterEach(() => {
  clearRecallInjection();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('分档规则', () => {
  it('已重排时,超出「召回全文数」的高分段落改发摘要,不再因相似度不够被丢弃', () => {
    const r = buildRecallText([
      ranked('A', { rerankScore: 0.97, reranked: true }),
      ranked('B', { rerankScore: 0.96, reranked: true }),
      ranked('C', { rerankScore: 0.95, reranked: true, similarity: 0.72 }),
      ranked('D', { rerankScore: 0.05, reranked: true, similarity: 0.81 }),
    ] as never, cfg({ fullTextCount: 2 }), 'chat:A', '');
    expect([...r.tiers]).toEqual([['A', 'full'], ['B', 'full'], ['C', 'brief'], ['D', 'brief']]);
  });

  it('没有重排时不发原文,只按 embedding 相似度发摘要', () => {
    const r = buildRecallText([
      ranked('A', { similarity: 0.95, rerankScore: 0.95, reranked: false }),
      ranked('B', { similarity: 0.6, rerankScore: 0.6, reranked: false }),
    ] as never, cfg(), 'chat:A', '');
    expect([...r.tiers]).toEqual([['A', 'brief']]);
    expect(r.text).not.toContain('A的原文');
    expect(r.dropped.get('B')).toBe('threshold');
  });

  it('没有重排时,只由关键词命中的段落最多收 2 条', () => {
    const kw = (id: string) => ranked(id, { similarity: 0, rerankScore: 0, reranked: false, similarityKnown: false, keywordScore: 1, route: 'keyword' });
    const r = buildRecallText([kw('K1'), kw('K2'), kw('K3')] as never, cfg(), 'chat:A', '');
    expect([...r.tiers.keys()]).toEqual(['K1', 'K2']);
    expect(r.dropped.get('K3')).toBe('keyword-cap');
  });

  it('达标但「最终召回条数」已满的记为超出条数,没达标的记为未达阈值', () => {
    const r = buildRecallText([
      ranked('A', { similarity: 0.9 }), ranked('B', { similarity: 0.9 }), ranked('C', { similarity: 0.1 }),
    ] as never, cfg({ finalRecallCount: 1 }), 'chat:A', '');
    expect([...r.tiers.keys()]).toEqual(['A']);
    expect(Object.fromEntries(r.dropped)).toEqual({ B: 'limit', C: 'threshold' });
  });

  it('已在历史摘要中原样发送的叶子不再按摘要发送,全文档照常', () => {
    const r = buildRecallText([
      ranked('H1', { similarity: 0.9, rerankScore: 0.5, reranked: true }),
      ranked('H2', { rerankScore: 0.95, reranked: true }),
      ranked('N', { similarity: 0.9, rerankScore: 0.5, reranked: true }),
    ] as never, cfg(), 'chat:A', '', { inHistory: new Set(['H1', 'H2']) });
    expect([...r.tiers]).toEqual([['H2', 'full'], ['N', 'brief']]);
    expect(r.dropped.get('H1')).toBe('history');
  });

  it('召回块用专用的短结束语,不再重复完整的私密简报结束语', () => {
    const r = buildRecallText([ranked('A', { similarity: 0.9 })] as never, cfg(), 'chat:A', '');
    expect(r.text.startsWith('〔开头说明〕\n[相关回忆]')).toBe(true);
    expect(r.text.endsWith(RECALL_BRIEFING_END)).toBe(true);
    expect(r.text).not.toContain('〔私密简报结束〕');
    expect(RECALL_BRIEFING_END).toContain('不要复述');
    expect(RECALL_BRIEFING_END).toContain('人物只知道自己经历或得知的事');
  });
});

describe('召回流程', () => {
  it('INTENT 为空时用全部检索语句做重排查询', async () => {
    mocks.rewrite.mockResolvedValue({ intent: '', queries: ['甲事', '乙事'] });
    mocks.search.mockResolvedValue({ results: [vecHit('L1', 0.9)] });
    mocks.rerank.mockResolvedValue([{ index: 0, score: 0.5 }]);
    await runVectorRecall();
    expect(mocks.rerank.mock.calls[0][0]).toBe('甲事；乙事');
  });

  it('本聊天命中的楼层号按当前聊天重新定位', async () => {
    const chat: STMessage[] = Array.from({ length: 8 }, (_, i) => ({ name: i % 2 ? 'AI' : 'User', is_user: i % 2 === 0, is_system: false, mes: `第${i}楼` }));
    chat[7] = { ...chat[7], extra: { bbs_leaf: { id: 'L7', text: '摘要', delta: {}, swipe: 0 } as never } };
    chat.push({ name: 'User', is_user: true, is_system: false, mes: '继续' });
    useChat(chat);
    mocks.search.mockResolvedValue({ results: [vecHit('L7', 0.9, { msgIndex: 120 })] });
    await runVectorRecall();
    const d = snapshotRecallDebug();
    expect(d.embedding[0].source).toBe('#7');
    expect(d.rerank[0].source).toBe('#7');
    expect(injected()).toContain('[#7]');
    expect(injected()).not.toContain('#120');
  });

  it('记忆注入预算不限制时,已在历史摘要中的叶子不按摘要召回,关键词一路也跳过', async () => {
    mocks.historyUnlimited = true;
    mocks.historyLeaves = ['L1'];
    mocks.vector.recall = { ...RECALL, keywordRoute: true };
    mocks.memory.scenes = [{ name: '灰塔' }];
    mocks.leaves = [leaf(1, '灰塔顶层的旧事')];
    mocks.rewrite.mockResolvedValue({ intent: '去灰塔', queries: ['灰塔'] });
    mocks.search.mockResolvedValue({ results: [vecHit('L1', 0.9), vecHit('L2', 0.9)] });
    await runVectorRecall();
    const d = snapshotRecallDebug();
    expect(d.keyword).toEqual([]);
    expect(d.rerank.find(h => h.leafId === 'L1')).toMatchObject({ tier: 'drop', dropReason: 'history', inHistory: true });
    expect(d.rerank.find(h => h.leafId === 'L2')).toMatchObject({ tier: 'brief' });
    expect(injected()).not.toContain('L1的摘要');
  });

  it('没有填写 Rerank 模型时写明没有重排,只发摘要', async () => {
    mocks.rerank.mockRejectedValue(Object.assign(new Error('未填写 Rerank 模型'), { kind: 'config' }));
    mocks.search.mockResolvedValue({ results: [vecHit('L1', 0.95)] });
    await runVectorRecall();
    const d = snapshotRecallDebug();
    expect(d.rerankIssue).toBe('未填写 Rerank 模型，已按 embedding 相似度分档，只发送摘要。如需重排，请在「设置 → 向量记忆 → Rerank」中补全。');
    expect(d.rerank[0]).toMatchObject({ tier: 'brief', reranked: false });
    expect(injected()).not.toContain('L1的原文');
    expect(recallStatusText(recallDebug)).toContain('未填写 Rerank 模型');
  });

  it('设置页暂时清空的条数和候选数按默认值运行,不会一段都不注入', async () => {
    mocks.vector.recall = { ...RECALL, finalRecallCount: '', rerankCandidates: '', embeddingThreshold: '' };
    mocks.search.mockResolvedValue({ results: [vecHit('L1', 0.85)] });
    await runVectorRecall();
    expect(mocks.search.mock.calls[0][3]).toMatchObject({ topK: 20 });
    expect(injected()).toContain('L1的摘要');
  });

  it('补建索引:进行中显示剩余条数;超过等待上限时写明,本次结果不缓存', async () => {
    let seenPending = -1;
    mocks.index.mockImplementation(async (_signal: AbortSignal, opts: { onPending?: (n: number) => void; maxWaitMs?: number }) => {
      opts.onPending?.(5);
      seenPending = recallDebug.indexPending ?? -1;
      expect(recallStatusText(recallDebug)).toContain('剩余 5 条');
      expect(opts.maxWaitMs).toBe(20_000);
      return { timedOut: true, pending: 4 };
    });
    mocks.search.mockResolvedValue({ results: [vecHit('L1', 0.9)] });
    await runVectorRecall();
    expect(seenPending).toBe(5);
    expect(recallDebug.indexPending).toBe(0);
    expect(recallDebug.indexNote).toContain('剩余 4 条');
    expect(recallStatusText(recallDebug)).toContain('本次先用已建好的部分召回');
    expect(storage.has('bbs_vec_recall_cache')).toBe(false);
  });

  it('索引是用别的 Embedding 模型建立的:召回调试提示清空并重建', async () => {
    storage.set('bbs_vec_index_models', JSON.stringify({ 'db|chat:A': { model: 'old-emb', dim: 2, at: 1 } }));
    mocks.search.mockResolvedValue({ results: [vecHit('L1', 0.9)] });
    await runVectorRecall();
    expect(recallDebug.indexNote).toContain('「old-emb」');
    expect(recallDebug.indexNote).toContain('清空并重建');
  });

  it('外部取消(点停止生成)后写明召回已随之取消', async () => {
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    mocks.rewrite.mockImplementation(() => { started(); return new Promise(() => {}); });
    const stop = new AbortController();
    const run = runVectorRecall(stop.signal);
    await begun;
    stop.abort();
    await run;
    expect(recallDebug.status).toBe(RECALL_STOPPED);
    expect(injected()).toBe('');
  });

  it('整次召回超过兜底时限时放弃本轮,写明时限的算法', async () => {
    vi.useFakeTimers();
    Object.assign(mocks.vector.embedding, { timeoutSec: 1, retries: 0 });
    Object.assign(mocks.vector.rerank, { timeoutSec: 1, retries: 0 });
    Object.assign(mocks.vector.queryRewrite, { timeoutSec: 1, retries: 0 });
    mocks.rewrite.mockImplementation(() => new Promise(() => {}));
    const run = runVectorRecall();
    await vi.advanceTimersByTimeAsync(3000);
    await run;
    expect(recallDebug.status.startsWith('失败:超过 3 秒仍未完成')).toBe(true);
    expect(recallStatusText(recallDebug)).toContain('「超时 ×（重试次数 + 1）」之和');
  });
});

describe('停止生成的取消信号', () => {
  it('召回期间点停止即中止;结束后取消监听', () => {
    const handlers = new Map<string, () => void>();
    const removeListener = vi.fn((event: string) => handlers.delete(event));
    mocks.context = {
      ...mocks.context,
      eventSource: { on: (event: string, fn: () => void) => handlers.set(event, fn), removeListener },
      eventTypes: { GENERATION_STOPPED: 'generation_stopped' },
    } as unknown as STContext;
    const stop = recallStopSignal();
    expect(stop.signal.aborted).toBe(false);
    handlers.get('generation_stopped')?.();
    expect(stop.signal.aborted).toBe(true);
    stop.dispose();
    expect(removeListener).toHaveBeenCalledWith('generation_stopped', expect.any(Function));

    const later = recallStopSignal();
    const fn = handlers.get('generation_stopped')!;
    later.dispose();
    fn(); // 宿主没能移除监听时,dispose 之后也不再生效
    expect(later.signal.aborted).toBe(false);
  });
});
