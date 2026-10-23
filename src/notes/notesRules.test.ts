import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import type { NoteDecision, NoteRecord } from './types';
import * as host from '@/st/context';
import * as api from '@/api/settings';
import { apiSettings } from '@/api/settings';
import { requestCompletion } from '@/api/client';
import { memory } from '@/memory/store';
import { renderHistoryNodes, selectHistoryNodesBefore } from '@/memory/inject';
import type { ViewNode } from '@/memory/select';
import { isNoNoteReply, parseQuestions } from './protocol';
import { hydrateNotesSettings, notesSettings, saveNotesSettings } from './settings';
import { floorHash, sourceHash } from './source';
import { NOTES_DATA_KEY, loadNotes, notesState } from './store';
import { NOTES_CONTEXT_LIMITS, buildNotesContext, notesRecentBudget } from './context';
import { NOTES_INJECTION_LIMIT, buildConfirmedInjection, cancelNotes, confirmedInjectionPlan, generateNotes, notesRun } from './service';

// 札记的识别、保存、注入与请求内容（B43/B46/B47/B62/B63/B64/B9）。外部边界全部本地模拟，不请求真实模型。
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn() }));
vi.mock('@/memory/store', () => ({
  memory: { summaries: [], state: {}, protagonist: {}, npcs: [], items: [], plans: [] },
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ selectHistoryNodesBefore: vi.fn(() => []), renderHistoryNodes: vi.fn(() => '') }));

const completion = vi.mocked(requestCompletion);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function message(mes: string, overrides: Partial<STMessage> = {}): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes, swipe_id: 0, ...overrides };
}
let ctx: STContext;
function context(chat = [message('开场。', { is_user: true }), message('第一段正文。')]): STContext {
  return {
    chat, chatMetadata: {}, extensionSettings: {}, name1: '用户', name2: '角色', characterId: '0', groupId: undefined,
    characters: [{ name: '角色', avatar: 'a.png', description: '角色设定' }],
    getCurrentChatId: () => 'chat-rules', saveMetadata: vi.fn().mockResolvedValue(undefined), saveSettingsDebounced: vi.fn(),
    setExtensionPrompt: vi.fn(), eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  } as unknown as STContext;
}
const record = (id: string, floor: number, text: string): NoteRecord => ({
  id, createdAt: 1, floor, swipe: ctx.chat[floor].swipe_id ?? 0, sourceHash: sourceHash(ctx, floor), floorHash: floorHash(ctx.chat[floor]), text, questions: parseQuestions(text),
});
function seedData(records: NoteRecord[], decisions: NoteDecision[]) {
  ctx.chatMetadata[NOTES_DATA_KEY] = { version: 1, records, decisions };
  loadNotes();
}
const decision = (id: string, noteId: string, questionId: string, text: string, status: NoteDecision['status'], createdAt: number): NoteDecision =>
  ({ id: `uuid-${id}`, noteId, questionId, text, status, createdAt });
function enable() {
  notesSettings.enabled = true; notesSettings.injectConfirmed = true;
  Object.assign(notesSettings.channel, { url: 'https://notes.example.invalid/v1', key: 'k', model: 'm' });
}
const memoryBefore = copy(memory);

beforeEach(() => {
  ctx = context();
  vi.spyOn(host, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(api, 'engineActiveHere').mockReturnValue(true);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('禁止真实网络')));
  completion.mockReset();
  vi.mocked(selectHistoryNodesBefore).mockReset().mockReturnValue([]);
  vi.mocked(renderHistoryNodes).mockReset().mockImplementation(nodes => nodes.map(n => n.text).join('\n\n'));
  apiSettings.memoryBudgetTokens = 0;
  hydrateNotesSettings(); loadNotes(); cancelNotes();
  Object.assign(notesRun, { busy: false, draft: '', error: '', errorDetail: '', status: '', floor: null });
});
afterEach(() => {
  Object.assign(memory, copy(memoryBefore));
  apiSettings.memoryBudgetTokens = 0;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('札记问题的识别（B62）', () => {
  it('只在「想问用户」小节里识别；进度清单里引用的 Q 编号不算问题', () => {
    const text = '凝嘤嘤探头: 好戏开场。\n\n进度清单:\n- [未动笔] Q1：上一轮确认的去山里\n- Q2：见面的事写到一半\n\n想问用户:\nQ1. 新问题甲？凝嘤嘤暂定: 新方案甲\nQ2. 新问题乙？凝嘤嘤暂定: 新方案乙\n\n收尾: 用 Q 编号回复我。Q3. 这不是问题';
    expect(parseQuestions(text)).toEqual([
      { id: 'Q1', label: 'Q1', prompt: '新问题甲？', proposal: '新方案甲' },
      { id: 'Q2', label: 'Q2', prompt: '新问题乙？', proposal: '新方案乙' },
    ]);
  });
  it.each([
    ['Markdown 标题', '### Q1. 要去钟塔吗？\n凝嘤嘤暂定: 入夜后去'],
    ['方括号编号', '【Q1】要去钟塔吗？凝嘤嘤暂定：入夜后去'],
    ['编号后只有空格', 'Q1 要去钟塔吗？暂定: 入夜后去'],
    ['序号开头', '1. Q1：要去钟塔吗？凝嘤嘤暂定: 入夜后去'],
    ['全角编号', 'Ｑ１．要去钟塔吗？凝嘤嘤暂定：入夜后去'],
    ['引用块', '> **Q1** 要去钟塔吗？凝嘤嘤暂定: 入夜后去'],
  ])('放宽的写法：%s', (_name, text) => {
    const [q] = parseQuestions('想问用户:\n' + text);
    expect(q).toMatchObject({ id: 'Q1', label: 'Q1', proposal: '入夜后去' });
    expect(q.prompt).toContain('要去钟塔吗？');
  });
  it('放宽的写法没有「暂定」标记时不算问题，文字并回上一题；原来的写法不要求暂定', () => {
    const qs = parseQuestions('Q1. 第一个问题？凝嘤嘤暂定: 方案一\nQ2 的事我们下次再说\nQ3. 还缺什么？');
    expect(qs.map(q => q.id)).toEqual(['Q1', 'Q3']);
    expect(qs[0].proposal).toContain('Q2 的事我们下次再说');
    expect(qs[1]).toEqual({ id: 'Q3', label: 'Q3', prompt: '还缺什么？', proposal: '' });
    expect(parseQuestions('想问用户:\nQ1 没有暂定的随口一提')).toEqual([]);
    expect(parseQuestions('Q10. 不是 Q1')).toEqual([]);
  });
});

describe('「本轮无需新增札记」（B63）', () => {
  it.each(['本轮无需新增札记', '本轮无需新增札记。', '（本轮无需新增札记）', '**本轮无需新增札记**\n'])('识别：%s', text => {
    expect(isNoNoteReply(text)).toBe(true);
  });
  it('有内容的札记不算', () => {
    expect(isNoNoteReply('本轮无需新增札记，但想问：Q1. 要不要去山里？')).toBe(false);
  });
  it('模型回复本轮无需新增札记时不保存，只在状态里说明', async () => {
    enable();
    completion.mockResolvedValueOnce('<aftertalk status="out_of_story">本轮无需新增札记。</aftertalk>');
    await generateNotes();
    expect(notesState.records).toEqual([]); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(notesRun.status).toContain('本轮无需新增札记'); expect(notesRun.error).toBe('');
  });
  it('选「上一份札记」时跳过既没有问题也没有进度清单的记录', () => {
    const real = record('real', 1, '进度清单:\n- [未动笔] 去山里\n\n想问用户:\nQ1. 要不要带上她？凝嘤嘤暂定: 带上');
    const empty = { ...record('empty', 1, '本轮无需新增札记'), createdAt: 2 };
    seedData([real, empty], []);
    const last = buildNotesContext(ctx).at(-1)!.content;
    expect(last).toContain('要不要带上她'); expect(last).not.toContain('本轮无需新增札记\n[用户在面板');
  });
});

describe('已确认安排的注入（B46）', () => {
  function seedDecisions() {
    const note = record('n1', 1, 'Q1. 甲？凝嘤嘤暂定: 甲\nQ2. 乙？凝嘤嘤暂定: 乙\nQ3. 丙？凝嘤嘤暂定: 丙\nQ4. 丁？凝嘤嘤暂定: 丁');
    seedData([note], [
      decision('a', 'n1', 'Q1', '最早的待兑现' + '甲'.repeat(7000), 'pending', 1),
      decision('b', 'n1', 'Q2', '进行中的安排', 'in_progress', 2),
      decision('c', 'n1', 'Q3', '较新的待兑现' + '丙'.repeat(7000), 'pending', 3),
      decision('d', 'n1', 'Q4', '最新的待兑现' + '丁'.repeat(7000), 'pending', 4),
    ]);
  }
  it('记忆注入预算为 0（默认）时全部注入：进行中在前，待兑现按确认时间从新到旧', () => {
    enable(); seedDecisions();
    const plan = confirmedInjectionPlan();
    expect(plan).toMatchObject({ injected: 4, omitted: 0, total: 4 });
    const order = ['进行中的安排', '最新的待兑现', '较新的待兑现', '最早的待兑现'].map(t => plan.text.indexOf(t));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
  });
  it('填写了预算时清单最多 16000 字，注入放得下的部分并给出未注入的条数；不改写札记状态', () => {
    enable(); seedDecisions(); apiSettings.memoryBudgetTokens = 6000;
    const plan = confirmedInjectionPlan();
    expect(plan.injected).toBe(3); expect(plan.omitted).toBe(1); expect(plan.total).toBe(4);
    expect(plan.text).toContain('进行中的安排'); expect(plan.text).toContain('最新的待兑现'); expect(plan.text).toContain('较新的待兑现');
    expect(plan.text).not.toContain('最早的待兑现');
    const list = plan.text.split('\n').filter(line => line.startsWith('['));
    expect(list.filter(line => !line.startsWith('[戏外')).join('\n').length).toBeLessThanOrEqual(NOTES_INJECTION_LIMIT);
    expect(buildConfirmedInjection()).toBe(plan.text);
    expect(notesRun.status).toBe('');
  });
  it('注入关闭或没有安排时为空', () => {
    enable(); notesSettings.injectConfirmed = false; seedDecisions();
    expect(confirmedInjectionPlan()).toEqual({ text: '', injected: 0, omitted: 0, total: 0 });
  });
});

describe('札记请求的内容（B47/B9/B64）', () => {
  it('安排逐行列出状态、来自哪一楼札记的哪一问；不发内部 id 和时间戳，不发 JSON', () => {
    const note = record('n1', 1, 'Q1. 甲？凝嘤嘤暂定: 甲\nQ2. 乙？凝嘤嘤暂定: 乙');
    seedData([note], [decision('a', 'n1', 'Q1', '交还\n钥匙', 'in_progress', 1700000000001), decision('b', 'n1', 'Q2', '放弃登山', 'rejected', 1700000000002)]);
    const last = buildNotesContext(ctx).at(-1)!.content;
    expect(last).toContain('- [进行中] 第1楼札记 Q1：交还 钥匙');
    expect(last).toContain('- [已搁置] 第1楼札记 Q2：放弃登山');
    expect(last).not.toMatch(/uuid-|1700000000001|noteId|"status"|\{"/);
  });
  it('已完成、已取消、已搁置的只列最近 30 条；超出字数时从最新往前放并注明较早的省略了几条', () => {
    const note = record('n1', 1, 'Q1. 甲？凝嘤嘤暂定: 甲\nQ2. 乙？凝嘤嘤暂定: 乙\nQ3. 丙？凝嘤嘤暂定: 丙\nQ4. 丁？凝嘤嘤暂定: 丁');
    const notes = Array.from({ length: 40 }, (_, i) => ({ ...note, id: `n${i}` }));
    const decisions = notes.map((n, i) => decision(String(i), n.id, 'Q1', `第${i}条安排` + '长'.repeat(600), 'completed', i + 1));
    decisions.push(decision('live', 'n39', 'Q2', '仍要落实', 'pending', 100), decision('live2', 'n38', 'Q2', '第二条仍要落实', 'pending', 101));
    seedData(notes, decisions);
    const last = buildNotesContext(ctx).at(-1)!.content;
    const operated = last.slice(last.indexOf('[用户在面板操作过的安排'), last.indexOf('[当前仍要落实的安排'));
    expect(operated).toContain('第39条安排'); expect(operated).toContain('第二条仍要落实');
    expect(operated).not.toContain('第9条安排'); expect(operated).not.toContain('第10条安排');
    expect(operated.length).toBeLessThanOrEqual(NOTES_CONTEXT_LIMITS.decisions + 40);
    expect(operated).toMatch(/（另有 \d+ 条较早的安排因字数上限没有列出。）/);
    const active = last.slice(last.indexOf('[当前仍要落实的安排'));
    expect(active).toContain('- [待兑现] 第1楼札记 Q2：第二条仍要落实');
  });
  it('状态按重要程度排列，限字数时整条省略并注明；「摘要和状态最多读多少字」为 0 时不限制', () => {
    Object.assign(memory, {
      state: { time: '第三天傍晚', location: '旧港' },
      plans: [{ id: 'p1', kind: 'plan', content: '找到寄信人', status: 'open', createdAt: 1 }],
      items: Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, name: `物品${i}`, desc: '说明'.repeat(20), createdAt: 1, updatedAt: 1 })),
    });
    notesSettings.memoryChars = 1000;
    const limited = buildNotesContext(ctx)[1].content;
    const state = limited.slice(limited.indexOf('[当前宝书状态'));
    expect(state.indexOf('[未了结的计划与悬念]')).toBeLessThan(state.indexOf('[时间、地点与局势]'));
    expect(state).toContain('找到寄信人'); expect(state).toContain('当前地点：旧港');
    expect(state).toMatch(/因字数上限另有 \d+ 条状态没有列出：物品/);
    expect(state).not.toContain('物品59');
    notesSettings.memoryChars = 0;
    const full = buildNotesContext(ctx)[1].content;
    expect(full).toContain('物品59'); expect(full).not.toContain('没有列出');
  });
  it('「摘要和状态最多读多少字」可以存为 0（不限制），其余仍按 1000–40000', () => {
    notesSettings.memoryChars = 0; saveNotesSettings(); hydrateNotesSettings();
    expect(notesSettings.memoryChars).toBe(0);
    ctx.extensionSettings!.prism_book_notes_settings = { version: 1, memoryChars: 5, channel: {} }; hydrateNotesSettings();
    expect(notesSettings.memoryChars).toBe(1000);
  });
  it('正文预算随参考层数放宽；放不下的较早楼层不发，摘要从实际放进去的最早一层之前选取', () => {
    expect(notesRecentBudget(8)).toBe(24000); expect(notesRecentBudget(40)).toBe(120000);
    ctx = context(Array.from({ length: 12 }, (_, i) => message(`第${i}层`.padEnd(5000, '文'), { is_user: i % 2 === 0 })));
    notesSettings.recentFloors = 12;
    const nodes: ViewNode[] = [{ id: 'leaf', kind: 'leaf', level: 0, text: '较早楼层的摘要', childIds: [], msgIndex: 1, createdAt: 1, active: false }];
    vi.mocked(selectHistoryNodesBefore).mockReturnValue(nodes);
    const msgs = buildNotesContext(ctx);
    const recent = msgs[2].content;
    // 预算 36000，每层约 5000 字：第 5–11 层整层放下，第 4 层只放下开头（注明截断），更早的 4 层不发
    expect(recent).toContain('（更早的 4 层超出正文字数上限，没有列出，由上面的摘要覆盖。）');
    expect(recent).toContain('第4楼'); expect(recent).not.toContain('第3楼');
    expect(selectHistoryNodesBefore).toHaveBeenCalledWith(memory.summaries, ctx.chat, 4);
    expect(msgs[1].content).toContain('较早楼层的摘要');
  });
  it('札记读取记忆时不改记忆', () => {
    const before = copy(memory);
    buildNotesContext(ctx);
    expect(memory).toEqual(before); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
});
