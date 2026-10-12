import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSummaryMaxChars } from './settings';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('每楼摘要字数设置', () => {
  it.each([
    [undefined, 'detailed', 300],
    [undefined, 'concise', 150],
    ['300', 'detailed', 300],
    [Number.NaN, 'concise', 150],
    [420, 'concise', 420],
    [420.6, 'detailed', 421],
    [10, 'detailed', 50],
    [99999, 'detailed', 2000],
  ] as const)('规整 %s（%s）→ %i', (value, verbosity, expected) => {
    expect(normalizeSummaryMaxChars(value, verbosity)).toBe(expected);
  });

  // 经设置 hydrate 读取旧存档，再看摘要提示词实际用到的字数，不只测 helper。
  it.each([
    ['旧设置·详细', { verbosity: 'detailed' }, 300],
    ['旧设置·精简', { verbosity: 'concise' }, 150],
    ['已改过的数值', { verbosity: 'concise', summaryMaxChars: 480 }, 480],
    ['存了非法值', { verbosity: 'detailed', summaryMaxChars: 'abc' }, 300],
  ] as const)('升级时读取旧设置：%s', async (_name, patch, expected) => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('./settings');
    const prompts = await import('@/memory/prompts');
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    delete stored.summaryMaxChars;
    Object.assign(stored, patch, { wiPatternsSeeded: true });
    const extensionSettings = { baibai_book: stored };
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    settings.hydrateSettings();
    expect(settings.apiSettings.summaryMaxChars).toBe(expected);
    expect(prompts.summaryMaxChars()).toBe(expected);
    const args: Parameters<typeof prompts.buildSummaryPrompt>[0] = {
      user: '主角', char: '角色', time: '', location: '', protagonist: {}, sceneFocus: null, lifeDetails: [], items: [], itemLog: [],
      scenes: [], npcs: [], openPlans: [], resolvedPlans: [], history: '', content: '正文。', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
    };
    expect(prompts.buildSummaryPrompt(args).system).toContain(`summary 不超过 ${expected} 字（含标点）`);
  });
});
