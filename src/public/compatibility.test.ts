import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import type { PublicSnapshot, STBaiBaiBookApi } from './types';

// Only mock host/network boundaries. Store checks, selectors, coverage and query routing stay real.
const hostMacros = vi.hoisted(() => ({
  experimental: false,
  handlers: new Map<string, (args?: { unnamedArgs: string[] }) => string>(),
  slash: undefined as undefined | ((args: Record<string, unknown>, unnamed: unknown) => string),
}));
vi.mock('/scripts/power-user.js', () => ({
  power_user: { get experimental_macro_engine() { return hostMacros.experimental; } },
}));
vi.mock('/scripts/macros.js', () => ({
  MacrosParser: {
    registerMacro: (name: string, handler: () => string) => hostMacros.handlers.set(name, handler),
  },
}));
vi.mock('/scripts/macros/macro-system.js', () => ({
  MacroCategory: { CHAT: 'chat', VARIABLE: 'variable' },
  macros: {
    register: (name: string, options: { handler: (args: { unnamedArgs: string[] }) => string }) => {
      hostMacros.handlers.set(name, options.handler as (args?: { unnamedArgs: string[] }) => string);
      return true;
    },
  },
}));
vi.mock('/scripts/slash-commands/SlashCommandParser.js', () => ({
  SlashCommandParser: {
    addCommandObject: (command: { callback: typeof hostMacros.slash }) => { hostMacros.slash = command.callback; },
  },
}));
vi.mock('/scripts/slash-commands/SlashCommand.js', () => ({
  SlashCommand: { fromProps: (props: unknown) => props },
}));
vi.mock('/scripts/slash-commands/SlashCommandArgument.js', () => ({
  ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number' },
  SlashCommandArgument: { fromProps: (props: unknown) => props },
  SlashCommandNamedArgument: { fromProps: (props: unknown) => props },
}));

const noNetwork = () => { throw new Error('Public compatibility tests must never call a model/network'); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hiddenLeaf = (): STMessage => ({
  name: '旧角色', is_user: false, is_system: true, swipe_id: 0, mes: '原始正文不得修改',
  extra: {
    bbs_hidden: true,
    bbs_leaf: { id: 'kept-leaf', text: '旧剧情不能绕过保护注入', delta: {}, createdAt: 1, swipe: 0, v: 1 },
  },
});

async function fixture(raw: unknown = { version: 3, summaries: [] }, chat: STMessage[] = [hiddenLeaf()]) {
  const context = await import('@/st/context');
  const store = await import('@/memory/store');
  const settings = await import('@/api/settings');
  const client = await import('@/api/client');
  const engine = await import('@/memory/engine');
  const inject = await import('@/memory/inject');
  const query = await import('./query');
  const { MEMORY_KEY } = await import('@/memory/types');
  const host = {
    chat, chatMetadata: { [MEMORY_KEY]: raw } as Record<string, unknown>, name1: '用户', name2: '旧角色',
    getCurrentChatId: () => 'public-compatibility',
    saveChat: vi.fn(), saveMetadata: vi.fn(), saveMetadataDebounced: vi.fn(),
    setExtensionPrompt: vi.fn(),
  };
  vi.spyOn(context, 'getContext').mockReturnValue(host as unknown as STContext);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(client, 'requestCompletion').mockImplementation(noNetwork);
  vi.spyOn(client, 'requestViaMainApi').mockImplementation(noNetwork);
  store.loadMemory();
  return { store, engine, inject, query, host, client, MEMORY_KEY };
}

beforeEach(() => {
  vi.resetModules();
  hostMacros.experimental = false;
  hostMacros.handlers.clear();
  hostMacros.slash = undefined;
  vi.stubGlobal('fetch', vi.fn(noNetwork));
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { STBaiBaiBook?: STBaiBaiBookApi }).STBaiBaiBook;
});

describe('public compatibility protection', () => {
  it('short-circuits selection/rendering despite valid hidden leaves and an empty pending queue', async () => {
    const f = await fixture({ version: 999, summaries: [], unknown: { keep: true } });
    const original = clone({ chat: f.host.chat, metadata: f.host.chatMetadata });
    // Prove this fixture would leak content if the API merely reselected leaves.
    expect(f.inject.selectInjectionNodes(f.store.memory.summaries, f.host.chat)).toHaveLength(1);
    expect(f.engine.pendingAiFloors(f.host.chat)).toEqual([]);
    const selector = vi.spyOn(f.inject, 'selectInjectionNodes');
    const render = vi.spyOn(f.inject, 'renderHistoryNodes');
    const relative = vi.spyOn(f.inject, 'renderHistoryNodesWithRelative');
    const result = f.query.getInjectedHistory();
    expect(result).toMatchObject({
      apiVersion: 1, mode: 'injection', text: '', relativeText: '', nodes: [],
      compatibility: { mode: 'protected', blocked: true, converting: false },
      coverage: { complete: false, missingAiFloors: [], status: 'blocked' },
    });
    expect(result.compatibility!.reason).toBe(f.store.memoryWriteIssue());
    expect(result.compatibility!.issues.length).toBeGreaterThan(0);
    expect(result.coverage.reason).toBe(result.compatibility!.reason);
    expect(f.query.query({ resource: 'injectedHistory' })).toEqual(result);
    expect(selector).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(relative).not.toHaveBeenCalled();
    expect({ chat: f.host.chat, metadata: f.host.chatMetadata }).toEqual(original);
    expect(f.host.saveChat).not.toHaveBeenCalled();
    expect(f.host.saveMetadata).not.toHaveBeenCalled();
    expect(f.host.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(f.client.requestCompletion).not.toHaveBeenCalled();
    expect(f.client.requestViaMainApi).not.toHaveBeenCalled();
  });

  it('exposes incomplete coverage and compatibility in generic/historical snapshots and floor contexts', async () => {
    const { query } = await fixture({ version: 999, summaries: [] });
    for (const result of [
      query.getSnapshot(), query.getSnapshot({ floor: 0, at: 'before' }),
      query.getSnapshot({ floor: 0, at: 'after' }), query.getHistory(), query.getHistory({ before: 0 }),
      query.query({ resource: 'snapshot' }) as PublicSnapshot,
    ]) {
      expect(result.compatibility).toMatchObject({ mode: 'protected', blocked: true });
      expect(result.coverage).toMatchObject({ complete: false, status: 'blocked' });
      expect(result.coverage.reason).toBeTruthy();
    }
    const context = query.getContextAtFloor({ floor: 0 });
    for (const result of [context, context.snapshotBefore, context.snapshotAfter, context.historyBefore]) {
      expect(result.coverage).toMatchObject({ complete: false, status: 'blocked' });
    }
    expect(() => query.getSnapshot({ floor: -1 })).toThrow(RangeError);
    expect(() => query.getHistory({ before: 2 })).toThrow(RangeError);
  });

  it('blocks V2 records awaiting explicit conversion without altering their source', async () => {
    const message = hiddenLeaf();
    delete message.extra!.bbs_leaf;
    const raw = {
      version: 2,
      summaries: [{ id: 'v2-leaf', level: 0, text: '保留V2原文', coveredIndices: [0], delta: {}, createdAt: 1 }],
    };
    const f = await fixture(raw, [message]);
    const original = clone(f.host.chatMetadata);
    expect(f.store.compatibilityState.mode).toBe('convert');
    expect(f.query.getInjectedHistory()).toMatchObject({
      text: '', relativeText: '', nodes: [],
      compatibility: { mode: 'convert', blocked: true },
      coverage: { complete: false, status: 'blocked' },
    });
    expect(f.query.getSnapshot().compatibility!.reason).toContain('转换');
    expect(f.host.chatMetadata).toEqual(original);
    expect(message.extra!.bbs_leaf).toBeUndefined();
  });

  it('blocks active conversion even when mode is ready, then restores normal output', async () => {
    const f = await fixture();
    const normal = f.query.getInjectedHistory();
    expect(normal.relativeText).toContain('旧剧情不能绕过保护注入');
    f.store.compatibilityState.converting = true;
    expect(f.query.getInjectedHistory()).toMatchObject({
      text: '', relativeText: '', nodes: [],
      compatibility: { mode: 'ready', converting: true, blocked: true },
      coverage: { complete: false, status: 'blocked' },
    });
    expect(f.query.getSnapshot().coverage.complete).toBe(false);
    f.store.compatibilityState.converting = false;
    expect(f.query.getInjectedHistory()).toEqual(normal);
  });

  it('refreshes compatibility on chat switch without requiring loadMemory first', async () => {
    const f = await fixture();
    expect(f.query.getSnapshot().compatibility!.blocked).toBe(false);
    f.host.chat = [hiddenLeaf()];
    f.host.chatMetadata = { [f.MEMORY_KEY]: { version: 999, summaries: [] } };
    f.host.getCurrentChatId = () => 'another-chat';
    expect(f.query.getInjectedHistory()).toMatchObject({
      chat: { id: 'another-chat' }, text: '', compatibility: { mode: 'protected', blocked: true },
    });
    f.host.chatMetadata = { [f.MEMORY_KEY]: { version: 3, summaries: [] } };
    expect(f.query.getSnapshot().compatibility).toMatchObject({ mode: 'ready', blocked: false });
    expect(f.query.getInjectedHistory().relativeText).toContain('旧剧情不能绕过保护注入');
  });

  it('returns detached diagnostics without exposing the store conversion plan', async () => {
    const f = await fixture({ version: 999, summaries: [] });
    const first = f.query.getSnapshot();
    const originalIssues = [...f.store.compatibilityState.issues];
    first.compatibility!.issues.push('caller mutation');
    first.compatibility!.mode = 'ready';
    expect(f.store.compatibilityState.issues).toEqual(originalIssues);
    expect(f.query.getSnapshot().compatibility!.mode).toBe('protected');
    expect(f.query.getInjectedHistory().compatibility!.issues).toEqual(originalIssues);
    expect(first.compatibility).not.toHaveProperty('conversion');
  });

  it('preserves ready-mode selectors, rendering, hidden-floor coverage and sliding-window behavior', async () => {
    const visible: STMessage = { name: '角色', is_user: false, is_system: false, mes: '窗口内尚未摘要' };
    const f = await fixture(undefined, [hiddenLeaf(), visible]);
    const selected = f.inject.selectInjectionNodes(f.store.memory.summaries, f.host.chat);
    const result = f.query.getInjectedHistory();
    expect(result.text).toBe(f.inject.renderHistoryNodes(selected));
    expect(result.nodes.map(node => node.id)).toEqual(['kept-leaf']);
    expect(result.compatibility).toEqual({ mode: 'ready', blocked: false, converting: false, reason: null, issues: [] });
    expect(result.coverage).toMatchObject({ complete: true, missingAiFloors: [], status: 'complete' });
    expect(f.query.getSnapshot().coverage).toMatchObject({ complete: false, missingAiFloors: [1], status: 'incomplete' });
    expect(f.query.getSnapshot({ floor: 0 }).coverage.complete).toBe(true);
    visible.is_system = true;
    visible.extra = { bbs_hidden: true };
    expect(f.query.getInjectedHistory().coverage).toMatchObject({ complete: false, missingAiFloors: [1], status: 'incomplete' });
  });

  it('does not mark an empty protected chat complete', async () => {
    const f = await fixture({ version: 999, summaries: [] }, []);
    expect(f.query.getSnapshot().coverage.complete).toBe(false);
    expect(f.query.getInjectedHistory().coverage.complete).toBe(false);
  });
});

describe.each([false, true])('public registration (experimental macros: %s)', experimental => {
  it('guards global API, slash output and registered macros, and notifies on compatibility-only changes', async () => {
    const f = await fixture();
    hostMacros.experimental = experimental;
    const { effectScope, nextTick } = await import('vue');
    const scope = effectScope();
    const register = await import('./register');
    try {
      await scope.run(() => register.registerPublicInterface());
      const api = (globalThis as typeof globalThis & { STBaiBaiBook: STBaiBaiBookApi }).STBaiBaiBook;
      expect(api.capabilities).toMatchObject({ macros: true, slashCommand: true, parameterizedMacros: experimental });
      const macro = (name: string) => hostMacros.handlers.get(name)!({ unnamedArgs: [] });
      const normal = macro('bbsInjectedHistory');
      expect(normal).toContain('旧剧情不能绕过保护注入');
      const changed = vi.fn();
      const unsubscribe = api.subscribe(changed);
      const rev = api.getSnapshot().revision;
      const derivedRev = f.store.derivedMeta.rev;
      f.store.compatibilityState.converting = true;
      await nextTick();
      await Promise.resolve();
      expect(changed).toHaveBeenCalled();
      expect(api.getSnapshot().revision).toBeGreaterThan(rev);
      expect(f.store.derivedMeta.rev).toBe(derivedRev);
      expect(macro('bbsInjectedHistory')).toBe('');
      expect(JSON.parse(macro('bbsSnapshot'))).toMatchObject({
        compatibility: { blocked: true, converting: true }, coverage: { complete: false, status: 'blocked' },
      });
      expect(api.getInjectedHistory().text).toBe('');
      expect(hostMacros.slash!({ resource: 'injectedHistory', format: 'text' }, '')).toBe('');
      expect(JSON.parse(hostMacros.slash!({ resource: 'injectedHistory', format: 'json' }, ''))).toMatchObject({
        text: '', relativeText: '', nodes: [], compatibility: { blocked: true }, coverage: { complete: false },
      });
      f.store.compatibilityState.converting = false;
      f.host.chatMetadata = { [f.MEMORY_KEY]: { version: 999, summaries: [] } };
      expect(macro('bbsInjectedHistory')).toBe('');
      expect(JSON.parse(macro('bbsSnapshot')).compatibility.mode).toBe('protected');
      f.host.chatMetadata = { [f.MEMORY_KEY]: { version: 3, summaries: [] } };
      expect(macro('bbsInjectedHistory')).toBe(normal);
      await nextTick();
      await Promise.resolve();
      changed.mockClear();
      f.store.compatibilityState.issues.push('诊断变化');
      await nextTick();
      await Promise.resolve();
      expect(changed).toHaveBeenCalled();
      unsubscribe();
    } finally {
      scope.stop();
    }
  });
});
