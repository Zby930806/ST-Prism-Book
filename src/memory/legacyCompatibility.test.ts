import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { leafValid } from './apply';
import { inspectCompatibility } from './compatibility';
import { checkResummary, currentSummaryPromise, engineState, openingPendingFloor, pendingAiFloors, runSummary, summarizeSelected } from './engine';
import { ensureRecallIndex, scheduleVectorIndex, syncVectorIndex, vectorIndexableHere } from './vector';
import * as vectorStore from './vector/store';
import { refreshInjection, renderHistoryNodes, selectHistoryNodesBefore, selectInjectionNodes } from './inject';
import {
  compatibilityState, convertLegacyMemory, derivedMeta, flushLeavesNow, loadMemory, memory,
  memoryWriteIssue, recomputeDerived, saveMemory, scheduleLeafFlush,
} from './store';
import { createEmptyMemory, MEMORY_KEY, type LeafExtra, type MemSummary, type StoredDelta } from './types';

// Only the host/persistence/network boundaries are mocked. Loading, validation,
// replay, forest selection, prompt rendering and V2 conversion are production code.
const savedSettings = JSON.stringify(settings.apiSettings);
let expectedMockRequests = 0;
const BACKUP_KEY = 'prism_book_legacy_backup';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const noNetwork = () => { throw new Error('Compatibility regression must not call a model/network'); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function ai(index: number, hidden = true): STMessage {
  return {
    name: '旧角色', is_user: false, is_system: hidden, swipe_id: 0,
    mes: `原正文 ${index}：这一楼原文不应被重写。`,
    extra: { ...(hidden ? { bbs_hidden: true } : {}), otherPlugin: { keep: index } },
  };
}

function storedLeaf(index: number, delta: StoredDelta = {}): LeafExtra {
  // Deliberately retain whitespace, Unicode and a stale srcHash: page identity,
  // not the old source hash, decides whether a legacy leaf is reusable.
  return {
    id: `legacy-leaf-${index}`, text: `  旧叶子正文【${index}】\n保持原措辞。  `,
    delta, createdAt: 1000 + index, swipe: 0, v: 1,
    timeLabel: '2031/4/12 19:10', srcHash: 'old-hash-do-not-revalidate',
    legacyExtension: { index, note: '未知字段不能丢' },
  } as LeafExtra;
}

function legacyTree(count = 1800) {
  const chat = Array.from({ length: count }, (_, i) => {
    const message = ai(i);
    const leaf = storedLeaf(i);
    // Historical first-page records may omit both version and page markers.
    if (i % 2 === 0) {
      delete (leaf as Partial<LeafExtra>).v;
      delete leaf.swipe;
    }
    message.extra!.bbs_leaf = leaf;
    return message;
  });
  const summaries: MemSummary[] = [];
  for (let start = 0; start < count; start += 30) {
    summaries.push({
      id: `legacy-l1-${start / 30}`, text: `  旧L1独有正文【${start / 30}】\n不得重写。  `,
      level: 1, createdAt: 4000 + start, auto: false,
      childIds: chat.slice(start, start + 30).map(m => m.extra!.bbs_leaf!.id),
      legacyExtension: { keep: true },
    } as MemSummary);
  }
  const l1 = [...summaries];
  for (let start = 0; start < l1.length; start += 10) {
    summaries.push({
      id: `legacy-l2-${start / 10}`, text: `  旧L2独有正文【${start / 10}】\n完整旧历史。  `,
      level: 2, createdAt: 8000 + start, auto: true,
      childIds: l1.slice(start, start + 10).map(s => s.id),
      legacyExtension: { keep: 'L2' },
    } as MemSummary);
  }
  return { chat, raw: {
    version: 3, summaries,
    varsTemplate: { json: { score: 10 }, meaning: '旧变量定义', rule: '旧规则' },
    legacyMetadata: { owner: '原插件', revision: 7 },
  } };
}

function useChat(chat: STMessage[], raw: unknown) {
  const host = {
    chat, chatMetadata: { [MEMORY_KEY]: raw } as Record<string, unknown>,
    name1: '林舟', name2: '旧角色', getCurrentChatId: () => 'legacy-compatibility-regression',
    saveChat: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveMetadata: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn(),
  };
  vi.spyOn(context, 'getContext').mockReturnValue(host as unknown as STContext);
  return host;
}

function expectNoSave(host: ReturnType<typeof useChat>) {
  expect(host.saveChat).not.toHaveBeenCalled();
  expect(host.saveMetadata).not.toHaveBeenCalled();
  expect(host.saveMetadataDebounced).not.toHaveBeenCalled();
}

function legacyV2() {
  const chat = [ai(0, false)];
  const leaf = storedLeaf(0, {
    time: '2031/4/12 19:10', location: '旧厨房',
    protagonist: { condition: '右腕仍受伤' },
    items: { add: [{ name: '旧地图', qty: 2, carried: true }] },
    plans: { add: [{ kind: 'plan', content: '归还旧地图', targetTime: '2031/4/13 20:00' }] },
    varOps: [{ op: 'add', path: 'score', delta: 3 }],
  });
  const summary = { ...leaf, level: 0, coveredIndices: [0], auto: false };
  // V2 predates the message leaf's v/swipe markers.
  delete (summary as Partial<typeof summary>).v;
  delete summary.swipe;
  const parent = {
    id: 'v2-l1', text: '  V2压缩原文\n保留换行。  ', level: 1, childIds: [summary.id],
    createdAt: 2222, auto: false, customParent: { keep: 'yes' },
  };
  const raw = {
    version: 2, summaries: [summary, parent],
    varsTemplate: { json: { score: 10 }, meaning: '旧字段含义', rule: '旧更新规则' },
    customTop: { keep: ['旧字段', 2] },
  };
  return { chat, raw, summary, parent };
}

beforeEach(() => {
  vi.useFakeTimers();
  expectedMockRequests = 0;
  Object.assign(engineState, { running: false, lastError: '', lastRunAt: 0 });
  Object.assign(memory, createEmptyMemory());
  Object.assign(compatibilityState, { mode: 'ready', leaves: 0, summaries: 0, issues: [], conversion: [], converting: false });
  Object.assign(settings.apiSettings, {
    summaryOnlyMode: false, memoryBudgetTokens: 0, verbosity: 'detailed', summaryMaxRetries: 0,
    leafBatchThreshold: 100, leafKeepRecent: 0, resummaryThreshold: 100, higherResummaryThreshold: 100,
    varsGlobalTemplate: { json: {}, meaning: '', rule: '' }, varsTemplateByChar: {},
  });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  vi.spyOn(client, 'requestViaMainApi').mockImplementation(noNetwork);
  vi.spyOn(client, 'requestCompletion').mockImplementation(noNetwork);
  vi.stubGlobal('fetch', vi.fn(noNetwork));
});

afterEach(async () => {
  try {
    await currentSummaryPromise();
    // The only permitted calls are explicitly supplied local mock completions.
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(expectedMockRequests);
    expect(client.requestCompletion).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.assign(settings.apiSettings, JSON.parse(savedSettings));
  }
});

describe('1800 valid legacy leaves and the real L1/L2 loading/injection paths', () => {
  it('loads all 1800 leaves and 60 L1 + 6 L2 nodes without saving, rewriting source or scheduling persistence', async () => {
    const { chat, raw } = legacyTree();
    const host = useChat(chat, raw);
    const original = JSON.stringify({ chat, metadata: host.chatMetadata });
    expect(chat.every(leafValid)).toBe(true);
    loadMemory();
    expect(compatibilityState).toMatchObject({ mode: 'ready', leaves: 1800, summaries: 66, issues: [] });
    expect(derivedMeta.leaves).toHaveLength(1800);
    expect(derivedMeta.leaves.every(l => !l.stale)).toBe(true);
    expect(derivedMeta.pendingFloors).toEqual([]);
    expect(memory.summaries.map(s => s.id)).toEqual(raw.summaries.map(s => s.id));
    await vi.runAllTimersAsync();
    expectNoSave(host);
    expect(JSON.stringify({ chat, metadata: host.chatMetadata })).toBe(original);
  });

  it('preserves historical compressed text verbatim in the loaded memory mirror', () => {
    const { chat, raw } = legacyTree();
    useChat(chat, raw);
    loadMemory();
    expect(memory.summaries.map(s => s.text)).toEqual(raw.summaries.map(s => s.text));
    for (const summary of memory.summaries) {
      expect(summary).toMatchObject(raw.summaries.find(s => s.id === summary.id)!);
    }
  });

  it('uses L2 in both main-chat and summary history contexts, never also emitting its L1/leaf descendants', () => {
    const { chat, raw } = legacyTree();
    const host = useChat(chat, raw);
    loadMemory();
    const l2 = raw.summaries.filter(s => s.level === 2);
    const mainNodes = selectInjectionNodes(memory.summaries, chat);
    const summaryNodes = selectHistoryNodesBefore(memory.summaries, chat, 1800);
    expect(mainNodes.map(n => n.id)).toEqual(l2.map(s => s.id));
    expect(summaryNodes.map(n => n.id)).toEqual(l2.map(s => s.id));
    refreshInjection();
    const injected = host.setExtensionPrompt.mock.calls.find(([key]) => key === 'baibai_book_memory_history')?.[1];
    expect(typeof injected).toBe('string');
    const history = renderHistoryNodes(summaryNodes);
    for (const root of l2) {
      expect(injected).toContain(root.text.trim());
      expect(history).toContain(root.text.trim());
      expect(injected.split(root.text.trim())).toHaveLength(2);
      expect(history.split(root.text.trim())).toHaveLength(2);
    }
    for (const text of [injected, history]) {
      expect(text).not.toContain('旧L1独有正文');
      expect(text).not.toContain('旧叶子正文');
      expect(text).not.toContain('原正文');
    }
    expectNoSave(host);
  });

  it('keeps summary-history selection independent of whether old message bodies are hidden', () => {
    const { chat, raw } = legacyTree();
    for (const message of chat) { message.is_system = false; delete message.extra!.bbs_hidden; }
    useChat(chat, raw);
    loadMemory();
    expect(selectInjectionNodes(memory.summaries, chat)).toEqual([]);
    expect(selectHistoryNodesBefore(memory.summaries, chat, 1800).map(n => n.id))
      .toEqual(raw.summaries.filter(s => s.level === 2).map(s => s.id));
    // A cutoff inside L2 must not leak later narrative from that L2.
    const partial = selectHistoryNodesBefore(memory.summaries, chat, 30);
    expect(partial.map(n => n.id)).toEqual(['legacy-l1-0']);
  });

  it('appending one new AI floor queues only that floor, not the 1800 historical leaves', () => {
    const { chat, raw } = legacyTree();
    const host = useChat(chat, raw);
    loadMemory();
    const oldChat = JSON.stringify(chat);
    chat.push(ai(1800, false));
    recomputeDerived();
    expect(pendingAiFloors(chat)).toEqual([1800]);
    expect(derivedMeta.pendingFloors).toEqual([1800]);
    expect(derivedMeta.leaves).toHaveLength(1800);
    expect(JSON.stringify(chat.slice(0, 1800))).toBe(oldChat);
    expect(selectHistoryNodesBefore(memory.summaries, chat, 1800).every(n => n.level === 2)).toBe(true);
    expectNoSave(host);
  });

  it('repeated recompute is state-idempotent for quantities, stable plan IDs, time and variable operations', () => {
    const { chat, raw } = legacyTree();
    chat[0].extra!.bbs_leaf!.delta = {
      time: '2031/4/12 19:10', location: '厨房',
      protagonist: { condition: '右腕受伤' },
      items: { add: [{ name: '铜币', qty: 3, carried: true }] },
      plans: { add: [{ kind: 'plan', content: '归还旧地图' }] },
      varOps: [{ op: 'add', path: 'score', delta: 2 }],
    };
    chat[1799].extra!.bbs_leaf!.delta = {
      time: '2031/4/13 08:00', location: '广场',
      items: { add: [{ name: '铜币', qty: 2 }] },
      varOps: [{ op: 'add', path: 'score', delta: 3 }],
    };
    const host = useChat(chat, raw);
    const original = JSON.stringify({ chat, raw });
    loadMemory();
    expect(memory.items).toMatchObject([{ name: '铜币', qty: 5 }]);
    expect(memory.plans).toMatchObject([{ id: 'plan:legacy-leaf-0#0', content: '归还旧地图' }]);
    expect(memory.state).toMatchObject({ time: '2031/4/13 08:00', location: '广场' });
    expect(memory.protagonist.condition).toBe('右腕受伤');
    expect(memory.vars.score).toBe(15);
    const state = clone(memory);
    const derived = clone(derivedMeta);
    for (let i = 0; i < 4; i++) recomputeDerived();
    expect(clone(memory)).toEqual(state);
    // rev is an intentional UI invalidation counter, not narrative state.
    expect(clone(derivedMeta)).toEqual({ ...derived, rev: derived.rev + 4 });
    expect(JSON.stringify({ chat, raw })).toBe(original);
    expectNoSave(host);
  });
});

describe('legacy user flows through real summary request entry points', () => {
  it('runSummary summarizes only floor 1801 in one mocked request using L2 history and leaves all 1800 old leaves intact', async () => {
    const { chat, raw } = legacyTree();
    const host = useChat(chat, raw);
    const originalChat = JSON.stringify(chat);
    const originalRaw = JSON.stringify(raw);
    const oldLeafObjects = chat.map(message => message.extra!.bbs_leaf);
    const newFloor = ai(1800, false);
    newFloor.mes = '<bbs_start>2031/4/13 08:00</bbs_start>林舟从旧厨房走到新港口，在码头停下等待。<bbs_end>2031/4/13 08:05</bbs_end>';
    chat.push(newFloor);
    loadMemory();
    expect(derivedMeta.pendingFloors).toEqual([1800]);
    expectedMockRequests = 1;
    const summary = '林舟离开旧厨房，抵达新港口，在码头停下等待。';
    vi.mocked(client.requestViaMainApi).mockResolvedValueOnce(JSON.stringify({
      summary, location: '新港口', stateChanges: ['location'],
      timeStart: '2031/4/13 08:00', timeEnd: '2031/4/13 08:05',
    }));

    // Keep default automatic-resummary behavior enabled; fixture thresholds
    // ensure the one new leaf cannot accidentally trigger an extra request.
    await runSummary(1800);
    expect(engineState.lastError).toBe('');
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(currentSummaryPromise()).toBeNull();
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain('林舟从旧厨房走到新港口');
    for (const l2 of raw.summaries.filter(s => s.level === 2)) {
      expect(request).toContain(l2.text.trim());
      expect(request.split(l2.text.trim())).toHaveLength(2);
    }
    expect(request).not.toContain('旧L1独有正文');
    expect(request).not.toContain('旧叶子正文');
    expect(request).not.toContain('原正文 1799');
    expect(newFloor.extra!.bbs_leaf).toMatchObject({ text: summary, delta: { location: '新港口' }, swipe: 0, v: 1 });
    expect(newFloor.extra!.bbs_leaf!.id).not.toBe('legacy-leaf-1800');
    expect(leafValid(newFloor)).toBe(true);
    expect(memory.state).toMatchObject({ location: '新港口', time: '2031/4/13 08:05' });
    expect(derivedMeta.leaves).toHaveLength(1801);
    expect(derivedMeta.pendingFloors).toEqual([]);
    expect(pendingAiFloors(chat)).toEqual([]);
    expect(JSON.stringify(chat.slice(0, 1800))).toBe(originalChat);
    expect(chat.slice(0, 1800).every((message, i) => message.extra!.bbs_leaf === oldLeafObjects[i])).toBe(true);
    expect(JSON.stringify(raw)).toBe(originalRaw);
    expect(memory.summaries.map(s => s.id)).toEqual(raw.summaries.map(s => s.id));
    const injected = host.setExtensionPrompt.mock.calls.find(([key]) => key === 'baibai_book_memory_history')?.[1];
    expect(injected).toContain('旧L2独有正文');
    expect(injected).not.toContain('旧L1独有正文');
    expect(host.saveMetadata).not.toHaveBeenCalled();
    expect(host.saveMetadataDebounced).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(host.saveChat).toHaveBeenCalledTimes(1);
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(chat.slice(0, 1800))).toBe(originalChat);
  });

  const mergeCases = (['checkResummary', 'summarizeSelected'] as const).flatMap(entry =>
    ([1, 2] as const).map(level => [entry, level] as const));
  it.each(mergeCases)('%s discards a delayed old L%s compression result after switching chats', async (entry, level) => {
    const { chat, raw } = legacyTree();
    // L1-root and L2-root forests both retain all original leaves; remove only
    // the fixture's L2 parents when testing the former, before loading it.
    if (level === 1) raw.summaries = raw.summaries.filter(s => s.level === 1);
    const oldHost = useChat(chat, raw);
    const oldChat = JSON.stringify(chat);
    const oldMetadata = JSON.stringify(oldHost.chatMetadata);
    loadMemory();
    Object.assign(settings.apiSettings, { resummaryThreshold: 2, higherResummaryThreshold: 2 });
    const picked = raw.summaries.filter(s => s.level === level).slice(0, 2);
    expectedMockRequests = 1;
    const gate = deferred();
    const lateSummary = '仅属于旧聊天的压缩结果，绝不能出现在新聊天。';
    vi.mocked(client.requestViaMainApi).mockImplementationOnce(async () => {
      await gate.promise;
      return JSON.stringify({ summary: lateSummary, stateChanges: [] });
    });
    const operation = entry === 'checkResummary'
      ? checkResummary().then(made => ({ made, error: engineState.lastError }))
      : summarizeSelected(picked.map(n => n.id));
    let nextHost: ReturnType<typeof useChat> | undefined;
    let nextChatSnapshot = '';
    let nextMetadataSnapshot = '';
    let nextMemory: ReturnType<typeof clone<typeof memory>> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
      const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
      for (const source of picked) expect(request).toContain(source.text.trim());
      expect(request).not.toContain('旧叶子正文');
      if (level === 2) expect(request).not.toContain('旧L1独有正文');
      expectNoSave(oldHost);
      const nextMessage = ai(9000);
      nextMessage.extra!.bbs_leaf = storedLeaf(9000, { location: '新聊天营地' });
      nextHost = useChat([nextMessage], {
        version: 3,
        summaries: [{ id: 'new-chat-only-l1', text: '新聊天原有历史，必须保留。', level: 1,
          childIds: ['legacy-leaf-9000'], createdAt: 9000, auto: false }],
        varsTemplate: { json: { score: 999 }, meaning: '', rule: '' },
      });
      nextHost.getCurrentChatId = () => 'new-unrelated-chat';
      loadMemory();
      expect(compatibilityState.mode).toBe('ready');
      expect(memory.state.location).toBe('新聊天营地');
      nextChatSnapshot = JSON.stringify(nextHost.chat);
      nextMetadataSnapshot = JSON.stringify(nextHost.chatMetadata);
      nextMemory = clone(memory);
    } finally {
      gate.resolve();
      // Always settle the real engine operation, even if an assertion above fails.
      await operation;
    }
    const result = await operation;
    expect(result.made).toBe(0);
    expect(result.error).toMatch(/变化|切换|未写入/);
    expect(engineState.running).toBe(false);
    await vi.runAllTimersAsync();
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(chat)).toBe(oldChat);
    expect(JSON.stringify(oldHost.chatMetadata)).toBe(oldMetadata);
    expect(JSON.stringify(nextHost!.chat)).toBe(nextChatSnapshot);
    expect(JSON.stringify(nextHost!.chatMetadata)).toBe(nextMetadataSnapshot);
    expect(clone(memory)).toEqual(nextMemory);
    expect(JSON.stringify(memory)).not.toContain(lateSummary);
    expectNoSave(oldHost);
    expectNoSave(nextHost!);
    expect(nextHost!.setExtensionPrompt.mock.calls.some(call => String(call[1]).includes(lateSummary))).toBe(false);
  });

  it('stops vector scheduling, sync and recall indexing when a previously writable raw memory is replaced by a future version', async () => {
    const { chat, raw } = legacyTree(30);
    const host = useChat(chat, raw);
    Object.assign(host, { characterId: 0, characters: [{ name: '旧角色', avatar: 'legacy-character.png' }] });
    settings.apiSettings.vector.enabled = true;
    const reconcile = vi.spyOn(vectorStore, 'vecReconcile').mockImplementation(noNetwork);
    const upsert = vi.spyOn(vectorStore, 'vecUpsert').mockImplementation(noNetwork);
    const updatePayload = vi.spyOn(vectorStore, 'vecUpdatePayload').mockImplementation(noNetwork);
    loadMemory();
    // Positive control: this host really is indexable before its raw changes.
    expect(vectorIndexableHere()).toBe(true);
    host.chatMetadata[MEMORY_KEY] = { ...raw, version: 999 };
    const original = JSON.stringify({ chat, metadata: host.chatMetadata });
    // No explicit reload: the entry-point must notice raw object identity changed.
    expect(vectorIndexableHere()).toBe(false);
    expect(compatibilityState.mode).toBe('protected');
    expect(await syncVectorIndex()).toEqual({ embedded: 0, payloadUpdated: 0 });
    await ensureRecallIndex();
    scheduleVectorIndex();
    await vi.runAllTimersAsync();
    expect(reconcile).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(updatePayload).not.toHaveBeenCalled();
    expect(JSON.stringify({ chat, metadata: host.chatMetadata })).toBe(original);
    expectNoSave(host);
  });
});

describe('read-only compatibility rejection and explicit page mismatch', () => {
  const cases: Array<[string, (fixture: ReturnType<typeof legacyTree>) => void]> = [
    ['non-object metadata', f => { (f as { raw: unknown }).raw = []; }],
    ['future metadata version', f => { f.raw.version = 999; }],
    ['missing metadata version', f => { delete (f.raw as Partial<typeof f.raw>).version; }],
    ['malformed summaries list', f => { (f.raw as { summaries: unknown }).summaries = {}; }],
    ['malformed leaf delta', f => { (f.chat[0].extra!.bbs_leaf as unknown as { delta: unknown }).delta = []; }],
    ['delta-only persistent leaf lacking text', f => { delete (f.chat[0].extra!.bbs_leaf as Partial<LeafExtra>).text; }],
    ['missing leaf ID', f => { f.chat[0].extra!.bbs_leaf!.id = ''; }],
    ['future leaf version', f => { (f.chat[0].extra!.bbs_leaf as unknown as { v: number }).v = 99; }],
    ['unknown legacy page on a nonzero swipe', f => { f.chat[0].swipe_id = 1; }],
    ['invalid negative swipe marker', f => { f.chat[0].extra!.bbs_leaf!.swipe = -1; }],
    ['orphan child reference', f => { f.raw.summaries[0].childIds.push('missing-old-leaf'); }],
    ['empty non-imported compression node', f => { f.raw.summaries[0].childIds = []; }],
    ['duplicate leaf IDs', f => { f.chat[1].extra!.bbs_leaf!.id = f.chat[0].extra!.bbs_leaf!.id; }],
    ['cyclic summary references', f => { f.raw.summaries[0].childIds = [f.raw.summaries[1].id]; }],
    ['duplicate child within one parent', f => { f.raw.summaries[0].childIds.push(f.raw.summaries[0].childIds[0]); }],
    ['one leaf referenced by multiple parents', f => {
      f.raw.summaries.push({ ...f.raw.summaries[0], id: 'second-l1-parent', childIds: [f.chat[0].extra!.bbs_leaf!.id] });
    }],
    ['one compression referenced by multiple parents', f => {
      f.raw.summaries.push({ ...f.raw.summaries[1], id: 'second-l2-parent' });
    }],
    ['parent and child on equal levels', f => { f.raw.summaries[1].level = 1; }],
    ['compression level inversion', f => { f.raw.summaries[0].level = 3; }],
  ];
  it.each(cases)('protects %s without changing input', (_label, mutate) => {
    const fixture = legacyTree(30);
    mutate(fixture);
    const before = JSON.stringify(fixture);
    const report = inspectCompatibility(fixture.raw, fixture.chat);
    expect(report.mode).toBe('protected');
    expect(report.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('accepts missing v/swipe only on the historical first page', () => {
    const { chat, raw } = legacyTree(30);
    expect(chat[0].extra!.bbs_leaf!.v).toBeUndefined();
    expect(chat[0].extra!.bbs_leaf!.swipe).toBeUndefined();
    expect(inspectCompatibility(raw, chat)).toMatchObject({ mode: 'ready', leaves: 30, issues: [] });
    expect(leafValid(chat[0])).toBe(true);
  });

  it('allows explicit swipe mismatch as a stored history record, but never injects its stale narrative', () => {
    const { chat, raw } = legacyTree();
    chat[0].extra!.bbs_leaf!.swipe = 0;
    chat[0].swipe_id = 1;
    const before = JSON.stringify({ chat, raw });
    const host = useChat(chat, raw);
    loadMemory();
    expect(compatibilityState.mode).toBe('ready');
    expect(leafValid(chat[0])).toBe(false);
    expect(pendingAiFloors(chat)).toEqual([0]);
    const selected = selectHistoryNodesBefore(memory.summaries, chat, 1800);
    const ids = selected.map(n => n.id);
    expect(ids).not.toContain('legacy-leaf-0');
    expect(ids).not.toContain('legacy-l1-0');
    expect(ids).not.toContain('legacy-l2-0');
    expect(ids).toContain('legacy-l2-1');
    expect(ids).toContain('legacy-l1-1');
    expect(ids).toContain('legacy-leaf-1');
    expect(new Set(ids).size).toBe(ids.length);
    chat[0].swipe_id = 0;
    recomputeDerived();
    expect(derivedMeta.pendingFloors).toEqual([]);
    expect(selectInjectionNodes(memory.summaries, chat).map(n => n.id))
      .toEqual(raw.summaries.filter(s => s.level === 2).map(s => s.id));
    chat[0].swipe_id = 1;
    expect(JSON.stringify({ chat, raw })).toBe(before);
    expectNoSave(host);
  });

  it('recognizes a valid leaf archived in swipe_info rather than treating its reference as an orphan', () => {
    const { chat, raw } = legacyTree(30);
    const archived = clone(chat[0].extra!.bbs_leaf!);
    archived.v = 1;
    archived.swipe = 0;
    chat[0].extra!.bbs_leaf = { ...storedLeaf(999), swipe: 1 };
    chat[0].swipe_id = 1;
    Object.assign(chat[0], { swipe_info: [{ extra: { bbs_leaf: archived } }] });
    expect(inspectCompatibility(raw, chat)).toMatchObject({ mode: 'ready', issues: [] });
  });

  it('does not let a malformed swipe archive legitimize an otherwise orphaned reference', () => {
    const { chat, raw } = legacyTree(30);
    const oldId = chat[0].extra!.bbs_leaf!.id;
    chat[0].extra!.bbs_leaf = { ...storedLeaf(999), swipe: 1 };
    chat[0].swipe_id = 1;
    Object.assign(chat[0], { swipe_info: [{ extra: { bbs_leaf: { id: oldId, v: 999, delta: [] } } }] });
    expect(inspectCompatibility(raw, chat).mode).toBe('protected');
  });

  const badArchives: Array<[string, (leaf: Partial<LeafExtra>) => void, number]> = [
    ['missing text', leaf => { delete leaf.text; }, 0],
    ['invalid delta', leaf => { (leaf as { delta: unknown }).delta = []; }, 0],
    ['future version', leaf => { (leaf as { v: number }).v = 999; }, 0],
    ['negative page marker', leaf => { leaf.swipe = -1; }, 0],
    ['unknown nonzero page', leaf => { delete leaf.swipe; }, 1],
  ];
  it.each(badArchives)('protects an archived leaf with %s, without altering any page', (_label, mutate, pageIndex) => {
    const { chat, raw } = legacyTree(30);
    const archived: Partial<LeafExtra> = { ...clone(chat[0].extra!.bbs_leaf!), v: 1, swipe: pageIndex };
    mutate(archived);
    chat[0].extra!.bbs_leaf = { ...storedLeaf(999), swipe: 2 };
    chat[0].swipe_id = 2;
    const pages = Array.from({ length: pageIndex + 1 }, () => ({ extra: {} as Record<string, unknown> }));
    pages[pageIndex].extra.bbs_leaf = archived;
    Object.assign(chat[0], { swipe_info: pages });
    const before = JSON.stringify({ chat, raw });
    const report = inspectCompatibility(raw, chat);
    expect(report.mode).toBe('protected');
    expect(report.issues.join('；')).toMatch(/历史分页摘要/);
    expect(JSON.stringify({ chat, raw })).toBe(before);
  });

  function deepForest(depth: number, rootFirst: boolean) {
    const fixture = legacyTree(1);
    fixture.raw.summaries = Array.from({ length: depth }, (_, i) => ({
      id: 'deep-' + (i + 1), text: '深层旧压缩文本 ' + (i + 1), level: i + 1,
      createdAt: 1000 + i, auto: false,
      childIds: [i === 0 ? fixture.chat[0].extra!.bbs_leaf!.id : 'deep-' + i],
    }));
    if (rootFirst) fixture.raw.summaries.reverse();
    return fixture;
  }

  it.each([['root first', true], ['leaves first', false]] as const)
    ('accepts a 63-level valid tree below the safety limit (%s)', (_order, rootFirst) => {
      const { chat, raw } = deepForest(63, rootFirst);
      expect(inspectCompatibility(raw, chat)).toMatchObject({ mode: 'ready', issues: [], summaries: 63 });
    });

  it.each([['root first', true], ['leaves first', false]] as const)
    ('protects a 65-level tree regardless of serialized node order (%s)', (_order, rootFirst) => {
      const { chat, raw } = deepForest(65, rootFirst);
      const before = JSON.stringify({ chat, raw });
      const report = inspectCompatibility(raw, chat);
      expect(report.mode).toBe('protected');
      expect(report.issues.join('；')).toMatch(/过深/);
      expect(JSON.stringify({ chat, raw })).toBe(before);
    });

  it('protected load keeps raw data, blocks mutations and does not offer a destructive whole-history backlog', async () => {
    const { chat, raw } = legacyTree(30);
    raw.summaries[0].childIds.push('unrecoverable-orphan');
    const host = useChat(chat, raw);
    const before = JSON.stringify({ chat, metadata: host.chatMetadata });
    loadMemory();
    expect(memoryWriteIssue()).not.toBe('');
    expect(derivedMeta.pendingFloors).toEqual([]);
    expect(pendingAiFloors(chat)).toEqual([]);
    expect(() => saveMemory()).toThrow();
    expect(() => scheduleLeafFlush()).toThrow();
    await expect(convertLegacyMemory()).rejects.toThrow();
    await vi.runAllTimersAsync();
    expect(JSON.stringify({ chat, metadata: host.chatMetadata })).toBe(before);
    expectNoSave(host);
  });
});

describe('explicit local V2 single-floor conversion and persistence safety', () => {
  it('only proposes a conversion during load, preserving metadata and chat without model calls or saves', () => {
    const { chat, raw, summary } = legacyV2();
    const host = useChat(chat, raw);
    const before = JSON.stringify({ chat, metadata: host.chatMetadata });
    loadMemory();
    expect(compatibilityState.mode).toBe('convert');
    expect(compatibilityState.conversion).toHaveLength(1);
    expect(compatibilityState.conversion[0]).toMatchObject({ floor: 0, leaf: { ...summary, v: 1, swipe: 0 } });
    expect(derivedMeta.pendingFloors).toEqual([]);
    expect(JSON.stringify({ chat, metadata: host.chatMetadata })).toBe(before);
    expectNoSave(host);
  });

  it('durably saves the original backup, then chat, then final metadata while preserving IDs/text/fields', async () => {
    const { chat, raw, summary, parent } = legacyV2();
    const original = clone(raw);
    const originalBody = chat[0].mes;
    const originalExtra = clone(chat[0].extra);
    const host = useChat(chat, raw);
    const backupSaved = deferred();
    const chatSaved = deferred();
    const finalSaved = deferred();
    const calls: string[] = [];
    host.saveMetadata.mockImplementationOnce(() => {
      calls.push('backup-start');
      expect(host.chatMetadata[BACKUP_KEY]).toEqual(original);
      expect(host.chatMetadata[MEMORY_KEY]).toEqual(original);
      expect(chat[0].extra).toEqual(originalExtra);
      return backupSaved.promise.then(() => { calls.push('backup-complete'); });
    }).mockImplementationOnce(() => {
      calls.push('final-metadata-start');
      expect(chat[0].extra!.bbs_leaf).toEqual({ ...summary, v: 1, swipe: 0 });
      expect(host.chatMetadata[MEMORY_KEY]).toEqual({ ...original, version: 3, summaries: [parent] });
      return finalSaved.promise.then(() => { calls.push('final-metadata-complete'); });
    });
    host.saveChat.mockImplementation(() => {
      calls.push('chat-start');
      expect(host.chatMetadata[BACKUP_KEY]).toEqual(original);
      expect(chat[0].extra!.bbs_leaf).toEqual({ ...summary, v: 1, swipe: 0 });
      expect(host.chatMetadata[MEMORY_KEY]).toMatchObject({ version: 3, summaries: [parent] });
      return chatSaved.promise.then(() => { calls.push('chat-complete'); });
    });
    loadMemory();
    const converting = convertLegacyMemory();
    try {
      expect(compatibilityState.converting).toBe(true);
      expect(calls).toEqual(['backup-start']);
      expect(host.saveChat).not.toHaveBeenCalled();
      expect(chat[0].extra).toEqual(originalExtra);
      // A concurrent conversion may not replace the pending transaction/backup.
      await expect(convertLegacyMemory()).rejects.toThrow(/进行/);
      backupSaved.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['backup-start', 'backup-complete', 'chat-start']);
      expect(host.saveMetadata).toHaveBeenCalledTimes(1);
      expect(compatibilityState.converting).toBe(true);
      chatSaved.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['backup-start', 'backup-complete', 'chat-start', 'chat-complete', 'final-metadata-start']);
      expect(compatibilityState.converting).toBe(true);
    } finally {
      backupSaved.resolve(); chatSaved.resolve(); finalSaved.resolve();
      await converting;
    }
    expect(calls).toEqual(['backup-start', 'backup-complete', 'chat-start', 'chat-complete', 'final-metadata-start', 'final-metadata-complete']);
    expect(host.saveChat).toHaveBeenCalledTimes(1);
    expect(host.saveMetadata).toHaveBeenCalledTimes(2);
    expect(host.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(chat[0].mes).toBe(originalBody);
    expect(chat[0].extra).toEqual({ ...originalExtra, bbs_leaf: { ...summary, v: 1, swipe: 0 } });
    expect(host.chatMetadata[MEMORY_KEY]).toEqual({ ...original, version: 3, summaries: [parent] });
    expect(host.chatMetadata[BACKUP_KEY]).toEqual(original);
    expect(host.chatMetadata[BACKUP_KEY]).not.toBe(raw);
    expect(compatibilityState).toMatchObject({ mode: 'ready', converting: false });
    expect(derivedMeta.pendingFloors).toEqual([]);
    expect(memory.items).toMatchObject([{ name: '旧地图', qty: 2 }]);
    expect(memory.vars.score).toBe(13);
    expect(memory.plans).toMatchObject([{ id: 'plan:' + summary.id + '#0', content: '归还旧地图' }]);
    expect(selectHistoryNodesBefore(memory.summaries, chat, 1).map(n => n.id)).toEqual([parent.id]);
    const stable = clone(memory);
    recomputeDerived();
    expect(clone(memory)).toEqual(stable);
    await expect(convertLegacyMemory()).rejects.toThrow();
    expect(host.saveChat).toHaveBeenCalledTimes(1);
    expect(host.saveMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['backup metadata', 0, 1], ['chat', 1, 1], ['final metadata', 1, 2],
  ] as const)('restores originals and protects backup after %s fails', async (stage, chatCalls, metadataCalls) => {
    const { chat, raw } = legacyV2();
    const original = clone(raw);
    const originalChat = clone(chat);
    const originalExtra = chat[0].extra;
    const host = useChat(chat, raw);
    const error = new Error('forced ' + stage + ' failure');
    if (stage === 'backup metadata') host.saveMetadata.mockRejectedValueOnce(error);
    else if (stage === 'chat') host.saveChat.mockRejectedValueOnce(error);
    else host.saveMetadata.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    loadMemory();
    await expect(convertLegacyMemory()).rejects.toThrow(/备份/);
    expect(chat).toEqual(originalChat);
    expect(chat[0].extra).toBe(originalExtra);
    expect(host.chatMetadata[MEMORY_KEY]).toBe(raw);
    expect(raw).toEqual(original);
    expect(host.chatMetadata[BACKUP_KEY]).toEqual(original);
    expect(host.chatMetadata[BACKUP_KEY]).not.toBe(raw);
    expect(compatibilityState.converting).toBe(false);
    expect(compatibilityState.mode).not.toBe('ready');
    expect(memoryWriteIssue()).not.toBe('');
    expect(host.saveChat).toHaveBeenCalledTimes(chatCalls);
    expect(host.saveMetadata).toHaveBeenCalledTimes(metadataCalls);
    expect(host.saveMetadataDebounced).not.toHaveBeenCalled();
    const backup = host.chatMetadata[BACKUP_KEY];
    await expect(convertLegacyMemory()).rejects.toThrow(/备份/);
    expect(host.chatMetadata[BACKUP_KEY]).toBe(backup);
    expect(host.saveChat).toHaveBeenCalledTimes(chatCalls);
    expect(host.saveMetadata).toHaveBeenCalledTimes(metadataCalls);
  });

  const switches = (['backup', 'chat', 'final metadata'] as const).flatMap(stage =>
    (['chat array', 'metadata object', 'chat ID'] as const).map(identity => [stage, identity] as const));
  it.each(switches)('stops later saves when %s is pending and the %s changes', async (stage, identity) => {
    const { chat, raw } = legacyV2();
    const originalChat = clone(chat);
    const originalRaw = clone(raw);
    const host = useChat(chat, raw);
    const oldMetadata = host.chatMetadata;
    const pending = deferred();
    if (stage === 'backup') host.saveMetadata.mockReturnValueOnce(pending.promise);
    else if (stage === 'chat') host.saveChat.mockReturnValueOnce(pending.promise);
    else host.saveMetadata.mockResolvedValueOnce(undefined).mockReturnValueOnce(pending.promise);
    loadMemory();
    const converting = convertLegacyMemory();
    // Attach a rejection assertion before releasing the pending host operation.
    const rejected = expect(converting).rejects.toThrow(/切换聊天/);
    await vi.advanceTimersByTimeAsync(0);
    const expectedChatCalls = stage === 'backup' ? 0 : 1;
    const expectedMetadataCalls = stage === 'final metadata' ? 2 : 1;
    expect(host.saveChat).toHaveBeenCalledTimes(expectedChatCalls);
    expect(host.saveMetadata).toHaveBeenCalledTimes(expectedMetadataCalls);
    const newChat = [ai(9999, false)];
    const newMetadata = { [MEMORY_KEY]: { version: 3, summaries: [] }, unrelated: '另一聊天数据' };
    const newChatSnapshot = clone(newChat);
    const newMetadataSnapshot = clone(newMetadata);
    if (identity === 'chat array') host.chat = newChat;
    else if (identity === 'metadata object') host.chatMetadata = newMetadata;
    else host.getCurrentChatId = () => 'different-chat-id';
    pending.resolve();
    await rejected;
    expect(compatibilityState.converting).toBe(false);
    expect(host.saveChat).toHaveBeenCalledTimes(expectedChatCalls);
    expect(host.saveMetadata).toHaveBeenCalledTimes(expectedMetadataCalls);
    expect(host.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(chat).toEqual(originalChat);
    expect(oldMetadata[MEMORY_KEY]).toEqual(originalRaw);
    expect(oldMetadata[BACKUP_KEY]).toEqual(originalRaw);
    expect(newChat).toEqual(newChatSnapshot);
    expect(newMetadata).toEqual(newMetadataSnapshot);
  });

  it('refuses to overwrite a pre-existing backup before touching chat or metadata', async () => {
    const { chat, raw } = legacyV2();
    const host = useChat(chat, raw);
    host.chatMetadata[BACKUP_KEY] = { evidence: '上次转换备份，不准覆盖' };
    const before = JSON.stringify({ chat, metadata: host.chatMetadata });
    loadMemory();
    await expect(convertLegacyMemory()).rejects.toThrow(/备份/);
    expect(JSON.stringify({ chat, metadata: host.chatMetadata })).toBe(before);
    expectNoSave(host);
  });

  it.each(['saveChat', 'saveMetadata'] as const)('refuses conversion without reliable %s, before creating a backup', async missingSave => {
    const { chat, raw } = legacyV2();
    const host = useChat(chat, raw);
    const saveChat = host.saveChat;
    const saveMetadata = host.saveMetadata;
    (host as unknown as Record<string, unknown>)[missingSave] = undefined;
    const before = JSON.stringify({ chat, metadata: host.chatMetadata });
    loadMemory();
    await expect(convertLegacyMemory()).rejects.toThrow(/保存接口/);
    expect(JSON.stringify({ chat, metadata: host.chatMetadata })).toBe(before);
    expect(host.chatMetadata[BACKUP_KEY]).toBeUndefined();
    expect(saveChat).not.toHaveBeenCalled();
    expect(saveMetadata).not.toHaveBeenCalled();
  });

  const unsafeV2: Array<[string, (fixture: ReturnType<typeof legacyV2>) => void]> = [
    ['multi-floor range', f => { f.summary.coveredIndices = [0, 1]; }],
    ['missing floor', f => { f.summary.coveredIndices = [999]; }],
    ['nonzero current swipe', f => { f.chat[0].swipe_id = 1; }],
    ['occupied floor', f => { f.chat[0].extra!.bbs_leaf = storedLeaf(777); }],
    ['user floor', f => { f.chat[0].is_user = true; }],
  ];
  it.each(unsafeV2)('refuses ambiguous V2 conversion: %s', async (_label, mutate) => {
    const fixture = legacyV2();
    mutate(fixture);
    const host = useChat(fixture.chat, fixture.raw);
    const before = JSON.stringify({ chat: fixture.chat, metadata: host.chatMetadata });
    loadMemory();
    expect(compatibilityState.mode).toBe('protected');
    await expect(convertLegacyMemory()).rejects.toThrow();
    expect(JSON.stringify({ chat: fixture.chat, metadata: host.chatMetadata })).toBe(before);
    expectNoSave(host);
  });
});

describe('in-place swipe changes and lossless V2 delta compatibility regressions', () => {
  it('rechecks a ready chat after an in-place swipe change and never resummarizes or overwrites its unpaged legacy leaf', async () => {
    const chat = [ai(0, false)];
    const leaf = storedLeaf(0);
    delete leaf.swipe;
    delete (leaf as Partial<LeafExtra>).v;
    chat[0].extra!.bbs_leaf = leaf;
    const raw = { version: 3, summaries: [] };
    const host = useChat(chat, raw);
    const metadata = host.chatMetadata;
    const originalLeaf = clone(leaf);
    loadMemory();
    expect(compatibilityState.mode).toBe('ready');
    expect(memoryWriteIssue()).toBe('');
    expect(leafValid(chat[0])).toBe(true);

    // No load/event/identity change: the ready cache must notice mutation in place.
    chat[0].swipe_id = 1;
    const before = JSON.stringify({ chat, metadata });
    expect(host.chat).toBe(chat);
    expect(host.chatMetadata).toBe(metadata);
    expect(metadata[MEMORY_KEY]).toBe(raw);
    expect(memoryWriteIssue()).not.toBe('');
    expect(compatibilityState.mode).toBe('protected');
    expect(openingPendingFloor(chat)).toBe(-1);
    await runSummary(0);
    await vi.runAllTimersAsync();
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(chat[0].extra!.bbs_leaf).toBe(leaf);
    expect(leaf).toEqual(originalLeaf);
    expect(JSON.stringify({ chat, metadata })).toBe(before);
    expect(engineState.running).toBe(false);
    expectNoSave(host);
  });

  it('protects lossy or unknown V2 delta operations while converting valid legacy data with unknown node metadata intact', async () => {
    const invalidDeltas: Array<[string, Record<string, unknown>]> = [
      ['items array', { items: [{ name: '旧地图', qty: 2 }] }],
      ['unknown items.consume', { items: { consume: [{ name: '旧地图', qty: 1 }] } }],
      ['unknown top-level operation', { consume: [{ name: '旧地图', qty: 1 }] }],
      ['items.add entry missing name', { items: { add: [{ qty: 2, carried: true }] } }],
    ];
    for (const [label, badFields] of invalidDeltas) {
      const { chat, raw, summary } = legacyV2();
      // Keep all unrelated valid delta fields: rejection must prevent partial conversion.
      summary.delta = { ...summary.delta, ...badFields } as StoredDelta;
      const host = useChat(chat, raw);
      const before = JSON.stringify({ chat, metadata: host.chatMetadata });
      expect(inspectCompatibility(raw, chat).mode, label).toBe('protected');
      loadMemory();
      expect(compatibilityState.mode, label).toBe('protected');
      expect(memoryWriteIssue(), label).not.toBe('');
      await expect(convertLegacyMemory(), label).rejects.toThrow();
      await vi.runAllTimersAsync();
      expect(chat[0].extra!.bbs_leaf, label).toBeUndefined();
      expect(host.chatMetadata[BACKUP_KEY], label).toBeUndefined();
      expect(host.chatMetadata[MEMORY_KEY], label).toBe(raw);
      expect(JSON.stringify({ chat, metadata: host.chatMetadata }), label).toBe(before);
      expectNoSave(host);
    }

    // Unknown node metadata is not an unknown state operation and must survive.
    const { chat, raw, summary, parent } = legacyV2();
    const original = clone(raw);
    const host = useChat(chat, raw);
    expect(inspectCompatibility(raw, chat).mode).toBe('convert');
    loadMemory();
    expect(compatibilityState.mode).toBe('convert');
    expectNoSave(host);
    await convertLegacyMemory();
    expect(compatibilityState.mode).toBe('ready');
    expect(memoryWriteIssue()).toBe('');
    expect(chat[0].extra!.bbs_leaf).toEqual({ ...summary, v: 1, swipe: 0 });
    expect(host.chatMetadata[MEMORY_KEY]).toEqual({ ...original, version: 3, summaries: [parent] });
    expect(host.chatMetadata[BACKUP_KEY]).toEqual(original);
    expect(memory.items).toMatchObject([{ name: '旧地图', qty: 2 }]);
    expect(memory.vars.score).toBe(13);
    expect(host.saveMetadata).toHaveBeenCalledTimes(2);
    expect(host.saveChat).toHaveBeenCalledTimes(1);
    expect(host.saveMetadataDebounced).not.toHaveBeenCalled();
  });
});
it('never saves either chat when a scheduled leaf flush outlives a switch to a protected chat', async () => {
  for (const immediateFlush of [false, true]) {
    const chat = [ai(0, false)];
    chat[0].extra!.bbs_leaf = storedLeaf(0);
    const oldHost = useChat(chat, { version: 3, summaries: [] });
    oldHost.getCurrentChatId = () => 'flush-source-chat';
    loadMemory();
    expect(compatibilityState.mode).toBe('ready');
    const oldBefore = JSON.stringify({ chat, metadata: oldHost.chatMetadata });
    expect(vi.getTimerCount()).toBe(0);
    scheduleLeafFlush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expectNoSave(oldHost);

    const newHost = useChat([ai(1, false)], { version: 999, summaries: [] });
    newHost.getCurrentChatId = () => 'flush-protected-chat';
    const newBefore = JSON.stringify({ chat: newHost.chat, metadata: newHost.chatMetadata });
    loadMemory();
    expect(compatibilityState.mode).toBe('protected');
    expect(vi.getTimerCount()).toBe(1);
    if (immediateFlush) {
      // Even a protected early return must cancel the old pending timer first.
      flushLeavesNow();
      expect(vi.getTimerCount()).toBe(0);
    }
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expectNoSave(oldHost);
    expectNoSave(newHost);
    expect(JSON.stringify({ chat, metadata: oldHost.chatMetadata })).toBe(oldBefore);
    expect(JSON.stringify({ chat: newHost.chat, metadata: newHost.chatMetadata })).toBe(newBefore);
  }
});