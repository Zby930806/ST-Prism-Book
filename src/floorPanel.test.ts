import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

vi.mock('@/components/FloorPanel.vue', () => ({ default: { name: 'FloorPanelStub', render: () => null } }));
vi.mock('@/st/shadowStyles', () => ({ attachSharedStyles: vi.fn(), ensureSharedSheet: vi.fn(async () => undefined), SHADOW_HOST_CLASS: 'bbs-shadow-host' }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('楼层面板跟随插件开关', () => {
  it('关掉总开关或把当前角色加入排除名单时立即撤下面板，重新启用时立即补挂', async () => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('@/api/settings');
    const chat = [
      { name: '玩家', is_user: true, is_system: false, mes: '你好' },
      { name: '角色', is_user: false, is_system: false, mes: '她点了点头。' },
    ];
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat, characterId: 0, characters: [{ name: '角色', avatar: 'a.png' }],
      eventSource: { on: vi.fn() }, eventTypes: {},
    } as unknown as import('@/st/context').STContext);
    // 找楼层元素 = 正在给 AI 楼挂面板；清理时按宿主类名查询
    const querySelector = vi.fn((_selector: string) => null);
    const querySelectorAll = vi.fn((_selector: string) => []);
    vi.stubGlobal('document', { querySelector, querySelectorAll, getElementById: () => null });
    settings.apiSettings.ui.showFloorPanel = true;
    const { bindFloorPanel } = await import('./floorPanel');
    const mounts = () => querySelector.mock.calls.filter(c => String(c[0]).includes('mesid="1"')).length;

    bindFloorPanel();
    expect(mounts()).toBe(1);

    settings.apiSettings.enabled = false;
    await nextTick();
    expect(querySelectorAll).toHaveBeenCalledWith('.bbs-fp-host'); // 撤下已挂的面板
    expect(mounts()).toBe(1); // 停用期间不补挂

    settings.apiSettings.enabled = true;
    await nextTick();
    expect(mounts()).toBe(2);

    settings.apiSettings.excludedChars.push('角色');
    await nextTick();
    const before = mounts();
    settings.apiSettings.excludedChars.splice(0);
    await nextTick();
    expect(mounts()).toBe(before + 1);
  });

  // 当前角色名不是响应式数据:切换聊天后,侦听器记下的旧值可能与新值相同,不能只看值有没有变
  async function setupTwoChars() {
    vi.resetModules();
    vi.useFakeTimers();
    const context = await import('@/st/context');
    const settings = await import('@/api/settings');
    const handlers = new Map<string, () => void>();
    const ctx = {
      chat: [
        { name: '玩家', is_user: true, is_system: false, mes: '你好' },
        { name: '角色', is_user: false, is_system: false, mes: '她点了点头。' },
      ],
      characterId: 0,
      characters: [{ name: '甲', avatar: 'a.png' }, { name: '乙', avatar: 'b.png' }],
      eventSource: { on: (name: string, fn: () => void) => handlers.set(name, fn) },
      eventTypes: { CHAT_CHANGED: 'chat_changed' },
    };
    vi.spyOn(context, 'getContext').mockReturnValue(ctx as unknown as import('@/st/context').STContext);
    const querySelector = vi.fn((_selector: string) => null);
    const querySelectorAll = vi.fn((_selector: string) => []);
    vi.stubGlobal('document', { querySelector, querySelectorAll, getElementById: () => null });
    settings.apiSettings.enabled = true;
    settings.apiSettings.ui.showFloorPanel = true;
    const { bindFloorPanel } = await import('./floorPanel');
    const mounts = () => querySelector.mock.calls.filter(c => String(c[0]).includes('mesid="1"')).length;
    /** 全量重扫的次数(每次重扫先按宿主类名清掉已挂的面板) */
    const rebuilds = () => querySelectorAll.mock.calls.filter(c => c[0] === '.bbs-fp-host').length;
    /** 切换到第 idx 个角色的聊天(由 CHAT_CHANGED 重扫) */
    const switchTo = (idx: number) => {
      ctx.characterId = idx;
      handlers.get('chat_changed')?.();
      vi.advanceTimersByTime(100);
    };
    return { settings, bindFloorPanel, mounts, rebuilds, switchTo };
  }

  it('从生效的聊天切到被排除角色的聊天后，把这个角色移出排除名单时立即补挂', async () => {
    const { settings, bindFloorPanel, mounts, switchTo } = await setupTwoChars();
    settings.apiSettings.excludedChars.splice(0, settings.apiSettings.excludedChars.length, '乙');
    bindFloorPanel(); // 在「甲」的聊天里:挂面板
    expect(mounts()).toBe(1);
    switchTo(1); // 切到被排除的「乙」:撤下
    expect(mounts()).toBe(1);
    settings.apiSettings.excludedChars.splice(0);
    await nextTick();
    expect(mounts()).toBe(2);
  });

  it('从被排除角色的聊天切到生效的聊天后，把当前角色加入排除名单时立即撤下', async () => {
    const { settings, bindFloorPanel, mounts, rebuilds, switchTo } = await setupTwoChars();
    settings.apiSettings.excludedChars.splice(0, settings.apiSettings.excludedChars.length, '乙');
    switchTo(1); // 绑定前先处在「乙」的聊天里
    bindFloorPanel(); // 被排除:不挂
    expect(mounts()).toBe(0);
    switchTo(0); // 切到「甲」:挂上
    expect(mounts()).toBe(1);
    const before = rebuilds();
    settings.apiSettings.excludedChars.push('甲');
    await nextTick();
    expect(rebuilds()).toBe(before + 1); // 立即撤下
    switchTo(0);
    expect(mounts()).toBe(1); // 之后也不再补挂
  });

  it('排除名单里加入与当前聊天无关的名字时不重扫面板', async () => {
    const { settings, bindFloorPanel, mounts, rebuilds } = await setupTwoChars();
    settings.apiSettings.excludedChars.splice(0);
    bindFloorPanel();
    expect(mounts()).toBe(1);
    const before = rebuilds();
    settings.apiSettings.excludedChars.push('丙');
    await nextTick();
    expect(rebuilds()).toBe(before);
    expect(mounts()).toBe(1);
  });
});
