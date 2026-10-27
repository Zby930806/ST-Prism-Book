import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { currentSummaryPromise, summarizeFloor } from './engine';
import { isNpcLabelName, npcLabelBase, npcMentioned, npcSearchTerms } from './npcLabel';
import { fmtNpcSummaryList } from './npcRelations';
import {
  buildNpcEnrichPrompt, buildSummaryPrompt, NPC_ENRICH_PROMPT, RULE_CONTENT_BOUNDARY, RULE_MAIN_CHARACTERS, RULE_NPC_LIST, RULE_NPCS,
  RULE_PROTAGONIST, SUMMARY_PROMPT, THINKING_CHECKLIST,
} from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type StoredDelta } from './types';

// 规则与名册的发送合同检查;不代表模型实际的识别率。
const saved = JSON.stringify(settings.apiSettings);
const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: '沈遥', char: '雾港来信', time: '', location: '', protagonist: {}, sceneFocus: null, lifeDetails: [], items: [], itemLog: [], scenes: [],
  npcs: [], openPlans: [], resolvedPlans: [], history: '', content: '正文。', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('三类人物的记录规则', () => {
  it('主角只记 {{user}} 本人:名字、用户发言或第二人称「你」;其他人物一律进 npcs;没出场不输出', () => {
    for (const rule of ['【主角只指 {{user}}】', '第二人称「你」直指用户操控的角色', '即使戏份像主角、处在故事中心或就是 {{char}}',
      '一律记入 npcs,不写进 protagonist', '本轮对话没有 {{user}} 出场时不输出 protagonist']) expect(RULE_PROTAGONIST).toContain(rule);
  });
  it('主要角色:除主角外的主要登场角色,{{char}} 算在内;角色卡没写的档案照常记,升降档要有证据', () => {
    for (const rule of ['【主要角色规则】', '同伴、反复出场或推动主线的人物', '{{char}} 是具体人物时也算', '角色卡已写明的性别、年龄、身份、外貌、性格可以省略',
      '角色卡没写的照常按正文记录', 'update important:true', 'update important:false', '名册中已有的档位保持不变']) expect(RULE_MAIN_CHARACTERS).toContain(rule);
    expect(RULE_MAIN_CHARACTERS).not.toContain('desc/personality 可省');
  });
  it('NPC:登场即记,人群和只被提到的不记;无名用职业+字母并复用;报出真名用 rename', () => {
    for (const rule of ['【NPC 规则】', '登场并说话、行动或被具体描写的个人都要记', '只出场一次也记', '职业不是排除标准', '人群与集体',
      '只被提到名字、本人没有登场的人', '「职业或身份 + 大写字母」', '「酒保A」「酒保B」', '同一人再出现复用原标签', '一个标签只给一个人,改名后也不再分给别人',
      'npcs.rename', 'to 不能与名册已有的名字重复', '外号、新称呼或身份变化不算改名']) expect(RULE_NPC_LIST).toContain(rule);
    for (const old of ['宁可漏记', '默认不记**', '极严筛选', '准入硬门槛', '写不出 title 的角色基本没有记录价值']) expect(RULE_NPCS).not.toContain(old);
    expect(RULE_NPCS).toContain('正文描写了发色、身材、五官');
  });
  it('名册没有的登场人物都要建档:此前只被提到、主角不在场或其他角色视角中登场的也算;视角切走不是退场', () => {
    for (const rule of ['以名册为准', '以前只被提到、本楼才真正登场的', '在主角不在场的场景或其他角色视角的段落里登场的', '只在一段支线中出场的',
      '历史摘要、角色卡或世界书提到过不等于已经建档', '同一份 JSON 必须有对应的 npcs.add']) expect(RULE_NPC_LIST).toContain(rule);
    expect(RULE_NPCS).toContain('视角切回其他人物、支线告一段落、角色暂时不再出场都不是退场');
    expect(RULE_NPCS).toContain('位置拿不准时只省略 location,建档和其他字段照常输出');
    expect(THINKING_CHECKLIST).toContain('本楼登场而名册中没有的人都要 npcs.add(含此前只被提到、主角不在场或其他角色视角中登场的)');
    // 是否与主角互动不是建档条件(旧版的准入门槛)
    expect(RULE_NPCS).not.toContain('与 {{user}} 发生过');
  });
  it('输出协议一眼分清主要角色与 NPC:两个 add 示例、important 写法、rename 操作', () => {
    expect(SUMMARY_PROMPT).toContain('"name": "主要角色名", "important": true');
    expect(SUMMARY_PROMPT).toContain('"name": "NPC名;没有名字用职业或身份加大写字母,如酒保A"');
    expect(SUMMARY_PROMPT).toContain('"important": "NPC升为主要角色填true,主要角色降为NPC填false');
    expect(SUMMARY_PROMPT).toContain('"rename": [{ "from": "名册中的原名,如酒保A", "to": "本楼报出的真名", "evidence"');
    expect(THINKING_CHECKLIST).toContain('人物盘点');
    expect(THINKING_CHECKLIST).toContain('主要角色带 important:true,无名的用「职业+字母」标签并复用,报出真名用 rename 接续');
    const system = buildSummaryPrompt(args).system;
    expect(system.indexOf('【主角当前档案规则】')).toBeLessThan(system.indexOf('【主要角色规则】'));
    expect(system.indexOf('【主要角色规则】')).toBeLessThan(system.indexOf('【NPC 规则】'));
  });
  it('自定义模板由代码补上分档协议;模板已带新规则时不重复', () => {
    settings.apiSettings.prompts.summary = '旧模板:NPC 默认不记,宁可漏记。{{content}}';
    const old = buildSummaryPrompt(args).system;
    expect(old).toContain('【棱镜宝书角色分档兼容协议】');
    expect(old).toContain('本协议更新旧模板中「NPC 默认不记、宁可漏记」');
    // 主角规则开头会引用后文的【主要角色规则】,这里统计的是规则一节本身,仍只出现一次。
    expect(old.split('═══ 【主要角色规则】')).toHaveLength(2);
    expect(old).toContain('【主角只指 沈遥】');
    settings.apiSettings.prompts.summary = SUMMARY_PROMPT.replace('{{content}}', '{{content}}\n');
    expect(buildSummaryPrompt(args).system).not.toContain('【棱镜宝书角色分档兼容协议】');
  });
});

describe('摘要模型看到的名册按三类分组', () => {
  it('主角一行、主要角色、NPC 分组;简列的只有名字、身份和所在地', () => {
    const text = fmtNpcSummaryList([
      { name: '洛伊', important: true, title: '领航员', desc: '银灰短发', presence: 'present', follow: true },
      { name: '梅芙', title: '修表师', desc: '红发', condition: '右臂轻伤', affinityInner: 1, presence: 'absent', location: '旧街', brief: true },
      { name: '老周', title: '船工', formerNames: ['船工A'], presence: 'nearby', location: '码头' },
    ], { tiers: true, user: '沈遥' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('  主角:沈遥(只写 protagonist,档案见「主角当前档案」,不进名册)');
    expect(lines[1]).toBe('  主要角色:');
    expect(lines[2]).toContain('  - ★ 洛伊');
    expect(lines[3]).toBe('  NPC(标〔简列〕的只列了名字、身份和所在地):');
    expect(lines[4]).toBe('  - 梅芙〔不在场〕 [在:旧街] —— 修表师〔简列〕');
    expect(lines[5]).toContain('老周〔同区域〕 [在:码头] —— 船工;原记为:船工A');
    expect(fmtNpcSummaryList([], { tiers: true, user: '沈遥' })).toContain('  主要角色:(无)\n  NPC:(无)');
  });
  it('实际摘要请求:不在场且本楼未提到的 NPC 简列,提到的(含职业词)保留完整档案', async () => {
    vi.useFakeTimers();
    vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
    vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
    vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
    vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
    vi.spyOn(notices, 'toast').mockImplementation(() => {});
    settings.apiSettings.summaryMaxRetries = 0;
    settings.apiSettings.vector.enabled = false;
    const delta: StoredDelta = { location: '书店', npcs: { add: [
      { name: '梅芙', title: '修表师', desc: '红发', location: '旧街' },
      { name: '酒保A', title: '酒保', desc: '络腮胡', location: '酒馆' },
      { name: '洛伊', important: true, desc: '银灰短发', location: '王都' },
    ] } };
    const chat: STMessage[] = [
      { name: '角色', is_user: false, is_system: false, mes: '开场。', extra: { bbs_leaf: { id: 'tiers-0', text: '开场。', delta, createdAt: 1, swipe: 0, v: 1 } as LeafExtra } },
      { name: '沈遥', is_user: true, is_system: false, mes: '去找那个酒保。' },
      { name: '角色', is_user: false, is_system: false, mes: '书店里很安静。' },
    ];
    const ctx = { chat, chatMetadata: {}, name1: '沈遥', name2: '角色', getCurrentChatId: () => 'tiers',
      saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
    vi.spyOn(context, 'getContext').mockReturnValue(ctx);
    recomputeDerived();
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '沈遥要去找酒保。', stateChanges: [] }));
    await summarizeFloor(2);
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('  主角:沈遥');
    expect(sent).toContain('梅芙〔不在场〕 [在:旧街] —— 修表师〔简列〕');
    expect(sent).not.toContain('红发');
    expect(sent).toContain('既有外貌记录:络腮胡');
    expect(sent).toContain('既有外貌记录:银灰短发');
    vi.useRealTimers();
  });
});

describe('无名角色标签', () => {
  it.each([['酒保A', '酒保'], ['黑衣人C', '黑衣人'], ['守卫Ｂ', '守卫'], ['Bartender A', 'Bartender']])('%s 是标签,职业词为 %s', (name, base) => {
    expect(npcLabelBase(name)).toBe(base);
  });
  it.each(['小A', 'ANNA', '艾琳', '酒保', 'A', '甲A1'])('%s 不是标签', name => {
    expect(isNpcLabelName(name)).toBe(false);
  });
  it('检索词含名字、旧名和职业词;单字不检索;正文提到职业词也算提到', () => {
    expect(npcSearchTerms('老周', ['船工A'])).toEqual(['老周', '船工A', '船工']);
    expect(npcSearchTerms('甲')).toEqual([]);
    expect(npcMentioned('那个酒保又来了', '酒保A')).toBe(true);
    expect(npcMentioned('船工在码头', '老周', ['船工A'])).toBe(true);
    expect(npcMentioned('甲点了点头', '甲')).toBe(true);
    expect(npcMentioned('书店里很安静', '梅芙')).toBe(false);
  });
});

describe('回看原文补档案的提示词', () => {
  it('带与摘要相同的内容边界,DeepSeek 模型省略;只填待补字段并附原文证据', () => {
    const withBoundary = buildNpcEnrichPrompt({ user: '沈遥', char: '雾港来信', targets: '1. 酒保A', content: '[#1] 酒保留着络腮胡。' });
    expect(withBoundary.system.startsWith(RULE_CONTENT_BOUNDARY)).toBe(true);
    expect(buildNpcEnrichPrompt({ user: '沈遥', char: '雾港来信', targets: '', content: '' }, { contentBoundary: false }).system).not.toContain('【内容边界');
    expect(withBoundary.user).toContain('[#1] 酒保留着络腮胡。');
    expect(withBoundary.system).not.toContain('酒保留着络腮胡');
    for (const rule of ['只填写材料中「待补字段」列出的字段', '不推测、不按常识或角色类型补全', '可能混有同职业的其他人', '每个填写的字段都在 evidence 中附一条支持它的摘录原句', '{"npcs":[]}']) {
      expect(NPC_ENRICH_PROMPT).toContain(rule);
    }
  });
});
