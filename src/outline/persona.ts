/**
 * 规划讨论当前生效的对话角色:内置的 Qiheng,或用户自定义的角色(设置在 outlineSettings.discussionPersona)。
 * 选了自定义、且名字和人设提示词都填了才用自定义;没填全时仍用 Qiheng,免得讨论突然没有人设。
 */
import { outlineSettings } from './settings';
import { QIHENG_GREETING, QIHENG_NAME } from './qiheng';

export interface ActivePersona {
  /** true = 自定义角色 */
  custom: boolean;
  name: string;
  /** 自定义的人设提示词;Qiheng 为空串(人设在 DISCUSSION_PROMPT 里) */
  prompt: string;
  /** 自定义头像的服务器路径;空串 = 显示名字的第一个字。Qiheng 用内嵌头像,这里为空串 */
  avatar: string;
  /** 空对话时显示的开场白;自定义角色没有 */
  greeting: readonly string[];
}

export function activeDiscussionPersona(): ActivePersona {
  const p = outlineSettings.discussionPersona;
  const name = p?.name?.trim() ?? '', prompt = p?.prompt?.trim() ?? '';
  if (p?.mode === 'custom' && name && prompt) return { custom: true, name, prompt, avatar: p.avatar?.trim() ?? '', greeting: [] };
  return { custom: false, name: QIHENG_NAME, prompt: '', avatar: '', greeting: QIHENG_GREETING };
}

/** 没有头像时显示的字:名字的第一个字(英文取首字母大写)。 */
export function personaInitial(name: string): string {
  const first = [...name.trim()][0] ?? '?';
  return first.toUpperCase();
}
