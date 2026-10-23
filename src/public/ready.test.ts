import { afterEach, describe, expect, it, vi } from 'vitest';
import type { STBaiBaiBookApi } from './types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { STBaiBaiBook?: STBaiBaiBookApi }).STBaiBaiBook;
});

describe('公共接口的就绪标志', () => {
  it('全局对象先挂上、ready 为 false；斜杠命令和宏注册完成后 ready 为 true，并发出 ready 事件', async () => {
    vi.resetModules();
    const context = await import('@/st/context');
    vi.spyOn(context, 'getContext').mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent, addEventListener: vi.fn() });
    const register = await import('./register');
    const pending = register.registerPublicInterface();
    const api = (globalThis as { STBaiBaiBook?: STBaiBaiBookApi }).STBaiBaiBook!;
    expect(api).toBeDefined();
    expect(api.ready).toBe(false);
    expect(api.capabilities).toMatchObject({ globalApi: true, sharedApiChannels: true, slashCommand: false, macros: false, events: true });
    await pending;
    expect(api.ready).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'st-baibai-book:ready' }));
    expect(Object.isFrozen(api)).toBe(true);
  });
});
