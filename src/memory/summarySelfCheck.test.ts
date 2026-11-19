import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import { apiFailure, classifyHttpFailure } from '@/api/errors';
import type { STContext, STMessage } from '@/st/context';
import { checkResummary, currentSummaryPromise, engineState, summarizeSelected } from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';
import * as selfCheck from './summarySelfCheck';
import { applyFixes, buildSelfCheckPrompt, parseSelfCheckReply, readFixes, SELF_CHECK_NOTE, SELF_CHECK_PREFILL } from './summarySelfCheck';

const LEAVES = [
  '三月初七傍晚，阿青把借来的灯笼还给云来酒楼的掌柜。掌柜托他带一封信给临水镇的周账房，说信里是今年的茶钱账目，要亲手交到；阿青答应十日内送到，掌柜先付了他三钱银子的脚力，余下的回来再结。临走时掌柜叮嘱他别走北边的山路，说那一带近来不太平。',
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
const RIGHT = WROTE.join('');
/** 第二条把垫钱的人写反了 */
const SWAPPED = RIGHT.replace('阿青替船家补交了二两银子', '船家替阿青补交了二两银子');
const SWAP_FIX = { wrong: '船家替阿青补交了二两银子的过渡钱才放行', right: '阿青替船家补交了二两银子的过渡钱才放行', why: '垫钱的是阿青，不是船家' };

describe('核对用的提示词', () => {
  it('规则和材料里写明核对的是哪一级，材料原样放进去', () => {
    const content = '[1] (三月初七) 材料里带着 {{summary}} 和 $& 这样的字样';
    const prompt = buildSelfCheckPrompt('二次总结', content, '写好的那一条，里面有 {{content}}');
    expect(prompt.system).toContain('【二次总结】（由这些记录合并成的一条）');
    expect(prompt.system).not.toContain('{{what}}');
    expect(prompt.user).toBe(`【输入】（按时间先后；每条前的括注是它的时间范围）\n${content}\n\n【二次总结】\n写好的那一条，里面有 {{content}}`);
    expect(prompt.note).toBe(SELF_CHECK_NOTE);
    expect(prompt.prefill).toBe(SELF_CHECK_PREFILL);
  });

  it('只查写错，不让删内容', () => {
    const { system } = buildSelfCheckPrompt('总结', '', '');
    for (const kind of ['人物', '日期和时刻', '数量', '地点', '结果']) expect(system).toContain(`- ${kind}：`);
    expect(system).toContain('这些不算错，不要动：比【输入】简略');
    expect(system).toContain('只改不删');
    expect(system).not.toContain('删掉它以后剩下的句子');
  });
});

describe('解析核对的回复', () => {
  const one = '{"fixes":[{"wrong":"船家替阿青补交","right":"阿青替船家补交","why":"人写反了"}]}';

  it('检查块之后的 JSON', () => {
    expect(parseSelfCheckReply(`<thinking>三月初九：垫钱的人写反了。</thinking>\n${one}`)).toEqual([{ wrong: '船家替阿青补交', right: '阿青替船家补交', why: '人写反了' }]);
    // 开了预填充时回复从检查块中间接着写,只有闭合标签
    expect(parseSelfCheckReply(`三月初七：对。\n三月初九：垫钱的人写反了。\n</thinking>\n\`\`\`json\n${one}\n\`\`\``)).toHaveLength(1);
    expect(parseSelfCheckReply('三月初七：对。</thinking>{"fixes":[]}')).toEqual([]);
  });

  it('JSON 被写进了检查块里、检查块没有闭合时，取最后一个 fixes 对象', () => {
    expect(parseSelfCheckReply('三月初七：对。输出空的 fixes。\n\n{"fixes":[]}</thinking')).toEqual([]);
    expect(parseSelfCheckReply(`<thinking>先想一下，大概是 {"fixes":[]}，再看一遍。三月初九有出入。\n${one}`)).toHaveLength(1);
  });

  it('没有 fixes 数组时返回 null', () => {
    expect(parseSelfCheckReply('没有发现错处。')).toBeNull();
    expect(parseSelfCheckReply('</thinking>{"fix":[]}')).toBeNull();
    expect(parseSelfCheckReply('')).toBeNull();
  });

  it('取改正项：去掉换行和两头空白，不是对象的项丢掉', () => {
    expect(readFixes({ fixes: [{ wrong: ' 甲\n乙 ', right: 12, why: null }, '不是对象', null, ['数组']] })).toEqual([{ wrong: '甲乙', right: '12', why: '' }]);
    expect(readFixes({ fixes: '不是数组' })).toBeNull();
    expect(readFixes(null)).toBeNull();
  });
});

describe('按原句替换', () => {
  it('只换写错的那一句，其余一字不动', () => {
    const result = applyFixes(SWAPPED, [SWAP_FIX]);
    expect(result.text).toBe(RIGHT);
    expect(result.applied).toEqual([SWAP_FIX]);
    expect(result.skipped).toEqual([]);
  });

  it('抄原句时多带了句末标点：去掉两头的标点再找', () => {
    const result = applyFixes(SWAPPED, [{ ...SWAP_FIX, wrong: SWAP_FIX.wrong + '。', right: SWAP_FIX.right + '。' }]);
    expect(result.text).toBe(RIGHT);
  });

  it('句末标点跟着原句走：顺手加的句号去掉，漏掉的补上', () => {
    // 原句抄到「放行」为止,改正后的多了一个句号:不能在句子中间留下「。，」
    expect(applyFixes(SWAPPED, [{ ...SWAP_FIX, right: SWAP_FIX.right + '。' }]).text).toBe(RIGHT);
    // 原句连着后面的逗号一起抄了,改正后的没带:补上,免得两句连在一起
    expect(applyFixes(SWAPPED, [{ ...SWAP_FIX, wrong: SWAP_FIX.wrong + '，' }]).text).toBe(RIGHT);
  });

  it.each([
    ['not-found', SWAPPED, { wrong: '船家替阿青垫付了二两银子', right: '阿青替船家垫付了二两银子' }],
    // 同一句话在总结里出现了两次,不知道该换哪一处
    ['ambiguous', SWAPPED + SWAPPED, { wrong: SWAP_FIX.wrong, right: SWAP_FIX.right }],
    ['too-short', SWAPPED, { wrong: '船家替阿青', right: '阿青替船家' }],
    ['same', SWAPPED, { wrong: SWAP_FIX.wrong, right: SWAP_FIX.wrong }],
    ['empty', SWAPPED, { wrong: SWAP_FIX.wrong, right: '' }],
    ['too-long', SWAPPED, { wrong: SWAP_FIX.wrong, right: SWAP_FIX.right + '，船家抱怨误了潮水，还另送他一包晒干的鱼'.repeat(4) }],
  ] as const)('改不上的不改：%s', (reason, summary, fix) => {
    const result = applyFixes(summary, [{ ...fix, why: '' }]);
    expect(result.text).toBe(summary);
    expect(result.skipped.map(s => s.reason)).toEqual([reason]);
  });

  it('一次最多改 24 处', () => {
    const parts = Array.from({ length: 26 }, (_, i) => `第${String(i + 1).padStart(2, '0')}趟押的是青布。`);
    const fixes = parts.map(part => ({ wrong: part.slice(0, -1), right: part.slice(0, -1).replace('青布', '新茶'), why: '' }));
    const result = applyFixes(parts.join(''), fixes);
    expect(result.applied).toHaveLength(24);
    expect(result.skipped.map(s => s.reason)).toEqual(['too-many', 'too-many']);
    expect(result.text).toContain('第24趟押的是新茶。第25趟押的是青布。');
  });

  it('删掉内容的改动不采用，少两个字也算；只少一个字的改写照改', () => {
    const cut = applyFixes(RIGHT, [{ wrong: '掌柜先付了三钱银子的脚力，叮嘱他别走北边的山路', right: '掌柜先付了三钱银子的脚力', why: '输入里没有' }]);
    expect(cut.text).toBe(RIGHT);
    expect(cut.skipped.map(s => s.reason)).toEqual(['drops']);
    // 「三钱」是一个数目:两个字没了,这件事的数目就没了
    const amount = applyFixes(RIGHT, [{ wrong: '掌柜先付了三钱银子的脚力', right: '掌柜先付了银子的脚力', why: '' }]);
    expect(amount.text).toBe(RIGHT);
    expect(amount.skipped.map(s => s.reason)).toEqual(['drops']);
    const reworded = applyFixes(RIGHT, [{ wrong: '货船在柳林渡口被巡检拦下验路引', right: '货船在柳林渡口被巡检拦下验引', why: '' }]);
    expect(reworded.applied).toHaveLength(1);
  });

  // 一件事安错了日子,模型分两项把它挪到正确的日子:一项从写错的那句里拿掉,一项加进正确的那句
  describe('挪到正确的日子', () => {
    const CLAUSE = '又说之后的信改寄到他侄子周小满那里';
    // 这句话被安到了三月二十日
    const MISPLACED = RIGHT.replace('，' + CLAUSE, '').replace('答应再加五钱银子，', `答应再加五钱银子，周账房${CLAUSE}，`);
    const remove = { wrong: `答应再加五钱银子，周账房${CLAUSE}，并把那张收条锁进了柜台下面的铁盒里`, right: '答应再加五钱银子，并把那张收条锁进了柜台下面的铁盒里', why: '这是三月十五日说的' };
    const add = { wrong: '要他月底前交给掌柜。', right: `要他月底前交给掌柜，${CLAUSE}。`, why: '补回三月十五日' };

    it.each([['先拿掉后加上', [remove, add]], ['先加上后拿掉', [add, remove]]] as const)('%s：两项都改', (_, fixes) => {
      const result = applyFixes(MISPLACED, [...fixes]);
      expect(result.text).toBe(RIGHT);
      expect(result.skipped).toEqual([]);
    });

    it('只拿掉、没有加到别处：不改，写错的句子留着', () => {
      const result = applyFixes(MISPLACED, [remove]);
      expect(result.text).toBe(MISPLACED);
      expect(result.skipped.map(s => s.reason)).toEqual(['drops']);
    });

    it('加到别处的那一项没改上：拿掉的那一项也不改', () => {
      const result = applyFixes(MISPLACED, [remove, { ...add, wrong: '要他月底之前交还给掌柜。' }]);
      expect(result.text).toBe(MISPLACED);
      expect(result.skipped.map(s => s.reason).sort()).toEqual(['drops', 'not-found']);
    });

    // 字数差不多,但把安错日子的那句话换成了当天别的事:这句话就从总结里没了
    it('把一整句话换成了别的话、没有加到别处：不改', () => {
      const swap = { wrong: `周账房${CLAUSE}，并把那张收条锁进了柜台下面的铁盒里`, right: '阿青说来回要六天、路上要在柳林渡口歇一晚，并把那张收条锁进了柜台下面的铁盒里', why: '这是三月十五日说的' };
      const result = applyFixes(MISPLACED, [swap]);
      expect(result.text).toBe(MISPLACED);
      expect(result.skipped.map(s => s.reason)).toEqual(['drops']);
      // 同一次回复里另一项把它加回了正确的日子:照改
      const both = applyFixes(MISPLACED, [swap, add]);
      expect(both.skipped).toEqual([]);
      expect(both.text).toContain(`要他月底前交给掌柜，${CLAUSE}。`);
      expect(both.text).toContain('答应再加五钱银子，阿青说来回要六天、路上要在柳林渡口歇一晚，并把那张收条锁进了柜台下面的铁盒里');
    });
  });

  it('一整句重写、原来的话大半还在：照改', () => {
    const wrong = '周账房托阿青带回一包账册和一张收条，要他月底前交给掌柜';
    const right = '周账房托阿青带回一包账册和一张收条，要掌柜月底前交还给他';
    const result = applyFixes(RIGHT, [{ wrong, right, why: '' }]);
    expect(result.applied).toHaveLength(1);
    expect(result.text).toContain(right);
  });

  // 长短按「字」算:一个英文名、一个英文单词、一个数不论拼出来多长都只算一个词,不按字符数
  describe('人名长短不一、总结不是中文', () => {
    const MIXED = '11月20日晚，Alexander到Eve家吃饭，提出同居；Eve说要考虑，年底前答复。饭后Alexander洗碗，Eve收拾桌子，九点多回了书屋。';

    it('把长名字换成短名字不算删内容', () => {
      const result = applyFixes(MIXED, [{ wrong: '饭后Alexander洗碗，Eve收拾桌子', right: '饭后Eve洗碗，Alexander收拾桌子', why: '' },
        { wrong: 'Eve说要考虑，年底前答复', right: 'Eve说要考虑，Eve答应年底前答复', why: '' }]);
      expect(result.skipped).toEqual([]);
      const swap = applyFixes(MIXED, [{ wrong: '九点多回了书屋', right: '九点多Eve回了书屋', why: '' }, { wrong: 'Alexander到Eve家吃饭，提出同居', right: 'Eve到Alexander家吃饭，Alexander提出同居', why: '去谁家写反了' }]);
      expect(swap.skipped).toEqual([]);
      expect(swap.text).toContain('11月20日晚，Eve到Alexander家吃饭，Alexander提出同居；');
      // 字符数少了六个,换的只是一个名字
      const shorter = applyFixes(MIXED, [{ wrong: '饭后Alexander洗碗', right: '饭后Eve洗碗', why: '洗碗的是 Eve' }]);
      expect(shorter.applied).toHaveLength(1);
    });

    it('整个拿掉一个人、一件事仍然不采用', () => {
      for (const right of ['饭后Alexander洗碗', '饭后洗碗，Eve收拾桌子']) {
        const result = applyFixes(MIXED, [{ wrong: '饭后Alexander洗碗，Eve收拾桌子', right, why: '' }]);
        expect(result.text).toBe(MIXED);
        expect(result.skipped.map(s => s.reason)).toEqual(['drops']);
      }
    });

    it('英文写的总结：换名字照改，删掉一个词不采用', () => {
      const english = 'On March 7 Alexander returned the lantern to the innkeeper. Eve paid twice for the ferry, and Alexander promised to carry the letter within ten days.';
      const named = applyFixes(english, [{ wrong: 'Alexander promised to carry the letter within ten days', right: 'Eve promised to carry the letter within ten days', why: '' }]);
      expect(named.text).toContain('and Eve promised to carry the letter within ten days.');
      const cut = applyFixes(english, [{ wrong: 'Eve paid twice for the ferry', right: 'Eve paid for the ferry', why: '' }]);
      expect(cut.text).toBe(english);
      expect(cut.skipped.map(s => s.reason)).toEqual(['drops']);
      const short = applyFixes(english, [{ wrong: 'Eve paid', right: 'She paid', why: '' }]);
      expect(short.skipped.map(s => s.reason)).toEqual(['too-short']);
    });
  });
});

describe('总结写完后核对', () => {
  const saved = JSON.stringify(settings.apiSettings);
  const ai = (text: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra: {} });
  let chat: STMessage[];
  const merged = (text: string) => JSON.stringify({ summary: text });
  const checked = (...fixes: Array<{ wrong: string; right: string; why: string }>) => `三月初九：垫钱的人写反了。\n</thinking>\n${JSON.stringify({ fixes })}`;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(memory, createEmptyMemory());
    Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 1, leafBatchThreshold: 4, leafKeepRecent: 0, resummaryThreshold: 100, resummarySelfCheck: true });
    Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
    settings.apiSettings.vector.enabled = false;
    chat = LEAVES.map(() => ai('正文'));
    chat.forEach((m, i) => { m.extra = { bbs_leaf: { id: `leaf-${i}`, text: LEAVES[i], delta: {}, createdAt: i + 1, swipe: 0, v: 1 } }; });
    const ctx = { chat, name1: '阿青', name2: '角色', getCurrentChatId: () => 'self-check-test', chatMetadata: {},
      saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
    vi.spyOn(context, 'getContext').mockReturnValue(ctx);
    vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
    vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
    vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
    vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
    vi.spyOn(notices, 'toast').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    recomputeDerived();
    Object.assign(engineState, { lastError: '', lastFailure: null });
  });
  afterEach(async () => {
    await currentSummaryPromise();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    Object.assign(settings.apiSettings, JSON.parse(saved));
  });
  const send = () => vi.spyOn(client, 'requestViaMainApi');

  it('默认开启，没有保存过这一项的设置（从旧版本升级）也是；关闭后不多发请求', async () => {
    expect(settings.normalizeApiSettings(null).resummarySelfCheck).toBe(true);
    expect(settings.normalizeApiSettings({ keepRecent: 4, summaryMaxRetries: 1 }).resummarySelfCheck).toBe(true);
    expect(settings.normalizeApiSettings({ resummarySelfCheck: 'false' }).resummarySelfCheck).toBe(true);
    expect(settings.normalizeApiSettings({ resummarySelfCheck: false }).resummarySelfCheck).toBe(false);
    expect(settings.normalizeApiSettings({ resummarySelfCheck: true }).resummarySelfCheck).toBe(true);
    settings.apiSettings.resummarySelfCheck = false;
    const request = send().mockResolvedValue(merged(SWAPPED));
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(memory.summaries[0].text).toBe(SWAPPED);
  });

  it('开启后多发一个请求：带上输入和写好的总结，按原句替换后保存', async () => {
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockResolvedValueOnce(checked(SWAP_FIX));
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    const messages = request.mock.calls[1][0];
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: '<thinking>' });
    expect(messages.at(-2)).toEqual({ role: 'system', content: SELF_CHECK_NOTE });
    const material = messages.find(m => m.role === 'user')!.content;
    expect(material).toContain(`[2] ${LEAVES[1]}`);
    expect(material.endsWith(`【总结】\n${SWAPPED}`)).toBe(true);
    expect(messages.some(m => m.role === 'system' && m.content.includes('请对照【输入】逐句核对【总结】'))).toBe(true);
    expect(memory.summaries).toHaveLength(1);
    expect(memory.summaries[0]).toMatchObject({ level: 1, text: RIGHT, childIds: ['leaf-0', 'leaf-1', 'leaf-2', 'leaf-3'] });
    expect(engineState.lastError).toBe('');
  });

  it('没有发现错处时照原样保存', async () => {
    const request = send().mockResolvedValueOnce(merged(RIGHT)).mockResolvedValueOnce('各个场合都对得上。</thinking>{"fixes":[]}');
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(memory.summaries[0].text).toBe(RIGHT);
  });

  it.each([
    ['请求失败', () => Promise.reject(classifyHttpFailure({ status: 503 }))],
    ['回复不是 JSON', () => Promise.resolve('逐个场合看过了，没有需要改的地方。')],
    ['改动删掉了内容', () => Promise.resolve(checked({ wrong: '掌柜先付了三钱银子的脚力，叮嘱他别走北边的山路', right: '掌柜先付了三钱银子的脚力', why: '输入里没有' }))],
  ])('核对%s：总结照原样保存，不算失败，也不重发', async (_, reply) => {
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockImplementationOnce(reply);
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(memory.summaries[0].text).toBe(SWAPPED);
    expect(engineState.lastError).toBe('');
    expect(engineState.lastFailure).toBeNull();
  });

  it('核对期间要合并的摘要被改了：结果不写入', async () => {
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockImplementationOnce(async () => {
      chat[0].extra!.bbs_leaf!.text = '改过的第一条。';
      return checked(SWAP_FIX);
    });
    expect(await checkResummary()).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(memory.summaries).toHaveLength(0);
    expect(engineState.lastError).toContain('结果未写入');
  });

  it.each([
    ['解析', 'parseSelfCheckReply'],
    ['替换', 'applyFixes'],
  ] as const)('%s时出了意料之外的错：总结照原样保存，不算失败', async (_, step) => {
    vi.spyOn(selfCheck, step).mockImplementation(() => { throw new TypeError('意料之外的错'); });
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockResolvedValueOnce(checked(SWAP_FIX));
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(memory.summaries[0].text).toBe(SWAPPED);
    expect(engineState.lastError).toBe('');
    expect(console.warn).toHaveBeenCalledWith('[棱镜宝书] 总结核对的结果没能套用,按原样保存:', '意料之外的错');
  });

  // 开着预填充时,个别渠道偶尔只回一个「>」就结束(真实模型对照里 30 次核对出现过 1 次);这种回复几乎不花钱,再发一次
  it.each([
    ['只回了一个「>」', () => Promise.resolve('>')],
    ['报空回复', () => Promise.reject(apiFailure('empty', 'API 返回了空内容'))],
  ])('核对%s：再发一次，第二次的结果照常采用', async (_, empty) => {
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockImplementationOnce(empty).mockResolvedValueOnce(checked(SWAP_FIX));
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0]).toEqual(request.mock.calls[1][0]);
    expect(memory.summaries[0].text).toBe(RIGHT);
  });

  it('核对两次都是空回复：不再发，总结照原样保存', async () => {
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockResolvedValue('>');
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(memory.summaries[0].text).toBe(SWAPPED);
    expect(engineState.lastError).toBe('');
  });

  it('手动合并同样核对', async () => {
    settings.apiSettings.leafBatchThreshold = 100;
    const request = send().mockResolvedValueOnce(merged(SWAPPED)).mockResolvedValueOnce(checked(SWAP_FIX));
    expect(await summarizeSelected(['leaf-0', 'leaf-1', 'leaf-2', 'leaf-3'])).toEqual({ made: 1 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(memory.summaries[0]).toMatchObject({ level: 1, text: RIGHT, auto: false });
  });

  it('二次总结同样核对，材料和规则里写的是【二次总结】', async () => {
    Object.assign(settings.apiSettings, { leafBatchThreshold: 100, resummaryThreshold: 4 });
    chat.forEach((m, i) => { m.extra!.bbs_leaf!.text = `第${i + 1}楼的摘要。`; });
    memory.summaries.push(...LEAVES.map((text, i) => ({ id: `l1-${i}`, text, level: 1, auto: true, createdAt: 10 + i, childIds: [`leaf-${i}`] })));
    recomputeDerived();
    const items = WROTE.map((text, i) => (i === 1 ? text.replace('阿青替船家补交了二两银子', '船家替阿青补交了二两银子') : text));
    const request = send().mockResolvedValueOnce(`<thinking>点日期</thinking>${JSON.stringify({ timeline: items })}`).mockResolvedValueOnce(checked(SWAP_FIX));
    expect(await checkResummary()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    const messages = request.mock.calls[1][0];
    expect(messages.find(m => m.role === 'user')!.content.endsWith(`【二次总结】\n${SWAPPED}`)).toBe(true);
    expect(messages.some(m => m.role === 'system' && m.content.includes('请对照【输入】逐句核对【二次总结】'))).toBe(true);
    expect(memory.summaries.filter(s => s.level === 2).map(s => s.text)).toEqual([RIGHT]);
  });
});
