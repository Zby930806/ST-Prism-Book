import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { currentSummaryPromise, engineState, handleGenerationIntercept, maybeSummarizePrevAi, regenerateFloor, summarizeFloor } from './engine';
import { currentStoryTimeTarget, ensureOpeningStoryTime, initialTimeEditIssue, saveCurrentStoryTime, saveInitialStoryTime } from './initialTime';
import { memory, loadMemory, recomputeDerived, derivedMeta } from './store';
import { createEmptyMemory, MEMORY_KEY, MEMORY_VERSION } from './types';
import { cleanBody, FICTIONAL_OPENING_TIME, INITIAL_TIME_KEY, INITIAL_TIME_ORIGIN_KEY, initialStoryTime, latestStoryTime, parseTimeRange, TIME_PENDING, timeTagPrompt } from './timeTag';
import { calculateRelativeDays, parseStoryDate, relativeTimeLabel, weekdayLabel } from './timeRel';
import { refreshInjection } from './inject';
import { fitTimeTagPrompt } from './budget';

const savedSettings = JSON.stringify(settings.apiSettings);
const message = (mes = '她走进房间。'): STMessage => ({ name: '角色', is_user: false, is_system: false, mes });
let ctx: STContext;
let slots: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { autoSummaryEnabled: true, summaryOnlyMode: true, memoryBudgetTokens: 6000 });
  settings.apiSettings.prompts.summary = '';
  settings.apiSettings.prompts.timeTag = '';
  slots = new Map();
  ctx = { chat: [message()], chatMetadata: {}, name1: '玩家', name2: '角色', getCurrentChatId: () => 'new-chat',
    saveMetadata: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(), saveChat: vi.fn().mockResolvedValue(undefined),
    setExtensionPrompt: vi.fn((key: string, value: string) => slots.set(key, value)),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestCompletion').mockRejectedValue(new Error('测试禁止真实请求'));
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: TIME_PENDING, timeEnd: TIME_PENDING, time: TIME_PENDING }));
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  recomputeDerived();
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(savedSettings));
});

describe('正文边界与托管状态标签分离', () => {
  it.each(['', `<bbs_start>${TIME_PENDING}</bbs_start>`, '<bbs_start></bbs_start>'])('无已知时间仍只读取故事正文: %s', start => {
    const end = start ? '<bbs_end></bbs_end>' : '';
    ctx.chat[0].mes = '<thinking>思考秘密<bbs_start>1999</bbs_start></thinking>' + start + '她走进房间。' + end
      + '\n<bbs_items>\n获得 金币 ×2\n</bbs_items>\n<bbs_vars>\n变更 x: 1 → 2\n</bbs_vars>'
      + '<aftertalk>札记秘密<bbs_start>2999</bbs_start>提案<bbs_end>2999</bbs_end></aftertalk>';
    const body = cleanBody(ctx.chat[0].mes);
    expect(body).toContain('她走进房间。');
    for (const noise of ['思考秘密', '金币', '变更', '札记秘密', '2999', '1999']) expect(body).not.toContain(noise);
    expect(latestStoryTime(ctx.chat)).toBe('');
  });
  it('托管块里的伪时间边界不能裁掉正文；未闭合思考也不成为正文', () => {
    const noise = '<bbs_vars source="baibai-book" status="settled">说明 <bbs_start>2999</bbs_start>非正文</bbs_vars>';
    expect(cleanBody('真实正文' + noise + '<thinking>未闭合思考')).toBe('真实正文');
    expect(cleanBody('真实正文\n<bbs_vars>\n变更 x: <bbs_start>2999</bbs_start>\n</bbs_vars>')).toBe('真实正文');
    expect(cleanBody('真实正文<aftertalk>未闭合札记')).toBe('真实正文');
  });
  it('空时间边界仍是边界，不把边界外系统文本纳入摘要', () => {
    expect(cleanBody('前侧系统旁注<bbs_start></bbs_start>真实正文<bbs_end></bbs_end>后侧系统旁注')).toBe('(起始时间:)真实正文(结束时间:)');
    expect(parseTimeRange(`<bbs_start>${TIME_PENDING}</bbs_start>正文<bbs_end>初秋</bbs_end>`)).toEqual({ start: undefined, end: '初秋' });
  });
});

describe('新聊天开场时间的正式保存与消费', () => {
  it('设置→元数据→重载→主对话与摘要请求共用开场时间，不改消息', async () => {
    const original = structuredClone(ctx.chat);
    await saveInitialStoryTime('庆历四年初秋');
    expect(ctx.saveMetadata).toHaveBeenCalledOnce();
    expect(ctx.chatMetadata[INITIAL_TIME_KEY]).toBe('庆历四年初秋');
    expect(ctx.chat).toEqual(original);
    loadMemory(); refreshInjection();
    expect(derivedMeta.latestStoryTime).toBe('庆历四年初秋');
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:庆历四年初秋');
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: '庆历四年初秋', timeEnd: '庆历四年初秋' }));
    await summarizeFloor(0);
    expect(vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n')).toContain('庆历四年初秋');
    expect(ctx.chat[0].extra?.bbs_leaf?.timeEnd).toBe('庆历四年初秋');
    expect(ctx.chat[0].mes).toBe(original[0].mes);
    expect(memory.state.time).toBe('庆历四年初秋');
  });
  it('已有正文时间优先于开场设定，摘要错误时间不能覆盖正文锚点', async () => {
    await saveInitialStoryTime('2030/1/1');
    ctx.chat[0].mes = '<bbs_start>2030/1/2 上午</bbs_start>她想起1999年的往事。<bbs_end>2030/1/2 上午</bbs_end>';
    refreshInjection();
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:2030/1/2 上午');
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她回忆往事。', stateChanges: [], timeStart: '1999', timeEnd: '1999' }));
    await summarizeFloor(0);
    expect(memory.state.time).toBe('2030/1/2 上午');
    expect(ctx.chat[0].extra?.bbs_leaf?.timeStart).toBe('2030/1/2 上午');
  });
  it('没有配置不从回忆或现实日期初始化；切换新聊天无时间泄漏', async () => {
    await saveInitialStoryTime('2030/1/1');
    ctx = { ...ctx, chat: [message('她想起1999年的往事。')], chatMetadata: {}, getCurrentChatId: () => 'another' };
    loadMemory(); refreshInjection();
    expect(initialStoryTime()).toBe('');
    expect(derivedMeta.latestStoryTime).toBe('');
    expect(slots.get('baibai_book_time_tag')).not.toContain('2030/1/1');
    expect(slots.get('baibai_book_time_tag')).not.toContain('1999');
    expect(slots.get('baibai_book_time_tag')).toContain('纯闪回沿用主线时间');
  });
  it('保存失败恢复内存；切换期间完成保存不刷新其他聊天', async () => {
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('磁盘失败'));
    await expect(saveInitialStoryTime('初秋')).rejects.toThrow('没能确认保存成功');
    expect(initialStoryTime()).toBe('');
    let finish!: () => void;
    vi.mocked(ctx.saveMetadata).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    const old = ctx;
    const pending = saveInitialStoryTime('初秋');
    ctx = { ...ctx, chat: [], chatMetadata: {}, getCurrentChatId: () => 'another' };
    finish(); await pending;
    expect(old.chatMetadata[INITIAL_TIME_KEY]).toBe('初秋');
    expect(initialStoryTime()).toBe('');
    expect(ctx.setExtensionPrompt).not.toHaveBeenCalled();
  });
  it('重复保存被拒绝，失败不覆盖外部更新，也不泄露底层异常', async () => {
    let reject!: (e: Error) => void;
    vi.mocked(ctx.saveMetadata).mockImplementationOnce(() => new Promise<void>((_, r) => { reject = r; }));
    const pending = saveInitialStoryTime('初秋');
    await expect(saveInitialStoryTime('深秋')).rejects.toThrow('正在保存');
    ctx.chatMetadata[INITIAL_TIME_KEY] = '外部明确设置';
    reject(new Error('secret-token-test-value'));
    const error = await pending.catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('没能确认保存成功');
    expect((error as Error).message).not.toContain('secret-token');
    expect(ctx.chatMetadata[INITIAL_TIME_KEY]).toBe('外部明确设置');
  });
  it('宿主复用context原地更换chat引用时，不刷新新聊天', async () => {
    let finish!: () => void;
    vi.mocked(ctx.saveMetadata).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    const pending = saveInitialStoryTime('初秋');
    ctx.chat = [message('另一段新正文')];
    finish(); await pending;
    expect(ctx.setExtensionPrompt).not.toHaveBeenCalled();
  });
  it('自动开场摘要无时间时仍给出定位到该楼的手动补填入口说明', async () => {
    await summarizeFloor(0);
    expect(initialTimeEditIssue()).toContain('编辑 #0 楼');
    expect(initialTimeEditIssue()).toContain('起止时间');
  });
  it('旧聊天、旧 L1/L2 与已有叶子不自动回写或重新摘要', async () => {
    memory.summaries.push({ id: 'old-l2', text: '旧总结', level: 2, childIds: [], auto: false, createdAt: 1 });
    const before = JSON.stringify(memory.summaries);
    expect(initialTimeEditIssue()).toContain('开场时间不能再改');
    await expect(saveInitialStoryTime('初秋')).rejects.toThrow('开场时间不能再改');
    expect(JSON.stringify(memory.summaries)).toBe(before);
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    memory.summaries = [];
    ctx.chat.push(message());
    await expect(saveInitialStoryTime('初秋')).rejects.toThrow('开场时间不能再改');
  });
});

describe('未知时间不是摘要失败', () => {
  it.each(['<thinking>秘密思考</thinking><aftertalk>秘密札记</aftertalk>', '<bbs_start></bbs_start><bbs_end>时间待设定</bbs_end>'])('只有元数据/旁注不能冒充有效正文: %s', text => {
    ctx.chat[0].mes = text;
    return summarizeFloor(0).then(result => {
      expect(result).toBe('failed');
      expect(client.requestViaMainApi).not.toHaveBeenCalled();
      expect(ctx.chat[0].extra?.bbs_leaf).toBeUndefined();
      // 报错写清原因和改法:编辑正文、标为番外(及其位置)或删除这一楼
      expect(engineState.lastError).toContain('清洗后没有故事正文');
      expect(engineState.lastError).toContain('「未摘要楼层」中点「标为番外」');
      expect(engineState.lastError).toContain('设置 → 基本设置');
    });
  });
  it('前置系统通知不进入摘要材料或证据来源', async () => {
    ctx.chat.unshift({ ...message('系统旁注秘密'), is_system: true });
    await summarizeFloor(1);
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).not.toContain('系统旁注秘密');
    expect(ctx.chat[1].extra?.bbs_leaf?.text).toBe('她走进房间。');
  });
  it.each([TIME_PENDING, '', undefined])('正式摘要接受未知端点 %s，且不把协议状态存成时钟', async value => {
    ctx.chat[0].mes = '<bbs_start></bbs_start>她走进房间。<bbs_end></bbs_end><aftertalk>札记秘密</aftertalk>';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: value, timeEnd: value, time: value }));
    await summarizeFloor(0);
    expect(ctx.chat[0].extra?.bbs_leaf?.text).toBe('她走进房间。');
    expect(ctx.chat[0].extra?.bbs_leaf?.timeStart).toBeUndefined();
    expect(ctx.chat[0].extra?.bbs_leaf?.delta.time).toBeUndefined();
    expect(memory.state.time).toBe('');
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).not.toContain('札记秘密');
    expect(sent).toContain('不因此拒绝摘要');
  });
  it('新开场空时间可完成摘要并放行，无空标签修复性回写', async () => {
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: FICTIONAL_OPENING_TIME, timeEnd: FICTIONAL_OPENING_TIME }));
    const original = ctx.chat[0].mes;
    const abort = vi.fn();
    expect(await handleGenerationIntercept('normal', abort)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(ctx.chat[0].extra?.bbs_leaf?.text).toBe('她走进房间。');
    expect(ctx.chat[0].mes).toBe(original);
  });
  it('自定义摘要兼容协议不再强迫未知时间补全日期', async () => {
    await saveInitialStoryTime('庆历四年初秋');
    settings.apiSettings.prompts.summary = '请摘要: {{content}}';
    await summarizeFloor(0);
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('统一虚构起点');
    expect(sent).not.toContain('无依据写“时间待设定”');
    expect(sent).not.toContain('写相同的完整时间');
    expect(sent).toContain('庆历四年初秋');
    expect(ctx.chat[0].extra?.bbs_leaf?.text).toBe('她走进房间。');
  });
  it('默认预算下时间协议不会被整个丢弃', async () => {
    await saveInitialStoryTime('2030/1/1 上午');
    expect(fitTimeTagPrompt(timeTagPrompt())).toBe(timeTagPrompt());
    expect(slots.get('baibai_book_time_tag')).toContain('<bbs_start>');
  });
});

describe('一次性虚构开场时钟的生产链', () => {
  const response = (time: string) => JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: time, timeEnd: time });
  it('自动开场摘要前持久化一次，重载/生成复用，下一楼不重置', async () => {
    ctx.chat[0].mes = '<bbs_start></bbs_start>她走进房间。<bbs_end></bbs_end>';
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      expect(ctx.chatMetadata[INITIAL_TIME_KEY]).toBe(FICTIONAL_OPENING_TIME);
      expect(ctx.saveMetadata).toHaveBeenCalledOnce();
      expect(messages.map(m => m.content).join('\n')).toContain('程序虚构后备起点');
      return response(FICTIONAL_OPENING_TIME);
    });
    await maybeSummarizePrevAi(false, false, true);
    expect(ctx.chat[0].extra?.bbs_leaf?.timeEnd).toBe(FICTIONAL_OPENING_TIME);
    expect(ctx.chatMetadata[INITIAL_TIME_ORIGIN_KEY]).toBe('fictional');
    expect(memory.state.time).toBe(FICTIONAL_OPENING_TIME);
    loadMemory();
    await ensureOpeningStoryTime();
    expect(ctx.saveMetadata).toHaveBeenCalledOnce();
    expect(slots.get('baibai_book_time_tag')).toContain(FICTIONAL_OPENING_TIME);
    expect(slots.get('baibai_book_time_tag')).not.toContain(TIME_PENDING);
    ctx.chat.push(message('故事第2天，她再次走进房间。'));
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('故事第2天 08:00'));
    await maybeSummarizePrevAi(false, false, true);
    expect(ctx.chatMetadata[INITIAL_TIME_KEY]).toBe(FICTIONAL_OPENING_TIME);
    expect(memory.state.time).toBe('故事第2天 08:00');
    expect(ctx.saveMetadata).toHaveBeenCalledOnce();
  });
  it('无开场白时，首次正常生成前也初始化；可在建档前编辑', async () => {
    ctx.chat = [];
    expect(await handleGenerationIntercept('normal', vi.fn())).toBe(false);
    expect(initialStoryTime()).toBe(FICTIONAL_OPENING_TIME);
    await saveInitialStoryTime('霜月初三');
    await ensureOpeningStoryTime();
    expect(initialStoryTime()).toBe('霜月初三');
    expect(ctx.chatMetadata[INITIAL_TIME_ORIGIN_KEY]).toBe('user');
  });
  it('正文标签已有日期时不初始化；自然语言明示日期由摘要优先采用', async () => {
    ctx.chat[0].mes = '<bbs_start>永和十五年八月初七</bbs_start>她进门。<bbs_end>永和十五年八月初七</bbs_end>';
    await ensureOpeningStoryTime();
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    ctx.chat[0].mes = '永和十五年八月初七，她走进房间。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('永和十五年八月初七'));
    await maybeSummarizePrevAi(false, false, true);
    expect(memory.state.time).toBe('永和十五年八月初七');
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:永和十五年八月初七');
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('本楼正文/用户明确的主线时间优先');
  });
  it('旧聊天元数据或既有多轮/摘要不自动回填，手动补摘仍兼容空时间', async () => {
    ctx.chatMetadata[MEMORY_KEY] = { ...createEmptyMemory(), state: { time: '既有旧时间', location: '', sceneFocus: null } };
    await ensureOpeningStoryTime();
    expect(initialStoryTime()).toBe('');
    await summarizeFloor(0);
    expect(ctx.chat[0].extra?.bbs_leaf?.text).toBe('她走进房间。');
    expect(initialStoryTime()).toBe('');
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it.each(['深夜', '黄昏', '清晨'])('仅有主线时段%s也优先保留，不能被08:00改写', async period => {
    ctx.chat[0].mes = `${period}，她走进房间。`;
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response(period));
    await maybeSummarizePrevAi(false, false, true);
    expect(ctx.chat[0].extra?.bbs_leaf?.timeStart).toBe(period);
    expect(ctx.chat[0].extra?.bbs_leaf?.timeEnd).toBe(period);
    expect(memory.state.time).toBe(period);
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:' + period);
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('仅深夜/黄昏/清晨等时段也算依据,不得被虚构08:00覆盖');
  });
  it('只有第一轮闪回年份时，仍共用虚构主线起点，不从回忆初始化当前年', async () => {
    ctx.chat[0].mes = '她回忆1999年的深夜往事，没有交代此刻的时间。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response(FICTIONAL_OPENING_TIME));
    await maybeSummarizePrevAi(false, false, true);
    expect(initialStoryTime()).toBe(FICTIONAL_OPENING_TIME);
    expect(memory.state.time).toBe(FICTIONAL_OPENING_TIME);
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('不得以回忆覆盖当前时钟');
    expect(slots.get('baibai_book_time_tag')).not.toContain('1999');
  });
  it('并发初始化共享同一次保存，保存失败不放行首轮生成', async () => {
    let finish!: () => void;
    vi.mocked(ctx.saveMetadata).mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    const first = ensureOpeningStoryTime(); const second = ensureOpeningStoryTime();
    expect(ctx.saveMetadata).toHaveBeenCalledOnce();
    finish(); await Promise.all([first, second]);
    ctx = { ...ctx, chatMetadata: {}, chat: [], getCurrentChatId: () => 'fresh' };
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('secret'));
    const abort = vi.fn();
    expect(await handleGenerationIntercept('normal', abort)).toBe(true);
    expect(abort).toHaveBeenCalledWith(true);
    expect(engineState.lastError).not.toContain('secret');
    expect(initialStoryTime()).toBe('');
  });
  it('相对故事时间只比较同轴日差，不混入公历、架空年月或星期', () => {
    expect(parseStoryDate(FICTIONAL_OPENING_TIME)).toMatchObject({ type: 'relative', day: 1 });
    expect(calculateRelativeDays(FICTIONAL_OPENING_TIME, '故事第3天 09:00')).toBe(2);
    expect(relativeTimeLabel(FICTIONAL_OPENING_TIME, '故事第2天 09:00')).toBe('昨天');
    for (const other of ['2031/1/3', '霜月初三', '庆历四年初秋']) {
      expect(calculateRelativeDays(FICTIONAL_OPENING_TIME, other)).toBeNull();
      expect(calculateRelativeDays(other, FICTIONAL_OPENING_TIME)).toBeNull();
    }
    expect(weekdayLabel(FICTIONAL_OPENING_TIME)).toBe('');
  });
  it.each(['', TIME_PENDING, undefined])('新开场模型仍返回空/未知端点 %s：一次请求直接保存统一起点', async time => {
    ctx.chat[0].mes = '<bbs_start></bbs_start>她走进房间。<bbs_end></bbs_end>';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: time, timeEnd: time }));
    await maybeSummarizePrevAi(false, false, true);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(ctx.chat[0].extra?.bbs_leaf).toMatchObject({ text: '她走进房间。', timeStart: FICTIONAL_OPENING_TIME, timeEnd: FICTIONAL_OPENING_TIME });
    expect(memory.state.time).toBe(FICTIONAL_OPENING_TIME);
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:' + FICTIONAL_OPENING_TIME);
    expect(engineState.lastError).toBe('');
  });
  it.each(['timeStart', 'timeEnd'] as const)('模型仅填写%s时另一端沿用该端，不猜时长', async field => {
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: '', timeEnd: '', [field]: '故事第1天 09:00' }));
    await maybeSummarizePrevAi(false, false, true);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(ctx.chat[0].extra?.bbs_leaf).toMatchObject({ timeStart: '故事第1天 09:00', timeEnd: '故事第1天 09:00' });
  });
  it.each(['both', 'timeStart', 'timeEnd'])('后续正文仅写夜晚，保留模型%s的完整日期精度，只补缺端点', async fields => {
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('故事第5天 20:00'));
    await maybeSummarizePrevAi(false, false, true);
    ctx.chat.push(message('夜晚，她走进房间。'));
    const timeStart = fields === 'timeEnd' ? '' : '故事第5天 21:00';
    const timeEnd = fields === 'timeStart' ? '' : '故事第5天 22:00';
    vi.mocked(client.requestViaMainApi).mockClear().mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart, timeEnd }));
    await maybeSummarizePrevAi(false, false, true);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(ctx.chat[1].extra?.bbs_leaf).toMatchObject({ timeStart: timeStart || timeEnd, timeEnd: timeEnd || timeStart });
    expect(memory.state.time).toBe(timeEnd || timeStart);
  });
  it('真正开场也不覆盖模型已给出的非默认完整时间', async () => {
    ctx.chat[0].mes = '夜晚，她走进房间。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('故事第1天 21:00'));
    await maybeSummarizePrevAi(false, false, true);
    expect(ctx.chat[0].extra?.bbs_leaf).toMatchObject({ timeStart: '故事第1天 21:00', timeEnd: '故事第1天 21:00' });
  });
  it('真正开场的明确时段仅纠正照抄的虚构默认值', async () => {
    ctx.chat[0].mes = '夜晚，她走进房间。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response(FICTIONAL_OPENING_TIME));
    await maybeSummarizePrevAi(false, false, true);
    expect(ctx.chat[0].extra?.bbs_leaf).toMatchObject({ timeStart: '夜晚', timeEnd: '夜晚' });
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
  });
  it.each(['深夜', '黄昏', '清晨', '当前时间：永和十五年八月初七'])('模型空端点时，本地明确原文%s优先虚构08:00', async prefix => {
    ctx.chat[0].mes = prefix + '，她走进房间。';
    const expected = prefix.replace('当前时间：', '');
    await maybeSummarizePrevAi(false, false, true);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(ctx.chat[0].extra?.bbs_leaf).toMatchObject({ timeStart: expected, timeEnd: expected });
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:' + expected);
  });
  it.each([
    { version: MEMORY_VERSION, summaries: [] },
    { version: MEMORY_VERSION, summaries: [], varsTemplate: { json: { coins: 2 }, meaning: '金币', rule: '' } },
    createEmptyMemory(),
  ])('明确空v3容器/变量模板不挡住新开场初始化', async raw => {
    ctx.chatMetadata[MEMORY_KEY] = raw;
    await maybeSummarizePrevAi(false, false, true);
    expect(initialStoryTime()).toBe(FICTIONAL_OPENING_TIME);
    expect(ctx.chat[0].extra?.bbs_leaf?.timeEnd).toBe(FICTIONAL_OPENING_TIME);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
  });
  it.each([
    { version: 999, summaries: [] },
    { version: MEMORY_VERSION, summaries: [], unknownHistory: ['旧记录'] },
  ])('未知版本或非空未知历史保持不动', async raw => {
    ctx.chatMetadata[MEMORY_KEY] = raw;
    const before = JSON.stringify(ctx.chatMetadata);
    await ensureOpeningStoryTime();
    expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
    expect(initialStoryTime()).toBe('');
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
});

describe('旧聊天补设当前故事时间', () => {
  const noTime = JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: TIME_PENDING, timeEnd: TIME_PENDING, time: TIME_PENDING });
  const userMessage = (mes = '继续。'): STMessage => ({ ...message(mes), name: '玩家', is_user: true });
  /** 旧聊天：三层回复都已摘要，但正文没有时间标签、也没有开场时间，摘要里都没有时间。 */
  async function oldChat(summarized = [0, 2, 4]) {
    ctx.chat = [message('第一层。'), userMessage(), message('第二层。'), userMessage('再继续。'), message('第三层。')];
    vi.mocked(client.requestViaMainApi).mockResolvedValue(noTime);
    for (const floor of summarized) await summarizeFloor(floor);
    expect(ctx.chat.filter(m => m.extra?.bbs_leaf)).toHaveLength(summarized.length);
    expect(latestStoryTime(ctx.chat)).toBe('');
    vi.mocked(client.requestViaMainApi).mockClear();
    vi.mocked(ctx.saveChat).mockClear();
  }

  it('已经开始的聊天不能再设开场时间，但可以设定截至最新一层摘要的当前时间', async () => {
    await oldChat();
    expect(initialTimeEditIssue()).toContain('开场时间不能再改');
    expect(currentStoryTimeTarget()).toEqual({ floor: 4, issue: '' });
  });

  it('只写最新一层摘要的结束时间和状态时间：不改正文、不改其他摘要、不写开场时间', async () => {
    await oldChat();
    const before = structuredClone(ctx.chat);
    expect(await saveCurrentStoryTime('永和十五年八月初七 傍晚')).toBe(4);
    expect(ctx.saveChat).toHaveBeenCalledOnce();
    const leaf = ctx.chat[4].extra?.bbs_leaf;
    expect(leaf).toMatchObject({ id: before[4].extra?.bbs_leaf?.id, text: before[4].extra?.bbs_leaf?.text, timeEnd: '永和十五年八月初七 傍晚', delta: { time: '永和十五年八月初七 傍晚' } });
    expect(leaf?.timeStart).toBeUndefined();
    for (const floor of [0, 1, 2, 3]) expect(ctx.chat[floor]).toEqual(before[floor]);
    expect(ctx.chat.map(m => m.mes)).toEqual(before.map(m => m.mes));
    expect(ctx.chatMetadata[INITIAL_TIME_KEY]).toBeUndefined();
    expect(initialStoryTime()).toBe('');
    // 年龄、相对时间、注入用的「现在」都有了
    expect(derivedMeta.latestStoryTime).toBe('永和十五年八月初七 傍晚');
    expect(memory.state.time).toBe('永和十五年八月初七 傍晚');
    expect(slots.get('baibai_book_time_tag')).toContain('当前主线时间基准:永和十五年八月初七 傍晚');
    // 设定后不能再补设，修正改走摘要列表
    expect(currentStoryTimeTarget().issue).toContain('已经有故事时间（永和十五年八月初七 傍晚，来自 #4 楼）');
    await expect(saveCurrentStoryTime('故事第2天')).rejects.toThrow('已经有故事时间');
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
  });

  it('之后的楼层从这个时间往后推算；重新摘要更早的楼层拿不到它', async () => {
    await oldChat();
    await saveCurrentStoryTime('故事第30天 20:00');
    ctx.chat.push(userMessage('又过了一会儿。'), message('第四层。'));
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '她走进房间。', stateChanges: [], timeStart: '故事第30天 21:00', timeEnd: '故事第30天 22:00' }));
    await summarizeFloor(6);
    expect(vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n')).toContain('故事第30天 20:00');
    expect(ctx.chat[6].extra?.bbs_leaf).toMatchObject({ timeStart: '故事第30天 21:00', timeEnd: '故事第30天 22:00' });
    expect(memory.state.time).toBe('故事第30天 22:00');

    vi.mocked(client.requestViaMainApi).mockClear().mockResolvedValue(noTime);
    expect(await regenerateFloor(2)).toBe(true);
    expect(vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n')).not.toContain('故事第30天');
    expect(ctx.chat[2].extra?.bbs_leaf?.timeEnd).toBeUndefined();
    expect(ctx.chat[4].extra?.bbs_leaf?.timeEnd).toBe('故事第30天 20:00');
  });

  it('最新几层还没摘要时先补摘；完全没有摘要时先补摘最新一层', async () => {
    await oldChat([0]);
    expect(currentStoryTimeTarget()).toMatchObject({ floor: -1 });
    expect(currentStoryTimeTarget().issue).toContain('#2–#4 还有 2 层没有摘要');
    await oldChat([0, 2]); // 只剩最后一层没摘（正常状态）
    expect(currentStoryTimeTarget()).toEqual({ floor: 2, issue: '' });
    ctx.chat = [message('第一层。'), userMessage(), message('第二层。')];
    recomputeDerived();
    expect(currentStoryTimeTarget().issue).toContain('还没有楼层摘要');
    await expect(saveCurrentStoryTime('初秋')).rejects.toThrow('先补摘');
  });

  it('旧版合并时间标签、正文时间标签都算已有时间；摘要进行中不能设定；不接受空值和标签', async () => {
    await oldChat();
    const leaf = ctx.chat[0].extra!.bbs_leaf!;
    ctx.chat[0].extra = { ...ctx.chat[0].extra, bbs_leaf: { ...leaf, timeLabel: '初春 - 初夏' } };
    recomputeDerived();
    expect(currentStoryTimeTarget().issue).toContain('已经有故事时间');
    ctx.chat[0].extra = { ...ctx.chat[0].extra, bbs_leaf: leaf };
    ctx.chat[2].mes = '<bbs_start>霜月初三</bbs_start>第二层。<bbs_end>霜月初三</bbs_end>';
    expect(currentStoryTimeTarget().issue).toContain('来自 #2 楼');
    ctx.chat[2].mes = '第二层。';
    expect(currentStoryTimeTarget().issue).toBe('');
    engineState.running = true;
    expect(currentStoryTimeTarget().issue).toContain('摘要正在进行');
    engineState.running = false;
    await expect(saveCurrentStoryTime('未知')).rejects.toThrow('具体的故事时间');
    await expect(saveCurrentStoryTime('<bbs_end>x</bbs_end>')).rejects.toThrow('具体的故事时间');
    expect(ctx.saveChat).not.toHaveBeenCalled();
  });

  it('保存失败时撤回，摘要保持原样', async () => {
    await oldChat();
    const before = structuredClone(ctx.chat[4]);
    vi.mocked(ctx.saveChat).mockRejectedValueOnce(new Error('secret-disk-error'));
    const error = await saveCurrentStoryTime('初秋').catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('没能确认保存成功');
    expect((error as Error).message).not.toContain('secret');
    expect(ctx.chat[4]).toEqual(before);
    expect(derivedMeta.latestStoryTime).toBe('');
    expect(currentStoryTimeTarget()).toEqual({ floor: 4, issue: '' });
  });
});
