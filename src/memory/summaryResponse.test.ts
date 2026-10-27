import { describe, expect, it } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import type { MemPlan } from './types';

const plans: MemPlan[] = [{ id: 'plan:stable', kind: 'plan', content: '还图', status: 'open', createdAt: 0 }];
const parse = (data: unknown, builtin = true) => parseSummaryResponse(JSON.stringify(data), {
  builtin, finalize: d => finalizeDelta(d, plans),
});

describe('摘要结果合同', () => {
  it.each([150, 300, 2000])('篇幅不是保存门槛：超出 %i 字的摘要原样返回，不截句', limit => {
    const summary = '字'.repeat(limit) + '😀，后半句仍保留。';
    expect(parse({ summary, stateChanges: [] }).summary).toBe(summary);
  });
  it('状态清单已停用：内置与自定义模板都不要求 stateChanges，旧模板输出时直接忽略', () => {
    expect(parse({ summary: '原文。' }).summary).toBe('原文。');
    expect(parse({ summary: '原文。' }, false).summary).toBe('原文。');
    expect(parse({ summary: '原文。', npcs: { add: [{ title: '无名角色' }] } }, false).summary).toBe('原文。');
    // 清单与实际字段对不上也不再拒收:声明了却没写的不补,写了却没声明的照常保存
    const d = parse({ summary: '原文。', stateChanges: ['items', 'plans'], npcs: { add: [{ name: '小A' }] } });
    expect(d).not.toHaveProperty('stateChanges');
    expect(d.npcs?.add?.[0].name).toBe('小A');
    expect(finalizeDelta(d, plans)).not.toHaveProperty('items');
    expect(parse({ summary: '原文。', stateChanges: ['npcs'] }, false)).not.toHaveProperty('stateChanges');
  });
  it.each([
    { npcs: { add: [{ title: '无名' }] } },
    { plans: { resolve: ['p99'] } },
    { npcs: { patch: [] } },
    { delta: { npcs: {} } },
    { updates: {} },
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
