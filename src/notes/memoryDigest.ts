/**
 * 双子札记与创作规划读取宝书记忆时用的紧凑文字（只读，不创建摘要、不改记忆）。
 *
 * - 状态：去掉内部 id 和时间戳，按重要程度分段排列：未了结的计划与悬念 → 时间、地点与局势 → 主角 →
 *   主要角色与在场、同区域的角色 → 物品 → 近期已了结的计划与悬念 → 其余角色；规划另带已知地点、生活档案和自定义变量。
 * - 历史：摘要和总结按时间顺序排列。
 * - 不限字数时全部发送；限字数时按上面的顺序放入放得下的部分，整条或整段省略并注明省略了什么，不在一条中间截断。
 */
import { apiSettings } from '@/api/settings';
import { classifyNpcPresence } from '@/memory/apply';
import { renderHistoryNodes, type ViewNode } from '@/memory/inject';
import { fmtLifeDetail } from '@/memory/lifeDetails';
import { fmtNpcSummaryList, type NpcSummaryView } from '@/memory/npcRelations';
import { fmtItems, fmtProtagonist, fmtResolvedPlans, fmtSceneFocus, fmtScenes, renderVarsState, selectRecentResolvedPlans } from '@/memory/prompts';
import { memory } from '@/memory/store';
import type { MemItem, MemLifeDetail, MemNpc, MemPlan, MemScene } from '@/memory/types';

/** 「设置 → 注入设置」的记忆注入预算填写了数值（大于 0）时，札记安排和规划资料按各自的上限读取；为 0（默认）时不限制。 */
export function memoryBudgetLimited(): boolean {
  const raw = Number(apiSettings.memoryBudgetTokens);
  return Number.isFinite(raw) && raw > 0;
}

const oneLine = (value: unknown): string => (typeof value === 'string' ? value : '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
/** 摘要提示词的列表行以两个空格缩进开头，这里去掉一级，顶格写「- 」；「(无)」「(暂无记录)」这类占位行不要。 */
const listLines = (block: string): string[] => block.split('\n')
  .map(line => line.replace(/^ {2}/, ''))
  .filter(line => line.trim() && !['(无)', '(暂无记录)'].includes(line.trim()));

/** 一段状态：title 为段落标题，name 为省略说明里的简称；atomic 的段落不能拆开（如变量 JSON）。 */
export interface DigestSection { name: string; title: string; lines: string[]; atomic?: boolean }

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

function planLine(p: MemPlan): string {
  const times = [p.createdTime?.trim() ? `立于 ${p.createdTime.trim()}` : '', p.targetTime?.trim() ? `目标 ${p.targetTime.trim()}` : ''].filter(Boolean);
  return `- [${p.kind === 'suspense' ? '悬念' : '计划'}] ${oneLine(p.content)}${times.length ? `（${times.join(' · ')}）` : ''}`;
}

/** 当前状态分段（按重要程度排列）。extended=true 时另带已知地点、生活档案和自定义变量（创作规划用）。 */
export function memoryStateSections(opts: { userName?: string; extended?: boolean } = {}): DigestSection[] {
  const userName = oneLine(opts.userName) || '主角';
  const state = (memory.state ?? {}) as Partial<typeof memory.state>;
  const plans = asArray<MemPlan>(memory.plans);
  const scenes = asArray<MemScene>(memory.scenes);
  const npcs = asArray<MemNpc>(memory.npcs);
  const items = asArray<MemItem>(memory.items);
  const sections: DigestSection[] = [];

  sections.push({ name: '计划与悬念', title: '未了结的计划与悬念', lines: plans.filter(p => p?.status === 'open' && oneLine(p.content)).map(planLine) });

  const place: string[] = [];
  if (oneLine(state.time)) place.push(`当前时间：${oneLine(state.time)}`);
  if (oneLine(state.location)) place.push(`当前地点：${oneLine(state.location)}`);
  if (state.sceneFocus && oneLine(state.sceneFocus.situation)) place.push(`局势：${fmtSceneFocus(state.sceneFocus).trim()}`);
  sections.push({ name: '时间地点与局势', title: '时间、地点与局势', lines: place });

  sections.push({ name: '主角', title: `主角（${userName}）`, lines: listLines(fmtProtagonist(memory.protagonist ?? {})) });

  const here = oneLine(state.location);
  const main: NpcSummaryView[] = [];
  const others: Array<NpcSummaryView & { order: number; updated: number }> = [];
  for (const npc of npcs) {
    if (!npc || !oneLine(npc.name)) continue;
    const presence = classifyNpcPresence(npc, scenes, here, state.locationPath);
    if (npc.important || presence === 'present' || presence === 'nearby') main.push({ ...npc, presence });
    else others.push({ ...npc, presence, brief: true, order: npc.lastFloor ?? -1, updated: npc.updatedAt ?? 0 });
  }
  main.sort((a, b) => Number(!!b.important) - Number(!!a.important));
  others.sort((a, b) => b.order - a.order || b.updated - a.updated);
  sections.push({ name: '主要与在场角色', title: '主要角色与在场、同区域的角色', lines: main.map(n => listLines(fmtNpcSummaryList([n]))[0]).filter(Boolean) });

  sections.push({ name: '物品', title: '物品（未标注存放处的随身携带）', lines: listLines(fmtItems(items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))) });

  const countSetting = Number(apiSettings.recentResolvedPlansCount);
  const resolved = selectRecentResolvedPlans(plans.filter(p => p && typeof p === 'object'), Number.isFinite(countSetting) && countSetting >= 0 ? countSetting : 5);
  sections.push({ name: '近期已了结', title: '近期已了结的计划与悬念（不要当作未完成再推进）', lines: resolved.length ? listLines(fmtResolvedPlans(resolved)) : [] });

  sections.push({
    name: '其余角色', title: '其余角色（不在场或位置未确认；只列名字、身份和所在地）',
    lines: others.map(n => (listLines(fmtNpcSummaryList([n]))[0] ?? '').replace(/〔简列〕$/, '')).filter(Boolean),
  });

  if (opts.extended) {
    sections.push({ name: '已知地点', title: '已知地点', lines: scenes.length ? listLines(fmtScenes(scenes)) : [] });
    const details = asArray<MemLifeDetail>(memory.lifeDetails).filter(d => d && oneLine(d.text));
    const tierRank = (d: MemLifeDetail) => (d.tier === 'pinned' ? 0 : d.tier === 'archive' ? 2 : 1);
    sections.push({
      name: '生活档案', title: '生活档案（每条只属于姓名标明的人）',
      lines: [...details].sort((a, b) => tierRank(a) - tierRank(b)).map(d => `- ${d.tier === 'pinned' ? '[置顶] ' : d.tier === 'archive' ? '[较早] ' : ''}${oneLine(fmtLifeDetail(d, userName))}`),
    });
    const vars = memory.vars && typeof memory.vars === 'object' ? memory.vars : {};
    sections.push({ name: '自定义变量', title: '自定义变量（当前值）', lines: Object.keys(vars).length ? [renderVarsState(vars)] : [], atomic: true });
  }
  return sections.filter(s => s.lines.length);
}

const sectionText = (s: DigestSection, count: number): string => `[${s.title}]\n${s.lines.slice(0, count).join('\n')}`;

/**
 * 按顺序放入放得下的状态：段内逐条放，放不下的那条及之后的同段条目省略，再看下一段；atomic 段整段放或整段省略。
 * limit 为 Infinity 时全部放入。返回的文字不超过 limit（含末尾的省略说明）。
 */
export function fitDigestSections(sections: DigestSection[], limit: number): { text: string; omitted: number } {
  const render = (counts: number[]) => sections.map((s, i) => (counts[i] ? sectionText(s, counts[i]) : '')).filter(Boolean).join('\n');
  const all = sections.map(s => s.lines.length);
  const full = render(all);
  if (!Number.isFinite(limit) || full.length <= limit) return { text: full, omitted: 0 };
  const counts = sections.map(() => 0);
  let used = 0;
  sections.forEach((s, i) => {
    const sep = used ? 1 : 0;
    if (s.atomic) {
      const cost = sep + sectionText(s, s.lines.length).length;
      if (used + cost <= limit) { counts[i] = s.lines.length; used += cost; }
      return;
    }
    let cost = sep + s.title.length + 3; // [标题]\n
    for (const line of s.lines) {
      const next = cost + line.length + (counts[i] ? 1 : 0);
      if (used + next > limit) break;
      cost = next; counts[i]++;
    }
    if (counts[i]) used += cost;
  });
  const note = (c: number[]): string => {
    const names = sections.filter((s, i) => c[i] < s.lines.length).map(s => s.name);
    const missing = sections.reduce((n, s, i) => n + s.lines.length - c[i], 0);
    return missing ? `（因字数上限另有 ${missing} 条状态没有列出：${names.join('、')}。没有列出不代表不存在。）` : '';
  };
  // 加上省略说明后仍超出时，从优先级最低的已放入内容开始拿掉。
  for (;;) {
    const body = render(counts), tail = note(counts);
    const text = [body, tail].filter(Boolean).join('\n');
    if (text.length <= limit) return { text, omitted: sections.reduce((n, s, i) => n + s.lines.length - counts[i], 0) };
    const last = counts.reduce((at, c, i) => (c ? i : at), -1);
    if (last < 0) return { text: tail.length <= limit ? tail : '', omitted: all.reduce((a, b) => a + b, 0) };
    counts[last] = sections[last].atomic ? 0 : counts[last] - 1;
  }
}

/** 当前状态的紧凑文字；limit 为 Infinity 时不限字数。 */
export function memoryStateDigest(opts: { userName?: string; extended?: boolean }, limit = Infinity): string {
  return fitDigestSections(memoryStateSections(opts), limit).text;
}

/**
 * 历史摘要与总结（按时间顺序）。限字数时从最新往前连续保留，遇到第一条放不下就停，
 * 在开头注明更早的几条已省略；不会跳过放不下的一条再去取更早、更短的。
 */
export function fitHistoryNodes(nodes: ViewNode[], limit = Infinity): { text: string; omitted: number } {
  const texts = nodes.map(n => renderHistoryNodes([n])).filter(Boolean);
  if (!Number.isFinite(limit)) return { text: texts.join('\n\n'), omitted: 0 };
  const full = texts.join('\n\n');
  if (full.length <= limit) return { text: full, omitted: 0 };
  const kept: string[] = [];
  const noteFor = (omitted: number) => `（更早的 ${omitted} 条摘要和总结因字数上限省略。）`;
  let used = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    const cost = texts[i].length + (kept.length ? 2 : 0);
    // 预留省略说明的位置（说明在最前面，后面接两个换行）
    if (used + cost + noteFor(i).length + 2 > limit) break;
    kept.unshift(texts[i]); used += cost;
  }
  const omitted = texts.length - kept.length;
  if (!kept.length) {
    const none = `（${omitted} 条摘要和总结超出字数上限，没有列出。）`;
    return { text: none.length <= limit ? none : '', omitted };
  }
  return { text: `${noteFor(omitted)}\n\n${kept.join('\n\n')}`, omitted };
}

/**
 * 逐行列表从最新往前放入（items 按时间先后排列，最新的在最后），放不下就停；
 * 在开头注明另有几条较早的没有列出。what 是列表内容的名称（如「安排」）。limit 为 Infinity 时全部放入。
 */
export function fitNewestLines(items: string[], limit = Infinity, what = ''): { text: string; omitted: number } {
  const lines = items.filter(Boolean);
  const full = lines.join('\n');
  if (!Number.isFinite(limit) || full.length <= limit) return { text: full, omitted: 0 };
  const noteFor = (omitted: number) => `（另有 ${omitted} 条较早的${what}因字数上限没有列出。）`;
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length ? 1 : 0);
    if (used + cost + noteFor(i).length + 1 > limit) break;
    kept.unshift(lines[i]); used += cost;
  }
  const omitted = lines.length - kept.length;
  if (!kept.length) {
    const none = `（${omitted} 条${what}超出字数上限，没有列出。）`;
    return { text: none.length <= limit ? none : '', omitted };
  }
  return { text: `${noteFor(omitted)}\n${kept.join('\n')}`, omitted };
}
