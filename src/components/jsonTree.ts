/**
 * JSON 结构编辑器（JsonTreeEditor.vue）的纯函数部分。
 */
import type { JsonValue } from '@/memory/types';

/** 不能当字段名的写法：给普通对象赋值 __proto__ 会改动原型，字段连同值一起丢失。 */
const FORBIDDEN_KEYS = new Set(['__proto__']);

export type RenameKeyResult =
  | { ok: true; value: Record<string, JsonValue> }
  | { ok: false; reason: 'empty' | 'same' | 'duplicate' | 'forbidden'; key: string };

/**
 * 字段改名，保持原来的顺序。新名为空、与旧名相同、与其他字段重名或是 __proto__ 时不改
 * （重名时直接重建对象会让其中一个字段连同它的值被覆盖掉）。
 */
export function renameObjectKey(obj: Record<string, JsonValue>, oldKey: string, rawNewKey: string): RenameKeyResult {
  const key = rawNewKey.trim();
  if (!key) return { ok: false, reason: 'empty', key };
  if (key === oldKey) return { ok: false, reason: 'same', key };
  if (FORBIDDEN_KEYS.has(key)) return { ok: false, reason: 'forbidden', key };
  if (Object.prototype.hasOwnProperty.call(obj, key)) return { ok: false, reason: 'duplicate', key };
  // Object.fromEntries 按自有属性写入，已有的特殊键名也不会落到原型上
  return { ok: true, value: Object.fromEntries(Object.keys(obj).map(k => [k === oldKey ? key : k, obj[k]])) };
}
