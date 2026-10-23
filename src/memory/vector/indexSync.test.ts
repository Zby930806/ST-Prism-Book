import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  issue: '',
  active: true,
  settings: {
    enabled: true,
    customStripTags: [] as string[],
    vector: { enabled: true, embedding: { model: 'emb-A' } },
  },
  reconcile: vi.fn(), upsert: vi.fn(), updatePayload: vi.fn(), clearScope: vi.fn(),
  embed: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/api/settings', () => ({ apiSettings: mocks.settings, engineActiveHere: () => mocks.active }));
vi.mock('../store', () => ({ memory: { summaries: [] }, memoryWriteIssue: () => mocks.issue }));
vi.mock('../apply', () => ({
  getLeaf: (m: STMessage | undefined) => m?.extra?.bbs_leaf,
  leafValid: (m: STMessage | undefined) => !!m?.extra?.bbs_leaf,
}));
vi.mock('../engine', () => ({ isAiFloor: (m: STMessage | undefined) => !!m && !m.is_user && !m.extra?.bbs_omit && !(m.is_system && m.extra?.type) }));
vi.mock('../timeTag', () => ({ cleanBody: (s: string) => String(s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() }));
vi.mock('./store', () => ({
  resetVectorStoreProbe: () => undefined,
  vecReconcile: mocks.reconcile, vecUpsert: mocks.upsert, vecUpdatePayload: mocks.updatePayload, vecClearScope: mocks.clearScope,
}));
// 每批 2 条,便于用少量叶子验证逐批写入
vi.mock('./embed', () => ({ EMBED_BATCH: 2, embedTexts: mocks.embed, encodeFloat32Base64: () => 'AA' }));
vi.mock('./scope', () => ({ currentVectorDb: () => 'db', currentChatId: () => 'c1' }));
vi.mock('./cache', () => ({ invalidateRecallCache: mocks.invalidate }));

import { clearVectorIndex, collectLeaves, ensureRecallIndex, forgetRejectedLeaves, rebuildVectorIndex, syncVectorIndex, vectorIndexBlockReason } from './index';
import { indexModelIssue, readIndexModel } from './indexModel';

const user = (mes: string, extra: Record<string, unknown> = {}): STMessage => ({ name: 'User', is_user: true, is_system: false, mes, extra });
const ai = (mes: string, leafId: string, text = `${leafId}的摘要`): STMessage => ({
  name: 'AI', is_user: false, is_system: false, mes, extra: { bbs_leaf: { id: leafId, text, delta: {}, v: 1, swipe: 0 } as never },
});
const badInput = (message = 'Embedding：服务商拒绝了这次请求（HTTP 400）。') => Object.assign(new Error(message), { name: 'EmbedError', kind: 'bad-request', status: 400 });
const vectors = (n: number, dim = 4) => Array.from({ length: n }, () => new Float32Array(dim));

function useChat(chat: STMessage[]) {
  mocks.context = { chat, chatMetadata: {}, getCurrentChatId: () => 'c1' } as unknown as STContext;
}
/** 后端里一条都没有:全部叶子都待补 */
function allMissing() {
  mocks.reconcile.mockImplementation(async (_db: string, _scope: string, present: Array<{ leafId: string }>) => ({ deleted: 0, missing: present.map(p => p.leafId), stalePayload: [] }));
}

let storage: Map<string, string>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.issue = ''; mocks.active = true;
  mocks.settings.enabled = true;
  mocks.settings.vector.enabled = true;
  mocks.settings.vector.embedding.model = 'emb-A';
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  forgetRejectedLeaves();
  mocks.upsert.mockResolvedValue({ upserted: 0 });
  mocks.updatePayload.mockImplementation(async (_db: string, _scope: string, items: unknown[]) => ({ updated: items.length }));
  mocks.clearScope.mockResolvedValue({ deleted: 3 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('索引「原文」包含叶子覆盖的用户发言', () => {
  it('按说话人标注,番外楼和用户自己隐藏的发言不算,插件隐藏的照常算', () => {
    const chat = [
      ai('开场白', 'L0'),
      user('我答应你明天还书'),
      { ...user('番外里的话'), extra: { bbs_omit: true } },
      { ...user('用户自己隐藏的话'), is_system: true },
      { ...user('插件隐藏的旧发言'), is_system: true, extra: { bbs_hidden: true } },
      ai('<think>想</think>好，明天见。', 'L1'),
    ];
    const leaves = collectLeaves(chat);
    expect(leaves.map(l => l.leafId)).toEqual(['L0', 'L1']);
    expect(leaves[0].mesFull).toBe('开场白');
    expect(leaves[1].mesFull).toBe('主角：我答应你明天还书\n\n主角：插件隐藏的旧发言\n\n角色：好，明天见。');
    expect(leaves[1].msgIndex).toBe(5);
  });

  it('过长的用户发言只保留前一部分并注明', () => {
    const leaves = collectLeaves([user('长'.repeat(2000)), ai('回复', 'L1')]);
    expect(leaves[0].mesFull).toContain('（这条发言较长，后文省略）');
    expect(leaves[0].mesFull.length).toBeLessThan(1600);
  });

  it('用户发言改了,payloadHash 随之改变(走轻量更新,不重新生成向量)', () => {
    const before = collectLeaves([user('甲'), ai('回复', 'L1')])[0];
    const after = collectLeaves([user('乙'), ai('回复', 'L1')])[0];
    expect(after.docHash).toBe(before.docHash);
    expect(after.payloadHash).not.toBe(before.payloadHash);
  });
});

describe('同步结果写明原因,不再一律显示「已是最新」', () => {
  it('不能索引时返回原因', async () => {
    useChat([user('你好'), ai('回复', 'L1')]);
    mocks.settings.vector.enabled = false;
    expect(await syncVectorIndex()).toEqual({ embedded: 0, payloadUpdated: 0, skipped: expect.stringContaining('向量记忆未启用') });
    mocks.settings.vector.enabled = true;
    mocks.issue = '旧记忆保护中：测试原因。';
    expect((await syncVectorIndex()).skipped).toContain('保护状态');
    mocks.issue = '';
    mocks.settings.enabled = false;
    expect(vectorIndexBlockReason()).toContain('总开关');
    mocks.settings.enabled = true;
    mocks.active = false;
    expect(vectorIndexBlockReason()).toContain('排除角色');
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('embedding 失败时不抛错,结果里带原因', async () => {
    useChat([user('你好'), ai('回复', 'L1')]);
    allMissing();
    mocks.embed.mockRejectedValueOnce(Object.assign(new Error('Embedding：API 密钥无效或没有权限（HTTP 401）。'), { name: 'EmbedError', kind: 'auth', status: 401 }));
    const result = await syncVectorIndex();
    expect(result).toMatchObject({ embedded: 0, error: 'Embedding：API 密钥无效或没有权限（HTTP 401）。' });
  });

  it('柏宝库或浏览器存储出错时写明处理方法和位置', async () => {
    useChat([user('你好'), ai('回复', 'L1')]);
    mocks.reconcile.mockRejectedValueOnce(Object.assign(new Error('database locked'), { code: 'E_DB' }));
    expect((await syncVectorIndex()).error).toBe('柏宝库向量接口出错：database locked。请确认柏宝库后端正常运行后，到「设置 → 向量记忆 → 索引维护」点「补齐当前聊天索引」。');
    allMissing();
    mocks.embed.mockResolvedValueOnce(vectors(1));
    mocks.upsert.mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }));
    expect((await syncVectorIndex()).error).toContain('浏览器存储空间不足');
  });
});

describe('逐批写入', () => {
  const chat = () => [user('一'), ai('a', 'L1'), user('二'), ai('b', 'L2'), user('三'), ai('c', 'L3'), user('四'), ai('d', 'L4'), user('五'), ai('e', 'L5')];

  it('中途失败时,已写入的批次保留', async () => {
    useChat(chat());
    allMissing();
    mocks.embed
      .mockResolvedValueOnce(vectors(2))
      .mockRejectedValueOnce(Object.assign(new Error('Embedding：请求超时（超过 10 秒）。'), { name: 'EmbedError', kind: 'timeout' }));
    const result = await syncVectorIndex();
    expect(result).toMatchObject({ embedded: 2, error: 'Embedding：请求超时（超过 10 秒）。' });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0][2].map((i: { leafId: string }) => i.leafId)).toEqual(['L1', 'L2']);
  });

  it('某一批被拒收时逐条重试,跳过被拒的摘要,其余照常写入;本次会话内不再反复请求被拒的那条', async () => {
    useChat(chat());
    allMissing();
    mocks.embed.mockImplementation(async (texts: string[]) => {
      if (texts.length > 1 && texts.includes('L4的摘要')) throw badInput();
      if (texts.length === 1 && texts[0] === 'L4的摘要') throw badInput('Embedding：发送的内容超出了模型的上下文长度（HTTP 413）。');
      return vectors(texts.length);
    });
    const result = await syncVectorIndex();
    expect(result.embedded).toBe(4);
    expect(result.error).toBeUndefined();
    expect(result.failedLeaves).toEqual([{ floor: 7, reason: 'Embedding：发送的内容超出了模型的上下文长度（HTTP 413）。' }]);
    const written = mocks.upsert.mock.calls.flatMap(call => call[2].map((i: { leafId: string }) => i.leafId));
    expect(written.sort()).toEqual(['L1', 'L2', 'L3', 'L5']);

    // 下一次对账:L4 仍缺,但本次会话内不再请求它
    mocks.embed.mockClear();
    mocks.reconcile.mockResolvedValueOnce({ deleted: 0, missing: ['L4'], stalePayload: [] });
    expect((await syncVectorIndex()).embedded).toBe(0);
    expect(mocks.embed).not.toHaveBeenCalled();
    // 手动补齐前清掉记忆,再试一次
    forgetRejectedLeaves();
    mocks.reconcile.mockResolvedValueOnce({ deleted: 0, missing: ['L4'], stalePayload: [] });
    await syncVectorIndex();
    expect(mocks.embed).toHaveBeenCalled();
  });

  it('本轮一条都没写成、逐条重试又连续被拒 3 条时,按接口问题整体报错,不记成坏条目', async () => {
    useChat(chat());
    allMissing();
    mocks.embed.mockImplementation(async (texts: string[]) => {
      if (texts.length > 1) throw badInput();
      throw badInput('Embedding：服务商拒绝了这次请求（HTTP 400）。常见原因是模型名不对。');
    });
    const result = await syncVectorIndex();
    expect(result.error).toBe('Embedding：服务商拒绝了这次请求（HTTP 400）。常见原因是模型名不对。');
    expect(result.failedLeaves).toBeUndefined();
    expect(mocks.upsert).not.toHaveBeenCalled();
    // 没有记成坏条目:下次同步照常请求 L1
    mocks.embed.mockClear();
    mocks.embed.mockResolvedValue(vectors(2));
    await syncVectorIndex();
    expect(mocks.embed.mock.calls[0][0]).toEqual(['L1的摘要', 'L2的摘要']);
  });

  it('全文或时间变化分批更新,并让旧的召回结果失效', async () => {
    const many: STMessage[] = [];
    for (let i = 0; i < 250; i++) many.push(user(`问${i}`), ai(`答${i}`, `L${i}`));
    useChat(many);
    mocks.reconcile.mockImplementation(async (_db: string, _scope: string, present: Array<{ leafId: string }>) => ({ deleted: 0, missing: [], stalePayload: present.map(p => p.leafId) }));
    const result = await syncVectorIndex();
    expect(result.payloadUpdated).toBe(250);
    expect(mocks.updatePayload.mock.calls.map(call => call[2].length)).toEqual([100, 100, 50]);
    expect(mocks.invalidate).toHaveBeenCalled();
  });
});

describe('召回前补索引的等待上限', () => {
  it('超过上限时先返回剩余条数,索引在后台继续', async () => {
    useChat([user('一'), ai('a', 'L1'), user('二'), ai('b', 'L2'), user('三'), ai('c', 'L3')]);
    allMissing();
    let release!: () => void;
    mocks.embed
      .mockResolvedValueOnce(vectors(2))
      .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(vectors(1)); }));
    const pending: number[] = [];
    const state = await ensureRecallIndex(undefined, { maxWaitMs: 30, onPending: n => pending.push(n) });
    expect(state).toEqual({ timedOut: true, pending: 1 });
    expect(pending).toEqual([3, 1]);
    release();
    await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(2));
  });

  it('补建失败时返回原因', async () => {
    useChat([user('一'), ai('a', 'L1')]);
    allMissing();
    mocks.embed.mockRejectedValueOnce(Object.assign(new Error('Embedding：接口地址不对（HTTP 404）。'), { name: 'EmbedError', kind: 'not-found', status: 404 }));
    expect(await ensureRecallIndex(undefined, { maxWaitMs: 1000 })).toEqual({ error: 'Embedding：接口地址不对（HTTP 404）。' });
  });
});

describe('记录建索引用的 Embedding 模型', () => {
  it('写入向量时记下模型和维度;换模型后提示清空并重建;清空后记录删除', async () => {
    useChat([user('一'), ai('a', 'L1')]);
    allMissing();
    mocks.embed.mockResolvedValueOnce(vectors(1, 8));
    await syncVectorIndex();
    expect(readIndexModel('db', 'chat:c1')).toMatchObject({ model: 'emb-A', dim: 8 });
    expect(indexModelIssue('db', 'chat:c1', 'emb-A', 8)).toBe('');
    expect(indexModelIssue('db', 'chat:c1', 'emb-A', 16)).toContain('16 维');
    mocks.settings.vector.embedding.model = 'emb-B';
    expect(indexModelIssue('db', 'chat:c1', 'emb-B')).toContain('「emb-A」');
    expect(indexModelIssue('db', 'chat:c1', 'emb-B')).toContain('清空并重建');
    expect(await clearVectorIndex()).toBe(3);
    expect(readIndexModel('db', 'chat:c1')).toBeNull();
  });

  it('换模型后补写的向量不覆盖原记录;升级前已有的索引按当前模型补记', async () => {
    useChat([user('一'), ai('a', 'L1'), user('二'), ai('b', 'L2')]);
    // 后端已有全部向量,本机还没有记录:视为当前模型
    mocks.reconcile.mockResolvedValueOnce({ deleted: 0, missing: [], stalePayload: [] });
    await syncVectorIndex();
    expect(readIndexModel('db', 'chat:c1')).toMatchObject({ model: 'emb-A' });
    mocks.settings.vector.embedding.model = 'emb-B';
    mocks.reconcile.mockResolvedValueOnce({ deleted: 0, missing: ['L2'], stalePayload: [] });
    mocks.embed.mockResolvedValueOnce(vectors(1));
    await syncVectorIndex();
    expect(readIndexModel('db', 'chat:c1')?.model).toBe('emb-A');
  });

  it('清空并重建:清空后立即用当前模型重新写入', async () => {
    useChat([user('一'), ai('a', 'L1')]);
    allMissing();
    mocks.embed.mockResolvedValueOnce(vectors(1, 6));
    const { deleted, result } = await rebuildVectorIndex();
    expect(deleted).toBe(3);
    expect(result.embedded).toBe(1);
    expect(readIndexModel('db', 'chat:c1')).toMatchObject({ model: 'emb-A', dim: 6 });
  });

  it('补写到一半时换了模型并清空:之后写入的向量按实际使用的模型记录,不会留下旧模型的提示', async () => {
    useChat([user('一'), ai('a', 'L1'), user('二'), ai('b', 'L2'), user('三'), ai('c', 'L3')]);
    allMissing();
    mocks.embed.mockImplementation(async (texts: string[]) => vectors(texts.length));
    let switched = false;
    await ensureRecallIndex(undefined, {
      onPending: n => {
        // 第一批(2 条)写完、第二批还没发出时,用户换了 Embedding 模型并点了「清空并重建」
        if (switched || n !== 1) return;
        switched = true;
        mocks.settings.vector.embedding.model = 'emb-B';
        void clearVectorIndex();
      },
    });
    expect(switched).toBe(true);
    expect(mocks.embed.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(readIndexModel('db', 'chat:c1')?.model).toBe('emb-B');
    expect(indexModelIssue('db', 'chat:c1', 'emb-B')).toBe('');
  });
});
