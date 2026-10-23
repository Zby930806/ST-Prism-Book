import { describe, expect, it } from 'vitest';
import { describeDropped, parseSummaryResponse, SummaryResponseError, type DroppedEvidence } from './summaryResponse';
import { finalizeDelta } from './apply';
import type { MemLifeDetail } from './types';

// 最后一次尝试的宽松解析:不合格的更新只去掉这几项,其余照常保存;不传回调时仍整份拒绝。
const content = '次晨林舟在厨房见到小A。小A说手腕还疼。';
const before = { protagonist: { condition: '左臂受伤' }, npcs: [{ name: '小A', condition: '手腕受伤，不能负重' }], content, strict: true };
const openPlans = [{ id: 'plan:stable#0' }];
function parse(body: Record<string, unknown>, lenient: boolean, extra: { skipped?: DroppedEvidence[]; details?: MemLifeDetail[] } = {}) {
  const dropped: DroppedEvidence[] = [];
  const d = parseSummaryResponse(JSON.stringify({ summary: '次晨重逢。', ...body }), {
    requireStateChanges: true, sourceContent: content, sourceTexts: [content], conditionContext: before,
    npcRoster: ['小A'], finalize: delta => finalizeDelta(delta, openPlans, extra.details ?? []),
    refCounts: { plans: openPlans.length, lifeDetails: 0, secrets: 0 },
    ...(extra.skipped ? { onSkipped: (list: DroppedEvidence[]) => { extra.skipped!.push(...list); } } : {}),
    ...(lenient ? { onDroppedEvidence: (list: DroppedEvidence[]) => { dropped.push(...list); } } : {}),
  });
  return { d, dropped, stored: finalizeDelta(d, openPlans, extra.details ?? []) };
}
const stateChangesOf = (d: unknown) => (d as { stateChanges?: unknown }).stateChanges;

describe('最后一次尝试时只去掉对不上正文的位置或伤情', () => {
  it('位置引文对不上：去掉这次定位，同一角色的其他更新照常保存', () => {
    const body = { stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '庭院', locationEvidence: '小A在庭院散步。', outfit: '灰色外套' }] } };
    expect(() => parse(body, false)).toThrow(SummaryResponseError);
    const { d, dropped } = parse(body, true);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', outfit: '灰色外套' });
    expect(dropped).toEqual([{ kind: 'location', name: '小A', reason: 'mismatch' }]);
  });

  it('只剩名字的条目和空分组一并去掉，stateChanges 随之更正', () => {
    const { d, dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '庭院', locationEvidence: '小A在庭院散步。' }] } }, true);
    expect(d.npcs).toBeUndefined();
    expect(stateChangesOf(d)).toEqual([]);
    expect(dropped).toEqual([{ kind: 'location', name: '小A', reason: 'mismatch' }]);
  });

  it('有新地点却没给原话时按「缺原话」报告', () => {
    const { dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '庭院', outfit: '灰色外套' }] } }, true);
    expect(dropped).toEqual([{ kind: 'location', name: '小A', reason: 'missing' }]);
    expect(describeDropped(dropped[0]).why).toBe('没有给出正文原句');
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
    expect(stateChangesOf(d)).toEqual(['npcs']);
    expect(dropped).toEqual([{ kind: 'condition', name: 'protagonist', reason: 'mismatch' }]);
    expect(describeDropped(dropped[0], '林舟')).toEqual({ what: '林舟的伤情', why: '给出的原句与本楼正文对不上' });
  });

  it('伤情片段编号不存在时按「编号或写法不对」报告，不说成原句对不上', () => {
    const { dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', conditionPatch: { replace: [{ id: 'c9', text: '好转', evidence: '小A说手腕还疼' }] } }] } }, true);
    expect(dropped).toEqual([{ kind: 'condition', name: '小A', reason: 'invalid' }]);
    expect(describeDropped(dropped[0]).why).toBe('伤情片段的编号或写法不符合要求');
  });

  it('有伤情时直接覆盖 condition 也按写法不对处理：保留原伤情', () => {
    const { d, dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', condition: '已痊愈', outfit: '灰色外套' }] } }, true);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', outfit: '灰色外套' });
    expect(dropped).toEqual([{ kind: 'condition', name: '小A', reason: 'invalid' }]);
  });

  it('引文对得上时不去掉任何内容', () => {
    const { d, dropped } = parse({ stateChanges: ['npcs'], npcs: { update: [{ name: '小A', location: '厨房', locationEvidence: '次晨林舟在厨房见到小A。' }] } }, true);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', location: '厨房' });
    expect(dropped).toEqual([]);
  });
});

describe('最后一次尝试时其他不合格的更新也只去掉这一项', () => {
  it('没有有效数量的 items.add 去掉并报告，摘要和其他状态照常保存；数字写成字符串时按数字收下', () => {
    const body = { stateChanges: ['items', 'npcs'], items: { add: [{ name: '钥匙' }, { name: '铜币', qty: '3' }] },
      npcs: { update: [{ name: '小A', outfit: '灰色外套' }] } };
    expect(() => parse(body, false)).toThrow(/items\.add\[0\]「钥匙」缺少 qty/);
    const { d, dropped, stored } = parse(body, true);
    expect(stored.items?.add).toEqual([{ name: '铜币', qty: 3 }]);
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', outfit: '灰色外套' });
    expect(dropped).toEqual([{ kind: 'item', name: '钥匙', reason: 'missing', detail: '没有明确数量' }]);
  });

  it('stateChanges 以实际有效字段为准：漏写的补上，声明了却没有有效更新的写进提示', () => {
    const body = { stateChanges: ['items', 'plans'], npcs: { update: [{ name: '小A', outfit: '灰色外套' }] } };
    expect(() => parse(body, false)).toThrow(/清单是 \[items, plans\]，实际有效输出的是 \[npcs\]/);
    const { d, dropped } = parse(body, true);
    expect(stateChangesOf(d)).toEqual(['npcs']);
    expect(dropped.map(x => [x.kind, x.name, x.reason])).toEqual([['stateChanges', 'items', 'missing'], ['stateChanges', 'plans', 'missing']]);
    expect(describeDropped(dropped[0]).what).toBe('物品的更新');
  });

  it('缺 stateChanges 时最后一次按实际字段补上，前几次附原因重试', () => {
    const body = { location: '厨房' };
    expect(() => parse(body, false)).toThrow(/必须填写 stateChanges/);
    const { d, dropped } = parse(body, true);
    expect(stateChangesOf(d)).toEqual(['location']);
    expect(dropped).toEqual([]);
  });

  it('计划编号不存在的 update 去掉，错误写明可用范围', () => {
    const body = { stateChanges: ['plans'], plans: { update: [{ id: 'p5', content: '改期' }], add: [{ kind: 'plan', content: '新约定' }] } };
    expect(() => parse(body, false)).toThrow('plans.update[0]编号 p5 不存在（当前可用 p1–p1）');
    const { stored, dropped } = parse(body, true);
    expect(stored.plans).toEqual({ add: [{ kind: 'plan', content: '新约定' }] });
    expect(dropped).toEqual([{ kind: 'plan', name: 'p5', reason: 'invalid', detail: '编号 p5 不存在（当前可用 p1–p1）' }]);
  });

  it('targetTime 写成 null 时按撤销期限处理；写成数字等其他类型时前几次点名重试，最后一次去掉这条调整', () => {
    const revoke = parse({ stateChanges: ['plans'], plans: { update: [{ id: 'p1', content: '改期', targetTime: null }] } }, false);
    expect(revoke.stored.plans?.update?.[0]).toMatchObject({ content: '改期', targetTime: '' });
    const body = { stateChanges: ['plans'], plans: { update: [{ id: 'p1', content: '改期', targetTime: 3 }] } };
    expect(() => parse(body, false)).toThrow('targetTime 必须是字符串；撤销期限填空字符串');
    const { d, dropped } = parse(body, true);
    expect(d.plans).toBeUndefined();
    expect(stateChangesOf(d)).toEqual([]);
    expect(dropped.map(x => x.kind)).toEqual(['plan']);
  });

  it('同一计划既 update 又 resolve：去掉 update，保留 resolve', () => {
    const body = { stateChanges: ['plans'], plans: { update: [{ id: 'p1', content: '暂缓' }], resolve: [{ id: 'p1', outcome: 'cancelled', reason: '撤销' }] } };
    expect(() => parse(body, false)).toThrow(/p1 同时 update 和 resolve/);
    const { stored, dropped } = parse(body, true);
    expect(stored.plans).toEqual({ resolve: [{ id: 'plan:stable#0', outcome: 'cancelled', reason: '撤销' }] });
    expect(dropped).toEqual([{ kind: 'plan', name: 'p1', reason: 'invalid', detail: '同一楼既调整又了结，只保留了结' }]);
  });

  it('状态包进 delta 时：根层没有同名字段才展开，有同名字段的只保留根层并报告', () => {
    const body = { stateChanges: ['location', 'npcs'], location: '厨房', delta: { location: '庭院', npcs: { update: [{ name: '小A', outfit: '灰色外套' }] } } };
    expect(() => parse(body, false)).toThrow(/不要包进 delta 或 updates/);
    const { d, dropped } = parse(body, true);
    expect(d.location).toBe('厨房');
    expect(d.npcs?.update?.[0]).toEqual({ name: '小A', outfit: '灰色外套' });
    expect(dropped).toEqual([{ kind: 'format', name: 'location', reason: 'invalid', detail: '根层和 delta 里各写了一份，只保留根层的' }]);
    expect(describeDropped(dropped[0])).toEqual({ what: '地点的更新', why: '根层和 delta 里各写了一份，只保留根层的' });
  });

  it('放错层级的伤情补丁去掉，其余照常；提示写明写在了哪里，不说成那一项的伤情', () => {
    const body = { stateChanges: ['items'], items: { add: [{ name: '药', qty: 1, conditionPatch: { add: [{ text: '好转', evidence: '小A说手腕还疼' }] } }] } };
    expect(() => parse(body, false)).toThrow(/conditionPatch 必须放在/);
    const { stored, dropped } = parse(body, true);
    expect(stored.items?.add).toEqual([{ name: '药', qty: 1 }]);
    expect(dropped).toEqual([{ kind: 'condition', name: '', reason: 'invalid', detail: '伤情补丁写在了「药」里，须写在主角或对应角色的条目内' }]);
    expect(describeDropped(dropped[0], '林舟').what).toBe('某个角色的伤情');
  });

  it('内置模板的生活档案新增缺 subject：前几次附原因重试，最后一次去掉并报告', () => {
    const body = { stateChanges: ['lifeDetails'], lifeDetails: { add: [{ text: '只喝温水', topics: ['饮食'] }, { subject: 'user', text: '早起跑步' }] } };
    expect(() => parse(body, false)).toThrow(/lifeDetails\.add\[0\]「只喝温水」缺少 subject/);
    const { stored, dropped } = parse(body, true);
    expect(stored.lifeDetails?.add).toEqual([{ subject: 'user', text: '早起跑步' }]);
    expect(dropped).toEqual([{ kind: 'lifeDetail', name: '只喝温水', reason: 'missing', detail: '没有写明所属人物' }]);
  });

  it('缺 summary 或不是 JSON 仍整份拒绝，也不报告去掉的内容', () => {
    let reported = false;
    for (const raw of [JSON.stringify({ stateChanges: [] }), '不是 JSON']) {
      expect(() => parseSummaryResponse(raw, {
        requireStateChanges: true, sourceContent: content, sourceTexts: [content], conditionContext: before, npcRoster: ['小A'],
        finalize: delta => finalizeDelta(delta, []), onDroppedEvidence: () => { reported = true; },
      })).toThrow(SummaryResponseError);
    }
    expect(reported).toBe(false);
  });
});

describe('变量命令无效时照常跳过并提示', () => {
  it('清单写了 vars、命令全部无效时不让整楼失败（任何一次尝试），保存后提示跳过了几条', () => {
    const skipped: DroppedEvidence[] = [];
    const { d, stored } = parse({ stateChanges: ['vars'], vars: [{ op: 'update', path: '好感', value: 3 }, { op: 'delete', path: '旧' }] }, false, { skipped });
    expect(d.summary).toBe('次晨重逢。');
    expect(stored.varOps).toBeUndefined();
    expect(skipped).toEqual([{ kind: 'vars', name: 'vars', reason: 'invalid', detail: '变量命令 2 条无效，已跳过（op 只能是 set、assign、remove、add）' }]);
  });

  it('部分命令有效时只跳过无效的', () => {
    const skipped: DroppedEvidence[] = [];
    const { stored } = parse({ stateChanges: ['vars'], vars: [{ op: 'set', path: '好感', value: 3 }, { op: 'push', path: '旧' }] }, false, { skipped });
    expect(stored.varOps).toEqual([{ op: 'set', path: '好感', value: 3 }]);
    expect(skipped.map(x => x.detail)).toEqual(['变量命令 1 条无效，已跳过（op 只能是 set、assign、remove、add）']);
  });
});
