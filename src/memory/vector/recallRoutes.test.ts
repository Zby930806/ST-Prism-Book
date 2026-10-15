import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import type { LeafForIndex } from './index';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  recall: {
    injectionDepth: 1, minAiFloors: 0, rerankCandidates: 10, embeddingThreshold: 0.8,
    rerankThreshold: 0.9, fullTextCount: 1, finalRecallCount: 5,
    keywordRoute: true, presentBoost: true, stickyTurns: 0,
  },
  leaves: [] as LeafForIndex[],
  present: new Set<string>(),
  memory: {
    npcs: [] as { name: string }[], items: [] as { name: string }[], scenes: [] as { name: string }[],
    state: { location: '', locationPath: undefined as string[] | undefined, sceneFocus: null as null | { participants: string[] } },
  },
  rewrite: vi.fn(), embed: vi.fn(), search: vi.fn(), rerank: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/api/settings', () => ({
  engineActiveHere: () => true,
  apiSettings: { memoryBudgetTokens: 6000, vector: { enabled: true, recall: mocks.recall } },
}));
vi.mock('../store', () => ({ memoryWriteIssue: () => '', memory: mocks.memory }));
vi.mock('../engine', () => ({ isAiFloor: (m: STMessage) => !!m && !m.is_user, resolveKeepStart: () => 0 }));
vi.mock('../apply', () => ({
  getLeaf: () => null, leafValid: () => false,
  classifyNpcPresence: (n: { name: string }) => (mocks.present.has(n.name) ? 'present' : 'absent'),
}));
vi.mock('../budget', () => ({
  estimateTokens: (s: string) => s.length, slotBudget: () => 5000,
  fitMemoryUnits: (chunks: string[]) => ({ text: chunks.join('\n'), indices: chunks.map((_, i) => i) }),
}));
vi.mock('../prompts', () => ({ MEMORY_BRIEFING_NOTE: '', MEMORY_BRIEFING_END: '' }));
vi.mock('../timeTag', () => ({
  cleanBody: (s: string) => s, compactTimeLabel: (s: string) => s, latestStoryTime: () => '', splitTimeLabel: () => ({}),
}));
vi.mock('../timeRel', () => ({ relativeTimeLabel: () => '' }));
vi.mock('./index', () => ({ ensureRecallIndex: async () => undefined, collectLeaves: () => mocks.leaves }));
vi.mock('./rewrite', () => ({ rewriteQuery: mocks.rewrite }));
vi.mock('./embed', () => ({ embedTexts: mocks.embed, encodeFloat32Base64: () => 'v', rerankDocuments: mocks.rerank }));
vi.mock('./store', () => ({ vecSearch: mocks.search }));
vi.mock('./scope', () => ({
  currentVectorDb: () => 'db', currentBundleHashes: () => ['bundle'],
  currentChatId: () => 'A', currentChatScope: () => 'chat:A', recallScopes: () => ['chat:A', 'bundle'],
}));

import { clearRecallInjection, runVectorRecall } from './recall';
import { snapshotRecallDebug } from './debug';

const slot = vi.fn();
const leaf = (i: number, document: string): LeafForIndex => ({
  leafId: `L${i}`, docHash: '', payloadHash: '', document, mesFull: `#${i}原文`, storyTime: '', msgIndex: i,
});
const hit = (i: number, similarity: number, document: string) => ({
  leafId: `L${i}`, scope: 'chat:A', similarity, queryIndex: 0, document, mesFull: null, storyTime: null, msgIndex: i,
});
function useChat(input: string) {
  mocks.context = {
    chat: [{ name: 'AI', is_user: false, is_system: false, mes: '上一轮回复' }, { name: 'User', is_user: true, is_system: false, mes: input }],
    chatMetadata: {}, name1: '沈遥', name2: '雾港来信', getCurrentChatId: () => 'A', setExtensionPrompt: slot,
  } as unknown as STContext;
}
const injected = () => String(slot.mock.lastCall?.[1] ?? '');

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(mocks.recall, { keywordRoute: true, presentBoost: true, stickyTurns: 0, fullTextCount: 1, finalRecallCount: 5 });
  mocks.present = new Set();
  Object.assign(mocks.memory, { npcs: [], items: [], scenes: [], state: { location: '', locationPath: undefined, sceneFocus: null } });
  mocks.leaves = [];
  useChat('去灰塔看看');
  clearRecallInjection();
  slot.mockClear();
  mocks.rewrite.mockResolvedValue({ intent: '回忆', queries: ['旧事'] });
  mocks.embed.mockResolvedValue([new Float32Array([1])]);
  mocks.search.mockResolvedValue({ results: [] });
  mocks.rerank.mockRejectedValue(new Error('rerank 未配置'));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});
afterEach(() => { clearRecallInjection(); vi.unstubAllGlobals(); });

describe('召回的关键词一路（全部本地 mock）', () => {
  it('向量没检索到时，关键词命中的段落以摘要召回', async () => {
    mocks.memory.scenes = [{ name: '灰塔' }];
    mocks.leaves = [leaf(3, '沈遥第一次在灰塔顶层见到守钟人。'), leaf(5, '沈遥去港口买鱼。')];
    await runVectorRecall();
    expect(injected()).toContain('灰塔顶层');
    expect(injected()).not.toContain('买鱼');
    const d = snapshotRecallDebug();
    expect(d.keyword.map(k => [k.source, k.matched])).toEqual([['#3', ['灰塔']]]);
    expect(d.rerank[0]).toMatchObject({ route: 'keyword', tier: 'brief', similarityKnown: false });
  });

  it('关掉关键词召回时照旧只看向量结果', async () => {
    mocks.recall.keywordRoute = false;
    mocks.memory.scenes = [{ name: '灰塔' }];
    mocks.leaves = [leaf(3, '沈遥第一次在灰塔顶层见到守钟人。')];
    await runVectorRecall();
    expect(snapshotRecallDebug().status).toBe('未召回:检索无候选');
    expect(snapshotRecallDebug().keyword).toEqual([]);
  });

  it('rerank 可用时，关键词命中的段落要达到全文阈值的一半才入选', async () => {
    mocks.memory.scenes = [{ name: '灰塔' }];
    mocks.leaves = [leaf(3, '灰塔塌了一角。'), leaf(4, '灰塔的门换了锁。')];
    mocks.rerank.mockResolvedValue([{ index: 0, score: 0.5 }, { index: 1, score: 0.3 }]);
    await runVectorRecall();
    const tiers = Object.fromEntries(snapshotRecallDebug().rerank.map(r => [r.leafId, r.tier]));
    expect(tiers).toEqual({ L4: 'brief', L3: 'drop' });
  });
});

describe('在场角色加权与召回保留', () => {
  it('rerank 分接近时，提到在场角色的段落排在前面并占用全文名额', async () => {
    mocks.recall.keywordRoute = false;
    mocks.memory.npcs = [{ name: '洛伊' }];
    mocks.present = new Set(['洛伊']);
    mocks.search.mockResolvedValue({ results: [hit(1, 0.9, '梅芙修好了怀表。'), hit(2, 0.9, '洛伊答应夜里同行。')] });
    mocks.rerank.mockResolvedValue([{ index: 0, score: 0.95 }, { index: 1, score: 0.94 }]);
    await runVectorRecall();
    const d = snapshotRecallDebug();
    expect(d.rerank.map(r => [r.leafId, r.tier])).toEqual([['L2', 'full'], ['L1', 'brief']]);
  });

  it('保留 1 轮：上一轮入选的段落在下一轮有空位时补入，再下一轮不再保留', async () => {
    mocks.recall.keywordRoute = false;
    mocks.recall.stickyTurns = 1;
    mocks.search.mockResolvedValueOnce({ results: [hit(1, 0.9, '甲事。')] });
    await runVectorRecall();
    expect(injected()).toContain('甲事');

    useChat('第二轮');
    mocks.search.mockResolvedValueOnce({ results: [hit(2, 0.9, '乙事。')] });
    await runVectorRecall();
    expect(injected()).toContain('乙事');
    expect(injected()).toContain('甲事');
    expect(snapshotRecallDebug().rerank.find(r => r.leafId === 'L1')).toMatchObject({ route: 'sticky', tier: 'brief' });

    useChat('第三轮');
    mocks.search.mockResolvedValueOnce({ results: [hit(3, 0.9, '丙事。')] });
    await runVectorRecall();
    expect(injected()).toContain('丙事');
    expect(injected()).toContain('乙事');
    expect(injected()).not.toContain('甲事');
  });
});
