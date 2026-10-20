/**
 * 挂在酒馆聊天区里的 shadow 宿主(楼层面板、札记卡片)共用的样式表。
 * 一次 fetch dist/index.css 构造 CSSStyleSheet,各 shadow root 采用同一份(一次解析、多处采用);
 * 构造失败或还没就绪时退回 <link>。
 */
import { versionedAssetUrl } from '@/version';

/** 共用样式的宿主都带这个类名,样式表就绪后据此给已挂载的宿主补采用。 */
export const SHADOW_HOST_CLASS = 'bbs-shadow-host';

let sharedSheet: CSSStyleSheet | null = null;
let loading: Promise<void> | null = null;
let cssHref = '';

function resolveCssHref(): string {
  if (cssHref) return cssHref;
  try {
    cssHref = versionedAssetUrl('./index.css', import.meta.url);
  } catch {
    cssHref = '';
  }
  return cssHref;
}

/** 异步构造共享样式表(只构造一次)。失败静默,挂载时退回 <link>。 */
export function ensureSharedSheet(): Promise<void> {
  if (sharedSheet || typeof CSSStyleSheet === 'undefined') return Promise.resolve();
  if (loading) return loading;
  const href = resolveCssHref();
  if (!href) return Promise.resolve();
  loading = (async () => {
    try {
      const res = await fetch(href);
      const text = await res.text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      sharedSheet = sheet;
      // 已挂载的补采用(首屏可能先于样式表就绪挂载)
      for (const host of document.querySelectorAll(`.${SHADOW_HOST_CLASS}`)) {
        const root = (host as HTMLElement).shadowRoot;
        if (root && !root.adoptedStyleSheets.includes(sheet)) {
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        }
      }
    } catch {
      /* 退回 <link>,见 attachSharedStyles */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 给 shadow root 挂上共享样式:样式表已就绪就采用,否则插一个 <link>。 */
export function attachSharedStyles(root: ShadowRoot): void {
  if (sharedSheet) {
    if (!root.adoptedStyleSheets.includes(sharedSheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedSheet];
    }
    return;
  }
  const href = resolveCssHref();
  if (href && !root.querySelector('link[data-bbs-shared-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-bbs-shared-css', '');
    root.appendChild(link);
  }
}
