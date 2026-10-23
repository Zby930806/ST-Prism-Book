import { describe, expect, it } from 'vitest';
import { beyondSlop, clickSlop } from './orbGesture';

describe('悬浮球的点按与拖动', () => {
  it('触屏点按允许约 10px 的抖动，鼠标 6px，按直线距离计算', () => {
    expect(clickSlop('touch')).toBe(10);
    expect(clickSlop('mouse')).toBe(6);
    expect(clickSlop('pen')).toBe(6);
    // 原来按 |dx|+|dy| 计算，(5, 4) 就算拖动；现在触屏仍算点按
    expect(beyondSlop(5, 4, 'touch')).toBe(false);
    expect(beyondSlop(8, 7, 'touch')).toBe(true);
    expect(beyondSlop(4, 4, 'mouse')).toBe(false);
    expect(beyondSlop(6, 0, 'mouse')).toBe(true);
  });
});
