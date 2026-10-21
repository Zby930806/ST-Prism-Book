import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as host from '@/st/context';
import { makeTavern } from './testEnv';
import {
  WORLDBOOK_DATA_KEY, commitBatch, loadWorldbookData, recordApplied, saveSuggestionEdit, setCursor, setSuggestionStatus, setTarget,
  validWorldbookData, worldbookState, worldbookWriteIssue,
} from './store';
import type { AppliedRecord, Suggestion, SuggestionBatch } from './types';

// 存储：严格校验、只读保护、只替换自己的键、保存失败恢复、切换聊天不串数据。全部本地数据。
vi.mock('@/memory/engine', () => ({ isAiFloor: (m: { is_user?: boolean }) => !!m && !m.is_user }));

let tavern: ReturnType<typeof makeTavern>;
const suggestion = (id = 's1', over: Partial<Suggestion> = {}): Suggestion => ({
  id, kind: 'create', uid: null, title: '灯塔', keys: ['灯塔'], content: '港口外的灯塔。', find: '', reason: '', floors: [1],
  base: '', status: 'pending', edited: false, warnings: [], ...over,
});
const batch = (id = 'b1', suggestions = [suggestion()]): SuggestionBatch => ({
  id, createdAt: 1, auto: false, book: '雾港设定', permission: 'create', source: { from: 0, to: 1, hash: 'h' }, suggestions, dropped: [],
});
const record = (over: Partial<AppliedRecord> = {}): AppliedRecord => ({
  id: 'r1', at: 2, book: '雾港设定', batchId: 'b1', suggestionId: 's1', kind: 'create', uid: 0, title: '灯塔', before: null,
  after: { comment: '灯塔', content: '港口外的灯塔。', key: ['灯塔'] }, signature: 'sig', source: { from: 0, to: 1, hash: 'h' }, undoneAt: null, ...over,
});

beforeEach(() => {
  tavern = makeTavern();
  vi.spyOn(host, 'getContext').mockImplementation(() => tavern.ctx);
  loadWorldbookData();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('世界书建议的存储', () => {
  it('保存后只替换自己的键，别的元数据不动；重新载入后一致', async () => {
    tavern.ctx.chatMetadata.unrelated = { keep: true };
    await commitBatch(batch(), { floor: 1, hash: 'c' });
    await setTarget('雾港设定');
    const stored = tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY];
    expect(validWorldbookData(stored)).toBe(true);
    expect(tavern.ctx.chatMetadata.unrelated).toEqual({ keep: true });
    loadWorldbookData();
    expect(worldbookState.target).toBe('雾港设定');
    expect(worldbookState.cursor).toEqual({ floor: 1, hash: 'c' });
    expect(worldbookState.batches[0].suggestions[0].title).toBe('灯塔');
  });

  it.each([
    ['版本不认识', { version: 2, target: null, cursor: null, batches: [], applied: [] }],
    ['多出字段', { version: 1, target: null, cursor: null, batches: [], applied: [], extra: 1 }],
    ['建议缺字段', { version: 1, target: null, cursor: null, batches: [{ ...batch(), suggestions: [{ id: 'x' }] }], applied: [] }],
    ['uid 不是整数', { version: 1, target: null, cursor: null, batches: [batch('b', [suggestion('s', { kind: 'append', uid: 1.5 as unknown as number })])], applied: [] }],
  ])('认不出的格式（%s）只读保护，不覆盖原数据', async (_name, raw) => {
    tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY] = raw;
    loadWorldbookData();
    expect(worldbookState.issue).toContain('只读保护');
    expect(worldbookWriteIssue()).toContain('只读保护');
    await expect(setTarget('别的书')).rejects.toThrow('只读保护');
    expect(tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY]).toEqual(raw);
    expect(tavern.ctx.saveMetadata).not.toHaveBeenCalled();
  });

  it('uid 为 0 与「从第 0 楼开始」的读取进度都是有效数据', async () => {
    await commitBatch(batch('b', [suggestion('s', { kind: 'append', uid: 0, base: 'x' })]), null);
    await setCursor({ floor: -1, hash: 'start' });
    loadWorldbookData();
    expect(worldbookState.issue).toBe('');
    expect(worldbookState.batches[0].suggestions[0].uid).toBe(0);
    expect(worldbookState.cursor).toEqual({ floor: -1, hash: 'start' });
  });

  it('保存失败时恢复原值并报错', async () => {
    await setTarget('甲');
    vi.mocked(tavern.ctx.saveMetadata).mockRejectedValueOnce(new Error('网络错误'));
    await expect(setTarget('乙')).rejects.toThrow('保存失败');
    expect((tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY] as { target: string }).target).toBe('甲');
    expect(worldbookState.target).toBe('甲');
  });

  it('世界书已写入后的记录保存失败不回滚，留在聊天元数据里并提示', async () => {
    await commitBatch(batch(), null);
    vi.mocked(tavern.ctx.saveMetadata).mockRejectedValueOnce(new Error('网络错误'));
    await recordApplied('b1', [record()]);
    expect(worldbookState.saveWarning).toContain('写入记录没有保存');
    expect(worldbookState.applied).toHaveLength(1);
    expect(worldbookState.batches[0].suggestions[0].status).toBe('applied');
    expect((tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY] as { applied: unknown[] }).applied).toHaveLength(1);
  });

  it('并发修改排队执行，互不覆盖', async () => {
    await commitBatch(batch('b1', [suggestion('s1'), suggestion('s2', { title: '码头', keys: ['码头'] })]), null);
    await Promise.all([setSuggestionStatus('b1', ['s1'], 'ignored'), setSuggestionStatus('b1', ['s2'], 'ignored'), setTarget('乙')]);
    expect(worldbookState.batches[0].suggestions.map(s => s.status)).toEqual(['ignored', 'ignored']);
    expect(worldbookState.target).toBe('乙');
  });

  it('编辑只允许待处理的建议，并标记为已编辑', async () => {
    await commitBatch(batch(), null);
    await saveSuggestionEdit('b1', 's1', { title: '新灯塔', keys: ['新灯塔'], content: '改过的内容。', find: '' });
    expect(worldbookState.batches[0].suggestions[0]).toMatchObject({ title: '新灯塔', edited: true });
    await setSuggestionStatus('b1', ['s1'], 'ignored');
    await expect(saveSuggestionEdit('b1', 's1', { title: 'x', keys: ['xx'], content: 'y', find: '' })).rejects.toThrow('已经处理过');
  });

  it('超出上限时先删已处理的批次，保留有待处理建议的批次', async () => {
    for (let i = 0; i < 20; i++) await commitBatch(batch('b' + i, [suggestion('s' + i, { status: i === 0 ? 'pending' : 'ignored' })]), null);
    await commitBatch(batch('new', [suggestion('sn')]), null);
    const ids = worldbookState.batches.map(b => b.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain('b0');
    expect(ids).not.toContain('b1');
    expect(ids).toContain('new');
  });

  it('切换聊天后重新载入，不把旧聊天的数据写进新聊天', async () => {
    await setTarget('甲');
    tavern.switchChat('chat-b');
    expect(worldbookWriteIssue()).toBe('');
    expect(worldbookState.target).toBeNull();
    await setTarget('乙');
    expect((tavern.ctx.chatMetadata[WORLDBOOK_DATA_KEY] as { target: string }).target).toBe('乙');
  });
});
