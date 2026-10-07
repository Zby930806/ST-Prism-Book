import { npcLocationLabel } from './npcLocation';
import type { MemNpc, NpcAffinity, NpcAffinityLevel, NpcPresence } from './types';

function oneLine(value: string | undefined): string {
  return (value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function relationKey(value: string): string {
  return value.toLowerCase().replace(/[；;]/g, ';').replace(/\s+/g, ' ').trim();
}

/**
 * 渲染不受在场分档影响的 NPC 长期关系图。
 *
 * 正常派生状态里 NPC 名字唯一；这里仍按规范化名字聚合，以兼容旧数据或异常导入造成的
 * 重名记录。完全相同的关系只输出一次，不同关系全部保留，避免静默缺漏。
 */
export function fmtNpcTiesContext(npcs: Pick<MemNpc, 'name' | 'ties'>[]): string {
  const grouped = new Map<string, { name: string; ties: string[]; seen: Set<string> }>();
  for (const npc of npcs) {
    const name = oneLine(npc.name);
    const ties = oneLine(npc.ties);
    if (!name || !ties) continue;

    const nameKey = name.toLowerCase();
    let entry = grouped.get(nameKey);
    if (!entry) {
      entry = { name, ties: [], seen: new Set<string>() };
      grouped.set(nameKey, entry);
    }
    // ties 的约定格式是分号并列。逐项合并可处理异常旧数据里同名 NPC 的关系集合有交叠，
    // 既不会整行重复，也不会因为简单“保留第一条”而丢掉后续独有关系。
    for (const tie of ties.split(/[；;]/).map(one => one.trim()).filter(Boolean)) {
      const tieKey = relationKey(tie);
      if (entry.seen.has(tieKey)) continue;
      entry.seen.add(tieKey);
      entry.ties.push(tie);
    }
  }

  const rows = [...grouped.values()].map(entry => `  - ${entry.name}:${entry.ties.join(';')}`);
  return rows.length ? `角色长期关系(血缘/婚姻/主仆/宿敌等，不因是否在场而失效):\n${rows.join('\n')}` : '';
}

export interface NpcSummaryView extends NpcAffinity {
  name: string;
  gender?: string;
  age?: string;
  ageTime?: string;
  relation?: string;
  ties?: string;
  title?: string;
  personality?: string;
  important?: boolean;
  desc?: string;
  outfit?: string;
  condition?: string;
  follow?: boolean;
  location?: string;
  /** 摘要名册在场标记:由 engine 用 classifyNpcPresence 按「本楼之前」的状态算好;缺省不显示标记 */
  presence?: NpcPresence;
  locationStale?: boolean;
  lastKnownLocation?: MemNpc['lastKnownLocation'];
}

/** 给摘要模型的已登场 NPC 名册。长期关系必须随既有状态一起给模型，才能做整体覆盖更新。 */
export function fmtNpcSummaryList(npcs: NpcSummaryView[]): string {
  if (!npcs.length) return '  (无)';
  return npcs
    .map(n => {
      const star = n.important ? '★ ' : '';
      const inBracket: string[] = [];
      if (oneLine(n.gender)) inBracket.push(oneLine(n.gender));
      if (oneLine(n.age)) inBracket.push(`${oneLine(n.age)}${n.ageTime ? `·记于${oneLine(n.ageTime)}` : ''}`);
      const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
      // 在场标记:只给摘要名册用(presence 由 engine 计算),要 AI 拿它做离场/归场对账而非自行推理。
      const mark = n.presence === 'present' ? '〔在场〕'
        : n.presence === 'nearby' ? '〔同区域〕'
          : n.presence === 'absent' ? '〔不在场〕' : n.presence === 'unknown' ? '〔当前位置未确认〕' : '';
      const place = n.follow ? ' [随行]' : ' [' + npcLocationLabel(n) + ']';
      const tail: string[] = [];
      if (oneLine(n.title)) tail.push(oneLine(n.title));
      if (oneLine(n.relation)) tail.push(`与主角:${oneLine(n.relation)}`);
      if (oneLine(n.ties)) tail.push(`人际:${oneLine(n.ties)}`);
      if (oneLine(n.personality)) tail.push(`性格:${oneLine(n.personality)}`);
      const affinity = fmtNpcAffinity(n);
      if (affinity) tail.push(`对主角的好感与态度估计[${affinity}]`);
      const title = tail.length ? ` —— ${tail.join(';')}` : '';
      const state: string[] = [];
      if (oneLine(n.desc)) state.push(`既有外貌记录:${oneLine(n.desc)}`);
      if (oneLine(n.outfit)) state.push(`最后记录着装:${oneLine(n.outfit)}`);
      if (oneLine(n.condition)) state.push(`最后记录状态:${oneLine(n.condition)}`);
      const stateStr = state.length ? ` 〔${state.join(';')}〕` : '';
      return `  - ${star}${oneLine(n.name)}${bracket}${mark}${place}${title}${stateStr}`;
    })
    .join('\n');
}

export const NPC_AFFINITY_LABELS = {
  affinityInner: ['强烈反感', '不喜欢', '无明显好恶', '有好感', '感情深厚'],
  affinityOuter: ['明显敌对', '冷淡疏远', '不明显亲近或排斥', '友善亲近', '明显亲近、积极表达'],
} as const;

/** 页面和楼层编辑共用档位,只显示文字,不提供加减分或进度条。 */
export const NPC_AFFINITY_FIELDS = (['affinityInner', 'affinityOuter'] as const).map(key => ({
  key,
  label: key === 'affinityInner' ? '内心好感' : '外在态度',
  options: [
    { value: '', label: '未知' },
    ...NPC_AFFINITY_LABELS[key].map((label, i) => ({ value: String(i - 2), label })),
  ],
}));

/** 拒绝百分制、小数、字符串和布尔值,不能把非法值截断成某个真实档位。 */
export function cleanNpcAffinityLevel(value: unknown): NpcAffinityLevel | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= -2 && value <= 2
    ? value as NpcAffinityLevel : undefined;
}

/** 下拉框的空选项表示未知,不是 Number('') 所得到的中性。 */
export function affinityLevelFromInput(value: string): NpcAffinityLevel | null | undefined {
  return cleanNpcAffinityLevel(value === '' ? null : Number(value));
}

/** 独立覆盖补丁;重复 add 只补未知,不能用复述覆盖已经建立的倾向。 */
export function applyNpcAffinity(target: NpcAffinity, patch: NpcAffinity, fillMissing = false): void {
  for (const { key } of NPC_AFFINITY_FIELDS) {
    const value = cleanNpcAffinityLevel(patch[key]);
    if (value !== undefined && (!fillMissing || target[key] == null)) target[key] = value;
  }
  if (typeof patch.affinityNote === 'string' && (!fillMissing || !target.affinityNote)) {
    target.affinityNote = patch.affinityNote.trim();
  }
}

/** 完整状态显示两侧(缺失为未知);楼层 delta 只显示本次真正提供的字段。 */
export function fmtNpcAffinity(npc: NpcAffinity, partial = false, includeNote = true): string {
  const hasLevels = NPC_AFFINITY_FIELDS.some(({ key }) => cleanNpcAffinityLevel(npc[key]) !== undefined);
  if (!hasLevels && !npc.affinityNote?.trim() && !(partial && npc.affinityNote === '')) return '';
  const parts: string[] = [];
  for (const { key, label } of NPC_AFFINITY_FIELDS) {
    const value = cleanNpcAffinityLevel(npc[key]);
    if (partial && value === undefined) continue;
    parts.push(`${label}:${value == null ? '未知' : NPC_AFFINITY_LABELS[key][value + 2]}`);
  }
  if (includeNote && npc.affinityNote?.trim()) parts.push(`说明:${npc.affinityNote.trim().replace(/\s*[\r\n]+\s*/g, ' ')}`);
  else if (includeNote && partial && npc.affinityNote === '') parts.push('好感说明:清空');
  return parts.join(';');
}

/** 只在确有好感记录时注入;估计不能变成读心、剧情事实或强制行为指令。 */
export const NPC_AFFINITY_BRIEFING = '内心好感与外在态度是对主角的五档定性估计,不是精确分数或既定事实。内在是真实倾向估计,外在是相对稳定的对待方式,二者独立且通常保持;一次语气/情绪变化不等于关系跨档。未知不等于中性。以明确剧情与人设为准,好感不等于爱情、信任、服从或同意;内在估计不代表主角或其他角色知情,不得读心、揭穿伪装或复述档位,按视角自然表现即可。估计是既有剧情的总结,不是对本轮的上限或禁令,关系仍可随剧情继续发展或转折。';
