import { watch, type WatchStopHandle } from 'vue';
import { recallDebug } from '@/memory/vector/debug';
import { recallButtonLabel } from '@/memory/vector/recallView';
import { ensureButtonHolder, removeOwnBarIfEmpty } from '@/quickReply';
import { ui } from '@/state/ui';

/**
 * 快捷回复栏的「召回」按钮:写着上次召回了几段,点一下弹出召回速览(RecallPeek),不用打开宝书。
 *
 * 外观和挂法与「棱镜宝书」按钮相同(见 quickReply.ts):借 quick-reply 扩展的 .qr--button 类,
 * 挂在 #qr--bar > .qr--buttons 里;ST 重建 #qr--bar 时由 MutationObserver 补回。
 * 只在开了向量记忆、且设置里没关掉时出现(由 index.ts 按两个开关同步)。
 */
const BTN_ID = 'bbs-qr-recall';
let pollTimer: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;
let stopLabelWatch: WatchStopHandle | null = null;

function applyLabel(btn: HTMLElement): void {
  const { text, title } = recallButtonLabel(recallDebug);
  btn.textContent = text;
  btn.title = title;
  btn.setAttribute('aria-expanded', String(ui.recallPeekOpen));
}

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'qr--button menu_button interactable';
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-haspopup', 'dialog');
  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    ui.recallPeekOpen = !ui.recallPeekOpen;
  };
  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') toggle(e);
  });
  applyLabel(btn);
  return btn;
}

/** 真正执行插入:成功或已存在返回 true,聊天框未就绪返回 false(由轮询重试)。 */
function tryInject(): boolean {
  const sendForm = document.getElementById('send_form');
  if (!sendForm) return false;
  if (document.getElementById(BTN_ID)) return true;
  ensureButtonHolder(sendForm).appendChild(buildButton());
  return true;
}

function startObserver(): void {
  if (observer) return;
  const sendForm = document.getElementById('send_form');
  if (!sendForm) return;
  observer = new MutationObserver(() => {
    if (!document.getElementById(BTN_ID)) tryInject();
  });
  observer.observe(sendForm, { childList: true, subtree: true });
}

/** 弹层定位用:按钮在页面上的位置;按钮不在页面上时返回 null。 */
export function recallButtonRect(): DOMRect | null {
  return document.getElementById(BTN_ID)?.getBoundingClientRect() ?? null;
}

/** 按开关同步「召回」按钮的有无(幂等)。 */
export function syncRecallQuickReply(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    observer?.disconnect();
    observer = null;
    stopLabelWatch?.();
    stopLabelWatch = null;
    ui.recallPeekOpen = false;
    document.getElementById(BTN_ID)?.remove();
    removeOwnBarIfEmpty();
    return;
  }
  // 召回状态或弹层开关变了就更新按钮上的字(只在字面真的变了时动 DOM)
  stopLabelWatch ??= watch(
    () => {
      const { text, title } = recallButtonLabel(recallDebug);
      return `${text}\n${title}\n${ui.recallPeekOpen}`;
    },
    () => {
      const btn = document.getElementById(BTN_ID);
      if (btn) applyLabel(btn);
    },
  );
  if (tryInject()) {
    startObserver();
    return;
  }
  // 聊天框懒加载:轮询等它出现,封顶 ~20s(40 次)后放弃,不常驻空转。
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (document.getElementById(BTN_ID)) startObserver();
    }
  }, 500);
}
