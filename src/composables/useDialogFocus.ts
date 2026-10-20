import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue';

/** Shadow DOM 内的真正焦点（document.activeElement 通常只是宿主）。 */
function focusedElement(): HTMLElement | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/**
 * 只负责界面焦点，不改变确认/取消业务；Teleport 子弹窗有自己的独立作用域。
 * initialFocus：打开时先聚焦的元素（如 role=dialog 的弹窗本身），不给则聚焦 container；目标不可聚焦时补 tabindex=-1。
 */
export function useDialogFocus(container: Ref<HTMLElement | null>, isOpen: () => boolean, dismiss: () => void, initialFocus?: () => HTMLElement | null) {
  let previous: HTMLElement | null = null;
  let generation = 0;
  function restore() {
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  }
  const stop = watch(isOpen, async open => {
    const current = ++generation;
    if (!open) { restore(); return; }
    previous = focusedElement();
    await nextTick();
    if (current !== generation || !isOpen()) return;
    const host = container.value;
    if (!host) return;
    // 页面已把焦点放进弹窗里（如打开即聚焦名字框）时保留，不再移到弹窗本身。
    const active = focusedElement();
    if (active && active !== host && host.contains(active)) return;
    const target = initialFocus?.() ?? host;
    if (target !== host && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }, { immediate: true, flush: 'post' });
  function onDialogKeydown(event: KeyboardEvent) {
    const host = container.value;
    if (!host || !isOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); dismiss(); return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(host.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]'))
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
    const first = nodes[0]; const last = nodes[nodes.length - 1]; const active = focusedElement();
    const target = initialFocus?.() ?? host;
    if (!first) { event.preventDefault(); target.focus(); return; }
    // 焦点在容器、弹窗本身或已经跑到外面时：Tab 回到第一个，Shift+Tab 回到最后一个。
    const outside = !active || active === host || active === target || !host.contains(active);
    if (event.shiftKey && (active === first || outside)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || outside)) { event.preventDefault(); first.focus(); }
  }
  onBeforeUnmount(() => { ++generation; stop(); restore(); });
  return { onDialogKeydown };
}
