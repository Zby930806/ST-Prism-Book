import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('界面偏好与设置同步', () => {
  it('导入设置备份整体替换界面偏好后，主题、按钮、悬浮球立即改用新值；再改其中一项时其他项不会被改回', async () => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('@/api/settings');
    const stored = clone(settings.apiSettings) as unknown as Record<string, any>;
    stored.wiPatternsSeeded = true;
    stored.memoryBudgetMigrated = true;
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    const { ui } = await import('./ui');
    settings.hydrateSettings();
    await nextTick();
    expect(ui).toMatchObject({ theme: 'day', showOrb: false, showTopBar: false });

    const incoming = clone(settings.apiSettings);
    incoming.ui = { ...incoming.ui, theme: 'night', showOrb: true, showTopBar: true, orbSize: 60, navPosition: 'bottom' };
    settings.replaceApiSettings(incoming);
    await nextTick();
    expect(ui).toMatchObject({ theme: 'night', showOrb: true, showTopBar: true, orbSize: 60, navPosition: 'bottom' });

    // 之后改任意一项界面设置：只改这一项，导入的其他值保留
    ui.navTapClose = false;
    await nextTick();
    expect(settings.apiSettings.ui).toMatchObject({ theme: 'night', showOrb: true, showTopBar: true, orbSize: 60, navPosition: 'bottom', navTapClose: false });
  });

  it('导入的主题名认不出来时回退日间', async () => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('@/api/settings');
    const stored = clone(settings.apiSettings) as unknown as Record<string, any>;
    stored.wiPatternsSeeded = true;
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    const { ui } = await import('./ui');
    settings.hydrateSettings();
    const incoming = clone(settings.apiSettings);
    incoming.ui = { ...incoming.ui, theme: 'neon', orbShape: 'star' };
    settings.replaceApiSettings(incoming);
    await nextTick();
    expect(ui).toMatchObject({ theme: 'day', orbShape: 'bookmark' });
  });
});
