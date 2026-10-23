import { describe, expect, it } from 'vitest';
import { discussionFullTime, discussionTimeLabel, discussionTranscript, parseDiscussionText, parseInline, plainPreview, splitReplyBubbles } from './discussionView';

describe('parseInline', () => {
  it('识别粗体、行内代码与斜体，其余原样保留', () => {
    expect(parseInline('先**确认署名**，再看`值班簿`和*旧印章*。')).toEqual([
      { text: '先' }, { text: '确认署名', bold: true }, { text: '，再看' }, { text: '值班簿', code: true },
      { text: '和' }, { text: '旧印章', italic: true }, { text: '。' },
    ]);
  });
  it('不成对或两侧有空格的星号按原文显示', () => {
    expect(parseInline('5 * 3 = 15，**未闭合')).toEqual([{ text: '5 * 3 = 15，**未闭合' }]);
    expect(parseInline('a*b*c')).toEqual([{ text: 'a*b*c' }]);
    expect(parseInline('** 有空格 **')).toEqual([{ text: '** 有空格 **' }]);
  });
});

describe('parseDiscussionText', () => {
  it('段落内的换行保留为多行，空行分段', () => {
    expect(parseDiscussionText('第一行\n第二行\n\n第二段')).toEqual([
      { kind: 'p', lines: [[{ text: '第一行' }], [{ text: '第二行' }]] },
      { kind: 'p', lines: [[{ text: '第二段' }]] },
    ]);
  });
  it('解析标题、无序与有序列表、缩进层级和续行', () => {
    const blocks = parseDiscussionText('## 节奏建议\n- **前半段**：查档案\n  先找值班簿\n  - 看守放行\n1. 钟塔\n2、港口\n3）航线');
    expect(blocks[0]).toEqual({ kind: 'h', parts: [{ text: '节奏建议' }] });
    expect(blocks[1]).toEqual({ kind: 'list', ordered: false, items: [
      { depth: 0, marker: '•', parts: [{ text: '前半段', bold: true }, { text: '：查档案 先找值班簿' }] },
      { depth: 1, marker: '•', parts: [{ text: '看守放行' }] },
      { depth: 0, marker: '1.', parts: [{ text: '钟塔' }] },
      { depth: 0, marker: '2.', parts: [{ text: '港口' }] },
      { depth: 0, marker: '3.', parts: [{ text: '航线' }] },
    ] });
  });
  it('小数、负数和带圆点的名字不当作列表', () => {
    expect(parseDiscussionText('3.5 倍速度\n-5 度\n约翰·史密斯').map(block => block.kind)).toEqual(['p']);
  });
  it('解析引用、分隔线和代码块，代码块内容不做行内解析', () => {
    expect(parseDiscussionText('> 用户原话\n> 第二行\n\n---\n```\n**不加粗**\n```')).toEqual([
      { kind: 'quote', lines: [[{ text: '用户原话' }], [{ text: '第二行' }]] },
      { kind: 'hr' },
      { kind: 'code', text: '**不加粗**' },
    ]);
  });
});

describe('plainPreview', () => {
  it('去掉 Markdown 记号并截断', () => {
    expect(plainPreview('## 建议\n- **先慢后紧**：前半段查档案')).toBe('建议 先慢后紧：前半段查档案');
    expect(plainPreview('一二三四五六七八九十', 6)).toBe('一二三四五…');
  });
});

describe('discussionTranscript', () => {
  it('按轮次输出说话人和内容', () => {
    expect(discussionTranscript([
      { role: 'user', content: '钟塔这场戏怎么安排？' },
      { role: 'assistant', content: '先慢后紧。\n' },
    ])).toBe('你：\n钟塔这场戏怎么安排？\n\nQiheng：\n先慢后紧。');
  });
  it('有时间的消息附上完整时间', () => {
    const at = new Date(2026, 9, 20, 8, 5).getTime();
    expect(discussionTranscript([{ role: 'user', content: '问', at }, { role: 'assistant', content: '答' }]))
      .toBe('你（2026年10月20日 08:05）：\n问\n\nQiheng：\n答');
  });
});

describe('splitReplyBubbles', () => {
  it('按空行拆成一条条气泡，没有空行时只有一条', () => {
    expect(splitReplyBubbles('行\n\n这个我倾向 A\n主要是节奏\n\n\nB 稳，但是慢')).toEqual(['行', '这个我倾向 A\n主要是节奏', 'B 稳，但是慢']);
    expect(splitReplyBubbles('一句话说完')).toEqual(['一句话说完']);
    expect(splitReplyBubbles('  \n第一条\r\n\r\n第二条\n  ')).toEqual(['第一条', '第二条']);
  });
  it('代码块里的空行不拆', () => {
    expect(splitReplyBubbles('看这个\n\n```\n第一行\n\n第三行\n```\n\n就这')).toEqual(['看这个', '```\n第一行\n\n第三行\n```', '就这']);
  });
  it('列表和标题各自成一条，拆出来的片段都能单独渲染', () => {
    const parts = splitReplyBubbles('我倾向两步走\n\n- 先让她核实消息\n- 再摊牌\n\n**风险**：太快会崩');
    expect(parts).toHaveLength(3);
    expect(parseDiscussionText(parts[1])[0].kind).toBe('list');
  });
});

describe('discussionTimeLabel', () => {
  const now = new Date(2026, 9, 20, 21, 30).getTime();
  it('当天只写时分，前一天写昨天，今年内写月日，更早加年份', () => {
    expect(discussionTimeLabel(new Date(2026, 9, 20, 8, 5).getTime(), now)).toBe('08:05');
    expect(discussionTimeLabel(new Date(2026, 9, 19, 23, 59).getTime(), now)).toBe('昨天 23:59');
    expect(discussionTimeLabel(new Date(2026, 0, 3, 7, 0).getTime(), now)).toBe('1月3日 07:00');
    expect(discussionTimeLabel(new Date(2025, 11, 31, 22, 10).getTime(), now)).toBe('2025年12月31日 22:10');
  });
  it('跨月的前一天也算昨天', () => {
    expect(discussionTimeLabel(new Date(2026, 9, 31, 18, 0).getTime(), new Date(2026, 10, 1, 9, 0).getTime())).toBe('昨天 18:00');
  });
  it('完整时间带年份', () => {
    expect(discussionFullTime(new Date(2026, 9, 20, 8, 5).getTime())).toBe('2026年10月20日 08:05');
  });
});
