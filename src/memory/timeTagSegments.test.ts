import { afterEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { cleanBody, clampToTimeTags, hasStoryBody, inlineTimeTags, latestStoryTime, parseTimeRange } from './timeTag';

// 正文分成几段、各带时间标签时,摘要材料和「当前时间」都要覆盖全部正文。
const saved = JSON.stringify(apiSettings);
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
const ai = (mes: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes });

describe('按时间标签分段收集正文', () => {
  it('时间跳跃处另起一对标签:两段正文都保留,起始取第一段、结束取最后一段', () => {
    const mes = '<bbs_start>周一夜里</bbs_start>她答应明天还钱。<bbs_end>周一夜里</bbs_end>\n'
      + '<bbs_start>周二早上</bbs_start>次日两人出发去码头。<bbs_end>周二上午</bbs_end>';
    const body = cleanBody(mes);
    expect(body).toContain('她答应明天还钱。');
    expect(body).toContain('次日两人出发去码头。');
    expect(body).toContain('(起始时间:周二早上)');
    expect(body).not.toContain('<bbs_');
    expect(parseTimeRange(clampToTimeTags(mes))).toEqual({ start: '周一夜里', end: '周二上午' });
    expect(latestStoryTime([ai(mes)])).toBe('周二上午');
  });

  it('中途多写一个结束标签:后面的正文照样保留,当前时间取最后一个结束标签', () => {
    const mes = '<bbs_start>夜里</bbs_start>她答应明天还钱。<bbs_end>夜里</bbs_end>次日两人出发去码头。<bbs_end>次日早上</bbs_end>';
    expect(cleanBody(mes)).toContain('次日两人出发去码头。');
    expect(parseTimeRange(clampToTimeTags(mes))).toEqual({ start: '夜里', end: '次日早上' });
    expect(latestStoryTime([ai(mes)])).toBe('次日早上');
  });

  it('没有结束标签的开始标签(状态栏)被丢弃,第一段之前和最后一段之后的文字仍排除', () => {
    const before = '<状态>当前:<bbs_start>旧时间</bbs_start></状态>\n<bbs_start>傍晚</bbs_start>正文。<bbs_end>夜里</bbs_end>\n后侧旁注';
    expect(clampToTimeTags(before)).toBe('<bbs_start>傍晚</bbs_start>正文。<bbs_end>夜里</bbs_end>');
    const after = '<bbs_start>傍晚</bbs_start>正文。<bbs_end>夜里</bbs_end>\n状态栏<bbs_start>状态时间</bbs_start>';
    expect(clampToTimeTags(after)).toBe('<bbs_start>傍晚</bbs_start>正文。<bbs_end>夜里</bbs_end>');
    expect(latestStoryTime([ai(after)])).toBe('夜里');
  });

  it('两段之间的文字不进摘要材料', () => {
    const mes = '<bbs_start>上午</bbs_start>正文一。<bbs_end>中午</bbs_end>\n系统旁注\n<bbs_start>下午</bbs_start>正文二。<bbs_end>傍晚</bbs_end>';
    const body = cleanBody(mes);
    expect(body).toContain('正文一。');
    expect(body).toContain('正文二。');
    expect(body).not.toContain('系统旁注');
  });

  it('取舍:状态栏如果也写了成对的时间标签,会被并进正文', () => {
    const mes = '<bbs_start>上午</bbs_start>正文。<bbs_end>中午</bbs_end>\n<状态栏><bbs_start>状态起</bbs_start>体力 80<bbs_end>状态止</bbs_end></状态栏>';
    expect(cleanBody(mes)).toContain('体力 80');
    expect(parseTimeRange(clampToTimeTags(mes)).end).toBe('状态止');
  });

  it('只有一侧标签时沿用原规则:只有开始标签从最后一个开始取到末尾,只有结束标签取到最后一个结束标签', () => {
    expect(clampToTimeTags('前文<bbs_start>早上</bbs_start>正文')).toBe('<bbs_start>早上</bbs_start>正文');
    expect(clampToTimeTags('正文一<bbs_end>中午</bbs_end>正文二<bbs_end>下午</bbs_end>后侧')).toBe('正文一<bbs_end>中午</bbs_end>正文二<bbs_end>下午</bbs_end>');
    expect(clampToTimeTags('没有任何时间标签的旧正文')).toBe('没有任何时间标签的旧正文');
  });

  it('只有标签、没有正文的两段仍算空楼;内联转换覆盖每一处标签', () => {
    expect(hasStoryBody('<bbs_start>上午</bbs_start><bbs_end>中午</bbs_end>\n<bbs_start>下午</bbs_start><bbs_end>傍晚</bbs_end>')).toBe(false);
    expect(inlineTimeTags('<bbs_start>A</bbs_start>一<bbs_end>B</bbs_end><bbs_start>C</bbs_start>二<bbs_end>D</bbs_end>'))
      .toBe('(起始时间:A)一(结束时间:B)(起始时间:C)二(结束时间:D)');
  });
});
