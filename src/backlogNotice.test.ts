import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { ui } from '@/state/ui';
import { currentSummaryPromise, engineState, handleGenerationIntercept } from '@/memory/engine';
import { loadMemory, memory } from '@/memory/store';
import { createEmptyMemory, type LeafExtra } from '@/memory/types';
import { outlineState } from '@/outline/store';
import { notesRun } from '@/notes/service';
import {
  BACKLOG_NOTICE_SENTINEL, isMarkedBacklogNotice, planBacklogCleanup, runBacklogCleanup,
  stripBacklogNoticesFromPrompt, trailingBacklogNotices,
} from './backlogNotice';

let leafSeq = 0;
const leaf = (): LeafExtra => ({ id: 'leaf-' + ++leafSeq, text: '摘要', delta: {}, createdAt: leafSeq, swipe: 0, v: 1 });
const user = (mes = '继续。'): STMessage => ({ name: '玩家', is_user: true, is_system: false, mes });
const ai = (summarized = true, mes = '她走进房间。'): STMessage => ({ name: '角色', is_user: false, is_system: false, mes, ...(summarized ? { extra: { bbs_leaf: leaf() } } : {}) });
const noticeText = `【棱镜宝书】${BACKLOG_NOTICE_SENTINEL}\n发生了什么：前面有楼层还没有摘要。`;
const notice = (marked = true): STMessage => ({ name: '棱镜宝书', is_user: false, is_system: false, mes: noticeText, ...(marked ? { extra: { bbs_internal_notice: 'backlog', bbs_omit: true } } : {}) });

let ctx: STContext;
let exec: ReturnType<typeof vi.fn>;
function useChat(chat: STMessage[]) {
  exec = vi.fn(async (command: string) => {
    // 模拟酒馆 /cut：范围含两端，逐条删除
    const cut = command.match(/^\/cut (\d+)(?:-(\d+))?$/);
    if (cut) {
      const start = Number(cut[1]); const end = Number(cut[2] ?? cut[1]);
      ctx.chat.splice(start, end - start + 1);
      return;
    }
    // 模拟酒馆 /sendas：追加一条普通的非用户消息（{{newline}} 还原成换行）
    const sendas = command.match(/^\/sendas name="([^"]+)" ([\s\S]*)$/);
    if (sendas) ctx.chat.push({ name: sendas[1], is_user: false, is_system: false, mes: sendas[2].replaceAll('{{newline}}', '\n') });
  });
  ctx = {
    chat, chatMetadata: {}, name1: '玩家', name2: '角色', getCurrentChatId: () => 'notice-chat',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    executeSlashCommandsWithOptions: exec, setExtensionPrompt: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
  loadMemory();
}

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  outlineState.draft = null; outlineState.active = null;
  ui.open = false;
  notesRun.busy = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockRejectedValue(new Error('测试不发请求'));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  engineState.running = false;
  ui.open = false;
  notesRun.busy = false;
  vi.restoreAllMocks();
});

describe('拦截提示的识别', () => {
  it('只认带标记、正文仍是提示原文的非用户消息', () => {
    expect(isMarkedBacklogNotice(notice())).toBe(true);
    expect(isMarkedBacklogNotice(notice(false))).toBe(false); // 没有标记
    expect(isMarkedBacklogNotice({ ...notice(), mes: '用户改写成了自己的正文' })).toBe(false);
    expect(isMarkedBacklogNotice({ ...notice(), is_user: true })).toBe(false);
    expect(isMarkedBacklogNotice(ai())).toBe(false);
  });
  it('末尾连续的提示才算可删的；后面已有发言时不算', () => {
    expect(trailingBacklogNotices([ai(), user(), notice(), notice()])).toEqual([2, 3]);
    expect(trailingBacklogNotices([ai(), user(), notice(), user()])).toEqual([]);
    expect(trailingBacklogNotices([ai(), notice(), user(), notice()])).toEqual([3]);
  });
});

describe('删除时机（planBacklogCleanup）', () => {
  const chat = [ai(), user(), ai(), user(), notice()];
  it('有缺口不删', () => {
    expect(planBacklogCleanup({ chat, holes: 1, busy: '', anchors: [] })).toEqual({ action: 'wait', reason: '还有楼层没有摘要' });
  });
  it('正在摘要等忙碌状态下不删', () => {
    expect(planBacklogCleanup({ chat, holes: 0, busy: '摘要正在进行', anchors: [] })).toEqual({ action: 'wait', reason: '摘要正在进行' });
  });
  it('补齐后删除末尾的提示', () => {
    expect(planBacklogCleanup({ chat, holes: 0, busy: '', anchors: [] })).toMatchObject({ action: 'delete', floors: [4], kept: [] });
  });
  it('依据楼层的记录包含提示时保留，只删它之后的', () => {
    const two = [ai(), user(), notice(), notice()];
    expect(planBacklogCleanup({ chat: two, holes: 0, busy: '', anchors: [{ floor: 2, kind: 'outline-active' }] }))
      .toMatchObject({ action: 'delete', floors: [3], kept: [2] });
    const kept = planBacklogCleanup({ chat: two, holes: 0, busy: '', anchors: [{ floor: 3, kind: 'imported' }, { floor: 1, kind: 'outline-draft' }] });
    expect(kept).toMatchObject({ action: 'keep', kept: [2, 3] });
    expect(kept.action === 'keep' && kept.keptReason).toContain('导入的旧总结');
    expect(kept.action === 'keep' && kept.keptReason).not.toContain('规划草稿'); // 早于提示的记录不受影响
  });
  it('没有带标记的提示时什么都不做', () => {
    expect(planBacklogCleanup({ chat: [ai(), user(), notice(false)], holes: 0, busy: '', anchors: [] })).toEqual({ action: 'none' });
  });
});

describe('自动删除（接入引擎状态）', () => {
  it('引擎插入的提示带标记；补齐缺口前不删，补齐后用 /cut 删除', async () => {
    const chat = [ai(false), user(), ai(false), user(), ai(true), user('下一步')];
    useChat(chat);
    const abort = vi.fn();
    expect(await handleGenerationIntercept('normal', abort)).toBe(true);
    expect(abort).toHaveBeenCalledWith(true);
    const inserted = ctx.chat[ctx.chat.length - 1];
    expect(inserted.extra).toMatchObject({ bbs_internal_notice: 'backlog', bbs_omit: true });
    expect(isMarkedBacklogNotice(inserted)).toBe(true);

    exec.mockClear();
    expect(await runBacklogCleanup()).toBe('wait'); // 两层缺口还在
    ctx.chat[0].extra = { bbs_leaf: leaf() };
    loadMemory();
    expect(await runBacklogCleanup()).toBe('wait'); // 还剩一层缺口
    expect(exec).not.toHaveBeenCalled();

    ctx.chat[2].extra = { bbs_leaf: leaf() };
    loadMemory();
    expect(await runBacklogCleanup()).toBe('delete');
    expect(exec).toHaveBeenCalledWith('/cut 6');
    expect(ctx.chat).toHaveLength(6);
    expect(ctx.chat.some(isMarkedBacklogNotice)).toBe(false);
    expect(notices.toast).toHaveBeenCalledWith(expect.stringContaining('已删除聊天末尾的 1 条'), 'success');
  });

  it('正在摘要、宝书窗口开着、札记正在生成时不删，结束后才删', async () => {
    useChat([ai(), user(), ai(), user(), notice()]);
    engineState.running = true;
    expect(await runBacklogCleanup()).toBe('wait');
    engineState.running = false;
    ui.open = true;
    expect(await runBacklogCleanup()).toBe('wait');
    ui.open = false;
    notesRun.busy = true;
    expect(await runBacklogCleanup()).toBe('wait');
    notesRun.busy = false;
    expect(exec).not.toHaveBeenCalled();
    expect(await runBacklogCleanup()).toBe('delete');
    expect(exec).toHaveBeenCalledWith('/cut 4');
  });

  it('只删带标记的消息：没标记的同名消息、中间的旧提示都不动', async () => {
    useChat([ai(), notice(), user(), ai(), notice(false)]);
    expect(await runBacklogCleanup()).toBe('none');
    useChat([ai(), notice(), user(), ai(), user()]);
    expect(await runBacklogCleanup()).toBe('none');
    expect(exec).not.toHaveBeenCalled();
  });

  it('末尾连续多条一起删；已确认的规划依据这条提示时保留并提示一次', async () => {
    useChat([ai(), user(), notice(), notice()]);
    expect(await runBacklogCleanup()).toBe('delete');
    expect(exec).toHaveBeenCalledWith('/cut 2-3');
    expect(ctx.chat).toHaveLength(2);

    useChat([ai(), user(), notice()]);
    memory.summaries.push({ id: 'imp', text: '导入的旧总结', level: 1, auto: false, childIds: [], createdAt: 1, imported: true, importedFloorStart: 0, importedFloorEnd: 2 });
    expect(await runBacklogCleanup()).toBe('keep');
    expect(await runBacklogCleanup()).toBe('keep');
    expect(exec).not.toHaveBeenCalled();
    expect(vi.mocked(notices.toast).mock.calls.filter(c => String(c[0]).includes('没有自动删除'))).toHaveLength(1);
  });

  it('插件未在当前聊天启用或记忆处于保护状态时不删', async () => {
    useChat([ai(), user(), notice()]);
    vi.mocked(settings.engineActiveHere).mockReturnValue(false);
    expect(await runBacklogCleanup()).toBe('skip');
    vi.mocked(settings.engineActiveHere).mockReturnValue(true);
    ctx.chatMetadata.baibai_book = { version: 999, summaries: [] };
    expect(await runBacklogCleanup()).toBe('skip');
    expect(exec).not.toHaveBeenCalled();
  });

  it('/cut 失败时提示手动删除，不反复重试', async () => {
    useChat([ai(), user(), notice()]);
    exec.mockRejectedValueOnce(new Error('消息不在页面上'));
    expect(await runBacklogCleanup()).toBe('delete');
    expect(notices.toast).toHaveBeenCalledWith(expect.stringContaining('可在聊天中手动删除'), 'warning');
    exec.mockClear();
    await runBacklogCleanup();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('发给正文模型前过滤', () => {
  it('从这次请求的消息副本里去掉带标记的提示，聊天本身不变', () => {
    const chat = [ai(), notice(), user(), notice(false), notice()];
    const prompt = chat.map(m => ({ ...m }));
    expect(stripBacklogNoticesFromPrompt(prompt)).toBe(2);
    expect(prompt.map(m => m.name)).toEqual(['角色', '玩家', '棱镜宝书']); // 没标记的不动
    expect(chat).toHaveLength(5);
  });
  it('插件未启用（总开关关闭或角色被排除）时也过滤带标记的提示，聊天本身不变', () => {
    vi.mocked(settings.engineActiveHere).mockReturnValue(false);
    const chat = [ai(), notice(), user(), notice(false)];
    const prompt = chat.map(m => ({ ...m }));
    expect(stripBacklogNoticesFromPrompt(prompt)).toBe(1);
    expect(prompt.map(m => m.name)).toEqual(['角色', '玩家', '棱镜宝书']);
    expect(chat).toHaveLength(4);
  });
});
