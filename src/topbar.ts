import { openBook } from '@/state/ui';
import { ensureIconFallback } from '@/st/iconFallback';

const BTN_ID = 'bbs-topbar-button';
const STYLE_ID = 'bbs-topbar-style';

function ensureStyle(): void {
  // 美化主题可能清空顶栏图标字形,用高特异性选择器强制还原(见 iconFallback)
  ensureIconFallback(STYLE_ID, `#top-settings-holder #${BTN_ID} .drawer-icon.fa-solid`);
}

/**
 * 往 ST 顶栏(#top-settings-holder)注入一个快速打开棱镜宝书的 drawer 按钮,
 * 位置在「用户设定管理」(#persona-management-button)左边。
 *
 * 注入的按钮**不进 shadow DOM**——直接用 ST 的 .drawer / .drawer-icon 类名,
 * 跟随酒馆主题美化。点击只负责打开棱镜宝书窗口,不展开任何抽屉(故无 .drawer-toggle,
 * 避免 ST 的 doNavbarIconClick 把它当抽屉来开合)。
 *
 * 受设置开关控制:开 → 确保已注入;关 → 移除。轮询等顶栏出现(顶栏懒加载)。
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'drawer';
  btn.innerHTML = `
    <div class="drawer-toggle">
      <div class="drawer-icon fa-solid fa-book-bookmark fa-fw closedIcon" title="棱镜宝书"></div>
    </div>
  `;
  // 仅打开窗口,不走 ST 的抽屉开合逻辑(故未挂 .drawer-toggle 的 doNavbarIconClick)
  btn.querySelector('.drawer-toggle')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openBook();
  });
  return btn;
}

/** 真正执行插入:成功或已存在返回 true,顶栏未就绪返回 false(由轮询重试)。 */
function tryInject(): boolean {
  const holder = document.getElementById('top-settings-holder');
  if (!holder) return false;
  if (document.getElementById(BTN_ID)) return true;

  ensureStyle();
  const btn = buildButton();
  // 插到「用户设定管理」左边;它若还没渲染则退而挂到顶栏末尾。
  const persona = document.getElementById('persona-management-button');
  if (persona) persona.before(btn);
  else holder.appendChild(btn);
  return true;
}

function removeButton(): void {
  document.getElementById(BTN_ID)?.remove();
}

/** 按开关同步顶栏按钮的有无。开关变化时调用即可(幂等)。 */
export function syncTopBarButton(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    removeButton();
    return;
  }
  if (tryInject()) return;
  // 顶栏懒加载:轮询等它出现。顶栏是 index.html 静态结构,通常首次即命中、timer 不启动;
  // 万一始终不出现,封顶 ~20s(40 次)后放弃,绝不常驻空转(同 index.ts 的 bindMemoryWhenReady 范式)。
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 500);
}
