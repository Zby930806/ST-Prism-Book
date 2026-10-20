import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import * as host from '@/st/context';
import * as api from '@/api/settings';
import { notesSettings, hydrateNotesSettings, saveNotesSettings, notesChannelIssue, NOTES_SETTINGS_KEY } from './settings';
import { sourceHash, latestStoryFloor } from './source';
import { parseQuestions } from './protocol';
import { notesState, loadNotes, addNote } from './store';
import { notesRun, cancelNotes, generateNotes } from './service';
import { notesCardFloors, floorNote } from './floors';
import type { NoteRecord } from './types';

vi.mock('@/api/client', () => ({ requestCompletion: vi.fn() }));
vi.mock('@/memory/store', () => ({
  memory: { summaries: [], state: {}, protagonist: {}, npcs: [], items: [], plans: [] },
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ selectHistoryNodesBefore: vi.fn(() => []), renderHistoryNodes: vi.fn(() => '') }));

const message = (mes: string, overrides: Partial<STMessage> = {}): STMessage => ({ name: '角色', is_user: false, is_system: false, mes, swipe_id: 0, ...overrides });
let ctx: STContext;
function context(): STContext {
  return {
    chat: [message('开场。', { is_user: true }), message('第一段正文。'), message('继续。', { is_user: true }), message('第二段正文。')],
    chatMetadata: {}, extensionSettings: {}, name1: '用户', name2: '角色', characterId: '0', groupId: undefined,
    getCurrentChatId: () => 'chat-floors', saveMetadata: vi.fn().mockResolvedValue(undefined), saveSettingsDebounced: vi.fn(),
    setExtensionPrompt: vi.fn(), eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  } as unknown as STContext;
}
const text = 'Q1. 要不要去钟塔？凝嘤嘤暂定: 入夜后去\nQ2. 梅芙同行吗？凝嘤嘤暂定: 留在旧街';
function record(id: string, floor: number, createdAt = 1): NoteRecord {
  return { id, createdAt, floor, swipe: ctx.chat[floor].swipe_id ?? 0, sourceHash: sourceHash(ctx, floor), text, questions: parseQuestions(text) };
}

beforeEach(() => {
  ctx = context();
  vi.spyOn(host, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(api, 'engineActiveHere').mockReturnValue(true);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  hydrateNotesSettings(); loadNotes(); cancelNotes();
  Object.assign(notesRun, { busy: false, draft: '', error: '', errorDetail: '', status: '', floor: null, storyBusy: false });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('聊天里的札记卡片', () => {
  it('「在聊天中显示札记」默认打开，旧设置没有这一项时也按打开处理，可保存为关闭', () => {
    expect(notesSettings.showInChat).toBe(true);
    ctx.extensionSettings![NOTES_SETTINGS_KEY] = { version: 1, channel: { url: '', model: '' } };
    hydrateNotesSettings();
    expect(notesSettings.showInChat).toBe(true);
    notesSettings.showInChat = false; saveNotesSettings();
    expect(ctx.extensionSettings![NOTES_SETTINGS_KEY]).toMatchObject({ version: 1, showInChat: false });
    hydrateNotesSettings();
    expect(notesSettings.showInChat).toBe(false);
  });

  it('挂在最新正文楼层和有有效札记的楼层；只看已渲染的楼层', async () => {
    expect(latestStoryFloor(ctx)).toBe(3);
    expect([...notesCardFloors(ctx, [0, 1, 2, 3])]).toEqual([3]);
    await addNote(record('n1', 1));
    expect([...notesCardFloors(ctx, [0, 1, 2, 3])].sort()).toEqual([1, 3]);
    // 未渲染的楼层不挂
    expect([...notesCardFloors(ctx, [2, 3])]).toEqual([3]);
  });

  it('正文改过的楼层不再显示失效札记；同楼多份时取最新一份', async () => {
    await addNote(record('old', 1, 1));
    await addNote(record('new', 1, 2));
    expect(floorNote(1)?.id).toBe('new');
    ctx.chat[1].mes = '第一段正文，改过了。';
    notesState.revision++;
    expect(floorNote(1)).toBeNull();
    expect([...notesCardFloors(ctx, [0, 1, 2, 3])]).toEqual([3]);
  });

  it('生成前的检查不通过时不记楼层，卡片不显示进度；API 没填时给出原因', async () => {
    notesSettings.enabled = true;
    expect(notesChannelIssue()).toContain('独立 API 设置');
    await generateNotes();
    expect(notesRun.floor).toBeNull();
    expect(notesRun.error).toContain('独立 API 设置');
  });

  it('没有札记在生成时，正文开始生成不会显示「已取消」', () => {
    cancelNotes();
    expect(notesRun.status).toBe('');
    notesRun.busy = true;
    cancelNotes();
    expect(notesRun.status).toContain('已取消');
  });
});
