import { apiSettings } from '@/api/settings';
import {
  JAILBREAK_PROMPT,
  RESUMMARY2_MACROS,
  RESUMMARY2_PROMPT,
  RESUMMARY_MACROS,
  RESUMMARY_PROMPT,
  SUMMARY_MACROS,
  SUMMARY_PROMPT,
  type PromptMacro,
} from '@/memory/prompts';
import { TIME_TAG_PROMPT } from '@/memory/timeTag';

/* —— 自定义提示词:列表(摘要/总结/破限/时间标签),点开在弹窗里编辑大文本 —— */
export type PromptKey = 'summary' | 'resummary' | 'resummary2' | 'jailbreak' | 'timeTag';
export interface PromptMeta {
  key: PromptKey;
  label: string;
  hint: string;
  builtin: string;
  macros: PromptMacro[];
}
export const PROMPT_METAS: PromptMeta[] = [
  {
    key: 'summary',
    label: '摘要提示词',
    hint: '将一楼的对话整理为记忆：摘要正文，以及时间、地点、物品、计划等变化。摘要字数在「摘要设置」中调整。',
    builtin: SUMMARY_PROMPT,
    macros: SUMMARY_MACROS,
  },
  {
    key: 'resummary',
    label: '总结提示词',
    hint: '将多条楼层摘要合并为一条 L1 总结，字数由「字数档位」决定。',
    builtin: RESUMMARY_PROMPT,
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'resummary2',
    label: '二次总结提示词',
    hint: '将多条总结向上合并一层（L1 及以上 → 更高一层）。字数按输入长度计算：详细约 40%–50%，精简约 30%–40%。',
    builtin: RESUMMARY2_PROMPT,
    macros: RESUMMARY2_MACROS,
  },
  {
    key: 'jailbreak',
    label: '任务说明（旧称破限）' ,
    hint: '位于最前面的 system 消息，说明这是整理资料的任务及资料的边界。可选默认、自定义、禁用；自定义留空时不发送。',
    builtin: JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'timeTag',
    label: '时间标签提示词',
    hint: '发送给正文模型，要求每条回复前后写入时间标签，作为剧情时间的锚点，摘要和后续剧情据此对齐。开启「启用自动摘要」后生效；留空时使用内置默认。',
    builtin: TIME_TAG_PROMPT,
    macros: [],
  },
];

// 该任务是否已自定义(非空即视为已覆盖内置)
export function isCustom(key: PromptKey): boolean {
  return key === 'jailbreak' ? apiSettings.taskContextMode === 'custom' : apiSettings.prompts[key].trim().length > 0;
}

/**
 * 自定义和内置的关系:default=没自定义;synced=照着现在的内置改的;
 * outdated=改完之后内置又更新了;unknown=旧版本里改的,没记录照着哪一版。
 */
export type PromptSync = 'default' | 'synced' | 'outdated' | 'unknown';
export function promptSync(meta: PromptMeta): PromptSync {
  if (!isCustom(meta.key)) return 'default';
  const base = apiSettings.promptBases[meta.key];
  if (!base) return 'unknown';
  return base.trim() === meta.builtin.trim() ? 'synced' : 'outdated';
}
