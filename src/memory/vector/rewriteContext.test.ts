import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext } from '@/st/context';

// 查询重写附带上下文的精简:超过上限时最近几楼从新到旧保留、快照只带相关的人和物、历史摘要从新到旧保留。
const mocks = vi.hoisted(() => ({
  ctx: null as unknown as STContext,
  nodes: [] as Array<{ id: string; text: string }>,
  memory: null as unknown as Record<string, unknown>,
  settings: {
    vector: {
      embedding: { url: 'https://example.test/v1', key: 'k', model: 'emb', timeoutSec: 10, retries: 1 },
      rerank: { url: '', key: '', model: 'rr', timeoutSec: 20, retries: 1 },
      queryRewrite: { url: '', key: '', model: 'chat-model', timeoutSec: 90, retries: 1 },
      queryRewriteMaxTokens: 8192,
      queryRewriteJailbreak: false,
      queryRewriteContextChars: 8000 as unknown,
    },
  },
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.ctx }));
vi.mock('@/api/settings', () => ({
  apiSettings: mocks.settings,
  resolveVectorModel: (role: 'embedding' | 'rerank' | 'queryRewrite') => {
    const v = mocks.settings.vector;
    const cfg = v[role];
    return { url: cfg.url || v.embedding.url, key: cfg.key || v.embedding.key, model: cfg.model, timeoutSec: cfg.timeoutSec, retries: cfg.retries };
  },
}));
vi.mock('../apply', () => ({
  deriveMemory: () => mocks.memory,
  // 名字里带「在场」的算在场,其余不在场
  classifyNpcPresence: (n: { name: string }) => (n.name.includes('在场') ? 'present' : 'absent'),
  getLeaf: () => null,
  leafValid: () => false,
}));
vi.mock('../engine', () => ({ resolveKeepStart: () => 0 }));
vi.mock('../inject', () => ({
  selectHistoryNodesBefore: () => mocks.nodes,
  renderHistoryNodes: (nodes: Array<{ text: string }>) => nodes.map(n => n.text).join('\n\n'),
}));
vi.mock('../prompts', () => ({
  fmtItems: (items: Array<{ name: string }>) => items.map(i => `  - ${i.name}`).join('\n'),
  fmtNpcs: (npcs: Array<{ name: string }>) => npcs.map(n => `  - ${n.name}`).join('\n'),
  fmtPlans: (plans: Array<{ content: string }>) => plans.map(p => `  - ${p.content}`).join('\n'),
  fmtProtagonist: () => '  - 身份:记者',
  QUERY_REWRITE_SYSTEM: '系统提示', QUERY_REWRITE_TAIL: '收尾提示',
}));
vi.mock('../store', () => ({ memory: { summaries: [] } }));
vi.mock('../timeTag', () => ({ cleanBody: (s: string) => s }));
vi.mock('@/memory/taskContext', () => ({ taskContextPrompt: () => '' }));

import { resetRewriteParamMemory, rewriteQuery } from './rewrite';

const fetchMock = vi.fn();
const sentMessages = () => JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages as Array<{ role: string; content: string }>;
const floor = (mark: string, len: number) => mark + '文'.repeat(len - mark.length);

beforeEach(() => {
  resetRewriteParamMemory();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'INTENT: 意图\nQ: 查询' }, finish_reason: 'stop' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  // 历史摘要 30 段、每段约 500 字;最近三楼回复各 3000 字;本轮输入里提到了「老吴」
  mocks.nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, text: floor(`【第${i + 1}段】`, 500) }));
  mocks.ctx = {
    chat: [
      { mes: '第一句', is_user: true, is_system: false, name: 'U' },
      { mes: floor('回复一', 3000), is_user: false, is_system: false, name: 'A' },
      { mes: '第二句', is_user: true, is_system: false, name: 'U' },
      { mes: floor('回复二', 3000), is_user: false, is_system: false, name: 'A' },
      { mes: '第三句', is_user: true, is_system: false, name: 'U' },
      { mes: floor('回复三', 3000), is_user: false, is_system: false, name: 'A' },
      { mes: '我想问老吴那晚的事', is_user: true, is_system: false, name: 'U' },
    ],
  } as unknown as STContext;
  mocks.memory = {
    protagonist: { identity: '记者' },
    items: [{ name: '收据', carried: true }, { name: '旧报纸', carried: false, location: '报社' }],
    npcs: [
      { name: '在场的周晚' }, { name: '老吴' },
      ...Array.from({ length: 40 }, (_, i) => ({ name: `路人${i + 1}号` })),
    ],
    plans: Array.from({ length: 6 }, (_, i) => ({ status: 'open', kind: 'plan', content: `计划${i + 1}` })),
    scenes: [], state: { location: '图书馆' },
  };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('查询重写的附带上下文', () => {
  it('上限填 0 时全部带上,与以前一样', async () => {
    mocks.settings.vector.queryRewriteContextChars = 0;
    const { stats } = await rewriteQuery();
    const all = sentMessages().map(m => m.content).join('\n');
    expect(all).toContain('【第1段】');
    expect(all).toContain('路人40号');
    expect(all).toContain('旧报纸');
    expect(all).not.toContain('从略');
    expect(stats).toMatchObject({ trimmed: false });
    expect(stats!.sentContextChars).toBe(stats!.contextChars);
  });

  it('超过上限时按新近和相关程度精简,总量不超过上限', async () => {
    mocks.settings.vector.queryRewriteContextChars = 8000;
    const { stats } = await rewriteQuery();
    const messages = sentMessages();
    const all = messages.map(m => m.content).join('\n');
    expect(stats!.trimmed).toBe(true);
    expect(stats!.contextChars).toBeGreaterThan(20000);
    expect(stats!.sentContextChars).toBeLessThanOrEqual(8000);
    // 本轮输入原样带上,最新一楼回复带上
    expect(all).toContain('我想问老吴那晚的事');
    expect(all).toContain('回复三');
    // 快照:随身物品、在场的人和本轮提到名字的人保留;不在场也没提到的人、存放在别处的物品略去
    expect(all).toContain('收据');
    expect(all).not.toContain('旧报纸');
    expect(all).toContain('在场的周晚');
    expect(all).toContain('老吴');
    expect(all).not.toContain('路人1号');
    // 历史摘要从新到旧保留,更早的注明从略
    const system = messages[0].content;
    expect(system).toContain('【第30段】');
    expect(system).not.toContain('【第1段】');
    expect(system).toContain('(更早的剧情从略)');
  });

  it('最近一楼本身超过上限时截短,保留结尾', async () => {
    mocks.settings.vector.queryRewriteContextChars = 2000;
    (mocks.ctx.chat as Array<{ mes: string }>)[5].mes = floor('回复三开头', 2500) + '最后一句';
    const { stats } = await rewriteQuery();
    const all = sentMessages().map(m => m.content).join('\n');
    expect(all).toContain('我想问老吴那晚的事');
    expect(all).toContain('最后一句');
    expect(all).toContain('(前略)……');
    expect(all).not.toContain('回复三开头');
    expect(stats!.sentContextChars).toBeLessThanOrEqual(2000);
  });
});
