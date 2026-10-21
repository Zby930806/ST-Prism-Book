import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemNpc } from '@/memory/types';
import { loadCollapsed, npcCardFields, npcChips, npcPlaceText, persistCollapsed, profileGapText } from './npcView';

const npc = (patch: Partial<MemNpc>): MemNpc => ({ id: 'n1', name: '洛伊', createdAt: 1, updatedAt: 1, ...patch });
const keys = (fields: ReturnType<typeof npcCardFields>) => fields?.map(f => f.key) ?? null;

describe('角色卡各档字段', () => {
  it('主要角色没有任何状态时不显示字段表', () => {
    expect(npcCardFields(npc({}), 'main')).toBeNull();
  });

  it('主要角色显示身份、关系、好感、外貌、性格、位置、着装、状态，随行时位置为强调色', () => {
    const fields = npcCardFields(npc({ title: '领航员', relation: '同伴', follow: true, outfit: '斗篷', condition: '轻伤', conditionTime: '5月8日', personality: '谨慎', desc: '短发', ties: '无' }), 'main');
    expect(keys(fields)).toEqual(['title', 'relation', 'desc', 'personality', 'loc', 'outfit', 'condition']);
    expect(fields?.find(f => f.key === 'loc')).toMatchObject({ value: '跟主角在一起', ddClass: 'is-follow', cls: 'f-loc' });
    expect(fields?.find(f => f.key === 'condition')?.labelTitle).toBe('记录于 5月8日');
  });

  it('主要角色只有外貌或性格时也显示字段表', () => {
    expect(keys(npcCardFields(npc({ desc: '银灰短发' }), 'main'))).toEqual(['desc']);
  });

  it('主要角色只有最后已知位置时显示空字段表（不显示提示），与原模板一致', () => {
    expect(npcCardFields(npc({ lastKnownLocation: { place: '旧街', time: '5月8日', leafId: 'l' } }), 'main')).toEqual([]);
  });

  it('在场角色显示全部字段，顺序固定', () => {
    const fields = npcCardFields(npc({ title: 't', relation: 'r', location: '书店', outfit: 'o', condition: 'c', personality: 'p', desc: 'd', ties: 'x' }), 'present');
    expect(keys(fields)).toEqual(['title', 'relation', 'loc', 'outfit', 'condition', 'personality', 'desc', 'ties']);
    expect(fields?.find(f => f.key === 'loc')?.ddClass).toBeUndefined();
  });

  it('在场角色没有任何字段时不显示字段表', () => {
    expect(npcCardFields(npc({}), 'present')).toBeNull();
  });

  it('同区域角色只显示身份、关系、好感、位置、性格；只有最后已知位置时也显示位置', () => {
    const fields = npcCardFields(npc({ title: 't', outfit: 'o', personality: 'p', lastKnownLocation: { place: '旧街', time: '5月8日', leafId: 'l' } }), 'nearby');
    expect(keys(fields)).toEqual(['title', 'loc', 'personality']);
    expect(fields?.find(f => f.key === 'loc')?.value).toBe('现在不确定；最后一次在旧街（5月8日）');
  });

  it('同区域与不在场的卡片也显示外貌，改过名的显示原名', () => {
    expect(keys(npcCardFields(npc({ title: 't', personality: 'p', desc: '络腮胡', location: '码头' }), 'nearby'))).toEqual(['title', 'loc', 'personality', 'desc']);
    expect(keys(npcCardFields(npc({ title: '船工', formerNames: ['船工A'], desc: '络腮胡' }), 'absent'))).toEqual(['title', 'former', 'loc', 'desc']);
    expect(npcCardFields(npc({ formerNames: ['船工A', '老船工'] }), 'absent')?.find(f => f.key === 'former')?.value).toBe('船工A、老船工');
  });

  it('档案缺外貌、身份、性别时列出所缺项；未具名角色带标签', () => {
    expect(profileGapText(npc({}))).toBe('外貌、身份、性别');
    expect(profileGapText(npc({ desc: 'd', title: 't', gender: '男' }))).toBe('');
    expect(profileGapText(npc({ title: '酒保' }))).toBe('外貌、性别');
    expect(npcChips(npc({ name: '酒保A', gender: '男' })).map(c => c.text)).toEqual(['男', '未具名']);
    expect(npcChips(npc({ name: '小A' })).map(c => c.text)).toEqual([]);
  });

  it('不在场角色总显示位置；没有位置或位置过期时用弱化样式', () => {
    expect(npcCardFields(npc({}), 'absent')).toEqual([{ key: 'loc', label: '位置', value: '现在不确定', cls: 'f-loc', ddClass: 'is-nowhere' }]);
    expect(npcCardFields(npc({ location: '钟塔', locationStale: true }), 'absent')?.[0]).toMatchObject({ value: '现在不确定；最后一次在钟塔', ddClass: 'is-nowhere' });
    expect(npcCardFields(npc({ location: '钟塔', outfit: 'o' }), 'absent')).toEqual([{ key: 'loc', label: '位置', value: '钟塔', cls: 'f-loc', ddClass: undefined }]);
  });

  it('好感一行带说明提示', () => {
    const fields = npcCardFields(npc({ affinityInner: 1 }), 'absent');
    expect(fields?.[0]).toMatchObject({ key: 'affinity', label: '好感', labelTitle: '对主角的内心好感与外在态度估计' });
  });

  it('名册位置文案：随行、当前位置、过期位置', () => {
    expect(npcPlaceText(npc({ follow: true, location: '书店' }))).toBe('跟主角在一起');
    expect(npcPlaceText(npc({ location: '书店' }))).toBe('书店');
    expect(npcPlaceText(npc({ location: '书店', locationStale: true }))).toBe('现在不确定；最后一次在书店');
  });
});

describe('区块折叠偏好', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubStorage = (initial: Record<string, string>) => {
    const data = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
    return data;
  };

  it('默认展开的区块：只有存了 1 才收起', () => {
    stubStorage({ a: '1', b: '0', c: 'x' });
    expect(loadCollapsed('a', false)).toBe(true);
    expect(loadCollapsed('b', false)).toBe(false);
    expect(loadCollapsed('c', false)).toBe(false);
    expect(loadCollapsed('none', false)).toBe(false);
  });

  it('默认收起的区块：只有存了 0 才展开', () => {
    stubStorage({ a: '1', b: '0', c: 'x' });
    expect(loadCollapsed('a', true)).toBe(true);
    expect(loadCollapsed('b', true)).toBe(false);
    expect(loadCollapsed('c', true)).toBe(true);
    expect(loadCollapsed('none', true)).toBe(true);
  });

  it('localStorage 不可用时回到默认状态，写入不报错', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(loadCollapsed('a', false)).toBe(false);
    expect(loadCollapsed('a', true)).toBe(true);
    expect(() => persistCollapsed('a', true)).not.toThrow();
  });

  it('写入 1 / 0', () => {
    const data = stubStorage({});
    persistCollapsed('k', true);
    expect(data.get('k')).toBe('1');
    persistCollapsed('k', false);
    expect(data.get('k')).toBe('0');
  });
});
