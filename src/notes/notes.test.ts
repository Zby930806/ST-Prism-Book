import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { STContext, STMessage } from '@/st/context';
import type { NoteRecord } from './types';
import * as host from '@/st/context';
import * as api from '@/api/settings';
import { requestCompletion } from '@/api/client';
import { clampToTimeTags, cleanBody } from '@/memory/timeTag';
import { ORIGINAL_NOTES_PROMPT, ORIGINAL_NOTES_PROMPT_SHA256, EXECUTABLE_NOTES_PROMPT } from './prompt';
import { stripAftertalk, extractAftertalk, parseQuestions, noteText, fingerprint } from './protocol';
import { notesSettings, settingsIssue, hydrateNotesSettings, saveNotesSettings, validateNotesChannel, NOTES_SETTINGS_KEY } from './settings';
import { sourceHash, latestStoryFloor } from './source';
import { notesState, NOTES_DATA_KEY, loadNotes, addNote, confirmQuestion, rejectQuestion, setDecisionStatus, activeDecisions, recordIsCurrent, recordSourceIsCurrent, importLegacyNotes } from './store';
import { buildNotesContext } from './context';
import { notesRun, generateNotes, cancelNotes, buildConfirmedInjection, refreshNotesInjection, bindNotesLifecycle, unbindNotesLifecycle, NOTES_INJECT_KEY } from './service';

// 仅模拟外部边界；notes 全模块及 timeTag 使用真实实现。禁止真实模型/网络。
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn() }));
vi.mock('@/memory/store', () => ({
  memory: { summaries: [], state: {}, protagonist: {}, npcs: [], items: [], plans: [] },
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ selectHistoryNodesBefore: vi.fn(() => []), renderHistoryNodes: vi.fn(() => '') }));

const completion = vi.mocked(requestCompletion);
const ORIGINAL_SHA256 = '2627b266939ffcfa122a95570fad64c752cefdbd2f8fc9d73f9f2031d5d7c33d';
const proposed = 'Q1. 要不要去山里？凝嘤嘤暂定: 未确认的登山计划\nQ2. 如何见面？凝嘤嘤暂定写法: 未确认的见面计划';
const reply = `<aftertalk status="out_of_story">${proposed}</aftertalk>`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function message(mes: string, overrides: Partial<STMessage> = {}): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes, swipe_id: 0, ...overrides };
}
function context(id = 'chat-a'): STContext {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const names = ['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT'];
  return {
    chat: [message('我们从这里开始。', { is_user: true }), message('她走进房间。')],
    chatMetadata: { unrelated: { untouched: true } }, extensionSettings: {},
    name1: '用户', name2: '角色', characterId: '0', groupId: undefined,
    getCurrentChatId: () => id, saveMetadata: vi.fn().mockResolvedValue(undefined),
    saveSettingsDebounced: vi.fn(), setExtensionPrompt: vi.fn(),
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
}
let ctx: STContext;
let current: STContext;
function record(id = 'note-1', floor = 1): NoteRecord {
  return { id, createdAt: 123, floor, swipe: ctx.chat[floor].swipe_id ?? 0,
    sourceHash: sourceHash(ctx, floor), text: proposed, questions: parseQuestions(proposed) };
}
function enable() {
  notesSettings.enabled = true;
  notesSettings.injectConfirmed = true;
  Object.assign(notesSettings.channel, { url: 'https://notes.example.invalid/v1', key: 'mock-notes-secret', model: 'notes-model' });
}
async function seeded(id = 'note-1') { const r = record(id); await addNote(r); return r; }

beforeEach(() => {
  ctx = context(); current = ctx;
  vi.spyOn(host, 'getContext').mockImplementation(() => current);
  vi.spyOn(api, 'engineActiveHere').mockReturnValue(true);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected real network request')));
  completion.mockReset(); completion.mockResolvedValue(reply);
  hydrateNotesSettings(); loadNotes(); cancelNotes();
  Object.assign(notesRun, { busy: false, draft: '', error: '', status: '' });
});
afterEach(async () => {
  unbindNotesLifecycle(); cancelNotes(); await nextTick();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('原提示词和 aftertalk 协议', () => {
  it('原提示词 UTF-8 SHA-256 等于固定基线，而不是仅比较两个可同时修改的导出', () => {
    expect(createHash('sha256').update(ORIGINAL_NOTES_PROMPT, 'utf8').digest('hex')).toBe(ORIGINAL_SHA256);
    expect(ORIGINAL_NOTES_PROMPT_SHA256).toBe(ORIGINAL_SHA256);
  });
  it('可执行提示词只展开 setvar、移除注释/trim，保留全部规则和检查清单', () => {
    const expected = ORIGINAL_NOTES_PROMPT.replace(/\{\{setvar::[^:}]+::([\s\S]*?)\}\}/g, '$1').replace(/\{\{(?:\/\/[\s\S]*?|trim)\}\}/g, '').trim();
    expect(EXECUTABLE_NOTES_PROMPT).toBe(expected);
    expect(EXECUTABLE_NOTES_PROMPT).not.toMatch(/\{\{(?:setvar|trim|\/\/)/);
    expect(EXECUTABLE_NOTES_PROMPT).toContain('用户决策才算数');
    expect(EXECUTABLE_NOTES_PROMPT).toContain('凝嘤嘤');
  });
  it.each([
    ['正文<aftertalk>提案</aftertalk>结尾', '正文结尾'],
    ['正文<AFTERTALK status="out_of_story">提案\n秘密</AFTERTALK>结尾', '正文结尾'],
    ['正文<aftertalk>未闭合提案\n后文', '正文'],
    ['<aftertalk>一</aftertalk>正文<aftertalk>二</aftertalk>', '正文'],
    ['正文<aftertalk_rule>保留普通规则名</aftertalk_rule>', '正文<aftertalk_rule>保留普通规则名</aftertalk_rule>'],
  ])('清除闭合/未闭合札记，不误删相似标签：%s', (input, expected) => {
    expect(stripAftertalk(input)).toBe(expected);
    expect(clampToTimeTags(input)).toBe(expected);
    expect(cleanBody(input)).toBe(expected);
  });
  it('先移除札记里的伪时间锚点，不能让它覆盖正文时间范围', () => {
    const story = '<bbs_start>上午</bbs_start>真正正文<bbs_end>中午</bbs_end>';
    expect(clampToTimeTags(story + '<aftertalk><bbs_start>未来</bbs_start>提案<bbs_end>明天</bbs_end></aftertalk>')).toBe(story);
  });
  it('只导出闭合非空块；清理思考块并合并多份札记', () => {
    expect(extractAftertalk('<aftertalk> </aftertalk><aftertalk>一</aftertalk><aftertalk>未闭合')).toEqual(['一']);
    expect(noteText('<think>秘密</think><thinking>秘密二</thinking><aftertalk>一</aftertalk><aftertalk>二</aftertalk>')).toBe('一\n\n二');
    expect(noteText('本轮无需新增札记')).toBe('本轮无需新增札记');
    expect(() => noteText('x'.repeat(80001))).toThrow('过长');
  });
  it('解析问题、暂定写法、去重编号，且不把收尾当提案', () => {
    const qs = parseQuestions('Q1. 甲？凝嘤嘤暂定: 方案甲\n- **Q2**：乙？\n**凝嘤嘤暂定写法**：方案乙\nQ1. 重复\n收尾: 结束');
    expect(qs).toEqual([
      { id: 'Q1', label: 'Q1', prompt: '甲？', proposal: '方案甲' },
      { id: 'Q2', label: 'Q2', prompt: '乙？', proposal: '方案乙' },
    ]);
  });
  it('来源指纹覆盖中部内容而非只取首尾', () => {
    expect(fingerprint('x'.repeat(1000) + '甲' + 'y'.repeat(1000))).not.toBe(fingerprint('x'.repeat(1000) + '乙' + 'y'.repeat(1000)));
  });
});

describe('独立设置隔离', () => {
  it('默认关闭且不继承原渠道；写入只影响独立 key', () => {
    const original = { channels: [{ id: 'original', key: 'original-secret' }], assignments: { summary: 'original' } };
    ctx.extensionSettings!.baibai_api_channels = original;
    const before = copy(api.apiSettings);
    hydrateNotesSettings();
    expect(notesSettings.enabled).toBe(false);
    expect(notesSettings.autoGenerate).toBe(false);
    expect(notesSettings.injectConfirmed).toBe(false);
    expect(notesSettings.channel.url).toBe('');
    enable(); saveNotesSettings();
    expect(ctx.extensionSettings!.baibai_api_channels).toBe(original);
    expect(original).toEqual({ channels: [{ id: 'original', key: 'original-secret' }], assignments: { summary: 'original' } });
    expect(copy(api.apiSettings)).toEqual(before);
    expect(ctx.extensionSettings![NOTES_SETTINGS_KEY]).toMatchObject({ version: 1, channel: { id: 'prism-notes-independent', model: 'notes-model' } });
    notesSettings.channel.key = 'edited-after-save';
    expect((ctx.extensionSettings![NOTES_SETTINGS_KEY] as any).channel.key).toBe('mock-notes-secret');
  });
  it('读取时克隆和规范化独立渠道，不修改持久化输入', () => {
    const raw = { version: 1, enabled: true, recentFloors: 999, memoryChars: -1,
      channel: { id: 'spoofed-shared', url: ' https://notes.example.invalid/v1 ', model: ' model ', key: 'key', temperature: 9, maxTokens: -1, timeoutSec: 9999 } };
    ctx.extensionSettings![NOTES_SETTINGS_KEY] = raw;
    const before = copy(raw); hydrateNotesSettings();
    expect(notesSettings).toMatchObject({ recentFloors: 40, memoryChars: 1000, channel: { id: 'prism-notes-independent', url: 'https://notes.example.invalid/v1', model: 'model', temperature: 2, maxTokens: 256, timeoutSec: 600 } });
    notesSettings.channel.model = 'changed'; expect(raw).toEqual(before);
  });
  it.each([{ version: 9, channel: {} }, [], 'corrupt', { version: 1, channel: null }])('未知或损坏设置只读保护：%j', raw => {
    ctx.extensionSettings![NOTES_SETTINGS_KEY] = raw; hydrateNotesSettings();
    expect(settingsIssue.value).toContain('只读保护');
    expect(() => saveNotesSettings()).toThrow();
    expect(() => validateNotesChannel()).toThrow();
    expect(ctx.extensionSettings![NOTES_SETTINGS_KEY]).toBe(raw);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
  it.each(['', 'not a url', 'file:///tmp/test', 'https://user:pass@example.invalid/v1', 'https://example.invalid/v1?token=secret', 'https://example.invalid/v1#fragment'])('拒绝无效或含凭据的端点：%s', url => {
    enable(); notesSettings.channel.url = url; expect(() => validateNotesChannel()).toThrow();
  });
});

describe('store 只读保护、事务与确认绑定', () => {
  it.each([
    { version: 2, records: [], decisions: [] },
    { version: 1, records: 'broken', decisions: [] },
    { version: 1, records: [], decisions: [{ id: 'orphan', noteId: 'missing', questionId: 'Q1', text: 'x', status: 'pending', createdAt: 0 }] },
  ])('未知版/损坏数据不能被任何写入口覆盖：%j', async raw => {
    ctx.chatMetadata[NOTES_DATA_KEY] = raw; loadNotes();
    expect(notesState.issue).toContain('只读保护');
    await expect(addNote(record())).rejects.toThrow();
    await expect(confirmQuestion('missing', 'Q1', '安排')).rejects.toThrow();
    await expect(rejectQuestion('missing', 'Q1')).rejects.toThrow();
    await expect(setDecisionStatus('missing', 'pending')).rejects.toThrow();
    await expect(importLegacyNotes()).rejects.toThrow();
    expect(ctx.chatMetadata[NOTES_DATA_KEY]).toBe(raw);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('已存在数据保存失败时恢复原引用，状态/其它 metadata 不变', async () => {
    await seeded();
    const raw = ctx.chatMetadata[NOTES_DATA_KEY], state = copy(notesState.records), unrelated = ctx.chatMetadata.unrelated;
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('disk full'));
    await expect(addNote(record('note-2'))).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata[NOTES_DATA_KEY]).toBe(raw);
    expect(notesState.records).toEqual(state);
    expect(notesState.decisions).toEqual([]);
    expect(ctx.chatMetadata.unrelated).toBe(unrelated);
    expect(notesState.issue).toContain('保存失败');
    await addNote(record('note-3'));
    expect(notesState.records.map(r => r.id)).toEqual(['note-1', 'note-3']);
    expect(notesState.issue).toBe('');
  });
  it('首次保存失败删除临时 key，而不是留下假成功数据', async () => {
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('disk full'));
    await expect(addNote(record())).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata).not.toHaveProperty(NOTES_DATA_KEY);
    expect(notesState.records).toEqual([]);
  });
  it('确认保存失败不能产生有效安排', async () => {
    await seeded(); vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('disk full'));
    await expect(confirmQuestion('note-1', 'Q1', '批准')).rejects.toThrow('保存失败');
    expect(activeDecisions()).toEqual([]);
    expect((ctx.chatMetadata[NOTES_DATA_KEY] as any).decisions).toEqual([]);
  });
  it('保存中禁止并发写入，失败回滚不覆盖外部较新值', async () => {
    const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const saving = addNote(record());
    await expect(addNote(record('second'))).rejects.toThrow('正在保存');
    const external = { version: 99 }; ctx.chatMetadata[NOTES_DATA_KEY] = external;
    wait.reject(new Error('failed')); await expect(saving).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata[NOTES_DATA_KEY]).toBe(external);
  });
  it('保存完成前切聊不污染新聊天的内存或 metadata', async () => {
    const wait = deferred<void>(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const old = ctx; const pending = addNote(record());
    current = context('chat-b'); loadNotes(); wait.resolve(); await pending;
    expect(notesState.records).toEqual([]);
    expect(current.chatMetadata).not.toHaveProperty(NOTES_DATA_KEY);
    expect((old.chatMetadata[NOTES_DATA_KEY] as any).records).toHaveLength(1);
  });
  it('确认严格绑定 noteId + questionId；重确认更新而不重复', async () => {
    await seeded();
    await expect(confirmQuestion('missing', 'Q1', '批准')).rejects.toThrow();
    await expect(confirmQuestion('note-1', 'Q9', '批准')).rejects.toThrow();
    await expect(confirmQuestion('note-1', 'Q1', '   ')).rejects.toThrow();
    await expect(confirmQuestion('note-1', 'Q1', 'x'.repeat(4001))).rejects.toThrow();
    await confirmQuestion('note-1', 'Q1', ' 用户自行改写的安排 ');
    const first = copy(notesState.decisions[0]);
    expect(first).toMatchObject({ noteId: 'note-1', questionId: 'Q1', text: '用户自行改写的安排', status: 'pending' });
    await confirmQuestion('note-1', 'Q1', '第二版安排');
    expect(notesState.decisions).toHaveLength(1);
    expect(notesState.decisions[0]).toMatchObject({ id: first.id, createdAt: first.createdAt, text: '第二版安排' });
  });
  it('同楼重生成后旧问题不能确认，新编号不会继承旧授权；已有确认仍绑定旧记录', async () => {
    const old = await seeded(); await confirmQuestion(old.id, 'Q1', '已经确认');
    const newer = record('newer'); newer.questions[0].proposal = '新的未确认提案'; await addNote(newer);
    expect(recordIsCurrent(old)).toBe(false); expect(recordIsCurrent(newer)).toBe(true);
    await expect(confirmQuestion(old.id, 'Q2', '迟到确认')).rejects.toThrow();
    expect(activeDecisions()).toHaveLength(1);
    expect(activeDecisions()[0]).toMatchObject({ noteId: old.id, text: '已经确认' });
    expect(notesState.decisions.some(d => d.noteId === newer.id)).toBe(false);
  });
  it.each(['completed', 'cancelled'] as const)('状态 %s 排除注入，重生成不会自动复活', async status => {
    await seeded(); await confirmQuestion('note-1', 'Q1', '批准');
    await setDecisionStatus(notesState.decisions[0].id, status); await addNote(record('newer'));
    expect(activeDecisions()).toEqual([]); expect(notesState.decisions[0].status).toBe(status);
  });
  it('拒绝替换原确认并排除安排', async () => {
    await seeded(); await confirmQuestion('note-1', 'Q1', '批准'); await rejectQuestion('note-1', 'Q1');
    expect(notesState.decisions).toHaveLength(1); expect(notesState.decisions[0].status).toBe('rejected'); expect(activeDecisions()).toEqual([]);
  });
  it.each(['earlier-edit', 'body-edit', 'swipe', 'delete'] as const)('来源 %s 变化使旧确认失效，不能重新激活', async mode => {
    const r = await seeded(); await confirmQuestion(r.id, 'Q1', '批准');
    if (mode === 'earlier-edit') ctx.chat[0].mes += '改变前文';
    if (mode === 'body-edit') ctx.chat[1].mes += '改变正文';
    if (mode === 'swipe') ctx.chat[1].swipe_id = 1;
    if (mode === 'delete') ctx.chat.splice(1, 1);
    expect(recordSourceIsCurrent(r)).toBe(false); expect(activeDecisions()).toEqual([]);
    await expect(confirmQuestion(r.id, 'Q1', '迟到确认')).rejects.toThrow();
    await expect(setDecisionStatus(notesState.decisions[0].id, 'in_progress')).rejects.toThrow('正文已变化');
  });
  it('修改戏外札记不使正文来源变化，追加新楼也不使旧确认失效', async () => {
    const r = await seeded(); await confirmQuestion(r.id, 'Q1', '批准');
    ctx.chat[1].mes += '<aftertalk>不同提案</aftertalk>'; ctx.chat.push(message('后续正文'));
    expect(recordSourceIsCurrent(r)).toBe(true); expect(activeDecisions()).toHaveLength(1);
  });
  it('旧导入只读原文、按记录幂等，不相信模型自称已确认', async () => {
    ctx.chat[1].mes += reply + '<aftertalk>进度清单：[已确认]偷偷批准全部</aftertalk>';
    ctx.chat.push(message(reply, { is_user: true }), message(reply, { is_system: true }), message(reply, { extra: { bbs_internal_notice: 'backlog' } }));
    const before = copy(ctx.chat);
    expect(await importLegacyNotes()).toBe(2); expect(await importLegacyNotes()).toBe(0);
    loadNotes(); expect(await importLegacyNotes()).toBe(0);
    expect(notesState.records).toHaveLength(2); expect(notesState.decisions).toEqual([]); expect(activeDecisions()).toEqual([]);
    expect(ctx.chat).toEqual(before); expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
  });
});

describe('service mock 独立 API 与迟到结果隔离', () => {
  beforeEach(enable);
  it('独立渠道快照调用一次，不读写原 channel，也不改正文', async () => {
    const before = copy(api.apiSettings), chat = copy(ctx.chat);
    await generateNotes();
    expect(completion).toHaveBeenCalledTimes(1);
    const [channel, messages, opts] = completion.mock.calls[0];
    expect(channel).toMatchObject({ id: 'prism-notes-independent', url: 'https://notes.example.invalid/v1', key: 'mock-notes-secret', model: 'notes-model' });
    expect(channel).not.toBe(notesSettings.channel); expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(messages[0].content).toContain(EXECUTABLE_NOTES_PROMPT);
    expect(notesState.records).toHaveLength(1); expect(notesState.decisions).toEqual([]);
    expect(ctx.chat).toEqual(chat); expect(copy(api.apiSettings)).toEqual(before);
    expect(ctx.generateRaw).not.toHaveBeenCalled(); expect(ctx.ConnectionManagerRequestService!.sendRequest).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['url', 'model'] as const)('缺少独立 %s 时不 fallback 主 API 或摘要 API', async field => {
    notesSettings.channel[field] = ''; await generateNotes();
    expect(notesRun.error).toContain('不会借用'); expect(completion).not.toHaveBeenCalled();
    expect(ctx.generateRaw).not.toHaveBeenCalled(); expect(ctx.ConnectionManagerRequestService!.sendRequest).not.toHaveBeenCalled();
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('API 失败不 fallback、不泄漏密钥、不替换旧记录', async () => {
    await seeded(); const before = copy(notesState.records);
    completion.mockRejectedValueOnce(new Error('upstream mock-notes-secret request body private'));
    await generateNotes(true);
    expect(completion).toHaveBeenCalledTimes(1); expect(ctx.generateRaw).not.toHaveBeenCalled();
    expect(notesRun.error).toContain('独立 API'); expect(notesRun.error).not.toContain('mock-notes-secret');
    expect(notesState.records).toEqual(before); expect(notesRun.busy).toBe(false);
  });
  it('取消后忽略不响应 abort 的 API 迟到流片段和最终响应', async () => {
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const pending = generateNotes(); const opts = completion.mock.calls[0][2]!;
    opts.onDelta?.('可见草稿'); expect(notesRun.draft).toBe('可见草稿');
    cancelNotes(); expect(opts.signal?.aborted).toBe(true); opts.onDelta?.('迟到草稿');
    wait.resolve(reply); await pending;
    expect(notesRun.draft).toBe(''); expect(notesState.records).toEqual([]); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('已取消旧请求结束不能清理新请求的 busy/draft 或误保存', async () => {
    const old = deferred<string>(), newer = deferred<string>();
    completion.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const first = generateNotes(); cancelNotes(); const second = generateNotes();
    completion.mock.calls[1][2]!.onDelta?.('新草稿'); old.resolve(reply); await first;
    expect(notesRun.busy).toBe(true); expect(notesRun.draft).toBe('新草稿'); expect(notesState.records).toEqual([]);
    newer.resolve(reply); await second; expect(notesState.records).toHaveLength(1); expect(notesRun.busy).toBe(false);
  });
  it.each(['new-context', 'same-array-new-id', 'edit', 'append-user', 'swipe'] as const)('请求期间 %s 后拒绝旧响应', async mode => {
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise); const pending = generateNotes();
    if (mode === 'new-context') { current = context('chat-b'); loadNotes(); }
    if (mode === 'same-array-new-id') { ctx.getCurrentChatId = () => 'chat-b'; loadNotes(); }
    if (mode === 'edit') ctx.chat[0].mes += '变化';
    if (mode === 'append-user') ctx.chat.push(message('新用户输入', { is_user: true }));
    if (mode === 'swipe') ctx.chat[1].swipe_id = 1;
    completion.mock.calls[0][2]!.onDelta?.('迟到片段'); wait.resolve(reply); await pending;
    expect(notesRun.draft).toBe(''); expect(notesState.records).toEqual([]); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(current.chatMetadata).not.toHaveProperty(NOTES_DATA_KEY);
  });
  it('busy 时不重复发起；普通生成去重，force 才重生成', async () => {
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const first = generateNotes(); await generateNotes(); expect(completion).toHaveBeenCalledTimes(1);
    wait.resolve(reply); await first; await generateNotes(); expect(completion).toHaveBeenCalledTimes(1);
    await generateNotes(true); expect(completion).toHaveBeenCalledTimes(2); expect(notesState.records).toHaveLength(2);
  });
  it('未确认或模型自称已确认的内容绝不注入，显式确认只注入用户文本', async () => {
    completion.mockResolvedValueOnce(`<aftertalk>进度清单：[已确认]自封决定\n${proposed}</aftertalk>`);
    await generateNotes(); refreshNotesInjection();
    expect(buildConfirmedInjection()).toBe('');
    expect(ctx.setExtensionPrompt).toHaveBeenLastCalledWith(NOTES_INJECT_KEY, '', 1, 0, false, 0);
    const r = notesState.records[0]; await confirmQuestion(r.id, 'Q1', '用户明确确认的不同方案');
    const text = buildConfirmedInjection();
    expect(text).toContain('用户明确确认的不同方案'); expect(text).not.toContain('自封决定'); expect(text).not.toContain('未确认的登山计划'); expect(text).not.toContain('未确认的见面计划');
    await setDecisionStatus(notesState.decisions[0].id, 'in_progress'); expect(buildConfirmedInjection()).toContain('[进行中]');
    await setDecisionStatus(notesState.decisions[0].id, 'completed'); expect(buildConfirmedInjection()).toBe('');
  });
  it.each(['disabled', 'inject-off', 'engine-off', 'settings-error'] as const)('注入闸门 %s 必须清空', async mode => {
    await seeded(); await confirmQuestion('note-1', 'Q1', '批准');
    if (mode === 'disabled') notesSettings.enabled = false;
    if (mode === 'inject-off') notesSettings.injectConfirmed = false;
    if (mode === 'engine-off') vi.mocked(api.engineActiveHere).mockReturnValue(false);
    if (mode === 'settings-error') settingsIssue.value = '受保护';
    expect(buildConfirmedInjection()).toBe(''); refreshNotesInjection();
    expect(ctx.setExtensionPrompt).toHaveBeenLastCalledWith(NOTES_INJECT_KEY, '', 1, 0, false, 0);
  });
  it('context 的最近正文不混入 aftertalk，且不写回记忆/正文', () => {
    ctx.chat[1].mes += '<aftertalk>绝不能成为剧情事实</aftertalk>';
    const before = copy(ctx.chat); const messages = buildNotesContext(ctx);
    const recent = messages.find(m => m.content.startsWith('[最近正文'))!;
    expect(recent.content).toContain('她走进房间'); expect(recent.content).not.toContain('绝不能成为剧情事实');
    expect(ctx.chat).toEqual(before); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('最新正文选择跳过用户、系统、内部通知、omit 与只有札记的楼层', () => {
    ctx.chat.push(message('用户', { is_user: true }), message('系统', { is_system: true }), message('内部', { extra: { bbs_internal_notice: 'backlog' } }), message('omit', { extra: { bbs_omit: true } }), message(reply));
    expect(latestStoryFloor(ctx)).toBe(1);
  });
  it('生命周期只响应正常正文完成；切聊取消排队生成且解绑移除监听器', async () => {
    vi.useFakeTimers(); notesSettings.autoGenerate = true; bindNotesLifecycle();
    const listeners = vi.mocked(ctx.eventSource.on).mock.calls.length; bindNotesLifecycle();
    expect(ctx.eventSource.on).toHaveBeenCalledTimes(listeners);
    ctx.eventSource.emit!('GENERATION_STARTED', 'quiet'); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
    ctx.eventSource.emit!('GENERATION_STARTED', 'normal'); ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(499); expect(completion).not.toHaveBeenCalled();
    ctx.eventSource.emit!('CHAT_CHANGED'); await vi.advanceTimersByTimeAsync(100); expect(completion).not.toHaveBeenCalled();
    ctx.eventSource.emit!('GENERATION_STARTED', 'normal'); ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(500); expect(completion).toHaveBeenCalledTimes(1);
    unbindNotesLifecycle(); expect(ctx.eventSource.off).toHaveBeenCalledTimes(listeners);
    expect(ctx.setExtensionPrompt).toHaveBeenLastCalledWith(NOTES_INJECT_KEY, '', 1, 0, false, 0);
  });
});


describe('自动触发严格时序与摘要隐藏兼容', () => {
  beforeEach(() => { enable(); notesSettings.autoGenerate = true; vi.useFakeTimers(); });
  afterEach(() => { ctx.eventSource.emit?.('GENERATION_STOPPED'); });
  it.each([undefined, 'normal', 'regenerate', 'swipe', 'continue'])('允许 %s，但必须先完成 CHARACTER_MESSAGE_RENDERED', async type => {
    bindNotesLifecycle();
    ctx.eventSource.emit!('GENERATION_STARTED', type);
    await generateNotes(); expect(notesRun.error).toContain('正文生成结束');
    ctx.eventSource.emit!('GENERATION_ENDED'); await vi.advanceTimersByTimeAsync(600);
    expect(completion).not.toHaveBeenCalled();
    ctx.eventSource.emit!('GENERATION_STARTED', type);
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, type);
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
    ctx.eventSource.emit!('GENERATION_ENDED'); await vi.advanceTimersByTimeAsync(499);
    expect(completion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(completion).toHaveBeenCalledTimes(1);
  });
  it.each(['quiet', 'impersonate', 'unknown'])('忽略 %s 类型，即使出现渲染/结束事件也不调度', async type => {
    bindNotesLifecycle(); ctx.eventSource.emit!('GENERATION_STARTED', type);
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, type); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
  });
  it('dryRun 不调度，也不阻止之后手动生成', async () => {
    bindNotesLifecycle(); ctx.eventSource.emit!('GENERATION_STARTED', 'normal', {}, true);
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
    await generateNotes(); expect(completion).toHaveBeenCalledTimes(1);
  });
  it.each(['quiet', 'impersonate', 'first_message'])('渲染事件 %s 不能充当正文已完成证据', async type => {
    bindNotesLifecycle(); ctx.eventSource.emit!('GENERATION_STARTED', 'normal');
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, type); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
  });
  it('先 ENDED 后 RENDERED 不调度，下一轮也不能继承上一轮渲染证据', async () => {
    bindNotesLifecycle(); ctx.eventSource.emit!('GENERATION_STARTED', 'normal'); ctx.eventSource.emit!('GENERATION_ENDED');
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); await vi.advanceTimersByTimeAsync(600);
    expect(completion).not.toHaveBeenCalled();
    ctx.eventSource.emit!('GENERATION_STARTED', 'normal'); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
  });
  it.each(['before-end', 'after-end'] as const)('GENERATION_STOPPED 在 %s 清除资格或计时器', async when => {
    bindNotesLifecycle(); ctx.eventSource.emit!('GENERATION_STARTED', 'normal');
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, 'normal');
    if (when === 'after-end') ctx.eventSource.emit!('GENERATION_ENDED');
    ctx.eventSource.emit!('GENERATION_STOPPED'); ctx.eventSource.emit!('GENERATION_ENDED');
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
    await generateNotes(); expect(completion).toHaveBeenCalledTimes(1);
  });
  it.each(['chat', 'edit', 'append', 'auto-off', 'engine-off'] as const)('排队期间 %s 变化，即使没有宿主事件也不发送请求', async mode => {
    bindNotesLifecycle(); ctx.eventSource.emit!('GENERATION_STARTED', 'normal');
    ctx.eventSource.emit!('CHARACTER_MESSAGE_RENDERED', 1, 'normal'); ctx.eventSource.emit!('GENERATION_ENDED');
    if (mode === 'chat') current = context('chat-b');
    if (mode === 'edit') ctx.chat[1].mes += '编辑';
    if (mode === 'append') ctx.chat.push(message('下一楼'));
    if (mode === 'auto-off') notesSettings.autoGenerate = false;
    if (mode === 'engine-off') vi.mocked(api.engineActiveHere).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(600); expect(completion).not.toHaveBeenCalled();
  });
  it('原 assistant 被摘要标记 is_system + bbs_hidden 后指纹、绑定和已确认注入仍有效', async () => {
    const r = await seeded(); await confirmQuestion(r.id, 'Q1', '已确认计划'); const hash = sourceHash(ctx, 1);
    ctx.chat[1].is_system = true; ctx.chat[1].extra = { bbs_hidden: true };
    expect(sourceHash(ctx, 1)).toBe(hash); expect(recordSourceIsCurrent(r)).toBe(true); expect(recordIsCurrent(r)).toBe(true);
    expect(activeDecisions()).toHaveLength(1); expect(buildConfirmedInjection()).toContain('已确认计划');
    ctx.chat[1].extra.bbs_hidden = false;
    expect(sourceHash(ctx, 1)).not.toBe(hash); expect(recordSourceIsCurrent(r)).toBe(false);
  });
  it('摘要隐藏触发 MESSAGE_UPDATED 不取消正在生成的札记', async () => {
    bindNotesLifecycle(); const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const pending = generateNotes(); const signal = completion.mock.calls[0][2]!.signal;
    ctx.chat[1].is_system = true; ctx.chat[1].extra = { bbs_hidden: true };
    ctx.eventSource.emit!('MESSAGE_UPDATED', 1);
    expect(signal?.aborted).toBe(false); expect(notesRun.busy).toBe(true);
    wait.resolve(reply); await pending; expect(notesState.records).toHaveLength(1);
  });
  it.each(['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT'])('%s 遇到真实来源变化取消请求、清空旧确认注入', async event => {
    await seeded(); await confirmQuestion('note-1', 'Q1', '批准'); bindNotesLifecycle();
    const wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise); const pending = generateNotes(true);
    ctx.chat[1].mes += '真实变化'; ctx.eventSource.emit!(event, 1);
    expect(completion.mock.calls[0][2]!.signal?.aborted).toBe(true); expect(buildConfirmedInjection()).toBe('');
    wait.resolve(reply); await pending; expect(notesState.records).toHaveLength(1);
  });
});

describe('保存失败后的 service 重试契约', () => {
  it('短暂保存失败保持旧记录，用户再次生成应允许重试而非永久自锁', async () => {
    enable(); vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('temporary save failure'));
    await generateNotes();
    expect(notesRun.error).toContain('保存失败'); expect(notesState.records).toEqual([]);
    expect(ctx.chatMetadata).not.toHaveProperty(NOTES_DATA_KEY);
    await generateNotes();
    expect(completion).toHaveBeenCalledTimes(2);
    expect(ctx.saveMetadata).toHaveBeenCalledTimes(2);
    expect(notesState.records).toHaveLength(1);
    expect(notesState.issue).toBe('');
  });
});

describe('最新后端修复回归', () => {
  it.each([false, true])('独立设置同步保存失败恢复原 key（已有值=%s），恢复后可再次保存', hadPrevious => {
    enable(); if (hadPrevious) saveNotesSettings();
    const previous = ctx.extensionSettings![NOTES_SETTINGS_KEY];
    const unrelated = { channels: [{ key: 'original-key' }] }; ctx.extensionSettings!.original = unrelated;
    notesSettings.channel.model = 'unsaved-model';
    vi.mocked(ctx.saveSettingsDebounced!).mockImplementationOnce(() => { throw new Error('save failed'); });
    expect(() => saveNotesSettings()).toThrow('保存失败');
    if (hadPrevious) expect(ctx.extensionSettings![NOTES_SETTINGS_KEY]).toBe(previous);
    else expect(ctx.extensionSettings).not.toHaveProperty(NOTES_SETTINGS_KEY);
    expect(ctx.extensionSettings!.original).toBe(unrelated); expect(settingsIssue.value).toContain('保存失败');
    saveNotesSettings(); expect(settingsIssue.value).toBe('');
    expect((ctx.extensionSettings![NOTES_SETTINGS_KEY] as any).channel.model).toBe('unsaved-model');
  });
  it('设置加载后若外部写入未知版本，保存仍不得覆盖新版本', () => {
    enable(); const newer = { version: 99, channel: { model: 'future' } };
    ctx.extensionSettings![NOTES_SETTINGS_KEY] = newer;
    expect(() => saveNotesSettings()).toThrow('版本已变化');
    expect(ctx.extensionSettings![NOTES_SETTINGS_KEY]).toBe(newer); expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
  it.each([true, false])('拒绝保留被拒文本供下轮阅读，永不注入正文（有提案=%s）', async hasProposal => {
    enable(); const r = record(); if (!hasProposal) r.questions[0].proposal = '';
    await addNote(r); await rejectQuestion(r.id, 'Q1');
    const expected = hasProposal ? r.questions[0].proposal : r.questions[0].prompt;
    expect(notesState.decisions[0]).toMatchObject({ status: 'rejected', text: expected });
    expect(buildNotesContext(ctx).at(-1)!.content).toContain(expected);
    expect(activeDecisions()).toEqual([]); expect(buildConfirmedInjection()).toBe('');
    loadNotes(); expect(notesState.decisions[0].text).toBe(expected);
  });
  it.each([0, 1])('说话人第 %s 楼姓名变化使来源指纹与旧确认失效', async floor => {
    enable(); const r = await seeded(); await confirmQuestion(r.id, 'Q1', '已确认'); const hash = sourceHash(ctx, 1);
    ctx.chat[floor].name = '另一个说话人';
    expect(sourceHash(ctx, 1)).not.toBe(hash); expect(recordSourceIsCurrent(r)).toBe(false);
    expect(activeDecisions()).toEqual([]); expect(buildConfirmedInjection()).toBe('');
  });
  it('托管物品/变量旁注引发 MESSAGE_UPDATED 不取消在途请求、不改变正文指纹', async () => {
    enable(); ctx.chat[1].mes = '<bbs_start>上午</bbs_start>她走进房间。<bbs_end>中午</bbs_end>';
    bindNotesLifecycle(); const hash = sourceHash(ctx, 1), wait = deferred<string>(); completion.mockReturnValueOnce(wait.promise);
    const pending = generateNotes();
    ctx.chat[1].mes += '\n<bbs_items>物品：钥匙 +1</bbs_items>\n<bbs_vars>体力：5</bbs_vars>';
    ctx.eventSource.emit!('MESSAGE_UPDATED', 1);
    expect(sourceHash(ctx, 1)).toBe(hash); expect(completion.mock.calls[0][2]!.signal?.aborted).toBe(false);
    wait.resolve(reply); await pending; expect(notesState.records).toHaveLength(1);
  });
});
