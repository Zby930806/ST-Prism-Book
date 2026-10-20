import { describe, expect, it } from 'vitest';
import { floorSpectrum, pendingRanges, type SpectrumInput } from './spectrum';

const base = (patch: Partial<SpectrumInput> = {}): SpectrumInput => ({
  floors: [1, 3, 5, 7, 9, 11, 13, 15],
  omit: new Set(), pending: new Set(), keepStart: 99,
  leafOf: new Map([1, 3, 5, 7, 9, 11, 13, 15].map(f => [f, 'leaf-' + f])),
  summaries: [],
  ...patch,
});

describe('floorSpectrum', () => {
  it('按合并到的最高层级分档：二次总结、总结、逐楼摘要', () => {
    const result = floorSpectrum(base({
      summaries: [
        { id: 'l1-a', level: 1, childIds: ['leaf-1', 'leaf-3'] },
        { id: 'l1-b', level: 1, childIds: ['leaf-5', 'leaf-7'] },
        { id: 'l1-c', level: 1, childIds: ['leaf-9'] },
        { id: 'l2', level: 2, childIds: ['l1-a', 'l1-b'] },
      ],
    }));
    expect(result.runs.map(r => [r.state, r.count, r.firstFloor, r.lastFloor])).toEqual([
      ['l2', 4, 1, 7], ['l1', 1, 9, 9], ['leaf', 3, 11, 15],
    ]);
    expect(result.counts).toMatchObject({ l2: 4, l1: 1, leaf: 3, raw: 0 });
    expect(result.total).toBe(8);
  });
  it('番外优先于待补摘，待补摘优先于原文窗口', () => {
    const result = floorSpectrum(base({ omit: new Set([3]), pending: new Set([3, 13]), keepStart: 11 }));
    expect(result.runs.map(r => r.state)).toEqual(['leaf', 'omit', 'leaf', 'raw', 'pending', 'raw']);
    expect(result.counts).toMatchObject({ omit: 1, pending: 1, raw: 2, leaf: 4 });
  });
  it('导入的旧总结覆盖的楼层按其层级显示；循环引用不会卡住', () => {
    const result = floorSpectrum(base({
      leafOf: new Map([[9, 'leaf-9']]), floors: [1, 3, 9],
      summaries: [
        { id: 'old', level: 1, imported: true, importedFloorStart: 0, importedFloorEnd: 5 },
        { id: 'x', level: 1, childIds: ['y'] }, { id: 'y', level: 1, childIds: ['x'] },
      ],
    }));
    expect(result.runs.map(r => [r.state, r.count])).toEqual([['l1', 2], ['leaf', 1]]);
  });
});

describe('pendingRanges', () => {
  it('中间没有别的 AI 楼时合成一段；番外楼不打断', () => {
    // AI 楼（不含番外）：1 3 5 9 11 13；7 是番外
    expect(pendingRanges([13, 3, 5, 9, 1], [1, 3, 5, 9, 11, 13])).toEqual([
      { first: 1, last: 9, floors: [1, 3, 5, 9] },
      { first: 13, last: 13, floors: [13] },
    ]);
  });
  it('没有待补摘时为空', () => {
    expect(pendingRanges([], [1, 3])).toEqual([]);
  });
});
