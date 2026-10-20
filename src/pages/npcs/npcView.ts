/**
 * 角色页的展示规则：名册里的位置文案、年龄显示、各档角色卡显示哪些字段、折叠偏好的读写。
 * 只决定界面怎么显示，不改记忆数据。各档显示的字段与发给模型的 NPC 名册分档一致（见 inject.ts）。
 */
import { fmtNpcAffinity } from '@/memory/npcRelations';
import { memory } from '@/memory/store';
import { ageDisplay } from '@/memory/timeRel';
import type { MemNpc } from '@/memory/types';

/** 名册分档：主要角色 / 在场 / 同区域 / 不在场或位置未确认。 */
export type NpcTier = 'main' | 'present' | 'nearby' | 'absent';

/** 名册里的位置。发给模型的写法见 npcLocationLabel，这里换成好读的说法，规则相同：旧位置不当成现在的位置。 */
export function npcPlaceText(n: MemNpc): string {
  if (n.follow) return '跟主角在一起';
  if (n.location && !n.locationStale) return n.location;
  const last = n.lastKnownLocation;
  const place = last?.place || n.location;
  return place ? `现在不确定；最后一次在${place}${last?.time ? `（${last.time}）` : ''}` : '现在不确定';
}

/** 年龄显示：按锚点和当前故事时间推算（与注入端同一函数，界面显示的就是模型收到的）。 */
export function shownAge(age?: string, ageTime?: string): string {
  return ageDisplay(age, ageTime, memory.state.time);
}

/** 年龄的悬停提示：显示原始锚点，说明「约26岁」是怎么推算出来的。 */
export function ageTitle(age?: string, ageTime?: string): string {
  if (!age?.trim()) return '';
  return ageTime?.trim() ? `记录于 ${ageTime.trim()}:${age.trim()}(随剧情时间自动推算)` : `年龄:${age.trim()}`;
}

/** 列表里图标按钮的读屏名称带上条目开头，区分同一列表里的多个按钮，如「删除生活细节：喝咖啡不加糖…」。 */
export function labelSnippet(text: string, max = 12): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 名字旁的小标签：性别、年龄（年龄带锚点提示）。 */
export interface CardChip {
  text: string;
  title?: string;
}

export function personChips(gender?: string, age?: string, ageTime?: string): CardChip[] {
  const chips: CardChip[] = [];
  if (gender) chips.push({ text: gender });
  const shown = shownAge(age, ageTime);
  if (shown) chips.push({ text: shown, title: ageTitle(age, ageTime) });
  return chips;
}

/** 角色卡的一行字段。cls 决定标签与值的配色，ddClass 用于位置的「随行」「不确定」状态。 */
export interface CardField {
  key: string;
  label: string;
  value: string;
  cls?: string;
  ddClass?: string;
  labelTitle?: string;
}

const AFFINITY_TITLE = '对主角的内心好感与外在态度估计';

/**
 * 各档角色卡显示的字段，与注入端分档一致：
 *  - 主要角色：身份、关系、好感、位置、着装、状态（重点是即时状态）；
 *  - 在场：全部字段；同区域：身份、关系、好感、位置、性格；不在场：身份、关系、好感、位置。
 * 返回 null 表示不显示字段表（主要角色此时显示「暂无状态记录」提示）。
 */
export function npcCardFields(n: MemNpc, tier: NpcTier): CardField[] | null {
  const affinity = fmtNpcAffinity(n);
  const shows: Record<NpcTier, boolean> = {
    main: !!(n.title || n.relation || affinity || n.outfit || n.condition || n.follow || n.location || n.lastKnownLocation),
    present: !!(n.title || n.relation || affinity || n.ties || n.personality || n.desc || n.outfit || n.condition || n.follow || n.location || n.lastKnownLocation),
    nearby: !!(n.title || n.relation || affinity || n.personality || n.location || n.lastKnownLocation),
    absent: true,
  };
  if (!shows[tier]) return null;
  const fields: CardField[] = [];
  const add = (key: string, label: string, value: string | undefined, extra: Partial<CardField> = {}) => {
    if (value) fields.push({ key, label, value, ...extra });
  };
  add('title', '身份', n.title, { cls: 'f-title' });
  add('relation', '关系', n.relation, { cls: 'f-rel' });
  add('affinity', '好感', affinity, { labelTitle: AFFINITY_TITLE });
  const place = npcPlaceText(n);
  if (tier === 'main' || tier === 'present') {
    if (n.follow || n.location) fields.push({ key: 'loc', label: '位置', value: place, cls: 'f-loc', ddClass: n.follow ? 'is-follow' : undefined });
    add('outfit', '着装', n.outfit, { cls: 'f-outfit' });
    add('condition', '状态', n.condition, { cls: 'f-cond' });
    if (tier === 'present') {
      add('personality', '性格', n.personality, { cls: 'f-trait' });
      add('desc', '外貌', n.desc, { cls: 'f-desc' });
      add('ties', '人际', n.ties, { cls: 'f-ties' });
    }
  } else if (tier === 'nearby') {
    if (n.location || n.lastKnownLocation) fields.push({ key: 'loc', label: '位置', value: place, cls: 'f-loc' });
    add('personality', '性格', n.personality, { cls: 'f-trait' });
  } else {
    fields.push({ key: 'loc', label: '位置', value: place, cls: 'f-loc', ddClass: !n.location || n.locationStale ? 'is-nowhere' : undefined });
  }
  return fields;
}

/** 添加/编辑角色表单的草稿。好感两档用字符串承载下拉值，保存时再转换。 */
export interface NpcDraft {
  name: string;
  gender: string;
  age: string;
  relation: string;
  affinityInner: string;
  affinityOuter: string;
  affinityNote: string;
  ties: string;
  title: string;
  personality: string;
  desc: string;
  outfit: string;
  condition: string;
  important: boolean;
  follow: boolean;
  location: string;
}

export function emptyNpcDraft(location: string): NpcDraft {
  return { name: '', gender: '', age: '', relation: '', affinityInner: '', affinityOuter: '', affinityNote: '', ties: '', title: '', personality: '', desc: '', outfit: '', condition: '', important: false, follow: false, location };
}

/**
 * 区块折叠偏好：本机视图状态，存 localStorage，不进设置。
 * defaultCollapsed 为没有记录时的状态：false 时只有存了 '1' 才收起，true 时只有存了 '0' 才展开。
 */
export function loadCollapsed(key: string, defaultCollapsed: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return defaultCollapsed ? v !== '0' : v === '1';
  } catch {
    return defaultCollapsed;
  }
}

export function persistCollapsed(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
