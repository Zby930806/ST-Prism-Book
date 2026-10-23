import { describe, expect, it } from 'vitest';
import { parseSummaryResponse, SummaryResponseError, type DroppedEvidence } from './summaryResponse';
import { finalizeDelta } from './apply';

// 最后一次尝试的宽松解析:引文对不上的位置或伤情只去掉这几项,其余照常保存;不传回调时仍整份拒绝。
const content = '次晨林舟在厨房见到小A。小A说手腕还疼。';
const before = { protagonist: { condition: '左臂受伤' }, npcs: [{ name: '小A', condition: '手腕受伤，不能负重' }], content, strict: true };
function parse(body: Record<string, unknown>, lenient: boolean) {
  const dropped: DroppedEvidence[] = [];
  const d = parseSummaryResponse(JSON.stringify({ summary: '次晨重逢。', ...body }), {
    requireStateChanges: true, sourceContent: content, sourceTexts: [content], conditionContext: before,
    npcRoster: ['小A'], finalize: delta => finalizeDelta(delta, []),
    ...(lenient ? { onDroppedEvidence: (list: DroppedEvidence[]) => { dropped.push(...list); } } : {}),
  });
  return { d, dropped };
}

describe('最后一次尝试时只去掉对不上正文的位置或伤情', () => {
  it('位置引文对不上：去掉这次定位，同一角色的其他更新照常保存', () => {
    const body = { stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '庭院', locationEvidence: '小A在庭院散步。', outfit: '灰色外套' }] } };
    expect(() => parse(body, false)).toThrow(SummaryResponseError);
    const { d, dropped } = parse(body, true);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', outfit: '灰色外套' });
    expect(dropped).toEqual([{ kind: 'location', name: '小A' }]);
  });

  it('只剩名字的条目和空分组一并去掉，stateChanges 随之更正', () => {
    const { d, dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '庭院', locationEvidence: '小A在庭院散步。' }] } }, true);
    expect(d.npcs).toBeUndefined();
    expect((d as unknown as { stateChanges?: unknown }).stateChanges).toEqual([]);
    expect(dropped).toEqual([{ kind: 'location', name: '小A' }]);
  });

  it('伤情补丁引文对不上：去掉这项更新、原伤情不动；主角的同样处理', () => {
    const body = {
      stateChanges: ['protagonist', 'npcs'],
      protagonist: { conditionPatch: { replace: [{ id: 'c1', text: '', evidence: '林舟的左臂已经痊愈' }] } },
      npcs: { update: [{ name: '小A', conditionPatch: { add: [{ text: '还疼', evidence: '小A说手腕还疼' }] } }] },
    };
    expect(() => parse(body, false)).toThrow(SummaryResponseError);
    const { d, dropped } = parse(body, true);
    expect(d.protagonist).toBeUndefined();
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', condition: '手腕受伤，不能负重；还疼' });
    expect((d as unknown as { stateChanges?: unknown }).stateChanges).toEqual(['npcs']);
    expect(dropped).toEqual([{ kind: 'condition', name: 'protagonist' }]);
  });

  it('有伤情时直接覆盖 condition 也按对不上处理：保留原伤情', () => {
    const { d, dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', condition: '已痊愈', outfit: '灰色外套' }] } }, true);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', outfit: '灰色外套' });
    expect(dropped).toEqual([{ kind: 'condition', name: '小A' }]);
  });

  it('其他问题仍整份拒绝，也不报告去掉的内容', () => {
    let reported = false;
    expect(() => parseSummaryResponse(JSON.stringify({ summary: '收到钥匙。', stateChanges: ['items', 'npcs'], items: { add: [{ name: '钥匙' }] },
      npcs: { update: [{ name: '小A', location: '庭院', locationEvidence: '小A在庭院散步。' }] } }), {
      requireStateChanges: true, sourceContent: content, sourceTexts: [content], conditionContext: before, npcRoster: ['小A'],
      finalize: delta => finalizeDelta(delta, []), onDroppedEvidence: () => { reported = true; },
    })).toThrow(SummaryResponseError);
    expect(reported).toBe(false);
  });

  it('引文对得上时不去掉任何内容', () => {
    const { d, dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '厨房', locationEvidence: '次晨林舟在厨房见到小A。' }] } }, true);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', location: '厨房' });
    expect(dropped).toEqual([]);
  });
});
