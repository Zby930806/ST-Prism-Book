import { describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { DELTA_OP_LABEL, deltaTagGroups } from './deltaTags';
import type { LeafExtra, StoredDelta } from './types';

// 楼层面板和重新摘要对比弹窗共用这份标签；这里只验证分组、说法和定位键，不涉及界面。
describe('状态变动的标签', () => {
  it('按主角、局势、物品、角色、生活档案、场景、悬念簿、信息差、变量分组，没有变动的组为空', () => {
    const delta: StoredDelta = {
      items: { add: [{ name: '地图', qty: 1, desc: '旧街地图' }], remove: ['火把'] },
      npcs: { update: [{ name: '小A', location: '厨房', follow: false }] },
      plans: { add: [{ kind: 'suspense', content: '信是谁寄的' }] },
    };
    const groups = deltaTagGroups(delta, 3);
    expect(groups.map(g => g.title)).toEqual(['主角', '局势', '物品', '角色', '生活档案', '场景', '悬念簿', '信息差', '变量']);
    const items = groups.find(g => g.title === '物品')!.tags;
    expect(items.map(t => [t.key, DELTA_OP_LABEL[t.op], t.text, t.sub])).toEqual([
      ['item:add:0', '新增', '地图 ×1', '旧街地图'],
      ['item:remove:0', '移除', '火把', undefined],
    ]);
    expect(groups.find(g => g.title === '角色')!.tags[0]).toMatchObject({ text: '小A', sub: '位置:厨房', op: 'update' });
    expect(groups.find(g => g.title === '悬念簿')!.tags[0]).toMatchObject({ text: '信是谁寄的', sub: '悬念', op: 'add' });
    expect(groups.find(g => g.title === '主角')!.tags).toEqual([]);
  });
  it('空 delta 不出标签', () => {
    expect(deltaTagGroups(null, 0).every(g => g.tags.length === 0)).toBe(true);
  });
  it('生活档案的新增、修改、沉降、删除和局势卡的变化都列出，只读、可删除', () => {
    const first = { name: '角色', is_user: false, is_system: false, mes: '一',
      extra: { bbs_leaf: { id: 'leaf-a', text: '摘要', delta: { lifeDetails: { add: [{ subject: 'user', text: '只喝温水' }] } }, createdAt: 1, swipe: 0, v: 1 } as LeafExtra } } as STMessage;
    vi.spyOn(context, 'getContext').mockReturnValue({ chat: [first] } as unknown as STContext);
    const groups = deltaTagGroups({
      lifeDetails: { add: [{ subject: '小A', text: '怕黑', topics: ['习惯'] }], update: [{ id: 'detail:leaf-a#0', tier: 'pinned' }], archive: ['detail:leaf-a#0'], remove: ['detail:missing#3'] },
      sceneFocus: { situation: '雨夜对峙', participants: ['小A', '小B'], tension: '互不信任' },
    }, 1);
    const life = groups.find(g => g.title === '生活档案')!.tags;
    expect(life.map(t => [t.key, DELTA_OP_LABEL[t.op], t.text, t.sub, t.editable])).toEqual([
      ['life:add:0', '新增', '怕黑', '小A', false],
      ['life:update:0', '更新', '修改:只喝温水', '置顶', false],
      ['life:archive:0', '沉降', '沉降:只喝温水', '只在出现关键词时发送', false],
      ['life:remove:0', '移除', '删除一项', undefined, false],
    ]);
    expect(groups.find(g => g.title === '局势')!.tags).toEqual([
      { key: 'focus:update:0', op: 'update', bucket: 'update', idx: 0, text: '雨夜对峙', sub: '在场:小A、小B · 张力:互不信任', editable: false },
    ]);
    expect(deltaTagGroups({ sceneFocus: null }, 0).find(g => g.title === '局势')!.tags[0]).toMatchObject({ text: '清空局势卡', op: 'remove' });
    vi.restoreAllMocks();
  });
});
