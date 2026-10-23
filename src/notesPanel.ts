/**
 * 聊天里的札记卡片宿主:在最新正文楼层和有札记的楼层的正文后面挂一个 shadow 宿主,
 * 里面挂 NotesCard.vue。挂法、样式共享、防重复和楼层面板(floorPanel.ts)相同,两者互不依赖:
 * 只启用札记、不启用楼层面板也能显示;同一楼两者都有时,札记卡片排在楼层面板下面。
 *
 * 只在启用双子札记、且札记页里「在聊天中显示札记」打开时挂载。
 */
import { createApp, reactive, watch, type App } from 'vue';
import NotesCard from '@/components/NotesCard.vue';
import { getContext } from '@/st/context';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { attachSharedStyles, ensureSharedSheet, SHADOW_HOST_CLASS } from '@/st/shadowStyles';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { notesSettings } from '@/notes/settings';
import { notesState } from '@/notes/store';
import { notesRun } from '@/notes/service';
import { notesCardFloors } from '@/notes/floors';

const HOST_CLASS = 'bbs-notes-host';
const MARK_ATTR = 'data-bbs-notes';

let enabled = false;
let observer: MutationObserver | null = null;
let obTimer: ReturnType<typeof setTimeout> | null = null;
const bound = new Set<string>();

// 酒馆事件(渲染、翻页、编辑等)转发给已挂载的卡片,让它们重读 chat
const signal = reactive({ tick: 0 });
function bumpTick(): void {
  signal.tick++;
}

interface Mounted {
  host: HTMLElement;
  app: App;
}
const mountedByFloor = new Map<number, Mounted>();

function wanted(): boolean {
  return enabled && notesSettings.enabled && notesSettings.showInChat && engineActiveHere();
}
function mesEl(idx: number): HTMLElement | null {
  return document.querySelector(`.mes[mesid="${idx}"]`);
}

function mountFloor(idx: number): void {
  const el = mesEl(idx);
  if (!el) return;
  if (el.getAttribute(MARK_ATTR) === '1' && mountedByFloor.get(idx)?.host.isConnected) return;
  removeFloor(idx);
  el.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());

  const host = document.createElement('div');
  host.className = `${HOST_CLASS} ${SHADOW_HOST_CLASS}`;
  host.setAttribute('data-bbs-notes-floor', String(idx));
  const root = host.attachShadow({ mode: 'open' });
  guardEditableArrowKeys(root);
  attachSharedStyles(root);
  const container = document.createElement('div');
  root.appendChild(container);
  const app = createApp(NotesCard, { floor: idx, sig: signal });
  app.mount(container);

  // 排在楼层面板后面;没有楼层面板时紧跟正文
  const panel = el.querySelector('.bbs-fp-host');
  const mesText = el.querySelector('.mes_text');
  if (panel) panel.insertAdjacentElement('afterend', host);
  else if (mesText) mesText.insertAdjacentElement('afterend', host);
  else el.appendChild(host);

  mountedByFloor.set(idx, { host, app });
  el.setAttribute(MARK_ATTR, '1');
}

function removeFloor(idx: number): void {
  const m = mountedByFloor.get(idx);
  if (m) {
    m.app.unmount();
    m.host.remove();
    mountedByFloor.delete(idx);
  }
  mesEl(idx)?.removeAttribute(MARK_ATTR);
}

function clearAll(): void {
  for (const idx of [...mountedByFloor.keys()]) removeFloor(idx);
  document.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());
  document.querySelectorAll(`.mes[${MARK_ATTR}]`).forEach(n => n.removeAttribute(MARK_ATTR));
}

/** 按当前状态对齐:该挂的挂上(含被酒馆重渲冲掉的),不该挂的卸掉。只看页面上已渲染的楼层。 */
function reconcile(): void {
  if (!wanted()) { clearAll(); return; }
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) { clearAll(); return; }
  const rendered: number[] = [];
  document.querySelectorAll('.mes[mesid]').forEach(el => {
    const idx = Number((el as HTMLElement).getAttribute('mesid'));
    if (Number.isInteger(idx) && idx >= 0) rendered.push(idx);
  });
  const target = notesCardFloors(ctx, rendered);
  for (const [idx, m] of mountedByFloor) {
    if (!target.has(idx) || !m.host.isConnected) removeFloor(idx);
  }
  for (const idx of target) mountFloor(idx);
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconcile(delay = 50): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcile();
    bumpTick();
  }, delay);
}

function bindEvents(): void {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (!es || !et) return;
  const on = (name: string | undefined, delay = 50) => {
    if (!name || bound.has(name)) return;
    es.on(name, () => { if (enabled) scheduleReconcile(delay); });
    bound.add(name);
  };
  on(et.CHARACTER_MESSAGE_RENDERED);
  on(et.USER_MESSAGE_RENDERED);
  on(et.MESSAGE_SWIPED);
  on(et.MESSAGE_DELETED);
  on(et.MESSAGE_UPDATED);
  on(et.MESSAGE_EDITED);
  on(et.CHAT_CHANGED, 80);
  if (et.MORE_MESSAGES_LOADED) on(et.MORE_MESSAGES_LOADED);
}

/** 盯聊天区:酒馆重渲消息时补挂被冲掉的宿主。防抖,避免流式生成期间高频触发。 */
function startObserver(): void {
  if (observer) return;
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;
  observer = new MutationObserver(() => {
    if (!wanted() || obTimer) return;
    obTimer = setTimeout(() => {
      obTimer = null;
      reconcile();
    }, 200);
  });
  observer.observe(chatEl, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  if (obTimer) {
    clearTimeout(obTimer);
    obTimer = null;
  }
}

/** 按开关同步札记卡片的有无(幂等)。 */
export function syncNotesPanel(on: boolean): void {
  enabled = on;
  if (!on) {
    stopObserver();
    clearAll();
    return;
  }
  void ensureSharedSheet();
  bindEvents();
  startObserver();
  reconcile();
}

/**
 * 启动链调用一次:跟随双子札记的开关和「在聊天中显示札记」;札记增删、生成楼层变化时重新对齐。
 * 插件总开关和角色排除不放进开关侦听:当前角色名不是响应式数据,切换聊天后侦听记下的值会过时
 * (从被排除角色的聊天切到普通聊天时卡片不补挂)。改为每次对齐时用 engineActiveHere 判断,总开关或排除名单变化时重新对齐。
 */
export function bindNotesPanel(): void {
  watch(
    () => notesSettings.enabled && notesSettings.showInChat,
    on => syncNotesPanel(on),
    { immediate: true },
  );
  watch(() => [apiSettings.enabled, apiSettings.excludedChars.join('\n')], () => {
    if (enabled) scheduleReconcile(0);
  });
  watch(() => [notesState.revision, notesState.records.length, notesRun.floor], () => {
    if (enabled) scheduleReconcile(0);
  });
}
