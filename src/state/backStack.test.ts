import { describe, expect, it } from 'vitest';
import { BACK_GUARD_KEY, createBackStack, type BackStack, type HistoryPort } from './backStack';

/**
 * 模拟浏览器：pushState 同步截断前进记录并追加；history.back() 与用户按返回键都是异步任务，
 * 完成后派发 popstate；退到第一条之前就算离开了页面。
 * 用户操作（tap）与历史跳转共用一个时钟，用来模拟 Chromium「按返回之后，之前的点按不再算数」的规则。
 */
function fakeBrowser(opts: { leaveDelayMs?: number; backIgnored?: boolean; hasBeenActive?: boolean } = {}) {
  const entries: unknown[] = [{ page: 'st' }];
  let index = 0;
  let leftPage = false;
  let pushes = 0;
  let backs = 0;
  let clock = 1;
  let lastTap = 0;
  const waiters: Array<() => void> = [];
  const listeners: Array<() => void> = [];
  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0) { leftPage = true; return; }
    if (next >= entries.length) return;
    index = next;
    clock++;
    for (const listener of listeners) listener();
  };
  const history: HistoryPort = {
    get state() { return entries[index]; },
    pushState(data: unknown) {
      pushes++;
      entries.splice(index + 1);
      entries.push(JSON.parse(JSON.stringify(data)));
      index = entries.length - 1;
    },
    back() { backs++; if (!opts.backIgnored) setTimeout(() => go(-1), 0); },
  };
  const stack = createBackStack({
    history,
    activation: {
      lastAt: () => lastTap,
      hasBeenActive: () => opts.hasBeenActive ?? true,
      onNext: cb => { waiters.push(cb); },
    },
    now: () => clock,
    listen: handler => listeners.push(handler),
    defer: task => queueMicrotask(task),
    timer: (task, ms) => { const id = setTimeout(task, ms); return () => clearTimeout(id); },
    leaveDelayMs: opts.leaveDelayMs ?? 0,
  });
  return {
    stack,
    history,
    /** 用户点按或按键（浏览器把它当作用户操作） */
    tap: () => { clock++; lastTap = clock; for (const cb of waiters.splice(0)) cb(); },
    /** 用户按一次返回键 */
    pressBack: () => setTimeout(() => go(-1), 0),
    pressForward: () => setTimeout(() => go(1), 0),
    /** 别的脚本压一条自己的记录 */
    foreignPush: () => history.pushState({ foreign: true }, ''),
    get index() { return index; },
    get leftPage() { return leftPage; },
    get pushes() { return pushes; },
    get backs() { return backs; },
    onGuard: () => !!entries[index] && typeof entries[index] === 'object' && BACK_GUARD_KEY in (entries[index] as object),
  };
}

/** 跑完已排队的任务与微任务（后退、popstate、补压记录可能连着排几轮）。 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** 模拟一个界面：close 后同步注销（与 useBackLayer 的同步 watch 一致）；busy 时拒绝关闭。 */
function layer(stack: BackStack, name: string, log: string[], opts: { busy?: () => boolean; asyncRelease?: boolean } = {}) {
  const state = { open: true, release: () => {} };
  const finish = () => { state.open = false; state.release(); };
  state.release = stack.open(() => {
    if (opts.busy?.()) { log.push(name + ':busy'); return; }
    log.push(name);
    // 模拟弹窗由父组件下一次更新才收起
    if (opts.asyncRelease) queueMicrotask(finish); else finish();
  });
  return { state, closeByButton: finish };
}

/** 用户点按打开一层（打开时有用户操作）。 */
function tapOpen(b: ReturnType<typeof fakeBrowser>, name: string, log: string[], opts?: Parameters<typeof layer>[3]) {
  b.tap();
  return layer(b.stack, name, log, opts);
}

describe('返回键分层关闭', () => {
  it('多层：每层打开时压一条记录；每按一次返回只关最上面一层，不补压；全部关掉后不再拦截', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    tapOpen(b, '窗口', log);
    tapOpen(b, '弹窗', log);
    tapOpen(b, '下拉列表', log, { asyncRelease: true });
    await settle();
    expect(b.pushes).toBe(3);
    expect(b.index).toBe(3);

    b.pressBack(); await settle();
    expect(log).toEqual(['下拉列表']);
    b.pressBack(); await settle();
    expect(log).toEqual(['下拉列表', '弹窗']);
    b.pressBack(); await settle();
    expect(log).toEqual(['下拉列表', '弹窗', '窗口']);
    expect(b.pushes).toBe(3); // 按返回之后没有补压记录（Chromium 会让返回键跳过这样的记录）
    expect(b.backs).toBe(0);
    expect(b.stack.depth).toBe(0);
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);

    b.pressBack(); await settle();
    expect(b.leftPage).toBe(true); // 全部关闭后按浏览器原来的行为
    expect(log).toHaveLength(3);
  });

  it('用关闭键关掉最后一层时，自己退掉记录，不离开页面', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    const win = tapOpen(b, '窗口', log);
    await settle();
    win.closeByButton();
    await settle();
    expect(b.backs).toBe(1);
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);
    b.pressBack(); await settle();
    expect(b.leftPage).toBe(true);
  });

  it('关闭键关掉上层而下层还在时，退掉一条记录；之后返回键关下层', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    tapOpen(b, '窗口', log);
    const dialog = tapOpen(b, '弹窗', log);
    await settle();
    dialog.closeByButton();
    await settle();
    expect(b.backs).toBe(1);
    expect(b.index).toBe(1);
    expect(b.onGuard()).toBe(true);
    b.pressBack(); await settle();
    expect(log).toEqual(['窗口']);
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);
  });

  it('连续快速按返回：逐层关闭，不会多退一步离开页面', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    tapOpen(b, '窗口', log);
    tapOpen(b, '规划讨论', log);
    tapOpen(b, '草稿面板', log, { asyncRelease: true });
    await settle();
    b.pressBack(); b.pressBack(); b.pressBack(); // 三次返回排在同一轮
    await settle();
    expect(log).toEqual(['草稿面板', '规划讨论', '窗口']);
    expect(b.leftPage).toBe(false);
    expect(b.index).toBe(0);
  });

  it('确认框处理中拒绝关闭：返回键退掉它的记录但它还在；用户下一次点按时补压记录，处理完后返回键才关它', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    let busy = true;
    tapOpen(b, '窗口', log);
    tapOpen(b, '确认框', log, { busy: () => busy });
    await settle();
    b.pressBack(); await settle();
    expect(log).toEqual(['确认框:busy']);
    expect(b.pushes).toBe(2); // 按返回之后不立即补压
    expect(b.stack.entries).toBe(1);
    b.tap(); // 用户点了一下确认框
    await settle();
    expect(b.pushes).toBe(3);
    expect(b.stack.entries).toBe(2);
    busy = false;
    b.pressBack(); await settle();
    expect(log).toEqual(['确认框:busy', '确认框']);
    expect(b.stack.depth).toBe(1);
    expect(b.leftPage).toBe(false);
  });

  it('按返回之后才自动弹出的层（没有新的用户操作）：先不压记录，等用户点按后再压', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    tapOpen(b, '窗口', log);
    const dialog = tapOpen(b, '弹窗', log);
    await settle();
    dialog.closeByButton(); // 关闭键 → 插件自己后退一次
    await settle();
    layer(b.stack, '摘要对比', log); // 请求完成后自动弹出，没有用户操作
    await settle();
    expect(b.pushes).toBe(2);
    expect(b.stack.entries).toBe(1);
    b.tap();
    await settle();
    expect(b.pushes).toBe(3);
    b.pressBack(); await settle();
    expect(log).toEqual(['摘要对比']);
    expect(b.leftPage).toBe(false);
  });

  it('页面还没有过用户操作时打开的层：不压记录，用户第一次点按时补压', async () => {
    const b = fakeBrowser({ hasBeenActive: false });
    const log: string[] = [];
    layer(b.stack, '窗口', log);
    await settle();
    expect(b.pushes).toBe(0);
    b.tap();
    await settle();
    expect(b.pushes).toBe(1);
    b.pressBack(); await settle();
    expect(log).toEqual(['窗口']);
  });

  it('自己的后退还在途时又打开新层：等后退落地后再压记录', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    const win = tapOpen(b, '窗口', log);
    await settle();
    win.closeByButton();
    // 两轮任务后：等待已结束、已调用 history.back()，对应的 popstate 还没回来
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(b.backs).toBe(1);
    tapOpen(b, '召回速览', log);
    await settle();
    // 点按发生在后退落地之前，按规则不算数：等用户再操作一次
    expect(b.stack.entries).toBe(0);
    b.tap();
    await settle();
    expect(b.stack.entries).toBe(1);
    b.pressBack(); await settle();
    expect(log).toEqual(['召回速览']);
    expect(b.leftPage).toBe(false);
    expect(b.index).toBe(0);
  });

  it('上面有别的脚本压的记录：返回只退掉那条记录，不关任何层；关闭时也不替别人后退', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    const win = tapOpen(b, '窗口', log);
    await settle();
    b.foreignPush();
    b.pressBack(); await settle();
    expect(log).toEqual([]);
    expect(b.onGuard()).toBe(true);
    b.foreignPush();
    win.closeByButton();
    await settle();
    expect(b.backs).toBe(0);
    expect(b.leftPage).toBe(false);
  });

  it('同一次更新里注销多层：逐条退掉，不多退', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    const a = tapOpen(b, '窗口', log);
    const c = tapOpen(b, '弹窗', log);
    const d = tapOpen(b, '菜单', log);
    await settle();
    d.closeByButton(); c.closeByButton(); a.closeByButton();
    await settle(12);
    expect(b.backs).toBe(3);
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);
  });

  it('电脑浏览器先后退再前进回到旧记录：不关任何层；没有层时自动退回', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    tapOpen(b, '窗口', log);
    await settle();
    b.pressBack(); await settle();
    expect(log).toEqual(['窗口']);
    b.pressForward(); await settle();
    expect(log).toEqual(['窗口']);
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);
  });

  it('页面卸载后不再修改历史', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    const win = tapOpen(b, '窗口', log);
    await settle();
    b.stack.freeze();
    win.closeByButton();
    await settle();
    expect(b.backs).toBe(0);
    expect(b.pushes).toBe(1);
  });

  it('注销函数重复调用无副作用', async () => {
    const b = fakeBrowser();
    b.tap();
    const release = b.stack.open(() => {});
    await settle();
    release(); release();
    await settle();
    expect(b.stack.depth).toBe(0);
    expect(b.backs).toBe(1);
  });

  it('关闭键关掉上层后，插件的后退和用户的返回同时在途：只关一层，不离开页面', async () => {
    const b = fakeBrowser();
    const log: string[] = [];
    tapOpen(b, '窗口', log);
    const dialog = tapOpen(b, '弹窗', log);
    await settle();
    dialog.closeByButton();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(b.backs).toBe(1); // 插件的后退已发出
    b.pressBack(); // 用户紧接着按了返回
    await settle();
    expect(log).toEqual(['窗口']); // 用户的返回关掉窗口
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);
  });

  it('关闭键关掉最后一层的同时按了返回：插件不再补退，不会离开页面', async () => {
    const b = fakeBrowser({ leaveDelayMs: 40 });
    const log: string[] = [];
    const win = tapOpen(b, '窗口', log);
    await settle();
    win.closeByButton(); // 插件准备退记录（先等 40ms）
    await settle(2);
    b.pressBack(); // 这期间用户按了返回，记录被用掉
    await new Promise(resolve => setTimeout(resolve, 80));
    await settle();
    expect(b.backs).toBe(0);
    expect(b.index).toBe(0);
    expect(b.leftPage).toBe(false);
  });

  it('等待期间又打开新层：不退记录，记录留给新层', async () => {
    const b = fakeBrowser({ leaveDelayMs: 40 });
    const log: string[] = [];
    const win = tapOpen(b, '窗口', log);
    await settle();
    win.closeByButton();
    await settle(2);
    tapOpen(b, '召回速览', log);
    await new Promise(resolve => setTimeout(resolve, 80));
    await settle();
    expect(b.backs).toBe(0);
    expect(b.pushes).toBe(1);
    b.pressBack(); await settle();
    expect(log).toEqual(['召回速览']);
    expect(b.leftPage).toBe(false);
  });

  it('自己的后退迟迟没有回应：超时后只放弃，不再补退', async () => {
    const scheduled: Array<{ task: () => void; ms: number; cancelled: boolean }> = [];
    let backs = 0;
    let state: unknown = null;
    const history: HistoryPort = { get state() { return state; }, pushState(data: unknown) { state = data; }, back() { backs++; } };
    const stack = createBackStack({
      history,
      activation: { lastAt: () => 1, hasBeenActive: () => true, onNext: () => {} },
      now: () => 0,
      listen: () => {},
      defer: task => queueMicrotask(task),
      timer: (task, ms) => { const item = { task, ms, cancelled: false }; scheduled.push(item); return () => { item.cancelled = true; }; },
    });
    const release = stack.open(() => {});
    await settle();
    expect(stack.entries).toBe(1);
    release();
    await settle();
    scheduled.filter(t => !t.cancelled && t.ms < 1000).forEach(t => t.task()); // 退记录前的等待
    expect(backs).toBe(1);
    scheduled.filter(t => !t.cancelled && t.ms >= 1000).forEach(t => t.task()); // 等 popstate 超时
    await settle();
    expect(backs).toBe(1);
    stack.open(() => {});
    await settle();
    expect(stack.entries).toBe(1); // 之后照常工作
  });
});
