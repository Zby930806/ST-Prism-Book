import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 规划讨论的自定义角色、推进节奏的设置规整,以及发布版 Qiheng 提示词与最后一次真实试聊一致。
const mocks = vi.hoisted(() => ({ ctx: null as unknown as Record<string, unknown> }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.ctx }));

import { customDiscussionPrompt, DISCUSSION_PROMPT, discussionSystemPrompt } from './discussionContext';
import { discussionTranscript } from './discussionView';
import { activeDiscussionPersona, personaInitial } from './persona';
import { hydrateOutlineSettings, OUTLINE_SETTINGS_KEY, outlineSettings, PERSONA_NAME_MAX, saveOutlineSettings } from './settings';

function useSettings(saved?: Record<string, unknown>) {
  mocks.ctx = {
    extensionSettings: saved ? { [OUTLINE_SETTINGS_KEY]: { version: 1, apiMode: 'notes', channel: {}, ...saved } } : {},
    saveSettingsDebounced: vi.fn(),
  };
  hydrateOutlineSettings();
}

beforeEach(() => useSettings());

describe('规划讨论的角色', () => {
  it('发布版 Qiheng 提示词与最后一次真实试聊(fix5)发出的系统提示词逐字相同', () => {
    // 改了 Qiheng 的提示词就要重新做真实试聊,再更新这里的哈希
    expect(createHash('sha256').update(DISCUSSION_PROMPT).digest('hex'))
      .toBe('143c1d2e1b303fcd18075e5487f6793ea72c91a8d9824f4f8c2f4de164bf6942');
  });

  it('默认和没填全的自定义角色都用 Qiheng', () => {
    expect(activeDiscussionPersona()).toMatchObject({ custom: false, name: 'Qiheng' });
    expect(discussionSystemPrompt()).toBe(DISCUSSION_PROMPT);
    useSettings({ discussionPersona: { mode: 'custom', name: '老王', prompt: '   ' } });
    expect(activeDiscussionPersona().custom).toBe(false);
    expect(discussionSystemPrompt()).toBe(DISCUSSION_PROMPT);
  });

  it('自定义角色:人设替换 Qiheng 的说话方式,讨论规则照常附上', () => {
    useSettings({ discussionPersona: { mode: 'custom', name: '老王', prompt: '毒舌编辑，说话直，爱用比喻。', avatar: '/user/images/baibai_book/discussion-avatar.webp?v=1' } });
    const persona = activeDiscussionPersona();
    expect(persona).toMatchObject({ custom: true, name: '老王', avatar: '/user/images/baibai_book/discussion-avatar.webp?v=1', greeting: [] });
    const prompt = discussionSystemPrompt();
    expect(prompt).toBe(customDiscussionPrompt('老王', '毒舌编辑，说话直，爱用比喻。'));
    expect(prompt.startsWith('你是 老王，')).toBe(true);
    expect(prompt).toContain('【人设】');
    expect(prompt).toContain('毒舌编辑，说话直，爱用比喻。');
    expect(prompt).toContain('以讨论规则为准');
    for (const part of ['【帮忙是正事】', '【讨论边界】', '【人物原则】', '不声称已经保存、修改、启用大纲或推进阶段', '不超过 8000 字符', '不发表情包']) {
      expect(prompt).toContain(part);
    }
    // Qiheng 的说话方式和「不编造自己的现实生活」不带进自定义角色
    for (const part of ['Qiheng', '【说话节奏】', '难绷', '不编造自己的现实生活']) expect(prompt).not.toContain(part);
    // 复制讨论时说话人用自定义的名字
    expect(discussionTranscript([{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }])).toContain('老王：');
  });

  it('没有头像时显示名字的第一个字', () => {
    expect(personaInitial('老王')).toBe('老');
    expect(personaInitial('bob')).toBe('B');
    expect(personaInitial('')).toBe('?');
  });
});

describe('规划设置的规整', () => {
  it('旧设置没有推进节奏和讨论角色时用默认值:适中、Qiheng', () => {
    useSettings({ progressCheck: { auto: true, interval: 3, autoAdvance: false } });
    expect(outlineSettings.pace).toBe('normal');
    expect(outlineSettings.discussionPersona).toEqual({ mode: 'qiheng', name: '', prompt: '', avatar: '' });
    expect(outlineSettings.progressCheck.auto).toBe(true);
  });

  it('认不出的值回到默认,名字超长时截到上限', () => {
    useSettings({ pace: 'turbo', discussionPersona: { mode: 'robot', name: '名'.repeat(30), prompt: 42 } });
    expect(outlineSettings.pace).toBe('normal');
    expect(outlineSettings.discussionPersona.mode).toBe('qiheng');
    expect(outlineSettings.discussionPersona.name).toHaveLength(PERSONA_NAME_MAX);
    expect(outlineSettings.discussionPersona.prompt).toBe('');
  });

  it('保存后写进扩展设置,再载入时保留', () => {
    outlineSettings.pace = 'slow';
    outlineSettings.discussionPersona = { mode: 'custom', name: '老王', prompt: '人设', avatar: '' };
    saveOutlineSettings();
    const saved = (mocks.ctx.extensionSettings as Record<string, Record<string, unknown>>)[OUTLINE_SETTINGS_KEY];
    expect(saved).toMatchObject({ version: 1, pace: 'slow', discussionPersona: { mode: 'custom', name: '老王', prompt: '人设' } });
    hydrateOutlineSettings();
    expect(outlineSettings.pace).toBe('slow');
    expect(activeDiscussionPersona()).toMatchObject({ custom: true, name: '老王' });
  });
});
