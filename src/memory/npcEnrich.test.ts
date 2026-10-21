import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import { apiFailure } from '@/api/errors';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory } from './apply';
import { currentSummaryPromise, engineState, previewRegenerateFloor, applyFloorPreview, regenerateFloor, summarizeFloor } from './engine';
import {
  applyManualEnrichment, collectNpcExcerpts, ENRICH_RECORD_KEY, ENRICH_TIMEOUT_MS, parseEnrichReply, previewManualEnrichment, readEnrichRecord,
  type EnrichTarget,
} from './npcEnrich';
import { RULE_CONTENT_BOUNDARY } from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type StoredDelta, type SummaryDelta } from './types';

// 模拟请求:验证补档的取材、校验与写入口径,不代表真实模型的补全质量。
const saved = JSON.stringify(settings.apiSettings);
let seq = 0;
const ai = (mes: string, delta?: StoredDelta, extra: Record<string, unknown> = {}): STMessage => ({
  name: '雾港来信', is_user: false, is_system: false, mes,
  extra: { ...extra, ...(delta ? { bbs_leaf: { id: 'enrich-' + ++seq, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } as LeafExtra } : {}) },
});
const user = (mes: string): STMessage => ({ name: '沈遥', is_user: true, is_system: false, mes });
const hidden = (m: STMessage): STMessage => ({ ...m, is_system: true, extra: { ...m.extra, bbs_hidden: true } });
const response = (delta: SummaryDelta = {}) => JSON.stringify({ summary: '本楼发生的事。', ...delta, stateChanges: Object.keys(delta).filter(k => !['timeStart', 'timeEnd', 'time'].includes(k)) });
const isEnrich = (messages: { content: string }[]) => messages.some(m => m.content.includes('角色档案补全助手'));

function useChat(chat: STMessage[], chatMetadata: Record<string, unknown> = {}) {
  const ctx = { chat, chatMetadata, name1: '沈遥', name2: '雾港来信', getCurrentChatId: () => 'enrich-test',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}

/** #1 已隐藏的旧楼描写了酒保,#2 是番外楼,#4 本楼第一次把酒保记为「酒保A」。 */
function barChat(): STMessage[] {
  return [
    user('去港口的酒馆。'),
    hidden(ai('酒保是个留着络腮胡的胖子，他一边擦杯子一边打量来客。', { time: '2031/5/8 20:00' })),
    ai('番外：酒保其实是一只会说话的猫。', { time: '2031/5/8 20:10' }, { bbs_omit: true }),
    user('我问酒保要一杯麦酒。'),
    ai('酒保递来一杯麦酒，说今晚港口有雾。'),
  ];
}
const addBartender = response({ npcs: { add: [{ name: '酒保A', title: '酒馆酒保' }] } });
const enrichReply = (fields: Record<string, string>, evidence: Record<string, string>, name = '酒保A') => JSON.stringify({ npcs: [{ name, ...fields, evidence }] });

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100, npcEnrichAuto: true });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('回看原文:取材范围', () => {
  it('摘录包含已隐藏的楼层,不含番外楼,按楼层先后', () => {
    const chat = barChat();
    const excerpts = collectNpcExcerpts(chat, ['酒保A', '酒保'], { end: 4, maxChars: 1200, maxAiFloors: 40 });
    expect(excerpts.map(e => e.floor)).toEqual([1, 3]);
    expect(excerpts[0].text).toContain('络腮胡');
    expect(excerpts.map(e => e.text).join('')).not.toContain('猫');
  });
  it('只检索结束楼层之前最近若干个回复楼层,超出字数在句末截断', () => {
    const chat: STMessage[] = [];
    for (let i = 0; i < 6; i++) chat.push(ai(`第${i}楼:守卫站在门口。` + '他一言不发。'.repeat(i === 5 ? 80 : 1)));
    expect(collectNpcExcerpts(chat, ['守卫'], { end: 6, maxChars: 5000, maxAiFloors: 2 }).map(e => e.floor)).toEqual([4, 5]);
    const cut = collectNpcExcerpts(chat, ['守卫'], { end: 6, maxChars: 40 });
    expect(cut.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(40);
    expect(cut.every(e => /[。]$/.test(e.text))).toBe(true);
  });
  it('补档结果只收待补字段,证据须能在该角色的摘录中找到', () => {
    const target: EnrichTarget = { name: '酒保A', missing: ['gender', 'desc'], profile: { title: '酒馆酒保' }, labelBase: '酒保', terms: ['酒保'],
      excerpts: [{ floor: 1, text: '酒保是个留着络腮胡的胖子，他一边擦杯子一边打量来客。' }] };
    const parsed = parseEnrichReply(JSON.stringify({ npcs: [
      { name: '酒保A', gender: '男', desc: '络腮胡,体型胖', title: '老板', evidence: { gender: '他一边擦杯子', desc: '留着络腮胡的胖子', title: '酒保' } },
      { name: '别人', desc: '高个', evidence: { desc: '酒保' } },
    ] }), [target]);
    expect(parsed.get('酒保A')?.fields).toEqual({ gender: '男', desc: '络腮胡,体型胖' });
    const forged = parseEnrichReply(enrichReply({ desc: '金发碧眼' }, { desc: '他有一头金发' }), [target]);
    expect(forged.size).toBe(0);
    expect(() => parseEnrichReply('好的,我来补全。', [target])).toThrow();
  });
});

describe('回看原文:摘要时自动补档', () => {
  it('本楼新增的角色到更早原文中补外貌与性别,只写入本楼叶子的 enriched 并记下已补', async () => {
    const chat = barChat();
    const ctx = useChat(chat);
    const calls: string[] = [];
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => {
      if (isEnrich(messages)) {
        const text = messages.map(m => m.content).join('\n');
        calls.push('enrich');
        expect(text).toContain('[#1] 酒保是个留着络腮胡的胖子');
        expect(text).not.toContain('会说话的猫');
        expect(text).toContain('待补字段');
        expect(text).toContain(RULE_CONTENT_BOUNDARY);
        return enrichReply({ gender: '男', desc: '络腮胡,体型胖' }, { gender: '他一边擦杯子一边打量来客', desc: '留着络腮胡的胖子' });
      }
      calls.push('summary');
      return addBartender;
    });
    await summarizeFloor(4);
    expect(calls).toEqual(['summary', 'enrich']);
    expect(engineState.lastError).toBe('');
    const leaf = chat[4].extra!.bbs_leaf!;
    expect(leaf.delta.npcs?.add?.[0]).toMatchObject({ name: '酒保A', title: '酒馆酒保' });
    expect(leaf.delta.npcs?.add?.[0].desc).toBeUndefined();
    expect(leaf.enriched).toEqual([{ name: '酒保A', fields: { gender: '男', desc: '络腮胡,体型胖' }, source: 'auto' }]);
    expect(memory.npcs.find(n => n.name === '酒保A')).toMatchObject({ desc: '络腮胡,体型胖', gender: '男', title: '酒馆酒保' });
    expect(readEnrichRecord(ctx.chatMetadata as Record<string, unknown>).npcs['酒保a']).toMatchObject({ status: 'filled', floor: 4, fields: { desc: '络腮胡,体型胖' } });
  });

  it('补档只填空字段:已有外貌不被覆盖,也不会凭补档新建角色', () => {
    const first = ai('甲登场。', { npcs: { add: [{ name: '甲', desc: '黑发' }] } });
    const second = ai('甲又说话了。', {});
    second.extra!.bbs_leaf!.enriched = [{ name: '甲', fields: { desc: '金发', gender: '女' } }, { name: '不存在的人', fields: { desc: '高个' } }];
    const st = deriveMemory([first, second]);
    expect(st.npcs).toHaveLength(1);
    expect(st.npcs[0]).toMatchObject({ desc: '黑发', gender: '女' });
    // 补档在本楼 delta 之后施加:同楼摘要明确写了外貌时以摘要为准
    const third = ai('乙登场。', { npcs: { add: [{ name: '乙', desc: '短发' }] } });
    third.extra!.bbs_leaf!.enriched = [{ name: '乙', fields: { desc: '长发' } }];
    expect(deriveMemory([third]).npcs[0].desc).toBe('短发');
  });

  it('原文里没有更早的提及就不发补档请求,也不记录', async () => {
    const chat = [user('进酒馆。'), ai('守卫甲拦住了门口。')];
    const ctx = useChat(chat);
    const spy = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(response({ npcs: { add: [{ name: '守卫甲', title: '门卫' }] } }));
    await summarizeFloor(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chat[1].extra!.bbs_leaf!.enriched).toBeUndefined();
    expect((ctx.chatMetadata as Record<string, unknown>)[ENRICH_RECORD_KEY]).toBeUndefined();
  });

  it('补档请求失败不影响本楼摘要,只记失败;最多自动重试到两次', async () => {
    const chat = barChat();
    const ctx = useChat(chat);
    let enrichCalls = 0;
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => {
      if (isEnrich(messages)) { enrichCalls++; throw apiFailure('server', '服务暂时不可用'); }
      return addBartender;
    });
    await summarizeFloor(4);
    expect(engineState.lastError).toBe('');
    expect(chat[4].extra!.bbs_leaf!.delta.npcs?.add?.[0].name).toBe('酒保A');
    expect(chat[4].extra!.bbs_leaf!.enriched).toBeUndefined();
    const record = () => readEnrichRecord(ctx.chatMetadata as Record<string, unknown>).npcs['酒保a'];
    expect(record()).toMatchObject({ status: 'failed', attempts: 1 });
    // 之后的楼层再提到酒保:重试一次;再失败后不再自动请求
    for (const text of ['酒保又给沈遥添了酒。', '酒保打了个哈欠。']) {
      chat.push(user('继续喝酒。'), ai(text));
      recomputeDerived();
      vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
        if (isEnrich(messages)) { enrichCalls++; throw apiFailure('server', '服务暂时不可用'); }
        return response({ npcs: { update: [{ name: '酒保A', outfit: '围裙' }] } });
      });
      await summarizeFloor(chat.length - 1);
      expect(engineState.lastError).toBe('');
    }
    expect(enrichCalls).toBe(2);
    expect(record()).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('补档请求超时按失败记录,本楼摘要照常写入', async () => {
    const chat = barChat();
    const ctx = useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(messages => (isEnrich(messages) ? new Promise<string>(() => {}) : Promise.resolve(addBartender)));
    const run = summarizeFloor(4);
    await vi.advanceTimersByTimeAsync(ENRICH_TIMEOUT_MS + 100);
    await run;
    expect(engineState.lastError).toBe('');
    expect(chat[4].extra!.bbs_leaf!.delta.npcs?.add?.[0].name).toBe('酒保A');
    expect(readEnrichRecord(ctx.chatMetadata as Record<string, unknown>).npcs['酒保a']).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('补过(或确认原文没有内容)的角色不再自动请求', async () => {
    const chat = barChat();
    useChat(chat);
    let enrichCalls = 0;
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => {
      if (isEnrich(messages)) { enrichCalls++; return JSON.stringify({ npcs: [] }); }
      return addBartender;
    });
    await summarizeFloor(4);
    chat.push(user('再来一杯。'), ai('酒保又倒了一杯。'));
    recomputeDerived();
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (isEnrich(messages)) { enrichCalls++; return JSON.stringify({ npcs: [] }); }
      return response({ npcs: { update: [{ name: '酒保A', outfit: '围裙' }] } });
    });
    await summarizeFloor(6);
    expect(enrichCalls).toBe(1);
  });

  it('重新摘要沿用原叶子的补档结果,不再请求;先对比的预览不写入', async () => {
    const chat = barChat();
    const ctx = useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => (isEnrich(messages)
      ? enrichReply({ desc: '络腮胡,体型胖' }, { desc: '留着络腮胡的胖子' }) : addBartender));
    await summarizeFloor(4);
    const calls = () => vi.mocked(client.requestViaMainApi).mock.calls.filter(([m]) => isEnrich(m)).length;
    expect(calls()).toBe(1);
    expect(await regenerateFloor(4)).toBe(true);
    expect(calls()).toBe(1);
    expect(chat[4].extra!.bbs_leaf!.enriched?.[0].fields.desc).toBe('络腮胡,体型胖');
    const before = JSON.stringify(chat);
    const metaBefore = JSON.stringify(ctx.chatMetadata);
    const preview = await previewRegenerateFloor(4);
    expect(calls()).toBe(1);
    expect(JSON.stringify(chat)).toBe(before);
    expect(JSON.stringify(ctx.chatMetadata)).toBe(metaBefore);
    expect(await applyFloorPreview(preview!)).toBe(true);
    expect(chat[4].extra!.bbs_leaf!.enriched?.[0].fields.desc).toBe('络腮胡,体型胖');
    expect(deriveMemory(chat).npcs[0].desc).toBe('络腮胡,体型胖');
  });

  it('同一楼翻页后重新摘要时沿用记录里的补档结果,不重复请求', async () => {
    const chat = barChat();
    const ctx = useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => (isEnrich(messages)
      ? enrichReply({ desc: '络腮胡,体型胖' }, { desc: '留着络腮胡的胖子' }) : addBartender));
    await summarizeFloor(4);
    // 换到新的一页:旧页叶子失效,新页重新摘要
    chat[4].swipe_id = 1;
    chat[4].mes = '酒保推来一杯麦酒，没有多说话。';
    recomputeDerived();
    await summarizeFloor(4);
    expect(vi.mocked(client.requestViaMainApi).mock.calls.filter(([m]) => isEnrich(m))).toHaveLength(1);
    expect(chat[4].extra!.bbs_leaf!.enriched?.[0]).toMatchObject({ name: '酒保A', fields: { desc: '络腮胡,体型胖' } });
    expect(readEnrichRecord(ctx.chatMetadata as Record<string, unknown>).npcs['酒保a'].status).toBe('filled');
  });

  it('名册已有同职业的无名角色时,新标签不按职业词检索,不白发请求', async () => {
    const chat = barChat();
    chat[1] = hidden(ai('酒保是个留着络腮胡的胖子，他一边擦杯子一边打量来客。', { time: '2031/5/8 20:00', npcs: { add: [{ name: '酒保A', title: '酒保' }] } }));
    useChat(chat);
    const spy = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(response({ npcs: { add: [{ name: '酒保B', title: '新来的酒保' }] } }));
    await summarizeFloor(4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(memory.npcs.map(n => n.name)).toEqual(['酒保A', '酒保B']);
  });

  it('角色卡里的角色({{char}})不自动补档', async () => {
    const chat = [ai('雾港来信的信使站在门口。', {}), user('问信使是谁。'), ai('雾港来信笑了笑。')];
    useChat(chat);
    const spy = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(response({ npcs: { add: [{ name: '雾港来信', important: true }] } }));
    await summarizeFloor(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('DeepSeek 模型的补档请求不带内容边界,其他模型带', async () => {
    for (const [model, boundary] of [['deepseek-chat', false], ['gpt-x', true]] as const) {
      Object.assign(memory, createEmptyMemory());
      const chat = barChat();
      useChat(chat);
      vi.mocked(settings.getChannelForTask).mockReturnValue({ id: 'c', name: '测试渠道', model } as never);
      const spy = vi.spyOn(client, 'requestCompletion').mockImplementation(async (_channel, messages) => (isEnrich(messages)
        ? JSON.stringify({ npcs: [] }) : addBartender));
      await summarizeFloor(4);
      const enrich = spy.mock.calls.find(([, m]) => isEnrich(m))![1].map(m => m.content).join('\n');
      expect(enrich.includes('【内容边界')).toBe(boundary);
      spy.mockRestore();
    }
  });
});

describe('回看原文:角色页手动补全', () => {
  function seeded() {
    const chat = [
      ...barChat().slice(0, 4),
      ai('酒保递来一杯麦酒。', { npcs: { add: [{ name: '酒保A', title: '酒馆酒保' }] } }),
      user('我问酒保的名字。'),
      ai('酒保没回答。', {}),
    ];
    return chat;
  }
  it('检索全部楼层,确认后写进最新一条摘要并记下;只填空字段', async () => {
    const chat = seeded();
    const ctx = useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => {
      const text = messages.map(m => m.content).join('\n');
      expect(text).toContain('络腮胡');
      expect(text).toContain('[#5] 我问酒保的名字。');
      return enrichReply({ gender: '男', desc: '络腮胡,体型胖', title: '老板' }, { gender: '他一边擦杯子一边打量来客', desc: '留着络腮胡的胖子', title: '酒保' });
    });
    const result = await previewManualEnrichment('酒保A');
    expect(result.status).toBe('ok');
    expect(result.fields).toEqual({ gender: '男', desc: '络腮胡,体型胖' });
    expect(result.evidence.desc).toBe('留着络腮胡的胖子');
    // 预览不写入
    expect(chat[6].extra!.bbs_leaf!.enriched).toBeUndefined();
    expect(applyManualEnrichment('酒保A', result.fields)).toBe(true);
    expect(chat[6].extra!.bbs_leaf!.enriched).toEqual([{ name: '酒保A', fields: { gender: '男', desc: '络腮胡,体型胖' }, source: 'manual' }]);
    expect(memory.npcs[0]).toMatchObject({ title: '酒馆酒保', gender: '男', desc: '络腮胡,体型胖' });
    expect(readEnrichRecord(ctx.chatMetadata as Record<string, unknown>).npcs['酒保a']).toMatchObject({ status: 'filled', floor: 6 });
  });
  it('原文没有可补内容、档案已完整、请求失败分别给出结果,失败写明原因与设置位置', async () => {
    const chat = seeded();
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ npcs: [] }));
    expect((await previewManualEnrichment('酒保A')).status).toBe('empty');
    vi.mocked(client.requestViaMainApi).mockRejectedValue(apiFailure('auth', '密钥无效', '请检查该 API 的密钥。'));
    const failed = await previewManualEnrichment('酒保A');
    expect(failed.status).toBe('error');
    expect(failed.error?.title).toBe('密钥无效');
    expect(failed.error?.hint).toContain('酒馆的主 API 设置');
    vi.mocked(client.requestViaMainApi).mockResolvedValue('我不确定。');
    const garbled = await previewManualEnrichment('酒保A');
    expect(garbled.status).toBe('error');
    expect(garbled.error?.message).toContain('没有按要求输出');
    chat[4].extra!.bbs_leaf!.delta = { npcs: { add: [{ name: '酒保A', title: '酒保', desc: '胖', gender: '男', age: '40', personality: '寡言' }] } };
    recomputeDerived();
    expect((await previewManualEnrichment('酒保A')).status).toBe('complete');
  });
  it('写入记在最新叶子:重新摘要该叶子后仍保留', async () => {
    const chat = seeded();
    useChat(chat);
    expect(applyManualEnrichment('酒保A', { desc: '络腮胡' })).toBe(true);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(response());
    expect(await regenerateFloor(6)).toBe(true);
    expect(chat[6].extra!.bbs_leaf!.enriched?.[0]).toMatchObject({ name: '酒保A', fields: { desc: '络腮胡' } });
    expect(memory.npcs[0].desc).toBe('络腮胡');
  });
});

describe('回看原文:设置开关', () => {
  const enrichCalls = () => vi.mocked(client.requestViaMainApi).mock.calls.filter(([m]) => isEnrich(m)).length;

  it('关闭后摘要时不检索、不发补档请求,也不记录;重新打开后照常补', async () => {
    settings.apiSettings.npcEnrichAuto = false;
    const chat = barChat();
    const ctx = useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => (isEnrich(messages)
      ? enrichReply({ desc: '络腮胡,体型胖' }, { desc: '留着络腮胡的胖子' }) : addBartender));
    await summarizeFloor(4);
    expect(vi.mocked(client.requestViaMainApi)).toHaveBeenCalledTimes(1);
    expect(enrichCalls()).toBe(0);
    expect(engineState.lastError).toBe('');
    expect(chat[4].extra!.bbs_leaf!.delta.npcs?.add?.[0].name).toBe('酒保A');
    expect(chat[4].extra!.bbs_leaf!.enriched).toBeUndefined();
    expect(memory.npcs.find(n => n.name === '酒保A')?.desc).toBeFalsy();
    expect((ctx.chatMetadata as Record<string, unknown>)[ENRICH_RECORD_KEY]).toBeUndefined();
    // 关闭期间没有留下「已补」或「失败」记录:重新打开后,之后的楼层提到该角色时照常补
    settings.apiSettings.npcEnrichAuto = true;
    chat.push(user('继续喝酒。'), ai('酒保又给沈遥添了酒。'));
    recomputeDerived();
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => (isEnrich(messages)
      ? enrichReply({ desc: '络腮胡,体型胖' }, { desc: '留着络腮胡的胖子' }) : response({ npcs: { update: [{ name: '酒保A', outfit: '围裙' }] } })));
    await summarizeFloor(6);
    expect(enrichCalls()).toBe(1);
    expect(memory.npcs.find(n => n.name === '酒保A')?.desc).toBe('络腮胡,体型胖');
  });

  it('关闭后已补全的内容保持不变:重新摘要和同楼翻页沿用已有结果,不发补档请求', async () => {
    const chat = barChat();
    const ctx = useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockImplementation(async messages => (isEnrich(messages)
      ? enrichReply({ desc: '络腮胡,体型胖' }, { desc: '留着络腮胡的胖子' }) : addBartender));
    await summarizeFloor(4);
    expect(enrichCalls()).toBe(1);
    settings.apiSettings.npcEnrichAuto = false;
    expect(await regenerateFloor(4)).toBe(true);
    expect(chat[4].extra!.bbs_leaf!.enriched?.[0].fields.desc).toBe('络腮胡,体型胖');
    chat[4].swipe_id = 1;
    chat[4].mes = '酒保推来一杯麦酒，没有多说话。';
    recomputeDerived();
    await summarizeFloor(4);
    expect(enrichCalls()).toBe(1);
    expect(chat[4].extra!.bbs_leaf!.enriched?.[0]).toMatchObject({ name: '酒保A', fields: { desc: '络腮胡,体型胖' } });
    expect(memory.npcs.find(n => n.name === '酒保A')?.desc).toBe('络腮胡,体型胖');
    expect(readEnrichRecord(ctx.chatMetadata as Record<string, unknown>).npcs['酒保a'].status).toBe('filled');
  });

  it('关闭期间角色卡上的「从原文补全」照常可用', async () => {
    settings.apiSettings.npcEnrichAuto = false;
    const chat = [...barChat().slice(0, 4), ai('酒保递来一杯麦酒。', { npcs: { add: [{ name: '酒保A', title: '酒馆酒保' }] } })];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(
      enrichReply({ gender: '男', desc: '络腮胡,体型胖' }, { gender: '他一边擦杯子一边打量来客', desc: '留着络腮胡的胖子' }));
    const result = await previewManualEnrichment('酒保A');
    expect(result.status).toBe('ok');
    expect(enrichCalls()).toBe(1);
    expect(applyManualEnrichment('酒保A', result.fields)).toBe(true);
    expect(chat[4].extra!.bbs_leaf!.enriched).toEqual([{ name: '酒保A', fields: { gender: '男', desc: '络腮胡,体型胖' }, source: 'manual' }]);
    expect(memory.npcs[0]).toMatchObject({ title: '酒馆酒保', gender: '男', desc: '络腮胡,体型胖' });
  });

  it('旧设置没有这个字段(或值不是布尔)时按开启处理,明确关闭的保持关闭', () => {
    expect(settings.normalizeApiSettings(null).npcEnrichAuto).toBe(true);
    expect(settings.normalizeApiSettings({ keepRecent: 3 }).npcEnrichAuto).toBe(true);
    expect(settings.normalizeApiSettings({ npcEnrichAuto: 'false' }).npcEnrichAuto).toBe(true);
    expect(settings.normalizeApiSettings({ npcEnrichAuto: false }).npcEnrichAuto).toBe(false);
  });
});
