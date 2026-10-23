import { describe, expect, it } from 'vitest';
import { renameObjectKey } from './jsonTree';

describe('变量模板字段改名', () => {
  const obj = { 势力: { 王国: 1 }, 好感: 3, 备注: '' };

  it('改成新名字时保持原来的顺序', () => {
    const result = renameObjectKey(obj, '好感', ' 好感度 ');
    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.value)).toEqual(['势力', '好感度', '备注']);
    expect(result.ok && result.value.势力).toEqual({ 王国: 1 });
  });

  it('与已有字段重名时不改，两个字段的值都保留', () => {
    expect(renameObjectKey(obj, '好感', '势力')).toEqual({ ok: false, reason: 'duplicate', key: '势力' });
    expect(obj).toEqual({ 势力: { 王国: 1 }, 好感: 3, 备注: '' });
  });

  it('新名字为空、与旧名相同或是 __proto__ 时不改', () => {
    expect(renameObjectKey(obj, '好感', '  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(renameObjectKey(obj, '好感', '好感')).toMatchObject({ ok: false, reason: 'same' });
    expect(renameObjectKey(obj, '好感', '__proto__')).toMatchObject({ ok: false, reason: 'forbidden' });
  });
});
