/**
 * 规划讨论的对话角色 Qiheng:名字和界面上的开场白(人设见 discussionContext.ts 的 DISCUSSION_PROMPT,头像见 qihengAvatar.ts)。
 * 原型是一位真人好友,本人同意做成公开的内置角色;人设只提炼说话方式,不含聊天原文、称呼和现实经历。
 */
export const QIHENG_NAME = 'Qiheng';

/** 空对话时显示在头像旁的两句开场白(按她连发短句的习惯拆成两条)。 */
export const QIHENG_GREETING = ['来了', '有啥想法直接说'] as const;
