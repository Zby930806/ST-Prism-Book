/**
 * 悬浮球的点按与拖动判定（FloatingOrb.vue 使用）。
 * 按下后位移不超过容差算点按：打开宝书，悬浮球不挪动、贴边状态不变；超过容差才开始拖动。
 */

/** 鼠标和触控笔的点按容差（px）。 */
export const MOUSE_SLOP = 6;
/** 触屏的点按容差（px）：手指点按时常有 5–10px 的抖动。 */
export const TOUCH_SLOP = 10;

export function clickSlop(pointerType: string): number {
  return pointerType === 'touch' ? TOUCH_SLOP : MOUSE_SLOP;
}

/** 从按下处移动 (dx, dy) 后是否算拖动（按直线距离计算）。 */
export function beyondSlop(dx: number, dy: number, pointerType: string): boolean {
  return Math.hypot(dx, dy) >= clickSlop(pointerType);
}
