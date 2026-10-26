import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import { apiFailure } from '@/api/errors';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { deriveMemory } from './apply';
import {
  applyNpcRefile, buildDiscoverMessages, cancelNpcRefile, collectArchiveExcerpts, discardNpcRefile, NPC_REFILE_PROMPT, npcRefileState, parseArchiveReply,
  parseDiscoverReply, planRefileChunks, readRefileRecord, refileChangeKey, refileEstimate, refileReview, refileSkipText, REFILE_RECORD_KEY, RefileReplyError,
  runNpcRefile, sharedLabelBases, type ArchiveTarget,
} from './npcRefile';
import { RULE_CONTENT_BOUNDARY } from './prompts';
import { loadMemory, memory, memoryWriteIssue, recomputeDerived } from './store';
import { createEmptyMemory, MEMORY_KEY, type LeafExtra, type StoredDelta } from './types';

// 模拟请求:验证分批取材、校验、审核与写入口径,不代表真实模型找人和整理档案的质量。
const saved = JSON.stringify(settings.apiSettings);
let seq = 0;
const ai = (mes: string, delta?: StoredDelta, extra: Record<string, unknown> = {}): STMessage => ({
  name: '雾港来信', is_user: false, is_system: false, mes,
  extra: { ...extra, ...(delta ? { bbs_leaf: { id: 'refile-' + ++seq, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } as LeafExtra } : {}) },
});
const user = (mes: string): STMessage => ({ name: '沈遥', is_user: true, is_system: false, mes });
const leafOf = (m: STMessage) => m.extra!.bbs_leaf as LeafExtra;

function useChat(chat: STMessage[], chatMetadata: Record<string, unknown> = {}) {
  const ctx = { chat, chatMetadata, name1: '沈遥', name2: '雾港来信', getCurrentChatId: () => 'refile-test',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}

/**
 * #1 洛伊建档;#3、#5 是男二视角的支线,同桌林小雨和青梅竹马周晴登场,当时的摘要没有记;#7 回到主线,洛伊最后出场。
 */
function sideStoryChat(): STMessage[] {
  return [
    user('我们去学校找男二。'),
    ai('沈遥和洛伊来到学校。洛伊是个高个子的少年，总是眯着眼。', { npcs: { add: [{ name: '洛伊', title: '沈遥的同伴' }] } }),
    user('接下来写男二视角。'),
    ai('男二走进教室，同桌林小雨抬头冲他笑了笑。林小雨扎着马尾，戴一副圆框眼镜。', { time: '2031/5/8 08:00' }),
    user('继续。'),
    ai('放学后，青梅竹马周晴在校门口等他。周晴今年十七岁，说话总是慢吞吞的。', { time: '2031/5/8 17:00' }),
    user('回到沈遥这边。'),
    ai('沈遥和洛伊在旧街吃面。洛伊说他是旧街书店的学徒。', { time: '2031/5/8 19:00', npcs: { update: [{ name: '洛伊', title: '沈遥的同伴' }] } }),
  ];
}

const discoverReply = (npcs: unknown[]) => JSON.stringify({ npcs });
const xiaoyu = { name: '林小雨', appear: '男二走进教室，同桌林小雨抬头冲他笑了笑。', title: '男二的同桌', desc: '扎着马尾，戴圆框眼镜',
  evidence: { title: '同桌林小雨抬头冲他笑了笑', desc: '林小雨扎着马尾，戴一副圆框眼镜。' } };
const zhouqing = { name: '周晴', appear: '放学后，青梅竹马周晴在校门口等他。', title: '男二的青梅竹马', age: '十七岁',
  evidence: { title: '青梅竹马周晴在校门口等他', age: '周晴今年十七岁' } };

const isDiscover = (messages: { content: string }[]) => messages.some(m => m.content.includes('角色名册整理员'));
const isArchive = (messages: { content: string }[]) => messages.some(m => m.content.includes('角色档案整理员'));
const floorsIn = (messages: { content: string }[]) => [...(messages.at(-1)?.content ?? '').matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false });
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(discoverReply([]));
  Object.assign(npcRefileState, { running: false, phase: '', cancelRequested: false, done: 0, total: 0, current: '' });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('第一步:分批取材', () => {
  it('每批最多 10 个回复楼层,含已隐藏的楼层和用户发言,不含番外楼与原生系统楼', () => {
    const chat: STMessage[] = [];
    for (let i = 0; i < 12; i++) chat.push(user(`第${i}句。`), ai(`第${i}段回复。`));
    chat[3] = { ...chat[3], is_system: true, extra: { bbs_hidden: true } };
    chat[5] = { ...chat[5], extra: { bbs_omit: true } };
    chat.push({ name: '旁白', is_user: false, is_system: true, mes: '系统提示。', extra: { type: 'narrator' } } as STMessage);
    const chunks = planRefileChunks(chat);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].floors).toContain(3);
    expect(chunks[0].floors).not.toContain(5);
    expect(chunks[0].floors.filter(f => f % 2 === 1)).toHaveLength(10);
    expect(chunks[1].floors).not.toContain(chat.length - 1);
    expect(chunks[1].from).toBe(chunks[0].to);
  });
  it('再装一条就超出字数上限时另起一批;从中间位置开始只排剩余部分', () => {
    const long = '长'.repeat(7000);
    const chat = [ai(long), ai(long), ai('短。')];
    const chunks = planRefileChunks(chat);
    expect(chunks.map(c => c.floors)).toEqual([[0], [1, 2]]);
    expect(planRefileChunks(chat, 1).map(c => c.floors)).toEqual([[1, 2]]);
  });
});

describe('第一步:找出漏记的角色', () => {
  const sources = [{ floor: 3, text: '男二走进教室，同桌林小雨抬头冲他笑了笑。林小雨扎着马尾，戴一副圆框眼镜。' },
    { floor: 5, text: '放学后，青梅竹马周晴在校门口等他。周晴今年十七岁，说话总是慢吞吞的。' }];
  const parse = (npcs: unknown[], known: string[] = ['洛伊', '酒保a']) => parseDiscoverReply(discoverReply(npcs), { sources, known: new Set(known), userName: '沈遥' });

  it('首次登场原句所在的楼层即首次登场楼层;档案字段各附原句', () => {
    const { found, rejected } = parse([zhouqing, xiaoyu]);
    expect(rejected).toBe(0);
    expect(found.map(f => [f.name, f.floor])).toEqual([['林小雨', 3], ['周晴', 5]]);
    expect(found[0].fields).toEqual({ title: '男二的同桌', desc: '扎着马尾，戴圆框眼镜' });
    expect(found[1].evidence.age).toEqual(['周晴今年十七岁']);
  });
  it('名册已有(含曾用名、标签)、主角本人、同一回复重复的、首次登场原句对不上的整条不收', () => {
    const { found, rejected } = parse([
      { ...xiaoyu, name: '洛伊' },
      { ...xiaoyu, name: '酒保A' },
      { ...xiaoyu, name: '沈遥' },
      { ...xiaoyu, name: 'user' },
      xiaoyu,
      { ...xiaoyu, appear: '林小雨跑出了教室。' },
      { ...zhouqing, appear: '' },
    ]);
    expect(found.map(f => f.name)).toEqual(['林小雨']);
    expect(rejected).toBe(6);
  });
  it('档案字段的原句对不上或超出长度上限时只丢这一项', () => {
    const { found, rejected } = parse([{ ...xiaoyu, desc: '长'.repeat(241), title: '男二的同桌', evidence: { title: '这句不在原文里', desc: '林小雨扎着马尾' } }]);
    expect(found[0].fields).toEqual({});
    expect(rejected).toBe(2);
  });
  it('一个字段可附几句原句,每句都要能在原文里找到', () => {
    const ok = parse([{ ...xiaoyu, evidence: { title: '同桌林小雨抬头冲他笑了笑', desc: ['林小雨扎着马尾', '戴一副圆框眼镜'] } }]);
    expect(ok.found[0].fields.desc).toBe('扎着马尾，戴圆框眼镜');
    const bad = parse([{ ...xiaoyu, evidence: { title: '同桌林小雨抬头冲他笑了笑', desc: ['林小雨扎着马尾', '穿着校服'] } }]);
    expect(bad.found[0].fields.desc).toBeUndefined();
  });
  it('结构不对时报格式错误', () => {
    expect(() => parseDiscoverReply('不是 JSON', { sources, known: new Set(), userName: '沈遥' })).toThrow(RefileReplyError);
    expect(() => parseDiscoverReply('{"people":[]}', { sources, known: new Set(), userName: '沈遥' })).toThrow(RefileReplyError);
  });
  it('请求带任务说明、内容边界(DeepSeek 不带)、名册、已用标签和带楼层号的原文', () => {
    const roster = [{ name: '洛伊', formerNames: ['少年A'], profile: { title: '沈遥的同伴' } }];
    const sent = buildDiscoverMessages(sources, roster, { user: '沈遥', char: '雾港来信', contentBoundary: true });
    const all = sent.map(m => m.content).join('\n');
    expect(all).toContain(RULE_CONTENT_BOUNDARY.split('\n')[0]);
    expect(all).toContain('主角 沈遥 本人');
    expect(all).toContain('- 洛伊;原记为 少年A;沈遥的同伴');
    expect(all).toContain('【已用的标签】少年A');
    expect(all).toContain('[#3] 男二走进教室');
    const plain = buildDiscoverMessages(sources, roster, { user: '沈遥', char: '雾港来信', contentBoundary: false }).map(m => m.content).join('\n');
    expect(plain).not.toContain(RULE_CONTENT_BOUNDARY.split('\n')[0]);
    expect(NPC_REFILE_PROMPT).toContain('第一步：补齐漏记');
    expect(NPC_REFILE_PROMPT).toContain('第二步：重做档案');
  });
});

describe('第二步:重做档案', () => {
  const target: ArchiveTarget = {
    name: '洛伊', formerNames: [], labelBase: '', profile: { title: '沈遥的同伴', desc: '高个子，穿灰外套' },
    excerpts: [{ floor: 1, text: '洛伊是个高个子的少年，总是眯着眼。' }, { floor: 7, text: '洛伊说他是旧街书店的学徒。' }],
  };
  const reply = (item: Record<string, unknown>) => JSON.stringify({ npcs: [{ name: '洛伊', ...item }] });

  it('改动的字段须附摘录原句;与当前档案相同的不算改动;只收五个档案字段', () => {
    const { changes, rejected } = parseArchiveReply(reply({
      title: '旧街书店的学徒', desc: '高个子少年，总是眯着眼', location: '旧街', relation: '朋友',
      evidence: { title: '洛伊说他是旧街书店的学徒。', desc: ['洛伊是个高个子的少年，总是眯着眼。'] },
    }), [target]);
    expect(rejected).toBe(0);
    expect(changes).toEqual([{ name: '洛伊', fields: {
      title: { old: '沈遥的同伴', value: '旧街书店的学徒', evidence: ['洛伊说他是旧街书店的学徒。'], floor: 7 },
      desc: { old: '高个子，穿灰外套', value: '高个子少年，总是眯着眼', evidence: ['洛伊是个高个子的少年，总是眯着眼。'], floor: 1 },
    } }]);
    expect(parseArchiveReply(reply({ title: '沈遥的同伴', evidence: { title: '洛伊说他是旧街书店的学徒。' } }), [target]).changes).toEqual([]);
  });
  it('原句对不上、没有原句或超出长度上限的字段不收;名单外的角色忽略', () => {
    const { changes, rejected } = parseArchiveReply(JSON.stringify({ npcs: [
      { name: '洛伊', title: '书店老板', evidence: { title: '洛伊开了一家书店。' } },
      { name: '洛伊', personality: '谨慎' },
      { name: '洛伊', desc: '高'.repeat(241), evidence: { desc: '洛伊是个高个子的少年，总是眯着眼。' } },
      { name: '梅芙', title: '药师', evidence: { title: '洛伊说他是旧街书店的学徒。' } },
    ] }), [target]);
    expect(changes).toEqual([]);
    expect(rejected).toBe(4);
  });
  it('摘录取较早的和较近的,多个角色共用的标签词不用来检索', () => {
    const chat: STMessage[] = [];
    for (let i = 0; i < 120; i++) chat.push(ai(i === 2 ? '洛伊在码头卸货。' : i === 118 ? '洛伊回到书店。' : `第${i}段。`));
    const excerpts = collectArchiveExcerpts(chat, ['洛伊'], chat.length);
    expect(excerpts.map(e => e.floor)).toEqual([2, 118]);
    const shared = sharedLabelBases([{ name: '酒保A', formerNames: [], profile: {} }, { name: '酒保B', formerNames: [], profile: {} }, { name: '守卫A', formerNames: [], profile: {} }]);
    expect([...shared]).toEqual(['酒保']);
  });
});

/** 按请求内容回复:找人请求按楼层回复对应的新角色,整理档案请求给洛伊改身份。 */
function mockReplies(opts: { archive?: (messages: { content: string }[]) => string } = {}) {
  return vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
    if (isDiscover(messages)) {
      const floors = floorsIn(messages);
      return discoverReply([...(floors.includes(3) ? [xiaoyu] : []), ...(floors.includes(5) ? [zhouqing] : [])]);
    }
    if (isArchive(messages)) {
      if (opts.archive) return opts.archive(messages);
      const names = [...(messages.at(-1)?.content ?? '').matchAll(/〔(.+?)〕/g)].map(m => m[1]);
      return JSON.stringify({ npcs: names.includes('洛伊') ? [{ name: '洛伊', title: '旧街书店的学徒', evidence: { title: '洛伊说他是旧街书店的学徒。' } }] : [] });
    }
    return discoverReply([]);
  });
}

describe('运行、审核与写入', () => {
  it('两步做完停在审核;新角色带首次登场楼层,洛伊的身份改动列为一项', async () => {
    const chat = sideStoryChat();
    const ctx = useChat(chat);
    mockReplies();
    expect(refileEstimate()).toMatchObject({ chunks: 1, characters: 1, archiveBatches: 1 });
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    const rec = readRefileRecord(ctx.chatMetadata as Record<string, unknown>)!;
    expect(rec.phase).toBe('review');
    expect(rec.archiveQueue).toEqual(['洛伊', '林小雨', '周晴']);
    const review = refileReview(rec);
    expect(review.added.map(a => [a.name, a.floor])).toEqual([['林小雨', 3], ['周晴', 5]]);
    expect(review.changes.map(c => [c.name, c.field, c.old, c.value])).toEqual([['洛伊', 'title', '沈遥的同伴', '旧街书店的学徒']]);
    // 记忆里还没有写入
    expect(memory.npcs.map(n => n.name)).toEqual(['洛伊']);
  });

  it('第二步包括主要角色和角色卡对应的角色', async () => {
    const chat = sideStoryChat();
    leafOf(chat[1]).delta = { npcs: { add: [{ name: '洛伊', title: '沈遥的同伴', important: true }] } };
    const ctx = useChat(chat);
    Object.assign(ctx, { name2: '洛伊' });
    mockReplies();
    expect(refileEstimate()).toMatchObject({ characters: 1 });
    await runNpcRefile();
    expect(readRefileRecord()!.archiveQueue).toEqual(['洛伊', '林小雨', '周晴']);
    expect(refileReview(readRefileRecord()!).changes.map(c => c.name)).toEqual(['洛伊']);
  });

  it('只写入勾选的项:新角色写到首次登场楼层的叶子上,档案改动写到最后出场那一楼,重新摘要后仍保留', async () => {
    const chat = sideStoryChat();
    const ctx = useChat(chat);
    mockReplies();
    await runNpcRefile();
    const lastFloorBefore = memory.npcs.find(n => n.name === '洛伊')!.lastFloor;
    expect(applyNpcRefile({ added: ['林小雨'], changes: [refileChangeKey('洛伊', 'title')] })).toEqual({ added: 1, updated: 1 });
    expect(memory.npcs.map(n => n.name).sort()).toEqual(['林小雨', '洛伊'].sort());
    expect(memory.npcs.find(n => n.name === '林小雨')).toMatchObject({ title: '男二的同桌', desc: '扎着马尾，戴圆框眼镜', firstFloor: 3 });
    expect(memory.npcs.find(n => n.name === '洛伊')).toMatchObject({ title: '旧街书店的学徒', lastFloor: lastFloorBefore });
    expect(leafOf(chat[3]).manualOps?.npcs?.add?.[0]).toMatchObject({ name: '林小雨' });
    expect(leafOf(chat[7]).manualOps?.npcs?.update?.[0]).toEqual({ name: '洛伊', title: '旧街书店的学徒' });
    expect(readRefileRecord(ctx.chatMetadata as Record<string, unknown>)).toBeNull();
    // 重新摘要换掉这两楼的模型结果:手动修改照常重放
    leafOf(chat[3]).delta = {};
    leafOf(chat[7]).delta = { npcs: { update: [{ name: '洛伊', title: '书店学徒' }] } };
    expect(deriveMemory(chat).npcs.find(n => n.name === '洛伊')?.title).toBe('旧街书店的学徒');
    expect(deriveMemory(chat).npcs.map(n => n.name)).toContain('林小雨');
  });

  it('年龄改动带原句所在楼层的故事时间作锚点;首次登场楼层没有有效叶子时写到之前最近的一条', async () => {
    const chat = sideStoryChat();
    delete chat[5].extra!.bbs_leaf;
    useChat(chat);
    mockReplies({ archive: () => JSON.stringify({ npcs: [{ name: '周晴', age: '十七', evidence: { age: '周晴今年十七岁' } }] }) });
    await runNpcRefile();
    expect(applyNpcRefile({ added: ['周晴'], changes: [] })).toEqual({ added: 1, updated: 0 });
    expect(leafOf(chat[3]).manualOps?.npcs?.add?.[0]).toMatchObject({ name: '周晴', age: '十七' });
    expect(memory.npcs.find(n => n.name === '周晴')).toMatchObject({ age: '十七', firstFloor: 3 });
  });

  it('已有角色的年龄改动按原句楼层的故事时间作锚点', async () => {
    const chat = sideStoryChat();
    leafOf(chat[5]).delta = { time: '2031/5/8 17:00', npcs: { add: [{ name: '周晴', title: '男二的青梅竹马' }] } };
    useChat(chat);
    mockReplies({ archive: messages => JSON.stringify({ npcs: (messages.at(-1)?.content ?? '').includes('〔周晴〕')
      ? [{ name: '周晴', age: '十七', evidence: { age: '周晴今年十七岁' } }] : [] }) });
    await runNpcRefile();
    const rec = readRefileRecord()!;
    const change = refileReview(rec).changes.find(c => c.name === '周晴')!;
    expect(change).toMatchObject({ field: 'age', value: '十七', floor: 5 });
    applyNpcRefile({ added: [], changes: [change.key] });
    expect(memory.npcs.find(n => n.name === '周晴')).toMatchObject({ age: '十七', ageTime: '2031/5/8 17:00' });
  });

  it('新角色的年龄采用第二步较晚的原句时,锚点取那一楼的故事时间,仍写在首次登场楼层', async () => {
    const chat = sideStoryChat();
    chat.push(user('一年后。'), ai('一年过去，周晴已经十八岁了。', { time: '2032/5/8 08:00' }));
    leafOf(chat[9]).timeEnd = '2032/5/8 08:00';
    useChat(chat);
    mockReplies({ archive: messages => JSON.stringify({ npcs: (messages.at(-1)?.content ?? '').includes('〔周晴〕')
      ? [{ name: '周晴', age: '十八岁', evidence: { age: '周晴已经十八岁了' } }] : [] }) });
    await runNpcRefile();
    const item = refileReview(readRefileRecord()!).added.find(a => a.name === '周晴')!;
    expect(item.fields.find(f => f.key === 'age')).toMatchObject({ value: '十八岁', floor: 9 });
    applyNpcRefile({ added: ['周晴'], changes: [] });
    expect(leafOf(chat[5]).manualOps?.npcs?.add?.[0]).toMatchObject({ name: '周晴', age: '十八岁', ageTime: '2032/5/8 08:00' });
    expect(memory.npcs.find(n => n.name === '周晴')).toMatchObject({ age: '十八岁', ageTime: '2032/5/8 08:00', firstFloor: 5 });
  });

  it('放弃时什么都不写,清掉记录', async () => {
    const chat = sideStoryChat();
    const ctx = useChat(chat);
    mockReplies();
    await runNpcRefile();
    discardNpcRefile();
    expect(ctx.chatMetadata[REFILE_RECORD_KEY]).toBeUndefined();
    expect(memory.npcs.map(n => n.name)).toEqual(['洛伊']);
    expect(chat.every(m => !(m.extra?.bbs_leaf as LeafExtra | undefined)?.manualOps)).toBe(true);
  });
});

describe('中断与继续', () => {
  function longChat(): STMessage[] {
    const chat = sideStoryChat();
    for (let i = 0; i < 12; i++) chat.push(user(`第${i}句。`), ai(`第${i}段，沈遥在旧街闲逛。`, {}));
    return chat;
  }

  it('取消后保留进度,继续时从停下的位置接着读,不重复已读的楼层', async () => {
    const chat = longChat();
    const ctx = useChat(chat);
    const seen: number[][] = [];
    mockReplies();
    const base = vi.mocked(client.requestViaMainApi).getMockImplementation()!;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (isDiscover(messages)) { seen.push(floorsIn(messages)); if (seen.length === 1) cancelNpcRefile(); }
      return base(messages);
    });
    expect(await runNpcRefile()).toEqual({ status: 'cancelled' });
    const rec = readRefileRecord(ctx.chatMetadata as Record<string, unknown>)!;
    expect(rec).toMatchObject({ phase: 'discover', discoverDone: 1 });
    expect(rec.found.map(f => f.name)).toEqual(['林小雨', '周晴']);
    expect(refileEstimate(rec).chunks).toBe(1);
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    expect(seen).toHaveLength(2);
    expect(Math.min(...seen[1])).toBeGreaterThan(Math.max(...seen[0]));
    // 第二批的名册里已经有第一批找到的角色
    const second = vi.mocked(client.requestViaMainApi).mock.calls.find(([m]) => isDiscover(m) && floorsIn(m).includes(seen[1][0]))![0];
    expect(second.at(-1)?.content).toContain('- 林小雨;男二的同桌');
  });

  it('回复格式不对时重试一次,仍不对就跳过这一批并记下楼层和原因;其余照常', async () => {
    const chat = sideStoryChat();
    const ctx = useChat(chat);
    mockReplies();
    const base = vi.mocked(client.requestViaMainApi).getMockImplementation()!;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => isDiscover(messages) ? '不是 JSON' : base(messages));
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    const rec = readRefileRecord(ctx.chatMetadata as Record<string, unknown>)!;
    expect(rec.skipped).toEqual([{ step: 'discover', label: '#0–#7', reason: '回复格式不对' }]);
    expect(vi.mocked(client.requestViaMainApi).mock.calls.filter(([m]) => isDiscover(m))).toHaveLength(2);
    expect(rec.found).toEqual([]);
  });

  it('回复被内容审核拦截时重试一次,仍被拦截就跳过这一批并写明原因', async () => {
    const ctx = useChat(sideStoryChat());
    mockReplies();
    const base = vi.mocked(client.requestViaMainApi).getMockImplementation()!;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (isArchive(messages)) throw apiFailure('filtered', '回复被内容审核拦截');
      return base(messages);
    });
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    const rec = readRefileRecord(ctx.chatMetadata as Record<string, unknown>)!;
    expect(rec.skipped).toEqual([{ step: 'archive', label: '洛伊、林小雨、周晴', reason: '被内容审核拦截' }]);
    expect(refileSkipText(rec.skipped[0])).toBe('整理洛伊、林小雨、周晴的档案（被内容审核拦截）');
    expect(rec.found.map(f => f.name)).toEqual(['林小雨', '周晴']);
  });

  it('连续 3 批没有可用的回复时停下,这几批不记为跳过,继续时重新请求', async () => {
    const chat = sideStoryChat();
    for (let i = 0; i < 30; i++) chat.push(user(`第${i}句。`), ai(`第${i}段，沈遥在旧街闲逛。`, {}));
    const ctx = useChat(chat);
    expect(planRefileChunks(chat)).toHaveLength(4);
    vi.mocked(client.requestViaMainApi).mockResolvedValue('不是 JSON');
    const stopped = await runNpcRefile();
    expect(stopped.status).toBe('error');
    expect(stopped.error).toContain('连续 3 批回复格式不对');
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(6);
    expect(readRefileRecord(ctx.chatMetadata as Record<string, unknown>)).toMatchObject({ phase: 'discover', nextIndex: 0, discoverDone: 0, skipped: [] });
    mockReplies();
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    const rec = readRefileRecord(ctx.chatMetadata as Record<string, unknown>)!;
    expect(rec.skipped).toEqual([]);
    expect(rec.found.map(f => f.name)).toEqual(['林小雨', '周晴']);
  });

  it('网络或服务商的临时失败重试一次,成功后照常继续', async () => {
    const ctx = useChat(sideStoryChat());
    mockReplies();
    vi.mocked(client.requestViaMainApi).mockRejectedValueOnce(apiFailure('server', '服务商出错（HTTP 502）'));
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    const rec = readRefileRecord(ctx.chatMetadata as Record<string, unknown>)!;
    expect(rec.skipped).toEqual([]);
    expect(rec.found.map(f => f.name)).toEqual(['林小雨', '周晴']);
  });

  it('请求失败时停下并记下原因,之后可以从同一位置继续', async () => {
    const chat = sideStoryChat();
    const ctx = useChat(chat);
    vi.mocked(client.requestViaMainApi).mockRejectedValueOnce(apiFailure('auth', '密钥无效', '请检查 API 密钥。'));
    const result = await runNpcRefile();
    expect(result.status).toBe('error');
    expect(result.error).toContain('密钥无效');
    expect(readRefileRecord(ctx.chatMetadata as Record<string, unknown>)).toMatchObject({ phase: 'discover', nextIndex: 0, error: expect.stringContaining('密钥无效') });
    mockReplies();
    expect(await runNpcRefile()).toEqual({ status: 'review' });
    expect(readRefileRecord(ctx.chatMetadata as Record<string, unknown>)?.error).toBeUndefined();
  });

  it('停下的原因不重复说明;接口以外的异常附上脱敏后的原文', async () => {
    useChat(sideStoryChat());
    const request = vi.mocked(client.requestViaMainApi);
    request.mockRejectedValue(apiFailure('unknown', '主 API 请求被中止', '正文生成被停止时会一并中止，重新发起即可。'));
    expect((await runNpcRefile()).error).toBe('主 API 请求被中止。正文生成被停止时会一并中止，重新发起即可。');
    request.mockRejectedValue(new Error('保存失败 sk-abcdefghijklmnop'));
    const second = (await runNpcRefile()).error ?? '';
    expect(second).toContain('角色重新建档没有完成（保存失败 sk-***）');
    expect(second).not.toContain('abcdefghijklmnop');
  });

  it('还没有摘要、或记忆处于受保护状态时不开始,也不写记录', async () => {
    useChat([user('你好。'), ai('你好。')]);
    expect((await runNpcRefile()).status).toBe('error');
    const ctx = useChat(sideStoryChat(), { [MEMORY_KEY]: { version: 999, summaries: [] } });
    loadMemory();
    expect(memoryWriteIssue()).not.toBe('');
    expect((await runNpcRefile()).status).toBe('error');
    expect(ctx.chatMetadata[REFILE_RECORD_KEY]).toBeUndefined();
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
  });
});
