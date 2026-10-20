/**
 * 摘要页「楼层光谱」与「未摘要楼层」分段的计算。纯函数，不读宿主和响应式状态，便于测试。
 *
 * 光谱：每层 AI 回复一格，按它在记忆中保留的细节分档——发原文（保留窗口内）、逐楼摘要、
 * 已并入总结、已并入二次及以上总结；另有待补摘与番外。相邻同档的楼层合成一段。
 */
export type FloorState = 'raw' | 'leaf' | 'l1' | 'l2' | 'pending' | 'omit';

/** 图例与说明的顺序：从细节最多到最少，再到缺口和番外。 */
export const FLOOR_STATES: FloorState[] = ['raw', 'leaf', 'l1', 'l2', 'pending', 'omit'];

export const FLOOR_STATE_LABEL: Record<FloorState, string> = {
  raw: '原文', leaf: '逐楼摘要', l1: '总结', l2: '二次总结', pending: '待补摘', omit: '番外',
};

export interface SpectrumSummary {
  id: string;
  level: number;
  childIds?: string[];
  imported?: boolean;
  importedFloorStart?: number;
  importedFloorEnd?: number;
}

export interface SpectrumInput {
  /** 真实 AI 回复的楼层号（含番外），升序 */
  floors: number[];
  omit: ReadonlySet<number>;
  pending: ReadonlySet<number>;
  /** 保留窗口起点：楼层号不小于它的 AI 回复发原文 */
  keepStart: number;
  /** 楼层 → 有效逐楼摘要的 id */
  leafOf: ReadonlyMap<number, string>;
  summaries: readonly SpectrumSummary[];
}

export interface SpectrumRun {
  state: FloorState;
  /** 在光谱中的起始格（第几层 AI 回复，从 0 起） */
  start: number;
  count: number;
  firstFloor: number;
  lastFloor: number;
}

export interface Spectrum {
  runs: SpectrumRun[];
  counts: Record<FloorState, number>;
  total: number;
}

/** 节点向上合并到的最高层级：没有被收纳的逐楼摘要为 0。 */
function levelResolver(summaries: readonly SpectrumSummary[]) {
  const parentOf = new Map<string, string>();
  const levelOf = new Map<string, number>();
  for (const s of summaries) {
    levelOf.set(s.id, s.level);
    for (const child of s.childIds ?? []) parentOf.set(child, s.id);
  }
  return (id: string): number => {
    let level = levelOf.get(id) ?? 0;
    const seen = new Set<string>([id]);
    for (let parent = parentOf.get(id); parent && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      level = Math.max(level, levelOf.get(parent) ?? 0);
    }
    return level;
  };
}

export function floorSpectrum(input: SpectrumInput): Spectrum {
  const rootLevel = levelResolver(input.summaries);
  const imported = input.summaries
    .filter(s => s.imported && Number.isFinite(s.importedFloorEnd))
    .map(s => {
      const start = Math.max(0, Math.floor(s.importedFloorStart ?? 0));
      return { start, end: Math.max(start, Math.floor(s.importedFloorEnd!)), level: Math.max(1, rootLevel(s.id)) };
    });
  const counts = Object.fromEntries(FLOOR_STATES.map(s => [s, 0])) as Record<FloorState, number>;
  const runs: SpectrumRun[] = [];
  input.floors.forEach((floor, index) => {
    let state: FloorState;
    if (input.omit.has(floor)) state = 'omit';
    else if (input.pending.has(floor)) state = 'pending';
    else if (floor >= input.keepStart) state = 'raw';
    else {
      const leaf = input.leafOf.get(floor);
      const level = leaf !== undefined ? rootLevel(leaf)
        : imported.find(range => floor >= range.start && floor <= range.end)?.level ?? 0;
      state = level >= 2 ? 'l2' : level === 1 ? 'l1' : 'leaf';
    }
    counts[state]++;
    const last = runs[runs.length - 1];
    if (last && last.state === state) { last.count++; last.lastFloor = floor; }
    else runs.push({ state, start: index, count: 1, firstFloor: floor, lastFloor: floor });
  });
  return { runs, counts, total: input.floors.length };
}

export interface PendingRange {
  first: number;
  last: number;
  /** 这一段里待补摘的楼层，升序 */
  floors: number[];
}

/**
 * 把待补摘楼层按「中间没有别的 AI 楼」合成连续的段。aiFloors 为参与记忆的 AI 楼层（不含番外），升序；
 * 番外楼不需要摘要，夹在两层待补摘之间时不打断这一段。
 */
export function pendingRanges(pending: readonly number[], aiFloors: readonly number[]): PendingRange[] {
  const ordinal = new Map(aiFloors.map((floor, index) => [floor, index]));
  const ranges: PendingRange[] = [];
  let prevOrdinal = -2;
  for (const floor of [...pending].sort((a, b) => a - b)) {
    const at = ordinal.get(floor) ?? -10;
    const last = ranges[ranges.length - 1];
    if (last && at >= 0 && at === prevOrdinal + 1) { last.last = floor; last.floors.push(floor); }
    else ranges.push({ first: floor, last: floor, floors: [floor] });
    prevOrdinal = at;
  }
  return ranges;
}
