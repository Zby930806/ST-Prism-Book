import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import * as client from '@/api/client';
import * as vectorApi from '@/api/baibaoku';
import { apiSettings } from '@/api/settings';
import * as apply from './apply';
import * as engine from './engine';
import * as inject from './inject';
import { computeCarryoverPlan, createNewChatWithCarryover } from './carryover';
import { computeMigrationPlan, runHoraeMigration } from './migrate';
import { compatibilityState, loadMemory, memory, memoryWriteIssue } from './store';
import { MEMORY_KEY, type LeafExtra, type MemSummary } from './types';

// 真正执行入口、兼容检查、森林选择、状态编码与重放；只替换宿主/外发边界。
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const savedSettings = JSON.stringify(apiSettings);
const forbidden = () => { throw new Error('入口回归不允许真实宿主/模型/网络'); };
function leaf(i: number): LeafExtra {
  return { id: 'old-' + i, text: '旧叙事-' + i, delta: i === 0 ? {
    time: '2031/4/12 19:10', location: '旧厨房',
    items: { add: [{ name: '地图', qty: 2 }] },
    plans: { add: [{ kind: 'plan', content: '归还地图' }] },
    varOps: [{ op: 'set', path: 'score', value: 7 }],
  } : i === 2 ? { items: { add: [{ name: '地图', qty: 1 }] } } : {}, createdAt: i + 1, v: 1, swipe: 0 };
}
function message(i: number): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes: '原正文-' + i, swipe_id: 0,
    extra: { otherPlugin: { keep: i }, bbs_leaf: leaf(i) },
    horae_meta: { events: [{ summary: 'Horae叙事-' + i }], items: { '苹果(3)': { holder: '主角' } } },
  } as STMessage;
}
function forest(): MemSummary[] {
  return [{ id: 'old-summary', text: '不可丢的窗口外历史', level: 1, createdAt: 9, auto: false, childIds: ['old-0', 'old-1'] }];
}
function host(id: string, chat: STMessage[] = [message(0), message(1), message(2)], raw: unknown = { version: 3, summaries: forest(), customTop: '保留' }) {
  const h = {
    id, chat, chatMetadata: { [MEMORY_KEY]: raw, bbs_bundles: ['parent-hash'], otherPlugin: { keep: true } } as Record<string, unknown>,
    name1: '用户', name2: '角色', characterId: 0, characters: [{ name: '角色', avatar: 'test.png' }],
    getCurrentChatId: () => h.id,
    saveChat: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveMetadata: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveMetadataDebounced: vi.fn(), reloadCurrentChat: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  return h;
}
type Host = ReturnType<typeof host>;
let current: Host;
let source: Host;
let target: Host;
const doNewChat = vi.fn<(opts?: { deleteCurrentChat?: boolean }) => Promise<void>>();
function view(h: Host) { return JSON.stringify({ chat: h.chat, meta: h.chatMetadata }); }
function noSave(h: Host) {
  expect(h.saveChat).not.toHaveBeenCalled();
  expect(h.saveMetadata).not.toHaveBeenCalled();
  expect(h.saveMetadataDebounced).not.toHaveBeenCalled();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const axes = ['chat', 'metadata', 'id'] as const;
type Axis = typeof axes[number];
function changeOwner(axis: Axis) {
  if (axis === 'chat') current.chat = clone(current.chat);
  if (axis === 'metadata') current.chatMetadata = clone(current.chatMetadata);
  if (axis === 'id') current.id += '-switched';
  loadMemory();
}
function protect(mode: 'protected' | 'convert' | 'converting', h = current) {
  if (mode === 'protected') h.chatMetadata[MEMORY_KEY] = { version: 999, summaries: [] };
  if (mode === 'convert') {
    h.chat = [message(0)];
    delete h.chat[0].extra!.bbs_leaf;
    h.chatMetadata[MEMORY_KEY] = { version: 2, summaries: [{ ...leaf(0), level: 0, coveredIndices: [0] }] };
  }
  loadMemory();
  if (mode === 'converting') compatibilityState.converting = true;
  expect(memoryWriteIssue()).not.toBe('');
}

beforeEach(() => {
  vi.restoreAllMocks();
  compatibilityState.converting = false;
  Object.assign(apiSettings, JSON.parse(savedSettings));
  apiSettings.vector.enabled = true;
  source = host('source');
  target = host('target', [], { version: 3, summaries: [] });
  delete target.chatMetadata.bbs_bundles;
  current = source;
  vi.spyOn(context, 'getContext').mockImplementation(() => current as unknown as STContext);
  vi.spyOn(context, 'getDoNewChat').mockImplementation(async () => doNewChat);
  doNewChat.mockReset().mockImplementation(async () => { current = target; loadMemory(); });
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(engine, 'syncHiddenNow').mockResolvedValue(undefined);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(2);
  vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
  vi.spyOn(vectorApi, 'isBaiBaoKuAvailable').mockResolvedValue(true);
  vi.spyOn(vectorApi, 'vecBundleCreate').mockResolvedValue({ hash: 'new-hash' } as Awaited<ReturnType<typeof vectorApi.vecBundleCreate>>);
  vi.spyOn(client, 'requestCompletion').mockImplementation(forbidden);
  vi.spyOn(client, 'requestViaMainApi').mockImplementation(forbidden);
  vi.stubGlobal('fetch', vi.fn(forbidden));
  loadMemory();
});
afterEach(() => {
  expect(client.requestCompletion).not.toHaveBeenCalled();
  expect(client.requestViaMainApi).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  compatibilityState.converting = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.assign(apiSettings, JSON.parse(savedSettings));
});

describe('保护态入口在读取快照/修改/外发之前停止', () => {
  it.each(['protected', 'convert', 'converting'] as const)('%s: 两个预览禁用，两个执行入口无副作用', async mode => {
    protect(mode);
    const before = view(source);
    const derive = vi.spyOn(apply, 'deriveMemory');
    const select = vi.spyOn(inject, 'selectHistoryNodesBefore');
    expect(computeMigrationPlan()).toMatchObject({ hasData: false, blockedReason: expect.any(String) });
    expect(computeCarryoverPlan()).toMatchObject({ hasData: false, blockedReason: expect.any(String) });
    expect(await runHoraeMigration()).toBe(false);
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(view(source)).toBe(before);
    expect(derive).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(context.getDoNewChat).not.toHaveBeenCalled();
    expect(vectorApi.isBaiBaoKuAvailable).not.toHaveBeenCalled();
    expect(vectorApi.vecBundleCreate).not.toHaveBeenCalled();
    expect(doNewChat).not.toHaveBeenCalled();
    expect(engine.syncHiddenNow).not.toHaveBeenCalled();
    noSave(source);
  });
});

describe('Horae 候选、失败恢复及异步归属', () => {
  it('正常迁移保留其他插件与原文，明确等待聊天及 metadata 保存', async () => {
    const before = clone(source.chat);
    expect(computeMigrationPlan()).toMatchObject({ hasData: true, leafFloors: 3, pendingFloors: 0 });
    expect(await runHoraeMigration()).toBe(true);
    expect(source.chat.map(m => m.mes)).toEqual(before.map(m => m.mes));
    expect(source.chat[0].extra!.otherPlugin).toEqual(before[0].extra!.otherPlugin);
    expect(source.chat[0].extra!.bbs_leaf!.text).toBe('Horae叙事-0');
    // 最终状态单独存在最后一片叶子的 migratedDelta 上,不并入 delta(重新摘要这一楼时不丢)
    const seed = source.chat[2].extra!.bbs_leaf as LeafExtra & { migratedDelta?: unknown };
    expect(seed.delta).toEqual({});
    expect(seed.migratedDelta).toMatchObject({ items: { add: [{ name: '苹果', qty: 3 }] } });
    expect(memory.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: '苹果', qty: 3 })]));
    expect(source.chatMetadata[MEMORY_KEY]).toMatchObject({ version: 3, customTop: '保留' });
    expect(source.saveChat).toHaveBeenCalledTimes(1);
    expect(source.saveMetadata).toHaveBeenCalledTimes(1);
    expect(source.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(engine.syncHiddenNow).toHaveBeenCalledTimes(1);
  });
  it('子总结范围内没有叙事楼层时，父总结不留悬空引用，子总结存为导入历史；预览写明待补摘的楼层', async () => {
    const plain = (i: number, events = true): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: '原正文-' + i, swipe_id: 0, extra: {},
      ...(events ? { horae_meta: { events: [{ summary: 'Horae叙事-' + i }] } } : {}) } as STMessage);
    const chat = [plain(0), plain(1), plain(2, false), plain(3, false), plain(4, false)];
    (chat[0] as unknown as { horae_meta: Record<string, unknown> }).horae_meta.autoSummaries = [
      { id: 'top', range: [0, 3], summaryText: '整段总结', depth: 2, mergedSummaries: [{ id: 'child', range: [2, 3], summaryText: '后半段总结', depth: 1 }] },
    ];
    source = host('source', chat, { version: 3, summaries: [] });
    current = source;
    loadMemory();
    // #4 没有 Horae 记录、也不在任何总结范围内:迁移后需要补摘
    expect(computeMigrationPlan()).toMatchObject({ hasData: true, leafFloors: 2, summaryCount: 2, pendingFloors: 1 });
    expect(await runHoraeMigration()).toBe(true);
    const forest = memory.summaries;
    const child = forest.find(s => s.id === 'child');
    const top = forest.find(s => s.id === 'top');
    expect(child).toMatchObject({ imported: true, importedFloorStart: 2, importedFloorEnd: 3, childIds: [], text: '后半段总结' });
    expect(top?.childIds).toEqual(['child', chat[0].extra!.bbs_leaf!.id, chat[1].extra!.bbs_leaf!.id]);
    expect(compatibilityState.mode).toBe('ready');
    expect(engine.pendingAiFloors(source.chat)).toEqual([4]);
    expect(notices.toast).toHaveBeenLastCalledWith(expect.stringContaining('另有 1 层没有 Horae 记录'), 'warning');
  });
  it('造第二片叶子失败时第一片也不泄漏到源聊天', async () => {
    const before = view(source);
    vi.spyOn(apply, 'makeLeafId').mockReturnValueOnce('candidate-first').mockImplementationOnce(() => { throw new Error('候选失败'); });
    expect(await runHoraeMigration()).toBe(false);
    expect(view(source)).toBe(before);
    noSave(source);
  });
  it.each(['saveChat', 'saveMetadata'] as const)('%s 失败只恢复仍归属本次的内存', async boundary => {
    const before = view(source);
    const originalExtra = source.chat[0].extra;
    const originalRaw = source.chatMetadata[MEMORY_KEY];
    const oldForest = clone(memory.summaries);
    source[boundary].mockRejectedValueOnce(new Error('保存失败'));
    expect(await runHoraeMigration()).toBe(false);
    expect(view(source)).toBe(before);
    expect(source.chat[0].extra).toBe(originalExtra);
    expect(source.chatMetadata[MEMORY_KEY]).toBe(originalRaw);
    expect(memory.summaries).toEqual(oldForest);
    expect(engine.syncHiddenNow).not.toHaveBeenCalled();
    expect(notices.toast).toHaveBeenLastCalledWith(expect.stringContaining('未执行磁盘回滚'), 'error');
  });
  for (const boundary of ['saveChat', 'saveMetadata'] as const) {
    it.each(axes)(boundary + ' 挂起后仅 %s 变化也停止，不回写新归属缓存', async axis => {
      const gate = deferred();
      source[boundary].mockReturnValueOnce(gate.promise);
      const pending = runHoraeMigration();
      await vi.waitFor(() => expect(source[boundary]).toHaveBeenCalledTimes(1));
      changeOwner(axis);
      const switched = view(current);
      const forest = clone(memory.summaries);
      gate.resolve();
      expect(await pending).toBe(false);
      expect(view(current)).toBe(switched);
      expect(memory.summaries).toEqual(forest);
      if (boundary === 'saveChat') expect(source.saveMetadata).not.toHaveBeenCalled();
      expect(engine.syncHiddenNow).not.toHaveBeenCalled();
    });
  }
});

describe('carryover 快照、外发和新聊天提交', () => {
  it('正常携带真实窗口外森林/物品/计划/变量并继承 bundle，源历史不变', async () => {
    const before = view(source);
    const oldState = apply.deriveMemory(source.chat);
    expect(computeCarryoverPlan()).toMatchObject({ hasData: true, carryStart: 2, carryCount: 1 });
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(view(source)).toBe(before);
    expect(target.chat).toHaveLength(2);
    expect(target.chat[0].extra!.bbs_leaf).toMatchObject({ seed: true, text: expect.stringContaining('不可丢的窗口外历史') });
    expect(target.chat[1]).toEqual(source.chat[2]);
    const restored = apply.deriveMemory(target.chat);
    // 新种子的运行时间会变化，只比较业务字段，不把真实时间固定进生产代码。
    const itemBusiness = (items: typeof restored.items) => items.map(({ createdAt: _c, updatedAt: _u, ...business }) => business);
    const planBusiness = (plans: typeof restored.plans) => plans.map(({ id: _id, createdAt: _c, resolvedAt: _r, ...business }) => business);
    expect(itemBusiness(restored.items)).toEqual(itemBusiness(oldState.items));
    expect(planBusiness(restored.plans)).toEqual(planBusiness(oldState.plans));
    expect(restored.plans[0].id).toBe('plan:' + target.chat[0].extra!.bbs_leaf!.id + '#0');
    expect(restored.vars).toEqual(oldState.vars);
    expect(restored.state).toEqual(oldState.state);
    expect(target.chatMetadata.bbs_bundles).toEqual(['parent-hash', 'new-hash']);
    expect(source.saveChat).toHaveBeenCalledTimes(1);
    expect(target.saveChat).toHaveBeenCalledTimes(1);
    expect(target.saveMetadata).toHaveBeenCalledTimes(1);
    expect(target.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(doNewChat).toHaveBeenCalledWith({ deleteCurrentChat: false });
  });
  it('向量服务失败只降级召回，不丢派生状态与父 bundle', async () => {
    vi.mocked(vectorApi.vecBundleCreate).mockRejectedValueOnce(new Error('离线'));
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(target.chatMetadata.bbs_bundles).toEqual(['parent-hash']);
    expect(target.chat[0].extra!.bbs_leaf!.delta.items!.add).toEqual(expect.arrayContaining([expect.objectContaining({ name: '地图', qty: 2 })]));
  });
  it('种子叶子带上角色的曾用名；窗口前未摘要的楼层在预览里写明', async () => {
    source.chat[0].extra!.bbs_leaf!.delta = { npcs: { add: [{ name: '酒保A', title: '酒保' }] } };
    source.chat[1].extra!.bbs_leaf!.delta = { npcs: { rename: [{ from: '酒保A', to: '老周' }] } };
    loadMemory();
    expect(computeCarryoverPlan()).toMatchObject({ pendingBefore: 0 });
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(target.chat[0].extra!.bbs_leaf!.delta.npcs!.add).toEqual([expect.objectContaining({ name: '老周', formerNames: ['酒保A'] })]);
    // 窗口前有一层没有摘要(总结也一并去掉,免得引用缺失的楼层)
    current = source;
    delete source.chat[1].extra!.bbs_leaf;
    source.chatMetadata[MEMORY_KEY] = { version: 3, summaries: [] };
    loadMemory();
    expect(computeCarryoverPlan()).toMatchObject({ pendingBefore: 1 });
  });
  it('窗口内叶子上单独保存的手动修改,对窗口前条目的引用同样改挂到种子叶', async () => {
    // 窗口前(#0)记下计划、生活档案、信息差;窗口内(#2)在页面上编辑计划、沉降档案、结案信息差
    Object.assign(source.chat[0].extra!.bbs_leaf!.delta, {
      lifeDetails: { add: [{ subject: 'user', text: '喝茶不加糖' }] },
      secrets: { add: [{ content: '地图是借来的', unaware: ['角色'] }] },
    });
    (source.chat[2].extra!.bbs_leaf as LeafExtra).manualOps = {
      plans: { update: [{ id: 'plan:old-0#0', content: '明天归还地图' }] },
      lifeDetails: { archive: ['detail:old-0#0'] },
      secrets: { resolve: ['secret:old-0#0'] },
    };
    // 另一页回复上的叶子同样改写(翻到那一页时引用仍然对得上)
    Object.assign(source.chat[2], { swipe_info: [{ extra: {} }, { extra: { bbs_leaf: { ...leaf(2), id: 'old-2-alt', swipe: 1, manualOps: { plans: { remove: ['plan:old-0#0'] } } } } }] });
    loadMemory();
    expect(memory.plans.find(p => p.id === 'plan:old-0#0')?.content).toBe('明天归还地图');
    expect(await createNewChatWithCarryover()).toBe(true);
    const seedId = target.chat[0].extra!.bbs_leaf!.id;
    expect((target.chat[1].extra!.bbs_leaf as LeafExtra).manualOps).toEqual({
      plans: { update: [{ id: `plan:${seedId}#0`, content: '明天归还地图' }] },
      lifeDetails: { archive: [`detail:${seedId}#0`] },
      secrets: { resolve: [`secret:${seedId}#0`] },
    });
    const altPage = (target.chat[1] as unknown as { swipe_info: Array<{ extra: { bbs_leaf: LeafExtra } }> }).swipe_info[1];
    expect(altPage.extra.bbs_leaf.manualOps?.plans?.remove).toEqual([`plan:${seedId}#0`]);
    const derived = apply.deriveMemory(target.chat);
    expect(derived.plans).toEqual([expect.objectContaining({ id: `plan:${seedId}#0`, content: '明天归还地图', status: 'open' })]);
    expect(derived.lifeDetails).toEqual([expect.objectContaining({ text: '喝茶不加糖', tier: 'archive' })]);
    expect(derived.secrets).toEqual([expect.objectContaining({ content: '地图是借来的', status: 'resolved' })]);
    // 源聊天的叶子不受影响
    expect((source.chat[2].extra!.bbs_leaf as LeafExtra).manualOps?.plans?.update?.[0].id).toBe('plan:old-0#0');
  });
  for (const boundary of ['interface', 'available', 'bundle', 'sourceSave'] as const) {
    it.each(axes)(boundary + ' 挂起期间仅源 %s 变化，禁止后续外发/建聊', async axis => {
      const gate = deferred();
      const entered = vi.fn();
      if (boundary === 'interface') vi.mocked(context.getDoNewChat).mockImplementationOnce(async () => { entered(); await gate.promise; return doNewChat; });
      if (boundary === 'available') vi.mocked(vectorApi.isBaiBaoKuAvailable).mockImplementationOnce(async () => { entered(); await gate.promise; return true; });
      if (boundary === 'bundle') vi.mocked(vectorApi.vecBundleCreate).mockImplementationOnce(async () => { entered(); await gate.promise; return { hash: 'new-hash' } as Awaited<ReturnType<typeof vectorApi.vecBundleCreate>>; });
      if (boundary === 'sourceSave') source.saveChat.mockImplementationOnce(async () => { entered(); await gate.promise; });
      const pending = createNewChatWithCarryover();
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
      changeOwner(axis);
      const switched = view(current);
      gate.resolve();
      expect(await pending).toBe(false);
      expect(view(current)).toBe(switched);
      expect(doNewChat).not.toHaveBeenCalled();
      if (boundary !== 'sourceSave') expect(source.saveChat).not.toHaveBeenCalled();
      if (boundary === 'interface' || boundary === 'available') expect(vectorApi.vecBundleCreate).not.toHaveBeenCalled();
      if (boundary === 'interface') expect(vectorApi.isBaiBaoKuAvailable).not.toHaveBeenCalled();
      noSave(target);
    });
  }
  it('服务可用性返回时源变为保护态，不能吞掉错误继续 bundle', async () => {
    vi.mocked(vectorApi.isBaiBaoKuAvailable).mockImplementationOnce(async () => { protect('protected'); return true; });
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(vectorApi.vecBundleCreate).not.toHaveBeenCalled();
    expect(doNewChat).not.toHaveBeenCalled();
    noSave(source);
  });
  it('接口加载拒绝被入口捕获而非未处理 rejection', async () => {
    vi.mocked(context.getDoNewChat).mockRejectedValueOnce(new Error('加载失败'));
    await expect(createNewChatWithCarryover()).resolves.toBe(false);
    noSave(source);
  });
  it('建聊接口未切换时不重写源会话', async () => {
    const before = view(source);
    doNewChat.mockResolvedValueOnce(undefined);
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(view(source)).toBe(before);
    expect(source.saveMetadata).not.toHaveBeenCalled();
  });
  it.each(['protected', 'convert'] as const)('目标 %s 时不插入锚点、森林或 bundle', async mode => {
    let before = '';
    doNewChat.mockImplementationOnce(async () => { current = target; protect(mode, target); before = view(target); });
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(view(target)).toBe(before);
    noSave(target);
  });
  it('目标已有用户历史时拒绝覆盖', async () => {
    target.chat.push({ name: '用户', is_user: true, is_system: false, mes: '不能删' });
    const before = view(target);
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(view(target)).toBe(before);
    noSave(target);
  });
  it.each(['saveChat', 'saveMetadata'] as const)('目标 %s 失败恢复开场白、森林和原 bundle', async boundary => {
    target.chat.push({ name: '角色', is_user: false, is_system: false, mes: '原开场白', swipes: ['原开场白'], extra: { otherPlugin: 'keep' } });
    target.chatMetadata.bbs_bundles = ['target-existing'];
    const before = view(target);
    const greeting = target.chat[0];
    target[boundary].mockRejectedValueOnce(new Error('目标保存失败'));
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(view(target)).toBe(before);
    expect(target.chat[0]).toBe(greeting);
    expect(memory.summaries).toEqual([]);
    expect(target.reloadCurrentChat).not.toHaveBeenCalled();
    expect(inject.refreshInjection).not.toHaveBeenCalled();
    expect(notices.toast).toHaveBeenLastCalledWith(expect.stringContaining('未执行磁盘回滚'), 'error');
  });
  for (const boundary of ['saveChat', 'saveMetadata'] as const) {
    it.each(axes)('目标 ' + boundary + ' 后仅 %s 变化，不操作切换后的聊天', async axis => {
      const gate = deferred();
      target[boundary].mockReturnValueOnce(gate.promise);
      const pending = createNewChatWithCarryover();
      await vi.waitFor(() => expect(target[boundary]).toHaveBeenCalledTimes(1));
      changeOwner(axis);
      const switched = view(current);
      const forest = clone(memory.summaries);
      gate.resolve();
      expect(await pending).toBe(false);
      expect(view(current)).toBe(switched);
      expect(memory.summaries).toEqual(forest);
      if (boundary === 'saveChat') expect(target.saveMetadata).not.toHaveBeenCalled();
      expect(target.reloadCurrentChat).not.toHaveBeenCalled();
      expect(inject.refreshInjection).not.toHaveBeenCalled();
    });
  }
  it('重载合法替换引用仍可完成，切到不同 id 则禁止刷新', async () => {
    target.reloadCurrentChat.mockImplementationOnce(async () => { target.chat = clone(target.chat); target.chatMetadata = clone(target.chatMetadata); loadMemory(); });
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(inject.refreshInjection).toHaveBeenCalledTimes(1);
  });
  it('重载期间切换 id 不刷新其他聊天', async () => {
    target.reloadCurrentChat.mockImplementationOnce(async () => { changeOwner('id'); });
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(inject.refreshInjection).not.toHaveBeenCalled();
  });
});


describe('候选失败及后续编辑不能被恢复覆盖', () => {
  it('无 extra 的 Horae 楼恢复时保持属性原本不存在', async () => {
    source.chat.forEach(m => { delete m.extra; });
    source.chatMetadata[MEMORY_KEY] = { version: 3, summaries: [] };
    loadMemory();
    const before = view(source);
    source.saveChat.mockRejectedValueOnce(new Error('保存失败'));
    expect(await runHoraeMigration()).toBe(false);
    expect(view(source)).toBe(before);
    expect(source.chat.every(m => !Object.hasOwn(m, 'extra'))).toBe(true);
  });
  it('缺少可等待的聊天保存接口时不修改迁移源', async () => {
    Object.assign(source, { saveChat: undefined });
    const before = view(source);
    expect(await runHoraeMigration()).toBe(false);
    expect(view(source)).toBe(before);
    expect(source.saveMetadata).not.toHaveBeenCalled();
  });
  it('完整 saveChat 宿主可省略额外 metadata 接口', async () => {
    Object.assign(source, { saveMetadata: undefined });
    expect(await runHoraeMigration()).toBe(true);
    expect(source.saveChat).toHaveBeenCalledTimes(1);
  });
  it('迁移候选引用冲突在任何源修改之前失败', async () => {
    vi.spyOn(apply, 'makeLeafId').mockReturnValue('duplicated-candidate');
    const before = view(source);
    expect(await runHoraeMigration()).toBe(false);
    expect(view(source)).toBe(before);
    noSave(source);
  });
  it('迁移保存失败不抹掉等待期间的嵌套 extra 编辑', async () => {
    source.saveChat.mockImplementationOnce(async () => {
      source.chat[0].extra!.otherPlugin = { newEdit: true };
      throw new Error('保存失败');
    });
    expect(await runHoraeMigration()).toBe(false);
    expect(source.chat[0].extra!.otherPlugin).toEqual({ newEdit: true });
    expect(source.saveMetadata).not.toHaveBeenCalled();
  });
  it('携带候选构造失败不留下被清空的开场白', async () => {
    target.chat.push({ name: '角色', is_user: false, is_system: false, mes: '原开场白', swipes: ['原开场白'] });
    const before = view(target);
    vi.spyOn(context, 'setMessageText').mockImplementationOnce(m => { m!.mes = ''; throw new Error('候选失败'); });
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(view(target)).toBe(before);
    noSave(target);
  });
  it('携带保存失败不抹掉等待期间的新消息编辑', async () => {
    target.saveChat.mockImplementationOnce(async () => {
      target.chat[1].mes = '等待保存期间用户改过的内容';
      throw new Error('保存失败');
    });
    expect(await createNewChatWithCarryover()).toBe(false);
    expect(target.chat[1].mes).toBe('等待保存期间用户改过的内容');
    expect(target.saveMetadata).not.toHaveBeenCalled();
  });
  it('明确更换 chat 数组即可接续；允许暂复用 id/meta 且只提供 saveChat', async () => {
    Object.assign(source, { saveMetadata: undefined, reloadCurrentChat: undefined });
    doNewChat.mockImplementationOnce(async () => { source.chat = []; });
    // 旧宿主没有 CHAT_CHANGED 重载；只移除旧森林作为它的新聊初始化。
    source.chatMetadata[MEMORY_KEY] = { version: 3, summaries: [] };
    loadMemory();
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(source.chat[0].extra!.bbs_leaf!.seed).toBe(true);
    expect(source.saveChat).toHaveBeenCalledTimes(2);
    expect(source.saveMetadataDebounced).not.toHaveBeenCalled();
  });
  for (const boundary of ['interface', 'bundle', 'sourceSave'] as const) {
    it.each(['protected', 'convert', 'converting'] as const)(boundary + ' 返回时变为 %s，禁止继续建聊', async mode => {
      const stop = () => protect(mode);
      if (boundary === 'interface') vi.mocked(context.getDoNewChat).mockImplementationOnce(async () => { stop(); return doNewChat; });
      if (boundary === 'bundle') vi.mocked(vectorApi.vecBundleCreate).mockImplementationOnce(async () => { stop(); return { hash: 'hash' } as Awaited<ReturnType<typeof vectorApi.vecBundleCreate>>; });
      if (boundary === 'sourceSave') source.saveChat.mockImplementationOnce(async () => { stop(); });
      expect(await createNewChatWithCarryover()).toBe(false);
      expect(doNewChat).not.toHaveBeenCalled();
      noSave(target);
    });
  }
});
