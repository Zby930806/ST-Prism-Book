import { describe, expect, it } from 'vitest';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import { finalizeDelta } from './apply';

const content = '次晨林舟在厨房见到小A。小A的手腕仍缠着绷带。';
function parse(npcs: unknown, strict = true, sourceContent: string | undefined = content, extra = {}) {
  return parseSummaryResponse(JSON.stringify({ summary: '次晨重逢。', stateChanges: ['npcs'], npcs, ...extra }), {
    requireStateChanges: strict, sourceContent, finalize: d => finalizeDelta(d, []),
  });
}
describe('本楼NPC位置证据合同', () => {
  it.each(['add', 'update'])('%s 非空位置缺少证据不能刷新确认时间', op => {
    expect(() => parse({ [op]: [{ name: '小A', location: '厨房' }] })).toThrow(SummaryResponseError);
  });
  it.each(['add', 'update'])('%s 有本楼连续原文才接受且删除临时证据', op => {
    const d = parse({ [op]: [{ name: '小A', location: '厨房', locationEvidence: '次晨林舟在厨房见到小A。' }] });
    expect(JSON.stringify(d)).not.toContain('locationEvidence');
    expect(JSON.stringify(finalizeDelta(d, []))).not.toContain('locationEvidence');
    expect(d.npcs?.[op as 'add' | 'update']?.[0].location).toBe('厨房');
  });
  it.each(['昨夜小A在客栈。', '次晨林舟…小A。', '', '   ', 4, null])('拒绝旧楼/拼接/非法引文：%j', evidence => {
    expect(() => parse({ update: [{ name: '小A', location: '厨房', locationEvidence: evidence }] })).toThrow(SummaryResponseError);
  });
  it('有引文但缺正文上下文也拒绝', () => {
    expect(() => parse({ update: [{ name: '小A', location: '厨房', locationEvidence: content }] }, true, '')).toThrow(SummaryResponseError);
  });
  it.each([{ location: '' }, { follow: false }, { follow: true }, { condition: '右腕受伤' }])('空位置/离队/随行/伤情不强加定位证据 %j', fields => {
    expect(parse({ update: [{ name: '小A', ...fields }] }).npcs?.update?.[0]).toMatchObject(fields);
  });
  it.each([
    { locationEvidence: content },
    { location: '', locationEvidence: content },
    { location: '厨房', follow: true, locationEvidence: content },
    { location: 7, locationEvidence: content },
  ])('拒绝孤立或矛盾证据 %j', fields => {
    expect(() => parse({ update: [{ name: '小A', ...fields }] })).toThrow(SummaryResponseError);
  });
  it.each([{ locationEvidence: content }, { protagonist: { locationEvidence: content } }, { items: { add: [{ name: '铜哨', locationEvidence: content }] } }])('证据不能放错层级 %j', extra => {
    expect(() => parse({ update: [{ name: '小A', follow: false }] }, true, content, extra)).toThrow(SummaryResponseError);
  });
  it('同一NPC不能在add/update重复定位', () => {
    const n = { name: '小A', location: '厨房', locationEvidence: content };
    expect(() => parse({ add: [n], update: [n] })).toThrow(SummaryResponseError);
  });
  it('自定义旧模板兼容直接位置，但主动给的证据仍须有效', () => {
    expect(parse({ update: [{ name: '小A', location: '厨房' }] }, false).npcs?.update?.[0].location).toBe('厨房');
    expect(() => parse({ update: [{ name: '小A', location: '厨房', locationEvidence: '旧楼引文' }] }, false)).toThrow(SummaryResponseError);
  });
});
