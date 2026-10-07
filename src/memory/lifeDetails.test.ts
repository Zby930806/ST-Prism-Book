import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { addLifeDetail, deriveMemory, editNpc, finalizeDelta, removeLifeDetail, removeNpc, updateLifeDetail } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { fmtLifeDetail, lifeDetailSubject, mergeLifeDetailsOp, sameLifeDetail } from './lifeDetails';
import { buildSummaryPrompt, fmtLifeDetails, RULE_LIFE_DETAILS } from './prompts';
import { selectLifeDetailsForInjection } from './select';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type MemLifeDetail, type StoredDelta, type SummaryDelta } from './types';

const original = {
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  injection: { ...settings.apiSettings.injection },
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: '两人正在讨论吃煎饼果子。',
  extra: { bbs_leaf: { id: `life-${++seq}`, text: '讨论早餐', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const detail = (subject?: string, text = '认为煎饼果子不加脆饼就没有灵魂'): MemLifeDetail => ({
  id: `detail:${subject ?? 'legacy'}#0`, subject, text, topics: ['饮食'], anchors: ['煎饼果子'], tier: 'active', createdAt: 1,
});
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'life-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.lifeDetails = true;
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
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('生活档案按人物存储与重放', () => {
  it('旧记录按主角处理,新旧主角同文去重;同文 NPC 各自保留且序号稳定', () => {
    const leaf = message({ lifeDetails: { add: [detail(), detail('user'), detail('艾琳'), detail('小夏')] } });
    const before = JSON.stringify(leaf);
    const details = deriveMemory([leaf]).lifeDetails;
    expect(details.map(d => d.subject)).toEqual(['user', '艾琳', '小夏']);
    expect(details.map(d => d.id.split('#')[1])).toEqual(['0', '2', '3']);
    expect(deriveMemory(JSON.parse(JSON.stringify([leaf]))).lifeDetails).toEqual(details);
    expect(JSON.stringify(leaf)).toBe(before);
  });
  it('同人物的规范化文本去重但不合并不同人物', () => {
    expect(sameLifeDetail(detail(' Alice ', '早睡。'), detail('alice', '早睡'))).toBe(true);
    expect(sameLifeDetail(detail(), detail('user'))).toBe(true);
    expect(sameLifeDetail(detail('艾琳'), detail('user'))).toBe(false);
  });
  it('清洗 subject,按 d 序号更新指定人物,省略 subject 保持', () => {
    const first = message({ lifeDetails: { add: [detail('user'), detail('艾琳')] } });
    const prior = deriveMemory([first]).lifeDetails;
    const delta = finalizeDelta({ lifeDetails: { update: [{ id: 'd2', text: '也接受不加脆饼' }] } }, [], prior);
    expect(delta.lifeDetails!.update![0]).toEqual({ id: prior[1].id, text: '也接受不加脆饼' });
    const details = deriveMemory([first, message(delta)]).lifeDetails;
    expect(details[0]).toEqual(prior[0]);
    expect(details[1]).toMatchObject({ subject: '艾琳', text: '也接受不加脆饼' });
    const added = finalizeDelta({ lifeDetails: { add: [{ subject: ' 艾琳 ', text: '爱喝茶' }] } }, []);
    expect(added.lifeDetails!.add![0].subject).toBe('艾琳');
  });
  it.each(['', ' ', null, false, 42, [], {}])('非法/空 subject %j 不覆盖原人物', subject => {
    const first = message({ lifeDetails: { add: [detail('艾琳')] } });
    const prior = deriveMemory([first]).lifeDetails;
    const delta = finalizeDelta({ lifeDetails: { update: [{ id: 'd1', subject }] } } as SummaryDelta, [], prior);
    expect(delta.lifeDetails!.update![0]).not.toHaveProperty('subject');
    expect(deriveMemory([first, message(delta)]).lifeDetails[0].subject).toBe('艾琳');
  });
  it('显式纠正为 user,删楼/切换 swipe/截断重放均恢复原归属', () => {
    const first = message({ lifeDetails: { add: [detail('艾琳')] } });
    const id = deriveMemory([first]).lifeDetails[0].id;
    const second = message({ lifeDetails: { update: [{ id, subject: 'user' }] } });
    expect(deriveMemory([first, second]).lifeDetails[0].subject).toBe('user');
    expect(deriveMemory([first, second], 1).lifeDetails[0].subject).toBe('艾琳');
    expect(deriveMemory([first]).lifeDetails[0].subject).toBe('艾琳');
    second.swipe_id = 1;
    expect(deriveMemory([first, second]).lifeDetails[0].subject).toBe('艾琳');
  });
});

describe('删除后重加不能串人物', () => {
  it('同叶不同人物同文不会复活已删除条目;原人物重加才复活原 id', () => {
    const target: StoredDelta = { lifeDetails: { add: [detail('艾琳')], remove: ['detail:leaf#0'] } };
    mergeLifeDetailsOp(target, { add: [detail('user')] }, { leafId: 'leaf' });
    expect(target.lifeDetails!.remove).toEqual(['detail:leaf#0']);
    expect(target.lifeDetails!.add).toHaveLength(2);
    mergeLifeDetailsOp(target, { add: [detail('艾琳')] }, { leafId: 'leaf' });
    expect(target.lifeDetails!.remove).toBeUndefined();
    expect(target.lifeDetails!.add).toHaveLength(2);
    expect(target.lifeDetails!.add![0].subject).toBe('艾琳');
  });
  it('跨叶恢复使用已更新的归属,保留 stable id 和人物', () => {
    const existing = detail('艾琳');
    const target: StoredDelta = { lifeDetails: { update: [{ id: existing.id, subject: '小夏' }], remove: [existing.id] } };
    mergeLifeDetailsOp(target, { add: [detail('艾琳')] }, { leafId: 'next', existingDetails: [existing] });
    expect(target.lifeDetails!.remove).toEqual([existing.id]);
    mergeLifeDetailsOp(target, { add: [detail('小夏')] }, { leafId: 'next', existingDetails: [existing] });
    expect(target.lifeDetails!.remove).toBeUndefined();
    expect(target.lifeDetails!.update![0]).toMatchObject({ id: existing.id, subject: '小夏', tier: 'active' });
    expect(target.lifeDetails!.add).toHaveLength(1);
  });
});

describe('手动入口和 NPC 改名', () => {
  it('可添加、纠正人物、置顶、删除与重加', () => {
    useChat([message()]);
    expect(addLifeDetail({ subject: '艾琳', text: '喝茶不加糖' })).toBe(true);
    const id = memory.lifeDetails[0].id;
    expect(updateLifeDetail(id, { subject: 'user', tier: 'pinned' })).toBe(true);
    expect(memory.lifeDetails[0]).toMatchObject({ subject: 'user', tier: 'pinned' });
    expect(removeLifeDetail(id)).toBe(true);
    expect(memory.lifeDetails).toHaveLength(0);
    expect(addLifeDetail({ subject: 'user', text: '喝茶不加糖' })).toBe(true);
    expect(memory.lifeDetails[0]).toMatchObject({ id, subject: 'user', tier: 'active' });
  });
  it('角色改名同步归属但不动正文与其他人物,删角色保留历史习惯', () => {
    const first = message({ npcs: { add: [{ name: '艾琳', important: true }] },
      lifeDetails: { add: [detail('艾琳'), detail('user')] } });
    const chat = [first, message()];
    useChat(chat);
    const id = memory.lifeDetails[0].id;
    expect(editNpc('艾琳', { name: '艾莉' })).toBe(true);
    expect(memory.lifeDetails[0]).toMatchObject({ id, subject: '艾莉', text: detail().text });
    expect(memory.lifeDetails[1].subject).toBe('user');
    expect(deriveMemory(chat, 1).lifeDetails[0].subject).toBe('艾琳');
    expect(removeNpc('艾莉')).toBe(true);
    expect(memory.npcs).toHaveLength(0);
    expect(memory.lifeDetails[0].subject).toBe('艾莉');
  });
});

const promptArgs: Parameters<typeof buildSummaryPrompt>[0] = {
  user: '林舟', char: '艾琳', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [detail(), detail('艾琳')], items: [], itemLog: [], scenes: [], npcs: [{ name: '艾琳', important: true }],
  openPlans: [], resolvedPlans: [], history: '', content: '吃早餐', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
describe('每条生活细节都有明确主语', () => {
  it('页面/摘要共用完整人名渲染,旧记录显示主角,不从文本猜人物', () => {
    expect(lifeDetailSubject(detail())).toBe('user');
    expect(fmtLifeDetail(detail(), '林舟')).toBe(`林舟：${detail().text}`);
    expect(fmtLifeDetail(detail('艾琳'), '林舟')).toBe(`艾琳：${detail().text}`);
    expect(fmtLifeDetails(promptArgs.lifeDetails, '林舟')).toContain(`d2. [长期] 艾琳：${detail().text}`);
  });
  it.each(['', 'CUSTOM {{content}}', 'CUSTOM {{lifedetails_block}} {{content}}'])('默认/自定义模板带人物协议和完整旧档案: %s', custom => {
    settings.apiSettings.prompts.summary = custom;
    const prompt = buildSummaryPrompt(promptArgs);
    expect(prompt.system).toContain('每条 add 必须带 subject');
    expect(prompt.system).toContain('主角固定写字面值 "user"');
    expect(prompt.system).toContain('主要角色');
    expect(prompt.system).not.toContain('NPC 的细节不记这里');
    expect(prompt.user.split(`林舟：${detail().text}`)).toHaveLength(2);
    expect(prompt.user.split(`艾琳：${detail().text}`)).toHaveLength(2);
    expect(prompt.user).toContain('d2.');
    expect(prompt.user).toContain('★ 艾琳');
  });
  it('只提取明确事实、不从单次行为推断、默认不记且不互相覆盖', () => {
    for (const rule of ['主语不明宁可不记', '禁止从行为/语气推断', '一次吃了煎饼不等于爱吃煎饼',
      '【默认不记】', '不同人物即使文字相同也不合并', '不能用另一个人的偏好覆盖本人的条目', '好感与态度估计不写这里']) {
      expect(RULE_LIFE_DETAILS).toContain(rule);
    }
  });
  it('主模型注入逐条标人,受生活档案开关及仅摘要模式控制', () => {
    useChat([message({ lifeDetails: { add: [detail(), detail('艾琳')] } })]);
    const text = inject.buildStateInjectionText();
    expect(text).toContain('[生活小档案·按人物]');
    expect(text).toContain(`林舟：${detail().text}`);
    expect(text).toContain(`艾琳：${detail().text}`);
    expect(text).toContain('不可混用');
    expect(text).toContain('不代表其他角色已知');
    settings.apiSettings.injection.lifeDetails = false;
    expect(inject.buildStateInjectionText()).not.toContain(detail().text);
    settings.apiSettings.injection.lifeDetails = true;
    settings.apiSettings.summaryOnlyMode = true;
    expect(inject.buildStateInjectionText()).toBe('');
  });
  it('仍只按关键词触发,无关话题不灌入人物生活档案', () => {
    const details = [detail('user'), detail('艾琳')];
    expect(selectLifeDetailsForInjection(details, '下雨了', '')).toEqual([]);
    expect(selectLifeDetailsForInjection(details, '想买煎饼果子', '')).toEqual(details);
    details[1].tier = 'pinned';
    expect(selectLifeDetailsForInjection(details, '下雨了', '')).toEqual([details[1]]);
  });
});

describe('实际摘要与跨对话继承', () => {
  it('摘要收到带主语旧记录,解析 AI 新角色归属和旧记录纠正', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [message({ lifeDetails: { add: [detail()] } }), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '艾琳说自己喝茶不加糖,林舟纠正了口味。', stateChanges: ['npcs', 'lifeDetails'], timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { add: [{ name: '艾琳', important: true }] },
      lifeDetails: { add: [{ subject: '艾琳', text: '喝茶不加糖', topics: ['饮食'], anchors: ['茶'] }],
        update: [{ id: 'd1', text: '煎饼果子可以不加脆饼' }] },
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain(`林舟：${detail().text}`);
    expect(chat[1].extra!.bbs_leaf!.delta.lifeDetails!.add![0].subject).toBe('艾琳');
    expect(memory.lifeDetails.map(d => [d.subject, d.text])).toEqual([
      ['user', '煎饼果子可以不加脆饼'], ['艾琳', '喝茶不加糖'],
    ]);
  });
  it('继承保留种子与窗口内更新的人物、稳定层级,源聊天不受影响', async () => {
    settings.apiSettings.keepRecent = 1;
    const first = message({ lifeDetails: { add: [detail('user'), detail('艾琳'), detail('小夏'), detail('阿禾')] } });
    const ids = deriveMemory([first]).lifeDetails.map(d => d.id);
    const last = message({ lifeDetails: {
      add: [detail('小青')],
      update: [{ id: ids[1], subject: '艾莉', text: '口味已纠正' }], archive: [ids[2]], remove: [ids[3]],
    } });
    const ownId = `detail:${last.extra!.bbs_leaf!.id}#0`;
    last.extra!.bbs_leaf!.delta.lifeDetails!.update!.push({ id: ownId, text: '喜欢酸味' });
    const chat = [first, message({ lifeDetails: { update: [{ id: ids[1], tier: 'pinned' }] } }), last];
    const source = useChat(chat);
    const before = JSON.stringify(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'life-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(JSON.stringify(chat)).toBe(before);
    const carried = deriveMemory(target.chat).lifeDetails;
    expect(carried.map(d => [d.subject, d.tier])).toEqual([['user', 'active'], ['艾莉', 'pinned'], ['小夏', 'archive'], ['小青', 'active']]);
    expect(carried[1].text).toBe('口味已纠正');
    expect(carried[3]).toMatchObject({ id: ownId, text: '喜欢酸味' });
    expect(target.chat[0].extra!.bbs_leaf!.delta.lifeDetails!.add!.map(d => d.subject)).toEqual(['user', '艾琳', '小夏', '阿禾']);
  });
});
