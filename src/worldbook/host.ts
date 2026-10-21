/**
 * 世界书宿主接口：本模块是世界书功能唯一接触酒馆世界书数据的地方。
 * - 读写用 getContext() 的 loadWorldInfo / saveWorldInfo(name, data, true) / reloadWorldInfoEditor / updateWorldInfoList；
 * - 世界书列表、条目模板、空闲 uid、聊天绑定键、全局启用列表、角色附加书从 /scripts/world-info.js 动态读取
 *   （与 st/context.ts 的 getCheckWorldInfo 相同做法）。已按 SillyTavern 1.15.0 核对。
 * loadWorldInfo 第一次从服务器读取时返回的就是缓存中的对象，所以读到的数据一律先深拷贝再修改。
 */
import { reactive } from 'vue';
import { getContext, type STContext } from '@/st/context';
import type { WorldData } from './types';

interface WorldInfoModule {
  world_names?: unknown;
  selected_world_info?: unknown;
  world_info?: { charLore?: unknown };
  METADATA_KEY?: unknown;
  newWorldInfoEntryTemplate?: unknown;
  getFreeWorldEntryUid?: unknown;
  setWIOriginalDataValue?: unknown;
  deleteWIOriginalDataValue?: unknown;
}

export interface BookBindings {
  /** 当前聊天绑定的世界书。 */
  chat: string;
  /** 当前角色的主世界书。 */
  charPrimary: string;
  /** 当前角色的附加世界书。 */
  charAux: string[];
  /** 全局启用的世界书。 */
  global: string[];
  /** 用户角色（persona）绑定的世界书。 */
  persona: string;
  /** 群聊中不读取角色世界书。 */
  group: boolean;
}

export const NO_API_MESSAGE = '当前酒馆没有提供读写世界书的接口（getContext 中的 loadWorldInfo、saveWorldInfo）。世界书功能需要提供这两个接口的 SillyTavern 版本（已按 1.15.0 核对），可升级酒馆；在此之前，可在酒馆的世界书面板中手动编辑条目。';
export const NO_TEMPLATE_MESSAGE = '无法读取酒馆的世界书条目模板（/scripts/world-info.js 中的 newWorldInfoEntryTemplate），不能新建条目。已按 SillyTavern 1.15.0 核对，其他版本的文件结构可能不同；追加、替换和改写不受影响，新条目可在酒馆的世界书面板中手动创建。';

/** 世界书列表与绑定的快照，供界面显示；在打开页面、切换聊天、写入后和点击刷新时更新。 */
export const worldHost = reactive({
  /** 全部世界书名；null 表示读取不到列表。 */
  names: null as string[] | null,
  bindings: { chat: '', charPrimary: '', charAux: [], global: [], persona: '', group: false } as BookBindings,
  /** 列表读取方式：module 为酒馆模块，context/dom 为兜底，none 为读取不到。 */
  source: 'none' as 'module' | 'context' | 'dom' | 'none',
  revision: 0,
});

let modulePromise: Promise<WorldInfoModule | null> | null = null;
let loadedModule: WorldInfoModule | null = null;

export function worldInfoModule(): Promise<WorldInfoModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        // 变量持有路径，避免 Vite/vue-tsc 把它当本地模块解析
        const path = '/scripts/world-info.js';
        loadedModule = await import(/* @vite-ignore */ path) as WorldInfoModule;
        return loadedModule;
      } catch {
        return null;
      }
    })();
  }
  return modulePromise;
}

const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const strings = (v: unknown): string[] => Array.isArray(v) ? v.map(text).filter(Boolean) : [];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function readNames(mod: WorldInfoModule | null, ctx: STContext | null): { names: string[] | null; source: typeof worldHost.source } {
  if (Array.isArray(mod?.world_names)) return { names: strings(mod!.world_names), source: 'module' };
  const fn = ctx?.getWorldInfoNames;
  if (typeof fn === 'function') {
    try { const list = fn(); if (Array.isArray(list)) return { names: strings(list), source: 'context' }; } catch { /* 读不到时继续兜底 */ }
  }
  // 旧版没有上面两种接口时，从世界书面板的下拉框读（value 为空的是占位项）
  if (typeof document !== 'undefined') {
    const options = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
    if (options.length) return { names: [...options].filter(o => o.value !== '').map(o => text(o.textContent)).filter(Boolean), source: 'dom' };
  }
  return { names: null, source: 'none' };
}

export function metadataKey(mod: WorldInfoModule | null = loadedModule): string {
  return typeof mod?.METADATA_KEY === 'string' && mod.METADATA_KEY ? mod.METADATA_KEY : 'world_info';
}

function readBindings(mod: WorldInfoModule | null, ctx: STContext | null): BookBindings {
  const group = !!ctx?.groupId;
  const id = ctx?.characterId;
  const character = !group && id !== undefined && id !== '' ? ctx?.characters?.[Number(id)] as Record<string, any> | undefined : undefined;
  const avatar = typeof character?.avatar === 'string' ? character.avatar.replace(/\.[^/.]+$/, '') : '';
  const lore = mod?.world_info?.charLore;
  const aux = avatar && Array.isArray(lore) ? lore.find(e => e && typeof e === 'object' && (e as Record<string, unknown>).name === avatar) as Record<string, unknown> | undefined : undefined;
  return {
    chat: text(ctx?.chatMetadata?.[metadataKey(mod)]),
    charPrimary: text(character?.data?.extensions?.world),
    charAux: strings(aux?.extraBooks),
    global: strings(mod?.selected_world_info),
    persona: text((ctx?.powerUserSettings as Record<string, unknown> | undefined)?.persona_description_lorebook),
    group,
  };
}

/** 重新读取世界书列表与当前聊天的绑定。 */
export async function refreshWorldHost(): Promise<void> {
  const mod = await worldInfoModule();
  const ctx = getContext();
  const { names, source } = readNames(mod, ctx);
  worldHost.names = names ? [...new Set(names)] : null;
  worldHost.source = source;
  worldHost.bindings = readBindings(mod, ctx);
  worldHost.revision++;
}

export function hostApiIssue(): string {
  const ctx = getContext();
  return typeof ctx?.loadWorldInfo === 'function' && typeof ctx?.saveWorldInfo === 'function' ? '' : NO_API_MESSAGE;
}

function validData(data: unknown): data is WorldData {
  return !!data && typeof data === 'object' && !Array.isArray(data) && !!(data as WorldData).entries
    && typeof (data as WorldData).entries === 'object' && !Array.isArray((data as WorldData).entries);
}

/** 读取一本世界书（深拷贝）；不存在或格式不对时返回 null。 */
export async function loadBook(name: string): Promise<WorldData | null> {
  const issue = hostApiIssue(); if (issue) throw new Error(issue);
  let data: unknown;
  try { data = await getContext()!.loadWorldInfo(name); }
  catch { throw new Error('读取世界书「' + name + '」没有成功：酒馆服务器没有响应。请检查网络或酒馆是否在运行，稍后重试。'); }
  return validData(data) ? clone(data) : null;
}

/** 用酒馆原生接口立即保存，再刷新世界书编辑器（编辑器正显示这本书时重新载入，免得旧数据覆盖回去）。 */
export async function saveBook(name: string, data: WorldData): Promise<void> {
  const issue = hostApiIssue(); if (issue) throw new Error(issue);
  const ctx = getContext()!;
  try { await ctx.saveWorldInfo(name, data, true); }
  catch { throw new Error('保存世界书「' + name + '」时酒馆服务器没有响应，可能没有保存成功。请刷新酒馆页面，在世界书面板中检查后再操作。'); }
  try { ctx.reloadWorldInfoEditor?.(name); } catch { /* 编辑器刷新失败不影响已保存的数据 */ }
}

/** 保存后直接向酒馆服务器读取这本书核对；读取失败返回 null（视为无法核对）。 */
export async function fetchServerCopy(name: string): Promise<WorldData | null> {
  const ctx = getContext();
  if (typeof ctx?.getRequestHeaders !== 'function' || typeof fetch !== 'function') return null;
  try {
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-cache' });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return validData(data) ? data : null;
  } catch {
    return null;
  }
}

/** ST 的新条目模板（不含 uid）；读取不到时返回 null。 */
export async function entryTemplate(): Promise<Record<string, unknown> | null> {
  const template = (await worldInfoModule())?.newWorldInfoEntryTemplate;
  return template && typeof template === 'object' && !Array.isArray(template) ? clone(template as Record<string, unknown>) : null;
}

/** 空闲 uid：优先用酒馆的 getFreeWorldEntryUid，规则相同（从 0 起第一个未占用的整数）。 */
export function freeUid(data: WorldData): number | null {
  const fn = loadedModule?.getFreeWorldEntryUid;
  if (typeof fn === 'function') {
    const uid = fn(data);
    if (Number.isInteger(uid) && uid >= 0) return uid;
  }
  for (let uid = 0; uid < 1_000_000; uid++) if (!(uid in data.entries)) return uid;
  return null;
}

/**
 * 角色卡导入的世界书带 originalData（卡内 character_book 的原始格式）。酒馆编辑条目时同步改它，
 * 导出角色卡时才不会带回旧内容；这里沿用同样的做法（酒馆提供的函数优先）。
 */
export function syncOriginalData(data: WorldData, uid: number, field: 'content' | 'keys', value: unknown): void {
  const fn = loadedModule?.setWIOriginalDataValue;
  if (typeof fn === 'function') { fn(data, uid, field, clone(value)); return; }
  const original = data.originalData as { entries?: unknown } | undefined;
  if (!original || !Array.isArray(original.entries)) return;
  const entry = original.entries.find(x => x && typeof x === 'object' && (x as Record<string, unknown>).uid === uid) as Record<string, unknown> | undefined;
  if (entry) entry[field] = clone(value);
}
export function removeOriginalData(data: WorldData, uid: number): void {
  const fn = loadedModule?.deleteWIOriginalDataValue;
  if (typeof fn === 'function') { fn(data, uid); return; }
  const original = data.originalData as { entries?: unknown } | undefined;
  if (!original || !Array.isArray(original.entries)) return;
  // eslint-disable-next-line eqeqeq -- 与酒馆一致，uid 可能存成字符串
  const index = original.entries.findIndex(x => x && typeof x === 'object' && (x as Record<string, unknown>).uid == uid);
  if (index >= 0) original.entries.splice(index, 1);
}

/** 世界书名只允许常规字符，避免服务器清洗文件名后与绑定的名字对不上。 */
export function bookNameIssue(name: string): string {
  const value = name.trim();
  if (!value) return '请填写世界书名。';
  if (value.length > 64) return '世界书名最多 64 个字。';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) return '世界书名不能包含 \\ / : * ? " < > | 等字符。';
  if (/^\.|\.$/.test(value)) return '世界书名不能以句点开头或结尾。';
  return '';
}

/** 新建一本空的世界书并绑定到当前聊天。只在当前聊天还没有绑定世界书时使用。 */
export async function createChatBook(name: string): Promise<string> {
  const value = name.trim();
  const issue = bookNameIssue(value) || hostApiIssue(); if (issue) throw new Error(issue);
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) throw new Error('请先打开一个已保存的聊天。');
  const mod = await worldInfoModule();
  const key = metadataKey(mod);
  if (text(ctx.chatMetadata?.[key])) throw new Error('当前聊天已经绑定了世界书，没有新建。');
  const before = readNames(mod, ctx).names;
  if (!before) throw new Error('读取不到世界书列表，没有新建。请刷新页面后重试。');
  if (before.some(n => n.toLowerCase() === value.toLowerCase())) throw new Error('已有同名的世界书「' + value + '」，请换一个名字。');
  const chat = ctx.chat, chatId = ctx.getCurrentChatId();
  await ctx.saveWorldInfo(value, { entries: {} }, true);
  await ctx.updateWorldInfoList?.();
  const after = readNames(await worldInfoModule(), getContext()).names;
  if (!after?.includes(value)) throw new Error('世界书「' + value + '」已提交保存，但列表中没有找到它。请刷新页面后在酒馆的世界书面板中检查。');
  const now = getContext();
  if (!now || now.chat !== chat || now.getCurrentChatId() !== chatId) throw new Error('世界书「' + value + '」已创建，但聊天已经切换，没有绑定。可在原聊天中绑定。');
  now.chatMetadata[key] = value;
  await now.saveMetadata();
  if (typeof document !== 'undefined') document.querySelectorAll('.chat_lorebook_button').forEach(el => el.classList.add('world_set'));
  await refreshWorldHost();
  return value;
}
