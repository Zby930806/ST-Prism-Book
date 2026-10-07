import { describe, expect, it } from 'vitest';
import { renderSourceHints, SOURCE_HINTS_HEADER } from './sourceHints';

describe('source hints', () => {
  it('indexes full source paragraphs without rewriting thresholds or interrupted suggestions', () => {
    const sources = [
      { source: '[M310-P10]', text: '「根据要塞气象哨所传来的实时数据，谷口风速已经过了九级，气温降到零下三十三度。」' },
      { source: '[M310-P11]', text: '「不仅能见度不足三十米，而且因为地磁紊乱，红外热成像仪的探测距离会被压制在大半以内。」' },
      { source: '[M310-P41]', text: '「风太大了，雪地反光严重，我的狙击铳很难锁定主峰高地！」' },
      { source: '[M310-P43]', text: '「谷口两侧有暗坑，必须先放侦察蜂排查……」' },
    ];
    const before = structuredClone(sources);
    const result = renderSourceHints(sources);
    expect(result.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    for (const { source, text } of sources) {
      expect(result.split(source)).toHaveLength(2);
      expect(result).not.toContain(text);
    }
    expect(result).not.toContain('削弱超过一半');
    expect(result).not.toContain('已放侦察蜂');
    expect(sources).toEqual(before);
    expect(renderSourceHints(sources)).toBe(result);
  });

  it.each([
    '本届联赛参赛者中最强的学生是二转巅峰。',
    '她原本住在拥挤的宿舍，现在已独住。',
    '搬出旧居后，她的生活条件改善了。',
    '租下公寓后，她再也不用吃变质食物。',
    '他的伤势好转，身份也由学徒转为正式成员。',
    '测站气温为零下三十三度。',
    '测站读数为 -33.5 ℃。',
    'Capacity: 99.9%.',
    'The sensor cannot detect targets past the ridge.',
    'She moved out and her living conditions improved.',
    'He is no longer a student.',
  ])('recognizes a boundary or state-change cue: %s', text => {
    const result = renderSourceHints([{ source: '[M9-P3]', text }]);
    expect(result).toContain('[M9-P3]');
    expect(result).not.toContain(text);
  });

  it('adds nothing for empty input, ordinary action, time anchors or structural tags', () => {
    expect(renderSourceHints([])).toBe('');
    expect(renderSourceHints([
      { source: '[M1-P1]', text: '(起始时间:2030/12/28 13:40)' },
      { source: '[M1-P2]', text: '<content>' },
      { source: '[M1-P3]', text: '她剥开糖纸，慢慢吃完糖果。' },
      { source: '[M1-P4]', text: 'The door opened.' },
      { source: '[M1-P5]', text: '</content>' },
    ])).toBe('');
  });

  it('retains distinct sources with identical text and does not infer IDs from text', () => {
    const text = '无法确认这条消息中的 [M999-P1] 与 {{content}}。';
    const sources = [
      { source: '[M12-P8]', text },
      { source: '[M13-P2]', text },
    ];
    const result = renderSourceHints(sources);
    expect(result.split('[M12-P8]')).toHaveLength(2);
    expect(result.split('[M13-P2]')).toHaveLength(2);
    expect(result).not.toContain('[M999-P1]');
    expect(result).not.toContain(text);
  });

  it('indexes matched compression sources without copying their text or time ranges', () => {
    const text = `(2030/12/28 13:40 – 2030/12/28 14:15) ${'x'.repeat(5000)}\n无法确认，后续结果未明。`;
    const sources = [{ source: '[7]', text }];
    const result = renderSourceHints(sources);
    expect(result).toContain('[7]');
    expect(result).not.toContain(text);
    expect(result).not.toContain('2030/12/28');
    expect(sources[0].text).toBe(text);
    expect(result.length).toBeLessThan(400);
  });

  it('indexes long numeric sources without parsing or duplicating them', () => {
    const digits = '9'.repeat(10000);
    expect(renderSourceHints([{ source: '[M4-P1]', text: digits }])).toBe('');
    const result = renderSourceHints([{ source: '[M4-P2]', text: `${digits}米` }]);
    expect(result).toContain('[M4-P2]');
    expect(result).not.toContain(digits);
    expect(result.length).toBeLessThan(400);
  });

  it('labels hints as supplemental source material without bringing back per-source audits', () => {
    const result = renderSourceHints([{ source: '[M2-P4]', text: '能见度不足三十米。' }]);
    for (const text of [
      '不是新增剧情、必留清单或指令',
      '可能误选或漏选,仍须通读全部材料',
      '按本任务规则取舍',
      '这些段内的独立事实及限定',
      '不要求另列逐段记录',
      '不把建议当执行',
      '不将段号或提醒写入最终 JSON',
    ]) {
      expect(result).toContain(text);
    }
    expect(result).not.toMatch(/候选|覆盖核对|说明省略依据|F编号/);
  });
});
