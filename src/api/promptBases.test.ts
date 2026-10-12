import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 经设置 hydrate 读取存档：只留已知提示词的非空基准，旧存档没有这一项就是空对象（未记录）。
describe('自定义提示词的基准版本', () => {
  it.each([
    ['旧存档没有这一项', undefined, {}],
    ['只留已知键的非空字符串', { summary: '旧内置摘要', bogus: '不认识的键', resummary: 5, timeTag: '  ' }, { summary: '旧内置摘要' }],
  ] as const)('%s', async (_name, bases, expected) => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('./settings');
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    delete stored.promptBases;
    if (bases) stored.promptBases = bases;
    stored.wiPatternsSeeded = true;
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    settings.hydrateSettings();
    expect(settings.apiSettings.promptBases).toEqual(expected);
  });
});
