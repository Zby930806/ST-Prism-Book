/**
 * 复制文本到剪贴板。酒馆常经局域网 http 访问，非安全上下文里没有 navigator.clipboard，
 * 这时退回到页面临时文本框 + execCommand('copy')；文本框放在 document.body（Shadow DOM 里的选区不可靠），
 * 复制后移除，并把焦点还给原来的元素。返回是否成功，调用方自行提示。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒等情况退回下面的写法 */
  }
  let active = document.activeElement as HTMLElement | null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as HTMLElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus?.({ preventScroll: true });
  }
}
