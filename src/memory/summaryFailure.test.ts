import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import { classifyHttpFailure, truncatedReply } from '@/api/errors';
import type { ApiChannel } from '@/api/settings';
import type { STContext, STMessage } from '@/st/context';
import { checkResummary, currentSummaryPromise, engineState, summarizeFloor } from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

const saved = JSON.stringify(settings.apiSettings);
const channel: ApiChannel = {
  id: 'main-channel', name: '主力', url: 'https://relay.example/v1', key: 'k', model: 'm', temperature: 1,
  maxTokens: 4096, timeoutSec: 60, stream: false, prefill: true, excludeParams: [], reasoningEffort: '',
};
const ai = (text: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra: {} });
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ok = (summary: string) => JSON.stringify({ summary, stateChanges: [] });
let chat: STMessage[];

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 2, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  chat = [user('出发吧。'), ai('林舟推开门，雨已经停了。')];
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'failure-test', chatMetadata: {},
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  recomputeDerived();
  Object.assign(engineState, { lastError: '', lastFailure: null });
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

function useChannel() {
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(channel);
  return vi.spyOn(client, 'requestCompletion');
}
function useMainApi() {
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  return vi.spyOn(client, 'requestViaMainApi');
}

describe('摘要失败说清楚原因和去哪里改', () => {
  it('副 API 截断：说明是哪一楼、被截断、当前上限和渠道位置，不重复请求', async () => {
    const send = useChannel().mockRejectedValue(truncatedReply({ finishReason: 'length', maxTokens: 4096 }, '{"summary":"林舟推开'));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(engineState.lastError).toContain('楼层 #1 摘要未完成：回复被截断');
    expect(engineState.lastError).toContain('当前最大输出是 4096 tokens');
    expect(engineState.lastError).toContain('「设置 → 副 API → 主力」');
    expect(engineState.lastFailure).toMatchObject({ message: engineState.lastError, detail: expect.stringContaining('finish_reason=length') });
    expect(chat[1].extra?.bbs_leaf).toBeUndefined();
  });

  it('截断发生在完整 JSON 之后时照常保存结果', async () => {
    useChannel().mockRejectedValue(truncatedReply({ finishReason: 'length', maxTokens: 4096 }, ok('林舟推门出发。') + '\n补充说明写到一半'));
    await summarizeFloor(1);
    expect(engineState.lastError).toBe('');
    expect(chat[1].extra?.bbs_leaf).toMatchObject({ text: '林舟推门出发。' });
  });

  it('主 API 拿不到结束原因：从半截 JSON 判断为截断，并建议改用可设上限的副 API', async () => {
    const send = useMainApi().mockResolvedValue('<thinking>核对完毕</thinking>{"summary":"林舟推开门，雨');
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(engineState.lastError).toContain('楼层 #1 摘要未完成：回复不完整（JSON 写到一半就结束了）');
    expect(engineState.lastError).toContain('副 API');
  });

  it('密钥错误不重试；服务端临时故障按设置重试', async () => {
    const send = useChannel().mockRejectedValue(classifyHttpFailure({ status: 401 }));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(engineState.lastError).toContain('楼层 #1 摘要未完成：API 密钥无效或没有权限（HTTP 401）');
    send.mockReset().mockRejectedValueOnce(classifyHttpFailure({ status: 503 })).mockResolvedValueOnce(ok('林舟出发。'));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toBe('');
    expect(chat[1].extra?.bbs_leaf).toMatchObject({ text: '林舟出发。' });
  });

  it('模型拒答（没有 JSON）仍走校验纠错，最后说明没有按格式输出', async () => {
    settings.apiSettings.summaryMaxRetries = 1;
    const send = useMainApi().mockResolvedValue('抱歉，我无法总结这段内容。');
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].some(m => m.content.includes('上一次摘要结果未通过校验'))).toBe(true);
    expect(engineState.lastError).toContain('楼层 #1 摘要未保存');
    expect(engineState.lastFailure).toBeNull();
  });
});

describe('总结失败的说明', () => {
  beforeEach(() => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, leafKeepRecent: 0, summaryMaxRetries: 0 });
    chat.splice(0, chat.length, ai('第一楼'), ai('第二楼'));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: 'leaf-' + i, text: '摘要' + i, delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
  });

  it.each([
    ['好的，我来总结。', '总结失败：模型没有按要求输出 JSON'],
    ['{"summary":"两楼合在一起写到一半', '总结未完成：回复不完整（JSON 写到一半就结束了）'],
  ])('%s', async (reply, expected) => {
    useMainApi().mockResolvedValue(reply);
    expect(await checkResummary()).toBe(0);
    expect(engineState.lastError).toContain(expected);
    expect(memory.summaries).toHaveLength(0);
  });
});

// 格式合法、内容却不是摘要(拒答的话、对输出要求的复述)。两句都是真实模型对照里出现过的,见 summarySanity.ts。
describe('交回的不是摘要时不保存', () => {
  const ECHO = '检查必需项是否齐全，然后只输出 JSON。';
  const REFUSAL = '（由于任务要求包含我无法生成的露骨性内容，未能完成完整摘要。）';
  const MERGED = '第一天林舟和苏晚在书屋盘点旧书，清出三箱要退的；第二天两人把退货送到物流点，苏晚付了运费，林舟记下单号。';

  it('逐楼摘要：附原因重试，重试写对了照常保存', async () => {
    settings.apiSettings.summaryMaxRetries = 1;
    const send = useMainApi().mockResolvedValueOnce(ok(ECHO)).mockResolvedValueOnce(ok('林舟推门出发。'));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].some(m => m.content.includes('summary 不是这一楼的摘要（内容是拒答或对输出要求的复述，不是剧情）'))).toBe(true);
    expect(engineState.lastError).toBe('');
    expect(chat[1].extra?.bbs_leaf).toMatchObject({ text: '林舟推门出发。' });
  });

  it('逐楼摘要：重试后仍然不是摘要，这一楼不保存，仍待摘要', async () => {
    settings.apiSettings.summaryMaxRetries = 1;
    const send = useMainApi().mockResolvedValue(ok(ECHO));
    await summarizeFloor(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toContain('楼层 #1 摘要未保存');
    expect(engineState.lastError).toContain('summary 不是这一楼的摘要');
    expect(chat[1].extra?.bbs_leaf).toBeUndefined();
  });

  it('总结：拒答的话不当成总结保存；重试写对了照常保存', async () => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, leafKeepRecent: 0, summaryMaxRetries: 1 });
    chat.splice(0, chat.length, ai('第一楼'), ai('第二楼'));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: 'day-' + i, text: `第${i + 1}天。` + '林舟和苏晚在书屋盘点旧书。'.repeat(40), delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
    const send = useMainApi().mockResolvedValue(JSON.stringify({ summary: REFUSAL }));
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toContain('总结失败：模型交回的不是总结（内容是拒答或对输出要求的复述，不是剧情），没有保存');
    expect(memory.summaries).toHaveLength(0);

    send.mockReset().mockResolvedValueOnce(JSON.stringify({ summary: REFUSAL })).mockResolvedValueOnce(JSON.stringify({ summary: MERGED }));
    expect(await checkResummary()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(memory.summaries).toHaveLength(1);
    expect(memory.summaries[0]).toMatchObject({ level: 1, text: MERGED, childIds: ['day-0', 'day-1'] });
  });

  it('总结：一千多字的输入只交回一句话，不保存', async () => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, leafKeepRecent: 0, summaryMaxRetries: 0 });
    chat.splice(0, chat.length, ai('第一楼'), ai('第二楼'));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: 'day-' + i, text: `第${i + 1}天。` + '林舟和苏晚在书屋盘点旧书。'.repeat(40), delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
    useMainApi().mockResolvedValue(JSON.stringify({ summary: '两人这两天都在书屋。' }));
    expect(await checkResummary()).toBe(0);
    expect(engineState.lastError).toMatch(/总结失败：模型交回的不是总结（只有 10 字，而输入有 \d{4} 字），没有保存/);
    expect(memory.summaries).toHaveLength(0);
  });

  // 真实模型对照里出现过:很长的总结被模型拆成 summary、summary_continued、summary_continued2……几个字段,只取 summary 时后面的剧情没有存下来
  it('总结正文被拆成几个字段时按先后接回去，不只存前一半；模型自己加的备注和字数不接', async () => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, leafKeepRecent: 0, summaryMaxRetries: 0 });
    chat.splice(0, chat.length, ai('第一楼'), ai('第二楼'));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: 'part-' + i, text: `第${i + 1}天。` + '林舟和苏晚在书屋盘点旧书。'.repeat(40), delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
    const first = '第一天林舟和苏晚在书屋盘点旧书，清出三箱要退的，苏晚把书名抄在本子上。';
    const second = '第二天两人把退货送到物流点，苏晚付了运费，林舟记下单号。';
    const third = '晚上苏晚请林舟吃面，约好月底再盘一次。';
    useMainApi().mockResolvedValue(`<thinking>核对</thinking>${JSON.stringify({
      summary: first, summary_continued: second, summary_continued2: third,
      summary_note: '按输入事实整理，未补未知细节。', summary_chars: 1030, summary_length: '约 80 字', note: '这一项不是正文',
    })}`);
    expect(await checkResummary()).toBe(1);
    expect(memory.summaries[0].text).toBe(first + second + third);
  });
});

// 精简版要求每条输入里的场合都写到;写完后核对有没有整条没写到的输入(summaryCoverage.ts)。旧版允许整件事不写,不核对。
describe('精简版：总结漏掉了整条输入', () => {
  const LEAVES = [
    '三月初七傍晚，阿青把借来的灯笼还给云来酒楼的掌柜。掌柜托他带一封信给临水镇的周账房，说信里是今年的茶钱账目，要亲手交到；阿青答应十日内送到，掌柜先付了他三钱银子的脚力，余下的回来再结。临走时掌柜叮嘱他别走北边的山路，那一带近来不太平。',
    '三月初九，阿青搭的货船在柳林渡口被巡检拦下验路引，同船一个卖布的客商拿不出文书，全船耽搁了半日。阿青替船家补交了二两银子的过渡钱才放行，船家抱怨误了潮水，答应到了临水镇把这二两还给他，还另送他一包晒干的鱼。',
    '三月十五日，周账房从乡下收账回到临水镇，阿青在码头边的茶棚里把信交给他。周账房看完信说账目对得上，托阿青带回一包账册和一张收条，要他月底前交给掌柜；又说自己四月要去省城，之后的信改寄到他侄子周小满那里。',
    '三月二十日，阿青回到云来酒楼，掌柜清点账册时发现少了去年冬天的一本，让他回临水镇再问一趟周账房。阿青说来回要六天，掌柜答应再加五钱银子，并把那张收条锁进了柜台下面的铁盒里，钥匙只有掌柜自己有。',
  ];
  const WROTE = [
    '三月初七傍晚，阿青把借来的灯笼还给云来酒楼的掌柜，掌柜托他带一封信给临水镇的周账房，阿青答应十日内送到，掌柜先付了三钱银子的脚力，叮嘱他别走北边的山路。',
    '三月初九，货船在柳林渡口被巡检拦下验路引，耽搁了半日，阿青替船家补交了二两银子的过渡钱才放行，船家答应到了临水镇把这二两还给他。',
    '三月十五日，周账房回到临水镇，阿青在码头边的茶棚里把信交给他；周账房托阿青带回一包账册和一张收条，要他月底前交给掌柜，又说之后的信改寄到他侄子周小满那里。',
    '三月二十日，阿青回到云来酒楼，掌柜清点账册时发现少了去年冬天的一本，让他回临水镇再问一趟周账房，答应再加五钱银子，并把那张收条锁进了柜台下面的铁盒里。',
  ];
  const reply = (...parts: number[]) => JSON.stringify({ summary: parts.map(i => WROTE[i]).join('') });
  function seed(prefix: string, count = 4) {
    Object.assign(settings.apiSettings, { leafBatchThreshold: count, leafKeepRecent: 0, summaryMaxRetries: 1 });
    chat.splice(0, chat.length, ...LEAVES.slice(0, count).map(() => ai('正文')));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: `${prefix}-${i}`, text: LEAVES[i], delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
  }
  beforeEach(() => { settings.apiSettings.promptStyle = 'compact'; });

  it('把漏掉的是第几条告诉模型重写；补上了照常保存', async () => {
    seed('miss');
    const send = useMainApi().mockResolvedValueOnce(reply(0, 2, 3)).mockResolvedValueOnce(reply(0, 1, 2, 3));
    expect(await checkResummary()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].some(m => m.content.includes('上一次摘要结果未通过校验：总结里没有写到输入的第 2 条。每条输入里的场合都要写到，请重新输出完整的总结。'))).toBe(true);
    expect(memory.summaries[0]).toMatchObject({ level: 1, text: WROTE.join(''), childIds: ['miss-0', 'miss-1', 'miss-2', 'miss-3'] });
    expect(notices.toast).not.toHaveBeenCalled();
  });

  it('重试后仍漏掉两条以上（或四分之一以上）：不保存，这一批暂停自动重发，手动重试照常请求', async () => {
    seed('half');
    const send = useMainApi().mockResolvedValue(reply(0, 1));
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toContain('总结失败：总结里没有写到输入的第 3 条、第 4 条（重试后仍然如此），没有保存');
    expect(memory.summaries).toHaveLength(0);
    // 每来一楼都会再检查一次:同一批不再自动请求
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockReset().mockResolvedValue(reply(0, 1, 2, 3));
    expect(await checkResummary({ force: true })).toBe(1);
    expect(memory.summaries[0].text).toBe(WROTE.join(''));
  });

  it('暂停后换了提示词版本：这一批照常自动再试', async () => {
    seed('swap');
    const send = useMainApi().mockResolvedValue(reply(0, 1));
    expect(await checkResummary()).toBe(0);
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    // 改用旧版:不核对每条输入,这一批不再暂停
    settings.apiSettings.promptStyle = 'classic';
    expect(await checkResummary()).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(memory.summaries[0].text).toBe(WROTE[0] + WROTE[1]);
  });

  it('十二条里只漏一条、重试后仍然如此：照常保存并提示', async () => {
    const who = ['赵掌柜', '钱婆婆', '孙铁匠', '李船头', '吴秀才', '郑屠户', '王货郎', '冯道士', '陈寡妇', '褚把总', '卫郎中', '蒋木匠'];
    const place = ['甲字码头', '柳林渡口', '青石桥头', '北关税卡', '南门粮市', '西山茶亭', '东湖鱼栈', '城隍庙口', '老槐树下', '盐仓后巷', '旧驿站前', '白沙河滩'];
    const goods = ['三十匹青布', '两船新茶', '十二坛桂花酒', '五担粗盐', '一箱旧账册', '八捆麻绳', '四车木炭', '二十张羊皮', '六篓鲜鱼', '九袋糙米', '七口铁锅', '一批瓷碗'];
    const event = ['半路遇雨耽搁了半日', '被巡检拦下验了路引', '船舱漏水折了两成货', '多交了一笔过路钱', '对方当场付清了尾款', '约好月底再送一趟', '货主临时改了交货的地方', '回程捎上了一封家信', '押货的伙计扭伤了脚', '货被雨打湿退回了一半', '账目对不上又重点了一遍', '赶在关城门前进了城'];
    const after = ['夜里宿在渡口的草棚', '向店家赊了两顿饭钱', '替人垫付了修船的工钱', '在集上买了一把新算盘', '把欠下的旧账一并结清', '托人给家里带了口信', '换了一条吃水更浅的船', '多雇了两个挑夫', '把湿了的货摊开晒了一天', '同行的伙计先回去报信', '在庙里借宿了一晚', '给牲口换了新的蹄铁'];
    const many = Array.from({ length: 12 }, (_, i) => `四月第${i + 1}趟，阿青替${who[i]}押着${goods[i]}从${place[i]}出发，${event[i]}，${after[i]}，收了${i + 3}钱银子的脚力。`);
    Object.assign(settings.apiSettings, { leafBatchThreshold: 12, leafKeepRecent: 0, summaryMaxRetries: 1 });
    chat.splice(0, chat.length, ...many.map(() => ai('正文')));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: `many-${i}`, text: many[i], delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    recomputeDerived();
    const send = useMainApi().mockResolvedValue(JSON.stringify({ summary: many.filter((_, i) => i !== 6).join('') }));
    expect(await checkResummary()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(memory.summaries).toHaveLength(1);
    expect(notices.toast).toHaveBeenCalledWith('总结已保存，但其中没有写到输入的第 7 条摘要（重试后仍然如此）；这部分内容只留在逐楼摘要里。', 'warning');
  });

  it('交回的内容和输入对不上（「没有收到材料」之类的说明）：不保存', async () => {
    seed('note');
    const notice = '本次任务未收到可整理的材料：输入中只有任务说明、核对步骤与输出格式，缺少按时间排列的楼层摘要正文，无法据此生成总结，请重新发送完整的材料后再试。';
    const send = useMainApi().mockResolvedValue(JSON.stringify({ summary: notice }));
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toContain('总结失败：模型交回的内容和输入对不上（没有写到输入里的事），没有保存');
    expect(memory.summaries).toHaveLength(0);
  });

  it('二次总结漏掉任何一条都不保存', async () => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 100, resummaryThreshold: 4, summaryMaxRetries: 1 });
    chat.splice(0, chat.length, ...LEAVES.map(() => ai('正文')));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: `deep-${i}`, text: `第${i + 1}楼的摘要。`, delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    memory.summaries.push(...LEAVES.map((text, i) => ({ id: `l1-${i}`, text, level: 1, auto: true, createdAt: 10 + i, childIds: [`deep-${i}`] })));
    recomputeDerived();
    const send = useMainApi().mockResolvedValue(reply(0, 1, 2));
    expect(await checkResummary()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(engineState.lastError).toContain('二次总结失败：二次总结里没有写到输入的第 4 条（重试后仍然如此），没有保存');
    expect(memory.summaries.filter(s => s.level === 2)).toHaveLength(0);
  });

  it('旧版不核对：整条没写到也照常保存，不多请求', async () => {
    settings.apiSettings.promptStyle = 'classic';
    seed('classic');
    const send = useMainApi().mockResolvedValue(reply(0, 3));
    expect(await checkResummary()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(memory.summaries[0].text).toBe(WROTE[0] + WROTE[3]);
  });

  // 精简版的二次总结输出 timeline 数组(一个场合一项),这里接成一段文字保存
  describe('二次总结的大事记', () => {
    // 各项收尾的写法不一:不带标点、带句号、以分号收尾
    const ITEMS = [
      WROTE[0].replace('三月初七傍晚，', '三月初七傍晚：').replace(/。$/, ''),
      WROTE[1].replace('三月初九，', '三月初九：'),
      WROTE[2].replace('三月十五日，', '三月十五日：').replace(/。$/, '；'),
      WROTE[3].replace('三月二十日，', '三月二十日：').replace(/。$/, ''),
    ];
    const TIMELINE = ITEMS.map(item => item.replace(/[。；]$/, '') + '。').join('');
    const STATE = ['少的那本账册还没有找到。', '那张收条锁在柜台下面的铁盒里'];
    function seedSecond(prefix: string, retries = 1) {
      Object.assign(settings.apiSettings, { leafBatchThreshold: 100, resummaryThreshold: 4, summaryMaxRetries: retries });
      chat.splice(0, chat.length, ...LEAVES.map(() => ai('正文')));
      chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: `${prefix}-leaf-${i}`, text: `第${i + 1}楼的摘要。`, delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
      memory.summaries.push(...LEAVES.map((text, i) => ({ id: `${prefix}-${i}`, text, level: 1, auto: true, createdAt: 10 + i, childIds: [`${prefix}-leaf-${i}`] })));
      recomputeDerived();
    }
    const second = () => memory.summaries.filter(s => s.level === 2);

    it('各项补上句号接成一段', async () => {
      seedSecond('chron');
      const send = useMainApi().mockResolvedValue(`<thinking>点日期</thinking>${JSON.stringify({ timeline: ITEMS })}`);
      expect(await checkResummary()).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(TIMELINE.startsWith('三月初七傍晚：阿青把借来的灯笼还给云来酒楼的掌柜')).toBe(true);
      expect(second()[0]).toMatchObject({ text: TIMELINE, childIds: ['chron-0', 'chron-1', 'chron-2', 'chron-3'] });
      // 请求里要的就是这一个数组;不另要「结束时仍然有效的事」(实测那一段错得最多)
      const sent = send.mock.calls[0][0].map(m => m.content).join('\n');
      expect(sent).toContain('"timeline": ["日期：这个场合的一两句话"');
      expect(sent).toContain('timeline 里上面每个日期的场合都要有一项，一项一两句话');
      expect(sent).not.toContain('"state"');
    });

    it('项写成 {date, text} 对象、带了 state 的也认；仍然输出 summary 的照旧', async () => {
      seedSecond('obj');
      useMainApi().mockResolvedValue(JSON.stringify({ timeline: ITEMS.map(item => ({ date: item.split('：')[0], text: item.split('：')[1] })), state: STATE }));
      expect(await checkResummary()).toBe(1);
      expect(second()[0].text).toBe(TIMELINE + '到此为止仍然有效：少的那本账册还没有找到；那张收条锁在柜台下面的铁盒里。');
      memory.summaries.splice(0, memory.summaries.length);
      seedSecond('plain');
      useMainApi().mockResolvedValue(JSON.stringify({ summary: WROTE.join(''), timeline: ITEMS }));
      expect(await checkResummary()).toBe(1);
      expect(second()[0].text).toBe(WROTE.join(''));
    });

    it('各项是把输入整段搬进来的：让模型重写一次，写短了照常保存', async () => {
      seedSecond('long');
      const pasted = ITEMS.map(item => item.replace(/[。；]$/, '') + '。' + '他在回去的路上把这件事前前后后又想了一遍。'.repeat(10));
      expect(pasted.every(item => item.length > 200)).toBe(true);
      const send = useMainApi()
        .mockResolvedValueOnce(JSON.stringify({ timeline: pasted }))
        .mockResolvedValueOnce(JSON.stringify({ timeline: ITEMS }));
      expect(await checkResummary()).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0].some(m => /上一次摘要结果未通过校验：timeline 里有 4 项超过 200 字（最长的 \d+ 字），是把输入整段搬了进来。每一项重新写成一两句话（不超过一百个字），只留这个场合的事件、结果和定下的事/.test(m.content))).toBe(true);
      expect(second()[0].text).toBe(TIMELINE);
    });

    it('最后一次尝试仍然太长：照常保存，事都在，只是没有缩短', async () => {
      seedSecond('keep', 0);
      const pasted = ITEMS.map(item => item.replace(/[。；]$/, '') + '。' + '他在回去的路上把这件事前前后后又想了一遍。'.repeat(10));
      const send = useMainApi().mockResolvedValue(JSON.stringify({ timeline: pasted }));
      expect(await checkResummary()).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(second()[0].text.startsWith(pasted[0])).toBe(true);
      expect(engineState.lastError).toBe('');
    });
  });
});

