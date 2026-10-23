import { afterEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { floorRanges, pluginHiddenFloors, restorePluginHiddenFloors } from './restoreHidden';

afterEach(() => { vi.restoreAllMocks(); });

const msg = (hidden: 'plugin' | 'user' | 'none', extra: Record<string, unknown> = {}): STMessage => ({
  name: '角色', is_user: false, mes: '正文', is_system: hidden !== 'none',
  extra: { ...extra, ...(hidden === 'plugin' ? { bbs_hidden: true } : {}) },
});

function chatWith(chat: STMessage[], exec?: (command: string) => Promise<unknown>) {
  const ctx = {
    chat, saveChat: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    executeSlashCommandsWithOptions: exec ? vi.fn(exec) : undefined,
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  return ctx;
}

describe('恢复显示本插件隐藏的楼层', () => {
  it('只算带棱镜宝书标记、仍在隐藏的楼层；用户自己隐藏的不算', () => {
    const chat = [msg('plugin'), msg('plugin'), msg('user'), msg('none'), msg('plugin')];
    chat[3].extra = { bbs_hidden: true }; // 标记还在但已经显示的不算
    expect(pluginHiddenFloors(chat)).toEqual([0, 1, 4]);
    expect(floorRanges([1, 2, 3, 5, 7, 8])).toEqual([[1, 3], [5, 5], [7, 8]]);
  });

  it('按连续区间执行 /unhide，去掉标记并保存；用户隐藏的楼层和其他数据不动', async () => {
    const chat = [msg('plugin', { bbs_leaf: { id: 'a' } }), msg('plugin'), msg('user'), msg('plugin')];
    const ctx = chatWith(chat, async command => {
      const m = /^\/unhide (\d+)(?:-(\d+))?$/.exec(command)!;
      for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) chat[i].is_system = false;
    });
    expect(await restorePluginHiddenFloors()).toEqual({ restored: 3, fallback: false });
    expect(vi.mocked(ctx.executeSlashCommandsWithOptions!).mock.calls.map(c => c[0])).toEqual(['/unhide 0-1', '/unhide 3']);
    expect(chat.map(m => m.is_system)).toEqual([false, false, true, false]);
    expect(chat[0].extra).toEqual({ bbs_leaf: { id: 'a' } });
    expect(chat.some(m => m.extra?.bbs_hidden)).toBe(false);
    expect(ctx.saveChat).toHaveBeenCalled();
    expect(ctx.reloadCurrentChat).not.toHaveBeenCalled();
  });

  it('/unhide 失败时直接取消隐藏，保存后重新载入聊天', async () => {
    const chat = [msg('plugin'), msg('none')];
    const ctx = chatWith(chat, async () => { throw new Error('命令不可用'); });
    expect(await restorePluginHiddenFloors()).toEqual({ restored: 1, fallback: true });
    expect(chat[0]).toMatchObject({ is_system: false, extra: {} });
    expect(ctx.saveChat).toHaveBeenCalled();
    expect(ctx.reloadCurrentChat).toHaveBeenCalled();
  });

  it('/unhide 没有抛错却没有生效（酒馆只返回错误结果）时同样直接取消隐藏，不留下去掉了标记却仍隐藏的楼层', async () => {
    const chat = [msg('plugin'), msg('plugin'), msg('user')];
    const ctx = chatWith(chat, async () => ({ isError: true, errorMessage: '未知命令' }));
    expect(await restorePluginHiddenFloors()).toEqual({ restored: 2, fallback: true });
    expect(chat.map(m => m.is_system)).toEqual([false, false, true]);
    expect(chat.some(m => m.extra?.bbs_hidden)).toBe(false);
    expect(ctx.reloadCurrentChat).toHaveBeenCalled();
  });

  it('没有需要恢复的楼层时不执行命令', async () => {
    const ctx = chatWith([msg('user'), msg('none')], async () => undefined);
    expect(await restorePluginHiddenFloors()).toEqual({ restored: 0, fallback: false });
    expect(ctx.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
    expect(ctx.saveChat).not.toHaveBeenCalled();
  });
});
