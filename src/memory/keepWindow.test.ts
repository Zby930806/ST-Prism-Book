import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { bindEngine, currentSummaryPromise, handleGenerationIntercept, isAiFloor, RENDERED_RECOMPUTE_DELAY_MS, resolveKeepStart } from './engine';
import { selectInjectionNodes } from './inject';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra } from './types';

// 「保留最近 AI 消息数」:每次生成里,实际发全文的 AI 楼数等于设置值,每一楼要么发全文、要么发摘要,不重复也不缺失。
// 按酒馆 Generate(script.js)的顺序模拟:GENERATION_STARTED → GENERATION_AFTER_COMMANDS(逐个 await 监听器)
// → 重新生成时删掉末楼 → 按 is_system 选出要发送的楼层(翻页再去掉末楼)→ 生成拦截器。
// 楼层选完之后再改隐藏状态,对这一次生成不起作用。宿主与 /hide 均为本地模拟。
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

const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
const eventNames = ['USER_MESSAGE_RENDERED', 'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED',
  'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'CHAT_CHANGED'];
/** 与酒馆的 eventSource.emit 相同:按注册顺序逐个 await。 */
async function emit(name: string, ...args: unknown[]) {
  for (const fn of [...(handlers.get(name) ?? [])]) await fn(...args);
}
let chat: STMessage[] = [];
const exec = vi.fn(async (command: string) => {
  const m = /^\/(hide|unhide) (\d+)(?:-(\d+))?$/.exec(command);
  if (!m) throw new Error(`unexpected command ${command}`);
  for (let i = Number(m[2]); i <= Number(m[3] ?? m[2]); i++) chat[i].is_system = m[1] === 'hide';
});
const ctx = {
  chat, chatMetadata: {}, name1: 'User', name2: 'Character',
  executeSlashCommandsWithOptions: exec,
  saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
  getCurrentChatId: () => 'keep-window',
  eventTypes: Object.fromEntries(eventNames.map(name => [name, name])),
  eventSource: {
    on: (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    off: (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, (handlers.get(name) ?? []).filter(f => f !== fn)); },
  },
} as unknown as STContext;

function useChat(messages: STMessage[]) {
  chat = messages;
  Object.assign(ctx, { chat, chatMetadata: {} });
  recomputeDerived();
  exec.mockClear();
}

function injectedLeafFloors(): number[] {
  const ids = new Set(selectInjectionNodes(memory.summaries, chat).filter(n => n.kind === 'leaf').map(n => n.id));
  return chat.map((m, i) => (m.extra?.bbs_leaf && ids.has(m.extra.bbs_leaf.id) ? i : -1)).filter(i => i >= 0);
}

/** 走一遍酒馆的生成流程,返回这次请求里发全文的 AI 楼和改发摘要的楼。 */
async function stGenerate(type: string, dryRun = false): Promise<{ full: number[]; summary: number[] }> {
  await emit('GENERATION_STARTED', type, {}, dryRun);
  await emit('GENERATION_AFTER_COMMANDS', type, {}, dryRun);
  if (type === 'regenerate' && chat.length && !chat[chat.length - 1].is_user) {
    chat.length -= 1;
    await emit('MESSAGE_DELETED', chat.length);
  }
  const picked = chat.map((m, i) => ({ m, i })).filter(x => !x.m.is_system);
  if (type === 'swipe') picked.pop();
  const full = picked.filter(x => isAiFloor(x.m)).map(x => x.i);
  expect(await handleGenerationIntercept(type, vi.fn())).toBe(false);
  return { full, summary: injectedLeafFloors() };
}

/** 新回复写完并显示:等合并重算的定时器和随后的隐藏同步。 */
async function replyRendered() {
  await emit('CHARACTER_MESSAGE_RENDERED', chat.length - 1, 'normal');
  await vi.advanceTimersByTimeAsync(RENDERED_RECOMPUTE_DELAY_MS + 50);
}

beforeAll(() => {
  vi.stubGlobal('document', { body: { dataset: {} } });
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null); // 借用主 API:摘要推迟到生成结束,不在这里跑
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue('{}');
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  bindEngine();
});
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.keepRecent = 2;
  settings.apiSettings.autoSummaryEnabled = true;
  settings.apiSettings.vector.enabled = false;
});
afterEach(async () => {
  await emit('GENERATION_STOPPED');
  await vi.advanceTimersByTimeAsync(1000);
  await currentSummaryPromise();
  await emit('CHAT_CHANGED');
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.assign(settings.apiSettings, { keepRecent: original.keepRecent, autoSummaryEnabled: original.autoSummaryEnabled });
  settings.apiSettings.vector.enabled = original.vector;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('保留最近 AI 消息数:酒馆选楼层之前同步隐藏', () => {
  // 回复 #6 写完之前,上一楼(#4)的摘要已完成:当时窗口按 #2、#4 算,只隐藏了 #0、#1。
  const stale = () => [hidden(ai()), hidden(user()), ai(), user(), ai(), user(), ai(false)];
  // 回复 #6 显示后的正常状态:窗口 #4、#6,隐藏到 #3。
  const settled = () => [hidden(ai()), hidden(user()), hidden(ai()), hidden(user()), ai(), user(), ai(false)];

  it('新回复显示后同步一次:最早那条移出窗口的楼改为隐藏', async () => {
    useChat(stale());

    await replyRendered();

    expect(chat.slice(0, 4).every(m => m.is_system && m.extra?.bbs_hidden)).toBe(true);
    expect(chat[4].is_system).toBe(false);
    expect(resolveKeepStart(chat)).toBe(4);
  });

  it('发送:没赶上显示后同步的,选楼层之前补上,这次请求里全文和摘要不重叠', async () => {
    useChat([...stale(), user()]);

    expect(await stGenerate('normal')).toEqual({ full: [4, 6], summary: [0, 2] });
  });

  it('续写:末楼仍算在窗口里', async () => {
    useChat(stale());

    expect(await stGenerate('continue')).toEqual({ full: [4, 6], summary: [0, 2] });
  });

  it('翻页:被换掉的末楼不占窗口,多发的那一楼全文在选楼层之前就已取消隐藏', async () => {
    useChat(settled());
    chat[6].swipe_id = 1;
    chat[6].swipes = ['旧的一页。', ''];

    // #2 发全文、不发摘要;不会两头都没有
    expect(await stGenerate('swipe')).toEqual({ full: [2, 4], summary: [0] });

    // 生成期间别处触发的同步(楼层重绘)不把 #2 藏回去
    await replyRendered();
    expect(chat[2].is_system).toBe(false);

    // 新的一页写完:窗口回到 #4、#6
    chat[6].mes = '新的一页。';
    await replyRendered();
    expect(chat[2].is_system && chat[3].is_system).toBe(true);
    expect(injectedLeafFloors()).toEqual([0, 2]);
  });

  it('重新生成:末楼删除之前就按删除后的窗口同步,之后的删除事件不再改动', async () => {
    useChat(settled());

    expect(await stGenerate('regenerate')).toEqual({ full: [2, 4], summary: [0] });

    const calls = exec.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); // MESSAGE_DELETED 之后的延迟同步
    expect(exec.mock.calls.length).toBe(calls);
    expect(injectedLeafFloors()).toEqual([0]);
  });

  it('重新生成:末尾是用户消息时不删楼,窗口照常', async () => {
    useChat([...settled().slice(0, 5), user()]); // 窗口 #2、#4,但 #2、#3 还隐藏着

    expect(await stGenerate('regenerate')).toEqual({ full: [2, 4], summary: [0] });
    expect(chat).toHaveLength(6);
  });

  it('生成拦截器不改隐藏状态(那时楼层已经选完)', async () => {
    useChat([...stale(), user()]);

    expect(await handleGenerationIntercept('normal', vi.fn())).toBe(false);
    expect(await handleGenerationIntercept('swipe', vi.fn())).toBe(false);

    expect(exec).not.toHaveBeenCalled();
    expect(chat[2].is_system).toBe(false);
  });

  it('窗口已正确时不发隐藏命令', async () => {
    useChat([...settled(), user()]);

    expect(await stGenerate('normal')).toEqual({ full: [4, 6], summary: [0, 2] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('只统计提示词的试算(dryRun)不改隐藏状态', async () => {
    useChat([...stale(), user()]);

    await emit('GENERATION_STARTED', 'normal', {}, true);
    await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, true);

    expect(exec).not.toHaveBeenCalled();
  });

  it('自动摘要关闭时不改隐藏状态', async () => {
    settings.apiSettings.autoSummaryEnabled = false;
    useChat([...stale(), user()]);

    expect((await stGenerate('normal')).full).toEqual([2, 4, 6]);
    expect(exec).not.toHaveBeenCalled();
  });
});
