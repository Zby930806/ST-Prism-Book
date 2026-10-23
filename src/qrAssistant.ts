/**
 * 兼容「QR助手」(uhhhh15/QR):它把快捷回复栏的按钮收进发送键旁的菜单,未登记的按钮会随所在的栏一起被隐藏,
 * 「召回」「棱镜宝书」两个按钮因此看不到、也点不到。
 *
 * 按 QR助手公开的登记方式写入 window.qrAssistantExtensionApi(它每次重建菜单都会重读这个数组):
 * 菜单里出现「棱镜宝书」一组,点菜单项等于点原按钮;用户也可以在 QR助手的白名单里把它们留在输入框上方。
 * 没装 QR助手时只多出这个全局数组,不影响别的。
 */
export interface QrAssistantEntry {
  dom_id: string;
  group_name?: string;
  button_name?: string;
}

declare global {
  interface Window {
    qrAssistantExtensionApi?: QrAssistantEntry[];
  }
}

const GROUP = '棱镜宝书';

/** 登记或更新一个按钮(按 dom_id 去重,文字变了就改写)。 */
export function registerQrAssistantButton(domId: string, buttonName: string): void {
  if (typeof window === 'undefined') return;
  window.qrAssistantExtensionApi ??= [];
  const list = window.qrAssistantExtensionApi;
  if (!Array.isArray(list)) return;
  const entry = list.find(e => e?.dom_id === domId);
  if (entry) {
    entry.group_name = GROUP;
    entry.button_name = buttonName;
  } else {
    list.push({ dom_id: domId, group_name: GROUP, button_name: buttonName });
  }
}

/** 按钮撤下时一并取消登记,菜单里不留点了没反应的项。 */
export function unregisterQrAssistantButton(domId: string): void {
  if (typeof window === 'undefined') return;
  const list = window.qrAssistantExtensionApi;
  if (!Array.isArray(list)) return;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.dom_id === domId) list.splice(i, 1);
}
