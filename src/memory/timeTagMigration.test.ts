import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_EMPTY_TIME_TAG_PROMPT, normalizeSavedTimeTag } from './timeTagMigration';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('已安装用户的默认时间提示词受控升级', () => {
  it.each([
    ['旧默认', LEGACY_EMPTY_TIME_TAG_PROMPT, true],
    ['旧默认CRLF', '\r\n' + LEGACY_EMPTY_TIME_TAG_PROMPT.replace(/\n/g, '\r\n') + '\r\n', true],
    ['用户增加一句', LEGACY_EMPTY_TIME_TAG_PROMPT + '\n用户自己的时间要求。', false],
    ['用户改动一句', LEGACY_EMPTY_TIME_TAG_PROMPT.replace('没有依据时标签内容留空', '没有依据时询问玩家'), false],
    ['新安装默认', '', true],
  ] as const)('设置hydrate→实际注入：%s', async (_name, saved, isDefault) => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('@/api/settings');
    const tag = await import('./timeTag');
    const { refreshInjection } = await import('./inject');
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    stored.prompts.timeTag = saved;
    stored.autoSummaryEnabled = true;
    stored.memoryBudgetTokens = 0; // 自定义长文本不因预算裁剪混淆迁移断言。
    stored.wiPatternsSeeded = true;
    const slots = new Map<string, string>();
    const extensionSettings = { baibai_book: stored };
    const save = vi.fn();
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings, getCurrentChatId: () => 'migrated',
      saveSettingsDebounced: save,
      setExtensionPrompt: (key: string, value: string) => slots.set(key, value),
    } as unknown as import('@/st/context').STContext);
    vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    settings.hydrateSettings();
    expect(settings.apiSettings.prompts.timeTag).toBe(isDefault ? '' : saved);
    expect(stored.prompts.timeTag).toBe(isDefault ? '' : saved);
    refreshInjection();
    const actual = slots.get('baibai_book_time_tag');
    expect(actual).toBe(isDefault ? tag.TIME_TAG_PROMPT : saved);
    if (isDefault) {
      expect(actual).not.toContain('标签内容留空');
      expect(actual).not.toContain('没有时间依据时用空字符串');
      expect(actual).toContain('标签不留空');
      expect(tag.RULE_COMPLETE_TIME_ANCHOR).not.toContain('用空字符串');
    }
    if (saved && isDefault) expect(save).toHaveBeenCalled();
  });
  it('仅逐字默认匹配，不靠“留空”关键词覆盖自定义', () => {
    const custom = '我的正文规则：没有依据时标签内容留空';
    expect(normalizeSavedTimeTag(custom)).toBe(custom);
    expect(normalizeSavedTimeTag(LEGACY_EMPTY_TIME_TAG_PROMPT)).toBe('');
  });
});
