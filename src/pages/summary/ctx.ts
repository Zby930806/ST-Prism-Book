/**
 * 摘要节点(SummaryNode)递归渲染所需的共享上下文。
 * 卡片渲染下沉到递归组件后,父页(index.vue)通过 provide 把状态、helper、动作一次性注入,
 * 免去逐层 props 透传。默认/搜索/选择三视图共用同一张卡片,只此一份实现。
 */
import type { ComputedRef, InjectionKey, Ref } from 'vue';
import type { ViewNode } from '@/memory/inject';

/** 一个森林节点在列表里的展示字段(toRow 的产物),供 helper 计算标签/时间用。 */
export interface SummaryRow {
  key: string;
  id: string;
  kind: 'leaf' | 'comp';
  level: number;
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string;
  floorLo: number;
  floorHi: number;
  msgIndex?: number;
  stale?: boolean;
  imported?: boolean;
}

export interface SummaryCtx {
  byId: ComputedRef<Map<string, ViewNode>>;
  expanded: Ref<Set<string>>;
  selectMode: Ref<boolean>;
  searching: ComputedRef<boolean>;
  selectedIds: Ref<Set<string>>;
  toggleExpand: (id: string) => void;
  toggleSelect: (id: string) => void;
  openEdit: (r: SummaryRow) => void;
  onDelete: (r: SummaryRow) => void;
  nodeFloors: (n: ViewNode, map: Map<string, ViewNode>) => [number, number];
  toRow: (n: ViewNode, map: Map<string, ViewNode>) => SummaryRow;
  levelLabel: (level: number, imported?: boolean) => string;
  floorLabel: (r: SummaryRow) => string;
  rowTime: (r: SummaryRow) => string;
  rowRelative: (r: SummaryRow) => string;
  highlightParts: (text: string) => Array<{ t: string; hit: boolean }>;
}

export const SUMMARY_CTX: InjectionKey<SummaryCtx> = Symbol('summaryCtx');
