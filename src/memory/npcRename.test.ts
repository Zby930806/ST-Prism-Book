import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, finalizeDelta } from './apply';
import { DELTA_OP_LABEL, deltaTagGroups } from './deltaTags';
import { currentSummaryPromise, engineState, summarizeFloor } from './engine';
import { memory, recomputeDerived } from './store';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import { createEmptyMemory, type LeafExtra, type StoredDelta } from './types';

// 改名操作的校验与重放;模拟响应不代表模型实际会这样输出。
const saved = JSON.stringify(settings.apiSettings);
let seq = 0;
const ai = (mes: string, delta?: StoredDelta): STMessage => ({
  name: '角色', is_user: false, is_system: false, mes,
  extra: delta ? { bbs_leaf: { id: 'rename-' + ++seq, text: '摘要。', delta, createdAt: seq, swipe: 0, v: 1 } as LeafExtra } : {},
});
const source = ['酒保A擦了擦手，笑道：“叫我老周就行。”他的右手伤口已经结痂。'];
const parse = (body: Record<string, unknown>, roster = ['酒保A', '梅芙'], conditionNpcs = [{ name: '酒保A', condition: '右手割伤' }]) =>
  parseSummaryResponse(JSON.stringify({ summary: '酒保报出名字。', ...body }), {
    requireStateChanges: false, sourceTexts: source, sourceContent: source[0], npcRoster: roster, userName: '沈遥',
    conditionContext: { protagonist: {}, npcs: conditionNpcs, content: source[0], strict: true },
    finalize: d => finalizeDelta(d, []),
  });
const rename = (extra: Record<string, unknown> = {}) => ({ npcs: { rename: [{ from: '酒保A', to: '老周', evidence: '叫我老周就行', ...extra }] } });

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, summaryMaxRetries: 0, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('改名操作的校验', () => {
  it('名册已有的名字改成新名字,证据须是本楼原句且含新名字;存储时去掉证据', () => {
    const d = parse({ ...rename(), stateChanges: ['npcs'] });
    expect(d.npcs?.rename).toEqual([{ from: '酒保A', to: '老周' }]);
    expect(finalizeDelta(d, []).npcs?.rename).toEqual([{ from: '酒保A', to: '老周' }]);
  });
  it.each([
    ['原名不在名册', { npcs: { rename: [{ from: '酒保B', to: '老周', evidence: '叫我老周就行' }] } }, '不在本楼之前的名册中'],
    ['新名字已在名册', { npcs: { rename: [{ from: '酒保A', to: '梅芙', evidence: '叫我老周就行' }] } }, '已在名册中'],
    ['改成主角', { npcs: { rename: [{ from: '酒保A', to: '沈遥', evidence: '叫我老周就行' }] } }, '主角'],
    ['证据不含新名字', rename({ evidence: '他的右手伤口已经结痂' }), '没有新名字'],
    ['证据不是原文', rename({ evidence: '我叫老周,是这里的老板' }), '不匹配'],
    ['缺证据', { npcs: { rename: [{ from: '酒保A', to: '老周' }] } }, '缺失'],
    ['未知字段', rename({ reason: '报了名字' }), '未知字段'],
    ['同楼仍用旧名更新', { npcs: { ...rename().npcs, update: [{ name: '酒保A', outfit: '围裙' }] } }, '改名前的名字'],
    ['同楼又新建新名字', { npcs: { ...rename().npcs, add: [{ name: '老周', title: '老板' }] } }, '请用 update'],
    ['同一角色改两次', { npcs: { rename: [rename().npcs.rename[0], { from: '酒保A', to: '周叔', evidence: '叫我老周就行' }] } }, '重复改名'],
    ['不是数组', { npcs: { rename: { from: '酒保A', to: '老周' } } }, '必须是数组'],
  ] as const)('%s → 整份结果不通过,附原因重试', (_label, body, message) => {
    expect(() => parse(body as Record<string, unknown>)).toThrow(SummaryResponseError);
    expect(() => parse(body as Record<string, unknown>)).toThrow(message);
  });
  it('改名后用新名字局部更新伤情,能找回改名前的伤情片段', () => {
    const d = parse({ npcs: { ...rename().npcs, update: [{ name: '老周', conditionPatch: { replace: [{ id: 'c1', text: '右手伤口结痂', evidence: '他的右手伤口已经结痂' }] } }] } });
    expect(d.npcs?.update?.[0]).toMatchObject({ name: '老周', condition: '右手伤口结痂' });
  });
  it('改名后对已有伤情整段覆盖仍按局部协议拒绝', () => {
    expect(() => parse({ npcs: { ...rename().npcs, update: [{ name: '老周', condition: '痊愈' }] } })).toThrow('conditionPatch');
  });
});

describe('改名操作的重放', () => {
  const chat = () => {
    const first = ai('酒保擦杯子。', { time: '2031/5/8 20:00', location: '酒馆', npcs: { add: [{ name: '酒保A', title: '酒馆酒保', desc: '络腮胡', condition: '右手割伤', affinityInner: 1, location: '酒馆' }] },
      lifeDetails: { add: [{ subject: '酒保A', text: '只喝温水', topics: ['饮食'] }] },
      secrets: { add: [{ content: '酒馆地窖藏着信', knownBy: ['沈遥'], unaware: ['酒保A'] }] } });
    const second = ai('酒保说叫他老周。', { time: '2031/5/9 21:00', npcs: { rename: [{ from: '酒保A', to: '老周' }], update: [{ name: '老周', title: '酒馆老板' }] } });
    return [first, second];
  };
  it('档案、伤情及锚点、位置、好感随改名接续,旧名记为原记为;生活档案与信息差的名字同步', () => {
    const st = deriveMemory(chat());
    expect(st.npcs).toHaveLength(1);
    expect(st.npcs[0]).toMatchObject({ id: 'npc:老周', name: '老周', title: '酒馆老板', desc: '络腮胡', condition: '右手割伤', conditionTime: '2031/5/8 20:00', conditionFloor: 0,
      affinityInner: 1, location: '酒馆', formerNames: ['酒保A'], firstFloor: 0, lastFloor: 1 });
    expect(st.lifeDetails[0].subject).toBe('老周');
    expect(st.secrets[0].unaware).toEqual(['老周']);
  });
  it('新名字被别人占用或原名不存在时跳过,不合并两条记录', () => {
    const c = chat();
    c.splice(1, 0, ai('老周登场。', { npcs: { add: [{ name: '老周', title: '船工' }] } }));
    const st = deriveMemory(c);
    expect(st.npcs.map(n => n.name).sort()).toEqual(['老周', '酒保A'].sort());
    expect(st.npcs.find(n => n.name === '老周')?.title).toBe('酒馆老板');
    expect(deriveMemory([ai('无关', { npcs: { rename: [{ from: '不存在', to: '某人' }] } })]).npcs).toEqual([]);
  });
  it('删除或翻页使改名所在叶子失效时回到旧名', () => {
    const c = chat();
    c[1].swipe_id = 1;
    expect(deriveMemory(c).npcs[0].name).toBe('酒保A');
  });
  it('楼层面板列出改名一条,可单独删除', () => {
    const groups = deltaTagGroups({ npcs: { rename: [{ from: '酒保A', to: '老周' }] } }, 1);
    const tag = groups.find(g => g.title === '角色')!.tags[0];
    expect(tag).toMatchObject({ key: 'npc:rename:0', op: 'rename', text: '酒保A → 老周', editable: false });
    expect(DELTA_OP_LABEL[tag.op]).toBe('改名');
  });
});

describe('改名的摘要入口', () => {
  it('名册给出标签与原记为,模型改名后档案接续', async () => {
    const chat = [ai('酒保擦杯子。', { npcs: { add: [{ name: '酒保A', title: '酒馆酒保', desc: '络腮胡' }] } }), { name: '沈遥', is_user: true, is_system: false, mes: '问他叫什么。' } as STMessage, ai(source[0])];
    const ctx = { chat, chatMetadata: {}, name1: '沈遥', name2: '角色', getCurrentChatId: () => 'rename-test',
      saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn() } as unknown as STContext;
    vi.spyOn(context, 'getContext').mockReturnValue(ctx);
    recomputeDerived();
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '酒保报出名字老周。', stateChanges: ['npcs'], ...rename() }));
    await summarizeFloor(2);
    expect(engineState.lastError).toBe('');
    const sent = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(sent).toContain('  - 酒保A');
    expect(sent).toContain('"rename"');
    expect(chat[2].extra!.bbs_leaf!.delta.npcs).toEqual({ rename: [{ from: '酒保A', to: '老周' }] });
    expect(memory.npcs[0]).toMatchObject({ name: '老周', desc: '络腮胡', formerNames: ['酒保A'] });
  });
});
