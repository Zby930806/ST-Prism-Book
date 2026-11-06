/**
 * 字体图标兜底:有些酒馆美化主题会把顶栏/聊天框里 .drawer-icon.fa-solid::before(或类似)
 * 的字体图标清空(content:''、color:transparent、font-size:0),改用 background-image 按
 * **每个按钮 id** 单独贴自定义图标。我们注入的按钮不在它们名单里,会变成一片空白。
 *
 * 这里用更高特异性(祖先 id + 自身 id)+ !important 压过那条通用规则,强制还原字形。
 * \e0bb = fa-book-bookmark 的 Unicode(取自 ST 的 fontawesome.min.css,别凭记忆猜)。
 *
 * 各注入点共用此函数:传入自身按钮 id 与图标元素的选择器,生成一段一次性 <style>。
 */
const BOOK_BOOKMARK = '\\e0bb';
const injected = new Set<string>();

/**
 * 确保某按钮的图标兜底样式已注入(按 styleId 去重,可重复调用)。
 * @param styleId   <style> 元素的 id(去重键)
 * @param selector  命中该按钮图标 ::before 的高特异性选择器(不含 ::before)
 */
export function ensureIconFallback(styleId: string, selector: string): void {
  if (injected.has(styleId) || document.getElementById(styleId)) {
    injected.add(styleId);
    return;
  }
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
${selector}::before {
  content: '${BOOK_BOOKMARK}' !important;
  width: auto !important;
  height: auto !important;
  font-size: inherit !important;
  color: inherit !important;
  background: none !important;
}
`;
  document.head.appendChild(style);
  injected.add(styleId);
}
