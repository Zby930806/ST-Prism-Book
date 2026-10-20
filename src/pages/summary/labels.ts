/**
 * 摘要条目的标签与时间文字：列表卡片（SummaryNode、平铺列表）、编辑弹窗、多选操作条共用。
 */
import { derivedMeta } from '@/memory/store';
import { relativeTimeLabel, weekdayLabel } from '@/memory/timeRel';
import { compactTimeLabel, formatRange, splitTimeLabel } from '@/memory/timeTag';
import type { SummaryRow } from './ctx';

/** 层级标签：摘要 / 总结Ln / 旧总结 */
export function levelLabel(level: number, imported = false): string {
  if (imported) return '旧总结';
  if (level === 0) return '摘要';
  return `总结L${level}`;
}

/** 楼层范围标签：单楼 #5，跨楼 #0 - #10 */
export function floorLabel(r: SummaryRow): string {
  if (r.floorLo < 0) return '—';
  return r.floorLo === r.floorHi ? `#${r.floorLo}` : `#${r.floorLo} - #${r.floorHi}`;
}

/** 行的展示时间：新数据用 timeStart/timeEnd 合成并压缩；旧数据回退到已固化的 timeLabel（也压缩一次） */
export function rowTime(r: SummaryRow): string {
  if (r.timeStart || r.timeEnd) return formatRange(r.timeStart, r.timeEnd);
  return r.timeLabel ? compactTimeLabel(r.timeLabel) : '';
}

/** 行的相对时间前缀（如「昨天·周三」）：仅叶子（单楼摘要）显示；总结跨多楼、相对时间无意义，返回空串 */
export function rowRelative(r: SummaryRow): string {
  if (r.kind !== 'leaf') return '';
  const event = r.timeEnd || r.timeStart || (r.timeLabel ? splitTimeLabel(r.timeLabel).end : '') || '';
  // 周几并入相对前缀（标准公历带年份才有）；与注入端口径一致
  return [relativeTimeLabel(event, derivedMeta.latestStoryTime), weekdayLabel(event)].filter(Boolean).join('·');
}
