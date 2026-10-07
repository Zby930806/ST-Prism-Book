import { openBook } from '@/state/ui';

const BTN_ID = 'bbs-qr-button';
const BAR_CLASS = 'bbs-qr-bar'; // 仅当 #qr--bar 不存在时,我们自建的条加这个标记类,便于回收

/**
 * 往聊天框上方注入一个「棱镜宝书」按钮,外观与 ST 原生快速回复按钮**完全一致**。
 *
 * 做法照搬相邻插件 JS-Slash-Runner 的范式(src/panel/script/use_button_destination_element.ts
 * 与 Script.vue):按钮就是一个 `<div class="qr--button menu_button interactable">文字</div>`,
 * 决定外观的是 quick-reply 扩展定义的 `.qr--button` 类——挂上它即与原生按钮同款,无需图标、
 * 不写自己的样式(自己画/只蹭 menu_button 都会四不像,实测过)。
 *
 * 挂载结构对齐原生:#qr--bar(已存在则复用,否则自建一个 .flex-container.flexGap5 条)
 *   └ .qr--buttons(容器)
 *       └ .qr--button(我们的按钮)
 *
 * 受设置开关控制:开 → 确保已注入;关 → 移除。轮询等聊天框出现(SPA 懒加载)。
 *
 * 注意:.qr--button 的样式全靠祖先选择器 `#qr--bar > .qr--buttons .qr--button` 生效,
 * 按钮**必须**落在该结构内才有原生外观。而 ST 的快速回复会在切聊天/改设置时重建 #qr--bar,
 * 把我们的按钮一并冲掉——故用 MutationObserver 盯住 #send_form,被冲掉就补回(同 JS-Slash-Runner)。
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;

/** 取(或建)#qr--bar:优先复用 ST 原生那条,没有才自建一条同款。返回挂按钮用的 .qr--buttons 容器。 */
function ensureButtonHolder(sendForm: HTMLElement): HTMLElement {
  // id 唯一约束,用属性筛选而非 #qr--bar 选择器(同 JS-Slash-Runner 的做法)
  let bar = Array.from(sendForm.querySelectorAll('div')).find(d => d.id === 'qr--bar') as HTMLElement | undefined;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'qr--bar';
    bar.className = `${BAR_CLASS} flex-container flexGap5`;
    sendForm.prepend(bar);
  }
  // 复用条内已有的 .qr--buttons,没有就建一个(原生未组合模式时可能没有)
  let holder = bar.querySelector('.qr--buttons') as HTMLElement | null;
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'qr--buttons';
    bar.appendChild(holder);
  }
  return holder;
}

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'qr--button menu_button interactable';
  btn.setAttribute('tabindex', '0');
  btn.title = '打开棱镜宝书';
  btn.textContent = '棱镜宝书';
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openBook();
  });
  btn.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      openBook();
    }
  });
  return btn;
}

/** 真正执行插入:成功或已存在返回 true,聊天框未就绪返回 false(由轮询重试)。 */
function tryInject(): boolean {
  const sendForm = document.getElementById('send_form');
  if (!sendForm) return false;
  if (document.getElementById(BTN_ID)) return true;

  const holder = ensureButtonHolder(sendForm);
  holder.appendChild(buildButton());
  return true;
}

function removeButton(): void {
  document.getElementById(BTN_ID)?.remove();
  // 若是我们自建的空 #qr--bar(原生没有 QR),按钮撤了就一并回收,别留空条
  const bar = document.querySelector(`#qr--bar.${BAR_CLASS}`) as HTMLElement | null;
  if (bar && bar.querySelector('.qr--buttons')?.children.length === 0) bar.remove();
}

/** 盯住 #send_form:ST 重建 #qr--bar 把我们的按钮冲掉时,补回(幂等,tryInject 自带存在检查)。 */
function startObserver(): void {
  if (observer) return;
  const sendForm = document.getElementById('send_form');
  if (!sendForm) return;
  observer = new MutationObserver(() => {
    if (!document.getElementById(BTN_ID)) tryInject();
  });
  observer.observe(sendForm, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
}

/** 按开关同步快速回复按钮的有无。开关变化时调用即可(幂等)。 */
export function syncQuickReplyButton(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    stopObserver();
    removeButton();
    return;
  }
  if (tryInject()) {
    startObserver();
    return;
  }
  // 聊天框懒加载:轮询等它出现,封顶 ~20s(40 次)后放弃,绝不常驻空转。
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (document.getElementById(BTN_ID)) startObserver();
    }
  }, 500);
}
