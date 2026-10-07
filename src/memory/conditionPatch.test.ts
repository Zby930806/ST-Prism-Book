import { describe, expect, it } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse } from './summaryResponse';
import { buildConditionPatchContext } from './conditionPatch';

const old = '右手腕缠绷带、有伤，自述爬不了沉降井、去了会拖慢速度';
const source = '小A说：“手腕至少还得养上四五天。”医生确认手腕已经痊愈。';
const state = { protagonist: { condition: '脚踝扭伤，不能负重' }, npcs: [{ name: '小A', condition: old }] };
const parse = (update: unknown, body = source, strict = true) => parseSummaryResponse(JSON.stringify({ summary: '她仍需休养。', stateChanges: ['npcs'], npcs: { update: [update] } }), {
  requireStateChanges: true, finalize: d => finalizeDelta(d, []), conditionContext: { ...state, content: body, strict },
});

describe('伤情局部更新合同', () => {
  it('拒绝真实失败形态：已有伤情被休养天数整段覆盖', () => {
    expect(() => parse({ name: '小A', condition: '右腕仍有伤，自述还需养四五天' })).toThrow('conditionPatch');
  });
  it('只输出新增休养估计也确定性保留旧行动限制，补丁不进入存储', () => {
    const d = parse({ name: '小A', conditionPatch: { add: [{ text: '自述还需休养四五天', evidence: '手腕至少还得养上四五天' }] } });
    expect(d.npcs?.update?.[0].condition).toBe(old + '；自述还需休养四五天');
    expect(JSON.stringify(finalizeDelta(d, []))).not.toContain('conditionPatch');
    expect(JSON.stringify(d)).not.toContain('evidence');
  });
  it('局部恢复只替换指定片段，其余仍保留', () => {
    const d = parse({ name: '小A', conditionPatch: { replace: [{ id: 'c1', text: '手腕已痊愈', evidence: '医生确认手腕已经痊愈' }] } });
    expect(d.npcs?.update?.[0].condition).toBe('手腕已痊愈，自述爬不了沉降井、去了会拖慢速度');
  });
  it('全部恢复须显式清除全部旧片段，而非留下永不消退旧伤', () => {
    const d = parse({ name: '小A', conditionPatch: { replace: ['c1','c2'].map(id => ({ id, text: '', evidence: '医生确认手腕已经痊愈' })) } });
    expect(d.npcs?.update?.[0].condition).toBe('');
  });
  it.each([
    null, {}, { add: null }, { replace: 'c1' }, { clear: true },
    { add: [{ text: '养伤', evidence: '历史中才有的证据' }] },
    { add: [{ text: '', evidence: '手腕至少还得养上四五天' }] },
    { replace: [{ id: 'c99', text: '', evidence: '医生确认手腕已经痊愈' }] },
    { replace: [{ id: 'c1', text: '', evidence: '医生确认手腕已经痊愈' }, { id: 'c1', text: '新伤', evidence: '医生确认手腕已经痊愈' }] },
    { replace: [{ id: 'c1', text: null, evidence: '医生确认手腕已经痊愈' }] },
  ])('无效补丁或不在本轮的引用被拒绝：%j', conditionPatch => {
    expect(() => parse({ name: '小A', conditionPatch })).toThrow();
  });
  it('不能同时提供覆盖值和补丁，也不能用重复更新绕过', () => {
    expect(() => parse({ name: '小A', condition: '', conditionPatch: { replace: [] } })).toThrow();
  });
  it('旧自定义模板保留覆盖兼容', () => {
    expect(parse({ name: '小A', condition: '' }, source, false).npcs?.update?.[0].condition).toBe('');
  });
  it('输出补丁列表使用本楼前状态与角色作用域编号，未知伤情不造旧项', () => {
    const block = buildConditionPatchContext(state);
    expect(block).toContain('c1'); expect(block).toContain('c2');
    expect(block).toContain('自述爬不了沉降井、去了会拖慢速度');
    expect(block).toContain('protagonist');
    expect(buildConditionPatchContext({ npcs: [], protagonist: {} })).toBe('');
  });
  it('主角同样局部更新，旧限制不能因新估计被覆盖', () => {
    const raw = JSON.stringify({ summary: '还需养伤。', stateChanges: ['protagonist'], protagonist: { conditionPatch: { add: [{ text: '需休养', evidence: '手腕至少还得养上四五天' }] } } });
    const d = parseSummaryResponse(raw, { requireStateChanges: true, finalize: v => finalizeDelta(v, []), conditionContext: { ...state, content: source, strict: true } });
    expect(d.protagonist?.condition).toBe('脚踝扭伤，不能负重；需休养');
  });
});

describe('伤情协议迁移边界', () => {
  const parseRaw = (data: unknown) => parseSummaryResponse(JSON.stringify({ summary: '伤情变化。', ...data as object }), { requireStateChanges: true, finalize: v => finalizeDelta(v, []), conditionContext: { ...state, content: source, strict: true } });
  it('首次记录仍可直接写 condition', () => {
    const d = parseRaw({ stateChanges: ['npcs'], npcs: { add: [{ name: '小B', condition: '手腕受伤' }] } });
    expect(d.npcs?.add?.[0].condition).toBe('手腕受伤');
  });
  it('无变化和闪回健康不输出操作，旧状态保持', () => {
    expect(parseRaw({ stateChanges: [] })).not.toHaveProperty('npcs');
  });
  it('不能用已有角色add或重复update覆盖同一伤情', () => {
    expect(() => parseRaw({ stateChanges: ['npcs'], npcs: { add: [{ name: ' 小a ', condition: '' }] } })).toThrow('add');
    const item = { name: '小A', conditionPatch: { add: [{ text: '休养四五天', evidence: '手腕至少还得养上四五天' }] } };
    expect(() => parseRaw({ stateChanges: ['npcs'], npcs: { update: [item, item] } })).toThrow('同一');
  });
  it('有依据的新估计替换旧估计，不累积相互矛盾的期限', () => {
    const d = parseSummaryResponse(JSON.stringify({ summary: '休养估计改变。', stateChanges: ['npcs'], npcs: { update: [{ name: '小A', conditionPatch: { replace: [{ id: 'c2', text: '自述需养四五天', evidence: '手腕至少还得养上四五天' }] } }] } }), { requireStateChanges: true, finalize: v => finalizeDelta(v, []), conditionContext: { protagonist: {}, npcs: [{ name: '小A', condition: '手腕受伤；自述需养两天' }], content: source, strict: true } });
    expect(d.npcs?.update?.[0].condition).toBe('手腕受伤；自述需养四五天');
  });
});

describe('补丁不能静默丢弃', () => {
  it.each([
    { conditionPatch: { add: [] }, stateChanges: [] },
    { npcs: { update: [{ name: '甲', conditionPatch: { add: [] } }] }, stateChanges: ['npcs'] },
    { protagonist: { conditionPatch: { add: [] } }, stateChanges: ['protagonist'] },
  ])('放错位置或缺状态时拒绝: %j', fields => {
    expect(() => parseSummaryResponse(JSON.stringify({ summary: '变化。', ...fields }), { requireStateChanges: true, finalize: v => finalizeDelta(v, []) })).toThrow('conditionPatch');
  });
});

it('清掉末尾片段不残留分隔符，同字追加不能重复旧事实', () => {
  const d = parse({ name: '小A', conditionPatch: { replace: [{ id: 'c2', text: '', evidence: '医生确认手腕已经痊愈' }] } });
  expect(d.npcs?.update?.[0].condition).toBe('右手腕缠绷带、有伤');
  expect(() => parse({ name: '小A', conditionPatch: { add: [{ text: '右手腕缠绷带、有伤', evidence: '手腕至少还得养上四五天' }] } })).toThrow('重复旧事实');
});
