import { afterEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import {
  describeWiPatternPreview, loadBoundEntryNames, wiPatternHasSpecialChars, wiPatternIsRegex, wiPatternMatches, type BoundEntryNames,
} from './wiPatternPreview';

afterEach(() => { vi.restoreAllMocks(); });

const loaded: BoundEntryNames = {
  books: ['设定集', '人物志'],
  entries: [
    { book: '设定集', comment: '[NPC] 酒馆老板' },
    { book: '设定集', comment: '城镇概况' },
    { book: '设定集', comment: '附加设定' },
    { book: '人物志', comment: 'Captain 船长' },
    { book: '人物志', comment: 'Pirates 海盗' },
    { book: '人物志', comment: 'Nora 修女' },
    { book: '人物志', comment: 'npc 名单' },
    { book: '人物志', comment: 'Cecil 神父' },
  ],
  failed: [],
};

describe('条目名规则的匹配（与摘要时相同）', () => {
  it('按正则解析、不区分大小写；写法有误时按字面包含匹配', () => {
    // 照条目名填 [NPC] 会被当成字符类，匹配任何含 n、p、c 的名字
    expect(wiPatternMatches('[NPC]', 'npc 名单')).toBe(true);
    expect(wiPatternMatches('[NPC]', 'Captain')).toBe(true);
    expect(wiPatternMatches('\\[NPC\\]', '[NPC] 酒馆老板')).toBe(true);
    expect(wiPatternMatches('\\[NPC\\]', 'npc 名单')).toBe(false);
    expect(wiPatternIsRegex('(临时')).toBe(false);
    expect(wiPatternMatches('(临时', '(临时)补充')).toBe(true);
    expect(wiPatternHasSpecialChars('附加')).toBe(false);
    expect(wiPatternHasSpecialChars('^规则')).toBe(true);
  });
});

describe('添加规则前的命中预览', () => {
  it('列出命中的条目数和前几条；命中较多时提醒，并说明方括号等符号的正则含义', () => {
    const wide = describeWiPatternPreview('[NPC]', loaded, []);
    expect(wide.warn).toBe(true);
    expect(wide.text).toContain('当前聊天使用的 2 本世界书中命中 6 / 8 个条目');
    expect(wide.text).toContain('命中较多，请确认没有把需要的条目一起排除');
    expect(wide.text).toContain('按原样匹配请在前面加 \\，如 \\[NPC\\]');
    const exact = describeWiPatternPreview('\\[NPC\\]', loaded, []);
    expect(exact).toMatchObject({ warn: false });
    expect(exact.text).toContain('命中 1 / 8 个条目：「[NPC] 酒馆老板」。');
    expect(describeWiPatternPreview('附加', loaded, []).text).toBe('当前聊天使用的 2 本世界书中命中 1 / 8 个条目：「附加设定」。');
  });

  it('整本排除的书不计入；没有使用世界书或读取失败时说明原因', () => {
    expect(describeWiPatternPreview('附加', loaded, ['设定集']).text).toBe('当前聊天使用的 1 本世界书中没有命中的条目。');
    expect(describeWiPatternPreview('附加', loaded, ['设定集', '人物志']).text).toBe('当前聊天使用的世界书都已整本排除。');
    expect(describeWiPatternPreview('附加', { books: [], entries: [], failed: [] }).text).toBe('当前聊天没有使用世界书，无法预览命中的条目。');
    expect(describeWiPatternPreview('附加', { books: ['坏书'], entries: [], failed: ['坏书'] }, []).text).toBe('世界书读取失败，无法预览命中的条目。');
    expect(describeWiPatternPreview('附加', { ...loaded, books: [...loaded.books, '坏书'], failed: ['坏书'] }, []).text).toContain('另有 1 本读取失败，没有计入。');
  });

  it('读取当前聊天和角色绑定的世界书里的条目名，不修改世界书', async () => {
    const books: Record<string, unknown> = {
      角色书: { entries: { 0: { uid: 0, comment: '角色设定' }, 1: { uid: 1, comment: '' } } },
      聊天书: { entries: { 0: { uid: 0, comment: '本章事件' } } },
    };
    const loadWorldInfo = vi.fn(async (name: string) => books[name] ?? null);
    vi.spyOn(context, 'getContext').mockReturnValue({
      chatMetadata: { world_info: '聊天书' },
      characterId: 0,
      characters: [{ name: '角色', avatar: 'role.png', data: { extensions: { world: '角色书' } } }],
      loadWorldInfo,
      saveWorldInfo: vi.fn(),
    } as unknown as STContext);
    const result = await loadBoundEntryNames();
    expect(result.books).toEqual(['角色书', '聊天书']);
    expect(result.entries).toEqual([{ book: '角色书', comment: '角色设定' }, { book: '聊天书', comment: '本章事件' }]);
    expect(result.failed).toEqual([]);
  });
});
