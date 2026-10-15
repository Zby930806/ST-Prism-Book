import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 副 API 渠道的流式传输和发送预填充默认都关；已经保存过的选择照旧。
describe('副 API 渠道的默认值', () => {
  it('新建渠道两项都关', async () => {
    vi.resetModules();
    const { newChannel } = await import('./settings');
    expect(newChannel()).toMatchObject({ stream: false, prefill: false });
  });

  it('旧存档里没写这两项的按关处理，写了的保持原样', async () => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('./settings');
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    stored.wiPatternsSeeded = true;
    stored.channels = [
      { id: 'old', name: '旧渠道', url: 'https://example.test/v1', key: '', model: 'm' },
      { id: 'kept', name: '开着的', url: 'https://example.test/v1', key: '', model: 'm', stream: true, prefill: true },
    ];
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    settings.hydrateSettings();
    expect(settings.apiSettings.channels.map(c => [c.id, c.stream, c.prefill])).toEqual([['old', false, false], ['kept', true, true]]);
  });
});
