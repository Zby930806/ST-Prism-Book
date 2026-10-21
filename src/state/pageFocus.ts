import { reactive } from 'vue';
import { openBook } from './ui';

/**
 * 跨页定位：切到目标页后展开并滚动到指定区块（设置页「札记与规划 API」卡片的跳转按钮使用）。
 * 目标页面在挂载时和请求变化时用 takePageFocus 认领，认领后清空，同一请求只处理一次。
 */
export type PageFocusSection = 'notes-api' | 'outline-api' | 'worldbook-api';

export const pageFocus = reactive<{ section: PageFocusSection | '' }>({ section: '' });

export function openPageSection(page: string, section: PageFocusSection): void {
  pageFocus.section = section;
  openBook(page);
}

/** 请求的正是这个区块时清空请求并返回 true，由调用方展开、滚动和移交焦点。 */
export function takePageFocus(section: PageFocusSection): boolean {
  if (pageFocus.section !== section) return false;
  pageFocus.section = '';
  return true;
}
