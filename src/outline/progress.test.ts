import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext } from '@/st/context';
import type { OutlineActive } from './types';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  request: vi.fn(),
  toast: vi.fn(),
  state: { active: null as OutlineActive | null },
  settings: { apiMode: 'notes', progressCheck: { auto: false, interval: 2 } },
}));
vi.mock('@/api/client', () => ({ requestCompletion: mocks.request }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/st/toast', () => ({ toast: mocks.toast }));
vi.mock('@/api/settings', () => ({ engineActiveHere: () => true }));
vi.mock('@/memory/engine', () => ({ isAiFloor: (m: { is_user: boolean }) => !m.is_user }));
vi.mock('@/memory/timeTag', () => ({ cleanBody: (s: string) => s }));
vi.mock('./settings', () => ({ outlineSettings: mocks.settings, resolveOutlineChannel: () => ({ url: 'https://x.example/v1', model: 'm' }) }));
vi.mock('./store', () => ({ outlineState: mocks.state, outlineSourceCurrent: () => true, outlineStorageCurrent: () => true }));

import { buildProgressContext, checkOutlineProgress, maybeAutoCheckProgress, outlineProgress, parseProgressReply, progressForCurrentStage } from './progress';

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
  mocks.settings.progressCheck = { auto: false, interval: 2 };
  useChat();
  Object.assign(outlineProgress, { busy: false, outlineId: '', chapter: -1, met: null, reason: '', floor: -1, auto: false, dismissed: false, error: '', errorDetail: '' });
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
    mocks.settings.progressCheck = { auto: true, interval: 2 };
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
  });
});
