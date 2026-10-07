import { describe, expect, it } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
function parse(entry: Record<string, unknown>, strict = true) {
  return parseSummaryResponse(JSON.stringify({ summary: '本轮交易。', stateChanges: ['items'], items: { add: [entry] } }), {
    requireStateChanges: strict, finalize: d => finalizeDelta(d, []),
  });
}
describe('内置摘要物品转入数量合同', () => {
  it.each([undefined, null, '3', 0, -3])('拒绝省略、非法或非正转入数量：%j', qty => {
    expect(() => parse({ name: '交易凭证', desc: '已付给对方三张，余额未知', ...(qty === undefined ? {} : { qty }) })).toThrow(SummaryResponseError);
  });
  it.each([1, 3, 0.5])('接受明确的正数量，不强制所有物品为整数：%s', qty => {
    expect(parse({ name: '物品', qty }).items?.add?.[0].qty).toBe(qty);
  });
  it('旧自定义模板仍支持省略数量，不改变历史解释', () => {
    expect(parse({ name: '旧道具' }, false).items?.add?.[0].qty).toBeUndefined();
  });
  it('自定义旧模板保留带符号数量兼容', () => {
    expect(parse({ name: '旧道具', qty: -1 }, false).items?.add?.[0].qty).toBe(-1);
  });
  it('部分消耗仍允许update绝对余额，耗尽允许remove', () => {
    const d = parseSummaryResponse(JSON.stringify({ summary: '用掉一部分，另一件已耗尽。', stateChanges: ['items'],
      items: { update: [{ name: '燃料', qty: 2 }], remove: ['电池'] } }), { requireStateChanges: true, finalize: d => finalizeDelta(d, []) });
    expect(d.items).toEqual({ update: [{ name: '燃料', qty: 2 }], remove: ['电池'] });
  });
});
