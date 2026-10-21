import { afterEach, describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';
import { setBackStackForTest, type BackStack } from '@/state/backStack';
import { useBackLayer } from './useBackLayer';

function fakeStack() {
  const closers: Array<() => void> = [];
  let released = 0;
  const stack: BackStack = {
    open: close => { closers.push(close); return () => { released++; }; },
    freeze: () => {},
    depth: 0,
    entries: 0,
  };
  return { stack, closers, get released() { return released; } };
}

afterEach(() => setBackStackForTest(null));

describe('useBackLayer', () => {
  it('打开时登记，按返回键关闭后立即注销，组件卸载时也注销', () => {
    const fake = fakeStack();
    setBackStackForTest(fake.stack);
    const open = ref(false);
    const scope = effectScope();
    scope.run(() => useBackLayer(() => open.value, () => { open.value = false; }));
    expect(fake.closers).toHaveLength(0);

    open.value = true;
    expect(fake.closers).toHaveLength(1);
    fake.closers[0](); // 返回键调用 close
    expect(open.value).toBe(false);
    expect(fake.released).toBe(1);

    open.value = true;
    expect(fake.closers).toHaveLength(2);
    scope.stop(); // 卸载
    expect(fake.released).toBe(2);
  });

  it('一开始就是打开状态时立即登记；close 拒绝关闭时保持登记', () => {
    const fake = fakeStack();
    setBackStackForTest(fake.stack);
    const open = ref(true);
    const scope = effectScope();
    scope.run(() => useBackLayer(() => open.value, () => { /* 处理中，不关闭 */ }));
    expect(fake.closers).toHaveLength(1);
    fake.closers[0]();
    expect(fake.released).toBe(0);
    scope.stop();
    expect(fake.released).toBe(1);
  });
});
