import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import { memory } from '@/memory/store';
import { renderHistoryNodes } from '@/memory/inject';
import type { ViewNode } from '@/memory/select';
import type { MemNpc, MemScene } from '@/memory/types';
import { fitDigestSections, fitHistoryNodes, fitNewestLines, memoryBudgetLimited, memoryStateDigest, memoryStateSections, type DigestSection } from './memoryDigest';

// 札记与规划读取记忆的紧凑文字：分段顺序、角色分组、限字数时的省略方式。记忆用本地对象替身。
vi.mock('@/memory/store', () => ({
  memory: { summaries: [], state: { time: '', location: '', sceneFocus: null }, protagonist: {}, npcs: [], items: [], plans: [], scenes: [], lifeDetails: [], vars: {} },
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ renderHistoryNodes: vi.fn((nodes: ViewNode[]) => nodes.map(n => n.text).join('\n\n')) }));

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const original = copy(memory);
const scene = (id: string, path: string[], parentId = ''): MemScene => ({ id, name: path[path.length - 1], path, parentId, createdAt: 1, updatedAt: 1 });
const npc = (name: string, fields: Partial<MemNpc> = {}): MemNpc => ({ id: `npc:${name}`, name, createdAt: 1, updatedAt: 1, ...fields });
const node = (text: string): ViewNode => ({ id: text.slice(0, 6), kind: 'comp', level: 1, text, childIds: [], msgIndex: -1, createdAt: 1, active: true });

beforeEach(() => { apiSettings.memoryBudgetTokens = 0; });
afterEach(() => { Object.assign(memory, copy(original)); apiSettings.memoryBudgetTokens = 0; vi.mocked(renderHistoryNodes).mockClear(); });

describe('记忆注入预算是否限制札记与规划资料', () => {
  it('0（默认）或无法识别时不限制；填写数值后限制', () => {
    expect(memoryBudgetLimited()).toBe(false);
    apiSettings.memoryBudgetTokens = 6000; expect(memoryBudgetLimited()).toBe(true);
    apiSettings.memoryBudgetTokens = Number.NaN; expect(memoryBudgetLimited()).toBe(false);
  });
});

describe('状态分段', () => {
  it('按重要程度排列；主要角色和在场、同区域的角色与其余角色分开，其余角色按最近出场排序、只列名字身份和所在地', () => {
    Object.assign(memory, {
      state: { time: '第二天清晨', location: '客栈大堂', locationPath: ['王都', '客栈', '客栈大堂'], sceneFocus: null },
      scenes: [scene('s1', ['王都']), scene('s2', ['王都', '客栈'], 's1'), scene('s3', ['王都', '客栈', '客栈大堂'], 's2'), scene('s4', ['王都', '客栈', '后院'], 's2'), scene('s5', ['边境'])],
      npcs: [
        npc('远方的旧友', { location: '边境', title: '镖师', personality: '不该出现在简列里', lastFloor: 3 }),
        npc('掌柜', { location: '客栈大堂', title: '客栈掌柜', personality: '精明' }),
        npc('马夫', { location: '后院', title: '马夫' }),
        npc('师父', { important: true, location: '边境', title: '剑客' }),
        npc('更近出场的商人', { location: '边境', title: '行商', lastFloor: 9 }),
      ],
      plans: [{ id: 'p', kind: 'suspense', content: '密信是谁送来的', status: 'open', createdAt: 1 }],
      items: [{ id: 'i', name: '密信', qty: 1, createdAt: 1, updatedAt: 1 }],
    });
    const sections = memoryStateSections({ userName: '林' });
    expect(sections.map(s => s.name)).toEqual(['计划与悬念', '时间地点与局势', '主要与在场角色', '物品', '其余角色']);
    const main = sections[2].lines.join('\n');
    expect(main.indexOf('师父')).toBeLessThan(main.indexOf('掌柜'));
    expect(main).toContain('〔在场〕'); expect(main).toContain('马夫'); expect(main).toContain('〔同区域〕');
    const others = sections[4].lines;
    expect(others[0]).toContain('更近出场的商人'); expect(others[1]).toContain('远方的旧友');
    expect(others.join('\n')).not.toMatch(/不该出现在简列里|〔简列〕/);
    expect(sections.flatMap(s => s.lines).join('\n')).not.toMatch(/npc:|createdAt|updatedAt/);
  });
  it('规划另带已知地点、生活档案和自定义变量；变量 JSON 不拆开', () => {
    Object.assign(memory, {
      scenes: [scene('s1', ['王都'])],
      lifeDetails: [{ id: 'd1', subject: 'user', text: '不吃香菜', topics: [], anchors: [], tier: 'pinned' }],
      vars: { 金钱: 30 },
    });
    expect(memoryStateSections({}).map(s => s.name)).toEqual([]);
    const extended = memoryStateSections({ userName: '林', extended: true });
    expect(extended.map(s => s.name)).toEqual(['已知地点', '生活档案', '自定义变量']);
    expect(extended[1].lines[0]).toBe('- [置顶] 林：不吃香菜');
    expect(extended[2]).toMatchObject({ atomic: true });
    expect(memoryStateDigest({ extended: true })).toContain('"金钱": 30');
  });
});

describe('限字数时的省略方式', () => {
  const sections: DigestSection[] = [
    { name: '甲', title: '甲段', lines: ['- 甲1', '- 甲2'] },
    { name: '乙', title: '乙段', lines: ['- ' + '乙'.repeat(200), '- 乙短'] },
    { name: '丙', title: '丙段', lines: ['{"大":"' + '丙'.repeat(300) + '"}'], atomic: true },
    { name: '丁', title: '丁段', lines: ['- 丁1'] },
  ];
  it('放得下时原样全部输出', () => {
    expect(fitDigestSections(sections, Infinity)).toEqual({ text: expect.stringContaining('[丁段]'), omitted: 0 });
  });
  it('段内逐条放，放不下的那条及之后的同段条目省略；不能拆的整段省略；末尾注明并且总长不超过上限', () => {
    const { text, omitted } = fitDigestSections(sections, 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('[甲段]\n- 甲1\n- 甲2');
    expect(text).not.toContain('乙短'); expect(text).not.toContain('丙丙');
    expect(text).toContain('[丁段]\n- 丁1');
    expect(text).toMatch(/因字数上限另有 \d+ 条状态没有列出：乙、丙/);
    expect(omitted).toBe(3);
  });
  it('上限很小时只保留优先级最高的部分和省略说明', () => {
    const { text } = fitDigestSections(sections, 60);
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text).toContain('没有列出');
  });
});

describe('历史摘要和逐行列表从最新往前连续保留', () => {
  it('遇到第一条放不下就停，不跳过去取更早、更短的；开头注明省略了几条', () => {
    const nodes = [node('最早'.repeat(5)), node('中间'.repeat(200)), node('最新'.repeat(20))];
    const { text, omitted } = fitHistoryNodes(nodes, 100);
    expect(omitted).toBe(2); expect(text.length).toBeLessThanOrEqual(100);
    expect(text.startsWith('（更早的 2 条摘要和总结因字数上限省略。）')).toBe(true);
    expect(text).toContain('最新'.repeat(20)); expect(text).not.toContain('最早');
    expect(fitHistoryNodes(nodes).text).toBe(nodes.map(n => n.text).join('\n\n'));
    expect(fitHistoryNodes([node('长'.repeat(500))], 50).text).toBe('（1 条摘要和总结超出字数上限，没有列出。）');
  });
  it('逐行列表保留最新的几行并说明较早的省略了几条', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- 第${i}行`);
    const { text, omitted } = fitNewestLines(lines, 40, '安排');
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text).toContain('- 第9行'); expect(text).not.toContain('- 第0行');
    expect(text).toMatch(new RegExp(`^（另有 ${omitted} 条较早的安排因字数上限没有列出。）`));
    expect(fitNewestLines(lines).text).toBe(lines.join('\n'));
  });
});
