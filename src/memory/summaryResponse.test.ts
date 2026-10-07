import { describe, expect, it } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import type { MemPlan } from './types';

const plans: MemPlan[] = [{ id: 'plan:stable', kind: 'plan', content: '还图', status: 'open', createdAt: 0 }];
const parse = (data: unknown, maxChars = 300, requireStateChanges = true) => parseSummaryResponse(JSON.stringify(data), {
  maxChars, requireStateChanges, finalize: d => finalizeDelta(d, plans),
});

describe('摘要结果合同', () => {
  it.each([150, 300])('按 Unicode 字符计数，边界 %i 不截句', limit => {
    const summary = '字'.repeat(limit - 2) + '😀。';
    expect(parse({ summary, stateChanges: [] }, limit).summary).toBe(summary);
    expect(() => parse({ summary: summary + '。', stateChanges: [] }, limit)).toThrow('超过');
  });
  it('内置必须对账，自定义未采用新合同时保持兼容', () => {
    expect(() => parse({ summary: '原文。' })).toThrow(SummaryResponseError);
    expect(parse({ summary: '原文。' }, 300, false).summary).toBe('原文。');
    expect(parse({ summary: '原文。', npcs: { add: [{ title: '无名角色' }] } }, 300, false).summary).toBe('原文。');
    expect(() => parse({ summary: '原文。', stateChanges: ['npcs'] }, 300, false)).toThrow('不一致');
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
  it.each([150, 300])('短于参考范围仍可落叶,保留完整状态更新: %i', limit => {
    const d = parse({ summary: '小A已收回地图,还图约定完成。', stateChanges: ['items', 'plans'],
      items: { remove: ['地图'] }, plans: { resolve: [{ id: 'p1', outcome: 'done' }] } }, limit);
    expect(d.summary).toBe('小A已收回地图,还图约定完成。');
    expect(finalizeDelta(d, plans).items?.remove).toEqual(['地图']);
    expect(finalizeDelta(d, plans).plans?.resolve).toEqual([{ id: 'plan:stable', outcome: 'done' }]);
  });
  it('超长纠错要求删细节而非挤电报,仍拒绝截句或删状态', () => {
    const attempt = () => parse({ summary: '字'.repeat(301), stateChanges: [] });
    for (const phrase of ['先删不影响后续的细节', '完整短句', '因果路径', '不截断句子或删掉状态更新']) {
      expect(attempt).toThrow(phrase);
    }
  });
});
