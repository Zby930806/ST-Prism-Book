import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 经设置 hydrate 读取存档，再看注入时各部分实际拿到的预算。patch 为 null 表示新装（没有存档）。
async function hydrateWith(patch: Record<string, unknown> | null) {
  vi.resetModules();
  const context = await import('@/st/context');
  const settings = await import('./settings');
  const budget = await import('@/memory/budget');
  const extensionSettings: Record<string, unknown> = {};
  if (patch) {
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    delete stored.memoryBudgetMigrated;
    Object.assign(stored, { wiPatternsSeeded: true }, patch);
    extensionSettings.baibai_book = stored;
  }
  const save = vi.fn();
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat: [], chatMetadata: {}, extensionSettings, saveSettingsDebounced: save,
  } as unknown as import('@/st/context').STContext);
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  settings.hydrateSettings();
  return { settings, budget, stored: extensionSettings.baibai_book as Record<string, unknown>, save };
}

describe('记忆注入预算默认不限制', () => {
  it('新装：默认 0，历史、召回等各部分都不限制', async () => {
    const { settings, budget } = await hydrateWith(null);
    expect(settings.apiSettings.memoryBudgetTokens).toBe(0);
    expect(budget.slotBudget('history')).toBe(Infinity);
    expect(budget.slotBudget('recall')).toBe(Infinity);
  });

  it('旧版本按原默认值保存的 6000，升级后改为不限制并写回设置', async () => {
    const { settings, stored, save } = await hydrateWith({ memoryBudgetTokens: 6000 });
    expect(settings.apiSettings.memoryBudgetTokens).toBe(0);
    expect(stored.memoryBudgetTokens).toBe(0);
    expect(stored.memoryBudgetMigrated).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it('用户改过的数值保留', async () => {
    const { settings, budget } = await hydrateWith({ memoryBudgetTokens: 12000 });
    expect(settings.apiSettings.memoryBudgetTokens).toBe(12000);
    expect(settings.apiSettings.memoryBudgetMigrated).toBe(true);
    // 填写了预算就按它分配(各部分的份额见 memory/budget.ts),不再是不限制
    const history = budget.slotBudget('history');
    expect(Number.isFinite(history)).toBe(true);
    expect(history).toBeGreaterThan(0);
    expect(history).toBeLessThan(12000);
  });

  it('迁移只做一次：之后自己填的 6000 不再改动', async () => {
    const { settings, budget } = await hydrateWith({ memoryBudgetTokens: 6000, memoryBudgetMigrated: true });
    expect(settings.apiSettings.memoryBudgetTokens).toBe(6000);
    expect(budget.slotBudget('timeTag')).toBe(300);
  });
});
