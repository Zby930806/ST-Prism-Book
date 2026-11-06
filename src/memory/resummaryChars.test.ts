import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings, normalizeResummary2MaxChars, normalizeResummaryMaxChars } from '@/api/settings';
import { buildResummaryPrompt, RESUMMARY_THINKING_CHECKLIST, resummary2MaxChars, resummaryWordsRange } from './prompts';

const saved = {
  prompts: { ...apiSettings.prompts },
  verbosity: apiSettings.verbosity,
  summaryMaxChars: apiSettings.summaryMaxChars,
  resummaryMaxChars: apiSettings.resummaryMaxChars,
  resummary2MaxChars: apiSettings.resummary2MaxChars,
};

beforeEach(() => {
  Object.assign(apiSettings.prompts, { resummary: '', resummary2: '' });
  Object.assign(apiSettings, { verbosity: 'detailed', summaryMaxChars: 300, resummaryMaxChars: 0, resummary2MaxChars: 0 });
});

afterEach(() => {
  Object.assign(apiSettings.prompts, saved.prompts);
  const { prompts: _prompts, ...rest } = saved;
  Object.assign(apiSettings, rest);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const args = { user: 'User', char: 'Character', content: 'x'.repeat(1000) };

/** 按引擎合并时的格式拼出待融合的材料:[编号] 正文,空行分隔。 */
const sources = (count: number, chars: number) =>
  Array.from({ length: count }, (_, i) => `[${i + 1}] ${'甲'.repeat(chars)}`).join('\n\n');

/** 内置总结规则里的参考范围。 */
const l1Words = (level: number, content = args.content) => {
  const m = buildResummaryPrompt({ ...args, content, level }).system.match(/(\d+)-(\d+) 字为参考范围/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
/** 内置二次总结规则里的参考目标与上限。 */
const l2Budget = (content: string, level = 2) => {
  const system = buildResummaryPrompt({ ...args, content, level }).system;
  return [Number(system.match(/(\d+) 字仅作为信息充足时的参考目标/)![1]), Number(system.match(/summary 不得超过 (\d+) 字/)![1])];
};
const reminder = (max: number) =>
  `${RESUMMARY_THINKING_CHECKLIST}\n本次 summary 不超过 ${max} 字（含标点）。信息少可以更短；写超时先删低价值细节和重复过程，不删关键事实及其限定。`;

describe('总结（L1）字数', () => {
  it.each([
    ['detailed', 300, [300, 500]], ['detailed', 600, [600, 1000]], ['detailed', 2000, [900, 1500]],
    ['concise', 150, [150, 300]], ['concise', 600, [300, 600]],
  ] as const)('填 0 时与以前相同：按字数档位，随摘要字数放大（%s，摘要字数 %i）', (verbosity, chars, words) => {
    Object.assign(apiSettings, { verbosity, summaryMaxChars: chars });
    expect(l1Words(1)).toEqual(words);
    expect(resummaryWordsRange()).toEqual({ min: words[0], max: words[1] });
  });

  it.each([
    ['detailed', 300, 800, [480, 800]], ['detailed', 2000, 800, [480, 800]], ['detailed', 300, 200, [120, 200]],
    ['concise', 300, 800, [400, 800]], ['concise', 50, 1500, [750, 1500]],
  ] as const)('填了数值就以它为上限，下限按档位比例，不随摘要字数变化（%s，摘要字数 %i，总结字数 %i）', (verbosity, chars, custom, words) => {
    Object.assign(apiSettings, { verbosity, summaryMaxChars: chars, resummaryMaxChars: custom });
    expect(l1Words(1)).toEqual(words);
    expect(buildResummaryPrompt({ ...args, level: 1 }).checklist).toBe(reminder(words[1]));
  });

  it('自定义模板的 {{resummary_words}} 按设置填入；核查清单不加字数提醒', () => {
    apiSettings.resummaryMaxChars = 1000;
    apiSettings.prompts.resummary = 'CUSTOM {{content}} {{resummary_words}}';
    const parts = buildResummaryPrompt({ ...args, level: 1 });
    expect(parts.user).toBe(`CUSTOM ${args.content} 600-1000`);
    expect(parts.checklist).toBe(RESUMMARY_THINKING_CHECKLIST);
  });
});

describe('二次总结（L2 及以上）字数上限', () => {
  it.each([
    ['detailed', [400, 500]], ['concise', [300, 400]],
  ] as const)('输入不长时与以前相同：按输入长度的比例（%s）', (verbosity, budget) => {
    apiSettings.verbosity = verbosity;
    expect(l2Budget('x'.repeat(1000))).toEqual(budget);
    expect(buildResummaryPrompt({ ...args, level: 2 }).checklist).toBe(reminder(budget[1]));
  });

  it('写超的总结合并时不再按比例放大：6 条 1200 字的总结合成的二次总结不超过 1500 字', () => {
    // 以前上限是输入的 50%：约 3600 字，再往上一层还会继续放大
    const content = sources(6, 1200);
    expect(content.length * 0.5).toBeGreaterThan(3600);
    expect(l2Budget(content)).toEqual([1200, 1500]);
    expect(buildResummaryPrompt({ ...args, content, level: 2 }).checklist).toBe(reminder(1500));
  });

  it('更高层（L3 及以上）同样不超过上限', () => {
    for (const level of [3, 4]) expect(l2Budget(sources(3, 1500), level)).toEqual([1200, 1500]);
  });

  it.each([
    ['默认设置', {}, 1500],
    ['精简档', { verbosity: 'concise' }, 900],
    ['摘要字数 600，总结跟着放大', { summaryMaxChars: 600 }, 3000],
    ['总结字数 800', { resummaryMaxChars: 800 }, 2400],
  ] as const)('填 0 时取总结字数上限的 3 倍：%s', (_name, patch, cap) => {
    Object.assign(apiSettings, patch);
    expect(resummary2MaxChars()).toBe(cap);
    expect(l2Budget(sources(6, 3000))[1]).toBe(cap);
  });

  it.each([
    ['detailed', 2000, [1600, 2000]], ['concise', 2000, [1500, 2000]], ['detailed', 6000, [4000, 5000]],
  ] as const)('填了二次总结字数就以它为上限，最低字数按同一比例缩小（%s，上限 %i）', (verbosity, cap, budget) => {
    Object.assign(apiSettings, { verbosity, resummary2MaxChars: cap });
    // 输入约 10000 字：比例算出的篇幅超过 2000，不超过 6000
    expect(l2Budget('x'.repeat(10000))).toEqual(budget);
  });

  it('自定义模板的 target 宏按上限填入；核查清单不加字数提醒', () => {
    apiSettings.prompts.resummary2 = 'CUSTOM {{target_min}} {{target_max}} {{target}}';
    const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(10000), level: 2 });
    expect(parts.user).toBe('CUSTOM 1200 1500 1500');
    expect(parts.checklist).toBe(RESUMMARY_THINKING_CHECKLIST);
  });
});

describe('总结字数设置的规整', () => {
  it.each([
    [undefined, 0], [null, 0], ['', 0], ['800', 0], [Number.NaN, 0], [-5, 0], [0, 0],
    [800, 800], [812.6, 813], [10, 100], [99999, 5000],
  ] as const)('总结字数 %s → %i', (value, expected) => {
    expect(normalizeResummaryMaxChars(value)).toBe(expected);
  });

  it.each([
    [undefined, 0], ['', 0], [-1, 0], [0, 0], [1500, 1500], [50, 200], [99999, 10000],
  ] as const)('二次总结字数 %s → %i', (value, expected) => {
    expect(normalizeResummary2MaxChars(value)).toBe(expected);
  });

  it('输入框暂时为空时，请求里仍是有效字数', () => {
    Object.assign(apiSettings, { resummaryMaxChars: '' as unknown as number, resummary2MaxChars: Number.NaN });
    expect(resummaryWordsRange()).toEqual({ min: 300, max: 500 });
    expect(resummary2MaxChars()).toBe(1500);
  });

  // 经设置 hydrate 读取旧存档，再看总结提示词实际用到的字数，不只测 helper。
  it.each([
    ['旧设置没有这两项', {}, [300, 500], 1500],
    ['已填数值', { resummaryMaxChars: 700, resummary2MaxChars: 1800 }, [420, 700], 1800],
    ['存了非法值', { resummaryMaxChars: 'abc', resummary2MaxChars: -3 }, [300, 500], 1500],
  ] as const)('升级时读取旧设置：%s', async (_name, patch, words, cap) => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('@/api/settings');
    const prompts = await import('./prompts');
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    delete stored.resummaryMaxChars;
    delete stored.resummary2MaxChars;
    Object.assign(stored, patch, { wiPatternsSeeded: true });
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    settings.hydrateSettings();
    expect(prompts.resummaryWordsRange()).toEqual({ min: words[0], max: words[1] });
    expect(prompts.resummary2MaxChars()).toBe(cap);
    expect(prompts.buildResummaryPrompt({ ...args, content: 'x'.repeat(10000), level: 2 }).system).toContain(`summary 不得超过 ${cap} 字`);
  });
});
