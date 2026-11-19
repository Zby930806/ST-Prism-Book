import { afterEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import { RESUMMARY_PROMPT_COMPACT, SUMMARY_PROMPT, SUMMARY_PROMPT_COMPACT } from '@/memory/prompts';
import { TIME_TAG_PROMPT, TIME_TAG_PROMPT_COMPACT } from '@/memory/timeTag';
import { builtinLike, PROMPT_METAS, promptSync, taskContextModeAfterSave } from './promptMeta';

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
