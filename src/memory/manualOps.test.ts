import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import {
  addLifeDetail, appendEnrichmentToLatestLeaf, appendOpToLatestLeaf, deriveAfterDelta, deriveMemory, editItem, editNpc, editPlan, finalizeDelta,
  MANUAL_ADD_BASE, MIGRATED_ADD_BASE, planContentById, relocateManualOps, removeLifeDetail, setProtagonist, upsertNpc,
} from './apply';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type LeafExtra, type StoredDelta } from './types';

// 页面上的手动修改单独存在叶子的 manualOps 上;迁移状态存在 migratedDelta 上。只验证存储与重放,不涉及模型。
const saved = JSON.stringify(settings.apiSettings);
let seq = 0;
function leafMsg(delta: StoredDelta = {}, extra: Partial<LeafExtra> = {}): STMessage {
  const id = 'manual-' + ++seq;
  return { name: '角色', is_user: false, is_system: false, mes: '正文。', swipe_id: 0,
    extra: { bbs_leaf: { id, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1, ...extra } } };
}
const leafOf = (m: STMessage) => m.extra!.bbs_leaf as LeafExtra;
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '主角', name2: '角色', getCurrentChatId: () => 'manual-ops',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
/** 模拟重抽:新页沿用旧页 extra 的副本(叶子页码仍是旧页),旧页存进 swipe_info。 */
function reroll(m: STMessage): void {
  const original = JSON.parse(JSON.stringify(m.extra));
  (m as unknown as { swipe_info: unknown[] }).swipe_info = [{ extra: original }, { extra: JSON.parse(JSON.stringify(original)) }];
  m.swipe_id = 1;
  m.extra = JSON.parse(JSON.stringify(original));
}
/** 模拟翻回某一页:从 swipe_info 恢复该页的 extra。 */
function showPage(m: STMessage, page: number): void {
  const pages = (m as unknown as { swipe_info: Array<{ extra: STMessage['extra'] }> }).swipe_info;
  pages[m.swipe_id ?? 0] = { extra: JSON.parse(JSON.stringify(m.extra)) };
  m.swipe_id = page;
  m.extra = JSON.parse(JSON.stringify(pages[page].extra));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('手动修改单独保存', () => {
  it('写进 manualOps 而不是 delta,重放排在模型结果之后;没有操作时返回 false 且不留空字段', () => {
    const chat = [leafMsg({ npcs: { add: [{ name: '洛伊', outfit: '制服' }] } })];
    useChat(chat);
    expect(appendOpToLatestLeaf({})).toBe(false);
    expect(appendOpToLatestLeaf({ items: {} })).toBe(false);
    expect(leafOf(chat[0]).manualOps).toBeUndefined();
    expect(editNpc('洛伊', { outfit: '便服' })).toBe(true);
    expect(leafOf(chat[0]).delta.npcs?.update).toBeUndefined();
    expect(leafOf(chat[0]).manualOps?.npcs?.update?.[0]).toMatchObject({ name: '洛伊', outfit: '便服' });
    expect(memory.npcs[0].outfit).toBe('便服');
    // 重新摘要换掉模型结果、沿用手动修改:手动修改仍然生效
    leafOf(chat[0]).delta = { npcs: { add: [{ name: '洛伊', outfit: '雨衣' }] } };
    recomputeDerived();
    expect(memory.npcs[0].outfit).toBe('便服');
  });

  it('物品沿用原来的跨桶互斥:同一叶子里删了再加、加了再删都按最后一次操作', () => {
    const chat = [leafMsg({ items: { add: [{ name: '罗盘', qty: 1 }] } })];
    useChat(chat);
    expect(editItem('罗盘', { name: '旧罗盘' })).toBe(true);
    expect(memory.items.map(i => i.name)).toEqual(['旧罗盘']);
    expect(editItem('旧罗盘', { name: '罗盘', qty: 1 })).toBe(true);
    expect(memory.items.map(i => [i.name, i.qty])).toEqual([['罗盘', 1]]);
    expect(leafOf(chat[0]).manualOps?.items?.remove).toEqual(['旧罗盘']);
    expect(appendOpToLatestLeaf({ items: { remove: ['罗盘'] } })).toBe(true);
    expect(memory.items).toHaveLength(0);
  });

  it('手动新增的计划、生活档案带显式 id,之后的结案、删除与重加都对得上', () => {
    const chat = [leafMsg()];
    useChat(chat);
    const leafId = leafOf(chat[0]).id;
    expect(appendOpToLatestLeaf({ plans: { add: [{ kind: 'plan', content: '明早去码头。' }] } })).toBe(true);
    expect(memory.plans[0].id).toBe(`plan:${leafId}#${MANUAL_ADD_BASE}`);
    expect(appendOpToLatestLeaf({ plans: { add: [{ kind: 'suspense', content: '信是谁写的。' }] } })).toBe(true);
    expect(memory.plans[1].id).toBe(`plan:${leafId}#${MANUAL_ADD_BASE + 1}`);
    expect(appendOpToLatestLeaf({ plans: { resolve: [{ id: memory.plans[0].id, outcome: 'done', reason: '已到码头' }] } })).toBe(true);
    expect(memory.plans[0]).toMatchObject({ status: 'resolved', outcome: 'done' });
    expect(planContentById(`plan:${leafId}#${MANUAL_ADD_BASE}`)).toBe('明早去码头。');
    expect(addLifeDetail({ subject: 'user', text: '喝茶不加糖' })).toBe(true);
    const detailId = memory.lifeDetails[0].id;
    expect(detailId).toBe(`detail:${leafId}#${MANUAL_ADD_BASE}`);
    expect(removeLifeDetail(detailId)).toBe(true);
    expect(memory.lifeDetails).toHaveLength(0);
    expect(addLifeDetail({ subject: 'user', text: '喝茶不加糖' })).toBe(true);
    expect(memory.lifeDetails.map(d => d.id)).toEqual([detailId]);
    expect(leafOf(chat[0]).manualOps?.lifeDetails?.add).toHaveLength(1);
  });

  it('编辑未了结计划的内容和期限作为手动修改保存,重新摘要来源楼层后仍然生效;已了结的改在原条目上', () => {
    const source = leafMsg({ plans: { add: [{ kind: 'plan', content: '明早去码头。', targetTime: '明早', createdTime: '周一' }] } });
    const chat = [source, leafMsg()];
    useChat(chat);
    const id = memory.plans[0].id;
    expect(editPlan(id, { content: '午后去码头。', targetTime: '午后', createdTime: '周二' })).toBe(true);
    expect(memory.plans[0]).toMatchObject({ id, content: '午后去码头。', targetTime: '午后', createdTime: '周二' });
    expect(leafOf(chat[1]).manualOps?.plans?.update?.[0]).toEqual({ id, content: '午后去码头。', targetTime: '午后' });
    expect(leafOf(source).delta.plans?.add?.[0]).toMatchObject({ content: '明早去码头。', createdTime: '周二' });
    // 没有改动时不追加
    expect(editPlan(id, { content: '午后去码头。', targetTime: '午后' })).toBe(true);
    expect(leafOf(chat[1]).manualOps?.plans?.update).toHaveLength(1);
    // 来源楼层重新摘要(换掉模型结果、同一个计划仍在):手动修改仍然生效
    leafOf(source).delta = { plans: { add: [{ kind: 'plan', content: '明早去码头,带上地图。', targetTime: '明早' }] } };
    recomputeDerived();
    expect(memory.plans[0]).toMatchObject({ content: '午后去码头。', targetTime: '午后' });
    // 已了结的计划改在原条目上
    expect(appendOpToLatestLeaf({ plans: { resolve: [{ id, outcome: 'done', reason: '已到码头' }] } })).toBe(true);
    expect(editPlan(id, { content: '午后到了码头。' })).toBe(true);
    expect(memory.plans[0]).toMatchObject({ status: 'resolved', content: '午后到了码头。' });
  });

  it('番外楼的叶子不接收手动修改', () => {
    const chat = [leafMsg(), leafMsg()];
    chat[1].extra!.bbs_omit = true;
    useChat(chat);
    expect(upsertNpc({ name: '梅芙' })).toBe(true);
    expect(leafOf(chat[0]).manualOps?.npcs?.add?.[0].name).toBe('梅芙');
    expect(leafOf(chat[1]).manualOps).toBeUndefined();
    expect(memory.npcs.map(n => n.name)).toEqual(['梅芙']);
  });

  it('角色页手动新增角色后又「从原文补全」:补档在同一叶子上也生效,已有角色手动清空的字段不被补回', () => {
    const chat = [leafMsg({ npcs: { add: [{ name: '洛伊', desc: '高个子' }] } })];
    useChat(chat);
    expect(upsertNpc({ name: '梅芙' })).toBe(true);
    expect(appendEnrichmentToLatestLeaf({ name: '梅芙', fields: { desc: '银灰短发', title: '药师' }, source: 'manual' })).toBe(true);
    expect(memory.npcs.find(n => n.name === '梅芙')).toMatchObject({ desc: '银灰短发', title: '药师' });
    // 已存在的角色:补档先于手动修改,手动清空的外貌不会被补档填回
    expect(appendEnrichmentToLatestLeaf({ name: '洛伊', fields: { personality: '沉稳' }, source: 'manual' })).toBe(true);
    expect(editNpc('洛伊', { desc: '' })).toBe(true);
    leafOf(chat[0]).enriched = [...(leafOf(chat[0]).enriched ?? []), { name: '洛伊', fields: { desc: '补档写的外貌' }, source: 'auto' }];
    recomputeDerived();
    expect(memory.npcs.find(n => n.name === '洛伊')).toMatchObject({ personality: '沉稳' });
    expect(memory.npcs.find(n => n.name === '洛伊')?.desc).toBeUndefined();
    // 投影(补档规划用)与重放同口径
    const after = deriveAfterDelta(deriveMemory(null), leafOf(chat[0]).delta, {
      time: '', enriched: leafOf(chat[0]).enriched, manualOps: leafOf(chat[0]).manualOps,
    });
    expect(after.npcs.find(n => n.name === '梅芙')).toMatchObject({ desc: '银灰短发', title: '药师' });
    expect(after.npcs.find(n => n.name === '洛伊')?.desc).toBeUndefined();
  });
});

describe('叶子失效时移走手动修改', () => {
  it('重抽后移到之前最近一条有效叶子,翻回原页也不重复施加;新增条目 id 不变', () => {
    const first = leafMsg({ items: { add: [{ name: '药剂', qty: 1 }] } });
    const last = leafMsg();
    const chat = [first, last];
    useChat(chat);
    expect(appendOpToLatestLeaf({ items: { add: [{ name: '药剂', qty: 2 }] }, plans: { add: [{ kind: 'plan', content: '天亮出发。' }] } })).toBe(true);
    const planId = memory.plans[0].id;
    expect(memory.items[0].qty).toBe(3);
    reroll(last);
    expect(relocateManualOps(chat)).toBe(true);
    recomputeDerived();
    expect(leafOf(first).manualOps?.items?.add?.[0]).toMatchObject({ name: '药剂', qty: 2 });
    expect(leafOf(last).manualOps).toBeUndefined();
    for (const page of (last as unknown as { swipe_info: Array<{ extra: STMessage['extra'] }> }).swipe_info) {
      expect((page.extra!.bbs_leaf as LeafExtra).manualOps).toBeUndefined();
    }
    expect(memory.items[0].qty).toBe(3);
    expect(memory.plans.map(p => p.id)).toEqual([planId]);
    // 再跑一次没有改动
    expect(relocateManualOps(chat)).toBe(false);
    // 翻回原页:原叶子重新有效,手动修改只在前一条叶子上施加一次
    showPage(last, 0);
    recomputeDerived();
    expect(memory.items[0].qty).toBe(3);
    expect(memory.plans.map(p => p.id)).toEqual([planId]);
    expect(appendOpToLatestLeaf({ plans: { add: [{ kind: 'plan', content: '带上地图。' }] } })).toBe(true);
    // 同一叶子 id 下的手动编号不与移走的条目撞号
    expect(new Set(memory.plans.map(p => p.id)).size).toBe(2);
  });

  it('翻到另一页已有的回复时,原页上的手动修改也移到前一条有效叶子', () => {
    const first = leafMsg();
    const last = leafMsg();
    const chat = [first, last];
    useChat(chat);
    reroll(last);
    // 新页摘要后有了自己的叶子
    last.extra = { bbs_leaf: { id: 'page-1-leaf', text: '另一版。', delta: {}, createdAt: 99, swipe: 1, v: 1 } };
    showPage(last, 0);
    recomputeDerived();
    expect(upsertNpc({ name: '梅芙' })).toBe(true);
    expect(leafOf(last).manualOps).toBeTruthy();
    showPage(last, 1);
    expect(relocateManualOps(chat)).toBe(true);
    recomputeDerived();
    expect(memory.npcs.map(n => n.name)).toEqual(['梅芙']);
    expect(leafOf(first).manualOps?.npcs?.add?.[0].name).toBe('梅芙');
  });

  it('只有清空操作(空字符串)的手动修改同样移走:清除主角伤情后重抽,伤情仍是清除的', () => {
    const first = leafMsg({ protagonist: { condition: '左臂受伤' } });
    const last = leafMsg();
    const chat = [first, last];
    useChat(chat);
    expect(memory.protagonist.condition).toBe('左臂受伤');
    expect(setProtagonist({ condition: '' })).toBe(true);
    expect(leafOf(last).manualOps).toEqual({ protagonist: { condition: '' } });
    expect(memory.protagonist.condition).toBeFalsy();
    reroll(last);
    recomputeDerived();
    // 原叶子失效:清除暂时不生效,移走后恢复
    expect(memory.protagonist.condition).toBe('左臂受伤');
    expect(relocateManualOps(chat)).toBe(true);
    recomputeDerived();
    expect(leafOf(first).manualOps).toEqual({ protagonist: { condition: '' } });
    expect(memory.protagonist.condition).toBeFalsy();
  });

  it('标为番外的楼同样移走;前面没有有效叶子时保留原处', () => {
    const only = leafMsg();
    const chat = [only];
    useChat(chat);
    expect(upsertNpc({ name: '梅芙' })).toBe(true);
    reroll(only);
    expect(relocateManualOps(chat)).toBe(false);
    expect(leafOf(only).manualOps).toBeTruthy();
    const first = leafMsg();
    const omitted = leafMsg({}, { manualOps: { npcs: { add: [{ name: '洛伊' }] } } });
    omitted.extra!.bbs_omit = true;
    const chat2 = [first, omitted];
    useChat(chat2);
    expect(memory.npcs).toHaveLength(0);
    expect(relocateManualOps(chat2)).toBe(true);
    recomputeDerived();
    expect(memory.npcs.map(n => n.name)).toEqual(['洛伊']);
  });

  it('重新生成前指定要被替换的那楼:仍有效的叶子上的手动修改也先移走,只移这一楼', () => {
    const first = leafMsg();
    const middle = leafMsg({}, { manualOps: { npcs: { add: [{ name: '洛伊' }] } } });
    const last = leafMsg();
    const chat = [first, middle, last];
    useChat(chat);
    expect(upsertNpc({ name: '梅芙' })).toBe(true);
    expect(leafOf(last).manualOps?.npcs?.add?.[0].name).toBe('梅芙');
    // 不指定时有效叶子不动
    expect(relocateManualOps(chat)).toBe(false);
    expect(relocateManualOps(chat, chat.length - 1)).toBe(true);
    expect(leafOf(last).manualOps).toBeUndefined();
    expect(leafOf(middle).manualOps?.npcs?.add?.map(n => n.name)).toEqual(['洛伊', '梅芙']);
    expect(leafOf(first).manualOps).toBeUndefined();
    // 这条回复被删掉后,两处手动修改都还在
    chat.pop();
    recomputeDerived();
    expect(memory.npcs.map(n => n.name).sort()).toEqual(['梅芙', '洛伊'].sort());
  });
});

describe('迁移状态与曾用名', () => {
  it('migratedDelta 在 delta 之后重放,计划 id 从迁移序号起算;换掉 delta 后迁移状态仍在', () => {
    const m = leafMsg({ items: { add: [{ name: '剑', qty: 1 }] }, plans: { add: [{ kind: 'plan', content: '模型记下的计划。' }] } }, {
      migratedDelta: { time: '庆历四年初秋', location: '城西客栈', items: { add: [{ name: '药', qty: 2 }] }, plans: { add: [{ kind: 'plan', content: '迁移来的计划。' }] } },
    });
    const chat = [m];
    useChat(chat);
    const leafId = leafOf(m).id;
    expect(memory.items.map(i => [i.name, i.qty])).toEqual([['剑', 1], ['药', 2]]);
    expect(memory.plans.map(p => p.id)).toEqual([`plan:${leafId}#0`, `plan:${leafId}#${MIGRATED_ADD_BASE}`]);
    expect(memory.state).toMatchObject({ time: '庆历四年初秋', location: '城西客栈' });
    leafOf(m).delta = { items: { add: [{ name: '盾', qty: 1 }] } };
    recomputeDerived();
    expect(memory.items.map(i => i.name)).toEqual(['盾', '药']);
    expect(planContentById(`plan:${leafId}#${MIGRATED_ADD_BASE}`)).toBe('迁移来的计划。');
    expect(editPlan(`plan:${leafId}#${MIGRATED_ADD_BASE}`, { content: '改过的迁移计划。' })).toBe(true);
    expect(memory.plans.find(p => p.id === `plan:${leafId}#${MIGRATED_ADD_BASE}`)?.content).toBe('改过的迁移计划。');
    expect(leafOf(m).migratedDelta?.plans?.add?.[0].content).toBe('迁移来的计划。');
  });

  it('deriveAfterDelta 按 delta → migratedDelta → enriched → manualOps 施加', () => {
    const before = deriveMemory(null);
    const after = deriveAfterDelta(before, { npcs: { add: [{ name: '洛伊', outfit: '制服' }] } }, {
      time: '', migratedDelta: { npcs: { update: [{ name: '洛伊', outfit: '旧衣' }] } },
      enriched: [{ name: '洛伊', fields: { desc: '银灰短发' } }],
      manualOps: { npcs: { update: [{ name: '洛伊', outfit: '便服' }] } },
    });
    expect(after.npcs[0]).toMatchObject({ outfit: '便服', desc: '银灰短发' });
  });

  it('内部写入的曾用名在重放时并入角色记录;模型输出的曾用名被剥离', () => {
    const seed = leafMsg({ npcs: { add: [{ name: '老周', title: '酒保', formerNames: ['酒保A', ' 老周 ', '酒保A'] }] } });
    const chat = [seed, leafMsg({ npcs: { update: [{ name: '老周', formerNames: ['周掌柜'] }] } })];
    expect(deriveMemory(chat).npcs[0].formerNames).toEqual(['酒保A', '周掌柜']);
    const fromModel = finalizeDelta({ npcs: { add: [{ name: '甲', formerNames: ['乙'] } as never] } }, []);
    expect(fromModel.npcs?.add?.[0]).not.toHaveProperty('formerNames');
  });
});
