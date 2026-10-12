import { describe, expect, it } from 'vitest';
import { DELTA_OP_LABEL, deltaTagGroups } from './deltaTags';
import type { StoredDelta } from './types';

// 楼层面板和重新摘要对比弹窗共用这份标签；这里只验证分组、说法和定位键，不涉及界面。
describe('状态变动的标签', () => {
  it('按主角、物品、角色、场景、悬念簿、变量分组，没有变动的组为空', () => {
    const delta: StoredDelta = {
      items: { add: [{ name: '地图', qty: 1, desc: '旧街地图' }], remove: ['火把'] },
      npcs: { update: [{ name: '小A', location: '厨房', follow: false }] },
      plans: { add: [{ kind: 'suspense', content: '信是谁寄的' }] },
    };
    const groups = deltaTagGroups(delta, 3);
    expect(groups.map(g => g.title)).toEqual(['主角', '物品', '角色', '场景', '悬念簿', '变量']);
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
});
