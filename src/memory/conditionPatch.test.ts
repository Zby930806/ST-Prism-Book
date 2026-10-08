import { describe, expect, it, vi } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
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

// 与定位证据一致：只放宽排版，不把改写、否定变化或不连续片段当成原文。
describe.each(['add', 'replace'] as const)('伤情 %s 引文的保守排版容错', op => {
  const text = '自述还需休养四五天';
  const patch = (evidence: unknown) => ({ [op]: [{ ...(op === 'replace' ? { id: 'c1' } : {}), text, evidence }] });
  const expected = op === 'add' ? old + '；' + text : text + '，自述爬不了沉降井、去了会拖慢速度';

  it.each([
    ['正文粗体', '小A说：“手腕**至少还得养上四五天**。”', '手腕至少还得养上四五天'],
    ['引文粗体', '手腕至少还得养上四五天。', '手腕**至少还得养上四五天**。'],
    ['两侧不同强调', '**手腕至少还得养上四五天。**', '_手腕至少还得养上四五天。_'],
    ['嵌套强调', '**手腕*至少还得养上四五天*。**', '手腕至少还得养上四五天。'],
    ['成对三重强调', '___手腕至少还得养上四五天。___', '手腕至少还得养上四五天。'],
    ['中文折行缩进', '手腕至少\r\n  还得养上\t四五天。', '手腕至少还得养上四五天。'],
    ['引文中文排版空白', '手腕至少还得养上四五天。', ' 手腕 至少\n还得养上 四五天 。 '],
    ['中文全角与不换行空白', '手腕\u3000至少还得养上\u00a0四五天。', '手腕至少还得养上四五天。'],
    ['英文空白折叠但保留词界', 'The wrist needs\n  four days.', 'The wrist needs four days.'],
    ['保留否定', '医生确认手腕**尚未痊愈**。', '医生确认手腕尚未痊愈。'],
    ['精确照录未配对标记', '手腕**至少还得养上四五天。', '手腕**至少还得养上四五天。'],
    ['精确照录局部强调原文', '**手腕至少还得养上四五天**。', '手腕至少还得养上四五天**'],
  ])('%s可匹配，未指定旧伤与限制保留', (_label, body, evidence) => {
    const before = JSON.stringify(state);
    const d = parse({ name: '小A', conditionPatch: patch(evidence) }, body);
    expect(d.npcs?.update?.[0].condition).toBe(expected);
    expect(JSON.stringify(state)).toBe(before);
    expect(JSON.stringify(d)).not.toContain('conditionPatch');
    expect(JSON.stringify(d)).not.toContain('evidence');
  });

  it.each([
    ['不在本轮的无关引文', '手腕至少还得养上四五天。', '院里的桂花开了。'],
    ['同义改写', '手腕至少还得养上四五天。', '手腕至少还需休养四五天。'],
    ['改变天数', '手腕至少还得养上四五天。', '手腕至少还得养上两天。'],
    ['删除否定', '医生确认手腕没有痊愈。', '医生确认手腕痊愈。'],
    ['替换否定', '医生确认手腕尚未痊愈。', '医生确认手腕已经痊愈。'],
    ['强调内的否定不能删掉', '医生确认手腕**没有**痊愈。', '医生确认手腕痊愈。'],
    ['改变标点', '手腕还疼，不能负重。', '手腕还疼。不能负重。'],
    ['拼接不连续片段', '手腕还疼。医生转身离开。不能负重。', '手腕还疼。不能负重。'],
    ['省略号代替正文', '手腕还疼。医生转身离开。不能负重。', '手腕还疼……不能负重。'],
    ['自行添加引号', '手腕至少还得养上四五天。', '“手腕至少还得养上四五天。”'],
    ['英文单词不能合并', 'The wrist is not healed.', 'The wrist is nothealed.'],
    ['英文词界不能凭空拆开', 'The wrist is nothealed.', 'The wrist is not healed.'],
    ['未配对强调不能删除', '手腕**至少还得养上四五天。', '手腕至少还得养上四五天。'],
    ['英文单词内下划线不能删除', 'The wrist is not_healed.', 'The wrist is nothealed.'],
    ['删除线不是排版容错', '医生确认手腕~~没有~~痊愈。', '医生确认手腕痊愈。'],
    ['行内代码不能去强调', '`手腕**尚未痊愈**。`', '手腕尚未痊愈。'],
    ['空正文不能借用旧伤', '', old],
    ['空白正文不是证据来源', ' \r\n\t ', '手腕至少还得养上四五天'],
  ])('拒绝%s，错误给出逐项路径和引文原因', (_label, body, evidence) => {
    const before = JSON.stringify(state);
    expectConditionItemError(() => parse({ name: '小A', conditionPatch: patch(evidence) }, body),
      `conditionPatch.${op}[0]`, /evidence.*(连续|匹配|正文|原文)/);
    expect(JSON.stringify(state)).toBe(before);
  });
});

function expectConditionItemError(run: () => unknown, path: string, reason: RegExp) {
  try {
    run();
    expect.unreachable('无效伤情补丁应被拒绝');
  } catch (error) {
    expect(error).toBeInstanceOf(SummaryResponseError);
    const message = (error as Error).message;
    expect(message).toContain(path);
    expect(message).toMatch(reason);
    expect(message).not.toContain('每项需合法 text 与本轮正文连续原文 evidence');
  }
}

describe.each(['add', 'replace'] as const)('伤情 %s 逐项字段诊断', op => {
  const valid = { ...(op === 'replace' ? { id: 'c1' } : {}), text: '需继续休养', evidence: '手腕至少还得养上四五天' };
  const check = (entry: unknown, reason: RegExp) => expectConditionItemError(
    () => parse({ name: '小A', conditionPatch: { [op]: [entry] } }), `conditionPatch.${op}[0]`, reason);

  it('缺失 evidence 时明确指出字段要求', () => {
    const { evidence: _evidence, ...entry } = valid;
    check(entry, /evidence.*(必|缺|字符串|提供)/);
  });
  it.each([null, 7, true, [], {}])('拒绝 evidence 类型错误：%j', evidence => {
    check({ ...valid, evidence }, /evidence.*字符串/);
  });
  it.each(['', ' \r\n\t ', '** **'])('拒绝空白或仅含空白强调的 evidence：%j', evidence => {
    check({ ...valid, evidence }, /evidence.*(空|正文|原文|匹配|连续)/);
  });
  it('缺失 text 时明确指出字符串要求', () => {
    const { text: _text, ...entry } = valid;
    check(entry, /text.*字符串/);
  });
  it.each([null, 7, true, [], {}])('拒绝 text 类型错误：%j', text => {
    check({ ...valid, text }, /text.*字符串/);
  });
  it.each([null, '养伤', []])('拒绝非对象条目：%j', entry => {
    check(entry, /对象/);
  });
  it('第二项错误不能冒充第一项', () => {
    const second = { ...valid, ...(op === 'replace' ? { id: 'c2' } : {}), evidence: '本轮没有这句' };
    expectConditionItemError(() => parse({ name: '小A', conditionPatch: { [op]: [valid, second] } }),
      `conditionPatch.${op}[1]`, /evidence.*(连续|匹配|正文|原文)/);
  });
});

describe('伤情格式容错的状态与证据来源边界', () => {
  it('格式化恢复证据允许明确清空一项，原有行动限制仍保留', () => {
    const d = parse({ name: '小A', conditionPatch: { replace: [{ id: 'c1', text: '', evidence: '医生确认手腕已经痊愈。' }] } },
      '医生确认手腕**已经痊愈**。');
    expect(d.npcs?.update?.[0].condition).toBe('自述爬不了沉降井、去了会拖慢速度');
    expect(state.npcs[0].condition).toBe(old);
  });
  it('add 不能借格式容错接受空 text', () => {
    expectConditionItemError(() => parse({ name: '小A', conditionPatch: { add: [{ text: ' \n ', evidence: '手腕至少还得养上四五天' }] } }),
      'conditionPatch.add[0]', /(text.*(空|非空)|不允许空字符串)/);
  });
  it('主角采用同一排版容错且保留旧伤与限制', () => {
    const raw = JSON.stringify({ summary: '还需养伤。', stateChanges: ['protagonist'], protagonist: {
      conditionPatch: { add: [{ text: '还需休养四五天', evidence: '脚踝还需休养四五天。' }] },
    } });
    const d = parseSummaryResponse(raw, { requireStateChanges: true, finalize: v => finalizeDelta(v, []),
      conditionContext: { ...state, content: '脚踝**还需休养**\n四五天。', strict: true } });
    expect(d.protagonist?.condition).toBe('脚踝扭伤，不能负重；还需休养四五天');
    expect(state.protagonist.condition).toBe('脚踝扭伤，不能负重');
    expect(JSON.stringify(d)).not.toContain('evidence');
  });
  it('旧状态与响应 summary 中存在的原句不能替代本轮正文证据', () => {
    const finalize = vi.fn((d: Parameters<typeof finalizeDelta>[0]) => finalizeDelta(d, []));
    const raw = JSON.stringify({ summary: old, stateChanges: ['npcs'], npcs: { update: [{ name: '小A',
      conditionPatch: { add: [{ text: '仍需休养', evidence: old }] },
    }] } });
    expectConditionItemError(() => parseSummaryResponse(raw, { requireStateChanges: true, finalize,
      conditionContext: { ...state, content: '今天庭院下雨。', strict: true } }),
    'conditionPatch.add[0]', /evidence.*(连续|匹配|正文|原文)/);
    expect(finalize).not.toHaveBeenCalled();
    expect(state.npcs[0].condition).toBe(old);
  });
  it('先合法替换再遇到无效追加时，整份响应拒绝且旧状态不变', () => {
    const before = JSON.stringify(state);
    const finalize = vi.fn((d: Parameters<typeof finalizeDelta>[0]) => finalizeDelta(d, []));
    const raw = JSON.stringify({ summary: '恢复。', stateChanges: ['npcs'], npcs: { update: [{ name: '小A', conditionPatch: {
      replace: [{ id: 'c1', text: '手腕已痊愈', evidence: '医生确认手腕已经痊愈' }],
      add: [{ text: '可负重', evidence: '医生允许负重' }],
    } }] } });
    expectConditionItemError(() => parseSummaryResponse(raw, { requireStateChanges: true, finalize,
      conditionContext: { ...state, content: source, strict: true } }),
    'conditionPatch.add[0]', /evidence.*(连续|匹配|正文|原文)/);
    expect(finalize).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).toBe(before);
  });
});
