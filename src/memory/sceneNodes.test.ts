import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { deriveMemory, editSceneDesc, finalizeDelta, reparentScene, upsertScene } from './apply';
import { parseSummaryResponse } from './summaryResponse';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type StoredDelta } from './types';

// 地点「建点宽、描述严」:到过的有名地点不写描述也建节点;描述只收稳定特征,可以清除。只验证解析、存储与重放,不涉及模型。
const saved = JSON.stringify(settings.apiSettings);
let seq = 0;
function leafMsg(delta: StoredDelta = {}): STMessage {
  const id = 'scene-' + ++seq;
  return { name: '角色', is_user: false, is_system: false, mes: '正文。', swipe_id: 0,
    extra: { bbs_leaf: { id, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } } };
}
const leafOf = (m: STMessage) => m.extra!.bbs_leaf as LeafExtra;
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '主角', name2: '角色', getCurrentChatId: () => 'scene-nodes',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const parse = (scenes: unknown) => parseSummaryResponse(JSON.stringify({ summary: '到达新地点。', scenes }), {
  builtin: true, finalize: d => finalizeDelta(d, []),
});
const descs = () => memory.scenes.map(s => [s.path.join('/'), s.desc ?? null]);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('摘要写入的地点', () => {
  it('新增地点不带描述也建节点,中间层级自动补建;带描述的照常保存', () => {
    const stored = finalizeDelta(parse({ add: [{ path: ['王都', '城西区', '望月客栈'] }, { path: ['王都', '码头'], desc: '停靠货船的石砌码头。' }] }), []);
    expect(stored.scenes?.add).toEqual([{ path: ['王都', '城西区', '望月客栈'] }, { path: ['王都', '码头'], desc: '停靠货船的石砌码头。' }]);
    useChat([leafMsg(stored)]);
    expect(descs()).toEqual([['王都', null], ['王都/城西区', null], ['王都/城西区/望月客栈', null], ['王都/码头', '停靠货船的石砌码头。']]);
  });

  it('不带描述的新增不会清掉已有描述;更新给空字符串才清除,节点保留', () => {
    const chat = [leafMsg({ scenes: { add: [{ path: ['望月客栈'], desc: '城西的两层木楼客栈。' }] } }),
      leafMsg(finalizeDelta(parse({ add: [{ path: ['望月客栈'] }] }), []))];
    useChat(chat);
    expect(descs()).toEqual([['望月客栈', '城西的两层木楼客栈。']]);
    chat.push(leafMsg(finalizeDelta(parse({ update: [{ path: ['望月客栈'], desc: '' }] }), [])));
    recomputeDerived();
    expect(descs()).toEqual([['望月客栈', null]]);
  });

  it('更新不带描述无事可做,前几次尝试附原因重试', () => {
    expect(() => parse({ update: [{ path: ['望月客栈'] }] })).toThrow('desc 必须是字符串');
  });

  it('旧聊天里带描述的地点照常重放', () => {
    const st = deriveMemory([leafMsg({ scenes: { add: [{ path: ['展馆'], desc: '陈列地方文献。' }] } })]);
    expect(st.scenes.map(s => [s.name, s.desc])).toEqual([['展馆', '陈列地方文献。']]);
  });
});

describe('场景页的手动修改', () => {
  it('添加地点可以不写描述', () => {
    const chat = [leafMsg()];
    useChat(chat);
    expect(upsertScene(['城南', '广场'], '')).toBe(true);
    expect(leafOf(chat[0]).manualOps?.scenes?.ops).toEqual([{ op: 'add', path: ['城南', '广场'] }]);
    expect(descs()).toEqual([['城南', null], ['城南/广场', null]]);
  });

  it('编辑时删空描述后保存即清除描述,地点保留', () => {
    const chat = [leafMsg({ scenes: { add: [{ path: ['望月客栈'], desc: '今早挤满送菜的人。' }] } })];
    useChat(chat);
    expect(editSceneDesc(['望月客栈'], '   ')).toBe(true);
    expect(descs()).toEqual([['望月客栈', null]]);
    expect(editSceneDesc(['望月客栈'], '城西的两层木楼客栈。')).toBe(true);
    expect(descs()).toEqual([['望月客栈', '城西的两层木楼客栈。']]);
  });

  it('改名或换上级时删空描述:移动后清除原描述;写了新描述就用新描述', () => {
    const chat = [leafMsg({ scenes: { add: [{ path: ['城西区'], desc: '商铺密集的城区。' }, { path: ['望月客栈'], desc: '旧描述。' }] } })];
    useChat(chat);
    expect(reparentScene(['望月客栈'], ['城西区', '望月客栈'], { 望月客栈: '' })).toBe(true);
    expect(descs()).toEqual([['城西区', '商铺密集的城区。'], ['城西区/望月客栈', null]]);
    expect(reparentScene(['城西区', '望月客栈'], ['城西区', '望月楼'], { 望月楼: '改名后的客栈。' })).toBe(true);
    expect(descs()).toEqual([['城西区', '商铺密集的城区。'], ['城西区/望月楼', '改名后的客栈。']]);
  });
});
