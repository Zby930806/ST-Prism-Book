import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as host from '@/st/context';
import { makeTavern, message, ST_TEMPLATE } from './testEnv';
import { worldbookSettings } from './settings';
import { commitBatch, loadWorldbookData, worldbookState } from './store';
import { makeRange } from './source';
import { entryBase } from './entries';
import { applySuggestions, previewChange, suggestionConflict, undoApplied } from './writer';
import type { Suggestion, SuggestionBatch, WorldData } from './types';

// 写入引擎：新建、追加、替换、改写、加关键词、权限拦截、冲突检测、uid 为 0、未改动字段保留、撤销。
// 世界书读写走模拟酒馆的 loadWorldInfo / saveWorldInfo；不连接真实酒馆。
vi.mock('@/memory/engine', () => ({ isAiFloor: (m: { is_user?: boolean }) => !!m && !m.is_user }));
vi.mock('./host', async importOriginal => {
  const actual = await importOriginal<typeof import('./host')>();
  return { ...actual, entryTemplate: vi.fn(async () => JSON.parse(JSON.stringify(ST_TEMPLATE))) };
});

const BOOK = '雾港设定';
function books(): Record<string, WorldData> {
  return {
    [BOOK]: {
      entries: {
        0: { uid: 0, comment: '雾港', key: [' 雾港', '港城'], content: '潮汐环绕的港城。城北有一座旧钟塔。', constant: false, order: 50, position: 1, displayIndex: 3, characterFilter: { isExclude: false, names: [], tags: [] }, extensions: { custom: true } },
        2: { uid: 2, comment: '钟塔守则', key: ['钟塔'], content: '入夜后钟塔不对外开放。看守只认怀表。', constant: true, disable: false },
      },
      originalData: { name: BOOK, entries: [{ uid: 0, keys: ['雾港'], content: '旧的卡内内容', comment: '雾港' }] },
    },
  };
}
let tavern: ReturnType<typeof makeTavern>;
let seq = 0;
function suggestion(over: Partial<Suggestion>): Suggestion {
  return { id: 's' + (++seq), kind: 'create', uid: null, title: '', keys: [], content: '', find: '', reason: '', floors: [1], base: '', status: 'pending', edited: false, warnings: [], ...over };
}
function entryBaseOf(uid: number): string { return entryBase(tavern.books.get(BOOK)!.entries[String(uid)]); }
async function seed(list: Suggestion[], book = BOOK): Promise<SuggestionBatch> {
  const batch: SuggestionBatch = { id: 'b' + (++seq), createdAt: 1, auto: false, book, permission: 'modify', source: makeRange(tavern.ctx, 0, 1), suggestions: list, dropped: [] };
  await commitBatch(batch, null);
  return batch;
}
const stored = () => tavern.books.get(BOOK)!;

beforeEach(() => {
  tavern = makeTavern({ books: books(), primary: BOOK });
  vi.spyOn(host, 'getContext').mockImplementation(() => tavern.ctx);
  vi.stubGlobal('fetch', tavern.fetchStub);
  worldbookSettings.permission = 'modify';
  worldbookSettings.newEntry = { position: 0, order: 100, depth: 4 };
  loadWorldbookData();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('写入', () => {
  it('新建：用酒馆的条目模板和设置的插入位置、顺序；uid 取第一个空闲的（可以是 0 以外的空位）', async () => {
    worldbookSettings.newEntry = { position: 4, order: 250, depth: 2 };
    const batch = await seed([suggestion({ kind: 'create', title: '灯塔', keys: ['灯塔', '港口灯塔'], content: '港口外的灯塔。' })]);
    const before = JSON.parse(JSON.stringify(stored().entries));
    const out = await applySuggestions(batch.id, [batch.suggestions[0].id]);
    expect(out.issues).toEqual([]);
    expect(out.verified).toBe(true);
    const entry = stored().entries['1'];
    expect(entry).toEqual({ ...ST_TEMPLATE, uid: 1, comment: '灯塔', content: '港口外的灯塔。', key: ['灯塔', '港口灯塔'], addMemo: true, position: 4, order: 250, depth: 2 });
    // 其他条目原样保留
    expect(stored().entries['0']).toEqual(before['0']);
    expect(stored().entries['2']).toEqual(before['2']);
    expect(tavern.ctx.saveWorldInfo).toHaveBeenCalledWith(BOOK, expect.any(Object), true);
    expect(tavern.ctx.reloadWorldInfoEditor).toHaveBeenCalledWith(BOOK);
    expect(worldbookState.applied[0]).toMatchObject({ kind: 'create', uid: 1, before: null, title: '灯塔' });
    expect(worldbookState.batches[0].suggestions[0].status).toBe('applied');
  });

  it('追加到 uid 为 0 的条目：只改内容和关键词，其余字段（含自定义字段）不动；同步角色卡原始数据', async () => {
    const batch = await seed([suggestion({ kind: 'append', uid: 0, title: '雾港', content: '港口每月初一开市。', keys: ['港口', '港城'], base: entryBaseOf(0) })]);
    const before = JSON.parse(JSON.stringify(stored().entries['0']));
    await applySuggestions(batch.id, [batch.suggestions[0].id]);
    const entry = stored().entries['0'];
    expect(entry.content).toBe('潮汐环绕的港城。城北有一座旧钟塔。\n港口每月初一开市。');
    expect(entry.key).toEqual([' 雾港', '港城', '港口']);
    const { content: _c, key: _k, ...rest } = entry;
    const { content: _bc, key: _bk, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    const original = (stored().originalData as { entries: Array<Record<string, unknown>> }).entries[0];
    expect(original.content).toBe(entry.content);
    expect(original.keys).toEqual(entry.key);
  });

  it('替换：只换掉逐字一致的那一段，替换文字里的 $& 不被当成特殊写法', async () => {
    const batch = await seed([suggestion({ kind: 'replace', uid: 2, title: '钟塔守则', find: '看守只认怀表。', content: '看守只认钥匙（$&）。', base: entryBaseOf(2) })]);
    await applySuggestions(batch.id, [batch.suggestions[0].id]);
    expect(stored().entries['2'].content).toBe('入夜后钟塔不对外开放。看守只认钥匙（$&）。');
  });

  it('改写与只加关键词', async () => {
    const batch = await seed([
      suggestion({ kind: 'rewrite', uid: 2, title: '钟塔守则', content: '钟塔全天开放。', base: entryBaseOf(2) }),
      suggestion({ kind: 'keys', uid: 0, title: '雾港', keys: ['雾都'], base: entryBaseOf(0) }),
    ]);
    const out = await applySuggestions(batch.id, batch.suggestions.map(s => s.id));
    expect(out.applied).toHaveLength(2);
    expect(stored().entries['2'].content).toBe('钟塔全天开放。');
    expect(stored().entries['0'].key).toEqual([' 雾港', '港城', '雾都']);
    expect(tavern.ctx.saveWorldInfo).toHaveBeenCalledTimes(1);
  });

  it('应用时按当前权限再核对：生成后把权限调低，修改类建议不写入', async () => {
    const batch = await seed([
      suggestion({ kind: 'append', uid: 0, title: '雾港', content: '新的一句。', base: entryBaseOf(0) }),
      suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' }),
    ]);
    worldbookSettings.permission = 'create';
    const out = await applySuggestions(batch.id, batch.suggestions.map(s => s.id));
    expect(out.applied).toEqual([batch.suggestions[1].id]);
    expect(out.issues[0].reason).toContain('当前修改权限为「只新增」');
    expect(stored().entries['0'].content).not.toContain('新的一句');
  });

  it('冲突：条目在生成后被改过或被删除时不写入', async () => {
    const batch = await seed([
      suggestion({ kind: 'append', uid: 0, title: '雾港', content: '新的一句。', base: entryBaseOf(0) }),
      suggestion({ kind: 'replace', uid: 2, title: '钟塔守则', find: '看守只认怀表。', content: '改。', base: entryBaseOf(2) }),
    ]);
    const changed = stored();
    changed.entries['0'].content = '用户在编辑器里改过了。';
    delete changed.entries['2'];
    tavern.books.set(BOOK, changed);
    const out = await applySuggestions(batch.id, batch.suggestions.map(s => s.id));
    expect(out.applied).toEqual([]);
    expect(out.issues.map(i => i.conflict)).toEqual([true, true]);
    expect(out.issues[0].reason).toContain('已被修改');
    expect(out.issues[1].reason).toContain('已不在世界书中');
    expect(tavern.ctx.saveWorldInfo).not.toHaveBeenCalled();
  });

  it('同名条目已存在时新建视为冲突（防止重复写入）', async () => {
    const batch = await seed([suggestion({ kind: 'create', title: '雾港', keys: ['雾港'], content: '潮汐环绕的港城。城北有一座旧钟塔。' })]);
    const out = await applySuggestions(batch.id, [batch.suggestions[0].id]);
    expect(out.issues[0].reason).toContain('可能已经写入过');
    expect(suggestionConflict(batch.suggestions[0], stored())).toContain('uid 0');
  });

  it('依据的楼层被重抽后批次失效：默认不应用，说明可「仍然应用」或重新读取；核对后仍然应用可以写入', async () => {
    const batch = await seed([suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' })]);
    tavern.ctx.chat[1] = message('重抽后的另一段正文。');
    await expect(applySuggestions(batch.id, [batch.suggestions[0].id])).rejects.toThrow('仍然应用');
    expect(tavern.ctx.saveWorldInfo).not.toHaveBeenCalled();
    const out = await applySuggestions(batch.id, [batch.suggestions[0].id], { allowStale: true });
    expect(out.applied).toEqual([batch.suggestions[0].id]);
    expect(stored().entries['1']).toMatchObject({ comment: '码头', content: '码头说明。' });
  });

  it('目标世界书被删除或改名时说明原因和改法', async () => {
    const batch = await seed([suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' })], '不存在的书');
    await expect(applySuggestions(batch.id, [batch.suggestions[0].id])).rejects.toThrow(/不存在：可能已被删除或改名。请在本页「写入目标」中重新选择/);
  });

  it('保存后向服务器核对不一致时报错，不记为已应用', async () => {
    tavern.fetchStub.mockResolvedValueOnce({ ok: true, json: async () => books()[BOOK] });
    const batch = await seed([suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' })]);
    await expect(applySuggestions(batch.id, [batch.suggestions[0].id])).rejects.toThrow('核对未通过');
    expect(worldbookState.applied).toEqual([]);
    expect(worldbookState.batches[0].suggestions[0].status).toBe('pending');
  });

  it('改前改后预览与实际写入一致', () => {
    const s = suggestion({ kind: 'append', uid: 0, content: '新增。', keys: ['雾港', '新名'] });
    const view = previewChange(s, stored());
    expect(view.before).toBe('潮汐环绕的港城。城北有一座旧钟塔。');
    expect(view.after).toBe('潮汐环绕的港城。城北有一座旧钟塔。\n新增。');
    expect(view.keys).toEqual(['新名']);
  });
});

describe('撤销', () => {
  it('新建的条目：没被改过时删除', async () => {
    const batch = await seed([suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' })]);
    await applySuggestions(batch.id, [batch.suggestions[0].id]);
    const message = await undoApplied(worldbookState.applied[0].id);
    expect(message).toContain('删除了新建的条目');
    expect(stored().entries['1']).toBeUndefined();
    expect(worldbookState.applied[0].undoneAt).not.toBeNull();
    expect(worldbookState.batches[0].suggestions[0].status).toBe('undone');
  });

  it('修改过的条目：没被改过时恢复原样（内容和关键词按原写法）', async () => {
    const original = JSON.parse(JSON.stringify(stored().entries['0']));
    const batch = await seed([suggestion({ kind: 'append', uid: 0, title: '雾港', content: '新的一句。', keys: ['雾都'], base: entryBaseOf(0) })]);
    await applySuggestions(batch.id, [batch.suggestions[0].id]);
    await undoApplied(worldbookState.applied[0].id);
    expect(stored().entries['0']).toEqual(original);
    expect((stored().originalData as { entries: Array<Record<string, unknown>> }).entries[0].content).toBe(original.content);
  });

  it('写入后条目又被改过时不撤销，说明原因', async () => {
    const batch = await seed([
      suggestion({ kind: 'append', uid: 0, title: '雾港', content: '新的一句。', base: entryBaseOf(0) }),
      suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' }),
    ]);
    await applySuggestions(batch.id, batch.suggestions.map(s => s.id));
    const changed = stored();
    changed.entries['0'].content += '用户又补了一句。';
    changed.entries['1'].order = 999;
    tavern.books.set(BOOK, changed);
    const [appendRecord, createRecord] = worldbookState.applied;
    await expect(undoApplied(appendRecord.id)).rejects.toThrow('被修改过');
    await expect(undoApplied(createRecord.id)).rejects.toThrow('被修改过');
    expect(stored().entries['0'].content).toContain('用户又补了一句');
    expect(stored().entries['1']).toBeDefined();
  });

  it('同一条目有较新的写入时，要先撤销较新的那次', async () => {
    const first = await seed([suggestion({ kind: 'append', uid: 0, title: '雾港', content: '第一句。', base: entryBaseOf(0) })]);
    await applySuggestions(first.id, [first.suggestions[0].id]);
    const second = await seed([suggestion({ kind: 'append', uid: 0, title: '雾港', content: '第二句。', base: entryBaseOf(0) })]);
    await applySuggestions(second.id, [second.suggestions[0].id]);
    const older = worldbookState.applied.find(r => r.batchId === first.id)!;
    await expect(undoApplied(older.id)).rejects.toThrow('先撤销较新的那次');
  });

  it('新建的条目已被手动删除时，记录标为已撤销', async () => {
    const batch = await seed([suggestion({ kind: 'create', title: '码头', keys: ['码头'], content: '码头说明。' })]);
    await applySuggestions(batch.id, [batch.suggestions[0].id]);
    const changed = stored(); delete changed.entries['1']; tavern.books.set(BOOK, changed);
    expect(await undoApplied(worldbookState.applied[0].id)).toContain('已不在世界书中');
    expect(worldbookState.applied[0].undoneAt).not.toBeNull();
  });
});
