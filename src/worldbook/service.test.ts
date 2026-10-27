import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as host from '@/st/context';
import * as api from '@/api/settings';
import { requestCompletion } from '@/api/client';
import { toast } from '@/st/toast';
import { makeTavern, message } from './testEnv';
import { worldbookSettings } from './settings';
import { loadWorldbookData, worldbookState, WORLDBOOK_DATA_KEY } from './store';
import { bindWorldbookLifecycle, cancelSuggestions, evaluateAuto, generateSuggestions, maybeAutoSuggest, pendingCount, unbindWorldbookLifecycle, worldbookRun } from './service';
import type { WorldData } from './types';

// 生成流程与自动建议的触发条件。模型回复全部本地模拟，不连接真实模型或酒馆。
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn() }));
vi.mock('@/st/toast', () => ({ toast: vi.fn() }));
vi.mock('@/memory/engine', () => ({ isAiFloor: (m: { is_user?: boolean }) => !!m && !m.is_user }));

const completion = vi.mocked(requestCompletion);
const BOOK = '雾港设定';
const book = (): WorldData => ({ entries: { 0: { uid: 0, comment: '雾港', key: ['雾港'], content: '潮汐环绕的港城。' } } });
const reply = (actions: unknown[]) => JSON.stringify({ actions });
let tavern: ReturnType<typeof makeTavern>;

function addTurn(text = '新的剧情。') {
  tavern.ctx.chat.push(message('继续。', { is_user: true }), message(text));
}
function emitGeneration(type: string | undefined = 'normal', dryRun = false) {
  const { emit } = tavern.ctx.eventSource as unknown as { emit: (name: string, ...args: unknown[]) => void };
  emit('GENERATION_STARTED', type, {}, dryRun);
  emit('CHARACTER_MESSAGE_RENDERED', tavern.ctx.chat.length - 1, type);
  emit('GENERATION_ENDED');
}

beforeEach(() => {
  tavern = makeTavern({ books: { [BOOK]: book(), '全局书': { entries: { 1: { uid: 1, comment: '港口规矩', key: ['雾港'], content: '参考。' } } } } });
  tavern.ctx.chatMetadata.world_info = BOOK;
  vi.spyOn(host, 'getContext').mockImplementation(() => tavern.ctx);
  vi.spyOn(api, 'engineActiveHere').mockReturnValue(true);
  vi.stubGlobal('fetch', tavern.fetchStub);
  Object.assign(worldbookSettings, { apiMode: 'independent', permission: 'create', auto: { enabled: false, interval: 2 } });
  Object.assign(worldbookSettings.channel, { url: 'https://wb.example.invalid/v1', key: 'mock-key', model: 'mock-model' });
  completion.mockReset();
  completion.mockResolvedValue(reply([{ action: 'create', title: '钟塔', keys: ['钟塔'], content: '城北的旧钟塔。', reason: '正文确立', floors: [1] }]));
  vi.mocked(toast).mockReset();
  loadWorldbookData();
  Object.assign(worldbookRun, { busy: false, status: '', error: '', errorDetail: '', autoNote: '', storyBusy: false, lastDropped: [] });
});
afterEach(() => { unbindWorldbookLifecycle(); cancelSuggestions(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('手动生成', () => {
  it('读取新楼层，保存一批建议并推进读取进度；请求只含索引和相关条目，不含整本书', async () => {
    expect(await generateSuggestions()).toBe(true);
    expect(worldbookState.batches).toHaveLength(1);
    expect(worldbookState.batches[0]).toMatchObject({ book: BOOK, auto: false, permission: 'create', source: { from: 0, to: 1 } });
    expect(worldbookState.batches[0].suggestions[0]).toMatchObject({ kind: 'create', title: '钟塔', status: 'pending' });
    expect(worldbookState.cursor?.floor).toBe(1);
    expect(worldbookRun.status).toContain('生成 1 条建议');
    const [channel, messages] = completion.mock.calls[0];
    expect(channel.model).toBe('mock-model');
    expect(messages[0].content).toContain('内容边界');
    expect(messages.map(m => m.content).join('\n')).toContain('[uid 0] 雾港');
    expect(pendingCount()).toBe(1);
  });

  it('默认用札记的 API；模型名含 deepseek 时不发送内容边界', async () => {
    worldbookSettings.apiMode = 'notes';
    const notes = await import('@/notes/settings');
    Object.assign(notes.notesSettings.channel, { url: 'https://notes.example.invalid/v1', model: 'deepseek-chat' });
    await generateSuggestions();
    const [channel, messages] = completion.mock.calls[0];
    expect(channel.model).toBe('deepseek-chat');
    expect(messages[0].content).not.toContain('内容边界');
  });

  it('内容边界按设置：始终发送时 DeepSeek 也带，不发送时其他模型也不带', async () => {
    const before = api.apiSettings.contentBoundary;
    try {
      api.apiSettings.contentBoundary = 'always';
      worldbookSettings.channel.model = 'deepseek-chat';
      await generateSuggestions();
      expect(completion.mock.calls[0][1][0].content).toContain('内容边界');

      api.apiSettings.contentBoundary = 'never';
      worldbookSettings.channel.model = 'mock-model';
      addTurn();
      await generateSuggestions();
      expect(completion.mock.calls[1][1][0].content).not.toContain('内容边界');
    } finally {
      api.apiSettings.contentBoundary = before;
    }
  });

  it('没有建议时只推进读取进度，不保存空批次；丢弃的动作说明原因', async () => {
    completion.mockResolvedValueOnce(reply([{ action: 'delete', uid: 0 }]));
    await generateSuggestions();
    expect(worldbookState.batches).toEqual([]);
    expect(worldbookState.cursor?.floor).toBe(1);
    expect(worldbookRun.status).toContain('没有需要写入的新设定');
    expect(worldbookRun.lastDropped[0].reason).toContain('不支持删除');
  });

  it('请求期间依据的楼层被重抽，结果不采用', async () => {
    completion.mockImplementationOnce(async () => { tavern.ctx.chat[1] = message('重抽后的回复。'); return reply([]); });
    expect(await generateSuggestions()).toBe(false);
    expect(worldbookRun.status).toContain('没有采用');
    expect(tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY]).toBeUndefined();
  });

  it('没有写入目标、API 未填写、正文生成中时说明原因，不发请求', async () => {
    delete tavern.ctx.chatMetadata.world_info;
    await generateSuggestions();
    expect(worldbookRun.error).toContain('还没有写入目标');
    tavern.ctx.chatMetadata.world_info = '不存在的书';
    await generateSuggestions();
    expect(worldbookRun.error).toContain('不存在：可能已被删除或改名');
    tavern.ctx.chatMetadata.world_info = BOOK;
    worldbookSettings.channel.url = '';
    await generateSuggestions();
    expect(worldbookRun.error).toContain('世界书专用 API 的地址和模型名');
    expect(completion).not.toHaveBeenCalled();
  });

  it('JSON 写到一半就结束时按截断说明', async () => {
    completion.mockResolvedValueOnce('{"actions":[{"action":"create","title":"钟');
    await generateSuggestions();
    expect(worldbookRun.error).toContain('长度上限');
    expect(worldbookState.cursor).toBeNull();
  });

  it('单层正文最多读到「正文字数上限」；被截断的楼层在状态里说明', async () => {
    worldbookSettings.read = { ...worldbookSettings.read, maxChars: 4000 };
    tavern.ctx.chat.push(message('继续。', { is_user: true }), message('长'.repeat(6000)));
    try {
      await generateSuggestions();
      expect(worldbookRun.status).toContain('第 3 楼超过单层上限（4000 字），后半段没有读取');
      expect(completion.mock.calls[0][1].map(m => m.content).join('\n')).toContain('以下截断');
    } finally { worldbookSettings.read = { ...worldbookSettings.read, maxChars: 24000 }; }
  });

  it('整段改写的建议只采用全文完整发送过的条目', async () => {
    worldbookSettings.permission = 'modify';
    tavern.books.set(BOOK, { entries: { 0: { uid: 0, comment: '雾港', key: ['雾港'], content: '潮'.repeat(2500) } } });
    completion.mockResolvedValueOnce(reply([{ action: 'rewrite', uid: 0, content: '改写后的雾港。', reason: 'r', floors: [1] }]));
    tavern.ctx.chat[1] = message('雾港的钟塔在城北。');
    await generateSuggestions();
    expect(worldbookState.batches).toEqual([]);
    expect(worldbookRun.lastDropped[0].reason).toContain('不能整段改写');
  });
});

describe('自动建议', () => {
  it('默认关闭：正文生成结束后不运行', async () => {
    bindWorldbookLifecycle();
    addTurn(); addTurn();
    emitGeneration();
    await new Promise(r => setTimeout(r, 900));
    expect(completion).not.toHaveBeenCalled();
  });

  it('打开后每 N 个新的 AI 楼层在正文生成结束后运行一次，完成后提示', async () => {
    worldbookSettings.auto.enabled = true;
    bindWorldbookLifecycle();
    addTurn();
    emitGeneration();
    await vi.waitFor(() => expect(completion).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await vi.waitFor(() => expect(worldbookState.batches).toHaveLength(1));
    expect(worldbookState.batches[0].auto).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('1 条新建议'), 'info');
  });

  it.each([['quiet'], ['impersonate']])('%s 生成不触发', async type => {
    worldbookSettings.auto.enabled = true;
    bindWorldbookLifecycle();
    emitGeneration(type);
    await new Promise(r => setTimeout(r, 900));
    expect(completion).not.toHaveBeenCalled();
  });

  it('试运行不触发；切换聊天取消已排队的自动建议', async () => {
    worldbookSettings.auto.enabled = true;
    bindWorldbookLifecycle();
    emitGeneration('normal', true);
    await new Promise(r => setTimeout(r, 900));
    expect(completion).not.toHaveBeenCalled();
    emitGeneration();
    tavern.switchChat('chat-b', [message('另一个聊天。'), message('另一段回复。')]);
    (tavern.ctx.eventSource as unknown as { emit: (n: string) => void }).emit('CHAT_CHANGED');
    await new Promise(r => setTimeout(r, 900));
    expect(completion).not.toHaveBeenCalled();
  });

  it('新增的 AI 楼层不足间隔时不运行', async () => {
    worldbookSettings.auto = { enabled: true, interval: 2 };
    await generateSuggestions();
    completion.mockClear();
    loadWorldbookData();
    worldbookState.batches = [];
    addTurn();
    expect(evaluateAuto().run).toBe(false);
    addTurn();
    expect(evaluateAuto().run).toBe(true);
  });

  it('有待审核的建议时暂停，不堆积新的请求', async () => {
    await generateSuggestions();
    worldbookSettings.auto = { enabled: true, interval: 2 };
    addTurn(); addTurn();
    completion.mockClear();
    expect(await maybeAutoSuggest()).toBe(false);
    expect(completion).not.toHaveBeenCalled();
    expect(evaluateAuto().note).toContain('建议待审核，自动建议暂停');
    expect(worldbookRun.autoNote).toBe('');
  });

  it('失败不自动重试：再新增 N 个 AI 楼层后才再次运行', async () => {
    worldbookSettings.auto = { enabled: true, interval: 2 };
    addTurn();
    completion.mockRejectedValueOnce(new Error('网络中断'));
    expect(await maybeAutoSuggest()).toBe(false);
    expect(worldbookRun.autoNote).toContain('自动建议没有完成');
    expect(worldbookRun.error).toBe('');
    expect(await maybeAutoSuggest()).toBe(false);
    expect(completion).toHaveBeenCalledTimes(1);
    addTurn(); addTurn();
    expect(await maybeAutoSuggest()).toBe(true);
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it('API 未填写时不运行，并说明原因', async () => {
    worldbookSettings.auto = { enabled: true, interval: 2 };
    worldbookSettings.channel.model = '';
    addTurn();
    expect(await maybeAutoSuggest()).toBe(false);
    expect(evaluateAuto().note).toContain('自动建议没有运行');
    expect(completion).not.toHaveBeenCalled();
  });
});
