import { describe, expect, it } from 'vitest';
import type { STMessage } from '@/st/context';
import { deriveMemory, finalizeDelta } from './apply';
import * as p from './prompts';
import { parseSummaryResponse } from './summaryResponse';
import type { StoredDelta } from './types';

// 物品随身/存放(carried/location):模型的回复经过解析和清洗,再按楼层重放成物品清单。
let seq = 0;
function leafMsg(delta: StoredDelta): STMessage {
  const id = 'placement-' + ++seq;
  return { name: '角色', is_user: false, is_system: false, mes: '正文。', swipe_id: 0,
    extra: { bbs_leaf: { id, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } } };
}
/** 模型的一楼回复(只含物品),解析清洗后存成叶子 */
const reply = (items: object) => leafMsg(finalizeDelta(parseSummaryResponse(JSON.stringify({ summary: '物品变化。', items }), {
  builtin: true, finalize: d => finalizeDelta(d, []),
}), []));
const items = (...floors: object[]) => deriveMemory(floors.map(reply)).items.map(i => ({ name: i.name, qty: i.qty, carried: i.carried, location: i.location }));

describe('物品随身与存放', () => {
  it('内置提示词要求新物品写明 carried，按此刻在不在身上判断，不一律写随身', () => {
    expect(p.RULE_ITEMS).toContain('新物品(【现有物品】里没有的)add 必须写 carried');
    expect(p.RULE_ITEMS).toContain('不一律写随身');
    expect(p.RULE_ITEMS).toContain('填获得时所在的地点');
    expect(p.RULE_ITEMS).toContain('同名旧物再获只加数量,省略 carried/location');
    expect(p.RULE_ITEMS).toContain('回到住处后放下');
    expect(p.RULE_ITEMS).not.toContain('默认随身:');
    expect(p.SUMMARY_PROMPT).toContain('"carried": 此刻是否带在身上true/false(新物品必填;同名旧物再获省略)');
    expect(p.THINKING_CHECKLIST).toContain('新物品按此刻在不在身上写 carried');
  });

  it('新物品：写了存放或只写地点的记为存放，写随身的不留地点，不写的照旧算随身', () => {
    expect(items({ add: [
      { name: '吉他', qty: 1, carried: false, location: '家中卧室' },
      { name: '旧箱子', qty: 1, location: '地下室' },
      { name: '钥匙', qty: 1, carried: true, location: '城西客栈' },
      { name: '信', qty: 1 },
    ] })).toEqual([
      { name: '吉他', qty: 1, carried: false, location: '家中卧室' },
      { name: '旧箱子', qty: 1, carried: false, location: '地下室' },
      { name: '钥匙', qty: 1, carried: true, location: undefined },
      { name: '信', qty: 1, carried: undefined, location: undefined },
    ]);
  });

  it('明确随身过的物品，之后只写地点也算放在那里（以前仍显示随身）', () => {
    expect(items(
      { add: [{ name: '相机', qty: 1, carried: true }] },
      { update: [{ name: '相机', location: '家中书房' }] },
    )).toEqual([{ name: '相机', qty: 1, carried: false, location: '家中书房' }]);
  });

  it('取回随身清掉地点；只写 carried:false 时保留原来的地点', () => {
    expect(items(
      { add: [{ name: '相机', qty: 1, carried: false, location: '展馆柜台' }] },
      { update: [{ name: '相机', carried: true }] },
      { update: [{ name: '相机', carried: false }] },
    )).toEqual([{ name: '相机', qty: 1, carried: false, location: undefined }]);
    expect(items(
      { add: [{ name: '相机', qty: 1, carried: false, location: '展馆柜台' }] },
      { update: [{ name: '相机', carried: false }] },
    )).toEqual([{ name: '相机', qty: 1, carried: false, location: '展馆柜台' }]);
  });

  it('地点写成「随身」「身上」之类的当作随身，不当成存放地', () => {
    expect(items(
      { add: [{ name: '护身符', qty: 1, location: '身上' }, { name: '地图', qty: 1, carried: false, location: '书房' }] },
      { update: [{ name: '地图', location: '随身' }] },
    )).toEqual([
      { name: '护身符', qty: 1, carried: true, location: undefined },
      { name: '地图', qty: 1, carried: true, location: undefined },
    ]);
  });

  it('同名旧物再获不写位置时，数量照加，位置照旧', () => {
    expect(items(
      { add: [{ name: '金币', qty: 50, carried: false, location: '家中' }] },
      { add: [{ name: '金币', qty: 3 }] },
    )).toEqual([{ name: '金币', qty: 53, carried: false, location: '家中' }]);
  });
});
