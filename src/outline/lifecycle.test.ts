import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { STContext, STMessage } from '@/st/context';
import type { OutlineContent, OutlineData, OutlineDraft } from './types';
import * as host from '@/st/context';
import * as api from '@/api/settings';
import { requestCompletion } from '@/api/client';
import { memory } from '@/memory/store';
import { cleanBody, writeItemLogTag, writeVarLogTag } from '@/memory/timeTag';
import { hydrateNotesSettings, notesSettings } from '@/notes/settings';
import { sourceHash } from '@/notes/source';
import { hydrateOutlineSettings, outlineSettings } from './settings';
import { captureOutlineSource, outlineInputUnchanged, sameOutlineChat } from './source';
import { discussionState, loadOutlineDiscussion, DISCUSSION_DATA_KEY, clearOutlineDiscussion } from './discussionStore';
import { buildDiscussionContext, recentDiscussion, discussionReply } from './discussionContext';
import {
  OUTLINE_DATA_KEY, outlineState, loadOutline, outlineStorageCurrent, outlineSourceCurrent,
  saveOutlineDraft, activateOutlineDraft, setOutlineChapter, setOutlineEnabled,
  reconfirmOutline, commitGeneratedOutline,
} from './store';
import {
  OUTLINE_INJECT_KEY, outlineRun, generateOutline, cancelOutline,
  buildOutlineInjection, refreshOutlineInjection, bindOutlineLifecycle, unbindOutlineLifecycle,
  sendOutlineDiscussion, cancelOutlineDiscussion, discussionRun, captureOutlineRefinement,
} from './service';

// 仅替换宿主/API/记忆边界。大纲全部模块、札记 source 与正文清洗均用真实实现。
// 即使有人错误接入正文渠道，也会由 afterEach 的网络/宿主调用断言拦截。
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn() }));
vi.mock('@/memory/store', () => ({
  memory: {
    summaries: [{ id: 'existing-leaf', kind: 'leaf', level: 0, text: '已发生摘要' }],
    state: { location: '房间' }, protagonist: {}, npcs: [], items: [], scenes: [],
    plans: [{ id: 'original-plan', text: '正文派生的原安排' }], lifeDetails: [], vars: {},
  },
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ selectHistoryNodesBefore: vi.fn(() => []), renderHistoryNodes: vi.fn(() => '') }));

const completion = vi.mocked(requestCompletion);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function content(title = '独立创作规划'): OutlineContent {
  return {
    title, premise: '依据真实正文探索后续可能', constraints: ['全局约束：保留用户自主权'],
    chapters: [
      { title: '阶段一独有标题', goal: '阶段一独有目标', approach: '阶段一独有发展方式',
        beats: ['阶段一独有要点甲', '阶段一独有要点乙'], exitCriteria: '阶段一由用户核对的条件' },
      { title: '未来阶段秘密标题', goal: '未来阶段秘密目标', approach: '未来阶段秘密发展方式',
        beats: ['未来阶段秘密要点'], exitCriteria: '未来阶段秘密条件' },
    ],
  };
}
const reply = (title?: string) => JSON.stringify(content(title));
function message(mes: string, fields: Partial<STMessage> = {}): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes, swipe_id: 0, ...fields };
}
const contexts: STContext[] = [];
function context(id = 'chat-a'): STContext {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const names = ['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
    'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT'];
  const result = {
    chat: [message('请慢慢推进故事。', { is_user: true }), message('她走进房间。', {
      extra: { bbs_leaf: { id: 'leaf-1', text: '原摘要', createdAt: 123, v: 1, swipe: 0, delta: {} } },
    })],
    chatMetadata: { unrelated: { untouched: true }, prism_book_notes: { version: 1, records: [], decisions: [] } },
    extensionSettings: {}, name1: '用户', name2: '角色', characterId: '0', groupId: undefined,
    characters: [{ name: '角色', avatar: 'role.png', description: '原有角色设定' }],
    getCurrentChatId: () => id,
    saveMetadata: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveSettingsDebounced: vi.fn(), saveChat: vi.fn(), setExtensionPrompt: vi.fn(),
    generateRaw: vi.fn().mockRejectedValue(new Error('Forbidden main API fallback')),
    ConnectionManagerRequestService: { sendRequest: vi.fn().mockRejectedValue(new Error('Forbidden profile fallback')) },
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
  contexts.push(result);
  return result;
}
let ctx: STContext;
let current: STContext;
let engine = ref(true);
let memoryBefore: unknown;
const emit = (name: string, ...args: unknown[]) => ctx.eventSource.emit!(name, ...args);
const saved = () => ctx.chatMetadata[OUTLINE_DATA_KEY] as OutlineData;
const latestInjection = (target = current) => vi.mocked(target.setExtensionPrompt!).mock.calls
  .filter(call => call[0] === OUTLINE_INJECT_KEY).at(-1)?.[1];
async function draft(title?: string) {
  await saveOutlineDraft(content(title), '创作要求', outlineState.revision);
  return copy(outlineState.draft!);
}
async function active() {
  const d = await draft(); await activateOutlineDraft(d.id); return copy(outlineState.active!);
}
function generatedDraft(): OutlineDraft {
  return { id: 'generated-test', createdAt: 123, sourceFloor: ctx.chat.length - 1,
    sourceHash: sourceHash(ctx, ctx.chat.length - 1), brief: '要求', content: content() };
}
function pendingRequest() {
  const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
  const task = generateOutline('新的创作要求', 2);
  expect(outlineRun.busy).toBe(true);
  expect(completion).toHaveBeenCalled();
  const options = completion.mock.calls.at(-1)![2]!;
  return { ...wait, task, options };
}

beforeEach(() => {
  contexts.length = 0; ctx = context(); current = ctx; engine = ref(true);
  vi.spyOn(host, 'getContext').mockImplementation(() => current);
  vi.spyOn(api, 'engineActiveHere').mockImplementation(() => engine.value);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Forbidden real network')));
  completion.mockReset().mockResolvedValue(reply());
  hydrateNotesSettings(); hydrateOutlineSettings();
  Object.assign(notesSettings.channel, { url: 'https://notes.example.invalid/v1', key: 'mock-secret', model: 'mock-model' });
  loadOutline(); loadOutlineDiscussion(); cancelOutline(); cancelOutlineDiscussion();
  Object.assign(outlineRun, { busy: false, draft: '', error: '', status: '' });
  Object.assign(discussionRun, { busy: false, error: '', status: '' });
  memoryBefore = copy(memory);
});
afterEach(async () => {
  unbindOutlineLifecycle(); cancelOutline(); cancelOutlineDiscussion(); await nextTick();
  expect(fetch).not.toHaveBeenCalled();
  expect(memory).toEqual(memoryBefore);
  for (const c of contexts) {
    expect(c.generateRaw).not.toHaveBeenCalled();
    expect(c.ConnectionManagerRequestService!.sendRequest).not.toHaveBeenCalled();
    expect(c.saveChat).not.toHaveBeenCalled();
    expect(c.saveMetadataDebounced).not.toHaveBeenCalled();
  }
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('大纲双向讨论与显式修订', () => {
  it('讨论只保存独立问答，可多轮交谈，不能自动改草稿、已确认规划或正文', async () => {
    await active(); const before = copy(saved()), chat = copy(ctx.chat), injection = buildOutlineInjection();
    completion.mockResolvedValueOnce('<think>不应显示</think>可以让角色先核实消息，不必立即同意。');
    expect(await sendOutlineDiscussion('这里是否过于配合？', 'active')).toBe(true);
    expect(discussionState.messages).toEqual([
      { role: 'user', content: '这里是否过于配合？' }, { role: 'assistant', content: '可以让角色先核实消息，不必立即同意。' },
    ]);
    expect(ctx.chatMetadata[DISCUSSION_DATA_KEY]).toBeDefined();
    expect(saved()).toEqual(before); expect(ctx.chat).toEqual(chat); expect(buildOutlineInjection()).toBe(injection);
    const firstInput = completion.mock.calls[0][1];
    expect(firstInput[0].content).toContain('角色的活人感');
    expect(firstInput[0].content).not.toContain('只输出一个 JSON');
    expect(firstInput.some(m => m.content.includes('阶段一独有目标'))).toBe(true);
    expect(firstInput.at(-1)!.content).toBe('这里是否过于配合？');
    completion.mockResolvedValueOnce('也可以暂缓答复，取决于她已有的顾虑。');
    expect(await sendOutlineDiscussion('能否再慢一点？', 'active')).toBe(true);
    expect(completion.mock.calls[1][1]).toContainEqual({ role: 'assistant', content: '可以让角色先核实消息，不必立即同意。' });
    expect(discussionState.messages).toHaveLength(4);
    expect(saved()).toEqual(before);
  });
  it('按讨论显式生成仅替换草稿，模型建议不当作用户已采纳，原启用版本不变', async () => {
    await active(); const oldActive = copy(outlineState.active);
    completion.mockResolvedValueOnce('建议先核实消息。');
    await sendOutlineDiscussion('修改节奏，但保留关系状态', 'active');
    const reference = captureOutlineRefinement('active');
    completion.mockResolvedValueOnce(reply('讨论后草稿'));
    await generateOutline('按讨论修订，以用户最新明确意见为准', 2, reference);
    expect(outlineRun.error).toBe('');
    expect(outlineState.draft!.content.title).toBe('讨论后草稿');
    expect(outlineState.active).toEqual(oldActive);
    const input = completion.mock.calls[1][1];
    expect(input[0].content).toContain('只输出一个 JSON');
    expect(input.some(m => m.content.includes('修改节奏，但保留关系状态'))).toBe(true);
    expect(input.at(-1)!.content).toContain('严格输出 2 个规划阶段');
    expect(completion).toHaveBeenCalledTimes(2);
  });
  it.each(['cancel', 'history', 'switch', 'outline', 'metadata'])('讨论响应迟到时不写入：%s', async mode => {
    await active(); const before = copy(ctx.chatMetadata);
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const task = sendOutlineDiscussion('意见', 'active');
    if (mode === 'cancel') cancelOutlineDiscussion();
    if (mode === 'history') ctx.chat[1].mes += '剧情改变';
    if (mode === 'switch') { current = context('other-discussion'); loadOutline(); loadOutlineDiscussion(); }
    if (mode === 'outline') outlineState.revision++;
    if (mode === 'metadata') ctx.chatMetadata[OUTLINE_DATA_KEY] = { external: true };
    wait.resolve('迟到的回复'); expect(await task).toBe(false);
    expect(ctx.chatMetadata[DISCUSSION_DATA_KEY]).toEqual(before[DISCUSSION_DATA_KEY]);
    expect(discussionState.messages).toHaveLength(0);
  });
  it('错误响应不回显上游秘密，不自动重试，保存失败保留旧问答', async () => {
    completion.mockRejectedValueOnce(new Error('PRIVATE_UPSTREAM'));
    expect(await sendOutlineDiscussion('问题', 'none')).toBe(false);
    expect(discussionRun.error).not.toContain('PRIVATE');
    expect(completion).toHaveBeenCalledTimes(1); expect(discussionState.messages).toHaveLength(0);
    completion.mockResolvedValueOnce('建议');
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('PRIVATE_STORE'));
    expect(await sendOutlineDiscussion('问题', 'none')).toBe(false);
    expect(discussionRun.error).not.toContain('PRIVATE');
    expect(discussionState.messages).toHaveLength(0);
  });
  it('讨论与生成互斥，正文开始取消讨论，无法回退正文API', async () => {
    bindOutlineLifecycle();
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const task = sendOutlineDiscussion('慢一点', 'none');
    await generateOutline('不应并发生成', 2);
    expect(completion).toHaveBeenCalledTimes(1);
    emit('GENERATION_STARTED', 'normal', {}, false);
    expect(completion.mock.calls[0][2]!.signal!.aborted).toBe(true);
    wait.resolve('迟到'); expect(await task).toBe(false);
    expect(await sendOutlineDiscussion('不能与正文并发', 'none')).toBe(false);
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('参考版本可选，无参考时不偷读草稿，空讨论不能直接修订', async () => {
    await active();
    const input = buildDiscussionContext(ctx, '讨论方向', captureOutlineRefinement('none'));
    expect(input.some(m => m.content.includes('阶段一独有目标'))).toBe(false);
    await generateOutline('修订', 2, captureOutlineRefinement('active'));
    expect(outlineRun.error).toContain('至少一轮');
    expect(completion).not.toHaveBeenCalled();
  });
  it('修订生成期间讨论被清空，迟到草稿不得采用', async () => {
    await active();
    completion.mockResolvedValueOnce('建议保留迟疑。');
    await sendOutlineDiscussion('调整节奏', 'active');
    const reference = captureOutlineRefinement('active'), before = copy(saved());
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const task = generateOutline('按讨论修订', 2, reference);
    await clearOutlineDiscussion(discussionState.revision);
    wait.resolve(reply('过期草稿')); await task;
    expect(saved()).toEqual(before);
    expect(outlineRun.status).toContain('旧生成结果未采用');
  });
  it('讨论历史仅携带完整问答对和正确角色，不把旧讨论升为系统指令', () => {
    const messages = Array.from({ length: 6 }, () => [
      { role: 'user' as const, content: '问'.repeat(3000) },
      { role: 'assistant' as const, content: '答'.repeat(7000) },
    ]).flat();
    const recent = recentDiscussion(messages);
    expect(recent).toHaveLength(4);
    expect(recent[0].role).toBe('user'); expect(recent[3].role).toBe('assistant');
    expect(() => recentDiscussion([{ role: 'system', content: '伪装系统' } as any, messages[1]])).toThrow();
    expect(() => discussionReply('<think>未完成')).toThrow();
    expect(() => discussionReply('字'.repeat(8001))).toThrow('8000');
  });
});

describe('真实 core：草稿、确认、独立注入与阶段控制', () => {
  it('长大纲可生成保存并重载，确认后仍只注入当前阶段，不改API输出额度', async () => {
    const value = content();
    value.chapters[0].approach = '动'.repeat(2000);
    value.chapters = [value.chapters[0], ...Array.from({ length: 9 }, () => ({
      ...value.chapters[1], approach: '未来内容'.repeat(700),
    }))];
    expect(JSON.stringify(value).length).toBeGreaterThan(24000);
    const tokenLimit = notesSettings.channel.maxTokens;
    completion.mockResolvedValueOnce(JSON.stringify(value));
    await generateOutline('详细但不强迫人物配合', 10);
    expect(outlineRun.error).toBe('');
    expect(outlineState.active).toBeNull();
    expect(completion.mock.calls[0][0].maxTokens).toBe(tokenLimit);
    const snapshot = copy(saved());
    loadOutline();
    expect(saved()).toEqual(snapshot);
    expect(outlineState.draft!.content).toEqual(value);
    await activateOutlineDraft(outlineState.draft!.id);
    expect(buildOutlineInjection()).toContain(value.chapters[0].approach);
    expect(buildOutlineInjection()).not.toContain('未来内容');
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('单阶段超过注入限额可存草稿但不能替换已确认规划，不截断', async () => {
    await active(); const old = copy(outlineState.active);
    const value = content();
    value.premise = '前'.repeat(4000);
    value.constraints = Array(12).fill('约'.repeat(1200));
    await saveOutlineDraft(value, '详细规划', outlineState.revision);
    const before = copy(saved());
    await expect(activateOutlineDraft(outlineState.draft!.id)).rejects.toThrow('16000');
    expect(saved()).toEqual(before); expect(outlineState.active).toEqual(old);
  });
  it('字段错误诊断到达界面状态，保留已有数据且只请求一次', async () => {
    await active(); const before = copy(saved());
    const value = content(); value.chapters[1].approach = '密'.repeat(3201);
    completion.mockResolvedValueOnce(JSON.stringify(value));
    await generateOutline('生成', 2);
    expect(outlineRun.error).toContain('chapters[1].approach 超过3200');
    expect(outlineRun.error).not.toContain('密');
    expect(saved()).toEqual(before); expect(completion).toHaveBeenCalledTimes(1);
  });
  it('API 草稿不会激活，只有确认保存成功才向宿主注入非空指引', async () => {
    bindOutlineLifecycle();
    const chat = copy(ctx.chat), metadata = copy(ctx.chatMetadata);
    const notes = ctx.chatMetadata.prism_book_notes, leaf = ctx.chat[1].extra!.bbs_leaf;
    await generateOutline('用户最新 input', 2);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0]).toMatchObject({ model: 'mock-model' });
    expect(JSON.stringify(completion.mock.calls[0][1])).toContain('用户最新 input');
    expect(outlineRun.error).toBe(''); expect(outlineState.draft?.content).toEqual(content());
    expect(outlineState.active).toBeNull(); expect(saved().active).toBeNull();
    expect(vi.mocked(ctx.setExtensionPrompt!).mock.calls.every(c => c[1] === '')).toBe(true);
    await activateOutlineDraft(outlineState.draft!.id);
    expect(latestInjection()).toBe(buildOutlineInjection()); expect(latestInjection()).not.toBe('');
    expect(ctx.setExtensionPrompt).toHaveBeenLastCalledWith(OUTLINE_INJECT_KEY, buildOutlineInjection(), 1, 0, false, 0);
    expect(ctx.chat).toEqual(chat); expect(ctx.chat[1].extra!.bbs_leaf).toBe(leaf);
    expect(ctx.chatMetadata.prism_book_notes).toBe(notes);
    const { [OUTLINE_DATA_KEY]: _outline, ...untouched } = ctx.chatMetadata;
    expect(untouched).toEqual(metadata); expect(Object.keys(saved()).sort()).toEqual(['active', 'draft', 'version']);
    expect(saved()).not.toHaveProperty('plans');
  });

  it('只注入当前阶段 goal/approach/beats/条件及全局约束，不泄漏未来阶段', async () => {
    await active();
    const text = buildOutlineInjection(), data = content();
    for (const value of [data.title, data.premise, ...data.constraints,
      data.chapters[0].title, data.chapters[0].goal, data.chapters[0].approach,
      ...data.chapters[0].beats, data.chapters[0].exitCriteria]) expect(text).toContain(value);
    for (const value of Object.values(data.chapters[1]).flat()) expect(text).not.toContain(value);
    expect(text).toContain('不是已发生事实'); expect(text).toContain('不得自行宣告');
    expect(text).toContain('不得替用户角色'); expect(text).toContain('用户本轮明确要求与已发生事实优先');
  });

  it('独立 API 模式只使用专用渠道，不改札记配置、不走正文或摘要回退', async () => {
    outlineSettings.apiMode = 'independent';
    Object.assign(outlineSettings.channel, { url: 'https://outline.example.invalid/v1', key: 'outline-secret', model: 'outline-model' });
    const notes = copy(notesSettings);
    await generateOutline('专用渠道创作要求', 2);
    expect(outlineRun.error).toBe(''); expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0][0]).toMatchObject({ url: 'https://outline.example.invalid/v1', model: 'outline-model' });
    expect(notesSettings).toEqual(notes); expect(outlineState.active).toBeNull();
  });

  it('手工切阶段仅切指引，结束与暂停撤下注入，不改正文、leaf、札记和 memory.plans', async () => {
    bindOutlineLifecycle(); await active();
    const chat = copy(ctx.chat), notes = copy(ctx.chatMetadata.prism_book_notes);
    await setOutlineChapter(1);
    expect(latestInjection()).toContain('未来阶段秘密目标'); expect(latestInjection()).not.toContain('阶段一独有目标');
    await setOutlineEnabled(false); expect(latestInjection()).toBe('');
    await setOutlineEnabled(true); expect(latestInjection()).toContain('未来阶段秘密目标');
    await setOutlineChapter(2); expect(latestInjection()).toBe(''); expect(saved().active?.enabled).toBe(false);
    await expect(setOutlineEnabled(true)).rejects.toThrow('结束');
    await setOutlineChapter(0); expect(latestInjection()).toBe('');
    await setOutlineEnabled(true); expect(latestInjection()).toContain('阶段一独有目标');
    expect(ctx.chat).toEqual(chat); expect(ctx.chatMetadata.prism_book_notes).toEqual(notes);
  });

  it('重新生成仅替换草稿，保留已确认版本及阶段；过期草稿 id 无权激活', async () => {
    bindOutlineLifecycle(); const old = await active(); await setOutlineChapter(1);
    const before = copy(outlineState.active), injection = buildOutlineInjection();
    completion.mockResolvedValueOnce(reply('全新草稿标题'));
    await generateOutline('重新规划', 2);
    expect(outlineState.draft?.id).not.toBe(old.id); expect(outlineState.draft?.content.title).toBe('全新草稿标题');
    expect(outlineState.active).toEqual(before); expect(saved().active).toEqual(before);
    expect(latestInjection()).toBe(injection);
    await expect(activateOutlineDraft(old.id)).rejects.toThrow('草稿已改变');
    expect(outlineState.active).toEqual(before);
  });

  it('重复 activate 同一草稿不会追加第二份 active、阶段或重复指引', async () => {
    bindOutlineLifecycle(); const d = await draft();
    await activateOutlineDraft(d.id); const first = copy(saved()); const injection = latestInjection();
    await activateOutlineDraft(d.id);
    expect(saved()).toEqual(first); expect(saved().active?.content.chapters).toHaveLength(2);
    expect(latestInjection()).toBe(injection);
    expect(latestInjection()!.split('阶段一独有目标')).toHaveLength(2);
  });

  it.each([-1, 3, 0.5, NaN])('非法阶段 %s 不保存或改变已激活状态', async index => {
    await active(); const before = copy(saved()), calls = vi.mocked(ctx.saveMetadata).mock.calls.length;
    await expect(setOutlineChapter(index)).rejects.toThrow();
    expect(saved()).toEqual(before); expect(ctx.saveMetadata).toHaveBeenCalledTimes(calls);
  });

  it('approach 缺失的模型回复被拒绝，原 active/draft 不变', async () => {
    await active(); const before = copy(saved()), bad = copy(content()) as any;
    delete bad.chapters[0].approach; completion.mockResolvedValueOnce(JSON.stringify(bad));
    await generateOutline('重生成', 2);
    expect(outlineRun.error).not.toBe(''); expect(saved()).toEqual(before);
  });
});

describe('真实 store：保存事务、只读和并发版本保护', () => {
  it('首次保存失败移除临时 metadata；重试仍可成功', async () => {
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('disk full'));
    await expect(draft()).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata).not.toHaveProperty(OUTLINE_DATA_KEY); expect(outlineState.draft).toBeNull();
    expect(outlineState.saving).toBe(false); await draft(); expect(saved().draft).not.toBeNull();
  });

  it('完整生成链保存失败保留原 active/draft，显式重试成功，不自动重复请求', async () => {
    bindOutlineLifecycle(); await active(); const before = ctx.chatMetadata[OUTLINE_DATA_KEY];
    const state = copy(saved()), injection = buildOutlineInjection();
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('disk error private-secret'));
    await generateOutline('重新规划', 2);
    expect(outlineRun.error).toContain('保存失败'); expect(outlineRun.error).not.toContain('private-secret');
    expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(before); expect(saved()).toEqual(state);
    expect(outlineRun.busy).toBe(false); expect(latestInjection()).toBe(injection);
    expect(completion).toHaveBeenCalledTimes(1);
    completion.mockResolvedValueOnce(reply('重试成功'));
    await generateOutline('手工重试', 2);
    expect(outlineRun.error).toBe(''); expect(saved().draft?.content.title).toBe('重试成功');
    expect(saved().active).toEqual(state.active); expect(latestInjection()).toBe(injection);
  });

  it('activate 保存中不得提前注入；失败恢复原引用和 active，随后重试可启用', async () => {
    bindOutlineLifecycle(); await active(); const d = await draft('新草稿');
    const before = ctx.chatMetadata[OUTLINE_DATA_KEY], old = copy(outlineState.active), injection = buildOutlineInjection();
    const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = activateOutlineDraft(d.id);
    expect(outlineState.saving).toBe(true); expect(latestInjection()).toBe(''); expect(outlineState.active).toEqual(old);
    wait.reject(new Error('disk failure with secret')); await expect(task).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(before); expect(outlineState.active).toEqual(old);
    expect(latestInjection()).toBe(injection); expect(outlineState.issue).not.toContain('secret');
    await activateOutlineDraft(d.id); expect(latestInjection()).toContain('新草稿'); expect(outlineState.issue).toBe('');
  });

  it.each(['pause', 'chapter', 'reconfirm'] as const)('%s 保存失败不提交内存状态和 metadata', async operation => {
    await active(); const before = ctx.chatMetadata[OUTLINE_DATA_KEY], state = copy(outlineState.active);
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('failed'));
    const task = operation === 'pause' ? setOutlineEnabled(false) : operation === 'chapter' ? setOutlineChapter(1) : reconfirmOutline();
    await expect(task).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(before); expect(outlineState.active).toEqual(state);
  });

  it.each([{ version: 99, private: 'opaque' }, { version: 1, draft: {}, active: null }, [], 'corrupt'])
  ('未知格式只读，所有写入口和生成均不能覆盖：%j', async raw => {
    ctx.chatMetadata[OUTLINE_DATA_KEY] = raw; loadOutline();
    expect(outlineState.issue).toContain('只读保护'); expect(buildOutlineInjection()).toBe('');
    for (const write of [() => draft(), () => activateOutlineDraft('any'), () => setOutlineEnabled(true),
      () => setOutlineChapter(0), () => reconfirmOutline(), () => commitGeneratedOutline(generatedDraft(), outlineState.revision)]) {
      await expect(write()).rejects.toThrow('只读保护');
    }
    await generateOutline('新要求', 2);
    expect(completion).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(raw);
  });

  it('旧 revision 的手工保存和模型提交都拒绝；并发返回不覆盖用户新草稿', async () => {
    const revision = outlineState.revision, generated = generatedDraft(); const pending = pendingRequest();
    const newer = await draft('用户最新编辑');
    await expect(saveOutlineDraft(content(), '旧编辑', revision)).rejects.toThrow('版本已变化');
    await expect(commitGeneratedOutline(generated, revision)).rejects.toThrow('已经变化');
    pending.resolve(reply('迟到草稿')); await pending.task;
    expect(outlineState.draft).toEqual(newer); expect(saved().draft).toEqual(newer);
    expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
  });

  it.each(['replace', 'mutate'] as const)('外部 metadata %s 后停止旧注入，不覆盖外部版本并重新载入', async mode => {
    await active(); const external = copy(saved()); external.active!.content.title = '外部更新';
    if (mode === 'replace') ctx.chatMetadata[OUTLINE_DATA_KEY] = external;
    else saved().active!.content.title = '外部更新';
    const raw = ctx.chatMetadata[OUTLINE_DATA_KEY]; const calls = vi.mocked(ctx.saveMetadata).mock.calls.length;
    expect(outlineStorageCurrent()).toBe(false); expect(buildOutlineInjection()).toBe('');
    refreshOutlineInjection(); expect(latestInjection()).toBe('');
    await expect(setOutlineChapter(1)).rejects.toThrow('其它操作中改变');
    expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(raw); expect(outlineState.active?.content.title).toBe('外部更新');
    expect(ctx.saveMetadata).toHaveBeenCalledTimes(calls);
  });

  it('模型等待期间外部 metadata 变化，即使 revision 未变也拒绝旧回复', async () => {
    const pending = pendingRequest(); const external = { version: 99, opaque: '不可覆盖' };
    ctx.chatMetadata[OUTLINE_DATA_KEY] = external;
    pending.resolve(reply()); await pending.task;
    expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(external); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(outlineState.issue).toContain('只读保护');
  });

  it.each(['resolve', 'reject'] as const)('保存期间外部更新，原保存 %s 也不得覆盖/回滚外部值', async outcome => {
    const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = draft(); await expect(draft('并发')).rejects.toThrow('正在保存');
    const external = { version: 99, opaque: '最新值' }; ctx.chatMetadata[OUTLINE_DATA_KEY] = external;
    if (outcome === 'resolve') wait.resolve(); else wait.reject(new Error('failed'));
    await expect(task).rejects.toThrow(); expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(external);
    expect(outlineState.saving).toBe(false); expect(buildOutlineInjection()).toBe('');
  });

  it('保存期间原地篡改自己写入的对象也被 fingerprint 检出', async () => {
    const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = draft(); saved().draft!.content.title = '外部原地修改'; wait.resolve();
    await expect(task).rejects.toThrow('其它操作修改'); expect(saved().draft!.content.title).toBe('外部原地修改');
    expect(outlineState.draft?.content.title).toBe('外部原地修改');
  });

  it.each(['replacement-context', 'mutable-context'] as const)('保存中切聊 %s 不提交到新聊天', async mode => {
    bindOutlineLifecycle(); const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const oldMetadata = ctx.chatMetadata, task = draft(); const next = context('chat-b');
    if (mode === 'mutable-context') {
      Object.assign(ctx, { chat: next.chat, chatMetadata: next.chatMetadata, getCurrentChatId: next.getCurrentChatId });
    } else current = next;
    emit('CHAT_CHANGED'); wait.resolve(); await expect(task).rejects.toThrow('聊天已切换');
    expect(current.chatMetadata).not.toHaveProperty(OUTLINE_DATA_KEY); expect(outlineState.draft).toBeNull();
    expect(oldMetadata).toHaveProperty(OUTLINE_DATA_KEY); expect(buildOutlineInjection()).toBe('');
  });

  it.each(['replacement-context', 'mutable-context'] as const)('保存失败且切聊 %s 只回滚捕获的旧 metadata', async mode => {
    bindOutlineLifecycle(); await active();
    const oldMetadata = ctx.chatMetadata, previous = oldMetadata[OUTLINE_DATA_KEY];
    const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = draft('保存中的新草稿'); const next = context('chat-b');
    if (mode === 'mutable-context') {
      Object.assign(ctx, { chat: next.chat, chatMetadata: next.chatMetadata, getCurrentChatId: next.getCurrentChatId });
    } else current = next;
    emit('CHAT_CHANGED'); const newMetadata = copy(current.chatMetadata);
    wait.reject(new Error('旧 chat 保存失败')); await expect(task).rejects.toThrow('聊天已切换');
    expect(oldMetadata[OUTLINE_DATA_KEY]).toBe(previous); expect(current.chatMetadata).toEqual(newMetadata);
    expect(outlineState.draft).toBeNull(); expect(outlineState.active).toBeNull(); expect(outlineState.issue).toBe('');
    expect(outlineState.saving).toBe(false); expect(buildOutlineInjection()).toBe('');
  });

  it.each(['circular', 'bigint'] as const)('不可序列化的 %s metadata 不崩溃并只读保护，不能静默丢字段', async mode => {
    const raw: Record<string, unknown> = { version: 1, draft: null, active: null };
    raw.opaque = mode === 'circular' ? raw : 1n;
    ctx.chatMetadata[OUTLINE_DATA_KEY] = raw;
    expect(() => loadOutline()).not.toThrow();
    expect(outlineState.issue).toContain('只读保护'); expect(outlineStorageCurrent()).toBe(false);
    await expect(draft()).rejects.toThrow(); expect(ctx.chatMetadata[OUTLINE_DATA_KEY]).toBe(raw);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
});

describe('真实 source 与消息事件：历史失效、重新确认、托管旁注', () => {
  it.each(['earlier-edit', 'body-edit', 'swipe', 'delete'] as const)('%s 撤下注入，不能切章/开关绕过，reconfirm 才恢复', async mode => {
    bindOutlineLifecycle(); const old = await active();
    if (mode === 'earlier-edit') ctx.chat[0].mes += '改变原用户约束';
    if (mode === 'body-edit') ctx.chat[1].mes += '改变真实正文';
    if (mode === 'swipe') ctx.chat[1].swipe_id = 1;
    if (mode === 'delete') ctx.chat.splice(1, 1);
    emit(mode === 'swipe' ? 'MESSAGE_SWIPED' : mode === 'delete' ? 'MESSAGE_DELETED' : 'MESSAGE_EDITED');
    expect(outlineSourceCurrent(old)).toBe(false); expect(latestInjection()).toBe('');
    await expect(activateOutlineDraft(old.id)).rejects.toThrow('历史正文已变化');
    await expect(setOutlineEnabled(true)).rejects.toThrow('参考正文已变化');
    await setOutlineChapter(1); expect(latestInjection()).toBe(''); expect(outlineState.active?.enabled).toBe(false);
    const chat = copy(ctx.chat); await reconfirmOutline();
    expect(outlineSourceCurrent(outlineState.active!)).toBe(true); expect(latestInjection()).toContain('未来阶段秘密目标');
    expect(ctx.chat).toEqual(chat); expect(saved().active?.sourceFloor).toBe(ctx.chat.length - 1);
  });

  it('普通追加正文只更新 UI revision，不使已确认来源失效，也不自动推进阶段', async () => {
    bindOutlineLifecycle(); const old = await active(), before = copy(saved()), revision = outlineState.revision;
    ctx.chat.push(message('正常追加的续写')); emit('MESSAGE_SENT');
    expect(outlineState.revision).toBeGreaterThan(revision); expect(outlineSourceCurrent(old)).toBe(true);
    expect(latestInjection()).toContain('阶段一独有目标'); expect(saved()).toEqual(before);
  });

  it.each(['legacy-body', 'time-tagged-body'] as const)('%s 的真实托管旁注/札记/隐藏标记不取消请求或误伤来源', async mode => {
    if (mode === 'time-tagged-body') ctx.chat[1].mes = '<bbs_start>上午</bbs_start>她走进房间。<bbs_end>中午</bbs_end>';
    bindOutlineLifecycle(); await active(); const revision = outlineState.revision;
    const pending = pendingRequest(), body = cleanBody(ctx.chat[1].mes), source = captureOutlineSource(ctx);
    ctx.chat[1].mes = writeVarLogTag(writeItemLogTag(ctx.chat[1].mes, '获得 钥匙 ×1'), '变更 信任 +1');
    ctx.chat[1].mes += '\n<aftertalk>只是未确认的札记提案</aftertalk>';
    ctx.chat[1].is_system = true; ctx.chat[1].extra!.bbs_hidden = true;
    expect(cleanBody(ctx.chat[1].mes)).toBe(body);
    emit('MESSAGE_UPDATED');
    expect(outlineInputUnchanged(source, true)).toBe(true); expect(outlineState.revision).toBe(revision);
    expect(pending.options.signal?.aborted).toBe(false); expect(outlineRun.busy).toBe(true);
    expect(latestInjection()).toContain('阶段一独有目标');
    pending.resolve(reply('旁注之后仍有效')); await pending.task;
    expect(outlineRun.error).toBe(''); expect(outlineState.draft?.content.title).toBe('旁注之后仍有效');
  });

  it('正文中的同名标签格式讲解不是托管旁注，修改后必须失效', async () => {
    bindOutlineLifecycle(); await active();
    ctx.chat[1].mes += '\n她解释了 <bbs_vars>这个写法</bbs_vars> 的意义。'; emit('MESSAGE_EDITED');
    expect(cleanBody(ctx.chat[1].mes)).toContain('她解释了'); expect(latestInjection()).toBe('');
  });

  it.each(['id', 'character', 'group', 'chat', 'metadata'] as const)('捕获可变 ctx 的 %s 值，不把同一对象当同一聊天', field => {
    const source = captureOutlineSource(ctx);
    if (field === 'id') ctx.getCurrentChatId = () => 'chat-b';
    if (field === 'character') ctx.characterId = '1';
    if (field === 'group') ctx.groupId = 'group-b';
    if (field === 'chat') ctx.chat = [...ctx.chat];
    if (field === 'metadata') ctx.chatMetadata = { ...ctx.chatMetadata };
    expect(sameOutlineChat(source)).toBe(false); expect(outlineInputUnchanged(source)).toBe(false);
  });
});

describe('真实 service：取消、迟到响应、错误边界与生命周期', () => {
  it.each(['cancel', 'chat', 'mutable-chat', 'body-edit', 'append', 'disable'] as const)
  ('%s 后迟到流与完成不得保存或写入新聊天', async mode => {
    bindOutlineLifecycle(); const pending = pendingRequest(); const oldMetadata = ctx.chatMetadata;
    pending.options.onDelta?.('临时预览'); expect(outlineRun.draft).toBe('临时预览');
    if (mode === 'cancel') cancelOutline();
    if (mode === 'chat') { current = context('chat-b'); emit('CHAT_CHANGED'); }
    if (mode === 'mutable-chat') {
      const next = context('chat-b');
      Object.assign(ctx, { chat: next.chat, chatMetadata: next.chatMetadata, getCurrentChatId: next.getCurrentChatId });
      emit('CHAT_CHANGED');
    }
    if (mode === 'body-edit') { ctx.chat[1].mes += '正文变动'; emit('MESSAGE_EDITED'); }
    if (mode === 'append') { ctx.chat.push(message('新正文')); emit('MESSAGE_SENT'); }
    if (mode === 'disable') engine.value = false;
    expect(pending.options.signal?.aborted).toBe(true);
    pending.options.onDelta?.('迟到流不可见'); pending.resolve(reply()); await pending.task;
    expect(outlineRun.busy).toBe(false); expect(outlineRun.draft).toBe(''); expect(outlineRun.error).toBe('');
    expect(oldMetadata).not.toHaveProperty(OUTLINE_DATA_KEY); expect(current.chatMetadata).not.toHaveProperty(OUTLINE_DATA_KEY);
    expect(outlineState.draft).toBeNull(); for (const c of contexts) expect(c.saveMetadata).not.toHaveBeenCalled();
  });

  it.each(['mutable-chat', 'body-edit', 'append', 'disable'] as const)('无宿主事件时 %s 也靠值检查拒绝迟到结果', async mode => {
    const pending = pendingRequest(); const old = ctx.chatMetadata;
    if (mode === 'mutable-chat') {
      const next = context('chat-b'); Object.assign(ctx, { chat: next.chat, chatMetadata: next.chatMetadata, getCurrentChatId: next.getCurrentChatId });
    }
    if (mode === 'body-edit') ctx.chat[1].mes += '真实修改';
    if (mode === 'append') ctx.chat.push(message('新正文'));
    if (mode === 'disable') engine.value = false;
    pending.options.onDelta?.('不能显示'); expect(outlineRun.draft).toBe('');
    pending.resolve(reply()); await pending.task;
    expect(old).not.toHaveProperty(OUTLINE_DATA_KEY); expect(current.chatMetadata).not.toHaveProperty(OUTLINE_DATA_KEY);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });

  it('取消旧请求后新请求可运行；旧流/错误/finally 不清理新 run', async () => {
    const old = pendingRequest(); cancelOutline(); const newer = pendingRequest();
    newer.options.onDelta?.('新请求预览'); old.options.onDelta?.('旧流');
    old.reject(new Error('旧请求上游密钥')); await old.task;
    expect(outlineRun.busy).toBe(true); expect(outlineRun.draft).toBe('新请求预览'); expect(outlineRun.error).toBe('');
    newer.resolve(reply('最新请求')); await newer.task;
    expect(saved().draft?.content.title).toBe('最新请求'); expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
  });

  it('busy 时重复生成不会再发请求或覆盖正在生成的参数', async () => {
    const pending = pendingRequest(); await generateOutline('重复点击', 1);
    expect(completion).toHaveBeenCalledTimes(1); pending.resolve(reply()); await pending.task;
    expect(saved().draft?.brief).toBe('新的创作要求');
  });

  it.each(['HTTP 401 sk-upstream-secret https://private.invalid/?key=secret', '上游超时 sk-upstream-secret', '<script>private upstream</script>'])
  ('request 错误不泄漏上游文本且不重试：%s', async upstream => {
    await active(); const before = copy(saved()); completion.mockRejectedValueOnce(new Error(upstream));
    await generateOutline('重新生成', 2);
    expect(outlineRun.error).not.toBe(''); expect(outlineRun.error).not.toContain('sk-upstream-secret');
    expect(outlineRun.error).not.toContain('private'); expect(outlineRun.error).not.toContain('<script>');
    expect(outlineRun.error.length).toBeLessThanOrEqual(250); expect(completion).toHaveBeenCalledTimes(1);
    expect(outlineRun.busy).toBe(false); expect(saved()).toEqual(before);
  });

  it.each(['not-json-secret', JSON.stringify({ ...content(), chapters: [content().chapters[0]] })])
  ('解析/阶段数失败保留已确认及草稿：%s', async badReply => {
    await active(); const before = copy(saved()); completion.mockResolvedValueOnce(badReply);
    await generateOutline('生成', 2);
    expect(outlineRun.error).not.toBe(''); expect(outlineRun.error).not.toContain('not-json-secret'); expect(saved()).toEqual(before);
  });

  it.each(['normal', 'regenerate', 'swipe', 'continue'])('正文 %s 开始取消规划，结束后方可重新规划', async type => {
    bindOutlineLifecycle(); const pending = pendingRequest(); emit('GENERATION_STARTED', type, {}, false);
    expect(pending.options.signal?.aborted).toBe(true); pending.resolve(reply()); await pending.task;
    await generateOutline('正文还在生成', 2); expect(outlineRun.error).toContain('正文生成结束');
    expect(completion).toHaveBeenCalledTimes(1); emit('GENERATION_ENDED');
    await generateOutline('正文结束后', 2); expect(outlineRun.error).toBe(''); expect(completion).toHaveBeenCalledTimes(2);
  });

  it.each([['quiet', false], ['impersonate', false], ['normal', true]] as const)
  ('%s dryRun=%s 不取消规划或阻止下一次规划', async (type, dryRun) => {
    bindOutlineLifecycle(); const pending = pendingRequest(); emit('GENERATION_STARTED', type, {}, dryRun);
    expect(pending.options.signal?.aborted).toBe(false); expect(outlineRun.busy).toBe(true);
    pending.resolve(reply()); await pending.task; expect(outlineRun.error).toBe('');
    await generateOutline('第二次规划', 2); expect(completion).toHaveBeenCalledTimes(2); expect(outlineRun.error).toBe('');
  });

  it('GENERATION_STOPPED 解除正文忙锁；CHAT_CHANGED 清除旧状态并只载入新聊天', async () => {
    bindOutlineLifecycle(); await active(); emit('GENERATION_STARTED', 'normal', {}, false); emit('GENERATION_STOPPED');
    await generateOutline('停止后可规划', 2); expect(outlineRun.error).toBe('');
    current = context('chat-b'); emit('CHAT_CHANGED');
    expect(outlineState.active).toBeNull(); expect(outlineState.draft).toBeNull(); expect(latestInjection()).toBe('');
    expect(outlineRun.error).toBe(''); expect(outlineRun.status).toBe('');
  });

  it('禁用引擎立即撤下注入；恢复开关不会把草稿自动激活', async () => {
    bindOutlineLifecycle(); await draft(); engine.value = false; expect(latestInjection()).toBe('');
    engine.value = true; expect(latestInjection()).toBe(''); await activateOutlineDraft(outlineState.draft!.id);
    expect(latestInjection()).not.toBe(''); engine.value = false; expect(latestInjection()).toBe('');
  });

  it('绑定幂等，卸载取消请求/撤下注入/解绑所有事件，不留幽灵监听', async () => {
    bindOutlineLifecycle(); const count = vi.mocked(ctx.eventSource.on).mock.calls.length;
    bindOutlineLifecycle(); expect(ctx.eventSource.on).toHaveBeenCalledTimes(count);
    const pending = pendingRequest(); unbindOutlineLifecycle();
    expect(pending.options.signal?.aborted).toBe(true); expect(latestInjection()).toBe('');
    expect(ctx.eventSource.off).toHaveBeenCalledTimes(count);
    const revision = outlineState.revision; ctx.chat[1].mes += '卸载后变化'; emit('MESSAGE_EDITED');
    expect(outlineState.revision).toBe(revision); pending.resolve(reply()); await pending.task;
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    bindOutlineLifecycle(); expect(ctx.eventSource.on).toHaveBeenCalledTimes(count * 2);
  });
});
