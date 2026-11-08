import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 经设置 hydrate 读取存档。patch 为 null 表示新装（没有存档）。
async function hydrateWith(patch: Record<string, unknown> | null) {
  vi.resetModules();
  const context = await import('@/st/context');
  const settings = await import('./settings');
  const extensionSettings: Record<string, unknown> = {};
  if (patch) {
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    delete stored.keepRecentMigrated;
    Object.assign(stored, { wiPatternsSeeded: true, memoryBudgetMigrated: true }, patch);
    extensionSettings.baibai_book = stored;
  }
  const save = vi.fn();
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat: [], chatMetadata: {}, extensionSettings, saveSettingsDebounced: save,
  } as unknown as import('@/st/context').STContext);
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  settings.hydrateSettings();
  return { settings, stored: extensionSettings.baibai_book as Record<string, unknown>, save };
}

describe('保留最近 AI 消息数默认 4', () => {
  it('新装：默认 4', async () => {
    const { settings } = await hydrateWith(null);
    expect(settings.apiSettings.keepRecent).toBe(4);
    expect(settings.apiSettings.keepRecentMigrated).toBe(true);
  });

  it('旧版本按原默认值保存的 3，升级后改为 4 并写回设置', async () => {
    const { settings, stored, save } = await hydrateWith({ keepRecent: 3 });
    expect(settings.apiSettings.keepRecent).toBe(4);
    expect(stored.keepRecent).toBe(4);
    expect(stored.keepRecentMigrated).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it.each([0, 2, 6])('用户改过的数值保留（%s）', async keep => {
    const { settings } = await hydrateWith({ keepRecent: keep });
    expect(settings.apiSettings.keepRecent).toBe(keep);
    expect(settings.apiSettings.keepRecentMigrated).toBe(true);
  });

  it('迁移只做一次：之后自己填的 3 不再改动', async () => {
    const { settings } = await hydrateWith({ keepRecent: 3, keepRecentMigrated: true });
    expect(settings.apiSettings.keepRecent).toBe(3);
  });
});
