import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext } from '@/st/context';
import type { OutlineActive } from './types';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  request: vi.fn(),
  toast: vi.fn(),
  setChapter: vi.fn(),
  channelIssue: '',
  state: { active: null as OutlineActive | null },
  settings: { apiMode: 'notes', progressCheck: { auto: false, interval: 2, autoAdvance: false } },
}));
vi.mock('@/api/client', () => ({ requestCompletion: mocks.request }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/st/toast', () => ({ toast: mocks.toast }));
vi.mock('@/api/settings', () => ({ engineActiveHere: () => true }));
vi.mock('@/memory/engine', () => ({ isAiFloor: (m: { is_user: boolean }) => !m.is_user }));
vi.mock('@/memory/timeTag', () => ({ cleanBody: (s: string) => s }));
vi.mock('@/memory/apply', () => ({
  getLeaf: (m: { extra?: { bbs_leaf?: unknown } }) => m?.extra?.bbs_leaf,
  leafValid: (m: { extra?: { bbs_leaf?: unknown } }) => !!m?.extra?.bbs_leaf,
}));
vi.mock('./settings', () => ({
  outlineSettings: mocks.settings,
  resolveOutlineChannel: () => { if (mocks.channelIssue) throw new Error(mocks.channelIssue); return { url: 'https://x.example/v1', model: 'm' }; },
  outlineApiPath: () => '摘要 → 创作规划 → 修改或重新生成规划 → 规划 API 设置',
}));
vi.mock('./store', () => ({ outlineState: mocks.state, outlineSourceCurrent: () => true, outlineStorageCurrent: () => true, setOutlineChapter: mocks.setChapter }));

import { autoAdvanceForCurrentStage, buildProgressContext, checkOutlineProgress, maybeAutoCheckProgress, outlineProgress, parseProgressReply, progressForCurrentStage, progressMinMessages, PROGRESS_LIMITS } from './progress';

const active = (): OutlineActive => ({
  id: 'o1', createdAt: 1, sourceFloor: 0, sourceHash: 'h', brief: '', enabled: true, currentChapter: 0,
  content: { title: '雾港', premise: '追查来信', constraints: [], chapters: [
    { title: '钟塔', goal: '查明署名', approach: '夜访', beats: ['进入档案室'], exitCriteria: '找到署名的值班簿' },
    { title: '港口', goal: '寻人', approach: '打听', beats: ['见到船长'], exitCriteria: '见到船长' },
  ] },
});
function useChat(extra: Array<{ is_user: boolean; mes: string; extra?: Record<string, unknown> }> = []) {
  mocks.context = {
    chat: [{ name: 'U', is_user: true, is_system: false, mes: '去钟塔' }, { name: 'A', is_user: false, is_system: false, mes: '两人来到钟塔下。' },
      ...extra.map(m => ({ name: m.is_user ? 'U' : 'A', is_system: false, ...m }))],
    chatMetadata: {}, getCurrentChatId: () => 'chat-1',
  } as unknown as STContext;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.active = active();
  mocks.channelIssue = '';
  mocks.settings.progressCheck = { auto: false, interval: 2, autoAdvance: false };
  useChat();
  Object.assign(outlineProgress, { busy: false, outlineId: '', chapter: -1, met: null, reason: '', floor: -1, auto: false, dismissed: false, error: '', errorDetail: '', advanced: null, autoNote: '' });
});

describe('推进条件检查（全部本地 mock）', () => {
  it('回复必须是 {met, reason}，依据去掉多余空白并限长', () => {
    expect(parseProgressReply('```json\n{"met": true, "reason": "  找到了\\n值班簿 "}\n```')).toEqual({ met: true, reason: '找到了 值班簿' });
    expect(() => parseProgressReply('{"reason":"缺 met"}')).toThrow('met');
    expect(() => parseProgressReply('满足了')).toThrow('JSON');
  });

  it('请求里有当前阶段和最近正文，跳过插件提示楼和番外楼', () => {
    useChat([{ is_user: false, mes: '内部提示', extra: { bbs_internal_notice: 'backlog' } }, { is_user: false, mes: '番外', extra: { bbs_omit: true } }]);
    const messages = buildProgressContext(mocks.context, active());
    expect(messages[0].role).toBe('system');
    const user = String(messages[1].content);
    expect(user).toContain('第 1 / 2 阶段 · 钟塔');
    expect(user).toContain('推进条件：找到署名的值班簿');
    expect(user).toContain('第1楼 正文：\n两人来到钟塔下。');
    expect(user).not.toContain('内部提示');
    expect(user).not.toContain('番外');
  });

  it('检查结果记在当前阶段上；切换阶段后不再显示', async () => {
    mocks.request.mockResolvedValue('{"met": true, "reason": "已找到值班簿"}');
    expect(await checkOutlineProgress()).toBe(true);
    expect(outlineProgress).toMatchObject({ met: true, reason: '已找到值班簿', floor: 1, chapter: 0, outlineId: 'o1' });
    expect(progressForCurrentStage()).toBe(true);
    mocks.state.active!.currentChapter = 1;
    expect(progressForCurrentStage()).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('请求期间切换了阶段，迟到的结果丢弃', async () => {
    mocks.request.mockImplementation(async () => { mocks.state.active!.currentChapter = 1; return '{"met": true, "reason": "x"}'; });
    expect(await checkOutlineProgress()).toBe(false);
    expect(outlineProgress.met).toBeNull();
  });

  it('请求期间推进条件被手动改过，按旧条件得出的结果丢弃', async () => {
    mocks.request.mockImplementation(async () => { mocks.state.active!.content.chapters[0].exitCriteria = '改过的条件'; return '{"met": true, "reason": "x"}'; });
    expect(await checkOutlineProgress()).toBe(false);
    expect(outlineProgress.met).toBeNull();
  });

  it('规划暂停时手动检查给出原因，自动检查静默跳过', async () => {
    mocks.state.active!.enabled = false;
    expect(await checkOutlineProgress()).toBe(false);
    expect(outlineProgress.error).toContain('没有正在生效的规划阶段');
    outlineProgress.error = '';
    expect(await checkOutlineProgress({ auto: true })).toBe(false);
    expect(outlineProgress.error).toBe('');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('自动检查：第一次只记起点，AI 楼数增加到间隔后检查，满足时提示一次', async () => {
    mocks.settings.progressCheck = { auto: true, interval: 2, autoAdvance: false };
    mocks.request.mockResolvedValue('{"met": true, "reason": "已找到"}');
    maybeAutoCheckProgress();
    expect(mocks.request).not.toHaveBeenCalled();
    useChat([{ is_user: true, mes: '继续' }, { is_user: false, mes: '第二段' }]);
    maybeAutoCheckProgress();
    expect(mocks.request).not.toHaveBeenCalled();
    useChat([{ is_user: false, mes: '第二段' }, { is_user: false, mes: '第三段' }]);
    maybeAutoCheckProgress();
    await vi.waitFor(() => expect(outlineProgress.met).toBe(true));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0][0]).toContain('「摘要 → 创作规划」');
    expect(mocks.setChapter).not.toHaveBeenCalled();
  });
});

describe('满足推进条件时自动切换阶段（全部本地 mock）', () => {
  beforeEach(() => {
    mocks.settings.progressCheck = { auto: true, interval: 2, autoAdvance: true };
    mocks.request.mockResolvedValue('{"met": true, "reason": "已找到值班簿"}');
  });

  it('自动检查判定满足：切到下一阶段，记下依据并提示一次；换了阶段后不再显示', async () => {
    expect(await checkOutlineProgress({ auto: true })).toBe(true);
    expect(mocks.setChapter).toHaveBeenCalledWith(1);
    expect(outlineProgress.advanced).toEqual({ outlineId: 'o1', from: 0, to: 1, title: '港口', reason: '已找到值班簿', floor: 1 });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0]).toEqual([expect.stringContaining('已自动切换到第 2 阶段「港口」'), 'success']);
    mocks.state.active!.currentChapter = 1; // 模拟存储已切换
    expect(autoAdvanceForCurrentStage()).toMatchObject({ from: 0, to: 1 });
    mocks.state.active!.currentChapter = 0; // 用户又退回
    expect(autoAdvanceForCurrentStage()).toBeNull();
  });

  it('最后一个阶段不自动结束规划，只提示手动结束', async () => {
    mocks.state.active!.currentChapter = 1;
    expect(await checkOutlineProgress({ auto: true })).toBe(true);
    expect(mocks.setChapter).not.toHaveBeenCalled();
    expect(outlineProgress.advanced).toBeNull();
    expect(mocks.toast.mock.calls[0]).toEqual([expect.stringContaining('不会自动结束'), 'info']);
  });

  it('手动检查的结果只作提示，不自动切换', async () => {
    expect(await checkOutlineProgress()).toBe(true);
    expect(mocks.setChapter).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('判定未满足时不切换', async () => {
    mocks.request.mockResolvedValue('{"met": false, "reason": "还没进档案室"}');
    expect(await checkOutlineProgress({ auto: true })).toBe(true);
    expect(mocks.setChapter).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('切换失败时退回为提示，不记自动切换', async () => {
    mocks.setChapter.mockRejectedValue(new Error('存储只读'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkOutlineProgress({ auto: true })).toBe(true);
    expect(outlineProgress.advanced).toBeNull();
    expect(mocks.toast.mock.calls[0]).toEqual([expect.stringContaining('可在「摘要 → 创作规划」中切换阶段'), 'info']);
  });
});

describe('检查材料的范围（全部本地 mock）', () => {
  const turns = (count: number, size = 20) => Array.from({ length: count }, (_, k) => ({ is_user: k % 2 === 0, mes: `第${k + 2}段`.padEnd(size, '文') }));

  it('至少看最近 max(6, 间隔×2) 条；上次检查以来的消息更多时全部带上', () => {
    expect(progressMinMessages(2)).toBe(6); expect(progressMinMessages(10)).toBe(20);
    useChat(turns(20));
    const recent = String(buildProgressContext(mocks.context, active(), { minMessages: 6 })[1].content);
    expect(recent).toContain('第21楼'); expect(recent).toContain('第16楼'); expect(recent).not.toContain('第15楼');
    const since = String(buildProgressContext(mocks.context, active(), { since: 5, minMessages: 6 })[1].content);
    expect(since).toContain('第6楼'); expect(since).not.toContain('第5楼'); expect(since).toContain('第21楼');
  });

  it('原文合计不超过 2 万字；放不下的较早楼层改用逐楼摘要，并注明只作辅助证据', () => {
    const chat = turns(12, 3000).map((m, k) => ({ ...m, extra: { bbs_leaf: { text: `第${k + 2}楼的摘要` } } }));
    useChat(chat);
    const user = String(buildProgressContext(mocks.context, active(), { since: 1, minMessages: 6 })[1].content);
    const original = user.slice(user.indexOf('[本阶段最近的正文'));
    expect(original.length).toBeLessThanOrEqual(PROGRESS_LIMITS.text + 100);
    expect(user).toContain('[较早楼层的逐楼摘要：原文放不下时的压缩记录，只作辅助证据]');
    expect(user).toContain('第2楼摘要：第2楼的摘要');
    expect(user).toContain('第13楼 ');
  });

  it('第二次检查从上次检查时的最后一楼之后开始（仍至少带最近 max(6, 间隔×2) 条）', async () => {
    mocks.request.mockResolvedValue('{"met": false, "reason": "还没到"}');
    useChat(turns(4));
    await checkOutlineProgress();
    useChat(turns(14));
    await checkOutlineProgress();
    const second = String(mocks.request.mock.calls[1][1][1].content);
    expect(second).toContain('第6楼'); expect(second).not.toContain('第5楼 ');
    expect(second).toContain('第15楼');
  });
});

describe('自动检查没有完成时留下说明（全部本地 mock）', () => {
  it('规划 API 没填好时自动检查不发请求，在卡片留下原因；手动检查照常报错', async () => {
    mocks.channelIssue = '请在下方「规划 API 设置」里填写专用 API 的地址和模型';
    expect(await checkOutlineProgress({ auto: true })).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(outlineProgress.autoNote).toContain('自动检查推进条件没有运行');
    expect(outlineProgress.autoNote).toContain('规划 API 设置');
    expect(outlineProgress.error).toBe('');
  });

  it('自动检查请求失败时留下说明，下次检查成功后清除', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.request.mockRejectedValueOnce(new Error('上游原文 sk-secret'));
    expect(await checkOutlineProgress({ auto: true })).toBe(false);
    expect(outlineProgress.autoNote).toContain('自动检查推进条件没有完成');
    expect(outlineProgress.autoNote).not.toContain('sk-secret');
    mocks.request.mockResolvedValueOnce('{"met": false, "reason": "还缺值班簿"}');
    expect(await checkOutlineProgress()).toBe(true);
    expect(outlineProgress.autoNote).toBe('');
  });

  it('关闭自动检查后不再显示旧的说明', () => {
    outlineProgress.autoNote = '旧说明';
    mocks.settings.progressCheck = { auto: false, interval: 2, autoAdvance: false };
    maybeAutoCheckProgress();
    expect(outlineProgress.autoNote).toBe('');
  });
});
