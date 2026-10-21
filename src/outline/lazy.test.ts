import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { STContext, STMessage } from '@/st/context';
import type { NoteDecision } from '@/notes/types';
import type { OutlineContent } from './types';
import * as host from '@/st/context';
import * as api from '@/api/settings';
import { requestCompletion } from '@/api/client';
import { fetchWorldInfo } from '@/memory/engine';
import { activeDecisions } from '@/notes/store';
import { hydrateNotesSettings, notesSettings } from '@/notes/settings';
import { hydrateOutlineSettings } from './settings';
import { loadOutline, outlineState } from './store';
import { loadOutlineDiscussion } from './discussionStore';
import { AUTO_OUTLINE_REQUEST, buildOutlineContext } from './context';
import { OUTLINE_RECENT_FLOORS, outlineArrangements, outlineRecentIndices, outlineWorldInfo } from './sources';
import {
  AUTO_OUTLINE_BRIEF, bindOutlineLifecycle, buildOutlineInjection, cancelOutline, generateOutline, generateOutlineAuto,
  outlineRun, unbindOutlineLifecycle,
} from './service';

// 一键生成与规划资料来源:宿主、API、记忆、世界书读取和札记安排都换成可控的替身,大纲模块用真实实现。
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn() }));
vi.mock('@/memory/store', () => ({
  memory: { summaries: [], state: { location: '码头' }, protagonist: {}, npcs: [], items: [], scenes: [], plans: [], lifeDetails: [], vars: {} },
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ selectHistoryNodesBefore: vi.fn(() => []), renderHistoryNodes: vi.fn(() => '') }));
vi.mock('@/memory/engine', () => ({ fetchWorldInfo: vi.fn(async () => '') }));
vi.mock('@/notes/store', async importOriginal => ({
  ...(await importOriginal<typeof import('@/notes/store')>()), activeDecisions: vi.fn(() => []),
}));

const WORLD_HEADING = '[世界书：当前启用的设定条目（常驻条目与最近正文触发的条目）；设定不等于已发生剧情]\n';
const ARRANGEMENT_HEADING = '[双子札记中用户已确认的安排；是写作方向，尚未发生]\n';
const completion = vi.mocked(requestCompletion);
const worldInfo = vi.mocked(fetchWorldInfo);
const decisions = vi.mocked(activeDecisions);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function content(count: number): OutlineContent {
  return {
    title: '旧港的暗流', premise: '围绕码头的走私线索展开', constraints: ['保留用户自主权'],
    chapters: Array.from({ length: count }, (_, i) => ({
      title: `阶段${i + 1}`, goal: `阶段${i + 1}目标`, approach: `阶段${i + 1}发展方式`,
      beats: [`阶段${i + 1}要点`], exitCriteria: `阶段${i + 1}推进条件`,
    })),
  };
}
const reply = (count = 3) => JSON.stringify(content(count));
const decision = (text: string) => ({ id: text, noteId: 'n', questionId: 'q', text, status: 'pending', createdAt: 1 }) as NoteDecision;
function message(mes: string, fields: Partial<STMessage> = {}): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes, swipe_id: 0, ...fields };
}
function context(): STContext {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const names = ['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
    'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT'];
  return {
    chat: [message('去码头看看。', { is_user: true }), message('雾气压着码头，货栈的灯还亮着。')],
    chatMetadata: {}, extensionSettings: {}, name1: '用户', name2: '角色', characterId: '0', groupId: undefined,
    characters: [{ name: '角色', avatar: 'role.png', description: '原有角色设定' }],
    getCurrentChatId: () => 'chat-lazy',
    saveMetadata: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveSettingsDebounced: vi.fn(), saveChat: vi.fn(), setExtensionPrompt: vi.fn(),
    generateRaw: vi.fn().mockRejectedValue(new Error('Forbidden main API fallback')),
    eventTypes: Object.fromEntries(names.map(name => [name, name])),
    eventSource: {
      on: vi.fn((name: string, fn: (...args: any[]) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
      }),
      off: vi.fn((name: string, fn: (...args: any[]) => void) => handlers.get(name)?.delete(fn)),
      emit: (name: string, ...args: any[]) => { handlers.get(name)?.forEach(fn => fn(...args)); },
    },
  } as unknown as STContext;
}
let ctx: STContext;
let engine = ref(true);
const emit = (name: string, ...args: unknown[]) => ctx.eventSource.emit!(name, ...args);
/** 让世界书读取停在半路,用于检验读取期间的取消和失效。 */
async function pausedAtWorldInfo(start: () => Promise<void>) {
  const wait = deferred<string>(); worldInfo.mockReturnValueOnce(wait.promise);
  const task = start();
  await vi.waitFor(() => expect(worldInfo).toHaveBeenCalled());
  expect(outlineRun.busy).toBe(true); expect(outlineRun.status).toBe('正在读取世界书…');
  return { ...wait, task };
}

beforeEach(() => {
  ctx = context(); engine = ref(true);
  vi.spyOn(host, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(api, 'engineActiveHere').mockImplementation(() => engine.value);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Forbidden real network')));
  completion.mockReset().mockResolvedValue(reply());
  worldInfo.mockReset().mockResolvedValue('');
  decisions.mockReset().mockReturnValue([]);
  hydrateNotesSettings(); hydrateOutlineSettings();
  Object.assign(notesSettings.channel, { url: 'https://notes.example.invalid/v1', key: 'mock-secret', model: 'mock-model' });
  loadOutline(); loadOutlineDiscussion(); cancelOutline();
  Object.assign(outlineRun, { busy: false, draft: '', error: '', errorDetail: '', status: '' });
});
afterEach(() => {
  unbindOutlineLifecycle(); cancelOutline();
  expect(fetch).not.toHaveBeenCalled();
  expect(ctx.generateRaw).not.toHaveBeenCalled(); expect(ctx.saveChat).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('一键生成：请求内容', () => {
  it('不需要创作要求，最后一条说明由模型自行规划 3～6 个阶段', () => {
    const result = buildOutlineContext(ctx, '', 'auto');
    const last = result.at(-1)!.content;
    expect(last).toContain('[一键生成：用户没有填写创作要求]'); expect(last).toContain(AUTO_OUTLINE_REQUEST);
    expect(last).toContain('输出 3～6 个规划阶段'); expect(last).not.toContain('严格输出'); expect(last).not.toContain('本次最新用户 input');
    expect(result.map(m => m.role)).toEqual(['system', 'user', 'user', 'user', 'user']);
    expect(() => buildOutlineContext(ctx, '  ', 3)).toThrow('请填写本次大纲需求');
  });

  it('世界书放在角色卡之后、记忆之前，已确认安排放在记忆之后；世界书超出预算时截断并标注', () => {
    const result = buildOutlineContext(ctx, '需求', 2, { worldInfo: '  【旧港】走私者聚集的码头  ', arrangements: '- 下次见面时交还钥匙' });
    expect(result).toHaveLength(7);
    expect(result[1].content).toContain('[角色卡');
    expect(result[2].content).toBe(`${WORLD_HEADING}【旧港】走私者聚集的码头`);
    expect(result[3].content).toContain('[已有历史压缩层');
    expect(result[4].content).toBe(`${ARRANGEMENT_HEADING}- 下次见面时交还钥匙`);
    expect(result[5].content).toContain('[最近正文');
    const long = buildOutlineContext(ctx, '需求', 2, { worldInfo: '设'.repeat(9000) })[2].content;
    expect(long.length).toBe(WORLD_HEADING.length + 6000); expect(long).toContain('[资料按预算截断，未展示部分不可臆造]');
  });

  it('资料为空白时不加消息，消息与不带资料时完全一致', () => {
    expect(buildOutlineContext(ctx, '需求', 2, { worldInfo: ' \n ', arrangements: '' })).toEqual(buildOutlineContext(ctx, '需求', 2));
  });

  it('角色卡有性格和情景时一并带上；只有描述时与以前一致', () => {
    expect(buildOutlineContext(ctx, '需求', 2)[1].content).toBe('[角色卡；设定不等于已发生剧情]\n原有角色设定');
    Object.assign(ctx.characters![0], { personality: '谨慎多疑', scenario: '港口小镇的雨季' });
    const card = buildOutlineContext(ctx, '需求', 2)[1].content;
    expect(card).toContain('原有角色设定\n\n【性格】\n谨慎多疑\n\n【情景】\n港口小镇的雨季');
  });
});

describe('一键生成：资料来源', () => {
  it('最近楼层跳过插件提示楼、番外楼和原生系统楼，被隐藏的旧楼照常算，只取最近八条', () => {
    ctx.chat = Array.from({ length: 10 }, (_, i) => message(`第${i}楼`));
    ctx.chat.push(message('提示', { extra: { bbs_internal_notice: 'backlog' } }), message('番外', { extra: { bbs_omit: true } }),
      message('系统', { is_system: true }), message('隐藏', { is_system: true, extra: { bbs_hidden: true } }));
    expect(outlineRecentIndices(ctx)).toEqual([3, 4, 5, 6, 7, 8, 9, 13]);
    expect(OUTLINE_RECENT_FLOORS).toBe(8);
  });

  it('用最近楼层读取世界书；读取失败或没有聊天时返回空串', async () => {
    worldInfo.mockResolvedValueOnce('  【旧港】条目  ');
    expect(await outlineWorldInfo(ctx)).toBe('【旧港】条目');
    expect(worldInfo).toHaveBeenCalledWith(ctx.chat, outlineRecentIndices(ctx), '用户', '角色');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    worldInfo.mockRejectedValueOnce(new Error('宿主异常'));
    expect(await outlineWorldInfo(ctx)).toBe(''); expect(warn).toHaveBeenCalled();
    expect(await outlineWorldInfo(null)).toBe('');
  });

  it('只带札记中仍生效的已确认安排；札记关闭或读取出错时不带', () => {
    notesSettings.enabled = true;
    decisions.mockReturnValue([decision('  下次见面时\n交还钥匙 '), decision('   ')]);
    expect(outlineArrangements()).toBe('- 下次见面时 交还钥匙');
    notesSettings.enabled = false; expect(outlineArrangements()).toBe('');
    notesSettings.enabled = true; decisions.mockImplementation(() => { throw new Error('札记数据异常'); });
    expect(outlineArrangements()).toBe('');
  });
});

describe('一键生成：生成流程', () => {
  it('读取世界书后生成草稿：请求带世界书，草稿注明一键生成，不自动加入计划', async () => {
    worldInfo.mockResolvedValueOnce('【旧港】走私者聚集的码头');
    await generateOutlineAuto();
    expect(outlineRun.error).toBe(''); expect(completion).toHaveBeenCalledTimes(1);
    const input = completion.mock.calls[0][1];
    expect(input.some(m => m.content === `${WORLD_HEADING}【旧港】走私者聚集的码头`)).toBe(true);
    expect(input.at(-1)!.content).toContain('[一键生成：用户没有填写创作要求]');
    expect(outlineState.draft?.brief).toBe(AUTO_OUTLINE_BRIEF); expect(outlineState.draft?.content.chapters).toHaveLength(3);
    expect(outlineState.active).toBeNull(); expect(buildOutlineInjection()).toBe('');
    expect(outlineRun.status).toContain('草稿已保存'); expect(outlineRun.busy).toBe(false);
  });

  it('一键生成接受模型给出的任意合法阶段数；指定阶段数时仍须一致', async () => {
    completion.mockResolvedValueOnce(reply(2));
    await generateOutlineAuto();
    expect(outlineRun.error).toBe(''); expect(outlineState.draft?.content.chapters).toHaveLength(2);
    completion.mockResolvedValueOnce(reply(2));
    await generateOutline('指定三个阶段', 3);
    expect(outlineRun.error).toContain('阶段数不对'); expect(outlineState.draft?.brief).toBe(AUTO_OUTLINE_BRIEF);
  });

  it('读取世界书期间取消：不等读取结束，不发请求，草稿和规划都不变', async () => {
    const paused = await pausedAtWorldInfo(generateOutlineAuto);
    cancelOutline(); await paused.task;
    expect(completion).not.toHaveBeenCalled(); expect(outlineRun.busy).toBe(false);
    expect(outlineRun.status).toContain('已取消生成');
    paused.resolve('【旧港】条目'); await Promise.resolve();
    expect(completion).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });

  it('读取世界书期间正文被修改：读完后不发请求，并说明原因', async () => {
    const paused = await pausedAtWorldInfo(generateOutlineAuto);
    ctx.chat[1].mes += '（正文改动）'; paused.resolve(''); await paused.task;
    expect(completion).not.toHaveBeenCalled(); expect(outlineRun.busy).toBe(false);
    expect(outlineRun.status).toBe('正文、聊天或大纲已经变化，这次没有生成。'); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });

  it.each(['edit', 'generation'] as const)('绑定生命周期时，读取世界书期间的 %s 事件立即取消', async mode => {
    bindOutlineLifecycle();
    const paused = await pausedAtWorldInfo(generateOutlineAuto);
    if (mode === 'edit') { ctx.chat[1].mes += '（正文改动）'; emit('MESSAGE_EDITED'); }
    else emit('GENERATION_STARTED', 'normal', {}, false);
    expect(outlineRun.busy).toBe(false);
    paused.resolve(''); await paused.task;
    expect(completion).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });

  it('世界书读取失败时照常生成，只是不带世界书资料', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    worldInfo.mockRejectedValueOnce(new Error('宿主异常'));
    await generateOutlineAuto();
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][1].some(m => m.content.startsWith('[世界书'))).toBe(false);
    expect(outlineRun.error).toBe(''); expect(outlineState.draft).not.toBeNull();
  });

  it('填写要求的普通生成同样附带世界书和已确认安排', async () => {
    worldInfo.mockResolvedValueOnce('【旧港】走私者聚集的码头');
    notesSettings.enabled = true; decisions.mockReturnValue([decision('交还钥匙')]);
    completion.mockResolvedValueOnce(reply(2));
    await generateOutline('追查走私线索', 2);
    const input = completion.mock.calls[0][1];
    expect(input.some(m => m.content.startsWith('[世界书'))).toBe(true);
    expect(input.some(m => m.content === `${ARRANGEMENT_HEADING}- 交还钥匙`)).toBe(true);
    expect(input.at(-1)!.content).toContain('追查走私线索'); expect(outlineState.draft?.brief).toBe('追查走私线索');
  });

  it('未启用宝书或正在生成时，不读取世界书也不发请求', async () => {
    engine.value = false;
    await generateOutlineAuto();
    expect(outlineRun.error).toContain('没有启用棱镜宝书');
    engine.value = true;
    const paused = await pausedAtWorldInfo(generateOutlineAuto);
    await generateOutlineAuto();
    expect(worldInfo).toHaveBeenCalledTimes(1);
    paused.resolve(''); await paused.task;
    expect(completion).toHaveBeenCalledTimes(1);
  });
});
