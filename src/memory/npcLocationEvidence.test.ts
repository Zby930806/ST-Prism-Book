import { describe, expect, it, vi } from 'vitest';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import { finalizeDelta } from './apply';
import type { SummaryDelta } from './types';
import { NPC_LOCATION_EVIDENCE_PROTOCOL, NpcLocationEvidenceError, validateNpcLocationEvidence } from './npcLocationEvidence';

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

describe('定位引文只容忍排版差异', () => {
  const accepted = [
    ['CRLF 与 LF', '小A在\r\n厨房等候。', '小A在\n厨房等候。'],
    ['中文折行可展平', '小A在\r\n  厨房等候。', '小A在厨房等候。'],
    ['证据内的折行与缩进', '小A在厨房等候。', '\n 小A在\n\t厨房等候。 \n'],
    ['空格/tab/全角空格/NBSP', '小A\t在\u3000厨房\u00a0等候。', '小A 在 厨房等候。'],
    ['段落连续且不跳字', '小A进入厨房。\r\n\r\n她坐在门边。', '小A进入厨房。她坐在门边。'],
    ['中文及标点旁空白', '小A 在厨房 ， 并未离开 。', '小A在厨房，并未离开。'],
    ['英文保留词间边界', 'Mira\tis\r\n in\u00a0the kitchen.', 'Mira is in the kitchen.'],
    ['正文粗体', '**小A**在**厨房**等候。', '小A在厨房等候。'],
    ['证据粗体', '小A在厨房等候。', '**小A**在**厨房**等候。'],
    ['斜体与粗斜体', '*小A*在***厨房***等候。', '小A在厨房等候。'],
    ['下划线强调', '__小A__ 在 _厨房_ 等候。', '小A在厨房等候。'],
    ['嵌套强调', '**小A在*厨房*等候。**', '小A在厨房等候。'],
    ['相邻短语分别强调', '**小A**，**正在厨房**等候。', '小A，正在厨房等候。'],
    ['强调与换行组合', '**小A**在\r\n\t*厨房*等候。', '小A在 厨房等候。'],
    ['强调内部软换行', '**小A在\r\n厨房等候。**', '小A在厨房等候。'],
    ['保留强调内否定', '小A**未**离开厨房。', '小A未离开厨房。'],
    ['精确片段保持旧合同', '**小A在厨房**等候。', '小A在厨房**等候。'],
  ];
  it.each(accepted.flatMap(([label, source, evidence]) => ['add', 'update'].map(op => [op, label, source, evidence])))
  ('%s 接受%s且保留整个定位及其他字段', (op, _case, source, evidence) => {
    const fields = { name: '小A', location: '厨房', condition: '手腕受伤', follow: false };
    const d = parse({ [op]: [{ ...fields, locationEvidence: evidence }] }, true, source);
    expect(d.npcs?.[op as 'add' | 'update']?.[0]).toEqual(fields);
    expect(JSON.stringify(d)).not.toContain('locationEvidence');
  });
  it.each(accepted)('%s（自定义模板主动采用时也使用同一校验）', (_case, source, evidence) => {
    expect(parse({ update: [{ name: '小A', location: '厨房', locationEvidence: evidence }] }, false, source).npcs?.update?.[0].location).toBe('厨房');
  });

  it.each([
    ['拼接不相邻片段', '**小A**推开门。小B在**厨房**等候。', '小A在厨房等候。'],
    ['拼接段落', '小A在\n庭院。\n小B在厨房。', '小A在厨房。'],
    ['省略中间正文', '小A在**厨房**与来客交谈后等候。', '小A在厨房等候。'],
    ['添加省略号', '小A在厨房与来客交谈后等候。', '小A在厨房…等候。'],
    ['自行加引号', '小A在厨房等候。', '“小A在厨房等候。”'],
    ['改写', '**小A**在厨房等候。', '小A正在厨房等待。'],
    ['调整语序', '**小A**正在厨房等候。', '小A在厨房正等候。'],
    ['删除标点', '**小A**在厨房，等候来客。', '小A在厨房等候来客。'],
    ['替换标点', '**小A**在厨房，等候来客。', '小A在厨房、等候来客。'],
    ['删除强调中的否定', '小A**未**在厨房。', '小A在厨房。'],
    ['删除换行旁的否定', '小A\r\n并不在厨房。', '小A在厨房。'],
    ['删除转折及前半句', '小A不是在厨房，而是在庭院。', '小A在厨房。'],
    ['删除英文否定', '**Mira** is not in the kitchen.', 'Mira is in the kitchen.'],
    ['合并英文单词', '**Mira** is now here.', 'Mira is nowhere.'],
    ['拆开英文单词', '**Mira** is nowhere.', 'Mira is now here.'],
    ['删除单词内下划线', '小A在 room_one 等候。', '小A在 roomone 等候。'],
    ['空行两侧不能当成配对强调', '小A在*厨房\n\n等候*。', '小A在厨房等候。'],
    ['字面星号不是强调', '小A在 2 * 3 * 4 号房。', '小A在 2 3 4 号房。'],
    ['单词内多个下划线不能删除', '小A在 room_one_two 等候。', '小A在 roomonetwo 等候。'],
    ['未配对符号不能删除', '小A在**厨房等候。', '小A在厨房等候。'],
    ['转义符号不能删除', '小A在\\*厨房\\*等候。', '小A在厨房等候。'],
    ['代码内容不能去强调', '`小A在**厨房**等候。`', '小A在厨房等候。'],
    ['围栏代码不能去强调', '```text\n小A在**厨房**等候。\n```', '小A在厨房等候。'],
    ['波浪围栏不能去强调', '~~~text\n小A在**厨房**等候。\n~~~', '小A在厨房等候。'],
    ['删除线保留', '小A~~不~~在厨房。', '小A在厨房。'],
    ['HTML 内容保留', '小A<span>不</span>在厨房。', '小A在厨房。'],
    ['链接内容不能跳过', '小A[不在](旧楼)厨房。', '小A在厨房。'],
    ['零宽字符不是可删空白', '小A不\u200b在厨房。', '小A在厨房。'],
    ['旧楼不可当本楼', '今天小A在庭院。', '**昨夜小A在厨房。**'],
  ])('拒绝%s', (_case, source, evidence) => {
    for (const strict of [true, false]) {
      expect(() => parse({ update: [{ name: '小A', location: '厨房', locationEvidence: evidence }] }, strict, source)).toThrow(SummaryResponseError);
    }
  });

  it('旧摘要、旧名册与响应 summary 都不是证据来源', () => {
    const evidence = '昨夜小A在厨房。';
    expect(() => parse({ update: [{ name: '小A', location: '厨房', locationEvidence: evidence }] }, true,
      '今天庭院下雨。', { summary: evidence, history: evidence, oldRoster: [{ name: '小A', location: '厨房', note: evidence }] })).toThrow(SummaryResponseError);
  });
  it.each([undefined, '', ' \r\n\t '])('缺少有效本楼正文仍拒绝：%j', source => {
    expect(() => validateNpcLocationEvidence({ npcs: { update: [{ name: '小A', location: '厨房', locationEvidence: '**小A**在厨房。' }] } },
      { strict: true, content: source })).toThrow(NpcLocationEvidenceError);
  });
});

describe('定位证据的错误与纠错合同', () => {
  it('错误包含实际操作路径和 name，但不泄漏正文、引文或地点', () => {
    const source = '本楼保密正文：小B在庭院。';
    const evidence = '错误响应保密引文：小A在仓库。';
    const name = '小A';
    try {
      parse({ update: [{ name: '小B', follow: false }, { name, location: '保密地点', locationEvidence: evidence }] }, true, source);
      expect.unreachable('应抛出正式错误');
    } catch (error) {
      expect(error).toBeInstanceOf(SummaryResponseError);
      const message = (error as Error).message;
      expect(message.startsWith('角色定位引文与本楼正文不匹配。')).toBe(true);
      expect(message).toContain('\n定位诊断：npcs.update[1]');
      expect(message).toContain('npcs.update[1]');
      expect(message).toContain('name="小A"');
      expect(message).toContain('locationEvidence');
      expect(message.indexOf('locationEvidence')).toBeGreaterThan(message.indexOf('\n定位诊断：'));
      expect(message).toContain('重写完整 JSON');
      expect(message).not.toContain(source);
      expect(message).not.toContain(evidence);
      expect(message).not.toContain('保密地点');
    }
  });
  it('缺证据与重复定位也能定位角色', () => {
    expect(() => parse({ add: [{ name: '小A', location: '厨房' }] })).toThrow('npcs.add[0] (name="小A")');
    expect(() => parse({ update: [{ name: '小A', follow: false }, { name: '小A', follow: true }] })).toThrow('npcs.update[1] (name="小A")');
  });
  it('有界 name 转义换行，不回显任意长名称', () => {
    const name = '小A\n' + '密'.repeat(100);
    try {
      parse({ add: [{ name, location: '厨房' }] });
      expect.unreachable('应抛出正式错误');
    } catch (error) {
      expect(error).toBeInstanceOf(SummaryResponseError);
      expect((error as Error).message).toContain('小A\\n');
      expect((error as Error).message.split('\n定位诊断：')[1]).not.toContain('\n');
      expect((error as Error).message).not.toContain('密'.repeat(41));
    }
  });
  it('任一证据失败不消费前面的证据，也不吞掉 location', () => {
    const valid = { name: '小A', location: '厨房', locationEvidence: '**小A**在厨房。' };
    const invalid = { name: '小B', location: '庭院', locationEvidence: '小B在庭院。' };
    const parsed = { npcs: { update: [valid, invalid] } };
    const before = JSON.stringify(parsed);
    expect(() => validateNpcLocationEvidence(parsed, { strict: true, content: '小A在厨房。' })).toThrow(NpcLocationEvidenceError);
    expect(JSON.stringify(parsed)).toBe(before);
  });
  it('失败不进入 finalize；完整纠正后保留定位并清除临时证据', () => {
    const finalize = vi.fn((d: SummaryDelta) => finalizeDelta(d, []));
    const options = { requireStateChanges: true, sourceContent: '**小A**在厨房。', finalize };
    const response = (evidence: string) => JSON.stringify({ summary: '小A在厨房。', stateChanges: ['npcs'],
      npcs: { update: [{ name: '小A', location: '厨房', locationEvidence: evidence }] } });
    expect(() => parseSummaryResponse(response('小A在庭院。'), options)).toThrow(SummaryResponseError);
    expect(finalize).not.toHaveBeenCalled();
    const result = parseSummaryResponse(response('小A在厨房。'), options);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(result.npcs?.update?.[0]).toMatchObject({ name: '小A', location: '厨房' });
    expect(JSON.stringify(result)).not.toContain('locationEvidence');
  });
  it('提示协议同时描述格式容错与证据保护', () => {
    expect(NPC_LOCATION_EVIDENCE_PROTOCOL).toContain('连续照录');
    expect(NPC_LOCATION_EVIDENCE_PROTOCOL).toContain('排版空白');
    expect(NPC_LOCATION_EVIDENCE_PROTOCOL).toContain('成对 Markdown 行内强调');
    expect(NPC_LOCATION_EVIDENCE_PROTOCOL).toContain('否定必须保留');
    expect(NPC_LOCATION_EVIDENCE_PROTOCOL).toContain('不能引用旧名册');
  });
});
