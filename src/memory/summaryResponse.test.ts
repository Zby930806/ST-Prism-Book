import { describe, expect, it } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import type { MemPlan } from './types';

const plans: MemPlan[] = [{ id: 'plan:stable', kind: 'plan', content: '还图', status: 'open', createdAt: 0 }];
const parse = (data: unknown, requireStateChanges = true) => parseSummaryResponse(JSON.stringify(data), {
  requireStateChanges, finalize: d => finalizeDelta(d, plans),
});

describe('摘要结果合同', () => {
  it.each([150, 300, 2000])('篇幅不是保存门槛：超出 %i 字的摘要原样返回，不截句', limit => {
    const summary = '字'.repeat(limit) + '😀，后半句仍保留。';
    expect(parse({ summary, stateChanges: [] }).summary).toBe(summary);
  });
  it('内置必须对账，自定义未采用新合同时保持兼容', () => {
    expect(() => parse({ summary: '原文。' })).toThrow(SummaryResponseError);
    expect(parse({ summary: '原文。' }, false).summary).toBe('原文。');
    expect(parse({ summary: '原文。', npcs: { add: [{ title: '无名角色' }] } }, false).summary).toBe('原文。');
    expect(() => parse({ summary: '原文。', stateChanges: ['npcs'] }, false)).toThrow('不一致');
  });
  it.each([
    { stateChanges: ['npcs'] },
    { stateChanges: [], npcs: { add: [{ name: '小A' }] } },
    { stateChanges: ['npcs', 'npcs'], npcs: { add: [{ name: '小A' }] } },
    { stateChanges: ['npcs'], npcs: { add: [{ title: '无名' }] } },
    { stateChanges: ['plans'], plans: { resolve: ['p99'] } },
    { stateChanges: ['npcs'], npcs: { patch: [] } },
    { stateChanges: [], delta: { npcs: {} } },
    { stateChanges: [], updates: {} },
  ])('错误或被清洗丢弃的状态不能作为成功结果：%j', data => {
    expect(() => parse({ summary: '简述。', ...data })).toThrow(SummaryResponseError);
  });
  it('保留显式 false/空位置/场景清空，短编号映射到稳定计划 ID', () => {
    const d = parse({ summary: '小A还图后离开，去向未明。', stateChanges: ['npcs', 'plans', 'sceneFocus'], sceneFocus: null,
      npcs: { update: [{ name: '小A', follow: false, location: '' }] }, plans: { resolve: [{ id: 'p1', outcome: 'done' }] } });
    const stored = finalizeDelta(d, plans);
    expect(stored.npcs?.update?.[0]).toMatchObject({ follow: false, location: '' });
    expect(stored.plans?.resolve).toEqual([{ id: 'plan:stable', outcome: 'done' }]);
    expect(stored.sceneFocus).toBeNull();
    expect(stored).not.toHaveProperty('stateChanges');
  });
  it.each([null, {}, { summary: '' }, { summary: '  ' }, { summary: 17 }])('拒绝空或非字符串摘要：%j', data => {
    expect(() => parse(data)).toThrow(SummaryResponseError);
  });
});


describe('v0.4 篇幅与纠错边界', () => {
  it('短摘要照常落叶，保留完整状态更新', () => {
    const d = parse({ summary: '小A已收回地图,还图约定完成。', stateChanges: ['items', 'plans'],
      items: { remove: ['地图'] }, plans: { resolve: [{ id: 'p1', outcome: 'done' }] } });
    expect(d.summary).toBe('小A已收回地图,还图约定完成。');
    expect(finalizeDelta(d, plans).items?.remove).toEqual(['地图']);
    expect(finalizeDelta(d, plans).plans?.resolve).toEqual([{ id: 'plan:stable', outcome: 'done' }]);
  });
  it('超长摘要同样保留状态更新，不因篇幅丢操作', () => {
    const summary = '小A收回地图，还图约定完成。'.repeat(40);
    const d = parse({ summary, stateChanges: ['items', 'plans'],
      items: { remove: ['地图'] }, plans: { resolve: [{ id: 'p1', outcome: 'done' }] } });
    expect(d.summary).toBe(summary);
    expect(finalizeDelta(d, plans).items?.remove).toEqual(['地图']);
    expect(finalizeDelta(d, plans).plans?.resolve).toEqual([{ id: 'plan:stable', outcome: 'done' }]);
  });
});
