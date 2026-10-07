/**
 * 轻量 toast 封装。ST 全局挂着 toastr(jQuery 插件),直接用它弹非模态提示。
 * 拿不到时静默退回 console.log,绝不抛错(提示失败不应影响主流程)。
 */

type ToastType = 'info' | 'success' | 'warning' | 'error';

interface Toastr {
  info: (msg: string, title?: string) => void;
  success: (msg: string, title?: string) => void;
  warning: (msg: string, title?: string) => void;
  error: (msg: string, title?: string) => void;
}

export function toast(message: string, type: ToastType = 'info'): void {
  try {
    const t = (window as unknown as { toastr?: Toastr }).toastr;
    if (t && typeof t[type] === 'function') {
      t[type](message, '棱镜宝书');
      return;
    }
  } catch {
    /* toastr 不可用 → 退回日志 */
  }
  console.log('[棱镜宝书]', message);
}
