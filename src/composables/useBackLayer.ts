import { onScopeDispose, watch } from 'vue';
import { backStack } from '@/state/backStack';

/**
 * 把一个可关闭的界面（窗口、弹窗、确认框、菜单、下拉列表）登记为返回键的一层：
 * 打开时登记，关闭或组件卸载时注销。按返回键时只调用最上面一层的 close。
 * close 可以拒绝关闭（例如确认框正在处理时）；这时这一层保持登记，返回键继续拦截。
 * 规则与历史记录的处理见 state/backStack.ts。
 */
export function useBackLayer(isOpen: () => boolean, close: () => void): void {
  let release: (() => void) | null = null;
  const stop = watch(
    isOpen,
    open => {
      if (open && !release) release = backStack().open(() => close());
      else if (!open && release) {
        release();
        release = null;
      }
    },
    // 同步执行：关闭（包括按返回键触发的关闭）一生效就注销，重新压守卫时层数已经准确。
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    stop();
    release?.();
    release = null;
  });
}
