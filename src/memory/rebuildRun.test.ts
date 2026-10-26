import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import {
  batchState, cancelBatchBackfill, continueRebuild, currentSummaryPromise, discardRebuildRun, engineState, readRebuildRun,
  REBUILD_RUN_KEY, rebuildableFloors, rebuildPlanFloors, rebuildProgress, regenerateFloor, startRebuild,
} from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra } from './types';

// 全部重新摘要的运行记录与中断后继续;模型回复为预设内容,只验证流程和存储,不代表模型质量。
const saved = JSON.stringify(settings.apiSettings);
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ai = (text: string, old = true): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text,
  extra: old ? { bbs_leaf: { id: 'leaf-' + text, text: '旧摘要', delta: {}, createdAt: 1, swipe: 0, v: 1 } } : {} });
/** 用户和 AI 交替:AI 楼层号为 1、3、5…… */
function story(count: number): STMessage[] {
  const chat: STMessage[] = [];
  for (let i = 1; i <= count; i++) chat.push(user('第' + i + '轮输入'), ai('第' + i + '轮正文'));
  return chat;
}
function useChat(chat: STMessage[]) {
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'rebuild-run-test',
    chatMetadata: {}, saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const leafOf = (m: STMessage) => m.extra?.bbs_leaf as LeafExtra | undefined;
const reply = (summary: string) => JSON.stringify({ summary, stateChanges: [] });
const meta = (ctx: STContext) => ctx.chatMetadata as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, summaryMaxRetries: 0, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(reply('新摘要。'));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('全部重新摘要的运行记录', () => {
  it('开始时写入记录,每楼完成后叶子带上运行 id,范围内全部完成后删除记录', async () => {
    const chat = story(3);
    const ctx = useChat(chat);
    let seen: unknown;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      seen ??= readRebuildRun(meta(ctx));
      return reply('新摘要。');
    });
    expect(await startRebuild()).toEqual({ done: 3, total: 3, cancelled: false });
    expect(seen).toMatchObject({ startFloor: 1, endFloor: 5 });
    const id = (seen as { id: string }).id;
    expect([1, 3, 5].map(f => leafOf(chat[f])?.rebuildRun)).toEqual([id, id, id]);
    expect([1, 3, 5].map(f => leafOf(chat[f])?.text)).toEqual(['新摘要。', '新摘要。', '新摘要。']);
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
    expect(rebuildProgress()).toBeNull();
    expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
  });

  it('取消后记录保留,进度按叶子标记计算;继续只处理没有标记的楼层,完成后删除记录', async () => {
    const chat = story(3);
    const ctx = useChat(chat);
    let call = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      if (++call === 2) cancelBatchBackfill(); // 第二层请求期间点取消:这一层完成后停下
      return reply('第' + call + '次。');
    });
    expect(await startRebuild()).toEqual({ done: 2, total: 3, cancelled: true });
    const run = readRebuildRun(meta(ctx))!;
    expect(run).toMatchObject({ startFloor: 1, endFloor: 5 });
    expect(rebuildProgress()).toEqual({ run, total: 3, done: 2, next: 5 });

    let during: { priorDone: number; total: number; mode: string } | null = null;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      during ??= { priorDone: batchState.priorDone, total: batchState.total, mode: batchState.mode };
      return reply('继续。');
    });
    expect(await continueRebuild()).toEqual({ done: 1, total: 1, cancelled: false });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(3);
    expect(during).toEqual({ priorDone: 2, total: 1, mode: 'rebuild' });
    expect([1, 3, 5].map(f => leafOf(chat[f])?.text)).toEqual(['第1次。', '第2次。', '继续。']);
    expect([1, 3, 5].every(f => leafOf(chat[f])?.rebuildRun === run.id)).toBe(true);
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
  });

  it('失败时停在失败的楼层并保留记录;只要记录还在元数据里,之后照样可以继续', async () => {
    const chat = story(3);
    const ctx = useChat(chat);
    let call = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      if (++call === 2) throw new Error('服务商暂时不可用');
      return reply('成功。');
    });
    const result = await startRebuild();
    expect(result).toMatchObject({ done: 1, total: 3, cancelled: false });
    expect(engineState.lastError).toContain('服务商暂时不可用');
    expect(leafOf(chat[3])?.text).toBe('旧摘要');
    expect(rebuildProgress()).toMatchObject({ total: 3, done: 1, next: 3 });
    // 刷新页面后内存里的状态都没了,记录和叶子标记还在聊天里
    const stored = JSON.parse(JSON.stringify(meta(ctx)));
    const reloaded = JSON.parse(JSON.stringify(chat)) as STMessage[];
    const ctx2 = useChat(reloaded);
    Object.assign(meta(ctx2), stored);
    expect(rebuildProgress()).toMatchObject({ total: 3, done: 1, next: 3 });
    vi.mocked(client.requestViaMainApi).mockResolvedValue(reply('补上。'));
    expect(await continueRebuild()).toEqual({ done: 2, total: 2, cancelled: false });
    expect([1, 3, 5].map(f => leafOf(reloaded[f])?.text)).toEqual(['成功。', '补上。', '补上。']);
    expect(meta(ctx2)[REBUILD_RUN_KEY]).toBeUndefined();
  });

  it('从指定楼层开始:之前的楼层保留原摘要;不是可处理的楼层时从之后的第一个开始', async () => {
    const chat = story(4);
    const ctx = useChat(chat);
    expect(rebuildPlanFloors(4)).toEqual([5, 7]);
    let seen: unknown;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      seen ??= readRebuildRun(meta(ctx));
      return reply('新摘要。');
    });
    expect(await startRebuild(4)).toEqual({ done: 2, total: 2, cancelled: false });
    expect(seen).toMatchObject({ startFloor: 5, endFloor: 7 });
    expect([1, 3, 5, 7].map(f => leafOf(chat[f])?.text)).toEqual(['旧摘要', '旧摘要', '新摘要。', '新摘要。']);
    expect(leafOf(chat[1])?.rebuildRun).toBeUndefined();
  });

  it('运行开始后新增的楼层不在范围内:继续时不处理,进度也不计入', async () => {
    const chat = story(2);
    const ctx = useChat(chat);
    let call = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      if (++call === 1) cancelBatchBackfill();
      return reply('新摘要。');
    });
    await startRebuild();
    const run = readRebuildRun(meta(ctx))!;
    expect(run.endFloor).toBe(3);
    chat.push(user('第3轮输入'), ai('第3轮正文', false));
    recomputeDerived();
    expect(rebuildProgress()).toMatchObject({ total: 2, done: 1, next: 3 });
    vi.mocked(client.requestViaMainApi).mockClear();
    expect(await continueRebuild()).toEqual({ done: 1, total: 1, cancelled: false });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(leafOf(chat[5])).toBeUndefined();
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
  });

  it('结束只删记录,已有摘要不变;没有剩余楼层时继续直接删除记录', async () => {
    const chat = story(2);
    const ctx = useChat(chat);
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => { cancelBatchBackfill(); return reply('新摘要。'); });
    await startRebuild();
    const id = readRebuildRun(meta(ctx))!.id;
    expect(discardRebuildRun()).toBe(true);
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
    expect(leafOf(chat[1])).toMatchObject({ text: '新摘要。', rebuildRun: id });
    expect(leafOf(chat[3])?.text).toBe('旧摘要');
    // 记录还在、但范围内已经全部完成(例如最后一层在别处重新摘要过):继续时不发请求,直接删除记录
    meta(ctx)[REBUILD_RUN_KEY] = { id, startFloor: 1, endFloor: 1, startedAt: 1 };
    vi.mocked(client.requestViaMainApi).mockClear();
    expect(await continueRebuild()).toEqual({ done: 0, total: 0, cancelled: false });
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
  });

  it('单楼重新摘要沿用标记;翻到另一页回复的楼层不算完成', async () => {
    const chat = story(2);
    const ctx = useChat(chat);
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => { cancelBatchBackfill(); return reply('新摘要。'); });
    await startRebuild();
    const id = readRebuildRun(meta(ctx))!.id;
    vi.mocked(client.requestViaMainApi).mockResolvedValue(reply('再摘一次。'));
    expect(await regenerateFloor(1)).toBe(true);
    expect(leafOf(chat[1])).toMatchObject({ text: '再摘一次。', rebuildRun: id });
    expect(rebuildProgress()).toMatchObject({ done: 1, next: 3 });
    // 翻页:叶子留在原页,当前显示的回复没有有效摘要
    chat[1].swipe_id = 1;
    recomputeDerived();
    expect(rebuildProgress()).toMatchObject({ done: 0, next: 1 });
  });
});

describe('可以全部重新摘要的楼层', () => {
  it('跳过继承种子、没有故事正文的楼层和番外楼;记录格式不对时当作没有记录', () => {
    const chat = story(4);
    (chat[1].extra!.bbs_leaf as LeafExtra).seed = true;
    chat[5].mes = '<bbs_start>周一</bbs_start><bbs_end>周一</bbs_end>';
    chat[7].extra = { ...chat[7].extra, bbs_omit: true };
    const ctx = useChat(chat);
    expect(rebuildableFloors(chat)).toEqual([3]);
    for (const bad of [null, 'x', { id: '' , startFloor: 0, endFloor: 1 }, { id: 'a', startFloor: 3, endFloor: 1 }, { id: 'a', startFloor: -1, endFloor: 1 }, { id: 'a', startFloor: 1.5, endFloor: 2 }]) {
      meta(ctx)[REBUILD_RUN_KEY] = bad;
      expect(readRebuildRun(meta(ctx))).toBeNull();
      expect(rebuildProgress()).toBeNull();
    }
  });
});
