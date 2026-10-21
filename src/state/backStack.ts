import { nextTick } from 'vue';

/**
 * 返回键分层关闭：宝书窗口、弹窗、确认框、菜单、下拉列表每打开一层，就在浏览器历史里压一条「返回记录」。
 * 按返回键（安卓返回键、电脑浏览器的后退键、iOS 侧滑返回都会触发 popstate）会退掉一条记录，
 * 插件随之关掉最上面的一层；层全部关掉、记录全部退完以后，返回键恢复浏览器原来的行为。
 * 用关闭键、Esc、点遮罩等方式关掉一层时，插件自己退掉多出来的那条记录。
 *
 * 为什么每层一条、而且只在打开时压：Chromium 会让返回键跳过「没有用户操作时压入」的历史记录，
 * 而且按过一次返回之后，之前的点按不再算数（History Manipulation Intervention）。
 * 若按返回后再补压记录，下一次按返回会把整页的记录都跳过，直接离开酒馆。所以：
 * - 打开层时（由用户点按触发）压入记录；按返回只退记录、关层，不再补压。
 * - 需要补压时（例如确认框处理中拒绝关闭、按返回之后才自动弹出的层），等用户下一次点按或按键时再压。
 *
 * 其他规则：
 * - 只有确认当前历史就是自己压的记录时才调用 history.back()；别的脚本压了记录时不动历史，不会离开页面。
 * - 退记录前稍等片刻再核对：这期间用户自己按了返回或又打开了新层，就不再退，避免两次后退叠在一起。
 * - 自己的后退在途时不压新记录；迟迟等不到 popstate 时只放弃这次，不再补退。
 * - 页面卸载（pagehide）后不再动历史。
 */

/** 用到的 History 接口（测试里用模拟实现）。 */
export interface HistoryPort {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  back(): void;
}

/** 用户操作的记录：浏览器里由点按、按键事件更新。 */
export interface ActivationPort {
  /** 最近一次用户操作的时间（与 now 同一时钟）；没有为 0。 */
  lastAt(): number;
  /** 开始记录之前页面是否已有过用户操作（navigator.userActivation.hasBeenActive，不支持时按有）。 */
  hasBeenActive(): boolean;
  /** 下一次用户操作时回调一次。 */
  onNext(callback: () => void): void;
}

export interface BackStackEnv {
  history: HistoryPort;
  activation: ActivationPort;
  /** 单调时钟（毫秒）。 */
  now(): number;
  /** 订阅 popstate。 */
  listen(handler: () => void): void;
  /** 在下一次界面更新之后执行（浏览器里是 Vue 的 nextTick）。 */
  defer(task: () => void): void;
  /** 定时器，返回取消函数。 */
  timer(task: () => void, ms: number): () => void;
  /** 退记录前等待的毫秒数（默认 30）。 */
  leaveDelayMs?: number;
  warn?(message: string, error: unknown): void;
}

export interface BackStack {
  /** 登记一层；返回的函数在这一层关闭或卸载时调用（可重复调用）。 */
  open(close: () => void): () => void;
  /** 页面卸载后调用：之后不再修改历史。 */
  freeze(): void;
  /** 当前登记的层数（测试与排查用）。 */
  readonly depth: number;
  /** 认为历史里有几条自己的记录（测试与排查用）。 */
  readonly entries: number;
}

export const BACK_GUARD_KEY = 'prismBookBack';
/** 退记录前的等待：给已经按下的返回键留出 popstate 回来的时间。 */
const LEAVE_DELAY_MS = 30;
/** 自己调用 history.back() 后，等 popstate 的最长时间。 */
const LEAVE_TIMEOUT_MS = 3000;

type GuardState = { [BACK_GUARD_KEY]: string; n: number };

export function createBackStack(env: BackStackEnv): BackStack {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const layers: Array<{ close: () => void }> = [];
  const leaveDelay = env.leaveDelayMs ?? LEAVE_DELAY_MS;
  let listening = false;
  /** 自己的后退都落地以后，历史里自己的记录条数（第 n 条记录的 state.n 为 n）。 */
  let entries = 0;
  /** 已调用 history.back()、还没收到 popstate 的次数。 */
  let inflight = 0;
  let lastTraversalAt = 0;
  let frozen = false;
  let waitingActivation = false;
  let cancelLeaveDelay: (() => void) | null = null;
  let cancelLeaveTimer: (() => void) | null = null;
  let syncQueued = false;

  const guardN = (state: unknown): number => {
    if (!state || typeof state !== 'object') return 0;
    const s = state as Partial<GuardState>;
    return s[BACK_GUARD_KEY] === token && typeof s.n === 'number' && s.n > 0 ? s.n : 0;
  };

  /** 现在压记录会不会被当成用户操作压的：最近一次返回之后有过用户操作（还没返回过时看页面是否有过操作）。 */
  const activationHonored = (): boolean =>
    env.activation.lastAt() > lastTraversalAt || (lastTraversalAt === 0 && env.activation.hasBeenActive());

  function queueSync(): void {
    if (syncQueued || frozen) return;
    syncQueued = true;
    env.defer(() => {
      syncQueued = false;
      sync();
    });
  }

  /** 让记录条数与层数一致：缺的补压（需要用户操作），多的稍后退掉。 */
  function sync(): void {
    if (inflight || frozen) return;
    if (entries < layers.length) {
      if (!activationHonored()) {
        // 没有用户操作时压的记录会被返回键跳过：等用户下一次点按或按键再压
        if (!waitingActivation) {
          waitingActivation = true;
          env.activation.onNext(() => {
            waitingActivation = false;
            sync();
          });
        }
        return;
      }
      try {
        while (entries < layers.length) {
          env.history.pushState({ [BACK_GUARD_KEY]: token, n: entries + 1 } satisfies GuardState, '');
          entries++;
        }
      } catch (error) {
        // 压不进去（例如浏览器限制了调用频率）时不拦截，返回键按浏览器原来的行为处理。
        env.warn?.('返回记录没有压入历史，这一层的返回键按浏览器默认处理', error);
      }
      return;
    }
    if (entries > layers.length && !cancelLeaveDelay) cancelLeaveDelay = env.timer(leave, leaveDelay);
  }

  /** 退掉一条多出来的记录：等待结束时再核对一次，仍然多出、当前历史仍是自己的最上一条才后退。 */
  function leave(): void {
    cancelLeaveDelay = null;
    if (inflight || frozen || entries <= layers.length) return;
    const n = guardN(env.history.state);
    if (n !== entries) {
      // 别的脚本在上面压了记录，或计数与历史对不上：不动历史；当前就是自己的记录时按它校正计数
      if (n > 0) {
        entries = n;
        queueSync();
      }
      return;
    }
    inflight++;
    entries--;
    cancelLeaveTimer?.();
    cancelLeaveTimer = env.timer(() => {
      // 迟迟等不到 popstate：只放弃这次，不补退；下一次 popstate 会按历史校正计数
      cancelLeaveTimer = null;
      inflight = 0;
      queueSync();
    }, LEAVE_TIMEOUT_MS);
    try {
      env.history.back();
    } catch (error) {
      env.warn?.('退出返回记录失败', error);
      inflight = Math.max(0, inflight - 1);
      entries++;
    }
  }

  function onPopState(): void {
    if (frozen) return;
    lastTraversalAt = env.now();
    if (inflight > 0) {
      inflight--;
      if (!inflight) {
        cancelLeaveTimer?.();
        cancelLeaveTimer = null;
      }
    }
    // 按当前历史确定自己的记录还剩几条（别人的记录或原始页面算 0）；自己的后退还在途的再减去。
    // 自己的后退在发出时已经扣过，落地时条数不变；只有用户的返回会让条数变少。
    const before = entries;
    entries = Math.max(0, guardN(env.history.state) - inflight);
    if (entries < before) {
      // 记录被用户的返回用掉：记录条数以上的层（从最上面起）逐个关闭；拒绝关闭的层等用户下次操作时再补记录
      for (const layer of layers.slice(entries).reverse()) {
        try {
          layer.close();
        } catch (error) {
          env.warn?.('按返回键关闭界面时出错', error);
        }
      }
    }
    queueSync();
  }

  return {
    open(close) {
      if (!listening) {
        listening = true;
        env.listen(onPopState);
      }
      const layer = { close };
      layers.push(layer);
      queueSync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
        queueSync();
      };
    },
    freeze() {
      frozen = true;
      cancelLeaveDelay?.();
      cancelLeaveDelay = null;
      cancelLeaveTimer?.();
      cancelLeaveTimer = null;
    },
    get depth() {
      return layers.length;
    },
    get entries() {
      return entries;
    },
  };
}

/** 浏览器里的用户操作记录：只记会被浏览器当作用户操作的输入（与 Chromium 的判定一致）。 */
function browserActivation(): ActivationPort {
  let lastAt = 0;
  const waiters: Array<() => void> = [];
  const onInput = (event: Event) => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Escape') return;
    if (event.type === 'pointerdown' && (event as PointerEvent).pointerType !== 'mouse') return;
    if (event.type === 'pointerup' && (event as PointerEvent).pointerType === 'mouse') return;
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (ua && !ua.isActive) return;
    lastAt = performance.now();
    for (const callback of waiters.splice(0)) callback();
  };
  for (const type of ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend']) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  return {
    lastAt: () => lastAt,
    hasBeenActive: () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true,
    onNext: callback => { waiters.push(callback); },
  };
}

/** 浏览器环境：真实 history、popstate、用户操作记录与 Vue nextTick。 */
function browserEnv(): BackStackEnv {
  return {
    history: window.history,
    activation: browserActivation(),
    now: () => performance.now(),
    listen: handler => window.addEventListener('popstate', handler),
    defer: task => {
      void nextTick(task);
    },
    timer: (task, ms) => {
      const id = window.setTimeout(task, ms);
      return () => window.clearTimeout(id);
    },
    warn: (message, error) => console.warn('[棱镜宝书] ' + message, error),
  };
}

/** 没有浏览器历史（如单元测试的 node 环境）时什么都不做。 */
const inertStack: BackStack = {
  open: () => () => {},
  freeze: () => {},
  depth: 0,
  entries: 0,
};

let shared: BackStack | null = null;

/** 全局唯一的返回键层管理（宝书窗口、聊天里的楼层面板弹窗等共用）。 */
export function backStack(): BackStack {
  if (shared) return shared;
  if (typeof window === 'undefined' || !window.history || typeof window.history.pushState !== 'function') return inertStack;
  shared = createBackStack(browserEnv());
  const stack = shared;
  // 捕获阶段先于入口里卸载界面的 pagehide 监听执行：卸载时各层释放，不能再去退历史。
  window.addEventListener('pagehide', () => stack.freeze(), { once: true, capture: true });
  return shared;
}

/** 仅供测试：替换全局实例（传 null 恢复默认）。 */
export function setBackStackForTest(stack: BackStack | null): void {
  shared = stack;
}
