/**
 * 森林节点的「最小拆解」选择算法 —— 纯函数、零依赖(便于单测,注入与列表共用)。
 *
 * 背景:摘要是一棵森林,叶子(L0,挂消息 extra)+ 压缩节点(L1/L2…,childIds 引用下层)。
 * 给定一组「合格」叶子(由 leafEligible 判定),要为每个合格叶子选一个**最高的、能整体代表它的
 * 节点**(省 token):若某压缩节点的全部后代叶子都合格,就用这一个节点代表整段;否则降级、逐子递归。
 *
 * 完好性(intact):压缩节点的某个 childId 指向的叶子若已失效(翻页到别的 swipe → 不在 byId 里),
 * 则该节点**不完整**——它的压缩文本嵌着失效那页的旧叙事,不能作为整体代表(会与当前正文冲突)。
 * 此时降级递归,改用它**仍完好的子节点**各自代表:受影响的那条链一路拆到叶子层、跳过失效叶子,
 * 而旁支完好的子节点(如同层另一条 L1)整条保留。节点失活只是「当前不展示/不注入」,森林数据不删除。
 */

/** 统一视图节点:叶子来自 chat 扫描,压缩节点来自森林,childIds 跨存储连接 */
export interface ViewNode {
  id: string;
  kind: 'leaf' | 'comp';
  level: number; // leaf=0,comp=该压缩层级(供列表显示「总结L{level}」)
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string; // 旧数据回退
  createdAt: number;
  childIds: string[]; // comp 才有
  msgIndex: number; // leaf 才有意义(排序键);comp 取 -1
  active: boolean; // leaf:所在消息已隐藏
  /** 无逐楼 child 的导入历史节点;选择算法把它视为与 leaf 同类的完整终端。 */
  atomic?: boolean;
  /** 原子导入历史的显式楼层范围。 */
  floorStart?: number;
  floorEnd?: number;
}

/**
 * 在已构建的森林视图上做选择(注入/列表共用)。逻辑见文件头注释。
 * byId 只收**有效**叶子 + 全部压缩节点;roots = 未被任何 childIds 引用的节点。
 */
export function selectViewNodes(
  view: { byId: Map<string, ViewNode>; roots: ViewNode[] },
  leafEligible: (n: ViewNode) => boolean,
): ViewNode[] {
  const { byId, roots } = view;

  const collectLeaves = (n: ViewNode, acc: ViewNode[]): void => {
    if (n.kind === 'leaf' || n.atomic) {
      acc.push(n);
      return;
    }
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) collectLeaves(c, acc);
    }
  };
  // 完好:每个 childId 都能解析(无悬空)且子节点自身也完好;叶子恒完好。memoized。
  const intactMemo = new Map<string, boolean>();
  const isIntact = (n: ViewNode): boolean => {
    if (n.kind === 'leaf' || n.atomic) return true;
    const cached = intactMemo.get(n.id);
    if (cached !== undefined) return cached;
    intactMemo.set(n.id, false); // 防环:递归未归前先占位 false
    let ok = n.childIds.length > 0;
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (!c || !isIntact(c)) { ok = false; break; } // 悬空 child ⇒ 不完整
    }
    intactMemo.set(n.id, ok);
    return ok;
  };
  // 可作为整体代表:完好 + 全部后代叶子都合格。
  const canRepresent = (n: ViewNode): boolean => {
    if (!isIntact(n)) return false;
    const ls: ViewNode[] = [];
    collectLeaves(n, ls);
    return ls.length > 0 && ls.every(leafEligible);
  };

  const chosen: ViewNode[] = [];
  const visited = new Set<string>(); // 防环/防重:正常森林是树,但病态环输入下避免爆栈
  const visit = (n: ViewNode): void => {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    if (n.kind === 'leaf' || n.atomic) {
      if (leafEligible(n)) chosen.push(n);
      return;
    }
    if (canRepresent(n)) {
      chosen.push(n);
      return;
    }
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) visit(c);
    }
  };
  for (const r of roots) visit(r);

  // 时间序拼接:叶子用楼层序;压缩节点用其最早后代叶子的楼层序
  const sortKey = (n: ViewNode): number => {
    if (n.kind === 'leaf') return n.msgIndex;
    if (n.atomic) return n.floorStart ?? n.msgIndex;
    const ls: ViewNode[] = [];
    collectLeaves(n, ls);
    return ls.length
      ? Math.min(...ls.map(l => l.atomic ? (l.floorStart ?? l.msgIndex) : l.msgIndex))
      : Number.MAX_SAFE_INTEGER;
  };
  return chosen.sort((a, b) => sortKey(a) - sortKey(b));
}

/* ============ 生活小档案:三投放层选择(纯函数,注入与测试共用) ============ */

/**
 * 选出本回合要注入的生活细节 —— 「记住 ≠ 每回合必提」的核心闸门:
 *  - pinned:手动置顶,常驻(≤5 条);
 *  - active:时效层,未过期且与近期上下文相关才注入;无关键词的长期 active 兜底注入;
 *  - archive:沉降层,仅 anchors/topics 命中近期上下文才浮出。
 * 总量封顶(置顶 5 + 触发补齐到 6),防一次性堆太多导致主模型逐条提及。
 * 只在注入选择层做裁剪,绝不删改真源叶子。
 */
export function selectLifeDetailsForInjection(
  details: import('./types').MemLifeDetail[],
  contextText: string,
  nowTime: string,
  compareDays?: (fromDate: string, toDate: string) => number | null,
): import('./types').MemLifeDetail[] {
  const PIN_CAP = 5;
  const TOTAL_CAP = 6;
  const pinned = details.filter(d => d.tier === 'pinned').slice(0, PIN_CAP);
  const picked: MemLifeDetailImport[] = [];
  for (const d of details) {
    if (d.tier === 'pinned') continue;
    if (pinned.length + picked.length >= TOTAL_CAP) break;
    // 时效过期(两端日期都可解析且 now 已超过 until)→ 不注入;数据保留,可手动沉降/删除
    if (d.tier === 'active' && d.until && nowTime && compareDays) {
      const gap = compareDays(d.until, nowTime);
      if (gap !== null && gap > 0) continue;
    }
    const keys = [...d.anchors, ...d.topics].map(s => s.trim()).filter(Boolean);
    const hit = keys.length ? keys.some(k => contextText.includes(k)) : d.tier === 'active';
    if (hit) picked.push(d);
  }
  return [...pinned, ...picked];
}

type MemLifeDetailImport = import('./types').MemLifeDetail;
