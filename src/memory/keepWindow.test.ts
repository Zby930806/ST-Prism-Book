import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { currentSummaryPromise, handleGenerationIntercept, isAiFloor, resolveKeepStart } from './engine';
import { selectInjectionNodes } from './inject';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra } from './types';

// 「保留最近 AI 消息数」:组装正文提示词前,实际发全文的 AI 楼数必须等于设置值,
// 已隐藏(改发摘要)的楼和发全文的楼不能重叠。宿主与 /hide 均为本地模拟。
const original = {
  keepRecent: settings.apiSettings.keepRecent,
  autoSummaryEnabled: settings.apiSettings.autoSummaryEnabled,
  vector: settings.apiSettings.vector.enabled,
};

let seq = 0;
const leaf = (): LeafExtra => ({ id: `keep-${++seq}`, text: `第 ${seq} 条摘要`, delta: {}, createdAt: seq, swipe: 0, v: 1 });
const user = (): STMessage => ({ name: 'User', is_user: true, is_system: false, mes: '继续。' });
const ai = (summarized = true): STMessage => ({
  name: 'Character', is_user: false, is_system: false, mes: '一段正文。',
  ...(summarized ? { extra: { bbs_leaf: leaf() } } : {}),
});
/** 模拟插件之前用 /hide 隐藏的楼。 */
const hidden = (m: STMessage): STMessage => ({ ...m, is_system: true, extra: { ...(m.extra ?? {}), bbs_hidden: true } });

function useChat(chat: STMessage[]) {
  const exec = vi.fn(async (command: string) => {
    const m = /^\/(hide|unhide) (\d+)(?:-(\d+))?$/.exec(command);
    if (!m) throw new Error(`unexpected command ${command}`);
    for (let i = Number(m[2]); i <= Number(m[3] ?? m[2]); i++) chat[i].is_system = m[1] === 'hide';
  });
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat, chatMetadata: {}, name1: 'User', name2: 'Character',
    executeSlashCommandsWithOptions: exec,
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'keep-window',
  } as unknown as STContext);
  recomputeDerived();
  return exec;
}

/** 会发给正文模型的 AI 楼(未隐藏);翻页时末楼正被换掉,不算。 */
function sentAiFloors(chat: STMessage[], rewritingLast = false): number[] {
  const floors = chat.map((m, i) => (isAiFloor(m) && !m.is_system ? i : -1)).filter(i => i >= 0);
  return rewritingLast ? floors.slice(0, -1) : floors;
}

function injectedLeafFloors(chat: STMessage[]): number[] {
  const ids = new Set(selectInjectionNodes(memory.summaries, chat).filter(n => n.kind === 'leaf').map(n => n.id));
  return chat.map((m, i) => (m.extra?.bbs_leaf && ids.has(m.extra.bbs_leaf.id) ? i : -1)).filter(i => i >= 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.keepRecent = 2;
  settings.apiSettings.autoSummaryEnabled = true;
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null); // 借用主 API:摘要推迟到生成结束,不在这里跑
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue('{}');
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});

afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings, { keepRecent: original.keepRecent, autoSummaryEnabled: original.autoSummaryEnabled });
  settings.apiSettings.vector.enabled = original.vector;
});

describe('保留最近 AI 消息数:发送前同步隐藏', () => {
  // 上一楼(#4)的摘要在新回复(#6)写完前完成:当时窗口按 #2、#4 算,只隐藏了 #0、#1。
  const staleChat = () => [hidden(ai()), hidden(user()), ai(), user(), ai(), user(), ai(false), user()];

  it.each(['normal', 'regenerate'])('新回复落定后再发送,最早那条移出窗口的楼会被隐藏(%s)', async type => {
    const chat = staleChat();
    useChat(chat);
    expect(sentAiFloors(chat)).toEqual([2, 4, 6]); // 修正前:三楼全文

    expect(await handleGenerationIntercept(type, vi.fn())).toBe(false);

    expect(sentAiFloors(chat)).toEqual([4, 6]);
    expect(chat.slice(0, 4).every(m => m.is_system && m.extra?.bbs_hidden)).toBe(true);
    expect(resolveKeepStart(chat)).toBe(4);
    // 改发摘要的楼正好是隐藏的楼,不与全文重叠
    expect(injectedLeafFloors(chat)).toEqual([0, 2]);
  });

  it('续写时末楼仍算在窗口里', async () => {
    const chat = staleChat().slice(0, -1);
    useChat(chat);

    expect(await handleGenerationIntercept('continue', vi.fn())).toBe(false);

    expect(sentAiFloors(chat)).toEqual([4, 6]);
    expect(injectedLeafFloors(chat)).toEqual([0, 2]);
  });

  it('翻页时正被换掉的末楼不占窗口:取消多隐藏的那一楼', async () => {
    // 按含末楼的窗口隐藏到 #3;翻页时 #6 不发,窗口应是 #2、#4
    const chat = [hidden(ai()), hidden(user()), hidden(ai()), hidden(user()), ai(), user(), ai(false)];
    chat[6].swipe_id = 1;
    chat[6].swipes = ['旧的一页。', ''];
    useChat(chat);

    expect(await handleGenerationIntercept('swipe', vi.fn())).toBe(false);

    expect(sentAiFloors(chat, true)).toEqual([2, 4]);
    expect(chat[2].extra?.bbs_hidden).toBeUndefined();
    expect(chat[3].is_system).toBe(false);
    expect(injectedLeafFloors(chat)).toEqual([0]);
  });

  it('窗口已正确时不发多余的隐藏命令', async () => {
    const chat = [hidden(ai()), hidden(user()), hidden(ai()), hidden(user()), ai(), user(), ai(false), user()];
    const exec = useChat(chat);

    await handleGenerationIntercept('normal', vi.fn());

    expect(exec).not.toHaveBeenCalled();
    expect(sentAiFloors(chat)).toEqual([4, 6]);
  });

  it('自动摘要关闭时不改隐藏状态', async () => {
    settings.apiSettings.autoSummaryEnabled = false;
    const chat = staleChat();
    const exec = useChat(chat);

    await handleGenerationIntercept('normal', vi.fn());

    expect(exec).not.toHaveBeenCalled();
    expect(sentAiFloors(chat)).toEqual([2, 4, 6]);
  });
});
