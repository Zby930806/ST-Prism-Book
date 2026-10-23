import { describe, expect, it } from 'vitest';
import { filterModelOptions } from './modelFilter';

describe('模型下拉的筛选', () => {
  const list = Array.from({ length: 250 }, (_, i) => `model-${String(i).padStart(3, '0')}${i % 50 === 0 ? '-embed' : ''}`);

  it('超过 200 个时只显示前 200 个，并给出没显示的条数', () => {
    const all = filterModelOptions(list, '');
    expect(all.shown).toHaveLength(200);
    expect(all.more).toBe(50);
  });

  it('输入关键词后按不区分大小写的子串筛选，结果不超过 200 个时不再提示', () => {
    expect(filterModelOptions(list, 'EMBED')).toEqual({ shown: ['model-000-embed', 'model-050-embed', 'model-100-embed', 'model-150-embed', 'model-200-embed'], more: 0 });
    expect(filterModelOptions(list, 'nothing')).toEqual({ shown: [], more: 0 });
  });
});
