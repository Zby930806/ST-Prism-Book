// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from 'vue/compiler-sfc';
import { ModuleKind, transpileModule } from 'typescript';
import * as Vue from 'vue';
import { createRenderer, nextTick } from 'vue';
import type { App, Component } from 'vue';
import * as host from '@/st/context';
import * as settings from './settings';
import * as service from './service';
import * as store from './store';
import * as prompt from './prompt';
import * as modelCatalog from './modelCatalog';
import { getContext } from '@/st/context';
import type { STContext } from '@/st/context';
import { loadNotes, notesState, NOTES_DATA_KEY } from './store';
import type { NoteRecord } from './types';

vi.mock('@/st/context', () => ({ getContext: vi.fn() }));
vi.mock('@/notes/service', () => ({
  notesRun: { busy: false, status: '', error: '', draft: '' },
  generateNotes: vi.fn(), cancelNotes: vi.fn(),
  confirmedInjectionPlan: vi.fn(() => ({ text: '', injected: 0, omitted: 0, total: 0 })), NOTES_INJECTION_LIMIT: 16000,
}));

// Node 模式的 Vite 默认编译 SSR；这里直接编译客户端 SFC，避免改变项目测试配置。
const source = readFileSync(new URL('../pages/notes/index.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: 'notes-expansion-test', inlineTemplate: true });
const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } });
const dependencies: Record<string, unknown> = {
  // 仅跳过无关 API 表单的 DOM v-model 指令；记录的 open/toggle 和分页仍走真实渲染。
  vue: { ...Vue, vModelText: {}, vModelCheckbox: {}, vModelSelect: {} },
  '@/st/context': host, '@/notes/settings': settings, '@/notes/service': service,
  '@/notes/store': store, '@/notes/prompt': prompt, '@/notes/modelCatalog': modelCatalog,
  // 跨页定位只在设置页跳转时用到；这里不发请求，避免牵出 state/ui 的本机存储。
  '@/state/pageFocus': { pageFocus: Vue.reactive({ section: '' }), takePageFocus: () => false },
  // 删除札记的确认弹窗和提示：本测试不涉及删除，用空组件与空函数占位。
  '@/components/ConfirmDialog.vue': { default: { render: () => null } },
  '@/st/toast': { toast: () => {} },
  '@/components/Icon.vue': { default: { render: () => null } },
  '@/components/PageHeader.vue': { default: { render: () => null } },
};
const compiled: { default?: Component } = {};
new Function('require', 'exports', outputText)((name: string) => {
  if (!(name in dependencies)) throw new Error(`未模拟的组件依赖：${name}`);
  return dependencies[name];
}, compiled);
const NotesPage = compiled.default!;

// 挂载真实 SFC，以内存宿主验证模板、原生 toggle 绑定和 Vue 节点复用，无浏览器/酒馆依赖。
type HostNode = {
  type: string; text: string; props: Record<string, any>;
  parent: HostNode | null; children: HostNode[];
  open: boolean; dataset: Record<string, string>;
};
function node(type: string, text = ''): HostNode {
  return { type, text, props: {}, parent: null, children: [], open: false, dataset: {} };
}
function remove(child: HostNode) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
function insert(child: HostNode, parent: HostNode, anchor: HostNode | null = null) {
  remove(child);
  parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
  child.parent = parent;
}
const renderer = createRenderer<HostNode, HostNode>({
  createElement: type => node(type), createText: text => node('#text', text),
  createComment: text => node('#comment', text), insert, remove,
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  patchProp(target, key, _previous, value) {
    target.props[key] = value;
    if (key === 'open') target.open = !!value;
    if (key === 'data-expansion-scope') target.dataset.expansionScope = String(value);
  },
  insertStaticContent(content, parent, anchor) {
    const child = node('#static', content);
    insert(child, parent, anchor);
    return [child, child];
  },
});
let app: App | undefined;
let root: HostNode;
let context: STContext;
let chatId: string;
function records(count = 11): NoteRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `note-${i}`, createdAt: count - i, floor: i, swipe: 0,
    sourceHash: 'test', text: `札记 ${i}`, questions: [],
  }));
}
function createContext(): STContext {
  return {
    chat: [], getCurrentChatId: () => chatId,
    chatMetadata: { [NOTES_DATA_KEY]: { version: 1, records: records(), decisions: [] } },
  } as unknown as STContext;
}
function all(target = root): HostNode[] {
  return [target, ...target.children.flatMap(child => all(child))];
}
function visible() {
  return all().filter(target => target.props.class?.split(' ').includes('notes-record'));
}
async function turnPage(label: '上一页札记' | '下一页札记') {
  const button = all().find(target => target.props['aria-label'] === label)!;
  expect(button.props.disabled).toBe(false);
  button.props.onClick();
  await nextTick();
}
async function toggle(target: HostNode, open: boolean) {
  target.open = open;
  target.props.onToggle({ currentTarget: target });
  await nextTick();
}
function expectCollapsed() {
  expect(visible().length).toBeGreaterThan(0);
  expect(visible().every(target => !target.open)).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('禁止真实网络')));
  chatId = 'chat-a';
  context = createContext();
  vi.mocked(getContext).mockImplementation(() => context);
  loadNotes();
  root = node('root');
  app = renderer.createApp(NotesPage);
  app.mount(root);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('札记记录展开状态', () => {
  it('首次进入所有札记折叠，逐页及返回首页不自动展开第一条', async () => {
    expect(visible()).toHaveLength(5);
    expectCollapsed();
    await turnPage('下一页札记');
    expectCollapsed();
    await turnPage('下一页札记');
    expect(visible()).toHaveLength(1);
    expectCollapsed();
    await turnPage('上一页札记');
    await turnPage('上一页札记');
    expectCollapsed();
  });

  it('手动打开和关闭独立记录正常，翻页返回保留手动选择', async () => {
    await toggle(visible()[0], true);
    await toggle(visible()[2], true);
    expect(visible().map(target => target.open)).toEqual([true, false, true, false, false]);
    await turnPage('下一页札记');
    expectCollapsed();
    await toggle(visible()[1], true);
    await turnPage('上一页札记');
    expect(visible().map(target => target.open)).toEqual([true, false, true, false, false]);
    await toggle(visible()[0], false);
    await turnPage('下一页札记');
    expect(visible().map(target => target.open)).toEqual([false, true, false, false, false]);
    await turnPage('上一页札记');
    expect(visible().map(target => target.open)).toEqual([false, false, true, false, false]);
  });

  it('同聊天数据刷新保留手动展开，新生成或导入的首条不自动展开', async () => {
    await toggle(visible()[0], true);
    loadNotes();
    await nextTick();
    expect(visible()[0].open).toBe(true);
    notesState.records.push({ ...records(1)[0], id: 'new-note', createdAt: 100 });
    notesState.revision++;
    await nextTick();
    expect(visible()[0].open).toBe(false);
    expect(visible()[1].open).toBe(true);
  });

  it.each(['new-chat', 'same-array-new-id', 'same-id-new-array'])(
    '切聊天不复用同 ID 札记的展开状态：%s', async mode => {
      await toggle(visible()[0], true);
      const previous = visible()[0];
      if (mode !== 'same-id-new-array') chatId = 'chat-b';
      if (mode !== 'same-array-new-id') context = createContext();
      loadNotes();
      await nextTick();
      expectCollapsed();
      expect(visible()[0]).not.toBe(previous);
      // 模拟旧聊天节点滞后的原生 toggle，不得污染新聊天同 ID 记录。
      await toggle(previous, true);
      expectCollapsed();
      await toggle(visible()[0], true);
      await toggle(previous, false);
      expect(visible()[0].open).toBe(true);
      await turnPage('下一页札记');
      await turnPage('上一页札记');
      expect(visible()[0].open).toBe(true);
    },
  );

  it('同一渲染批次内来回切聊也清空旧展开状态', async () => {
    await toggle(visible()[0], true);
    chatId = 'chat-b';
    loadNotes();
    chatId = 'chat-a';
    loadNotes();
    await nextTick();
    expectCollapsed();
  });
});

describe('已确认的安排', () => {
  it('依据的正文已改动的安排仍可设为待兑现，醒目提示并可一键取消；「注入中」按实际注入条数显示', async () => {
    app?.unmount();
    context = {
      chat: [], getCurrentChatId: () => chatId,
      chatMetadata: { [NOTES_DATA_KEY]: { version: 1,
        records: [{ id: 'gone', createdAt: 1, floor: 3, swipe: 0, sourceHash: 'x', floorHash: 'y', text: 'Q1. 甲？凝嘤嘤暂定: 甲', questions: [{ id: 'Q1', label: 'Q1', prompt: '甲？', proposal: '甲' }] }],
        decisions: [{ id: 'd1', noteId: 'gone', questionId: 'Q1', text: '去山里', status: 'in_progress', createdAt: 5 }] } },
    } as unknown as STContext;
    loadNotes();
    const previous = { enabled: settings.notesSettings.enabled, injectConfirmed: settings.notesSettings.injectConfirmed };
    Object.assign(settings.notesSettings, { enabled: true, injectConfirmed: true });
    vi.mocked(service.confirmedInjectionPlan).mockReturnValue({ text: '[戏外]', injected: 1, omitted: 2, total: 3 });
    try {
      root = node('root'); app = renderer.createApp(NotesPage); app.mount(root); await nextTick();
      const texts = all().map(target => target.text).join('\n');
      expect(texts).toContain('依据的正文已改动');
      expect(texts).toContain('注入中 · 1 条');
      expect(texts).toContain('有 2 条安排超出注入上限');
      expect(texts).toContain('有 1 条安排依据的札记所在楼已被改写、重抽或删除，仍在注入正文');
      const button = (label: string) => all().find(target => target.type === 'button' && (target.text.includes(label) || target.children.some(child => child.text.includes(label))))!;
      expect(button('待兑现').props.disabled).toBe(false);
      expect(button('取消这条安排').props.disabled).toBe(false);
    } finally {
      Object.assign(settings.notesSettings, previous);
      vi.mocked(service.confirmedInjectionPlan).mockReturnValue({ text: '', injected: 0, omitted: 0, total: 0 });
    }
  });
  it('「注入已确认安排」关闭时，依据的正文已改动的安排不说「仍在注入正文」', async () => {
    app?.unmount();
    context = {
      chat: [], getCurrentChatId: () => chatId,
      chatMetadata: { [NOTES_DATA_KEY]: { version: 1,
        records: [{ id: 'gone', createdAt: 1, floor: 3, swipe: 0, sourceHash: 'x', floorHash: 'y', text: 'Q1. 甲？凝嘤嘤暂定: 甲', questions: [{ id: 'Q1', label: 'Q1', prompt: '甲？', proposal: '甲' }] }],
        decisions: [{ id: 'd1', noteId: 'gone', questionId: 'Q1', text: '去山里', status: 'pending', createdAt: 5 }] } },
    } as unknown as STContext;
    loadNotes();
    const previous = { enabled: settings.notesSettings.enabled, injectConfirmed: settings.notesSettings.injectConfirmed };
    Object.assign(settings.notesSettings, { enabled: true, injectConfirmed: false });
    try {
      root = node('root'); app = renderer.createApp(NotesPage); app.mount(root); await nextTick();
      const texts = all().map(target => target.text).join('\n');
      expect(texts).toContain('未注入');
      expect(texts).toContain('有 1 条安排依据的札记所在楼已被改写、重抽或删除，仍是待兑现或进行中');
      expect(texts).toContain('打开「注入已确认安排」后会注入正文');
      expect(texts).not.toContain('仍在注入正文');
    } finally {
      Object.assign(settings.notesSettings, previous);
    }
  });
});
