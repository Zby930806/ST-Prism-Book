import { describe, expect, it } from 'vitest';
import { finalizeDelta, deriveMemory, findCurrentSceneId, classifyNpcPresence, itemReachableAtScene } from './apply';
import { parseSummaryResponse } from './summaryResponse';
import type { STMessage } from '@/st/context';

function fixture(pathValue: string[] | undefined) {
  const chat = [{ name: '记录', is_user: false, is_system: false, mes: '种子', extra: { bbs_leaf: {
    id: 'seed', text: '', createdAt: 1, v: 1, seed: true, delta: {
      location: '档案馆', locationPath: ['档案馆'], scenes: { add: [{ path: ['档案馆'], desc: '设有文献阅览室。' }] },
      npcs: { add: [{ name: '管理员', location: '档案馆' }] },
    } } } }, { name: '记录', is_user: false, is_system: false, mes: '在途', extra: { bbs_leaf: {
    id: 'next', text: '', createdAt: 2, v: 1, delta: { location: '前往档案馆途中', ...(pathValue === undefined ? {} : { locationPath: pathValue }) },
  } } }] as STMessage[];
  return deriveMemory(JSON.parse(JSON.stringify(chat)));
}
describe('显式空定位路径跨边界合同', () => {
  it('正式解析和固化保留空路径及状态清单', () => {
    const parsed = parseSummaryResponse(JSON.stringify({ summary: '在途中。', locationPath: [], stateChanges: ['locationPath'] }), {
      requireStateChanges: true, finalize: d => finalizeDelta(d, []),
    });
    expect(JSON.parse(JSON.stringify(finalizeDelta(parsed, [])))).toEqual({ locationPath: [] });
  });
  it('重放保留显式无锚点，目的地不能当当前位置', () => {
    const m = fixture([]); expect(m.state.locationPath).toEqual([]);
    expect(findCurrentSceneId(m.scenes, m.state.location, m.state.locationPath)).toBe('');
    expect(classifyNpcPresence({ ...m.npcs[0], locationStale: false }, m.scenes, m.state.location, [])).toBe('unknown');
    expect(itemReachableAtScene(m.scenes, '档案馆', null, m.state.location, undefined, [])).toBe(false);
  });
  it('自由地点完全相同仍可确认同处，但不能据此锚定树节点', () => {
    const m = fixture([]); const here = '未命名的岔道';
    expect(classifyNpcPresence({ ...m.npcs[0], location: here, locationStale: false }, m.scenes, here, [])).toBe('present');
    expect(itemReachableAtScene(m.scenes, here, null, here, undefined, [])).toBe(true);
    expect(findCurrentSceneId(m.scenes, '档案馆', [])).toBe('');
  });
  it('历史缺省路径继续兼容；非法非数组不变成显式空路径', () => {
    const m = fixture(undefined); expect(m.state.locationPath).toBeUndefined();
    expect(findCurrentSceneId(m.scenes, '档案馆阅览室')).toBe(m.scenes[0].id);
    for (const bad of [null, '档案馆', 9]) expect(finalizeDelta({ locationPath: bad } as never, []).locationPath).toBeUndefined();
  });
});
