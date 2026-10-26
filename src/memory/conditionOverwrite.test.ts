import { describe, expect, it } from 'vitest';
import type { STMessage } from '@/st/context';
import { deriveMemory, finalizeDelta } from './apply';
import * as p from './prompts';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import type { StoredDelta } from './types';

// 伤情(condition)整段覆盖:不再有片段补丁协议,旧叶子里存的本来就是完整的伤情文本,无需迁移。
let seq = 0;
function leafMsg(delta: StoredDelta): STMessage {
  const id = 'condition-' + ++seq;
  return { name: '角色', is_user: false, is_system: false, mes: '正文。', swipe_id: 0,
    extra: { bbs_leaf: { id, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } } };
}
const parse = (data: object, requireStateChanges = true) => parseSummaryResponse(JSON.stringify({ summary: '伤情变化。', ...data }), {
  requireStateChanges, finalize: d => finalizeDelta(d, []), npcRoster: ['小A'],
});

describe('伤情整段覆盖', () => {
  it('内置提示词写明整段覆盖,不再要求片段补丁;离场与时间跳跃不等于康复的规则保留', () => {
    for (const text of [p.SUMMARY_PROMPT, p.THINKING_CHECKLIST, p.RULE_HEALTH_STATE, p.RULE_PROTAGONIST, p.RULE_NPCS]) {
      expect(text).not.toContain('conditionPatch');
      expect(text).not.toContain('伤情局部更新协议');
    }
    expect(p.RULE_HEALTH_STATE).toContain('condition 整段覆盖');
    expect(p.RULE_HEALTH_STATE).toContain('全部恢复输出空字符串');
    expect(p.RULE_HEALTH_STATE).toContain('没有新证据就省略 condition,不要清空、宣告康复或猜测恶化');
    expect(p.RULE_HEALTH_STATE).toContain('本轮只新增休养估计时,不能挤掉尚无解除证据的活动限制');
    expect(p.SUMMARY_PROMPT.match(/【临时伤情与恢复证据】\(主角与 NPC 通用\)/g)).toHaveLength(1);
  });

  it('已有伤情可以直接整段改写,内置模板也不再拒绝', () => {
    const d = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', condition: '右腕仍有伤，自述还需养四五天' }] } });
    expect(d.npcs?.update?.[0].condition).toBe('右腕仍有伤，自述还需养四五天');
  });

  it('全部恢复输出空字符串,重放时清掉旧伤情;省略则保持', () => {
    const d = parse({ stateChanges: ['protagonist', 'npcs'], protagonist: { condition: '' }, npcs: { update: [{ name: '小A', condition: '' }] } });
    expect(d.protagonist?.condition).toBe('');
    const before = leafMsg({ protagonist: { condition: '脚踝扭伤' }, npcs: { add: [{ name: '小A', condition: '手腕受伤' }, { name: '小B', condition: '发烧' }] } });
    const mem = deriveMemory([before, leafMsg(finalizeDelta(d, []))]);
    expect(mem.protagonist.condition).toBeFalsy();
    expect(mem.npcs.find(n => n.name === '小A')?.condition).toBeUndefined();
    expect(mem.npcs.find(n => n.name === '小B')?.condition).toBe('发烧');
  });

  it.each([
    ['主角', { stateChanges: ['protagonist'], protagonist: { condition: '脚踝已消肿', conditionPatch: { add: [{ text: '还需休养', evidence: '无' }] } } }],
    ['角色 update', { stateChanges: ['npcs'], npcs: { update: [{ name: '小A', condition: '手腕已痊愈', conditionPatch: { replace: [{ id: 'c1', text: '' }] } }] } }],
  ])('%s照旧写法多给了 conditionPatch:去掉补丁,以 condition 为准,不让整楼失败', (_label, data) => {
    const d = parse(data);
    expect(JSON.stringify(d)).not.toContain('conditionPatch');
    expect(JSON.stringify(finalizeDelta(d, []))).not.toContain('conditionPatch');
    expect(d.protagonist?.condition ?? d.npcs?.update?.[0].condition).toMatch(/已消肿|已痊愈/);
  });

  it('补丁写在物品、分组等任何位置都直接去掉,不再报错', () => {
    for (const requireStateChanges of [true, false]) {
      const d = parse({ stateChanges: ['items'], items: { add: [{ name: '药', qty: 1, conditionPatch: { add: [] } }] }, conditionPatch: { add: [] } }, requireStateChanges);
      expect(JSON.stringify(d)).not.toContain('conditionPatch');
      expect(d.items?.add?.[0]).toMatchObject({ name: '药', qty: 1 });
    }
  });

  it('只给补丁、没有其他更新时,清单里声明的更新不存在,仍按清单不一致让模型重写', () => {
    expect(() => parse({ stateChanges: ['protagonist'], protagonist: { conditionPatch: { add: [{ text: '需休养', evidence: '无' }] } } }))
      .toThrow(SummaryResponseError);
  });
});
