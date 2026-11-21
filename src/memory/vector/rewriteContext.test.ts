import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext } from '@/st/context';

// 查询重写附带上下文的精简:超过上限时最近几楼从新到旧保留、快照只带相关的人和物、历史摘要从新到旧保留。
// 后半是发出去的消息的角色顺序:开头一条 system,之后 user、assistant 交替,以 user 开头和结尾。
const mocks = vi.hoisted(() => ({
  ctx: null as unknown as STContext,
  nodes: [] as Array<{ id: string; text: string }>,
  memory: null as unknown as Record<string, unknown>,
  /** 窗口起点(resolveKeepStart 的返回值) */
  windowStart: 0,
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
  // 楼层上带 extra.leafOk 的算有有效摘要(前半的用例都不带)
  leafValid: (m: { extra?: { leafOk?: boolean } } | undefined) => !!m?.extra?.leafOk,
}));
vi.mock('../engine', () => ({ resolveKeepStart: () => mocks.windowStart }));
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
  mocks.windowStart = 0;
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

/* ============ 消息的角色顺序 ============ */

/** 排法用例的一楼:U 用户发言、A 回复;leaf = 这一楼有有效摘要,omit = 标为番外,len = 正文补到这么长。 */
interface Floor { r: 'U' | 'A'; leaf?: boolean; omit?: boolean; len?: number }
interface Layout { floors: Floor[]; windowStart?: number; snapshot?: boolean; history?: boolean; cap?: number }
type Msg = { role: string; content: string };

const U: Floor = { r: 'U' };
const A: Floor = { r: 'A' };
/** 有有效摘要的回复 */
const AL: Floor = { r: 'A', leaf: true };
const LEAD = '[最近对话开始]';
const TAIL = '收尾提示';
/** 有内容的状态:快照四节各一条(人物名带「在场」,精简时也会留下)。 */
const STATE = {
  protagonist: { identity: '记者' },
  items: [{ name: '收据', carried: true }],
  npcs: [{ name: '在场的周晚' }],
  plans: [{ status: 'open', kind: 'plan', content: '计划一' }],
  scenes: [], state: { location: '图书馆' },
};
const NO_STATE = { protagonist: {}, items: [], npcs: [], plans: [], scenes: [], state: {} };

/** 每楼的正文以「U3:」「A4:」开头(数字是楼层号)。 */
const floorText = (f: Floor, i: number) => {
  const head = `${f.r}${i}:${f.r === 'U' ? '用户的话' : '回复的正文'}`;
  return f.len ? floor(head, f.len) : head;
};
const toChat = (floors: Floor[]) => floors.map((f, i) => ({
  name: f.r, is_user: f.r === 'U', is_system: false, mes: floorText(f, i),
  extra: { ...(f.leaf ? { leafOk: true } : {}), ...(f.omit ? { bbs_omit: true } : {}) },
}));

/** 按用例布置聊天、窗口起点、状态和上限,发一次重写,返回发出去的消息和这次的统计。 */
async function run(l: Layout) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'INTENT: 意图\nQ: 查询' }, finish_reason: 'stop' }] }), { status: 200 }));
  mocks.ctx = { chat: toChat(l.floors) } as unknown as STContext;
  mocks.windowStart = l.windowStart ?? 0;
  mocks.memory = l.snapshot ? STATE : NO_STATE;
  mocks.nodes = l.history ? [{ id: 'h1', text: '【历史摘要一】' }, { id: 'h2', text: '【历史摘要二】' }] : [];
  mocks.settings.vector.queryRewriteContextChars = l.cap ?? 0;
  const { stats } = await rewriteQuery();
  return { messages: sentMessages() as Msg[], stats: stats! };
}
const sentFor = async (l: Layout) => (await run(l)).messages;

/** 这组用例里状态快照的全文:窗口为空时它与收尾提示同在一条,从那里取出来。 */
async function snapshotText(): Promise<string> {
  const messages = await sentFor({ floors: [U], windowStart: 1, snapshot: true });
  expect(messages).toHaveLength(2);
  const { content } = messages[1];
  expect(content.startsWith('[状态快照')).toBe(true);
  expect(content.endsWith(`\n\n${TAIL}`)).toBe(true);
  return content.slice(0, -`\n\n${TAIL}`.length);
}

/** 一条消息里依次有什么:楼层记号(U3、A4)、快照、截短记号、收尾提示、引导语。 */
const shapeOf = (m: Msg) => {
  const parts = [...m.content.matchAll(/([UA]\d+):|(\[状态快照)|(\(前略\))|(收尾提示)|(\[最近对话开始\])/g)]
    .map(x => x[1] ?? (x[2] ? '快照' : x[3] ? '前略' : x[4] ? '收尾' : '引导'));
  return `${m.role === 'user' ? 'U' : m.role === 'assistant' ? 'A' : m.role}〔${parts.join('+')}〕`;
};
/** system 之后各条消息的样子,如 U〔引导〕 A〔A3+快照〕 U〔U4+收尾〕。 */
const shapesOf = (messages: Msg[]) => messages.slice(1).map(shapeOf).join(' ');

/** 开头一条 system,之后没有 system;之后 user、assistant 交替,以 user 开头和结尾。 */
function expectAlternating(messages: Msg[], label = ''): void {
  expect(messages[0].role, label).toBe('system');
  const roles = messages.slice(1).map(m => m.role);
  expect(roles.length % 2, label).toBe(1);
  expect(roles, label).toEqual(roles.map((_, i) => (i % 2 === 0 ? 'user' : 'assistant')));
}

/**
 * 参照:不经过被测代码,按楼层定义直接算出对话部分的全文(各段之间空一行)。
 * 快照放在「第一层没有有效摘要的楼」之前(没有这样的楼时放在最后一楼之后);第一楼是回复时最前面有引导语;最后是收尾提示。
 */
function expectedText(l: Layout, snapshot: string): string {
  const start = l.windowStart ?? 0;
  const shown = l.floors.map((f, i) => ({ f, i })).filter(({ f, i }) => i >= start && !f.omit);
  const hole = l.floors.findIndex((f, i) => i >= start && !f.omit && !f.leaf);
  const pieces = shown.map(({ f, i }) => floorText(f, i));
  if (l.snapshot) {
    const at = hole === -1 ? -1 : shown.findIndex(({ i }) => i >= hole);
    if (at === -1) pieces.push(snapshot);
    else pieces.splice(at, 0, snapshot);
  }
  return [...(shown[0]?.f.r === 'A' ? [LEAD] : []), ...pieces, TAIL].join('\n\n');
}

/** 固定种子的伪随机数,免得随机用例每次不同。 */
const seeded = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randomFloors = (rand: () => number, long: boolean): Floor[] =>
  Array.from({ length: 1 + Math.floor(rand() * 10) }, () => {
    const r = rand() < 0.5 ? 'U' : 'A';
    return { r, leaf: r === 'A' && rand() < 0.6, omit: rand() < 0.08, len: long && rand() < 0.8 ? 600 + Math.floor(rand() * 1500) : undefined } as Floor;
  });
const describeFloors = (l: Layout) => `${l.floors.map(f => f.r + (f.leaf ? '*' : '') + (f.omit ? '~' : '')).join('')} 起点 ${l.windowStart ?? 0}`;

/** 三千字的楼层,用来触发精简。 */
const LONG_CHAT: Floor[] = [
  { r: 'U', len: 50 }, { r: 'A', leaf: true, len: 3000 }, { r: 'U', len: 50 }, { r: 'A', leaf: true, len: 3000 },
  { r: 'U', len: 50 }, { r: 'A', leaf: true, len: 3000 }, { r: 'U', len: 50 },
];

describe('查询重写消息的角色顺序', () => {
  // expected 是 system 之后各条消息的样子:U、A 是角色,括号里依次是这一条里的楼层(数字是楼层号)、快照、收尾提示、引导语
  it.each<Layout & { name: string; expected: string }>([
    { name: '新聊天,用户先发言,末楼是用户发言', floors: [U, A, U, A, U], expected: 'U〔U0〕 A〔A1〕 U〔U2〕 A〔A3〕 U〔U4+收尾〕' },
    { name: '开场白在前,末楼是用户发言,没有快照', floors: [A, U, A, U], expected: 'U〔引导〕 A〔A0〕 U〔U1〕 A〔A2〕 U〔U3+收尾〕' },
    { name: '开场白在前、首楼没有摘要,有快照', floors: [A, U, A, U], snapshot: true, expected: 'U〔引导〕 A〔快照+A0〕 U〔U1〕 A〔A2〕 U〔U3+收尾〕' },
    {
      name: '窗口从有摘要的回复开始,末楼是用户发言,有快照和历史摘要', floors: [U, AL, U, AL, U, AL, U, AL, U], windowStart: 3, snapshot: true, history: true,
      expected: 'U〔引导〕 A〔A3+快照〕 U〔U4〕 A〔A5〕 U〔U6〕 A〔A7〕 U〔U8+收尾〕',
    },
    {
      name: '窗口从有摘要的回复开始,没有快照', floors: [U, AL, U, AL, U, AL, U, AL, U], windowStart: 3,
      expected: 'U〔引导〕 A〔A3〕 U〔U4〕 A〔A5〕 U〔U6〕 A〔A7〕 U〔U8+收尾〕',
    },
    { name: '中间连着两条用户发言', floors: [AL, U, U, A, U], snapshot: true, expected: 'U〔引导〕 A〔A0+快照〕 U〔U1+U2〕 A〔A3〕 U〔U4+收尾〕' },
    { name: '连着两条回复', floors: [U, A, A, U], expected: 'U〔U0〕 A〔A1+A2〕 U〔U3+收尾〕' },
    { name: '末楼是回复', floors: [AL, U, A], snapshot: true, expected: 'U〔引导〕 A〔A0+快照〕 U〔U1〕 A〔A2〕 U〔收尾〕' },
    { name: '窗口里只有一条有摘要的回复', floors: [U, AL, U, AL], windowStart: 3, snapshot: true, expected: 'U〔引导〕 A〔A3+快照〕 U〔收尾〕' },
    { name: '窗口为空,有快照', floors: [U, AL, U], windowStart: 3, snapshot: true, expected: 'U〔快照+收尾〕' },
    { name: '窗口为空,没有快照', floors: [U, AL, U], windowStart: 3, expected: 'U〔收尾〕' },
    { name: '只有一条用户发言', floors: [U], expected: 'U〔U0+收尾〕' },
    { name: '两条用户发言之间的回复标为番外', floors: [AL, U, { r: 'A', omit: true }, U], snapshot: true, expected: 'U〔引导〕 A〔A0+快照〕 U〔U1+U3+收尾〕' },
    { name: '精简后保留下来的最早一楼是截短的回复', floors: LONG_CHAT, windowStart: 1, snapshot: true, cap: 4000, expected: 'U〔引导〕 A〔快照+前略〕 U〔U4〕 A〔A5〕 U〔U6+收尾〕' },
    { name: '精简后保留下来的最早一楼是用户发言', floors: LONG_CHAT, windowStart: 1, snapshot: true, cap: 3500, expected: 'U〔快照+U4〕 A〔A5〕 U〔U6+收尾〕' },
  ])('$name', async ({ expected, ...layout }) => {
    const { messages, stats } = await run(layout);
    expectAlternating(messages);
    expect(shapesOf(messages)).toBe(expected);
    expect(stats.trimmed).toBe(!!layout.cap);
  });

  it('相邻的同角色消息用一个空行并成一条,收尾提示并进最后一条用户发言;历史摘要仍在开头的 system 里', async () => {
    const snapshot = await snapshotText();
    const { messages, stats } = await run({ floors: [AL, U, U, A, U], snapshot: true, history: true });
    const history = '【历史摘要一】\n\n【历史摘要二】';
    const floors = ['A0:回复的正文', 'U1:用户的话', 'U2:用户的话', 'A3:回复的正文', 'U4:用户的话'];
    expect(messages).toEqual([
      { role: 'system', content: `系统提示\n\n[历史剧情摘要]\n${history}` },
      { role: 'user', content: LEAD },
      { role: 'assistant', content: `${floors[0]}\n\n${snapshot}` },
      { role: 'user', content: `${floors[1]}\n\n${floors[2]}` },
      { role: 'assistant', content: floors[3] },
      { role: 'user', content: `${floors[4]}\n\n${TAIL}` },
    ]);
    // 附带上下文的字数只算历史摘要、楼层和快照,引导语、收尾提示和合并用的空行不算
    expect(stats.sentContextChars).toBe(history.length + floors.join('').length + snapshot.length);
    expect(stats.contextChars).toBe(stats.sentContextChars);
  });

  it('状态快照的位置不变:在第一层没有摘要的楼之前', async () => {
    const snapshot = await snapshotText();
    // 断点前面有楼层:拼在断点前一楼的末尾
    expect((await sentFor({ floors: [U, AL, U, AL, U], windowStart: 1, snapshot: true })).slice(1)).toEqual([
      { role: 'user', content: LEAD },
      { role: 'assistant', content: `A1:回复的正文\n\n${snapshot}` },
      { role: 'user', content: 'U2:用户的话' },
      { role: 'assistant', content: 'A3:回复的正文' },
      { role: 'user', content: `U4:用户的话\n\n${TAIL}` },
    ]);
    // 断点就是第一条:拼在它的开头;第一条是回复时引导语仍单独在前
    expect((await sentFor({ floors: [A, U], snapshot: true })).slice(1)).toEqual([
      { role: 'user', content: LEAD },
      { role: 'assistant', content: `${snapshot}\n\nA0:回复的正文` },
      { role: 'user', content: `U1:用户的话\n\n${TAIL}` },
    ]);
    expect((await sentFor({ floors: [U, A, U], snapshot: true })).slice(1)).toEqual([
      { role: 'user', content: `${snapshot}\n\nU0:用户的话` },
      { role: 'assistant', content: 'A1:回复的正文' },
      { role: 'user', content: `U2:用户的话\n\n${TAIL}` },
    ]);
    // 窗口里每一楼都有摘要:拼在最后一条的末尾。最后一条是回复时收尾提示另起一条
    expect((await sentFor({ floors: [U, AL, U, AL], windowStart: 3, snapshot: true })).slice(1)).toEqual([
      { role: 'user', content: LEAD },
      { role: 'assistant', content: `A3:回复的正文\n\n${snapshot}` },
      { role: 'user', content: TAIL },
    ]);
    // 最后一条是用户发言时:先是这一楼,再是快照,最后是收尾提示
    expect((await sentFor({ floors: [AL, { r: 'U', leaf: true }], snapshot: true })).slice(1)).toEqual([
      { role: 'user', content: LEAD },
      { role: 'assistant', content: 'A0:回复的正文' },
      { role: 'user', content: `U1:用户的话\n\n${snapshot}\n\n${TAIL}` },
    ]);
    // 窗口里没有楼层:快照与收尾提示同在一条 user,快照在前
    expect((await sentFor({ floors: [U, AL, U], windowStart: 3, snapshot: true })).slice(1)).toEqual([
      { role: 'user', content: `${snapshot}\n\n${TAIL}` },
    ]);
  });

  it('随机排列 300 组:都交替,各楼、快照、收尾提示的先后与逐条排列时相同', async () => {
    const snapshot = await snapshotText();
    const rand = seeded(20261120);
    for (let n = 0; n < 300; n++) {
      const floors = randomFloors(rand, false);
      const layout: Layout = { floors, windowStart: Math.floor(rand() * (floors.length + 1)), snapshot: rand() < 0.7, history: rand() < 0.5 };
      const label = `第 ${n} 组 ${describeFloors(layout)}`;
      const messages = await sentFor(layout);
      expectAlternating(messages, label);
      expect(messages.slice(1).map(m => m.content).join('\n\n'), label).toBe(expectedText(layout, snapshot));
    }
  });

  it('随机排列 200 组、附带上下文按上限精简之后:同样交替,收尾提示在最后', async () => {
    const rand = seeded(1120);
    let trimmed = 0;
    for (let n = 0; n < 200; n++) {
      const floors = randomFloors(rand, true);
      const layout: Layout = { floors, windowStart: Math.floor(rand() * floors.length), snapshot: rand() < 0.7, history: rand() < 0.5, cap: 1200 + Math.floor(rand() * 2000) };
      const label = `第 ${n} 组 ${describeFloors(layout)} 上限 ${layout.cap}`;
      const { messages, stats } = await run(layout);
      if (stats.trimmed) trimmed++;
      expectAlternating(messages, label);
      expect(messages[messages.length - 1].content.endsWith(TAIL), label).toBe(true);
      expect(messages.slice(1).filter(m => m.content.includes('[状态快照')).length, label).toBeLessThanOrEqual(1);
      expect(messages.slice(1).filter(m => m.content.includes(LEAD)).length, label).toBeLessThanOrEqual(1);
    }
    // 这 200 组里确有一半左右超过上限、走了精简
    expect(trimmed).toBeGreaterThan(80);
  });
});
