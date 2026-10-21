import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as host from '@/st/context';
import { makeTavern } from './testEnv';
import { notesSettings, hydrateNotesSettings } from '@/notes/settings';
import {
  WORLDBOOK_SETTINGS_KEY, hydrateWorldbookSettings, normalizeWorldbookSettings, resolveWorldbookChannel, saveWorldbookSettings,
  updateWorldbookSettings, worldbookChannelIssue, worldbookSettings, worldbookSettingsIssue,
} from './settings';

// 全局设置：默认值、格式保护、保存回滚、API 跟随札记或单独设置。
let tavern: ReturnType<typeof makeTavern>;
beforeEach(() => {
  tavern = makeTavern();
  vi.spyOn(host, 'getContext').mockImplementation(() => tavern.ctx);
  hydrateNotesSettings();
  hydrateWorldbookSettings();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('世界书设置', () => {
  it('默认最保守：只新增、不自动建议、跟随札记的 API；新条目沿用酒馆模板的位置和顺序', () => {
    expect(worldbookSettings).toMatchObject({ apiMode: 'notes', permission: 'create', auto: { enabled: false, interval: 10 }, newEntry: { position: 0, order: 100, depth: 4 } });
    expect(worldbookSettings.read).toEqual({ maxFloors: 24, maxChars: 24000, entryChars: 6000, refChars: 4000 });
  });

  it('保存到扩展设置的新键，带版本号；数值越界时收回范围', () => {
    updateWorldbookSettings(s => { s.permission = 'supplement'; s.auto.interval = 999; s.read.maxFloors = 1; s.newEntry.position = 42; });
    const stored = tavern.ctx.extensionSettings![WORLDBOOK_SETTINGS_KEY] as Record<string, any>;
    expect(stored.version).toBe(1);
    expect(stored.permission).toBe('supplement');
    expect(stored.auto.interval).toBe(50);
    expect(stored.read.maxFloors).toBe(4);
    expect(stored.newEntry.position).toBe(0);
    hydrateWorldbookSettings();
    expect(worldbookSettings.permission).toBe('supplement');
  });

  it('认不出的格式只读保护，不覆盖原设置', () => {
    tavern.ctx.extensionSettings![WORLDBOOK_SETTINGS_KEY] = { version: 9, apiMode: 'notes', channel: {} };
    hydrateWorldbookSettings();
    expect(worldbookSettingsIssue.value).toContain('只读保护');
    expect(() => saveWorldbookSettings()).toThrow('只读保护');
    expect(() => resolveWorldbookChannel()).toThrow('只读保护');
    expect((tavern.ctx.extensionSettings![WORLDBOOK_SETTINGS_KEY] as { version: number }).version).toBe(9);
  });

  it('保存失败时回滚', () => {
    vi.mocked(tavern.ctx.saveSettingsDebounced!).mockImplementationOnce(() => { throw new Error('磁盘满'); });
    expect(() => updateWorldbookSettings(s => { s.permission = 'modify'; })).toThrow('保存失败');
    expect(worldbookSettings.permission).toBe('create');
    expect(tavern.ctx.extensionSettings![WORLDBOOK_SETTINGS_KEY]).toBeUndefined();
  });

  it('默认借用札记的渠道（不要求启用札记），也可单独设置；都没填时说明去哪里填', () => {
    expect(worldbookChannelIssue()).toContain('札记 → 独立 API 设置');
    Object.assign(notesSettings.channel, { url: 'https://notes.example.invalid/v1', model: 'notes-model' });
    expect(resolveWorldbookChannel().model).toBe('notes-model');
    worldbookSettings.apiMode = 'independent';
    expect(worldbookChannelIssue()).toContain('世界书专用 API');
    Object.assign(worldbookSettings.channel, { url: 'https://wb.example.invalid/v1?x=1', model: 'wb' });
    expect(worldbookChannelIssue()).toContain('不能带账号、? 参数');
    worldbookSettings.channel.url = 'https://wb.example.invalid/v1';
    expect(resolveWorldbookChannel()).toMatchObject({ url: 'https://wb.example.invalid/v1', model: 'wb' });
  });

  it('旧数据缺字段时按默认补齐', () => {
    expect(normalizeWorldbookSettings({ apiMode: 'independent', channel: { url: ' https://a.example/v1 ' } })).toMatchObject({
      apiMode: 'independent', permission: 'create', channel: { url: 'https://a.example/v1', maxTokens: 8000 }, auto: { enabled: false },
    });
  });
});
