import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { classifyNpcPresence, deriveMemory, editNpc, finalizeDelta } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { summarizeFloor, currentSummaryPromise } from './engine';
import { refreshInjection, buildStateInjectionText } from './inject';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';
import { npcLocationLabel } from './npcLocation';
import { fmtNpcSummaryList } from './npcRelations';
import { taskContextPrompt } from './taskContext';
import { JAILBREAK_PROMPT } from './prompts';
import { fitMemoryUnits, fitTimeTagPrompt, estimateTokens, slotBudget, BUDGET_NOTICE } from './budget';
import { parseTimeRange, latestStoryTime, TIME_TAG_PROMPT } from './timeTag';
import { parseResponse } from './vector/rewrite';
import * as rewrite from './vector/rewrite';
import * as scope from './vector/scope';
import * as vectorIndex from './vector/index';
import * as vectorStore from './vector/store';
import * as embed from './vector/embed';
import { buildRecallText, runVectorRecall } from './vector/recall';

const { apiSettings } = settings;
const saved = JSON.stringify(apiSettings);
let seq = 0;
function message(delta: StoredDelta = {}, text = '一段正文。'): STMessage {
  const id = 'revision-' + ++seq;
  return { name: 'Character', is_user: false, is_system: false, mes: text,
    extra: { bbs_leaf: { id, text: '事件摘要。', delta, createdAt: seq, swipe: 0, v: 1 } } };
}
function useChat(chat: STMessage[]) {
  const slots = new Map<string, string>();
  const ctx = { chat, chatMetadata: {}, name1: '主角', name2: '角色', getCurrentChatId: () => 'revision',
    setExtensionPrompt: vi.fn((key: string, text: string) => slots.set(key, text)),
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
    saveMetadataDebounced: vi.fn(), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return { ctx, slots };
}
const kitchen = () => message({ time: '2026/9/1 10:00', location: '厨房', npcs: { add: [
  { name: '小A', location: '厨房' }, { name: '小B', follow: true },
] } });
const presence = (state: ReturnType<typeof deriveMemory>, name = '小A') => classifyNpcPresence(state.npcs.find(n => n.name === name)!, state.scenes, state.state.location, state.state.locationPath);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  apiSettings.memoryBudgetTokens = 6000;
  apiSettings.taskContextMode = 'default';
  apiSettings.summaryOnlyMode = false;
  apiSettings.vector.enabled = false;
  apiSettings.keepRecent = 1;
  apiSettings.injection.npcs = true;
  apiSettings.injection.scenes = true;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.assign(apiSettings, JSON.parse(saved));
});

describe('位置证据完整链路', () => {
  it('换场后第200楼不会把小A冻结在厨房,回去也不自动确认', () => {
    const chat = [kitchen(), message({ location: '街道' }), ...Array.from({ length: 198 }, () => message())];
    let st = deriveMemory(chat);
    expect(presence(st)).toBe('unknown');
    expect(presence(st, '小B')).toBe('present');
    expect(st.npcs[0].lastKnownLocation?.place).toBe('厨房');
    chat.push(message({ location: '厨房' }));
    st = deriveMemory(chat);
    expect(presence(st)).toBe('unknown');
    chat.push(message({ npcs: { update: [{ name: '小A', location: '厨房' }] } }));
    expect(presence(deriveMemory(chat))).toBe('present');
  });
  it('同场景不以楼数推时间,明确跨日则降级', () => {
    const chat = [kitchen(), ...Array.from({ length: 200 }, () => message())];
    expect(presence(deriveMemory(chat))).toBe('present');
    chat.push(message({ time: '2026/9/2 10:00' }));
    expect(presence(deriveMemory(chat))).toBe('unknown');
  });
  it('清空保留最后位置,撤销/翻页按有效叶子重放', () => {
    const first = kitchen();
    const away = message({ npcs: { update: [{ name: '小A', location: '', follow: false }] } });
    const state = deriveMemory([first, away]);
    expect(presence(state)).toBe('unknown');
    expect(npcLocationLabel(state.npcs[0])).toContain('最后确认:厨房');
    expect(presence(deriveMemory([first]))).toBe('present');
    away.swipe_id = 1;
    expect(presence(deriveMemory([first, away]))).toBe('present');
  });
  it('名册、注入和页面共用定位语义,编辑身份不刷新旧定位', () => {
    const chat = [kitchen(), message({ location: '街道' })];
    useChat(chat);
    expect(editNpc('小A', { title: '厨师' })).toBe(true);
    expect(memory.npcs[0].locationStale).toBe(true);
    expect(fmtNpcSummaryList(memory.npcs)).toContain('当前位置未确认;最后确认:厨房');
    expect(buildStateInjectionText()).toContain('当前位置未确认;最后确认:厨房');
    expect(editNpc('小A', { name: '甲' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '甲')?.locationStale).toBe(true);
  });
  it('真实摘要请求收到位置证据,而非只有旧地点字符串', async () => {
    const next = message(); delete next.extra!.bbs_leaf;
    useChat([kitchen(), message({ location: '街道' }), next]);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '继续交谈。', stateChanges: [], timeStart: '', timeEnd: '' }));
    await summarizeFloor(2);
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('小A〔当前位置未确认〕');
    expect(sent).toContain('最后确认:厨房');
  });
  it('带数据建新聊天保留过期证据和来源,不重新确认厨房', async () => {
    const chat = [kitchen(), message({ location: '街道' }), message()];
    const { ctx } = useChat(chat);
    const target = { ...ctx, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'target' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    expect(await createNewChatWithCarryover()).toBe(true);
    const st = deriveMemory(target.chat);
    expect(presence(st)).toBe('unknown');
    expect(st.npcs[0].lastKnownLocation?.leafId).toBe(chat[0].extra!.bbs_leaf!.id);
  });
  it('模型不能伪造内部定位证据,只有内部重放可读取', () => {
    const d = finalizeDelta({ npcs: { add: [{ name: '甲', location: '厨房', locationStale: false,
      lastKnownLocation: { place: '伪造', time: '2099', leafId: 'fake' } }] } }, []);
    expect(d.npcs?.add?.[0].lastKnownLocation).toBeUndefined();
    expect(d.npcs?.add?.[0].locationStale).toBeUndefined();
  });
});

describe('任务说明三态的实际请求', () => {
  it.each(['default', 'custom', 'disabled'] as const)('%s 模式进入发送消息', async mode => {
    apiSettings.taskContextMode = mode;
    apiSettings.prompts.jailbreak = '自定义任务说明唯一标记';
    const m = message(); delete m.extra!.bbs_leaf;
    useChat([m]);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '开场。', stateChanges: [], timeStart: '', timeEnd: '' }));
    await summarizeFloor(0);
    const text = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(text.includes(JAILBREAK_PROMPT)).toBe(mode === 'default');
    expect(text.includes('自定义任务说明唯一标记')).toBe(mode === 'custom');
  });
  it('自定义空白不回退内置,禁用也不回退', () => {
    apiSettings.taskContextMode = 'custom'; apiSettings.prompts.jailbreak = '   ';
    expect(taskContextPrompt()).toBe('');
    apiSettings.taskContextMode = 'disabled'; apiSettings.prompts.jailbreak = '旧自定义';
    expect(taskContextPrompt()).toBe('');
  });
});

describe('检索语义与未知时间', () => {
  it.each([1, 3, 5, 8])('允许按需 %s 条,最多5条', count => {
    const out = parseResponse('INTENT:核对之前的约定\n' + Array.from({ length: count }, (_, i) => 'Q:约定' + i).join('\n'));
    expect(out.queries).toHaveLength(Math.min(count, 5));
  });
  it('去重,INTENT不再误用较短的Q上限', () => {
    const intent = '意'.repeat(300);
    const out = parseResponse('INTENT:' + intent + '\nQ:许诺\nQ:许诺');
    expect(out.intent).toBe(intent); expect(out.queries).toEqual(['许诺']);
  });
  it('超长查询整条丢弃,不把后半句否定截掉变成肯定', () => {
    expect(parseResponse('Q:可以离开。' + '条'.repeat(230) + '但未获批准不得离开。\nQ:她答应的条件').queries).toEqual(['她答应的条件']);
    expect(parseResponse('Q:' + '长'.repeat(221)).queries).toEqual([]);
  });
  it('空标签不造时间,部分精度原样保留', () => {
    expect(parseTimeRange('<bbs_start></bbs_start>正文<bbs_end> </bbs_end>')).toEqual({ start: undefined, end: undefined });
    expect(parseTimeRange('<bbs_start>初秋</bbs_start>正文<bbs_end>当天傍晚</bbs_end>')).toEqual({ start: '初秋', end: '当天傍晚' });
    expect(latestStoryTime([{ mes: '无时间的正文', is_user: false } as STMessage])).toBe('');
  });
});

describe('总注入预算', () => {
  it('按完整条目省略,保留最近节点顺序,0不限', () => {
    apiSettings.memoryBudgetTokens = 2000;
    const units = Array.from({ length: 12 }, (_, i) => '[' + i + ']' + '回忆。'.repeat(130));
    const out = fitMemoryUnits(units, 'history', '开始', '结束', true);
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(slotBudget('history'));
    expect(out.text).toContain(BUDGET_NOTICE);
    expect(out.indices).toContain(11);
    for (const i of out.indices) expect(out.text).toContain(units[i]);
    expect(out.indices).toEqual([...out.indices].sort((a,b) => a-b));
    apiSettings.memoryBudgetTokens = 0;
    expect(fitMemoryUnits(units, 'history').indices).toHaveLength(12);
  });
  it('时间协议整块处理,默认6000可容纳内置协议', () => {
    expect(fitTimeTagPrompt(TIME_TAG_PROMPT)).toBe(TIME_TAG_PROMPT);
    expect(fitTimeTagPrompt('超长'.repeat(3000))).toBe('');
  });
  it('最终注入槽合计不超预算,保留完整变量对象或整块省略', () => {
    const { slots } = useChat([message()]);
    apiSettings.autoSummaryEnabled = true;
    apiSettings.prompts.timeTag = '';
    memory.state.location = '厨房';
    memory.vars = { secrets: '秘密'.repeat(8000) };
    memory.summaries = Array.from({ length: 35 }, (_, i) => ({ id: 'import' + i, text: '事件' + i + '往事。'.repeat(120), level: 1, auto: false, imported: true, importedFloorStart: i, importedFloorEnd: i, childIds: [], createdAt: i }));
    refreshInjection();
    const hits = Array.from({ length: 10 }, (_, i) => ({ leafId: 'hit' + i, scope: 'test', similarity: 0.9, rerankScore: 0.9, queryIndex: 0, document: '约定。'.repeat(140), mesFull: null, storyTime: null, msgIndex: i }));
    const recall = buildRecallText(hits, { ...apiSettings.vector.recall, finalRecallCount: 10, fullTextCount: 3 }, 'test', '');
    slots.set('baibai_book_vector_recall', recall.text);
    expect([...slots.values()].reduce((sum, s) => sum + estimateTokens(s), 0)).toBeLessThanOrEqual(6000);
    expect(slots.get('baibai_book_memory_state')).not.toContain('秘密');
    expect(slots.get('baibai_book_memory_state')).toContain(BUDGET_NOTICE);
    expect(recall.tiers.size).toBeLessThan(hits.length);
    expect(memory.vars.secrets).toBe('秘密'.repeat(8000));
    expect(memory.summaries).toHaveLength(35);
  });
  it('召回缓存命中不绕过预算,改变限额后重新生成', async () => {
    const { slots } = useChat([{ ...message(), is_user: true }]);
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
    apiSettings.vector.enabled = true;
    vi.spyOn(scope, 'currentVectorDb').mockReturnValue('test');
    vi.spyOn(scope, 'recallScopes').mockReturnValue(['test']);
    vi.spyOn(scope, 'currentBundleHashes').mockReturnValue(['bundle']);
    vi.spyOn(scope, 'currentChatScope').mockReturnValue('test');
    vi.spyOn(scope, 'currentChatId').mockReturnValue('cache-test');
    vi.spyOn(vectorIndex, 'ensureRecallIndex').mockResolvedValue(undefined);
    vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: '约定', queries: ['约定'] });
    vi.spyOn(embed, 'embedTexts').mockResolvedValue([new Float32Array([1, 0])]);
    vi.spyOn(embed, 'encodeFloat32Base64').mockReturnValue('AA');
    vi.spyOn(embed, 'rerankDocuments').mockRejectedValue(new Error('测试:未配重排'));
    vi.spyOn(vectorStore, 'vecSearch').mockResolvedValue({ results: [{ leafId: 'old', scope: 'test', similarity: 0.99, queryIndex: 0, document: '先前的约定。'.repeat(70), mesFull: null, storyTime: null, msgIndex: 0 }] });
    await runVectorRecall();
    await runVectorRecall();
    expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
    expect(estimateTokens(slots.get('baibai_book_vector_recall') ?? '')).toBeLessThanOrEqual(slotBudget('recall'));
    apiSettings.memoryBudgetTokens = 2000;
    await runVectorRecall();
    expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
    expect(estimateTokens(slots.get('baibai_book_vector_recall') ?? '')).toBeLessThanOrEqual(slotBudget('recall'));
  });
});


describe('v0.5 临时伤势与外貌纠错重放', () => {
  const injured = () => message({ time: '2031/4/12 19:00', location: '厨房',
    npcs: { add: [{ name: '甲', desc: '黑发,左眉永久伤疤', outfit: '佩短刀',
      condition: '手腕受伤并缠绷带,腿伤未愈;自述还需养四五天', location: '厨房' }] } });
  const npc = (chat: STMessage[]) => deriveMemory(JSON.parse(JSON.stringify(chat))).npcs[0];
  it.each([
    ['未提及', {}],
    ['离场', { npcs: { update: [{ name: '甲', follow: false, location: '' }] } }],
    ['超过预计休养期', { time: '2031/5/12 19:00' }],
    ['重逢未谈伤势', { npcs: { update: [{ name: '甲', location: '街道' }] } }],
  ] as [string, StoredDelta][])('%s不会自动清空伤势或固定疤痕', (_label, delta) => {
    const first = injured(); const before = npc([first]);
    const after = npc([first, message(delta)]);
    expect(after.condition).toBe(before.condition);
    expect(after.desc).toBe(before.desc);
  });
  it('闪回不带当前状态补丁时不会改变伤势', () => {
    const first = injured();
    expect(npc([first, message({}, '回忆多年前,甲手脚健全。')]).condition).toBe(npc([first]).condition);
  });
  it('完整伤情补丁可表示局部恢复,最终明确清空才去除剩余伤情', () => {
    const first = injured();
    const partial = message(finalizeDelta({ npcs: { update: [{ name: '甲', condition: '手腕已恢复,腿伤未愈' }] } }, []));
    expect(npc([first, partial]).condition).toBe('手腕已恢复,腿伤未愈');
    const healed = message(finalizeDelta({ npcs: { update: [{ name: '甲', condition: '' }] } }, []));
    expect(npc([first, partial, healed]).condition).toBeUndefined();
    expect(npc([first, partial, healed]).desc).toBe('黑发,左眉永久伤疤');
    expect(npc([first, partial, healed]).outfit).toBe('佩短刀');
  });
  it('显式空外貌经过规范化、存储与重放后生效,不连带清空伤势或装备', () => {
    const first = injured();
    const delta = finalizeDelta({ npcs: { update: [{ name: '甲', desc: '  ' }] } }, []);
    expect(delta.npcs?.update?.[0].desc).toBe('');
    const corrected = message(delta);
    expect(npc([first, corrected]).desc).toBeUndefined();
    expect(npc([first, corrected]).condition).toBe(npc([first]).condition);
    expect(npc([first, corrected]).outfit).toBe('佩短刀');
    corrected.swipe_id = 1;
    expect(npc([first, corrected]).desc).toBe('黑发,左眉永久伤疤');
  });
  it('省略外貌保持原值,已有错误外貌不会被关键词规则擅自迁移', () => {
    const first = message({ npcs: { add: [{ name: '甲', desc: '右腕缠绷带' }] } });
    const state = npc([first, message(finalizeDelta({ npcs: { update: [{ name: '甲', title: '向导' }] } }, []))]);
    expect(state.desc).toBe('右腕缠绷带');
    expect(state.condition).toBeUndefined();
  });
  it('纠错可保留永久特征,已痊愈后清理旧外貌不会复活伤势', () => {
    const first = message({ npcs: { add: [{ name: '甲', desc: '黑发,右腕缠绷带', condition: '右腕受伤' }] } });
    const healed = message({ npcs: { update: [{ name: '甲', condition: '' }] } });
    const corrected = message(finalizeDelta({ npcs: { update: [{ name: '甲', desc: '黑发' }] } }, []));
    expect(npc([first, healed, corrected]).desc).toBe('黑发');
    expect(npc([first, healed, corrected]).condition).toBeUndefined();
  });
  it('重复 add 不用空外貌覆盖已有稳定档案', () => {
    expect(npc([injured(), message(finalizeDelta({ npcs: { add: [{ name: '甲', desc: '' }] } }, []))]).desc).toBe('黑发,左眉永久伤疤');
  });
  it('手动清空外貌可持久重放,仅改名保留外貌和伤势', () => {
    const chat = [injured()]; useChat(chat);
    expect(editNpc('甲', { name: '乙' })).toBe(true);
    expect(npc(chat).desc).toBe('黑发,左眉永久伤疤');
    const condition = npc(chat).condition;
    expect(editNpc('乙', { desc: '' })).toBe(true);
    expect(npc(chat).desc).toBeUndefined();
    expect(npc(chat).condition).toBe(condition);
  });
});


describe('v0.5 主角伤势同一补丁语义', () => {
  it('跳时不自动康复,清外貌不清伤,明确恢复只清状态', () => {
    const first = message(finalizeDelta({ protagonist: { appearance: '短发,腕部绷带', condition: '腕伤未愈', outfit: '布衣' } }, []));
    const elapsed = message({ time: '2032/4/12 08:00' });
    const corrected = message(finalizeDelta({ protagonist: { appearance: '短发' } }, []));
    const st = deriveMemory([first, elapsed, corrected]);
    expect(st.protagonist.condition).toBe('腕伤未愈');
    expect(st.protagonist.appearance).toBe('短发');
    const healed = message(finalizeDelta({ protagonist: { condition: '' } }, []));
    const final = deriveMemory(JSON.parse(JSON.stringify([first, elapsed, corrected, healed])));
    expect(final.protagonist.condition).toBeUndefined();
    expect(final.protagonist.appearance).toBe('短发');
    expect(final.protagonist.outfit).toBe('布衣');
  });
});
