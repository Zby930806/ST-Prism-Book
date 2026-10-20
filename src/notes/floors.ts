import type { STContext } from '@/st/context';
import { notesState, recordSourceIsCurrent } from './store';
import { latestStoryFloor } from './source';
import type { NoteRecord } from './types';

/**
 * 聊天里的札记卡片挂在哪些楼层:最新一条正文楼层(生成札记针对的那一层),以及有札记、
 * 且札记对应的正文没变的楼层。只看给出的候选楼层(已渲染在页面上的),免得对整段聊天逐条核对。
 * 正文改过或楼层被删导致失效的札记不在聊天里显示,仍可在「札记」页查看。
 */
export function notesCardFloors(ctx: STContext, candidates: Iterable<number>): Set<number> {
  const wanted = new Set(candidates);
  const out = new Set<number>();
  const latest = latestStoryFloor(ctx);
  if (latest >= 0 && wanted.has(latest)) out.add(latest);
  for (const record of notesState.records) {
    if (!wanted.has(record.floor) || out.has(record.floor)) continue;
    if (recordSourceIsCurrent(record)) out.add(record.floor);
  }
  return out;
}

/** 某楼当前页最新的一份有效札记;没有返回 null。 */
export function floorNote(floor: number): NoteRecord | null {
  let best: NoteRecord | null = null;
  for (const record of notesState.records) {
    if (record.floor !== floor || !recordSourceIsCurrent(record)) continue;
    if (!best || record.createdAt >= best.createdAt) best = record;
  }
  return best;
}
