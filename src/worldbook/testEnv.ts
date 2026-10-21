/**
 * 测试用的模拟酒馆（只给 src/worldbook/*.test.ts 使用，不被插件代码引用）：
 * 内存中的聊天、聊天元数据、扩展设置和世界书，提供 loadWorldInfo / saveWorldInfo / reloadWorldInfoEditor 等接口，
 * 以及事件源。不连接真实酒馆、不请求模型。
 */
import { vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import type { WorldData } from './types';

/** 与 SillyTavern 1.15.0 world-info.js 的 newWorldInfoEntryTemplate 字段一致（不含 uid）。 */
export const ST_TEMPLATE = Object.freeze({
  key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0,
  addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
  matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
  matchScenario: false, matchCreatorNotes: false, delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4,
  outletName: '', group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
  useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
});

export function message(mes: string, overrides: Partial<STMessage> = {}): STMessage {
  return { name: overrides.is_user ? '用户' : '角色', is_user: false, is_system: false, mes, swipe_id: 0, ...overrides };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function makeTavern(opts: { chatId?: string; books?: Record<string, WorldData>; chat?: STMessage[]; primary?: string } = {}) {
  const books = new Map<string, WorldData>(Object.entries(clone(opts.books ?? {})));
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const names = ['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED'];
  let chatId = opts.chatId ?? 'chat-a';
  const ctx = {
    chat: opts.chat ?? [message('去港口看看。', { is_user: true }), message('雾港的钟塔在城北，入夜后不对外开放。')],
    chatMetadata: {} as Record<string, unknown>,
    extensionSettings: {} as Record<string, unknown>,
    name1: '用户', name2: '角色', characterId: '0', groupId: undefined,
    characters: [{ name: '角色', avatar: 'role.png', description: '角色卡描述。', data: { extensions: { world: opts.primary ?? '' } } }],
    getCurrentChatId: () => chatId,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    saveSettingsDebounced: vi.fn(),
    setExtensionPrompt: vi.fn(),
    getWorldInfoNames: () => [...books.keys()],
    loadWorldInfo: vi.fn(async (name: string) => (books.has(name) ? clone(books.get(name)) : null)),
    saveWorldInfo: vi.fn(async (name: string, data: WorldData) => { books.set(name, clone(data)); }),
    reloadWorldInfoEditor: vi.fn(),
    updateWorldInfoList: vi.fn(async () => {}),
    eventTypes: Object.fromEntries(names.map(n => [n, n])),
    eventSource: {
      on: vi.fn((name: string, fn: (...args: any[]) => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); }),
      off: vi.fn((name: string, fn: (...args: any[]) => void) => handlers.get(name)?.delete(fn)),
      emit: (name: string, ...args: any[]) => { handlers.get(name)?.forEach(fn => fn(...args)); },
    },
  } as unknown as STContext & { chatMetadata: Record<string, unknown> };
  /** 模拟服务器读取（保存后核对用）。 */
  const fetchStub = vi.fn(async (_url: string, init: { body: string }) => {
    const name = JSON.parse(init.body).name as string;
    return books.has(name) ? { ok: true, json: async () => clone(books.get(name)) } : { ok: false, json: async () => ({}) };
  });
  return {
    ctx, books, fetchStub,
    switchChat(id: string, chat?: STMessage[]) { chatId = id; ctx.chat = chat ?? [message('另一个聊天。')]; ctx.chatMetadata = {}; },
  };
}
