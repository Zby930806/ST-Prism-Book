import { describe, expect, it } from 'vitest';
import { appendText, diffSentences, findEntry, keyMatches, occurrences, splitSentences } from './entries';
import { changeParts, trimContext } from './view';
import type { Suggestion } from './types';

// 条目工具与改前改后对比（纯函数）。
const s = (over: Partial<Suggestion>): Suggestion => ({ id: 'x', kind: 'append', uid: 0, title: '', keys: [], content: '', find: '', reason: '', floors: [], base: '', status: 'pending', edited: false, warnings: [], ...over });

describe('条目工具', () => {
  it('按 uid 找条目，uid 为 0 也能找到；键与 uid 不一致时按 uid 字段找', () => {
    const data = { entries: { 0: { uid: 0, content: 'a' }, 9: { uid: 3, content: 'b' } } };
    expect(findEntry(data, 0)?.entry.content).toBe('a');
    expect(findEntry(data, 3)).toEqual({ key: '9', entry: data.entries[9] });
    expect(findEntry(data, -1)).toBeNull();
  });

  it('关键词匹配：普通关键词不区分大小写，正则关键词按 /…/ 写法', () => {
    expect(keyMatches('Clock Tower', 'the clock tower at night')).toBe(true);
    expect(keyMatches('/档案[室馆]/', '进了档案室')).toBe(true);
    expect(keyMatches('/[/', '任意文本 /[/')).toBe(true);
    expect(keyMatches('  ', '任意')).toBe(false);
  });

  it('出现次数、追加换行', () => {
    expect(occurrences('甲乙甲', '甲')).toBe(2);
    expect(occurrences('甲乙甲', '')).toBe(0);
    expect(appendText('原文。\n\n', ' 新增。')).toBe('原文。\n新增。');
    expect(appendText('', '新增。')).toBe('新增。');
  });

  it('按句切分保留原文；句子级对比标出删除和新增', () => {
    expect(splitSentences('第一句。第二句！“第三句。”第四').join('')).toBe('第一句。第二句！“第三句。”第四');
    const diff = diffSentences('甲。乙。丙。', '甲。丁。丙。');
    expect(diff.before).toEqual([{ text: '甲。', type: 'same' }, { text: '乙。', type: 'removed' }, { text: '丙。', type: 'same' }]);
    expect(diff.after).toEqual([{ text: '甲。', type: 'same' }, { text: '丁。', type: 'added' }, { text: '丙。', type: 'same' }]);
  });
});

describe('改前改后对比', () => {
  it('追加：改后在原文之后标出新增', () => {
    const parts = changeParts(s({ kind: 'append', content: '新增。' }), '原文。');
    expect(parts.before).toEqual([{ text: '原文。', type: 'same' }]);
    expect(parts.after).toEqual([{ text: '原文。\n', type: 'same' }, { text: '新增。', type: 'added' }]);
  });

  it('替换：按字标出被替换的一段；替换为空时改后不显示新增', () => {
    const parts = changeParts(s({ kind: 'replace', find: '乙', content: '丁' }), '甲乙丙');
    expect(parts.before.map(p => p.type)).toEqual(['same', 'removed', 'same']);
    expect(parts.after).toEqual([{ text: '甲', type: 'same' }, { text: '丁', type: 'added' }, { text: '丙', type: 'same' }]);
    expect(changeParts(s({ kind: 'replace', find: '乙', content: '' }), '甲乙丙').after).toEqual([{ text: '甲', type: 'same' }, { text: '丙', type: 'same' }]);
  });

  it('长段落只保留改动附近的文字', () => {
    const parts = trimContext([{ text: '前'.repeat(500), type: 'same' }, { text: '改', type: 'added' }, { text: '后'.repeat(500), type: 'same' }], 20);
    expect(parts[0].text).toBe('…' + '前'.repeat(20));
    expect(parts[2].text).toBe('后'.repeat(20) + '…');
  });
});
