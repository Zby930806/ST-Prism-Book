// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from 'vue/compiler-sfc';
import { ModuleKind, transpileModule } from 'typescript';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, provide } from 'vue';
import type { App, Component } from 'vue';
import * as settings from '@/api/settings';
import * as client from '@/api/client';
import * as context from '@/st/context';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '@/memory/engine';
import { batchState, currentSummaryPromise, REBUILD_RUN_KEY } from '@/memory/engine';
import * as store from '@/memory/store';
import { memory, recomputeDerived } from '@/memory/store';
import { createEmptyMemory, type LeafExtra } from '@/memory/types';
import * as pageCtx from './pageCtx';
import * as spectrum from './spectrum';
import * as view from './view';

// 摘要页的全部重新摘要界面：入口、确认框、未完成提示和进度。挂载真实 SFC（内存宿主，无浏览器）；
// 模型回复为预设内容，只验证界面显示和流程。
const empty = { default: defineComponent({ render: () => null }) };
const ModalShell = defineComponent({
  props: { open: Boolean, title: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.open ? h('div', { class: 'modal-stub' }, [h('h2', props.title), slots.default?.(), h('footer', slots.footer?.())]) : null);
  },
});
const ConfirmDialog = defineComponent({
  props: { open: Boolean, title: String, confirmText: String },
  emits: ['update:open', 'confirm'],
  setup(props, { slots, emit }) {
    return () => (props.open ? h('div', { class: 'confirm-stub', onConfirm: () => emit('confirm') }, slots.default?.()) : null);
  },
});
const dependencies: Record<string, unknown> = {
  // 起始楼层输入框的 v-model 指令只管 DOM 同步，这里直接调用它的更新回调
  vue: { ...Vue, vModelText: {} },
  '@/memory/engine': engine, '@/memory/store': store, '@/st/context': context, '@/st/toast': notices,
  './pageCtx': pageCtx, './spectrum': spectrum, './view': view,
  '@/components/Icon.vue': empty, './FloorSpectrum.vue': empty, './SummaryPager.vue': empty,
  '@/components/ModalShell.vue': { default: ModalShell }, '@/components/ConfirmDialog.vue': { default: ConfirmDialog },
};
// Node 模式的 Vite 默认编译 SSR；这里直接编译客户端 SFC，避免改变项目测试配置。
function compile(file: string): Component {
  const { descriptor } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: file, inlineTemplate: true });
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } });
  const compiled: { default?: Component } = {};
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in dependencies)) throw new Error(`未模拟的组件依赖：${name}`);
    return dependencies[name];
  }, compiled);
  return compiled.default!;
}
const Overview = compile('./SummaryOverview.vue');
const Notice = compile('./RebuildNotice.vue');
const Pending = compile('./PendingFloors.vue');
const Dialog = compile('./RebuildDialog.vue');

type HostNode = { type: string; text: string; props: Record<string, any>; parent: HostNode | null; children: HostNode[] };
const node = (type: string, text = ''): HostNode => ({ type, text, props: {}, parent: null, children: [] });
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
  patchProp(target, key, _previous, value) { target.props[key] = value; },
  insertStaticContent(content, parent, anchor) {
    const child = node('#static', content);
    insert(child, parent, anchor);
    return [child, child];
  },
});

let app: App | undefined;
let root: HostNode;
/** 按摘要页的顺序挂载：概览、未完成提示、进度与未摘要楼层、确认框。 */
function mountPage() {
  root = node('root');
  app = renderer.createApp(defineComponent({
    setup() {
      provide(pageCtx.SUMMARY_PAGE, pageCtx.createSummaryPage());
      return () => h('div', [h(Overview), h(Notice), h(Pending), h(Dialog)]);
    },
  }));
  app.mount(root);
}
const all = (target: HostNode): HostNode[] => [target, ...target.children.flatMap(all)];
const textOf = (target: HostNode): string => (target.type === '#comment' ? '' : target.text + target.children.map(textOf).join(''));
const byClass = (name: string) => all(root).find(n => String(n.props.class ?? '').split(' ').includes(name));
const entry = () => byClass('bbs-rebuild-btn')!;
const notice = () => byClass('bbs-rebuild-notice');
const dialog = () => byClass('modal-stub');
function button(scope: HostNode | undefined, label: string): HostNode {
  if (!scope) throw new Error('找不到按钮所在的区块：' + label);
  const found = all(scope).filter(n => n.type === 'button' && textOf(n).trim() === label);
  expect(found, label).toHaveLength(1);
  return found[0];
}
async function click(target: HostNode) {
  target.props.onClick();
  await nextTick();
}

const saved = JSON.stringify(settings.apiSettings);
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const ai = (text: string, old = true): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text,
  extra: old ? { bbs_leaf: { id: 'leaf-' + text, text: '旧摘要', delta: {}, createdAt: 1, swipe: 0, v: 1 } } : {} });
/** 用户和 AI 交替：AI 楼层号为 1、3、5……；前 summarized 层 AI 回复已有摘要 */
function story(count: number, summarized = count): STMessage[] {
  const chat: STMessage[] = [];
  for (let i = 1; i <= count; i++) chat.push(user('第' + i + '轮输入'), ai('第' + i + '轮正文', i <= summarized));
  return chat;
}
function useChat(chat: STMessage[]) {
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'rebuild-ui-test',
    chatMetadata: {}, saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const leafOf = (m: STMessage) => m.extra?.bbs_leaf as LeafExtra | undefined;
const reply = (summary: string) => JSON.stringify({ summary, stateChanges: [] });
const meta = (ctx: STContext) => ctx.chatMetadata as Record<string, unknown>;
/** 一次停在中途的全部重新摘要：范围 #1–#7，done 里的楼层已完成。 */
function unfinished(ctx: STContext, chat: STMessage[], done: number[]) {
  meta(ctx)[REBUILD_RUN_KEY] = { id: 'rb-t', startFloor: 1, endFloor: 7, startedAt: 1 };
  for (const f of done) leafOf(chat[f])!.rebuildRun = 'rb-t';
  recomputeDerived();
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, summaryMaxRetries: 0, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(reply('新摘要。'));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  app?.unmount();
  app = undefined;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('全部重新摘要的界面', () => {
  it('没有摘要时入口不可用;没有未完成的记录时直接打开新开一次的说明,首段写明层数、其中没有摘要的层数和请求次数', async () => {
    useChat(story(2, 0));
    mountPage(); await nextTick();
    expect(entry().props.disabled).toBe(true);
    expect(entry().props.title).toBe('还没有摘要');
    app!.unmount();

    useChat(story(4, 3));
    mountPage(); await nextTick();
    expect(entry().props.disabled).toBe(false);
    expect(textOf(entry()).trim()).toBe('全部重新摘要…');
    expect(notice()).toBeUndefined();
    await click(entry());
    const text = textOf(dialog()!);
    expect(text).toContain('按楼层顺序重新摘要 #1–#7 的 4 层 AI 回复（其中 1 层还没有摘要），每层请求一次 AI，共 4 次摘要请求；失败重试和合并总结另外产生请求');
    expect(text).not.toContain('上次的全部重新摘要');
    expect(text).toContain('开始前请先用酒馆的「管理聊天文件」导出聊天备份');
  });

  it('未完成提示显示已完成层数和停下的楼层;处理中不显示;运行开始后新增的楼层不计入,翻页的楼层不算完成', async () => {
    const chat = story(4);
    const ctx = useChat(chat);
    unfinished(ctx, chat, [1, 3]);
    mountPage(); await nextTick();
    expect(textOf(notice()!)).toContain('全部重新摘要未完成：已完成 2/4 层，停在 #5');
    expect(entry().props.title).toBe('上次的全部重新摘要停在 #5，可以继续或重新开始');

    batchState.running = true; await nextTick();
    expect(notice()).toBeUndefined();
    batchState.running = false; await nextTick();

    chat.push(user('第5轮输入'), ai('第5轮正文', false));
    recomputeDerived(); await nextTick();
    expect(textOf(notice()!)).toContain('已完成 2/4 层，停在 #5');

    chat[3].swipe_id = 1;
    recomputeDerived(); await nextTick();
    expect(textOf(notice()!)).toContain('已完成 1/4 层，停在 #3');
  });

  it('结束:确认框写明保留新结果和原摘要的层数;确认后只删记录,摘要不变,提示条消失', async () => {
    const chat = story(4);
    const ctx = useChat(chat);
    unfinished(ctx, chat, [1, 3]);
    mountPage(); await nextTick();
    await click(button(notice(), '结束'));
    const confirm = byClass('confirm-stub')!;
    expect(textOf(confirm)).toContain('已重新摘要的 2 层保留新结果，其余 2 层保留原摘要');
    confirm.props.onConfirm();
    await nextTick();
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
    expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
    expect(notice()).toBeUndefined();
    expect([1, 3, 5, 7].map(f => leafOf(chat[f])?.text)).toEqual(['旧摘要', '旧摘要', '旧摘要', '旧摘要']);
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
  });

  it('有未完成的记录时入口先问继续还是重新开始;继续只处理没有标记的楼层,进度计入之前完成的层数,完成后删除记录', async () => {
    const chat = story(4);
    const ctx = useChat(chat);
    unfinished(ctx, chat, [1, 3]);
    mountPage(); await nextTick();
    await click(entry());
    const text = textOf(dialog()!);
    expect(text).toContain('上次的全部重新摘要没有完成：已完成 2/4 层，停在 #5。');
    expect(text).toContain('继续：只处理还没有重新摘要的 2 层，每层请求一次 AI，共 2 次摘要请求；失败重试和合并总结另外产生请求。');

    const progress: string[] = [];
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      await nextTick();
      progress.push(textOf(byClass('bbs-batch-count')!) + (notice() ? '，仍显示未完成提示' : ''));
      return reply('继续。');
    });
    await click(button(dialog(), '继续'));
    await currentSummaryPromise();
    expect(progress).toEqual(['正在全部重新摘要 2/4', '正在全部重新摘要 3/4']);
    expect([1, 3, 5, 7].map(f => leafOf(chat[f])?.text)).toEqual(['旧摘要', '旧摘要', '继续。', '继续。']);
    expect([5, 7].map(f => leafOf(chat[f])?.rebuildRun)).toEqual(['rb-t', 'rb-t']);
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
    await nextTick();
    expect(notice()).toBeUndefined();
    expect(dialog()).toBeUndefined();
  });

  it('重新开始:放弃上次的进度;起始楼层不是 AI 回复时从之后的第一个开始,之后没有可处理的楼层时不能开始;之前的楼层保留原摘要', async () => {
    const chat = story(4);
    const ctx = useChat(chat);
    unfinished(ctx, chat, [1, 3]);
    mountPage(); await nextTick();
    await click(entry());
    await click(button(dialog(), '重新开始…'));
    let text = textOf(dialog()!);
    expect(text).toContain('按楼层顺序重新摘要 #1–#7 的 4 层 AI 回复，每层请求一次 AI，共 4 次摘要请求');
    expect(text).toContain('开始后放弃上次未完成的进度（已完成 2/4 层）。');

    const input = all(dialog()!).find(n => n.type === 'input')!;
    input.props['onUpdate:modelValue'](9);
    await nextTick();
    text = textOf(dialog()!);
    expect(text).toContain('#9 及之后没有可以重新摘要的楼层。');
    expect(button(dialog(), '开始全部重新摘要').props.disabled).toBe(true);

    input.props['onUpdate:modelValue'](4);
    await nextTick();
    text = textOf(dialog()!);
    expect(text).toContain('#4 不是可以重新摘要的 AI 回复，从之后的 #5 开始。');
    expect(text).toContain('按楼层顺序重新摘要 #5–#7 的 2 层 AI 回复，每层请求一次 AI，共 2 次摘要请求');

    let started: Record<string, unknown> | undefined;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      started ??= { ...(meta(ctx)[REBUILD_RUN_KEY] as Record<string, unknown>) };
      return reply('重新开始。');
    });
    await click(button(dialog(), '开始全部重新摘要'));
    await currentSummaryPromise();
    expect(started).toMatchObject({ startFloor: 5, endFloor: 7 });
    expect(started?.id).not.toBe('rb-t');
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect([1, 3, 5, 7].map(f => leafOf(chat[f])?.text)).toEqual(['旧摘要', '旧摘要', '重新开始。', '重新开始。']);
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
  });

  it('范围内都已完成、记录还在时显示「全部重新摘要已完成」,点「知道了」删除记录', async () => {
    const chat = story(4);
    const ctx = useChat(chat);
    unfinished(ctx, chat, [1, 3, 5, 7]);
    mountPage(); await nextTick();
    expect(textOf(notice()!)).toContain('全部重新摘要已完成：4/4 层');
    await click(button(notice(), '知道了'));
    expect(meta(ctx)[REBUILD_RUN_KEY]).toBeUndefined();
    expect(notice()).toBeUndefined();
  });
});
