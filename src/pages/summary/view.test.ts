import { describe, it, expect, vi } from 'vitest';
import { arrayPage, createSummaryIndex, treePage, walkExpanded } from './view';
import { selectViewNodes, type ViewNode } from '@/memory/select';
const leaf = (i: number): ViewNode => ({ id: `l${i}`, kind: 'leaf', level: 0, text: `合成摘要${i}`, createdAt: i, childIds: [], msgIndex: i, active: true });
const comp = (id: string, childIds: string[], level = 1): ViewNode => ({ id, kind: 'comp', level, text: `合成总结${id}`, createdAt: 1, childIds, msgIndex: -1, active: false });
const map = (nodes: ViewNode[]) => new Map(nodes.map(n => [n.id, n]));
describe('摘要树有界视图（仅合成数据）', () => {
  it('10000 根节点每页最多 20 条，完整可达且页码收缩有界', () => {
    const index = createSummaryIndex(map(Array.from({ length: 10000 }, (_, i) => leaf(i))));
    expect(treePage(index, new Set(), 1).items).toHaveLength(20);
    expect(treePage(index, new Set(), 999).page).toBe(500);
    expect(treePage(index, new Set(), 500).items.at(-1)?.node.id).toBe('l0');
    expect(arrayPage([1,2,3], Infinity).page).toBe(1);
    expect(arrayPage([], -1).items).toEqual([]);
  });
  it('折叠时不展开后代，全部展开后也只有 20 张卡片', () => {
    const leaves = Array.from({ length: 10000 }, (_, i) => leaf(i));
    const index = createSummaryIndex(map([...leaves, comp('root', leaves.map(n => n.id), 2)]));
    const children = vi.spyOn(index, 'children');
    expect(treePage(index, new Set(), 1).total).toBe(1);
    expect(children).not.toHaveBeenCalled();
    const expanded = treePage(index, new Set(['root']), 2);
    expect(expanded.total).toBe(10001);
    expect(expanded.items).toHaveLength(20);
    expect(expanded.items[0]).toMatchObject({ depth: 1, parentId: 'root' });
    expect(treePage(index, new Set(), 80)).toMatchObject({ page: 1, total: 1 });
  });
  it('20000 层深链不递归爆栈，楼层范围和迭代保持正确', () => {
    const nodes = [leaf(7)];
    for (let i = 0; i < 20000; i++) nodes.push(comp(`c${i}`, [i ? `c${i-1}` : 'l7'], i+1));
    const index = createSummaryIndex(map(nodes));
    expect(index.floors(nodes.at(-1)!)).toEqual([7,7]);
    expect(treePage(index, new Set(nodes.map(n => n.id)), 1001).items).toHaveLength(1);
  });
  it('旧 L1/L2、缺失 child 降级和 imported 语义与旧选择算法一致', () => {
    const nodes = [leaf(1), leaf(2), leaf(3), comp('L1a',['l1','l2']), comp('L1b',['l3','missing']), comp('L2',['L1a','L1b'],2), { ...comp('history', [],2), atomic: true, floorStart: 0, floorEnd: 0 }];
    const byId = map(nodes), index = createSummaryIndex(byId);
    const referenced = new Set(nodes.flatMap(n => n.childIds));
    const expected = selectViewNodes({ byId, roots: nodes.filter(n => !referenced.has(n.id)) }, () => true).sort((a,b) => index.floors(b)[1] - index.floors(a)[1]);
    expect(index.roots.map(n => n.id)).toEqual(expected.map(n => n.id));
    expect(index.roots.map(n => n.id)).toEqual(['l3','L1a','history']);
    expect(index.floors(nodes.at(-1)!)).toEqual([0,0]);
    expect(index.childCount(nodes.at(-1)!)).toBe(0);
  });
  it('多种正常森林的展示根与原 selectViewNodes 保持一致', () => {
    for (let seed = 0; seed < 30; seed++) {
      const nodes = Array.from({length: 100}, (_,i) => leaf(i));
      for (let i = 0; i < 20; i++) nodes.push(comp(`c${i}`, [`l${i*2}`, seed % 3 && i % 4 === 0 ? 'missing' : `l${i*2+1}`]));
      for (let i=0;i<5;i++) nodes.push(comp(`d${i}`, [`c${i*2}`, `c${i*2+1}`],2));
      const byId = map(nodes), index = createSummaryIndex(byId), refs = new Set(nodes.flatMap(n=>n.childIds));
      expect(index.roots.map(n=>n.id)).toEqual(selectViewNodes({byId,roots:nodes.filter(n=>!refs.has(n.id))},()=>true).sort((a,b)=>index.floors(b)[1]-index.floors(a)[1]).map(n=>n.id));
    }
  });
  it('异常环、重复 child、悬空引用不造成无限遍历', () => {
    const nodes=[leaf(1), comp('a',['b','l1','l1']), comp('b',['a']), comp('root',['a','missing'])];
    const index=createSummaryIndex(map(nodes));
    expect(index.roots.map(n=>n.id)).toEqual(['l1']);
    expect([...walkExpanded([nodes[1]], index.children, new Set(['a','b']))]).toHaveLength(3);
    expect(index.childCount(nodes[1])).toBe(2);
  });
});

// 样式约束直接验证页面 scoped CSS，避免全局主题已清理而局部又恢复模糊。
describe('摘要页局部渲染约束', () => {
  it('scoped 样式无模糊、装饰渐变或变量驱动的大阴影', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const name of ['index.vue', 'SummaryNode.vue', 'SummaryPager.vue']) {
      const source = await readFile(new URL(name, import.meta.url), 'utf8');
      const css = source.slice(source.indexOf('<style'));
      expect(css).not.toMatch(/backdrop-filter|blur\(|gradient\(|box-shadow:\s*var\(/);
    }
    const node = await readFile(new URL('SummaryNode.vue', import.meta.url), 'utf8');
    expect(node).not.toMatch(/<SummaryNode\b/);
  });
});
