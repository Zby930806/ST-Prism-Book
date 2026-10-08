import type { ViewNode } from '@/memory/select';

export const SUMMARY_PAGE_SIZE = 20;
export const PENDING_PAGE_SIZE = 40;
export type FloorRange = [number, number];

/** 每次数据变更建立一次索引；显式栈避免旧 L1/L2 或异常深链耗尽调用栈。 */
export function createSummaryIndex(byId: Map<string, ViewNode>) {
  const ranges = new Map<string, FloorRange>();
  const intact = new Map<string, boolean>();
  const state = new Map<string, number>();
  const referenced = new Set<string>();
  for (const node of byId.values()) for (const id of node.childIds) referenced.add(id);
  for (const start of byId.values()) {
    if (state.get(start.id) === 2) continue;
    const stack = [{ node: start, next: 0, lo: Infinity, hi: -Infinity, ok: true }];
    state.set(start.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const n = frame.node;
      if (n.kind === 'leaf' || n.atomic) {
        const floors = n.atomic ? [n.floorStart, n.floorEnd] : [n.msgIndex];
        for (const floor of floors) if (typeof floor === 'number' && Number.isFinite(floor)) {
          frame.lo = Math.min(frame.lo, floor);
          frame.hi = Math.max(frame.hi, floor);
        }
      } else if (frame.next < n.childIds.length) {
        const id = n.childIds[frame.next];
        const child = byId.get(id);
        if (child && !state.has(id)) {
          state.set(id, 1);
          stack.push({ node: child, next: 0, lo: Infinity, hi: -Infinity, ok: true });
          continue;
        }
        frame.next++;
        if (!child || state.get(id) === 1) { frame.ok = false; continue; }
        const range = ranges.get(id)!;
        if (range[0] >= 0) frame.lo = Math.min(frame.lo, range[0]);
        if (range[1] >= 0) frame.hi = Math.max(frame.hi, range[1]);
        frame.ok = frame.ok && intact.get(id) === true;
        continue;
      }
      ranges.set(n.id, [frame.lo === Infinity ? -1 : frame.lo, frame.hi === -Infinity ? -1 : frame.hi]);
      intact.set(n.id, n.kind === 'leaf' || n.atomic === true || (frame.ok && n.childIds.length > 0));
      state.set(n.id, 2);
      stack.pop();
    }
  }
  const floors = (n: ViewNode): FloorRange => ranges.get(n.id) ?? [-1, -1];
  // 与 selectViewNodes(..., () => true) 同口径：失效链降级，完整旁支保留。
  const roots: ViewNode[] = [];
  const visited = new Set<string>();
  const stack = [...byId.values()].filter(n => !referenced.has(n.id)).reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    if (intact.get(n.id)) { roots.push(n); continue; }
    for (let i = n.childIds.length - 1; i >= 0; i--) {
      const child = byId.get(n.childIds[i]);
      if (child) stack.push(child);
    }
  }
  roots.sort((a, b) => floors(b)[1] - floors(a)[1] || floors(a)[0] - floors(b)[0]);
  const childCounts = new Map<string, number>();
  for (const n of byId.values()) childCounts.set(n.id, n.atomic || n.kind === 'leaf' ? 0 : new Set(n.childIds.filter(id => byId.has(id))).size);
  const childCount = (n: ViewNode) => childCounts.get(n.id) ?? 0;
  const childCache = new Map<string, ViewNode[]>();
  function children(n: ViewNode): ViewNode[] {
    if (n.kind === 'leaf' || n.atomic) return [];
    let result = childCache.get(n.id);
    if (!result) {
      result = [...new Set(n.childIds)].map(id => byId.get(id)).filter((v): v is ViewNode => !!v);
      result.sort((a, b) => floors(b)[1] - floors(a)[1]);
      childCache.set(n.id, result);
    }
    return result;
  }
  return { roots, floors, children, childCount };
}

export interface TreeRow { node: ViewNode; depth: number; parentId?: string }
export function* walkExpanded(roots: ViewNode[], children: (n: ViewNode) => ViewNode[], expanded: Set<string>): Generator<TreeRow> {
  const seen = new Set<string>();
  const stack: Array<{ nodes: ViewNode[]; next: number; parentId?: string }> = [{ nodes: roots, next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.next === frame.nodes.length) { stack.pop(); continue; }
    const node = frame.nodes[frame.next++];
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    yield { node, depth: stack.length - 1, parentId: frame.parentId };
    if (expanded.has(node.id)) stack.push({ nodes: children(node), next: 0, parentId: node.id });
  }
}

export function pageNumber(page: number, total: number, size: number): number {
  return Math.max(1, Math.min(Number.isFinite(page) ? Math.floor(page) : 1, Math.max(1, Math.ceil(total / size))));
}
export function arrayPage<T>(items: T[], page: number, size = SUMMARY_PAGE_SIZE) {
  const current = pageNumber(page, items.length, size);
  return { items: items.slice((current - 1) * size, current * size), page: current, total: items.length };
}
/** 仅为当前页创建展示项。分页不会创建全量行，更不会创建嵌套组件。 */
export function treePage(index: ReturnType<typeof createSummaryIndex>, expanded: Set<string>, page: number, size = SUMMARY_PAGE_SIZE): { items: TreeRow[]; total: number; page: number } {
  let total = 0;
  const items: TreeRow[] = [];
  const requested = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
  for (const row of walkExpanded(index.roots, index.children, expanded)) {
    if (total >= (requested - 1) * size && items.length < size) items.push(row);
    total++;
  }
  const current = pageNumber(requested, total, size);
  if (current !== requested) return treePage(index, expanded, current, size);
  return { items, total, page: current };
}
