import { afterEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import type { STMessage } from '@/st/context';
import {
  builtinTimeTagPrompt, clampToTimeTags, clampToTimeTagsForFingerprint, cleanBody, FICTIONAL_OPENING_TIME, hasStoryBody, latestStoryTime, parseTimeRange,
  TIME_TAG_PROMPT, TIME_TAG_PROMPT_COMPACT, timeTagPrompt,
} from './timeTag';

// 时间标签指令的两个版本,以及模型把两个标签连在一起写时的兜底(1.4.18)。
const saved = JSON.stringify(apiSettings);
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
const ai = (mes: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes });

describe('时间标签指令随内置提示词版本切换', () => {
  it('旧版逐字不变;精简版写明位置、给出示例,并把虚构起点写成具体时间', () => {
    apiSettings.prompts.timeTag = '';
    apiSettings.promptStyle = 'classic';
    expect(builtinTimeTagPrompt()).toBe(TIME_TAG_PROMPT);
    expect(timeTagPrompt().startsWith(TIME_TAG_PROMPT)).toBe(true);
    apiSettings.promptStyle = 'compact';
    expect(builtinTimeTagPrompt()).toBe(TIME_TAG_PROMPT_COMPACT);
    expect(timeTagPrompt().startsWith(TIME_TAG_PROMPT_COMPACT)).toBe(true);
    expect(TIME_TAG_PROMPT_COMPACT).toContain('正文之前写一行 <bbs_start>开始时间</bbs_start>，正文之后写一行 <bbs_end>结束时间</bbs_end>');
    expect(TIME_TAG_PROMPT_COMPACT).toContain('两个标签不连着写');
    expect(TIME_TAG_PROMPT_COMPACT).toContain('开始时间沿用下面的「当前主线时间基准」');
    expect(TIME_TAG_PROMPT_COMPACT).toContain('不自己估算谈话、赶路用了多久');
    expect(TIME_TAG_PROMPT_COMPACT).toContain('<bbs_start>2025/3/14 21:30</bbs_start>');
    expect(TIME_TAG_PROMPT_COMPACT).toContain(`两个标签都写「${FICTIONAL_OPENING_TIME}」`);
    // 每次生成正文都发,不能太长
    expect(TIME_TAG_PROMPT_COMPACT.length).toBeLessThan(450);
  });

  it('自定义的时间标签指令不受版本影响', () => {
    apiSettings.prompts.timeTag = '我的时间指令';
    for (const style of ['classic', 'compact'] as const) {
      apiSettings.promptStyle = style;
      expect(timeTagPrompt().startsWith('我的时间指令')).toBe(true);
    }
  });
});

describe('两个时间标签连在一起写', () => {
  it('写在正文之后:标签只当时间用,正文照常保留', () => {
    const mes = '<content>\n她把钥匙放在柜台上，转身上了楼。\n</content>\n<bbs_start>9/12 20:00</bbs_start><bbs_end>9/12 20:30</bbs_end>';
    expect(hasStoryBody(mes)).toBe(true);
    expect(cleanBody(mes)).toContain('她把钥匙放在柜台上，转身上了楼。');
    expect(cleanBody(mes)).toContain('(结束时间:9/12 20:30)');
    expect(parseTimeRange(clampToTimeTags(mes))).toEqual({ start: '9/12 20:00', end: '9/12 20:30' });
    expect(latestStoryTime([ai(mes)])).toBe('9/12 20:30');
  });

  it('写在正文之前,或中间只隔着空行:同样保留正文', () => {
    const mes = '<bbs_start>清晨</bbs_start>\n\n<bbs_end>上午</bbs_end>\n两人在渡口等了一个时辰，船始终没有来。';
    expect(hasStoryBody(mes)).toBe(true);
    expect(cleanBody(mes)).toContain('两人在渡口等了一个时辰，船始终没有来。');
    expect(parseTimeRange(clampToTimeTags(mes))).toEqual({ start: '清晨', end: '上午' });
  });

  it('只有标签、没有任何正文的仍算空楼', () => {
    expect(hasStoryBody('<bbs_start>清晨</bbs_start><bbs_end>上午</bbs_end>')).toBe(false);
    expect(hasStoryBody('<bbs_start>清晨</bbs_start>\n<bbs_end>上午</bbs_end>\n<bbs_items source="baibai-book" hidden="true">\n获得 钥匙 1\n</bbs_items>')).toBe(false);
  });

  it('标签之间有正文时照原规则裁剪,不受影响', () => {
    const mes = '思考过程\n<bbs_start>傍晚</bbs_start>正文。<bbs_end>夜里</bbs_end>\n<状态栏>体力 80</状态栏>';
    expect(clampToTimeTags(mes)).toBe('<bbs_start>傍晚</bbs_start>正文。<bbs_end>夜里</bbs_end>');
    // 多段里有一段是空的:只要别的段有正文,就不启用兜底
    const two = '前言<bbs_start>早</bbs_start><bbs_end>早</bbs_end>\n<bbs_start>午</bbs_start>正文二。<bbs_end>晚</bbs_end>后记';
    expect(clampToTimeTags(two)).not.toContain('前言');
    expect(clampToTimeTags(two)).toContain('正文二。');
  });

  it('楼层指纹用的旧边界不变', () => {
    const mes = '正文在前。\n<bbs_start>清晨</bbs_start><bbs_end>上午</bbs_end>';
    expect(clampToTimeTagsForFingerprint(mes)).toBe('<bbs_start>清晨</bbs_start><bbs_end>上午</bbs_end>');
  });
});
