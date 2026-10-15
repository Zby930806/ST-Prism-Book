import type { ApiChannel } from '@/api/settings';

export interface OutlineChapter {
  title: string;
  goal: string;
  approach: string;
  beats: string[];
  exitCriteria: string;
}
export interface OutlineContent {
  title: string;
  premise: string;
  constraints: string[];
  chapters: OutlineChapter[];
}
export interface OutlineDraft {
  id: string;
  createdAt: number;
  sourceFloor: number;
  sourceHash: string;
  brief: string;
  content: OutlineContent;
}
export interface OutlineActive extends OutlineDraft {
  enabled: boolean;
  /** 等于 chapters.length 表示用户结束了本大纲，不代表所有事件已发生。 */
  currentChapter: number;
}
export interface OutlineData {
  version: 1;
  draft: OutlineDraft | null;
  active: OutlineActive | null;
}
export interface OutlineSettings {
  apiMode: 'notes' | 'independent';
  channel: ApiChannel;
  /** 推进条件检查:auto=每隔 interval 个 AI 楼自动检查一次(默认关);手动检查不受此开关影响。 */
  progressCheck: { auto: boolean; interval: number };
}
