import { describe, expect, it } from 'vitest';
import { parseSummaryResponse } from './summaryResponse';
import { finalizeDelta } from './apply';
describe('伤情补丁放错位置不能被静默吞掉', () => {
  it.each([
    { items: { update: [{ name: '药', conditionPatch: { add: [] } }] } },
    { npcs: { conditionPatch: { add: [] } } },
    { protagonist: { unknown: { conditionPatch: { add: [] } } } },
    { unknown: [{ conditionPatch: { add: [] } }] },
  ])('拒绝非法位置 %j', fields => {
    expect(() => parseSummaryResponse(JSON.stringify({ summary: '状态变化。', ...fields }), {
      requireStateChanges: false, finalize: value => finalizeDelta(value, []),
      conditionContext: { protagonist: {}, npcs: [], content: '本轮正文。', strict: false },
    })).toThrow('conditionPatch 必须放在');
  });
});
