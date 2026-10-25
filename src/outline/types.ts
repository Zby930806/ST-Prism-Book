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
/** 已确认规划在正文里推进的快慢:slow 每轮最多一个剧情要点,normal 最多一到两个,fast 可以多个。 */
export type OutlinePace = 'slow' | 'normal' | 'fast';
/**
 * 规划讨论的对话角色:qiheng = 内置的 Qiheng;custom = 用户自定义名字、人设提示词和头像。
 * 自定义的人设提示词只替换 Qiheng 的说话方式,规划讨论的规则照常附上。
 */
export interface DiscussionPersona {
  mode: 'qiheng' | 'custom';
  /** 自定义角色的名字(1..20 字) */
  name: string;
  /** 自定义人设提示词(说话方式、性格等,0..4000 字) */
  prompt: string;
  /** 自定义头像的服务器路径;空 = 显示名字的第一个字 */
  avatar: string;
}
export interface OutlineSettings {
  apiMode: 'notes' | 'independent';
  channel: ApiChannel;
  /**
   * 推进条件检查:auto=每隔 interval 个 AI 楼自动检查一次(默认关);手动检查不受此开关影响。
   * autoAdvance=自动检查判定满足时切换到下一阶段(默认关;最后一个阶段不自动结束,手动检查只作提示)。
   */
  progressCheck: { auto: boolean; interval: number; autoAdvance: boolean };
  /** 推进节奏,默认适中 */
  pace: OutlinePace;
  /** 规划讨论的对话角色,默认 Qiheng */
  discussionPersona: DiscussionPersona;
}
