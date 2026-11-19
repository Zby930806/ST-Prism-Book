import { apiSettings, type ApiSettings } from '@/api/settings';
import {
  builtinPrompt,
  JAILBREAK_PROMPT,
  RESUMMARY2_MACROS,
  RESUMMARY_MACROS,
  SUMMARY_MACROS,
  type PromptMacro,
} from '@/memory/prompts';
import { builtinTimeTagPrompt, TIME_TAG_PROMPT, TIME_TAG_PROMPT_COMPACT } from '@/memory/timeTag';

/* —— 自定义提示词:列表(摘要/总结/破限/时间标签),点开在弹窗里编辑大文本 —— */
export type PromptKey = 'summary' | 'resummary' | 'resummary2' | 'jailbreak' | 'timeTag';
export interface PromptMeta {
  key: PromptKey;
  label: string;
  hint: string;
  /** 当前选用版本的内置文本(摘要、总结、二次总结、时间标签随「内置提示词版本」变化) */
  readonly builtin: string;
  /** 各版本的内置文本:自定义内容照其中任何一版改写、而那一版没变,都不算「内置已更新」 */
  readonly builtins: string[];
  macros: PromptMacro[];
}
export const PROMPT_METAS: PromptMeta[] = [
  {
    key: 'summary',
    label: '摘要提示词',
    hint: '将一楼的对话整理为记忆：摘要正文，以及时间、地点、物品、计划等变化。摘要字数在「摘要设置」中调整。',
    get builtin() { return builtinPrompt('summary'); },
    get builtins() { return [builtinPrompt('summary', 'classic'), builtinPrompt('summary', 'compact')]; },
    macros: SUMMARY_MACROS,
  },
  {
    key: 'resummary',
    label: '总结提示词',
    hint: '将多条楼层摘要合并为一条 L1 总结，字数取「摘要设置」中的「总结字数」；为 0 时由「字数档位」决定，「摘要字数」高于档位默认值时按比例放大，最多 3 倍。精简版在「总结字数」为 0 时把上限放宽到输入的一半（精简档四成）。',
    get builtin() { return builtinPrompt('resummary'); },
    get builtins() { return [builtinPrompt('resummary', 'classic'), builtinPrompt('resummary', 'compact')]; },
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'resummary2',
    label: '二次总结提示词',
    hint: '将多条总结向上合并一层（L1 及以上 → 更高一层）。旧版的字数按输入长度计算：详细约 40%–50%，精简约 30%–40%，不超过「摘要设置」中的「二次总结字数」。精简版写成按日期排列的大事记，输出 timeline 数组（一个场合一项），由插件接成一段文字保存。',
    get builtin() { return builtinPrompt('resummary2'); },
    get builtins() { return [builtinPrompt('resummary2', 'classic'), builtinPrompt('resummary2', 'compact')]; },
    macros: RESUMMARY2_MACROS,
  },
  {
    key: 'jailbreak',
    label: '任务说明（旧称破限）' ,
    hint: '位于最前面的 system 消息，说明这是整理资料的任务及资料的边界。可选默认、自定义、禁用；自定义留空时不发送。',
    builtin: JAILBREAK_PROMPT,
    builtins: [JAILBREAK_PROMPT],
    macros: [],
  },
  {
    key: 'timeTag',
    label: '时间标签提示词',
    hint: '发送给正文模型，要求每条回复前后写入时间标签，作为剧情时间的锚点，摘要和后续剧情据此对齐。开启「启用自动摘要」后生效；留空时使用内置默认。',
    get builtin() { return builtinTimeTagPrompt(); },
    get builtins() { return [TIME_TAG_PROMPT, TIME_TAG_PROMPT_COMPACT]; },
    macros: [],
  },
];

// 该任务是否已自定义(非空即视为已覆盖内置)
export function isCustom(key: PromptKey): boolean {
  return key === 'jailbreak' ? apiSettings.taskContextMode === 'custom' : apiSettings.prompts[key].trim().length > 0;
}

/**
 * 与某段文本(自定义内容,或它依据的那版内置)同一写法的内置文本。
 * 看差异时拿它比较:照旧版改的自定义不去和精简版逐行对比,免得把整篇改写当成内置的改动列出来。
 */
export function builtinLike(meta: PromptMeta, text: string): string {
  if (meta.builtins.length < 2) return meta.builtin;
  const compact = meta.key === 'timeTag'
    ? text.includes('【故事时间标签】')
    : text.includes('═══ summary 怎么写 ═══') || text.includes('═══ 取舍 ═══');
  // builtins 的顺序固定为 [旧版, 精简版]
  return meta.builtins[compact ? 1 : 0];
}

/**
 * 保存任务说明后的模式:原来是「禁用」的保持禁用,只保存内容(查看后点「完成」不会悄悄重新启用);
 * 原来是内置或自定义的按内容切换——与内置相同为内置,否则为自定义。
 */
export function taskContextModeAfterSave(current: ApiSettings['taskContextMode'], sameAsBuiltin: boolean): ApiSettings['taskContextMode'] {
  if (current === 'disabled') return 'disabled';
  return sameAsBuiltin ? 'default' : 'custom';
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
  return meta.builtins.some(text => text.trim() === base.trim()) ? 'synced' : 'outdated';
}
