import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { addKnowledge, deriveMemory, editNpc, finalizeDelta, MANUAL_ADD_BASE, relocateManualOps, removeKnowledge, updateKnowledge } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { applyFloorPreview, currentSummaryPromise, previewRegenerateFloor, summarizeFloor } from './engine';
import * as inject from './inject';
import {
  applyKnowledgeOps, cleanKnowledgeOps, fmtKnowledgeForSummary, fmtKnowledgeInjection, KNOWLEDGE_INJECT_CAP, knowledgeId, selectKnowledgeForSummary,
} from './knowledge';
import { buildSummaryPrompt, buildSummaryThinking, RULE_KNOWLEDGE, SUMMARY_PROMPT } from './prompts';
import { memory, recomputeDerived } from './store';
import { describeDropped, parseSummaryResponse, SummaryResponseError, type DroppedEvidence } from './summaryResponse';
import { createEmptyMemory, type LeafExtra, type MemKnowledge, type StoredDelta, type SummaryDelta } from './types';

// 了解清单:固化、重放、手动修改、带数据新建对话、提示词与注入。模型回复都是本地 mock,不代表真实模型的输出。
const original = {
  injection: { ...settings.apiSettings.injection },
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}, mes = '林舟和艾琳在客栈里说话。'): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes,
  extra: { bbs_leaf: { id: `know-${++seq}`, text: '客栈对话', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const leafOf = (m: STMessage) => m.extra!.bbs_leaf as LeafExtra;
const leafId = (m: STMessage) => leafOf(m).id;
const entry = (subject: string, text: string, i = 0): MemKnowledge => ({ id: `know:t#${i}`, subject, text, createdAt: 1 });
function useChat(chat: STMessage[]) {
  const ctx = {
    chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'know-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
/** 模拟重抽:新页沿用旧页 extra 的副本(叶子页码仍是旧页),旧页存进 swipe_info。 */
function reroll(m: STMessage): void {
  const copy = JSON.parse(JSON.stringify(m.extra));
  (m as unknown as { swipe_info: unknown[] }).swipe_info = [{ extra: copy }, { extra: JSON.parse(JSON.stringify(copy)) }];
  m.swipe_id = 1;
  m.extra = JSON.parse(JSON.stringify(copy));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.knowledge = true;
  settings.apiSettings.prompts.summary = '';
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('了解清单:模型输出的固化', () => {
  it('k 序号翻成稳定 id;先改、删旧条再加新条;本楼新登场和改名后的角色可记,旧名按新名字记', () => {
    const shown = [{ id: 'know:a#0' }, { id: 'know:a#1' }];
    const stored = finalizeDelta({
      npcs: { add: [{ name: '小夏' }], rename: [{ from: '酒保A', to: '老周' }] },
      knowledge: {
        add: [
          { who: ' 艾琳 ', text: '认定主角是行商' }, { who: '小夏', text: '听说主角会医术' }, { who: '酒保A', text: '知道主角叫林舟' },
          { who: '林舟', text: '主角本人不记' }, { who: '路人', text: '名册外不记' }, { who: '艾琳', text: ' ' },
        ],
        update: [{ id: 'k2', text: '得知主角其实是王子' }, { id: 'k9', text: '编号不存在' }, { id: 'know:a#0', text: '不认稳定 id' }],
        remove: ['k1', 'kx'],
      },
    } as SummaryDelta, [], [], [], { shown, roster: ['艾琳', '酒保A'], userName: '林舟' });
    expect(stored.knowledge).toEqual([
      { op: 'update', id: 'know:a#1', text: '得知主角其实是王子' },
      { op: 'remove', id: 'know:a#0' },
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'add', subject: '小夏', text: '听说主角会医术' },
      { op: 'add', subject: '老周', text: '知道主角叫林舟' },
    ]);
  });

  it('不给上下文(功能关闭)时模型输出一律不收', () => {
    const raw = { knowledge: { add: [{ who: '艾琳', text: '认定主角是行商' }] } } as SummaryDelta;
    expect(finalizeDelta(raw, [], [], []).knowledge).toBeUndefined();
  });
});

describe('了解清单:存储与重放', () => {
  it('清洗存储日志:保持顺序,丢掉缺字段的操作,只保留插件格式的显式 id', () => {
    expect(cleanKnowledgeOps([
      { op: 'add', subject: ' 艾琳 ', text: ' 认定主角是行商 ', id: 'know:L#10000' },
      { op: 'add', subject: '艾琳', text: 'B', id: '乱写' },
      { op: 'add', subject: '', text: 'x' },
      { op: 'update', id: 'know:a#0' },
      { op: 'update', id: 'know:a#0', text: '改' },
      { op: 'remove' }, 'junk',
      { op: 'remove', id: 'know:a#1' },
    ])).toEqual([
      { op: 'add', subject: '艾琳', text: '认定主角是行商', id: 'know:L#10000' },
      { op: 'add', subject: '艾琳', text: 'B' },
      { op: 'update', id: 'know:a#0', text: '改' },
      { op: 'remove', id: 'know:a#1' },
    ]);
  });

  it('同角色同义去重,不同角色各记各的;id 只按 add 的先后编号,改写或删除不占序号', () => {
    const list: MemKnowledge[] = [];
    applyKnowledgeOps(list, [
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'add', subject: '艾琳', text: '认定主角是行商。' },
      { op: 'add', subject: '小夏', text: '认定主角是行商' },
    ], { id: 'L1', createdAt: 1, time: '第一天' });
    expect(list.map(k => [k.id, k.subject, k.createdTime])).toEqual([['know:L1#0', '艾琳', '第一天'], ['know:L1#2', '小夏', '第一天']]);
    // 删了再加回、改到和别条同一句:都按日志顺序施加
    applyKnowledgeOps(list, [
      { op: 'remove', id: 'know:L1#0' },
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'update', id: 'know:L1#2', subject: '艾琳' },
    ], { id: 'L2', createdAt: 2, time: '' });
    expect(list.map(k => [k.id, k.subject])).toEqual([['know:L2#0', '艾琳']]);
  });

  it('重放幂等,截止点不泄漏后面的楼层;没有这个字段的旧叶子照常重放', () => {
    const first = message({ knowledge: [{ op: 'add', subject: '艾琳', text: 'A' }, { op: 'add', subject: '艾琳', text: 'B' }] });
    const [a, b] = [0, 1].map(i => knowledgeId(leafId(first), i));
    const second = message({ knowledge: [{ op: 'update', id: a, text: 'A2' }, { op: 'remove', id: b }] });
    const chat = [first, second];
    expect(deriveMemory(chat).knowledge.map(k => [k.id, k.text])).toEqual([[a, 'A2']]);
    expect(deriveMemory(JSON.parse(JSON.stringify(chat))).knowledge).toEqual(deriveMemory(chat).knowledge);
    expect(deriveMemory(chat, 1).knowledge.map(k => k.text)).toEqual(['A', 'B']);
    expect(deriveMemory([message({ npcs: { add: [{ name: '艾琳' }] } })]).knowledge).toEqual([]);
  });

  it('改写过的条目挪到末尾:注入只发每人最近几条时,被纠正的认知不会被截掉', () => {
    const first = message({ knowledge: [
      { op: 'add', subject: '艾琳', text: '认定主角是行商' }, { op: 'add', subject: '艾琳', text: 'B' }, { op: 'add', subject: '艾琳', text: 'C' },
    ] });
    const second = message({ knowledge: [{ op: 'update', id: knowledgeId(leafId(first), 0), text: '得知主角其实是王子' }] });
    const list = deriveMemory([first, second]).knowledge;
    expect(list.map(k => k.text)).toEqual(['B', 'C', '得知主角其实是王子']);
    expect(fmtKnowledgeInjection(list, ['艾琳'], '林舟', 2)).toContain('艾琳:(另有 1 条较早的从略)\n- C\n- 得知主角其实是王子');
  });

  it('手动增改删写进最新叶子的手动修改,带显式 id;重新摘要换掉模型结果后仍然生效', () => {
    const chat = [message({ npcs: { add: [{ name: '艾琳', important: true }] } }), message()];
    useChat(chat);
    expect(addKnowledge('艾琳', ' 认定林舟是行商 ')).toBe(true);
    const id = memory.knowledge[0].id;
    expect(id).toBe(`know:${leafId(chat[1])}#${MANUAL_ADD_BASE}`);
    expect(leafOf(chat[1]).manualOps?.knowledge).toEqual([{ op: 'add', subject: '艾琳', text: '认定林舟是行商', id }]);
    expect(leafOf(chat[1]).delta.knowledge).toBeUndefined();
    expect(updateKnowledge(id, '得知林舟其实是王子')).toBe(true);
    expect(memory.knowledge[0]).toMatchObject({ id, subject: '艾琳', text: '得知林舟其实是王子' });
    leafOf(chat[1]).delta = { npcs: { update: [{ name: '艾琳', outfit: '雨衣' }] } };
    recomputeDerived();
    expect(memory.knowledge[0]).toMatchObject({ id, text: '得知林舟其实是王子' });
    expect(addKnowledge('艾琳', '  ')).toBe(false);
    expect(updateKnowledge(id, ' ')).toBe(false);
    expect(removeKnowledge(id)).toBe(true);
    expect(memory.knowledge).toEqual([]);
    // 删了再手动加回:分到新的显式 id,不与删掉的那条撞号
    expect(addKnowledge('艾琳', '认定林舟是行商')).toBe(true);
    expect(memory.knowledge[0].id).toBe(`know:${leafId(chat[1])}#${MANUAL_ADD_BASE + 1}`);
  });

  it('叶子失效时手动修改移到前一条有效叶子,条目 id 不变,之后的改写仍然有效', () => {
    const first = message({ npcs: { add: [{ name: '艾琳', important: true }] } });
    const last = message();
    const chat = [first, last];
    useChat(chat);
    expect(addKnowledge('艾琳', '认定林舟是行商')).toBe(true);
    const id = memory.knowledge[0].id;
    reroll(last);
    expect(relocateManualOps(chat)).toBe(true);
    recomputeDerived();
    expect(leafOf(first).manualOps?.knowledge?.[0]).toMatchObject({ op: 'add', id });
    expect(leafOf(last).manualOps).toBeUndefined();
    expect(memory.knowledge.map(k => k.id)).toEqual([id]);
    expect(updateKnowledge(id, '得知林舟其实是王子')).toBe(true);
    expect(memory.knowledge[0]).toMatchObject({ id, text: '得知林舟其实是王子' });
  });

  it('手动改名和摘要里的改名接续,条目都跟着角色走;删除角色时条目保留', () => {
    const chat = [message({
      npcs: { add: [{ name: '艾琳', important: true }, { name: '酒保A' }] },
      knowledge: [{ op: 'add', subject: '艾琳', text: '认定林舟是行商' }, { op: 'add', subject: '酒保A', text: '听说林舟会医术' }],
    })];
    useChat(chat);
    expect(editNpc('艾琳', { name: '艾莉' })).toBe(true);
    expect(memory.knowledge.find(k => k.text === '认定林舟是行商')?.subject).toBe('艾莉');
    chat.push(message({ npcs: { rename: [{ from: '酒保A', to: '老周' }] } }));
    recomputeDerived();
    expect(memory.knowledge.find(k => k.text === '听说林舟会医术')?.subject).toBe('老周');
    chat.push(message({ npcs: { remove: ['老周'] } }));
    recomputeDerived();
    expect(memory.npcs.map(n => n.name)).toEqual(['艾莉']);
    expect(memory.knowledge.map(k => k.subject)).toContain('老周');
  });

  it('带数据新建对话:清单全量带进种子叶,窗口内的改写和删除跟着换 id;功能关闭时同样带走', async () => {
    settings.apiSettings.injection.knowledge = false;
    settings.apiSettings.keepRecent = 1;
    const first = message({ npcs: { add: [{ name: '艾琳', important: true }] },
      knowledge: [{ op: 'add', subject: '艾琳', text: 'A' }, { op: 'add', subject: '艾琳', text: 'B' }] });
    const [a, b] = [0, 1].map(i => knowledgeId(leafId(first), i));
    const last = message({ knowledge: [{ op: 'update', id: a, text: 'A2' }, { op: 'remove', id: b }, { op: 'add', subject: '艾琳', text: 'C' }] });
    const chat = [first, message(), last];
    const source = useChat(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'know-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(leafOf(target.chat[0]).delta.knowledge).toEqual([{ op: 'add', subject: '艾琳', text: 'A' }, { op: 'add', subject: '艾琳', text: 'B' }]);
    expect(deriveMemory(target.chat).knowledge.map(k => k.text)).toEqual(['A2', 'C']);
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['A2', 'C']);
  });
});

describe('了解清单:摘要请求与解析', () => {
  const args: Parameters<typeof buildSummaryPrompt>[0] = {
    user: '林舟', char: '艾琳', time: '', location: '', protagonist: {}, sceneFocus: null,
    lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [{ name: '艾琳', important: true }],
    openPlans: [], resolvedPlans: [], history: '', content: '说话', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
  };
  const shown = [entry('艾琳', '认定主角是行商'), entry('小夏', '听说主角会医术', 1)];

  it('材料按角色分组,编号全局连续;只附给定角色', () => {
    const list = [entry('小夏', 'X'), entry('艾琳', 'Y', 1), entry('路人', 'Z', 2)];
    expect(selectKnowledgeForSummary(list, ['艾琳', '小夏', '艾琳']).map(k => k.text)).toEqual(['Y', 'X']);
    expect(fmtKnowledgeForSummary(shown)).toBe('  艾琳:\n    k1. 认定主角是行商\n  小夏:\n    k2. 听说主角会医术');
    expect(fmtKnowledgeForSummary([])).toBe('  (无)');
  });

  it('内置模板:关闭时没有任何相关文字;开启时带规则、输出字段、清单、stateChanges 字段名和核查项', () => {
    const off = buildSummaryPrompt(args);
    const on = buildSummaryPrompt({ ...args, knowledge: shown });
    for (const p of [off, on]) expect(`${p.system}${p.user}`).not.toMatch(/\{\{\w+\}\}/);
    expect(`${off.system}${off.user}`).not.toMatch(/knowledge|了解清单|对主角的了解/);
    expect(buildSummaryThinking('林舟').checklist).not.toMatch(/knowledge|了解清单/);
    expect(on.system).toContain('【了解清单规则】');
    expect(on.system).toContain('"knowledge": {');
    expect(on.system).toContain('"lifeDetails", "knowledge", "vars"');
    expect(on.system).toContain('secrets、lifeDetails、knowledge、vars');
    expect(on.system).toContain('【信息差规则】记'); // 分工里引用信息差规则
    expect(on.user).toContain('- 角色对主角的了解(相关角色已记下的认知,用编号 k1、k2… 指代');
    expect(on.user).toContain('k1. 认定主角是行商');
    expect(on.user).toContain('k2. 听说主角会医术');
    expect(buildSummaryThinking('林舟', true).checklist).toMatch(/\n6\. 了解清单只记角色本楼亲耳听到/);
    // 内置模板文本本身只多了几个宏占位,关闭时展开为空
    expect(SUMMARY_PROMPT).toContain('{{knowledge_rule}}');
  });

  it('自定义模板:开启时补兼容协议和清单材料,关闭时不补', () => {
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const on = buildSummaryPrompt({ ...args, knowledge: shown });
    expect(on.system).toContain('【棱镜宝书了解清单兼容协议】');
    expect(on.system).toContain(RULE_KNOWLEDGE);
    expect(on.user).toContain('k1. 认定主角是行商');
    const off = buildSummaryPrompt(args);
    expect(`${off.system}${off.user}`).not.toMatch(/knowledge|了解清单/);
  });

  const parseK = (data: object, lenient = false) => {
    const dropped: DroppedEvidence[] = [];
    const d = parseSummaryResponse(JSON.stringify({ summary: '对话。', ...data }), {
      requireStateChanges: true, npcRoster: ['艾琳'], userName: '林舟',
      finalize: v => finalizeDelta(v, [], [], [], { shown: [{ id: 'know:a#0' }], roster: ['艾琳'], userName: '林舟' }),
      knowledge: { shown: 1 },
      ...(lenient ? { onDroppedEvidence: (list: DroppedEvidence[]) => { dropped.push(...list); } } : {}),
    });
    return { d, dropped };
  };

  it('编号不存在、主角本人、名册外的条目:前几次附原因重试,最后一次只去掉这几条并报告', () => {
    const body = { stateChanges: ['knowledge'], knowledge: {
      add: [{ who: '艾琳', text: '认定林舟是行商' }, { who: '林舟', text: '主角自己' }, { who: '路人', text: '名册外' }],
      update: [{ id: 'k3', text: '编号不存在' }],
    } };
    expect(() => parseK(body)).toThrow(SummaryResponseError);
    for (const why of ['了解清单含无效条目', 'knowledge.update[0]', '当前可用 k1–k1', '「林舟」是主角本人', '「路人」不在角色名册中']) {
      expect(() => parseK(body)).toThrow(why);
    }
    const { d, dropped } = parseK(body, true);
    expect(d.knowledge).toEqual({ add: [{ who: '艾琳', text: '认定林舟是行商' }] });
    expect(dropped.map(x => [x.kind, x.reason])).toEqual([['knowledge', 'invalid'], ['knowledge', 'invalid'], ['knowledge', 'invalid']]);
    expect(describeDropped(dropped[2]).what).toBe('了解清单「k3」');
  });

  it('有效输出要写进 stateChanges;本楼新登场的角色可以直接记', () => {
    const fresh = { npcs: { add: [{ name: '小夏', title: '药铺学徒' }] }, knowledge: { add: [{ who: '小夏', text: '听说林舟会医术' }] } };
    expect(() => parseK({ ...fresh, stateChanges: ['npcs'] })).toThrow(/knowledge 有更新，但没写进清单/);
    expect(parseK({ ...fresh, stateChanges: ['npcs', 'knowledge'] }).d.knowledge).toEqual({ add: [{ who: '小夏', text: '听说林舟会医术' }] });
  });

  it('功能关闭时模型硬给的 knowledge 和清单里的字段名一并去掉,不让整楼失败', () => {
    const d = parseSummaryResponse(JSON.stringify({ summary: '对话。', stateChanges: ['knowledge'], knowledge: { add: [{ who: '艾琳', text: 'x' }] } }), {
      requireStateChanges: true, npcRoster: ['艾琳'], finalize: v => finalizeDelta(v, []),
    });
    expect(d).not.toHaveProperty('knowledge');
    expect((d as { stateChanges?: unknown }).stateChanges).toEqual([]);
  });
});

describe('了解清单:实际摘要接线(本地 mock 模型回复)', () => {
  const setup = () => {
    const second = message({}, '林舟向艾琳坦白自己其实是王子,并报上了名字。');
    delete second.extra!.bbs_leaf;
    const chat = [message({ npcs: { add: [{ name: '艾琳', important: true }] }, knowledge: [{ op: 'add', subject: '艾琳', text: '认定林舟是行商' }] }), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '林舟向艾琳坦白自己其实是王子,并报上了名字。', stateChanges: ['knowledge'], timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      knowledge: { update: [{ id: 'k1', text: '得知林舟其实是王子,此前一直被瞒' }], add: [{ who: '艾琳', text: '知道主角名叫林舟' }] },
    }));
    return chat;
  };
  const requestText = () => vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');

  it('开启:请求带规则与清单,k1 落成稳定 id,重放后得到改写和新增的认知', async () => {
    const chat = setup();
    await summarizeFloor(1);
    expect(requestText()).toContain('【了解清单规则】');
    expect(requestText()).toContain('k1. 认定林舟是行商');
    expect(requestText()).toContain('6. 了解清单只记');
    expect(leafOf(chat[1]).delta.knowledge).toEqual([
      { op: 'update', id: knowledgeId(leafId(chat[0]), 0), text: '得知林舟其实是王子,此前一直被瞒' },
      { op: 'add', subject: '艾琳', text: '知道主角名叫林舟' },
    ]);
    expect(memory.knowledge.map(k => k.text)).toEqual(['得知林舟其实是王子,此前一直被瞒', '知道主角名叫林舟']);
  });

  it('关闭:请求里没有任何相关文字,模型硬给也不收,已有清单保留', async () => {
    settings.apiSettings.injection.knowledge = false;
    const chat = setup();
    await summarizeFloor(1);
    expect(requestText()).not.toMatch(/knowledge|了解清单|认定林舟是行商/);
    expect(leafOf(chat[1]).text).toBe('林舟向艾琳坦白自己其实是王子,并报上了名字。');
    expect(leafOf(chat[1]).delta.knowledge).toBeUndefined();
    expect(memory.knowledge.map(k => k.text)).toEqual(['认定林舟是行商']);
  });

  it('重新摘要先对比:预览按请求时的编号固化,选用后写入;预览期间关掉开关不影响这份结果', async () => {
    const chat = setup();
    await summarizeFloor(1);
    const preview = await previewRegenerateFloor(1);
    const expected = [
      { op: 'update', id: knowledgeId(leafId(chat[0]), 0), text: '得知林舟其实是王子,此前一直被瞒' },
      { op: 'add', subject: '艾琳', text: '知道主角名叫林舟' },
    ];
    expect(preview?.next.delta.knowledge).toEqual(expected);
    settings.apiSettings.injection.knowledge = false;
    expect(await applyFloorPreview(preview!)).toBe(true);
    expect(leafOf(chat[1]).delta.knowledge).toEqual(expected);
  });

  it('材料只附相关角色:主要角色、在场或同区域、本楼正文提到的;单字名不算提到', async () => {
    const second = message({}, '林舟和小夏在客栈里说话。');
    delete second.extra!.bbs_leaf;
    useChat([message({
      npcs: { add: [{ name: '艾琳', important: true }, { name: '小夏' }, { name: '舟' }, { name: '远方客' }] },
      knowledge: [
        { op: 'add', subject: '艾琳', text: '认定林舟是行商' }, { op: 'add', subject: '小夏', text: '听说林舟会医术' },
        { op: 'add', subject: '舟', text: '听说林舟是渔夫' }, { op: 'add', subject: '远方客', text: '听说林舟去过北境' },
      ],
    }), second]);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '林舟和小夏闲聊。', stateChanges: [], timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
    }));
    await summarizeFloor(1);
    expect(requestText()).toContain('k1. 认定林舟是行商');
    expect(requestText()).toContain('k2. 听说林舟会医术');
    expect(requestText()).not.toMatch(/听说林舟是渔夫|听说林舟去过北境/);
  });
});

describe('了解清单:正文注入', () => {
  it('只给主要角色和在场角色,没有记录的写暂无记录;不依赖名册与场景开关;关闭或仅注入剧情摘要时不发', () => {
    useChat([message({
      location: '客栈',
      npcs: { add: [{ name: '艾琳', important: true }, { name: '小夏', follow: true }, { name: '路人甲', location: '码头' }] },
      knowledge: [{ op: 'add', subject: '艾琳', text: '认定林舟是行商' }, { op: 'add', subject: '路人甲', text: '听说林舟有钱' }],
    })]);
    const text = inject.buildStateInjectionText();
    expect(text).toContain('[角色对林舟的了解·知情范围]\n艾琳:\n- 认定林舟是行商\n小夏:暂无记录\n');
    expect(text).toContain('剧情中也没交代其得知的,按不知道处理');
    expect(text).toContain('按与林舟的关系本该知道的,照常知道');
    expect(text).not.toContain('听说林舟有钱');
    Object.assign(settings.apiSettings.injection, { npcs: false, scenes: false });
    expect(inject.buildStateInjectionText()).toContain('[角色对林舟的了解·知情范围]');
    settings.apiSettings.summaryOnlyMode = true;
    expect(inject.buildStateInjectionText()).toBe('');
    settings.apiSettings.summaryOnlyMode = false;
    settings.apiSettings.injection.knowledge = false;
    expect(inject.buildStateInjectionText()).not.toContain('了解');
  });

  it(`每人最多 ${KNOWLEDGE_INJECT_CAP} 条,取最近的并注明从略条数;没有角色时不发`, () => {
    const list = Array.from({ length: KNOWLEDGE_INJECT_CAP + 2 }, (_, i) => entry('艾琳', `第${i}条`, i));
    const text = fmtKnowledgeInjection(list, ['艾琳'], '林舟');
    expect(text).toContain('艾琳:(另有 2 条较早的从略)\n- 第2条\n');
    expect(text).toContain(`- 第${KNOWLEDGE_INJECT_CAP + 1}条`);
    expect(text).not.toMatch(/- 第[01]条\n/);
    expect(fmtKnowledgeInjection(list, [], '林舟')).toBe('');
  });
});
