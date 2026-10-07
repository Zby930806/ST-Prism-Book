import type { MemNpc } from './types';

type Placement = Pick<MemNpc, 'follow' | 'location' | 'locationStale' | 'lastKnownLocation'>;
/** 面板、主注入和摘要名册共用标签,旧位置不能冒充当前位置。 */
export function npcLocationLabel(n: Placement): string {
  if (n.follow) return '随主角同行';
  if (n.location && !n.locationStale) return '在:' + n.location;
  const last = n.lastKnownLocation;
  const place = last?.place || n.location;
  return place ? '当前位置未确认;最后确认:' + place + (last?.time ? '（' + last.time + '）' : '') : '当前位置未确认';
}
