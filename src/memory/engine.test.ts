import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { batchBackfill, checkResummary, currentSummaryPromise, handleGenerationIntercept, openingPendingFloor, cancelBatchBackfill, engineState, summarizeFloor, summarizeSelected } from './engine';
import { buildResummaryPrompt, buildSummaryThinking, RESUMMARY_THINKING_CHECKLIST, RESUMMARY_THINKING_PREFILL, RULE_SUMMARY_COMPOSITION, SUMMARY_OUTPUT_PROTOCOL } from './prompts';
import { renderSourceHints, SOURCE_HINTS_HEADER } from './sourceHints';
import { memory, memoryWriteIssue } from './store';
import { createEmptyMemory, type LeafExtra, type SummaryDelta } from './types';

const message = (isUser = false, overrides: Partial<STMessage> = {}): STMessage => ({
  name: isUser ? 'User' : 'Character',
  is_user: isUser,
  is_system: false,
  mes: isUser ? 'Start the story.' : 'The first response.',
  ...overrides,
});

const leaf = (): LeafExtra => ({
  id: 'first-page',
  text: 'An existing summary.',
  delta: {},
  createdAt: 0,
  swipe: 0,
  v: 1,
});

const summary = {
  summary: 'The story begins.',
  stateChanges: [],
  timeStart: '2026/9/7 10:00',
  timeEnd: '2026/9/7 10:05',
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify(summary));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});

afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function useChat(chat: STMessage[]) {
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat,
    name1: 'User',
    name2: 'Character',
    getCurrentChatId: () => 'opening-regression',
  } as STContext);
}

describe('openingPendingFloor', () => {
  it.each([
    ['empty chat', [], -1],
    ['only the first user message', [message(true)], -1],
    ['a real greeting before the user', [message(), message(true)], 0],
    ['a response after the first user message', [message(true), message()], -1],
    ['an omitted user message before the response', [
      message(true, { extra: { bbs_omit: true } }), message(),
    ], -1],
    ['a system notice before a real greeting', [
      message(false, { is_system: true, extra: { type: 'narrator' } }), message(),
    ], 1],
    ['multiple AI messages', [message(), message(true), message()], -1],
    ['an already summarized greeting', [message(false, { extra: { bbs_leaf: leaf() } })], -1],
    ['a greeting with complete time tags', [message(false, {
      mes: `<bbs_start>${summary.timeStart}</bbs_start>Greeting<bbs_end>${summary.timeEnd}</bbs_end>`,
    })], -1],
    ['a greeting missing its end tag', [message(false, {
      mes: `<bbs_start>${summary.timeStart}</bbs_start>Greeting`,
    })], 0],
  ] as const)('%s', (_name, chat, expected) => {
    expect(openingPendingFloor([...chat])).toBe(expected);
  });
});

describe('opening generation interception', () => {
  it.each([
    ['swipe', false],
    ['regenerate', false],
    ['swipe', true],
    ['regenerate', true],
  ] as const)('does not summarize the rewritten last AI (%s, greeting=%s)', async (type, greeting) => {
    const ai = message(false, { swipe_id: 1, swipes: ['The first response.'] });
    const chat = greeting ? [ai] : [message(true), ai];
    useChat(chat);
    const before = structuredClone(chat);
    const abort = vi.fn();

    expect(await handleGenerationIntercept(type, abort)).toBe(false);

    expect(abort).not.toHaveBeenCalled();
    expect(notices.toast).not.toHaveBeenCalled();
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(chat).toEqual(before);
    expect(memory.state.time).toBeFalsy();
  });

  it('does not attach the old page summary to the new swipe', async () => {
    const ai = message(false, {
      swipe_id: 1,
      swipes: ['The first response.'],
      extra: { bbs_leaf: leaf() },
    });
    const chat = [message(true), ai];
    useChat(chat);
    const before = structuredClone(chat);

    await handleGenerationIntercept('swipe', vi.fn());

    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(notices.toast).not.toHaveBeenCalled();
    expect(chat).toEqual(before);
  });

  it.each(['normal', 'swipe', 'regenerate'])(
    'still establishes a real greeting anchor when the last message is user (%s)',
    async type => {
      const chat = [message(), message(true)];
      useChat(chat);
      const abort = vi.fn();

      expect(await handleGenerationIntercept(type, abort)).toBe(false);

      expect(abort).not.toHaveBeenCalled();
      expect(notices.toast).toHaveBeenCalledOnce();
      expect(client.requestViaMainApi).toHaveBeenCalledOnce();
      expect(chat[0].extra?.bbs_leaf).toMatchObject({
        timeStart: summary.timeStart,
        timeEnd: summary.timeEnd,
        swipe: 0,
      });
    },
  );

  it('summarizes the first generated reply normally after the next user message', async () => {
    const chat = [message(true), message(), message(true)];
    useChat(chat);

    await handleGenerationIntercept('normal', vi.fn());
    await currentSummaryPromise();

    expect(notices.toast).not.toHaveBeenCalled();
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(chat[1].extra?.bbs_leaf?.text).toBe(summary.summary);
  });
});

describe('summary request roles', () => {
  const originalPrompts = { ...settings.apiSettings.prompts };
  const originalBatch = {
    batchMaxFloors: settings.apiSettings.batchMaxFloors,
    batchMaxChars: settings.apiSettings.batchMaxChars,
  };

  beforeEach(() => {
    Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
    Object.assign(settings.apiSettings, { batchMaxFloors: 2, batchMaxChars: 10000 });
  });

  afterEach(() => {
    Object.assign(settings.apiSettings.prompts, originalPrompts);
    Object.assign(settings.apiSettings, originalBatch);
  });

  it.each([false, true])('sends single-floor instructions separately and stores only final JSON (custom=%s)', async custom => {
    if (custom) settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const chat = [message()];
    useChat(chat);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `<thinking>Source and coverage records.</thinking>${JSON.stringify(summary)}`,
    );

    await summarizeFloor(0);

    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const tail = vi.mocked(client.requestViaMainApi).mock.calls[0][0].slice(-4);
    const thinking = buildSummaryThinking('User');
    expect(tail).toEqual([
      { role: 'system', content: expect.stringContaining(custom ? '【棱镜宝书主角档案兼容协议】' : '【物品规则】') },
      { role: 'user', content: expect.stringContaining('The first response.') },
      { role: 'system', content: thinking.checklist },
      { role: 'assistant', content: thinking.prefill },
    ]);
    expect(tail[0].content).not.toContain('The first response.');
    expect(tail[1].content).toContain('[M1-P1] The first response.');
    expect(tail[1].content).not.toContain('═══ 【物品规则】');
    expect(tail[1].content).not.toContain(SOURCE_HINTS_HEADER);
    expect(tail.map(m => m.content).join('\n').split(RULE_SUMMARY_COMPOSITION)).toHaveLength(custom ? 1 : 2);
    expect(tail.map(m => m.content).join('\n').split(SUMMARY_OUTPUT_PROTOCOL)).toHaveLength(2);
    expect(chat[0].extra?.bbs_leaf?.text).toBe(summary.summary);
  });

  it('stores structured changes alongside a brief audit and summary', async () => {
    const chat = [message(false, {
      mes: 'User enters the stone Archive. Archivist gives User the brass vault key and agrees to meet on 2026/9/10 at 10:00.',
    })];
    useChat(chat);
    const changes = {
      location: 'Archive',
      locationPath: ['Archive'],
      sceneFocus: { situation: 'User meets Archivist in the Archive.', participants: ['User', 'Archivist'] },
      items: { add: [{ name: 'Vault key', desc: 'A brass key.', qty: 1, carried: true }] },
      scenes: { add: [{ path: ['Archive'], desc: 'A stone archive.' }] },
      npcs: { add: [{ name: 'Archivist', title: 'Keeper of the archive', location: 'Archive' }] },
      plans: { add: [{ kind: 'plan', content: 'Meet Archivist.', targetTime: '2026/9/10 10:00' }] },
    } satisfies SummaryDelta;
    const text = 'User entered the Archive, received its vault key and arranged a meeting with Archivist.';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `<thinking>Key, place, contact and appointment recorded.</thinking>${JSON.stringify({ ...summary, summary: text, ...changes, npcs: { add: [{ ...changes.npcs.add[0], locationEvidence: chat[0].mes }] }, stateChanges: Object.keys(changes) })}`,
    );

    await summarizeFloor(0);

    expect(chat[0].extra?.bbs_leaf).toMatchObject({ text, delta: changes });
    expect(memory.state).toMatchObject({
      location: changes.location, locationPath: changes.locationPath, sceneFocus: changes.sceneFocus,
    });
    expect(memory.items).toEqual([expect.objectContaining(changes.items.add[0])]);
    expect(memory.scenes).toHaveLength(1);
    expect(memory.scenes[0].desc).toBe(changes.scenes.add[0].desc);
    expect(memory.npcs).toEqual([expect.objectContaining(changes.npcs.add[0])]);
    expect(memory.plans).toEqual([expect.objectContaining(changes.plans.add[0])]);
    expect(JSON.stringify(chat[0].extra?.bbs_leaf)).not.toContain('Key, place, contact and appointment recorded.');
  });

  it.each(['\n', '\r\n'])('numbers cleaned source paragraphs without changing stored chat (newline=%j)', async newline => {
    const body = [
      '<thinking>Discarded audit.</thinking>',
      `<bbs_start>${summary.timeStart}</bbs_start>`,
      '<content>',
      'The first response.',
      '',
      ' \t',
      'The second paragraph.',
      '</content>',
      `<bbs_end>${summary.timeEnd}</bbs_end>`,
      'Discarded status panel.',
    ].join(newline);
    const chat = [message(true), message(false, { mes: body })];
    useChat(chat);

    await summarizeFloor(1);

    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].at(-3)?.content ?? '';
    expect(material).toContain('【用户·User】\n[M1-P1] Start the story.');
    expect(material).toContain([
      '【角色·Character】',
      `[M2-P1] (起始时间:${summary.timeStart})`,
      '[M2-P2] <content>',
      '[M2-P3] The first response.',
      '[M2-P4] The second paragraph.',
      '[M2-P5] </content>',
      `[M2-P6] (结束时间:${summary.timeEnd})`,
    ].join('\n'));
    expect(material).not.toContain('Discarded');
    expect(material).not.toContain('[M2-P7]');
    expect(chat[0].mes).toBe('Start the story.');
    expect(chat[1].mes).toBe(body);
    expect(chat[1].extra?.bbs_leaf?.text).toBe(summary.summary);
  });

  it.each([
    [false, '\n'], [false, '\r\n'], [true, '\n'], [true, '\r\n'],
  ] as const)('attaches source indexes from cleaned user and AI paragraphs only (custom=%s, newline=%j)', async (custom, newline) => {
    if (custom) settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const userBody = '我已经搬出旧宿舍，独自住进条件更好的公寓。';
    const paragraphs = [
      '「谷口风速已经过了九级，气温降到零下三十三度。」',
      '「能见度不足三十米，红外热成像仪的探测距离会被压制在大半以内。」',
      '「风太大了，我的狙击铳很难锁定主峰高地！」',
      '「谷口两侧有暗坑，必须先放侦察蜂排查……」',
    ];
    const body = [
      '<thinking>无法使用的旧检查记录，不应进入提醒。</thinking>',
      `<bbs_start>${summary.timeStart}</bbs_start>`,
      '<content>',
      ...paragraphs,
      'The door opened.',
      '</content>',
      `<bbs_end>${summary.timeEnd}</bbs_end>`,
      '无法使用的状态栏，不应进入提醒。',
    ].join(newline);
    const chat = [message(true, { mes: userBody }), message(false, { mes: body })];
    useChat(chat);

    await summarizeFloor(1);

    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    const material = messages.at(-3)!.content;
    expect(material.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    const hints = material.split(SOURCE_HINTS_HEADER)[1];
    const expected = [
      `[M1-P1] ${userBody}`,
      ...paragraphs.map((text, index) => `[M2-P${index + 3}] ${text}`),
    ];
    for (const line of expected) {
      const id = line.slice(0, line.indexOf(' '));
      expect(hints.split(id)).toHaveLength(2);
      expect(hints).not.toContain(line);
      expect(material.split(line)).toHaveLength(2);
      expect(material.split(SOURCE_HINTS_HEADER)[0]).toContain(line);
      expect(messages.filter(m => m.role === 'system').every(m => !m.content.includes(line))).toBe(true);
    }
    expect(hints).not.toContain('The door opened.');
    expect(material).not.toContain('不应进入提醒');
    expect(chat.map(m => m.mes)).toEqual([userBody, body]);
    expect(chat[1].extra?.bbs_leaf?.text).toBe(summary.summary);
    if (custom) expect(material).toContain('CUSTOM 【用户·User】');
  });

  it('does not select reminder sources from history or later turns', async () => {
    const history = '历史记录：旧设备无法使用。';
    const future = '未来消息：设备已经恢复正常。';
    const body = '本届联赛参赛者中最强的学生是二转巅峰。';
    const chat = [
      message(false, { extra: { bbs_leaf: { ...leaf(), text: history } } }),
      message(true),
      message(false, { mes: body }),
      message(false, { mes: future }),
    ];
    useChat(chat);

    await summarizeFloor(2);

    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].at(-3)!.content;
    const hints = material.split(SOURCE_HINTS_HEADER)[1];
    expect(material).toContain(history);
    expect(hints).toContain('[M3-P1]');
    expect(hints).not.toContain(body);
    expect(material.split(body)).toHaveLength(2);
    expect(hints).not.toContain(history);
    expect(hints).not.toContain('[M1-');
    expect(material).not.toContain(future);
    expect(hints).not.toContain('[M4-');
  });

  it.each(['single', 'batch'] as const)('v17 forwards ownership and clause checks without changing source (%s)', async mode => {
    const body = '设备借用新增规定：延迟归还需补交说明；原保密条款没有取消。队员此前留在宿舍，之后没有新消息。';
    const chat = [message(true), message(false, { mes: body })];
    useChat(chat);
    // Fixed mock only verifies production request and persistence, not model reasoning.
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ ...summary, summary: '借用设备新增迟还说明要求，原保密条款保留。' }));
    if (mode === 'single') await summarizeFloor(1);
    else expect(await batchBackfill({ floors: [1] })).toMatchObject({done:1,total:1});
    const tail = vi.mocked(client.requestViaMainApi).mock.calls[0][0].slice(-4);
    expect(tail[0].content).toContain('content 是完整替换文本，不是新增半句');
    expect(tail[0].content).toContain('借用期限、违约后果交给 summary 与符合准入的 plans');
    expect(tail[0].content).toContain('没有本次位置证据，就不在摘要末尾补写离场者仍在旧处');
    expect(tail[1].content).toContain(body);
    expect(tail[2].content).toContain('保留的每个后果能否在来源中找到相同触发条件');
    expect(chat[1].extra?.bbs_leaf?.text).toBe('借用设备新增迟还说明要求，原保密条款保留。');
    expect(chat[1].mes).toContain(body);
  });

  it('processes floors in order, commits state and isolates source reminders', async () => {
    const bodies = ['风速超过九级，气温降到零下三十三度。', '她已经搬出旧居，生活条件改善了。'];
    const chat = [message(true), message(false, { mes: bodies[0] }), message(true), message(false, { mes: bodies[1] })];
    useChat(chat);
    vi.mocked(client.requestViaMainApi)
      .mockResolvedValueOnce(JSON.stringify({ ...summary, summary: 'First result.', location: 'Archive', stateChanges: ['location'] }))
      .mockResolvedValueOnce(JSON.stringify({ ...summary, summary: 'Second result.' }));
    expect(await batchBackfill({ floors: [3, 1, 3] })).toMatchObject({ done: 2, total: 2 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(client.requestViaMainApi).mock.calls.map(c => c[0].at(-3)!.content);
    expect(first.split(SOURCE_HINTS_HEADER)[1]).toContain('[M2-P1]');
    expect(first.split(SOURCE_HINTS_HEADER)[1]).not.toContain(bodies[0]);
    expect(first.split(bodies[0])).toHaveLength(2);
    expect(first).not.toContain(bodies[1]);
    expect(second.split(SOURCE_HINTS_HEADER)[1]).toContain('[M4-P1]');
    expect(second.split(SOURCE_HINTS_HEADER)[1]).not.toContain(bodies[1]);
    expect(second.split(bodies[1])).toHaveLength(2);
    expect(second.split(SOURCE_HINTS_HEADER)[1]).not.toContain('[M2-P1]');
    expect(second).toContain('Archive');
    expect(second).toContain('First result.');
    expect(chat[1].extra?.bbs_leaf?.delta.location).toBe('Archive');
    expect(chat[3].extra?.bbs_leaf?.text).toBe('Second result.');
  });
});

describe.each(['automatic', 'manual'] as const)('compression audit output (%s)', mode => {
  const originalPrompts = { ...settings.apiSettings.prompts };
  const original = {
    leafBatchThreshold: settings.apiSettings.leafBatchThreshold,
    leafKeepRecent: settings.apiSettings.leafKeepRecent,
    resummaryThreshold: settings.apiSettings.resummaryThreshold,
    higherResummaryThreshold: settings.apiSettings.higherResummaryThreshold,
    summaryMaxRetries: settings.apiSettings.summaryMaxRetries,
  };

  beforeEach(() => {
    Object.assign(settings.apiSettings.prompts, { resummary: '', resummary2: '' });
    Object.assign(settings.apiSettings, {
      leafBatchThreshold: 2,
      leafKeepRecent: 0,
      resummaryThreshold: 2,
      higherResummaryThreshold: 2,
      summaryMaxRetries: 0,
    });
  });

  afterEach(() => {
    Object.assign(settings.apiSettings.prompts, originalPrompts);
    Object.assign(settings.apiSettings, original);
  });

  function seedInputs(level: number, texts?: string[]): string[] {
    const chat = [0, 1].map(index => message(false, {
      extra: { bbs_leaf: { ...leaf(), id: `leaf-${index}`, text: texts?.[index] ?? leaf().text, createdAt: index } },
    }));
    useChat(chat);
    if (level === 0) return ['leaf-0', 'leaf-1'];
    memory.summaries.push(...[0, 1].map(index => ({
      id: `input-${index}`,
      text: texts?.[index] ?? `Earlier summary ${index}.`,
      level,
      createdAt: index,
      auto: true,
      childIds: [`leaf-${index}`],
    })));
    return ['input-0', 'input-1'];
  }

  async function compress(ids: string[]) {
    return mode === 'automatic' ? checkResummary() : (await summarizeSelected(ids)).made;
  }

  it.each([0, 1, 2])('allows unrelated tail streaming while selected sources remain unchanged (level=%s)', async level => {
    const ids = seedInputs(level);
    const chat = context.getContext()!.chat;
    chat.push(message(false, { mes: 'New response is streaming.' }));
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      chat.at(-1)!.mes += ' More text.';
      chat.push(message(true, { mes: 'A later instruction.' }));
      return JSON.stringify(summary);
    });
    expect(await compress(ids)).toBe(1);
    expect(memory.summaries.at(-1)?.childIds).toEqual(ids);
  });

  it('allows unrelated memory changes without discarding selected summaries', async () => {
    const ids = seedInputs(0);
    settings.apiSettings.resummaryThreshold = 20;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      memory.summaries.push({ id: 'unrelated', text: 'Unrelated imported history.', level: 1,
        createdAt: 99, auto: false, childIds: [] });
      return JSON.stringify(summary);
    });
    expect(await compress(ids)).toBe(1);
    expect(memory.summaries.at(-1)?.childIds).toEqual(ids);
  });

  it.each(['text', 'raw', 'swipe', 'omit', 'delete', 'parent', 'child', 'time', 'chat', 'metadata'] as const)(
    'still rejects changed source or session: %s', async mutation => {
      const ids = seedInputs(1);
      const ctx = context.getContext()!;
      const before = memory.summaries.length;
      vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
        if (mutation === 'text') memory.summaries[0].text = 'Edited summary.';
        if (mutation === 'raw') ctx.chat[0].mes = 'Edited actual source.';
        if (mutation === 'swipe') ctx.chat[0].swipe_id = 1;
        if (mutation === 'omit') ctx.chat[0].extra!.bbs_omit = true;
        if (mutation === 'delete') ctx.chat.splice(0, 1);
        if (mutation === 'parent') memory.summaries.push({ id: 'other-parent', text: 'Merged elsewhere.',
          level: 2, createdAt: 100, auto: false, childIds: ids });
        if (mutation === 'child') ctx.chat[0].extra!.bbs_leaf!.text = 'Edited descendant.';
        if (mutation === 'time') memory.summaries[0].timeStart = 'A different day';
        if (mutation === 'chat') vi.mocked(context.getContext).mockReturnValue({ ...ctx, chat: [...ctx.chat], getCurrentChatId: () => 'different-chat' });
        if (mutation === 'metadata') ctx.chatMetadata = {};
        return JSON.stringify(summary);
      });
      expect(await compress(ids)).toBe(0);
      expect(memory.summaries).toHaveLength(before + (mutation === 'parent' ? 1 : 0));
      expect(engineState.lastError).toContain('结果未写入');
      expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    },
  );

  it.each(['descendant-owner', 'duplicate-comp', 'duplicate-leaf'] as const)('rejects ambiguous descendant identity during request: %s', async mutation => {
    const ids = seedInputs(1);
    const ctx = context.getContext()!;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      if (mutation === 'descendant-owner') memory.summaries.push({ id: 'foreign-parent', text: 'Other tree.', level: 1, createdAt: 20, auto: false, childIds: ['leaf-0'] });
      if (mutation === 'duplicate-comp') memory.summaries.push({ ...memory.summaries[0] });
      if (mutation === 'duplicate-leaf') ctx.chat.push(message(false, { extra: { bbs_leaf: { ...ctx.chat[0].extra!.bbs_leaf! } } }));
      return JSON.stringify(summary);
    });
    expect(await compress(ids)).toBe(0);
    expect(engineState.lastError).toContain('结果未写入');
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
  });

  it('reports an ambiguous initial descendant without rejecting the public operation', async () => {
    const ids = seedInputs(1);
    expect(memoryWriteIssue()).toBe('');
    const ctx = context.getContext()!;
    ctx.chat.push(message(false, { extra: { bbs_leaf: { ...ctx.chat[0].extra!.bbs_leaf! } } }));
    expect(await compress(ids)).toBe(0);
    expect(engineState.lastError).toContain('结果未写入');
    expect(engineState.running).toBe(false);
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
  });

  it('accepts default swipe metadata initialization without a real swipe change', async () => {
    const ids = seedInputs(1);
    const ctx = context.getContext()!;
    delete ctx.chat[0].swipe_id;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      ctx.chat[0].swipe_id = 0;
      return JSON.stringify(summary);
    });
    expect(await compress(ids)).toBe(1);
  });

  it.each([0, 1, 2])('sends a checklist and prefill, storing only final data (input level=%s)', async level => {
    const ids = seedInputs(level);
    const finalSummary = 'The confirmed merged facts.';
    // A prefilled completion may omit the opening tag from the returned text.
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `F1 | source 1 | confirmed fact\nCoverage: F1 | confirmed merged facts\n</thinking>\n${JSON.stringify({ summary: finalSummary })}`,
    );

    expect(await compress(ids)).toBe(1);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    expect(messages.slice(-4)).toEqual([
      { role: 'system', content: expect.stringContaining('{ "summary":') },
      expect.objectContaining({ role: 'user' }),
      { role: 'system', content: RESUMMARY_THINKING_CHECKLIST },
      { role: 'assistant', content: RESUMMARY_THINKING_PREFILL },
    ]);
    const sourceText = level === 0 ? 'An existing summary.' : 'Earlier summary 0.';
    expect(messages.at(-3)?.content).toContain(sourceText);
    expect(messages.at(-3)?.content).toContain(`[1] ${sourceText}`);
    expect(messages.at(-3)?.content).toContain('[2] ');
    expect(messages.at(-3)?.content).not.toMatch(/\[M\d+-P\d+\]/);
    expect(messages.at(-4)?.content).not.toContain(sourceText);
    expect(messages.at(-4)?.content).toContain(RULE_SUMMARY_COMPOSITION);
    expect(messages.at(-3)?.content).not.toContain('【输出要求】');
    expect(messages.at(-3)?.content).not.toContain(SOURCE_HINTS_HEADER);
    expect(messages.map(m => m.content).join('\n').split(SUMMARY_OUTPUT_PROTOCOL)).toHaveLength(2);
    const saved = memory.summaries.at(-1);
    expect(saved).toMatchObject({ text: finalSummary, level: level + 1, childIds: ids });
    expect(JSON.stringify(saved)).not.toContain('Coverage:');
  });

  it.each([0, 1, 2])('v17 forwards clause updates and result-first examples (input level=%s)', async level => {
    const texts = ['泄露资料则终止后续合作。成员此前在值班室养伤。', '泄露资料或迟交则扣本次补贴。主角决定改为远程提交；没有成员的新消息。'];
    const ids = seedInputs(level, texts);
    // Fixed response verifies transport/storage only. It is not a semantic-generation result.
    const result = '泄露资料则终止后续合作；泄露或迟交则扣本次补贴。主角决定改为远程提交。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({summary:result}));
    expect(await compress(ids)).toBe(1);
    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    const system = messages.at(-4)!.content;
    for(const rule of ['旧条款未被明确替代就独立保留', '明确撤销或替代的只更新对应条款', '此前/以后、当次/后续、部分/全部逐词对照', '没有本次位置证据，就不在摘要末尾补写离场者仍在旧处', '留下动作不等于留下信息', '只写归还及验收结果，不附加一遍旧惩罚']) expect(system).toContain(rule);
    for(const text of texts) expect(messages.at(-3)!.content).toContain(text);
    expect(messages.at(-2)!.content).toContain('保留的每个后果能否在来源中找到相同触发条件');
    expect(memory.summaries.at(-1)).toMatchObject({text:result,level:level+1,childIds:ids});
  });

  it.each([0, 1, 2])('v16 forwards fact-first scope, space and time contracts (input level=%s)', async level => {
    const texts = ['[09:10–09:40] 中央设展台，楼梯在大厅边缘。损坏封签则以后的往来作废。', '她收好文件后离开，脚踝扭伤仍不能负重，决定改走栈桥。'];
    const ids = seedInputs(level, texts);
    // Fixed response proves request/storage transport, not generated semantic fidelity.
    const result = '队员决定改走栈桥，脚踝扭伤仍不能负重。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: result }));
    expect(await compress(ids)).toBe(1);
    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    const system = messages.at(-4)!.content;
    for (const rule of ['先确定共用事实，再分发到摘要和必要状态字段', '歧义未消除时只保留必要原话和限定', '中央的展台、边缘的楼梯不能互换位置', '范围端点不分配给动作']) expect(system).toContain(rule);
    for (const text of texts) expect(messages.at(-3)!.content).toContain(text);
    expect(messages.at(-2)!.content).toContain('横向核对同一事实');
    expect(memory.summaries.at(-1)).toMatchObject({ text: result, level: level + 1, childIds: ids });
  });

  it.each([0, 1, 2])('v15 forwards whole-clause fusion rules and unchanged source pairs (input level=%s)', async level => {
    const texts = ['泄露研究资料会终止后续合作。', '泄露研究资料或迟交超过三日会取消本次补贴。团队决定改用远程提交。'];
    const ids = seedInputs(level, texts);
    const result = '泄露资料将终止后续合作；泄露或迟交超过三日将取消本次补贴。团队决定改为远程提交。';
    // Fixed mock response checks transport/storage only, not whether a model follows the rules.
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: result }));
    expect(await compress(ids)).toBe(1);
    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    const system = messages.at(-4)!.content;
    expect(system).toContain(level === 0 ? '【总结流程：按事项重组】' : '【二次总结流程：阶段与有效后果】');
    expect(system).toContain('最小合并单位是完整命题');
    expect(system).toContain('共享条件不代表共享后果');
    expect(system).toContain('同句并列不证明同行、归属或因果');
    expect(system).toContain('段落起止是范围，不是每个事件的发生时刻');
    for (const text of texts) expect(messages.at(-3)!.content).toContain(text);
    expect(messages.at(-2)!.content).toContain('行动转变与有效限制是否被装饰细节挤掉');
    expect(memory.summaries.at(-1)).toMatchObject({ text: result, level: level + 1, childIds: ids });
  });

  it.each([
    [0, false], [1, false], [2, false], [1, true],
  ] as const)('copies numbered sources with time ranges without inflating budgets (input level=%s, custom=%s)', async (level, custom) => {
    if (custom) {
      settings.apiSettings.prompts.resummary2 = 'CUSTOM {{content}}\nBUDGET {{target_min}}-{{target_max}}';
    }
    const texts = [
      '本段能见度不足三十米，红外探测距离受限。',
      '她已经搬出旧居，生活条件改善了。',
    ];
    const ids = seedInputs(level, texts);
    const inputs = level === 0
      ? context.getContext()!.chat.map(m => m.extra!.bbs_leaf!)
      : [...memory.summaries];
    for (const input of inputs) {
      input.timeStart = summary.timeStart;
      input.timeEnd = summary.timeEnd;
    }
    const sources = texts.map((text, index) => ({
      source: `[${index + 1}]`,
      text: `(${summary.timeStart} – ${summary.timeEnd}) ${text}`,
    }));
    const content = sources.map(({ source, text }) => `${source} ${text}`).join('\n\n');
    const expected = buildResummaryPrompt({ user: 'User', char: 'Character', content, level: level + 1 });

    expect(await compress(ids)).toBe(1);

    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    expect(messages.at(-4)?.content).toBe(expected.system);
    expect(messages.at(-3)?.content).toBe(expected.user + renderSourceHints(sources));
    expect(messages.at(-3)?.content.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    expect(messages.at(-3)?.content).not.toMatch(/\[M\d+-P\d+\]/);
    expect(inputs.map(input => input.text)).toEqual(texts);
    expect(memory.summaries.at(-1)?.text).toBe(summary.summary);
    expect(messages.at(-2)?.content).toBe(RESUMMARY_THINKING_CHECKLIST);
    const [main, hints] = messages.at(-3)!.content.split(SOURCE_HINTS_HEADER);
    for (const { source, text } of sources) {
      expect(main).toContain(`${source} ${text}`);
      expect(messages.at(-3)!.content.split(text)).toHaveLength(2);
      expect(hints.split(source)).toHaveLength(2);
      expect(hints).not.toContain(text);
    }
    expect(hints).not.toContain(summary.timeStart);
    if (custom) {
      expect(messages.at(-3)?.content).toContain('CUSTOM ');
      expect(settings.apiSettings.prompts.resummary2).toBe('CUSTOM {{content}}\nBUDGET {{target_min}}-{{target_max}}');
    }
  });

  it('does not save JSON embedded in an unfinished audit', async () => {
    const ids = seedInputs(0);
    vi.mocked(client.requestViaMainApi).mockResolvedValue('<thinking>{"summary":"unfinished audit"}');

    expect(await compress(ids)).toBe(0);
    expect(memory.summaries).toHaveLength(0);
  });
});
