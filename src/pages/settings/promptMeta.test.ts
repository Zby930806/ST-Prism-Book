import { afterEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import { RESUMMARY_PROMPT_COMPACT, SUMMARY_PROMPT, SUMMARY_PROMPT_COMPACT } from '@/memory/prompts';
import { TIME_TAG_PROMPT, TIME_TAG_PROMPT_COMPACT } from '@/memory/timeTag';
import { OUTLINE_GUIDANCE_TEMPLATE } from '@/outline/injection';
import { OUTLINE_GUIDE, OUTLINE_PROGRESS_GUIDE, OUTLINE_PROGRESS_PROMPT, OUTLINE_PROMPT } from '@/outline/prompt';
import { builtinLike, isCustom, PROMPT_METAS, promptSync, taskContextModeAfterSave } from './promptMeta';

describe('保存任务说明后的模式', () => {
  it('原来禁用的保持禁用：查看后点「完成」不会悄悄重新启用', () => {
    expect(taskContextModeAfterSave('disabled', true)).toBe('disabled');
    expect(taskContextModeAfterSave('disabled', false)).toBe('disabled');
  });
  it('原来是内置或自定义的按内容切换', () => {
    expect(taskContextModeAfterSave('default', false)).toBe('custom');
    expect(taskContextModeAfterSave('custom', true)).toBe('default');
    expect(taskContextModeAfterSave('custom', false)).toBe('custom');
  });
});

describe('内置提示词版本与自定义提示词的同步状态', () => {
  const saved = { style: apiSettings.promptStyle, prompts: { ...apiSettings.prompts }, bases: { ...apiSettings.promptBases } };
  afterEach(() => {
    apiSettings.promptStyle = saved.style;
    Object.assign(apiSettings.prompts, saved.prompts);
    apiSettings.promptBases = { ...saved.bases };
  });
  const meta = (key: string) => PROMPT_METAS.find(m => m.key === key)!;

  it('列表里的内置文本随版本切换;任务说明只有一版', () => {
    apiSettings.promptStyle = 'classic';
    expect(meta('summary').builtin).toBe(SUMMARY_PROMPT);
    expect(meta('timeTag').builtin).toBe(TIME_TAG_PROMPT);
    apiSettings.promptStyle = 'compact';
    expect(meta('summary').builtin).toBe(SUMMARY_PROMPT_COMPACT);
    expect(meta('resummary').builtin).toBe(RESUMMARY_PROMPT_COMPACT);
    expect(meta('timeTag').builtin).toBe(TIME_TAG_PROMPT_COMPACT);
    expect(meta('summary').builtins).toEqual([SUMMARY_PROMPT, SUMMARY_PROMPT_COMPACT]);
    expect(meta('jailbreak').builtins).toHaveLength(1);
  });

  it('照旧版改的自定义:旧版没变就不算「内置已更新」,换了版本也一样', () => {
    apiSettings.prompts.summary = SUMMARY_PROMPT + '\n我加的一行';
    apiSettings.promptBases.summary = SUMMARY_PROMPT;
    for (const style of ['classic', 'compact'] as const) {
      apiSettings.promptStyle = style;
      expect(promptSync(meta('summary'))).toBe('synced');
    }
    // 依据的那一版内置后来改过:两版都对不上才提醒
    apiSettings.promptBases.summary = SUMMARY_PROMPT.replace('【任务】', '【旧任务】');
    expect(promptSync(meta('summary'))).toBe('outdated');
    delete apiSettings.promptBases.summary;
    expect(promptSync(meta('summary'))).toBe('unknown');
    apiSettings.prompts.summary = '';
    expect(promptSync(meta('summary'))).toBe('default');
  });

  it('看差异时与同一写法的内置比较', () => {
    apiSettings.promptStyle = 'compact';
    expect(builtinLike(meta('summary'), SUMMARY_PROMPT + '\n改动')).toBe(SUMMARY_PROMPT);
    expect(builtinLike(meta('summary'), SUMMARY_PROMPT_COMPACT + '\n改动')).toBe(SUMMARY_PROMPT_COMPACT);
    expect(builtinLike(meta('resummary2'), RESUMMARY_PROMPT_COMPACT)).toBe(meta('resummary2').builtins[1]);
    expect(builtinLike(meta('timeTag'), TIME_TAG_PROMPT + '补充')).toBe(TIME_TAG_PROMPT);
    expect(builtinLike(meta('timeTag'), TIME_TAG_PROMPT_COMPACT + '补充')).toBe(TIME_TAG_PROMPT_COMPACT);
    expect(builtinLike(meta('jailbreak'), '任意')).toBe(meta('jailbreak').builtin);
  });
});

describe('创作规划的三项提示词', () => {
  const saved = { style: apiSettings.promptStyle, prompts: { ...apiSettings.prompts }, bases: { ...apiSettings.promptBases } };
  afterEach(() => {
    apiSettings.promptStyle = saved.style;
    Object.assign(apiSettings.prompts, saved.prompts);
    apiSettings.promptBases = { ...saved.bases };
  });
  const meta = (key: string) => PROMPT_METAS.find(m => m.key === key)!;

  it('列表里有规划生成、注入指引、推进条件检查三项:可以改的只是要求,固定部分另外只读展示', () => {
    expect(PROMPT_METAS.map(m => m.key)).toEqual(['summary', 'resummary', 'resummary2', 'jailbreak', 'timeTag', 'outline', 'outlineGuidance', 'outlineProgress']);
    const outline = meta('outline'), guidance = meta('outlineGuidance'), progress = meta('outlineProgress');
    expect(outline.builtin).toBe(OUTLINE_GUIDE);
    expect(`${outline.builtin}\n${outline.fixed!.text}`).toBe(OUTLINE_PROMPT);
    expect(progress.builtin).toBe(OUTLINE_PROGRESS_GUIDE);
    expect(`${progress.builtin}\n${progress.fixed!.text}`).toBe(OUTLINE_PROGRESS_PROMPT);
    expect(guidance.builtin).toBe(OUTLINE_GUIDANCE_TEMPLATE);
    expect(guidance.macros.map(m => m.token)).toEqual(['{{pace_rule}}']);
    expect(guidance.fixed!.text).toContain('（此处是上面编辑的写作要求）');
    expect(guidance.fixed!.text).toContain('[创作规划结束]');
    expect(outline.macros).toEqual([]); expect(progress.macros).toEqual([]);
    // 其余提示词没有固定部分
    for (const key of ['summary', 'resummary', 'resummary2', 'jailbreak', 'timeTag']) expect(meta(key).fixed).toBeUndefined();
    // 每一项的内置文本都只有一版,不随「内置提示词版本」变化
    for (const style of ['classic', 'compact'] as const) {
      apiSettings.promptStyle = style;
      expect(meta('outline').builtins).toEqual([OUTLINE_GUIDE]);
    }
  });

  it('是否自定义、与内置的同步状态和其他提示词一样判断', () => {
    for (const key of ['outline', 'outlineGuidance', 'outlineProgress'] as const) {
      expect(isCustom(key)).toBe(false);
      expect(promptSync(meta(key))).toBe('default');
    }
    apiSettings.prompts.outline = OUTLINE_GUIDE + '\n- 多写日常。';
    apiSettings.promptBases.outline = OUTLINE_GUIDE;
    expect(isCustom('outline')).toBe(true);
    expect(promptSync(meta('outline'))).toBe('synced');
    expect(builtinLike(meta('outline'), apiSettings.prompts.outline)).toBe(OUTLINE_GUIDE);
    apiSettings.promptBases.outline = '更早的内置文本';
    expect(promptSync(meta('outline'))).toBe('outdated');
    delete apiSettings.promptBases.outline;
    expect(promptSync(meta('outline'))).toBe('unknown');
    apiSettings.prompts.outline = '   ';
    expect(isCustom('outline')).toBe(false);
  });
});
