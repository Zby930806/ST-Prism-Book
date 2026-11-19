import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, editNpc, finalizeDelta } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { fmtNpcIntimacyContext, fmtNpcSummaryList } from './npcRelations';
import { npcCardFields } from '@/pages/npcs/npcView';
import {
  buildBatchSummaryPrompt, buildResummaryPrompt, buildSummaryPrompt, buildSummaryThinking, RESUMMARY_THINKING_CHECKLIST, RULE_INTIMACY_KEEP, RULE_NPC_INTIMACY,
} from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type NpcDelta, type StoredDelta, type SummaryDelta } from './types';

// 亲密记录(npcs 的 intimacy 字段):固化、重放、手动修改、带数据新建对话、提示词与注入。
// 模型回复都是本地 mock,不代表真实模型的输出;样例人物均为成年人。
// 这项功能默认关闭;除「开关」一组外,下面的用例都在开启状态下核对(测试起点见 src/testSetup.ts)。
const name = '苏晚';
const first = '共1次;9/12 她家 1次:戴套';
const second = '共3次;9/12 她家 1次:戴套;9/19 旅馆 2次:第一次戴套,第二次未戴套、体外;约定此后多备';
const original = {
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  injection: { ...settings.apiSettings.injection },
  prompts: { ...settings.apiSettings.prompts },
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}, mes = '一段明确发生的剧情。'): STMessage => ({
  name: 'Character', is_user: false, is_system: false, mes,
  extra: { bbs_leaf: { id: `intimacy-${++seq}`, text: '剧情摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const base = (extra: Partial<NpcDelta> = {}) => message({ npcs: { add: [{ name, important: true, gender: '女', ...extra }] } });
const patch = (values: Omit<NpcDelta, 'name'>) => message({ npcs: { update: [{ name, ...values }] } });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '苏晚',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'intimacy-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: '林舟', char: '苏晚', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [{ name, important: true, intimacy: first }],
  openPlans: [], resolvedPlans: [], history: '', content: '说话', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.npcs = true;
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(settings.apiSettings.injection, original.injection);
  Object.assign(settings.apiSettings.prompts, original.prompts);
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('亲密记录:固化与重放', () => {
  it('update 整体覆盖,之后没有新情况的楼保持不变', () => {
    const chat = [base(), patch({ intimacy: first }), message(), patch({ intimacy: second }), message()];
    expect(deriveMemory(chat.slice(0, 2)).npcs[0].intimacy).toBe(first);
    expect(deriveMemory(chat).npcs[0].intimacy).toBe(second);
  });

  it('建档时可以直接带上;已有记录时重复 add 不覆盖', () => {
    const chat = [base({ intimacy: first }), message({ npcs: { add: [{ name, intimacy: '共1次' }] } })];
    expect(deriveMemory(chat).npcs[0].intimacy).toBe(first);
  });

  it('模型输出的空字符串当作省略,不会洗掉累计记录', () => {
    const delta = finalizeDelta({ npcs: { update: [{ name, intimacy: '', outfit: '白衬衫' }] } } as SummaryDelta, []);
    expect(delta.npcs!.update![0].intimacy).toBeUndefined();
    const npc = deriveMemory([base(), patch({ intimacy: first }), message(delta)]).npcs[0];
    expect(npc).toMatchObject({ intimacy: first, outfit: '白衬衫' });
  });

  it('重抽后旧页的摘要失效,记录回到上一条有效的值', () => {
    const rerolled = patch({ intimacy: second });
    rerolled.swipe_id = 1; // 当前页与摘要所在页不同:这条摘要不再重放
    expect(deriveMemory([base(), patch({ intimacy: first }), rerolled]).npcs[0].intimacy).toBe(first);
  });

  it('角色页手动清空生效,改名后记录跟着走', () => {
    const chat = [base(), patch({ intimacy: first })];
    useChat(chat);
    expect(editNpc(name, { name: '苏晚晚' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '苏晚晚')?.intimacy).toBe(first);
    expect(editNpc('苏晚晚', { intimacy: '' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '苏晚晚')?.intimacy).toBeUndefined();
    expect(editNpc('苏晚晚', { intimacy: '共2次' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '苏晚晚')?.intimacy).toBe('共2次');
  });

  it('带数据创建新对话时带走', async () => {
    settings.apiSettings.keepRecent = 1;
    const chat = [base(), patch({ intimacy: first }), message(), patch({ intimacy: second })];
    const source = useChat(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'intimacy-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    // 窗口前的记录进种子,窗口内那一楼的更新照常重放
    expect(deriveMemory(target.chat.slice(0, 1)).npcs[0].intimacy).toBe(first);
    expect(deriveMemory(target.chat).npcs[0].intimacy).toBe(second);
  });
});

describe('亲密记录:发给正文模型', () => {
  it('全局输出一次,不受在场分档影响;没有记录时不输出', () => {
    expect(fmtNpcIntimacyContext([{ name, intimacy: undefined }])).toBe('');
    const text = fmtNpcIntimacyContext([{ name, intimacy: '共3次;\n约定必须戴套' }, { name: '小周' }]);
    expect(text).toContain('与主角的亲密记录');
    expect(text).toContain('不是推进亲密情节的要求');
    expect(text).toContain(`  - ${name}:共3次; 约定必须戴套`);
    expect(text).not.toContain('小周');
  });

  it('角色不在场时仍然注入', () => {
    // 苏晚不是主要角色、留在别处:名册里不按在场发完整档案,亲密记录照发
    const chat = [
      message({ location: '晚风书屋', locationPath: ['晚风书屋'], scenes: { add: [{ path: ['晚风书屋'] }, { path: ['设计所'] }] }, npcs: { add: [{ name, gender: '女', location: '晚风书屋' }] } }),
      patch({ intimacy: second }),
      message({ location: '设计所', locationPath: ['设计所'] }),
    ];
    useChat(chat);
    const state = inject.buildStateInjectionText();
    expect(state).not.toContain('在场:');
    expect(state).toContain('之后未再确认');
    expect(state).toContain(`${name}:${second}`);
  });

  it('关闭角色注入时不发', () => {
    useChat([base(), patch({ intimacy: second })]);
    settings.apiSettings.injection.npcs = false;
    expect(inject.buildStateInjectionText()).not.toContain('亲密记录');
  });
});

describe('亲密记录:摘要请求', () => {
  it('名册带出已有记录,供模型在原有次数上累加', () => {
    expect(fmtNpcSummaryList([{ name, important: true, intimacy: first }])).toContain(`与主角的亲密记录:${first}`);
    // 简列的不在场 NPC 也带上,免得模型看不到旧记录而从头计数
    expect(fmtNpcSummaryList([{ name, intimacy: first, brief: true }])).toContain(`〔与主角的亲密记录:${first}〕〔简列〕`);
    expect(fmtNpcSummaryList([{ name, brief: true }])).not.toContain('亲密记录');
  });

  it.each([true, false])('内置规则含字段写法和摘要要求;未成年不记只各写一句(发送内容边界=%s)', contentBoundary => {
    const { system, user } = buildSummaryPrompt(args, { contentBoundary });
    expect(system).toContain('- intimacy:该角色与林舟的亲密记录,整体覆盖,写累积后的完整内容;未成年或年龄不明的角色不记。');
    expect(system).toContain('"intimacy": "累积后的完整亲密记录');
    expect(system).toContain('- 亲密情节的硬事实:本楼正文明确写到发生性行为时(未成年或年龄不明的角色除外)');
    expect(system).not.toContain('{{user}}');
    expect(user).toContain(`与主角的亲密记录:${first}`);
    expect(system.split(RULE_NPC_INTIMACY.replaceAll('{{user}}', '林舟'))).toHaveLength(2);
    // 这条限制不依赖内容边界那一段(对 DeepSeek 系列默认不发送),字段规则和摘要要求里各一句,不再重复
    const rules = contentBoundary ? system.slice(system.indexOf('═══ 【任务】')) : system;
    expect(rules.split('未成年或年龄不明的角色')).toHaveLength(3);
  });

  it('输出前核查逐项里有亲密记录一项', () => {
    const { checklist } = buildSummaryThinking('林舟');
    expect(checklist).toContain('   - 亲密记录:本楼正文是否明确写到林舟与某个角色发生性行为');
    expect(checklist).toContain('中途停下没有做成的不加次数');
    expect(checklist).not.toContain('{{user}}');
  });

  it('自定义模板没提到时补发字段协议,提到了就不重复', () => {
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    expect(buildSummaryPrompt(args).system).toContain('【棱镜宝书亲密记录兼容协议】');
    settings.apiSettings.prompts.summary = 'CUSTOM 亲密记录按我的写法 {{content}}';
    expect(buildSummaryPrompt(args).system).not.toContain('【棱镜宝书亲密记录兼容协议】');
  });

  it('合并摘要(批量补摘)同样要求写明', () => {
    const { system } = buildBatchSummaryPrompt({ user: '林舟', char: '苏晚', time: '', history: '', content: '楼层' });
    expect(system).toContain('- 亲密情节的硬事实:');
  });

  it.each([1, 2])('总结与二次总结不得把逐次的事实并掉(level=%s)', level => {
    const { system, checklist } = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level });
    expect(system.split(RULE_INTIMACY_KEEP)).toHaveLength(2);
    expect(system).toContain('不得并成「多次亲密」');
    expect(checklist).toContain('亲密情节：输入写明的每次性行为的日期、次数、是否戴套、是否在体内');
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('没做成的没有算进次数');
  });

  it('实际摘要流程:模型给出的累计记录写入档案并注入', async () => {
    const target = message({}, '当晚两人在听潮旅馆做了两次,第一次戴了套,第二次没有戴,最后没有在里面。');
    delete target.extra!.bbs_leaf;
    const chat = [base(), patch({ intimacy: first }), target];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '9月19日夜两人在听潮旅馆做了两次,第一次戴套,第二次未戴套,没有在里面。', stateChanges: ['npcs'], timeStart: '2026/9/19 20:30', timeEnd: '2026/9/20 02:10',
      npcs: { update: [{ name, intimacy: second }] },
    }));
    await summarizeFloor(2);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain(`与主角的亲密记录:${first}`);
    expect(chat[2].extra!.bbs_leaf!.delta.npcs!.update![0].intimacy).toBe(second);
    expect(memory.npcs[0].intimacy).toBe(second);
    expect(inject.buildStateInjectionText()).toContain(`${name}:${second}`);
  });
});

describe('亲密记录:开关(设置 → 注入设置,默认关闭)', () => {
  const MARKS = ['intimacy', '亲密记录', '亲密情节'];
  const none = (text: string) => { for (const mark of MARKS) expect(text).not.toContain(mark); };

  it('默认关闭:没有保存过这一项的设置(包括从 1.4.16 升级)不记录;存档里是布尔值时照用,其他值按默认', () => {
    expect(settings.normalizeApiSettings({}).injection.intimacy).toBe(false);
    expect(settings.normalizeApiSettings({ injection: { intimacy: true } }).injection.intimacy).toBe(true);
    expect(settings.normalizeApiSettings({ injection: { intimacy: false } }).injection.intimacy).toBe(false);
    expect(settings.normalizeApiSettings({ injection: { intimacy: 'yes' } }).injection.intimacy).toBe(false);
    expect(settings.normalizeApiSettings({ injection: { npcs: false } }).injection).toMatchObject({ npcs: false, intimacy: false });
  });

  it('设置里缺这一项时也按关闭处理:请求不带相关内容,模型给出的不收,不注入', () => {
    delete (settings.apiSettings.injection as Partial<typeof settings.apiSettings.injection>).intimacy;
    none(buildSummaryPrompt(args).system);
    none(buildSummaryPrompt(args).user);
    const delta = finalizeDelta({ npcs: { update: [{ name, intimacy: second, outfit: '白衬衫' }] } } as SummaryDelta, []);
    expect(delta.npcs!.update![0]).toEqual({ name, outfit: '白衬衫' });
    useChat([base(), patch({ intimacy: first })]);
    expect(inject.buildStateInjectionText()).not.toContain('亲密记录');
  });

  it.each([true, false])('关闭后摘要请求里没有相关规则、字段和材料(发送内容边界=%s)', contentBoundary => {
    const on = buildSummaryPrompt(args, { contentBoundary });
    settings.apiSettings.injection.intimacy = false;
    const off = buildSummaryPrompt(args, { contentBoundary });
    none(off.system);
    none(off.user);
    none(buildSummaryThinking('林舟').checklist);
    expect(off.system).not.toContain('未成年或年龄不明的角色');
    // 去掉的只有这几段:字段规则、两处输出字段、摘要要求
    expect(on.system.length - off.system.length).toBe(
      RULE_NPC_INTIMACY.replaceAll('{{user}}', '林舟').length + 1
      + on.system.split('"intimacy": "').slice(1).reduce((n, part) => n + '"intimacy": "'.length + part.indexOf('", ') + 3, 0)
      + on.system.slice(on.system.indexOf('- 亲密情节的硬事实:')).split('\n')[0].length + 1,
    );
  });

  it('关闭后总结、二次总结、合并摘要里也没有', () => {
    settings.apiSettings.injection.intimacy = false;
    for (const level of [1, 2]) {
      const { system, checklist } = buildResummaryPrompt({ user: '林舟', char: '苏晚', content: '[1] 摘要', level });
      none(system);
      none(checklist);
      expect(system).toContain('【关系线保留】');
    }
    none(buildBatchSummaryPrompt({ user: '林舟', char: '苏晚', time: '', history: '', content: '楼层' }).system);
  });

  it('关闭后自定义模板不补发协议;照内置模板保留了原文的自定义模板同样去掉', () => {
    settings.apiSettings.injection.intimacy = false;
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    none(buildSummaryPrompt(args).system);
    settings.apiSettings.prompts.summary = `CUSTOM\n${RULE_NPC_INTIMACY}\n- title:身份\n{{content}}`;
    const custom = buildSummaryPrompt(args);
    none(custom.user.split('【本轮之前的主线时间基准')[0]);
    expect(custom.user).toContain('- title:身份');
  });

  it('关闭后模型给出的记录不收,同一条里的其他字段照常;已有记录保留', () => {
    settings.apiSettings.injection.intimacy = false;
    const delta = finalizeDelta({ npcs: { update: [{ name, intimacy: second, outfit: '白衬衫' }], add: [{ name: '小周', intimacy: '共1次' }] } } as SummaryDelta, []);
    expect(delta.npcs!.update![0]).toEqual({ name, outfit: '白衬衫' });
    expect(delta.npcs!.add![0]).toEqual({ name: '小周' });
    // 之前记下的照常重放
    expect(deriveMemory([base(), patch({ intimacy: first }), message(delta)]).npcs.find(n => n.name === name)).toMatchObject({ intimacy: first, outfit: '白衬衫' });
  });

  it('关闭后不发给正文模型,打开后照发;手动修改不受开关影响', () => {
    useChat([base(), patch({ intimacy: first })]);
    settings.apiSettings.injection.intimacy = false;
    expect(inject.buildStateInjectionText()).not.toContain('亲密记录');
    expect(inject.buildStateInjectionText()).toContain(name);
    expect(editNpc(name, { intimacy: second })).toBe(true);
    expect(memory.npcs[0].intimacy).toBe(second);
    settings.apiSettings.injection.intimacy = true;
    expect(inject.buildStateInjectionText()).toContain(`${name}:${second}`);
  });

  it('角色卡照常显示已有记录,关闭时悬停说明注明不再记录也不发送', () => {
    const npc = deriveMemory([base(), patch({ intimacy: first })]).npcs[0];
    const field = () => npcCardFields(npc, 'main')!.find(f => f.key === 'intimacy')!;
    expect(field()).toMatchObject({ label: '亲密记录', value: first });
    expect(field().labelTitle).toContain('不论是否在场都会发给正文模型');
    settings.apiSettings.injection.intimacy = false;
    expect(field()).toMatchObject({ label: '亲密记录', value: first });
    expect(field().labelTitle).toContain('注入设置中未开启：不再记录，也不发送给正文模型');
  });

  it('关闭后的实际摘要流程:请求不带旧记录,模型硬给的不写入', async () => {
    settings.apiSettings.injection.intimacy = false;
    const target = message({}, '当晚两人在听潮旅馆做了两次。');
    delete target.extra!.bbs_leaf;
    const chat = [base(), patch({ intimacy: first }), target];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '9月19日夜两人在听潮旅馆过夜。', stateChanges: ['npcs'], timeStart: '2026/9/19 20:30', timeEnd: '2026/9/20 02:10',
      npcs: { update: [{ name, intimacy: second, outfit: '浴袍' }] },
    }));
    await summarizeFloor(2);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    none(request);
    expect(chat[2].extra!.bbs_leaf!.delta.npcs!.update![0]).toEqual({ name, outfit: '浴袍' });
    expect(memory.npcs[0]).toMatchObject({ intimacy: first, outfit: '浴袍' });
  });
});
