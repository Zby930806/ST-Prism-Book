import { describe, expect, it } from 'vitest';
import { diffHunks, diffLines, diffStats } from './promptDiff';
import { SUMMARY_PROMPT } from '@/memory/prompts';

describe('提示词按行对比', () => {
  it('分出删掉、加上和不变的行', () => {
    const rows = diffLines('甲\n乙\n丙', '甲\n乙改\n丙\n丁');
    expect(rows).toEqual([
      { type: 'same', text: '甲' },
      { type: 'del', text: '乙' },
      { type: 'add', text: '乙改' },
      { type: 'same', text: '丙' },
      { type: 'add', text: '丁' },
    ]);
    expect(diffStats(rows)).toEqual({ added: 2, removed: 1 });
  });

  it('换行风格不同不算改动；完全相同时没有差异段', () => {
    expect(diffHunks(diffLines('甲\r\n乙', '甲\n乙'))).toEqual([]);
  });

  it('只留改动和上下文，长段相同的行折叠', () => {
    const before = Array.from({ length: 20 }, (_, i) => `第${i}行`).join('\n');
    const after = before.replace('第10行', '第10行改');
    const rows = diffHunks(diffLines(before, after), 1);
    expect(rows[0]).toEqual({ type: 'skip', count: 9 });
    expect(rows.slice(1, 5).map(r => ('text' in r ? `${r.type}:${r.text}` : 'skip'))).toEqual(['same:第9行', 'del:第10行', 'add:第10行改', 'same:第11行']);
    expect(rows.at(-1)).toEqual({ type: 'skip', count: 8 });
  });

  it('整份内置摘要提示词改一行也能很快比出来', () => {
    const changed = SUMMARY_PROMPT.replace('篇幅是上限而非填满任务', '篇幅是上限而非填满任务（测试改动）');
    const started = Date.now();
    const rows = diffLines(SUMMARY_PROMPT, changed);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });
});
