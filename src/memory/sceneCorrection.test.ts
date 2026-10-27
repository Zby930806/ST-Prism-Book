import { describe, expect, it } from 'vitest';
import { finalizeDelta, deriveMemory } from './apply';
import { parseSummaryResponse } from './summaryResponse';
import type { STMessage } from '@/st/context';
function parse(scenes: unknown) {
  return parseSummaryResponse(JSON.stringify({ summary: '纠正地点档案。', scenes, stateChanges: ['scenes'] }), { builtin: true, finalize: d => finalizeDelta(d, []) });
}
describe('地点稳定描述纠错合同', () => {
  it('显式空更新可保存且仅清描述，不删后代也不创造无据新地点', () => {
    const delta = finalizeDelta(parse({ update: [{ path: ['展馆'], desc: '' }, { path: ['不存在'], desc: '' }] }), []);
    const chat = [{ extra: { bbs_leaf: { id: 'seed', seed: true, delta: { scenes: { add: [
      { path: ['展馆'], desc: '今早挤满送菜的人。' }, { path: ['展馆', '展厅'], desc: '陈列地方文献。' },
    ] } } } } }, { extra: { bbs_leaf: { id: 'fix', delta } } }] as STMessage[];
    const state = deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(state.scenes).toHaveLength(2);
    expect(state.scenes.find(s => s.name === '展馆')?.desc).toBeUndefined();
    expect(state.scenes.find(s => s.name === '展厅')?.desc).toBe('陈列地方文献。');
  });
  it('新增地点可以不带描述(只建节点)；更新缺省/非法描述不等于明确清空', () => {
    for (const desc of ['', null, undefined]) {
      const stored = finalizeDelta(parse({ add: [{ path: ['城南', '广场'], desc }] }), []);
      expect(stored.scenes?.add).toEqual([{ path: ['城南', '广场'] }]);
      const state = deriveMemory([{ extra: { bbs_leaf: { id: 'a', delta: stored } } }] as STMessage[]);
      expect(state.scenes.map(s => [s.name, s.desc])).toEqual([['城南', undefined], ['广场', undefined]]);
    }
    expect(finalizeDelta(parse({ add: [{ path: ['广场'], desc: '城中心的石板广场。' }] }), []).scenes?.add).toEqual([{ path: ['广场'], desc: '城中心的石板广场。' }]);
    for (const desc of [null, undefined]) expect(() => parse({ update: [{ path: ['展馆'], desc }] })).toThrow();
    expect(() => parse({ add: [{ path: [], desc: '没有路径' }] })).toThrow();
  });
});
