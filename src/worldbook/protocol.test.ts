import { describe, expect, it } from 'vitest';
import { extractReplyJson, normalizeEdit, parseWorldbookReply, validateActions, WorldbookProtocolError } from './protocol';
import { entryBase } from './entries';
import type { WorldData } from './types';

// 只测协议本身：解析、逐条校验、权限拦截。全部本地数据，不请求模型。
function book(): WorldData {
  return {
    entries: {
      0: { uid: 0, comment: '雾港', key: ['雾港', '港城'], content: '潮汐环绕的港城。城北有一座旧钟塔。', constant: false },
      3: { uid: 3, comment: '钟塔守则', key: ['钟塔'], content: '入夜后钟塔不对外开放。看守只认怀表。', constant: true },
      7: { uid: 7, comment: '旧书店', key: ['书店'], content: '旧街尽头的书店。', disable: true },
      9: { uid: 9, comment: '修表铺', key: ['修表铺'], content: '旧街的修表铺。' },
    },
  };
}
let seq = 0;
const input = (permission: 'create' | 'supplement' | 'modify' = 'modify', data = book()) => ({ data, permission, range: { from: 10, to: 20 }, newId: () => 'id-' + (++seq) });
const reply = (actions: unknown[]) => JSON.stringify({ actions });

describe('世界书建议协议：JSON 提取', () => {
  it('内容里带网址和 // 时整批照常解析（不把 // 当注释删掉）', () => {
    const text = '{"actions":[{"action":"create","title":"港务局","keys":["港务局"],"content":"官网 https://port.example/notice // 公告在此","reason":"r","floors":[12]}]}';
    const result = parseWorldbookReply(text, input());
    expect(result.dropped).toEqual([]);
    expect(result.suggestions[0].content).toBe('官网 https://port.example/notice // 公告在此');
  });

  it('剥离字符串之外的思考块和代码围栏；字符串里的 ``` 不会截错', () => {
    const text = '<think>先想想 {不是 JSON}</think>说明文字\n```json\n{"actions":[{"action":"create","title":"码头","keys":["码头"],"content":"示例 ``` 不是围栏","reason":"","floors":[]}]}\n```';
    expect((extractReplyJson(text) as { actions: Array<{ content: string }> }).actions[0].content).toBe('示例 ``` 不是围栏');
  });

  it('只修复字符串之外的尾随逗号，字符串内容一字不动', () => {
    const text = '{"actions":[{"action":"create","title":"灯塔","keys":["灯塔",],"content":"逗号,}保留","floors":[],},],}';
    const value = extractReplyJson(text) as { actions: Array<{ content: string; keys: string[] }> };
    expect(value.actions[0].content).toBe('逗号,}保留');
    expect(value.actions[0].keys).toEqual(['灯塔']);
  });

  it('不完整、没有 JSON、只有未写完的思考时给出明确原因', () => {
    expect(() => extractReplyJson('{"actions":[{"action":"create"')).toThrow(/不完整/);
    expect(() => extractReplyJson('没有需要写入的内容')).toThrow(/没有 JSON/);
    expect(() => extractReplyJson('<think>还在想')).toThrow(/思考/);
    expect(() => extractReplyJson('{"actions": [1 2]}')).toThrow(WorldbookProtocolError);
  });

  it('根对象必须有 actions 数组；空数组表示没有建议', () => {
    expect(() => validateActions({ suggestions: [] }, input())).toThrow(/actions/);
    expect(validateActions({ actions: [] }, input())).toEqual({ suggestions: [], dropped: [] });
  });
});

describe('世界书建议协议：动作校验', () => {
  it('已有条目按 uid 指定，uid 为 0 的条目可以修改；记下生成时的内容指纹', () => {
    const data = book();
    const result = parseWorldbookReply(reply([{ action: 'append', uid: 0, text: '港口每月初一开市。', addKeys: ['港口'], reason: '第12楼', floors: [12, 99] }]), input('modify', data));
    expect(result.dropped).toEqual([]);
    expect(result.suggestions[0]).toMatchObject({ kind: 'append', uid: 0, title: '雾港', keys: ['港口'], content: '港口每月初一开市。', floors: [12], base: entryBase(data.entries[0]) });
    expect(result.suggestions[0].warnings.join()).toContain('不在本次读取的范围');
  });

  it('不按名字模糊匹配：没有 uid 或 uid 不存在时丢弃并说明', () => {
    const result = parseWorldbookReply(reply([
      { action: 'append', title: '雾港', text: '新内容' },
      { action: 'append', uid: 42, text: '新内容' },
      { action: 'append', uid: '3', text: '数字字符串 uid 可以' },
      { action: 'append', uid: '钟塔', text: '名字不行' },
    ]), input());
    expect(result.suggestions.map(s => s.uid)).toEqual([3]);
    expect(result.dropped.map(d => d.reason)).toEqual([
      expect.stringContaining('缺少 uid'), expect.stringContaining('没有 uid 为 42'), expect.stringContaining('缺少 uid'),
    ]);
  });

  it.each([
    ['create', ['create', 'flag'], ['append', 'keys', 'replace', 'rewrite']],
    ['supplement', ['create', 'append', 'keys', 'flag'], ['replace', 'rewrite']],
    ['modify', ['create', 'append', 'keys', 'replace', 'rewrite', 'flag'], []],
  ] as const)('修改权限「%s」：代码强制拦截超出权限的动作', (permission, allowed, blocked) => {
    const result = parseWorldbookReply(reply([
      { action: 'create', title: '新地点', keys: ['新地点'], content: '内容' },
      { action: 'append', uid: 0, text: '追加的一句。' },
      { action: 'keys', uid: 7, addKeys: ['旧街书店'] },
      { action: 'replace', uid: 3, find: '看守只认怀表。', text: '看守只认钥匙。' },
      { action: 'rewrite', uid: 9, content: '改写后的修表铺说明。' },
      { action: 'flag', uid: 3, reason: '守则可能过时' },
    ]), input(permission));
    expect(result.suggestions.map(s => s.kind)).toEqual(allowed);
    expect(result.dropped).toHaveLength(blocked.length);
    for (const d of result.dropped) expect(d.reason).toContain('当前修改权限为');
  });

  it('新建：同名条目、重复标题、缺关键词、过长内容丢弃；过短关键词忽略并提示', () => {
    const result = parseWorldbookReply(reply([
      { action: 'create', title: '雾港', keys: ['雾港'], content: '重复' },
      { action: 'create', title: '灯塔', keys: ['灯', '灯塔', '灯塔'], content: '港口外的灯塔。' },
      { action: 'create', title: '灯塔', keys: ['灯塔'], content: '再来一次' },
      { action: 'create', title: '无关键词', keys: ['某'], content: '内容' },
      { action: 'create', title: '太长', keys: ['太长'], content: '字'.repeat(1501) },
    ]), input('create'));
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ title: '灯塔', keys: ['灯塔'] });
    expect(result.suggestions[0].warnings[0]).toContain('过短');
    expect(result.dropped.map(d => d.reason)).toEqual([
      expect.stringContaining('已有同名条目'), expect.stringContaining('本批已有同名'), expect.stringContaining('没有可用的关键词'), expect.stringContaining('超过 1500 字'),
    ]);
  });

  it('替换：原文必须逐字出现且只出现一次；替换为空表示删去这段', () => {
    const data: WorldData = { entries: { 1: { uid: 1, comment: '规矩', key: ['规矩'], content: '甲。乙。甲。丙。' } } };
    const result = parseWorldbookReply(reply([
      { action: 'replace', uid: 1, find: '甲。', text: '丁。' },
    ]), input('modify', data));
    expect(result.dropped[0].reason).toContain('出现了 2 次');
    const missing = parseWorldbookReply(reply([{ action: 'replace', uid: 1, find: '戊。', text: '丁。' }]), input('modify', data));
    expect(missing.dropped[0].reason).toContain('找不到');
    const removal = parseWorldbookReply(reply([{ action: 'replace', uid: 1, find: '乙。', text: '' }]), input('modify', data));
    expect(removal.suggestions[0]).toMatchObject({ kind: 'replace', find: '乙。', content: '' });
  });

  it('同一条目一批只采用一条修改；已有内容的追加、重复关键词丢弃', () => {
    const result = parseWorldbookReply(reply([
      { action: 'append', uid: 0, text: '城北有一座旧钟塔。' },
      { action: 'keys', uid: 0, addKeys: ['雾港', '港城'] },
      { action: 'append', uid: 3, text: '新的一句。' },
      { action: 'rewrite', uid: 3, content: '整段改写。' },
    ]), input('modify'));
    expect(result.suggestions.map(s => [s.kind, s.uid])).toEqual([['append', 3]]);
    expect(result.dropped.map(d => d.reason)).toEqual([
      expect.stringContaining('已有这段内容'), expect.stringContaining('都已存在'), expect.stringContaining('已有一条修改建议'),
    ]);
  });

  it('不支持的动作说明原因；超过 12 条的部分丢弃；未知字段只提示不写入', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ action: 'create', title: '地点' + i, keys: ['地点' + i], content: '内容', position: 4 }));
    const result = parseWorldbookReply(reply([{ action: 'delete', uid: 0 }, { action: 'set_field', uid: 0 }, { action: 'constructor' }, ...many]), input('create'));
    expect(result.dropped.slice(0, 3).map(d => d.reason)).toEqual([
      expect.stringContaining('不支持删除'), expect.stringContaining('常驻、位置'), expect.stringContaining('不认识的动作'),
    ]);
    expect(result.suggestions).toHaveLength(12);
    expect(result.dropped.slice(3).every(d => d.reason.includes('12 条'))).toBe(true);
    expect(result.suggestions[0].warnings.join()).toContain('position');
    expect(result.suggestions[0]).not.toHaveProperty('position');
  });

  it('提醒必须写明原因，只显示不写入；各档都允许', () => {
    const result = parseWorldbookReply(reply([{ action: 'flag', uid: 3 }, { action: 'flag', uid: 3, reason: '正文改了开放时间', floors: [15] }]), input('create'));
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ kind: 'flag', uid: 3, reason: '正文改了开放时间', floors: [15] });
    expect(result.dropped[0].reason).toContain('没有写明原因');
  });
});

describe('编辑建议的校验', () => {
  it('与模型输出同一套规则', () => {
    const data = book();
    expect(normalizeEdit('create', { title: ' 码头 ', keys: '码头，渡口', content: '内容', find: '' }, null, data)).toEqual({ title: '码头', keys: ['码头', '渡口'], content: '内容', find: '' });
    expect(() => normalizeEdit('create', { title: '雾港', keys: '雾港', content: '内容', find: '' }, null, data)).toThrow(/同名/);
    expect(() => normalizeEdit('replace', { title: '', keys: '', content: '新', find: '不存在' }, data.entries[3], data)).toThrow(/找不到/);
    expect(normalizeEdit('append', { title: '', keys: ['钟塔', '塔楼'], content: '新增。', find: '' }, data.entries[3], data)).toEqual({ title: '', keys: ['塔楼'], content: '新增。', find: '' });
  });
});
