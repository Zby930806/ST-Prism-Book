import { LEDGER_PROTOCOL } from './ledgerProtocol';
import { fitMemoryUnits, fitTimeTagPrompt } from './budget';
import { npcLocationLabel } from './npcLocation';
/**
 * 把记忆注入回主对话上下文。
 *
 * 机制:走 ST 标准的 setExtensionPrompt(key, value, position, depth, scan, role, filter),
 * 而不是手动 splice eventData.chat。setExtensionPrompt 是持久化的——一次设置后,
 * 每次主对话生成都会带上,直到下次用同 key 覆盖。所以只需「记忆变了就刷新」即可。
 *
 * 与隐藏机制配套:旧楼层被 is_system=true 踢出主上下文(见 engine.ts),
 * 这里把它们压缩后的摘要 + 当前结构化状态作为 system 提示重新注入,
 * 主模型因此仍能感知被隐藏的剧情。历史摘要放在聊天顶部附近,当前状态贴近最近对话。
 */

import { apiSettings, engineActiveHere } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { buildSceneLocationIndex, classifyNpcPresence, findCurrentSceneId, getLeaf, itemReachableAtScene, leafValid, staleLastSeenRelation } from './apply';
import { fmtItems, fmtPlans, fmtResolvedPlans, renderVarsState, selectRecentResolvedPlans, MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from './prompts';
import { fmtLifeDetail } from './lifeDetails';
import { fmtInjuryReminder, type InjuryReminderSubject } from './injuryReminder';
import { isNpcLabelName } from './npcLabel';
import { fmtNpcAffinity, fmtNpcTiesContext, NPC_AFFINITY_BRIEFING } from './npcRelations';
import { memory, memoryWriteIssue } from './store';
import { compactTimeLabel, formatRange, latestStoryTime, splitTimeLabel, timeTagPrompt } from './timeTag';
import { relativeTimeLabel, weekdayLabel, ageDisplay, calculateRelativeDays } from './timeRel';
import { selectViewNodes, selectLifeDetailsForInjection, type ViewNode } from './select';
import type { LeafExtra, MemItem, MemLifeDetail, MemNpc, MemProtagonist, MemScene, MemSecret, MemSummary, SceneFocus } from './types';

// 摘要页列表复用同一套选择逻辑,经此 re-export(纯算法在 select.ts,零依赖、可单测)
export { selectViewNodes, type ViewNode };

// 以下常量来源:SillyTavern public/script.js
//   extension_prompt_types.IN_CHAT = 1   (script.js:486)
//   extension_prompt_roles.SYSTEM = 0    (script.js:494)
// getContext() 未暴露这两个枚举,故硬编码并注明出处。
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** 旧版单槽位 key;刷新时清空,避免升级后 D2 残留重复注入 */
const LEGACY_INJECT_KEY = 'baibai_book_memory';
/** 拆分后的 setExtensionPrompt keys;同 key 重复 set 即覆盖,天然幂等 */
const HISTORY_INJECT_KEY = 'baibai_book_memory_history';
const STATE_INJECT_KEY = 'baibai_book_memory_state';
/** 时间标签固定提示词槽:注入主对话,要求每条正文前后输出 <bbs_start>/<bbs_end> */
const TIMETAG_INJECT_KEY = 'baibai_book_time_tag';
const LEDGER_INJECT_KEY = 'baibai_book_ledger_protocol';
/** 历史摘要尽量放到聊天上下文顶部;当前状态贴近最近对话 */
const HISTORY_INJECT_DEPTH = 9999;
const STATE_INJECT_DEPTH_AFTER_LATEST_AI = 1;
const STATE_INJECT_DEPTH_BEFORE_LATEST_AI = 2;
/** 时间标签提示词独立注入到 D0(最底、最贴近下一条回复),作为对「下一条回复」的最强指令,
 *  不与状态快照(D1/D2)同层 */
const TIMETAG_INJECT_DEPTH = 0;

/**
 * 一条叶子是否「已启用」(应注入)。
 * 生成与使用解耦:叶子对所有楼层提前生成,但只有当它所在消息已被隐藏(is_system,
 * 原文移出主上下文)时才注入顶替原文;仍在保留窗口发全文的叶子暂不注入,避免与全文重复。
 */
function leafActiveAt(chat: STMessage[] | null, i: number): boolean {
  if (!chat) return false;
  return chat[i]?.is_system === true;
}

/** 用于决定状态快照相对最新 AI 楼的位置;与 engine.ts 的可追踪 AI 楼规则保持一致。 */
function isTrackableAiMessage(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (m.extra?.bbs_omit) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (m.extra?.bbs_hidden) return true;
  return !m.is_system;
}

/** 触发匹配的近期上下文:最近几楼正文(新旧都可,含用户楼)拼一起,截断防暴。 */
function recentContextText(): string {
  const chat = getContext()?.chat;
  if (!chat?.length) return '';
  const texts: string[] = [];
  for (let i = chat.length - 1; i >= 0 && texts.length < 6; i--) {
    const m = chat[i];
    const mes = typeof m?.mes === 'string' ? m.mes.trim() : '';
    if (mes) texts.push(mes);
  }
  return texts.join('\n').slice(0, 4000);
}

/**
 * 当前状态的注入位置:
 *  - 最新 AI 已有有效摘要 → 状态已包含它,放在它之后(D1)。
 *  - 最新 AI 尚无有效摘要 → 状态不包含它,保持放在它之前(D2)。
 */
function resolveStateInjectionDepth(chat: STMessage[] | null): number {
  if (!chat) return STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (!isTrackableAiMessage(chat[i])) continue;
    return leafValid(chat[i]) ? STATE_INJECT_DEPTH_AFTER_LATEST_AI : STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
  }
  return STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
}

/** 构建统一森林视图:叶子(leafValid)+ 压缩节点,根 = 未被任何 childIds 引用者 */
function buildView(
  summaries: MemSummary[],
  chat: STMessage[] | null,
): { byId: Map<string, ViewNode>; roots: ViewNode[] } {
  const byId = new Map<string, ViewNode>();

  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      if (chat[i]?.extra?.bbs_omit) continue; // 番外楼:不进注入视图
      if (!leafValid(chat[i])) continue; // 陈旧叶子不进视图 → 不注入
      const leaf = getLeaf(chat[i]) as LeafExtra;
      byId.set(leaf.id, {
        id: leaf.id,
        kind: 'leaf',
        level: 0,
        text: leaf.text,
        timeStart: leaf.timeStart,
        timeEnd: leaf.timeEnd,
        timeLabel: leaf.timeLabel,
        createdAt: leaf.createdAt,
        childIds: [],
        msgIndex: i,
        active: leafActiveAt(chat, i),
      });
    }
  }
  for (const s of summaries) {
    byId.set(s.id, {
      id: s.id,
      kind: 'comp',
      level: s.level,
      text: s.text,
      timeStart: s.timeStart,
      timeEnd: s.timeEnd,
      timeLabel: s.timeLabel,
      createdAt: s.createdAt,
      childIds: s.childIds ?? [],
      // 导入历史以覆盖截止楼作为“历史发生位置”,便于 beforeIndex 判定;普通 comp 仍由后代叶子决定。
      msgIndex: s.imported ? (s.importedFloorEnd ?? -1) : -1,
      active: s.imported === true,
      atomic: s.imported === true,
      floorStart: s.importedFloorStart,
      floorEnd: s.importedFloorEnd,
    });
  }

  const referenced = new Set<string>();
  for (const s of summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const roots = [...byId.values()].filter(n => !referenced.has(n.id));
  return { byId, roots };
}

/**
 * 通用节点选择:每个「合格」叶子由其祖先链上**最高的、全部后代叶子都合格**的节点代表一次
 * (省 token);否则压缩节点降级、逐子递归。叶子「合格」由 leafEligible 判定。
 *  - 注入场景:合格 = 已隐藏(active),用 selectInjectionNodes。
 *  - 分析历史场景:合格 = 楼层在被分析楼之前,用 selectHistoryNodesBefore。
 *
 * ⚠️ 完好性(intact):一个压缩节点的某个 childId 指向的叶子若已失效(翻页到别的 swipe →
 * leafValid=false → 不在 byId 里),则该节点**不完整**,不能作为整体代表注入(它的压缩文本
 * 嵌着失效那页的旧叙事,会与当前正文冲突)。此时降级递归,改用它**仍完好的子节点**各自代表:
 * 受影响的那条链一路拆到叶子层、跳过失效叶子,而旁支完好的子节点(如同层另一条 L1)整条保留。
 * 节点失活只是「当前不展示/不注入」,森林数据不删除——翻回原页 leafValid 恢复,即自动复活。
 */
function selectNodes(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  leafEligible: (n: ViewNode) => boolean,
): ViewNode[] {
  return selectViewNodes(buildView(summaries, chat), leafEligible);
}

/**
 * 选出注入用的节点:每个「已启用(已隐藏)」叶子由其祖先链最高的全-启用节点代表一次;
 * 窗口内仍发全文的叶子不注入。
 */
export function selectInjectionNodes(summaries: MemSummary[], chat: STMessage[] | null): ViewNode[] {
  return selectNodes(summaries, chat, n => n.active);
}

/**
 * 选出「被分析楼之前」的历史节点,供生成摘要时注入上下文:
 * 楼层 < beforeIndex 的叶子,由其祖先链最高的「全部后代都在 beforeIndex 之前」的节点代表一次
 * (有总结就用总结的压缩文本)。不要求隐藏。
 */
export function selectHistoryNodesBefore(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  beforeIndex: number,
): ViewNode[] {
  return selectNodes(summaries, chat, n => n.msgIndex >= 0 && n.msgIndex < beforeIndex);
}

/** 节点展示时间:新数据用起止合成,旧数据回退 timeLabel */
function nodeTime(n: ViewNode): string {
  if (n.timeStart || n.timeEnd) return formatRange(n.timeStart, n.timeEnd);
  return n.timeLabel ? compactTimeLabel(n.timeLabel) : '';
}

/**
 * 把选出的节点拼成只带绝对时间的历史摘要文本块;空则返回空串。
 * 这套渲染器供摘要/批量摘要/查询重写等副任务复用:它们各自有历史截止点,
 * 不能沿用主对话「相对当前最新剧情」的口径,因此这里刻意不计算相对时间。
 */
export function renderHistoryNodes(nodes: ViewNode[]): string {
  return nodes
    .map(n => {
      const t = nodeTime(n);
      return t ? `【${t}】${n.text}` : n.text;
    })
    .join('\n\n');
}

/** 节点的「事件时间」:用结束时间(剧情已到达的时刻);缺则回退起始,再回退旧 timeLabel 的结束端 */
function nodeEventTime(n: ViewNode): string {
  if (n.timeEnd) return n.timeEnd;
  if (n.timeStart) return n.timeStart;
  return n.timeLabel ? splitTimeLabel(n.timeLabel).end ?? '' : '';
}

/** 取节点未压缩的起止时间;新字段优先,缺失端再从旧 timeLabel 回退。 */
function nodeTimeRange(n: ViewNode): { start: string; end: string } {
  const legacy = n.timeLabel ? splitTimeLabel(n.timeLabel) : {};
  return {
    start: n.timeStart?.trim() || legacy.start?.trim() || '',
    end: n.timeEnd?.trim() || legacy.end?.trim() || '',
  };
}

/** 给一个完整时间点追加相对时间与周几;无法推断的部分自然省略。 */
function timePointWithRelative(time: string, now: string): string {
  const value = time.trim();
  if (!value) return '';
  const parts = [relativeTimeLabel(value, now), weekdayLabel(value)].filter(Boolean);
  return parts.length ? `${value}(${parts.join('·')})` : value;
}

/**
 * 总结节点跨越一段时间,不能用单个「昨天」代表整段。
 * 因此起点、终点分别相对同一个 now 计算,并保留两端完整绝对时间:
 * 【1988/9/28 22:00(前天·周三) - 1988/9/29 08:00(昨天·周四)】
 */
function nodeRangeWithRelative(n: ViewNode, now: string): string {
  const { start, end } = nodeTimeRange(n);
  if (!start && !end) return '';
  if (start && end && start !== end) {
    return `${timePointWithRelative(start, now)} - ${timePointWithRelative(end, now)}`;
  }
  return timePointWithRelative(start || end, now);
}

/**
 * 主对话注入/公开历史宏使用:为历史节点补相对时间,帮模型感知剧情距离。
 * 参照点 now = 故事内最新时间;无法解析相对差的(架空纪年等)降级为只显示绝对时间。
 * 不并入 renderHistoryNodes —— 后者被摘要模型等副任务复用,截止点和参照点不同。
 *
 * 叶子摘要指向单楼,维持【(昨天·周三) 绝对时间】格式。
 * 总结跨多楼,按起止端分别标注为【起始(相对) - 结束(相对)】,避免用单个相对时间误代表整段。
 * 周几与相对时间并入同一个括号;仅标准公历带年份才有周几(weekdayLabel 自带门槛)。
 */
export function renderHistoryNodesWithRelative(nodes: ViewNode[], now: string): string {
  return nodes
    .map(n => {
      if (n.kind === 'comp') {
        const range = nodeRangeWithRelative(n, now);
        return range ? `【${range}】${n.text}` : n.text;
      }
      const t = nodeTime(n);
      if (!t) return n.text;
      const event = nodeEventTime(n);
      const parts = [relativeTimeLabel(event, now), weekdayLabel(event)].filter(Boolean);
      return parts.length ? `【(${parts.join('·')}) ${t}】${n.text}` : `【${t}】${n.text}`;
    })
    .join('\n\n');
}

/** 组合历史摘要注入文本;无启用摘要时返回空串(注入空串等于清除)。 */
export function buildHistoryInjectionText(): string {
  const chat = getContext()?.chat ?? null;

  // 从森林选「最高存活压缩层」节点(被收纳的不重复、窗口内全文叶子不注入)
  const sums = selectInjectionNodes(memory.summaries, chat);
  if (!sums.length) return '';
  // 注入路径带相对时间前缀;参照点 = 故事内最新时间(读正文标签,不受是否已摘影响)
  // 首尾私密简报框定,避免主模型把摘要当成要复述/输出的模板
  return fitMemoryUnits(sums.map(n => renderHistoryNodesWithRelative([n], latestStoryTime(chat))), 'history', `${MEMORY_BRIEFING_NOTE}\n[历史剧情摘要]`, MEMORY_BRIEFING_END, true).text;
}

/**
 * 在场景树里定位「当前节点」:优先 AI 给的权威 locationPath,否则按 here 收紧模糊匹配。
 * 与场景页共用 apply.findCurrentSceneId(单一来源,杜绝页面/注入分叉),这里再把 id 解析回节点。
 * 找不到返回 null(退回纯字符串行为)。
 */
function findCurrentScene(scenes: MemScene[], here: string, locationPath?: string[]): MemScene | null {
  const id = findCurrentSceneId(scenes, here, locationPath);
  if (!id) return null;
  return scenes.find(s => s.id === id) ?? null;
}

/** 回溯祖先链(由粗到细,含当前节点本身)。 */
function sceneChain(scenes: MemScene[], node: MemScene | null): MemScene[] {
  if (!node) return [];
  const byId = new Map(scenes.map(s => [s.id, s]));
  const chain: MemScene[] = [];
  let cur: MemScene | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * 渲染场景注入块(分三档省 token):
 *  - 当前地点 + 祖先链:逐级「名称(描述)」详细。
 *  - 其他去过的地点:仅列名称(完整路径名),帮 AI 复用既有命名、避免重复记录。
 * 无场景数据返回空串。
 */
function fmtSceneContext(scenes: MemScene[], here: string, locationPath?: string[]): string {
  if (!scenes.length) return '';
  const current = findCurrentScene(scenes, here, locationPath);
  const chain = sceneChain(scenes, current);
  const chainIds = new Set(chain.map(s => s.id));

  const lines: string[] = [];
  if (chain.length) {
    const detailed = chain
      .map(n => (oneLine(n.desc) ? `${n.name}(${oneLine(n.desc)})` : n.name))
      .join(' › ');
    lines.push(`当前所在(由大到小):${detailed}`);
  }
  // 其他地点:仅名称(用完整路径表达层级),排除已在祖先链里详述的
  const others = scenes
    .filter(s => !chainIds.has(s.id))
    .map(s => s.path.join(' › '));
  if (others.length) {
    lines.push(`其他已知地点(仅列名称):\n${others.map(o => `  - ${o}`).join('\n')}`);
  }
  return lines.join('\n');
}

/**
 * 单行化:把值里的换行/回车折叠成空格。
 * NPC 名册是「一个角色一行、字段用 ;/—— 拼接」的格式,值内含换行会把一条信息拆成多行、
 * 后续行丢掉「  - 」前缀,破坏注入结构、误导 AI。故所有内联字段渲染前都过此函数。
 * (UI 里字段可软换行显示,但注入必须压平——trim 只去首尾,拦不住中间换行。)
 */
function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 主角档案中会注入的文字字段(锚点等派生数字不在其中)。 */
const PROTAGONIST_TEXT_FIELDS = ['gender', 'age', 'identity', 'appearance', 'outfit', 'condition'] as const;

/** 锚点楼层之后的回复楼层数(与可追踪 AI 楼同口径:不含番外楼、提示楼和原生系统楼)。 */
function aiFloorsAfter(chat: STMessage[] | null, floor: number): number {
  if (!chat) return 0;
  let count = 0;
  for (let i = Math.max(0, floor + 1); i < chat.length; i++) if (isTrackableAiMessage(chat[i])) count++;
  return count;
}

/**
 * 伤势进展提醒:主角、主要角色、在场与同区域的 NPC 中,伤情记录满一天(故事时间不明时按回复楼层数)未更新的,
 * 提醒正文模型写到伤处或相关行动时按轻重体现进展,与本轮无关时不必提及。只覆盖随正文发送的角色(主角信息、NPC 名册的开关);不改记录。
 */
function buildInjuryReminder(protagonistOn: boolean, npcsOn: boolean): string {
  const chat = getContext()?.chat ?? null;
  const subjects: InjuryReminderSubject[] = [];
  if (protagonistOn && oneLine(memory.protagonist.condition)) {
    subjects.push({ name: getContext()?.name1?.trim() || '主角', condition: memory.protagonist.condition, conditionTime: memory.protagonist.conditionTime, conditionFloor: memory.protagonist.conditionFloor });
  }
  if (npcsOn) {
    const here = memory.state.location || '';
    const locPath = memory.state.locationPath;
    const injured = memory.npcs.filter(n => oneLine(n.condition));
    const rank = (n: MemNpc): number => {
      if (n.important) return 0;
      const p = classifyNpcPresence(n, memory.scenes, here, locPath);
      return p === 'present' ? 1 : p === 'nearby' || staleLastSeenRelation(n, memory.scenes, here, locPath) ? 2 : -1;
    };
    injured
      .map(n => ({ n, r: rank(n) }))
      .filter(x => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .forEach(({ n }) => subjects.push({ name: n.name, condition: n.condition, conditionTime: n.conditionTime, conditionFloor: n.conditionFloor }));
  }
  if (!subjects.length) return '';
  const now = latestStoryTime(chat) || memory.state.time;
  return fmtInjuryReminder(subjects, now, floor => aiFloorsAfter(chat, floor));
}

/** 主角不参与 NPC 在场分档;已有字段始终完整注入。年龄按锚点+当前故事时间推算(now)。 */
function fmtProtagonistContext(protagonist: MemProtagonist, name: string, now: string): string {
  const fields: Array<[string, string | undefined]> = [
    ['性别', protagonist.gender],
    ['年龄', ageDisplay(protagonist.age, protagonist.ageTime, now)],
    ['身份', protagonist.identity],
    ['外貌', protagonist.appearance],
    ['着装', protagonist.outfit],
    ['身体状态', protagonist.condition],
  ];
  const lines = fields
    .filter(([, value]) => oneLine(value))
    .map(([label, value]) => `  - ${label}:${oneLine(value)}`);
  if (!lines.length) return '';
  return `${oneLine(name) || '主角'}:\n${lines.join('\n')}`;
}

/** 把 NPC 的「即时状态」(着装/状态/所在)拼成一段尾注;无则空串。供在场与主要角色组复用。 */
function npcStateTail(n: MemNpc, withPlace: boolean, placeLabel?: string): string {
  const tail: string[] = [];
  if (oneLine(n.outfit)) tail.push(`最后记录着装:${oneLine(n.outfit)}`);
  if (oneLine(n.condition)) tail.push(`最后记录身体状态:${oneLine(n.condition)}`);
  if (withPlace) {
    if (n.follow) tail.push('随行');
    else tail.push(placeLabel || npcLocationLabel(n));
  }
  return tail.length ? ` 〔${tail.join(';')}〕` : '';
}

/** 位置已过期、最后确认的地点就在主角所在处或附近时的写法(时间取最后确认时的故事时间)。 */
function lastSeenLabel(n: MemNpc, rel: 'same' | 'near'): string {
  const time = n.lastKnownLocation?.place === n.location && n.lastKnownLocation?.time ? `（${oneLine(n.lastKnownLocation.time)}）` : '';
  return `最后确认在${rel === 'same' ? '此处' : '附近'}:${oneLine(n.location)}${time},之后未再确认`;
}

/** 「最后确认在此处/附近」的角色怎么写:既不默认消失,也不默认原地不动。 */
const LAST_SEEN_GUIDE = '按身份、作息和经过的时间判断是否还在:住处、店铺、岗位,或才过不久时多半仍在;不在时要交代去向或留下痕迹,不要无缘无故写成不见了';

/**
 * 关系的「称谓头」:取 relation 第一个逗号/分号/破折号前的部分(引导 AI 把称谓写在开头)。
 * 供不在场档用——「主角之兄」这种短称谓和性别同级重要(把亲哥写成陌生人与搞错性别同样致命),
 * 但整句态度描述在不在场档太贵,只留称谓。
 */
function relationHead(relation: string | undefined): string {
  const r = oneLine(relation);
  if (!r) return '';
  const head = r.split(/[,,;;、——]/)[0].trim();
  // 称谓应当很短;拿到一长句说明 AI 没按「称谓在前」写,整句注入反而贵 → 放弃
  return head.length <= 12 ? head : '';
}

/**
 * 不在场的有名字 NPC 最多列出的人数(按最近出场排序),以及每个预算单元的行数。
 * 不在场的人与眼前剧情关系最远:放在计划之后、按块进入注入预算,预算紧张时先省略这些块,
 * 不连累主要角色、在场角色和计划。超出人数的只说明数量。
 */
export const ABSENT_NPC_LIMIT = 24;
export const ABSENT_NPC_CHUNK = 8;

/** NPC 名册分段注入:主要角色、NPC(在场与同区域)、不在场 NPC(分块)。 */
export interface NpcContextBlocks {
  /** [主要角色] 段;没有主要角色时为空串 */
  main: string;
  /** [NPC名册] 段:在场与同区域的 NPC;都没有时为空串 */
  npc: string;
  /** 不在场或位置未确认、有名字的 NPC,每块一个预算单元 */
  absent: string[];
}

/**
 * 渲染 NPC 名册注入块(主要角色与 NPC 分开,NPC 再按在场分档省 token):
 *  - **主要角色**(important):不论在场与否都单列一段,带身份、关系、外貌、性格与即时状态(着装/状态/所在)。
 *  - 与其他角色的长期关系(ties)全局输出一次，不受在场分档影响。
 *  - NPC 在场(随行 / 所在地=主角当前节点)→ 全量:名 + 性别 + 年龄 + 身份 + 关系 + 性格 + 外貌 + 即时状态。
 *  - NPC **同区域**(抬头最多一级就与主角共处)→ 轻量:名 + 性别 + 年龄 + 身份 + 关系 + 性格 + 所在地。留个性格,免得 AI
 *    临时拉其出场时凭空 OOC;省略外貌与着装,保留身体状态以免漏掉行动限制。
 *  - NPC **最后确认在此处/附近**(位置因主角换场景或跨日而过期,但最后确认的地点就是主角所在处或附近,
 *    如过了一夜、主角回到原处)→ 单列,附最后确认时间和「按身份作息与经过时间判断是否还在」的说明;
 *    无名角色也发,免得回到原处时被写成不见了或换了个人。主要角色同样标出。
 *  - NPC 不在场(更上级祖先/更远旁支/位置未确认)→ 有名字的发一行:名 + 性别 + 关系称谓 + 身份 + 位置 + 已有好感档位(省略说明)
 *    + 最后记录身体状态;「职业 + 字母」的无名角色不发(回到对应地点会重新在场)。最多 ABSENT_NPC_LIMIT 人,按最近出场排序。
 * **性别在所有档都发**(包括不在场),防 AI 搞错性别;关系的**称谓头**同理(把亲哥写成陌生人同级严重)。
 * 年龄按锚点+当前故事时间(now)推算后注入,时间跳跃自动长岁。
 */
export function fmtNpcContextBlocks(npcs: MemNpc[], scenes: MemScene[], here: string, locationPath: string[] | undefined, now: string): NpcContextBlocks {
  const empty: NpcContextBlocks = { main: '', npc: '', absent: [] };
  if (!npcs.length) return empty;
  const main: MemNpc[] = [];
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  // 位置已过期、最后确认的地点就在主角所在处或附近(过了一夜、主角回到原处):单列提醒,不当成不在场
  const lastSeen: Array<{ n: MemNpc; rel: 'same' | 'near' }> = [];
  const absent: MemNpc[] = [];
  const seenRel = new Map<MemNpc, 'same' | 'near'>();
  for (const n of npcs) {
    const rel = staleLastSeenRelation(n, scenes, here, locationPath);
    if (rel) seenRel.set(n, rel);
    if (n.important) { main.push(n); continue; } // 主要角色单列,不再进在场判定
    const p = classifyNpcPresence(n, scenes, here, locationPath); // 与 NPC 页共用同一权威判定
    if (p === 'present') present.push(n);
    else if (p === 'nearby') nearby.push(n);
    else if (rel) lastSeen.push({ n, rel });
    else if (!isNpcLabelName(n.name)) absent.push(n); // 无名角色不在场时不发
  }
  const age = (n: MemNpc): string => oneLine(ageDisplay(n.age, n.ageTime, now));
  // 好感注入开关(设置页「注入设置」):关闭后名册照发,只不附带好感估计。
  // 摘要副 API 走 fmtNpcSummaryList,不受此开关影响——记录始终照常。
  const affinityOn = apiSettings.injection.npcAffinity;
  const aff = (n: MemNpc, partial = false, includeNote = true): string =>
    affinityOn ? fmtNpcAffinity(n, partial, includeNote) : '';

  // 离场可省外貌着装,不能让伤势和行动限制随位置分档消失;不截断条件或推演恢复。
  const lastCondition = (n: MemNpc): string => {
    const condition = oneLine(n.condition);
    return condition ? ` 身体状态(最后记录):${condition}` : '';
  };

  // 不在场名单按最近出场排序取前 ABSENT_NPC_LIMIT 人(派生的 lastFloor,旧数据回退 updatedAt)
  absent.sort((a, b) => (b.lastFloor ?? -1) - (a.lastFloor ?? -1) || b.updatedAt - a.updatedAt);
  const absentShown = absent.slice(0, ABSENT_NPC_LIMIT);
  const absentHidden = absent.length - absentShown.length;

  // 好感说明与长期关系各输出一次,放在第一段有内容的名册前面
  const preface: string[] = [];
  if ([...main, ...present, ...nearby, ...lastSeen.map(x => x.n), ...absentShown].some(n => aff(n))) preface.push(NPC_AFFINITY_BRIEFING);
  const ties = fmtNpcTiesContext(npcs);
  if (ties) preface.push(ties);
  const withPreface = (header: string, body: string): string => {
    const head = preface.length ? `${header}\n${preface.splice(0).join('\n')}` : header;
    return `${head}\n${body}`;
  };

  const out: NpcContextBlocks = { ...empty, absent: [] };
  if (main.length) {
    // 主要角色:身份、关系、外貌、性格,加即时状态面板(着装/状态/所在)。
    const detailed = main
      .map(n => {
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        const head = inBracket.length ? `${n.name}(${inBracket.join('·')})` : n.name;
        const profile: string[] = [];
        if (oneLine(n.relation)) profile.push(`与主角:${oneLine(n.relation)}`);
        if (oneLine(n.desc)) profile.push(`外貌:${oneLine(n.desc)}`);
        if (oneLine(n.personality)) profile.push(`性格:${oneLine(n.personality)}`);
        const affinity = aff(n);
        const rel = seenRel.get(n);
        return `  - ${head}${profile.length ? ` —— ${profile.join(';')}` : ''}${affinity ? ` 〔好感估计:${affinity}〕` : ''}${npcStateTail(n, true, rel ? lastSeenLabel(n, rel) : undefined)}`;
      })
      .join('\n');
    const lastSeenNote = main.some(n => seenRel.has(n)) ? `;标「最后确认在此处/附近」的,${LAST_SEEN_GUIDE}` : '';
    out.main = withPreface(`[主要角色](快照为最后记录,离场后不凭空推测延续或演变${lastSeenNote})`, detailed);
  }
  const npcParts: string[] = [];
  if (present.length) {
    const detailed = present
      .map(n => {
        const parts = [n.name];
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        if (inBracket.length) parts.push(`(${inBracket.join('·')})`);
        const profile: string[] = [];
        if (oneLine(n.relation)) profile.push(`与主角:${oneLine(n.relation)}`);
        const affinity = aff(n);
        if (affinity) profile.push(`好感估计:${affinity}`);
        if (oneLine(n.personality)) profile.push(`性格:${oneLine(n.personality)}`);
        if (oneLine(n.desc)) profile.push(oneLine(n.desc));
        const profileStr = profile.length ? ` —— ${profile.join(';')}` : '';
        const place = n.follow ? ' [随行]' : '';
        return `  - ${parts.join('')}${place}${profileStr}${npcStateTail(n, false)}`;
      })
      .join('\n');
    npcParts.push(`在场:\n${detailed}`);
  }
  if (nearby.length) {
    // 同区域保留性格及最后身体状态,省略外貌着装,不因未照面丢掉行动限制。
    const brief = nearby
      .map(n => {
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
        const profile: string[] = [];
        if (oneLine(n.relation)) profile.push(`与主角:${oneLine(n.relation)}`);
        const affinity = aff(n);
        if (affinity) profile.push(`好感估计:${affinity}`);
        if (oneLine(n.personality)) profile.push(`性格:${oneLine(n.personality)}`);
        const pers = profile.length ? ` —— ${profile.join(';')}` : '';
        const place = ` [${npcLocationLabel(n)}]`;
        return `  - ${n.name}${bracket}${pers}${place}${lastCondition(n)}`;
      })
      .join('\n');
    npcParts.push(`同区域(在附近但未必照面;需要时可让其自然登场,勿凭空改设定):\n${brief}`);
  }
  if (lastSeen.length) {
    // 最后确认在此处的带外貌,方便照面时按原样描写;都附最后身体状态。
    const lines = lastSeen
      .map(({ n, rel }) => {
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
        const profile: string[] = [];
        if (oneLine(n.relation)) profile.push(`与主角:${oneLine(n.relation)}`);
        const affinity = aff(n);
        if (affinity) profile.push(`好感估计:${affinity}`);
        if (oneLine(n.personality)) profile.push(`性格:${oneLine(n.personality)}`);
        if (rel === 'same' && oneLine(n.desc)) profile.push(oneLine(n.desc));
        const pers = profile.length ? ` —— ${profile.join(';')}` : '';
        return `  - ${n.name}${bracket}${pers} [${lastSeenLabel(n, rel)}]${lastCondition(n)}`;
      })
      .join('\n');
    npcParts.push(`最后确认在此处或附近(之后没有新的位置记录;${LAST_SEEN_GUIDE}):\n${lines}`);
  }
  if (npcParts.length) out.npc = withPreface('[NPC名册]', npcParts.join('\n'));
  if (absentShown.length) {
    // 不在场仍附最后身体状态;没有更新证据时不擅自清除或改变。
    const lines = absentShown.map(n => {
      const inBracket = [oneLine(n.gender), relationHead(n.relation), oneLine(n.title)].filter(Boolean);
      const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
      const loc = npcLocationLabel(n);
      const affinity = aff(n, false, false);
      return `  - ${n.name}${bracket}${loc ? ` [${loc}]` : ''}${affinity ? ` 〔好感估计:${affinity}〕` : ''}${lastCondition(n)}`;
    });
    if (absentHidden > 0) lines.push(`  (另有 ${absentHidden} 位较久未出场的角色未列出;未列出不代表不存在)`);
    for (let i = 0; i < lines.length; i += ABSENT_NPC_CHUNK) {
      const header = i === 0
        ? '[NPC名册·其他已知角色](不在场或当前位置未确认,不能据旧地点断言现在的去向)'
        : '[NPC名册·其他已知角色(续)]';
      const body = lines.slice(i, i + ABSENT_NPC_CHUNK).join('\n');
      out.absent.push(i === 0 ? withPreface(header, body) : `${header}\n${body}`);
    }
  }
  return out;
}

/** 前往草稿等需要整段文本的场合:三段按顺序拼起来。 */
function fmtNpcContext(npcs: MemNpc[], scenes: MemScene[], here: string, locationPath: string[] | undefined, now: string): string {
  const blocks = fmtNpcContextBlocks(npcs, scenes, here, locationPath, now);
  return [blocks.main, blocks.npc, ...blocks.absent].filter(Boolean).join('\n');
}

/**
 * 信息差注入:只列未结案、且此刻有不知情者在场的条目,写「谁不知道什么」和知情者。
 * 在场 = 名册判定在场(含随行)、局势卡在场名单、主角(始终在场)。最多 8 条,防止挤占预算。
 */
export function fmtSecretContext(
  secrets: MemSecret[],
  npcs: MemNpc[],
  scenes: MemScene[],
  here: string,
  locationPath: string[] | undefined,
  focus: SceneFocus | null,
  userName: string,
): string {
  const open = secrets.filter(s => s.status === 'open' && s.unaware.length);
  if (!open.length) return '';
  const present = new Set<string>();
  for (const n of npcs) if (classifyNpcPresence(n, scenes, here, locationPath) === 'present') present.add(n.name);
  for (const p of focus?.participants ?? []) if (p.trim()) present.add(p.trim());
  if (userName.trim()) present.add(userName.trim());
  const lines: string[] = [];
  for (const s of open) {
    const who = s.unaware.filter(name => present.has(name));
    if (!who.length) continue;
    const known = s.knownBy.length ? `(知情:${s.knownBy.map(oneLine).join('、')})` : '';
    lines.push(`- ${who.map(oneLine).join('、')}不知道:${oneLine(s.content)}${known}`);
    if (lines.length >= 8) break;
  }
  if (!lines.length) return '';
  return `[信息差·保持人物视角]\n${lines.join('\n')}\n(不知情者不能说出、提及或依据这些事行动,除非正文中有人告诉他们;这是写作参考,不要在正文中点破)`;
}

/**
 * 渲染指定地点视角下的物品上下文。
 * 正常状态注入与「前往地点」草稿共用这一入口，确保寄存物品的可达判定不会分叉。
 */
function fmtItemContext(items: MemItem[], scenes: MemScene[], here: string, locationPath?: string[]): string[] {
  const current = findCurrentScene(scenes, here, locationPath);
  const sceneIndex = buildSceneLocationIndex(scenes);
  const reachable: MemItem[] = [];
  const elsewhere: MemItem[] = [];

  for (const item of items) {
    if (item.carried !== false || itemReachableAtScene(scenes, item.location, current, here, sceneIndex, locationPath)) {
      reachable.push(item);
    } else {
      elsewhere.push(item);
    }
  }

  const blocks = [
    `物品清单:\n${fmtItems(reachable.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`,
  ];
  if (elsewhere.length) {
    const brief = elsewhere
      .map(i => `  - ${i.name}${typeof i.qty === 'number' ? ` ×${i.qty}` : ''}(存:${oneLine(i.location) || '某处'})`)
      .join('\n');
    blocks.push(`他处寄存物品(回到对应地点才有完整信息):\n${brief}`);
  }
  return blocks;
}

/**
 * 为场景页的「前往」操作生成可编辑的用户草稿。
 * 只临时把目标节点当作当前地点来计算场景、物品和 NPC 上下文，不修改 memory.state。
 */
export function buildTravelDraft(target: MemScene): string {
  const here = target.name;
  const locationPath = target.path;
  const destination = target.path.join(' › ');
  const blocks: string[] = [];

  const sceneBlock = fmtSceneContext(memory.scenes, here, locationPath);
  if (sceneBlock) blocks.push(`地点记忆:\n${sceneBlock}`);
  blocks.push(...fmtItemContext(memory.items, memory.scenes, here, locationPath));

  const npcBlock = fmtNpcContext(memory.npcs, memory.scenes, here, locationPath, memory.state.time);
  if (npcBlock) blocks.push(npcBlock);

  return [
    `前往「${destination}」，请从抵达后继续剧情。`,
    `以下是抵达该地点后的相关记忆，请保持设定一致:\n${blocks.join('\n')}`,
  ].join('\n\n');
}

/** 组合当前结构化状态注入文本;无有意义状态时返回空串。 */
export function buildStateInjectionText(): string {
  // 仅摘要模式保留内部状态供副 API、页面和公开查询使用,主模型只接收剧情摘要。
  if (apiSettings.summaryOnlyMode) return '';

  // 注入设置(设置页「注入设置」区):只影响这里发给主模型的内容;
  // 副 API 摘要走 prompts.ts 自己的状态渲染,始终见全量、照常记录,不受这些开关影响。
  // 依赖:NPC 在场分档 / 物品可达判定都走场景树 → 场景不注入时 NPC/物品随之不注入。
  const inj = apiSettings.injection;
  const scenesOn = inj.scenes;
  const npcsOn = inj.npcs && scenesOn;
  const itemsOn = inj.items && scenesOn;

  const st: string[] = [];
  if (memory.state.time) {
    // 周几只在标准公历带年份时有(weekdayLabel 自带门槛),古风/架空时间不标
    const wd = weekdayLabel(memory.state.time);
    st.push(`当前时间:${memory.state.time}${wd ? ` (${wd})` : ''}`);
  }
  if (memory.state.location) st.push(`当前地点:${oneLine(memory.state.location)}`);

  // 互动局势卡:衔接当下场面。tension/将发生仅作隐性氛围约束,明确告知勿点破——防过度提及。
  const focus = memory.state.sceneFocus;
  if (inj.sceneFocus && focus) {
    const bits: string[] = [`局面:${oneLine(focus.situation)}`];
    const who = focus.participants.map(oneLine).filter(Boolean).join('、');
    if (who) bits.push(`在场:${who}`);
    if (focus.currentFocus) bits.push(`当前焦点:${oneLine(focus.currentFocus)}`);
    if (focus.tension) bits.push(`互动张力:${oneLine(focus.tension)}(隐性氛围约束:自然体现即可,不要点破或反复提及)`);
    if (focus.pendingBeat) bits.push(`即将发生:${oneLine(focus.pendingBeat)}(自然过渡即可,勿生硬推进)`);
    st.push(`[当前互动局势]\n${bits.join('\n')}`);
  }

  // 生活小档案:置顶常驻 + 关键词触发的时效/沉降层。「记住 ≠ 每回合必提」——没命中就不出现。
  // 记录始终开启(无开关);这里 injection.lifeDetails 只管「注入」。
  if (inj.lifeDetails && memory.lifeDetails.length) {
    const picked = selectLifeDetailsForInjection(memory.lifeDetails, recentContextText(), memory.state.time, calculateRelativeDays);
    if (picked.length) {
      const lines = picked.map(d => `- ${oneLine(fmtLifeDetail(d, getContext()?.name1?.trim() || '主角'))}`);
      st.push(`[生活小档案·按人物]\n${lines.join('\n')}\n(每条仅属于姓名标明的人,不可混用给主角或其他角色;仅在与当前对话自然相关时参考,不要逐条复述或刻意提及,用不上就忽略。档案存在不代表其他角色已知这些细节,仍遵守剧情视角)`);
    }
  }

  // 主角状态自包含,不依赖场景树,独立开关。
  if (inj.protagonist) {
    const protagonistBlock = fmtProtagonistContext(memory.protagonist, getContext()?.name1 ?? '', memory.state.time);
    if (protagonistBlock) st.push(`[主角当前状态]\n${protagonistBlock}`);
  }

  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  // 场景树:当前地点 + 祖先链(详细) + 其他地点(仅名称)。祖先链同时用于物品/NPC 可达判定。
  if (scenesOn) {
    const sceneBlock = fmtSceneContext(memory.scenes, here, locPath);
    if (sceneBlock) st.push(`地点记忆:\n${sceneBlock}`);
  }

  // 物品分两组省 token:可达(随身 / 存放地落在当前地点或其祖先链)发全量(名+量+描述);
  // 他处寄存的只发名+数量(砍掉描述这个大头),既省 token 又不至于让主模型以为东西没了。
  if (itemsOn) st.push(...fmtItemContext(memory.items, memory.scenes, here, locPath));
  // 注:近期物品变动不在此注入。改为摘要后写进对应楼层正文 </bbs_end> 之后(见 engine.ts),
  // 窗口内全文楼层天然可见、滚出窗口自然消失 —— 符合「物品变动只在那段时间有用」的取舍。

  // 人物分三段:主角(上方 [主角当前状态])、主要角色、NPC 名册。NPC 按在场分档压缩,但所有档均保留身体状态;
  // 不在场的 NPC 按块放到计划之后,预算紧张时先省略它们。最终仍受原注入预算与开关约束。
  const npcBlocks = npcsOn ? fmtNpcContextBlocks(memory.npcs, memory.scenes, here, locPath, memory.state.time) : null;
  if (npcBlocks?.main) st.push(npcBlocks.main);
  if (npcBlocks?.npc) st.push(npcBlocks.npc);

  // 信息差:依赖名册的在场判定,随名册开关;记录始终开启,这里只管注入
  if (npcsOn && inj.secrets) {
    const secretBlock = fmtSecretContext(memory.secrets, memory.npcs, memory.scenes, here, locPath, memory.state.sceneFocus, getContext()?.name1 ?? '');
    if (secretBlock) st.push(secretBlock);
  }

  // 伤势进展提醒:伤情记录满一天(没有故事时间时按回复楼层数)未更新,提醒正文模型在相关时按轻重体现进展;只提醒随正文发送的角色。
  if (inj.injuryReminder) {
    const reminder = buildInjuryReminder(inj.protagonist, npcsOn);
    if (reminder) st.push(reminder);
  }

  const openPlans = memory.plans
    .filter(p => p.status === 'open')
    .map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime }));
  st.push(`未了结的计划/悬念:\n${fmtPlans(openPlans)}`);

  // 近期已完成的计划/悬念:防 AI 把刚了结的当未完成又去推进。与副API摘要同口径,只差截止点
  // (这里用全量 memory.plans;副API用 deriveMemory(chat, beforeIndex).plans)。
  const recentResolved = selectRecentResolvedPlans(memory.plans, apiSettings.recentResolvedPlansCount);
  if (recentResolved.length) st.push(`近期已了结(已结案,含了结方式与原因;不要当作未完成再推进):\n${fmtResolvedPlans(recentResolved)}`);

  // 不在场的 NPC:按最近出场分块,排在计划之后
  if (npcBlocks?.absent.length) st.push(...npcBlocks.absent);

  // 自定义变量:发当前状态 + 各字段「含义」给主模型(帮它理解并保持数值/设定连贯),明确框定为只读。
  // ⚠️ 绝不注入「变化规则」(rule)——那是给副API摘要用的「如何增删改」指令(含 set/assign 命令语法);
  //    主模型看到「何时怎么变」会误以为该在正文里输出/复述变量或命令。含义只描述「是什么」,给主模型安全。
  const varMeaning = (['global', 'char', 'chat'] as const)
    .map(t => memory.varTemplates[t].meaning.trim())
    .filter(Boolean)
    .join('\n\n');
  const hasVarState = Object.keys(memory.vars).length > 0;
  if (hasVarState) {
    let block = `自定义变量(当前状态,只读参考——严禁在正文里复述、罗列或输出这些变量/命令):\n${renderVarsState(memory.vars)}`;
    if (varMeaning) block += `\n变量含义(仅帮你理解上面的值,不要输出):\n${varMeaning}`;
    st.push(block);
  }

  // 状态块在有任何有意义内容时才注入(物品/计划即使空也会有「(无)」占位,
  // 但只要存在摘要或时间/地点就值得带上整块)
  const hasProtagonist = inj.protagonist && PROTAGONIST_TEXT_FIELDS.some(key => !!oneLine(memory.protagonist[key]));
  const hasState = memory.state.time || memory.state.location || (inj.sceneFocus && memory.state.sceneFocus) || hasProtagonist || (itemsOn && memory.items.length) || (scenesOn && memory.scenes.length) || (npcsOn && memory.npcs.length) || openPlans.length || hasVarState || (inj.lifeDetails && memory.lifeDetails.length);
  if (!hasState) return '';
  // 首尾私密简报框定,避免主模型把状态快照当成要复述/输出的模板(正文后跟吐一份状态)
  return fitMemoryUnits(st, 'state', `${MEMORY_BRIEFING_NOTE}\n[当前状态]`, MEMORY_BRIEFING_END).text;
}

/**
 * 组合注入文本:已启用的历史摘要 + 当前结构化状态(时间/地点/物品/未了结计划)。
 * 保留给调试/兼容调用;实际注入由 refreshInjection 拆成两个 ST 槽位。
 */
export function buildInjectionText(): string {
  return [buildHistoryInjectionText(), buildStateInjectionText()].filter(Boolean).join('\n\n').trim();
}

/** 按 ST 自身 tokenizer 不可用时的兜底口径估算文本 token 数。 */
function estimateTextTokens(blocks: string[]): number {
  const bytes = blocks.filter(Boolean).reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
  return Math.ceil(bytes / 3.35);
}

/**
 * 估算当前实际会注入主对话的 token 数,拆成摘要与其他两类。
 * “其他”包含当前结构化状态、只读账本协议与时间标签提示词。
 * 这里只用于给用户一个直观量级,不请求后端,也不计聊天模板包装带来的少量额外 token。
 */
export function estimateInjectionTokenBreakdown(): { summary: number; other: number } {
  if (!engineActiveHere()) return { summary: 0, other: 0 };

  return {
    summary: estimateTextTokens([buildHistoryInjectionText()]),
    other: estimateTextTokens([
      buildStateInjectionText(),
      LEDGER_PROTOCOL,
      apiSettings.autoSummaryEnabled ? fitTimeTagPrompt(timeTagPrompt()) : '',
    ]),
  };
}

/** 把当前记忆刷新到 ST 的扩展提示槽。ST 未就绪/旧版无此 API 时静默跳过。 */
export function refreshInjection(): void {
  if (memoryWriteIssue()) { clearInjection(); return; }
  // 引擎在此聊天不生效(总开关关 / 当前角色被排除):清掉已注入的槽。
  // 用 clearInjection 而非直接 return —— 切到被排除角色时必须抹掉上个聊天残留的注入。
  if (!engineActiveHere()) {
    clearInjection();
    return;
  }
  const ctx = getContext();
  const fn = ctx?.setExtensionPrompt;
  if (typeof fn !== 'function') return;
  const stateDepth = resolveStateInjectionDepth(ctx?.chat ?? null);
  fn(LEGACY_INJECT_KEY, '', IN_CHAT, STATE_INJECT_DEPTH_BEFORE_LATEST_AI, false, ROLE_SYSTEM, null);
  fn(HISTORY_INJECT_KEY, buildHistoryInjectionText(), IN_CHAT, HISTORY_INJECT_DEPTH, false, ROLE_SYSTEM, null);
  fn(STATE_INJECT_KEY, buildStateInjectionText(), IN_CHAT, stateDepth, false, ROLE_SYSTEM, null);
  // 旧旁注即使在仅摘要模式/关闭自动摘要后仍可能存在,分工协议始终随引擎注入。
  fn(LEDGER_INJECT_KEY, LEDGER_PROTOCOL, IN_CHAT, 0, false, ROLE_SYSTEM, null);
  // 时间标签固定提示词:跟随自动摘要开关注入主对话,关闭时注入空串(等于清除)
  fn(TIMETAG_INJECT_KEY, apiSettings.autoSummaryEnabled ? fitTimeTagPrompt(timeTagPrompt()) : '', IN_CHAT, TIMETAG_INJECT_DEPTH, false, ROLE_SYSTEM, null);
}

/** 清除注入(注入空串)。切到无记忆的聊天时由 refreshInjection 自动完成,此处供显式调用。 */
export function clearInjection(): void {
  const ctx = getContext();
  const stateDepth = resolveStateInjectionDepth(ctx?.chat ?? null);
  ctx?.setExtensionPrompt?.(LEGACY_INJECT_KEY, '', IN_CHAT, STATE_INJECT_DEPTH_BEFORE_LATEST_AI, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(HISTORY_INJECT_KEY, '', IN_CHAT, HISTORY_INJECT_DEPTH, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(STATE_INJECT_KEY, '', IN_CHAT, stateDepth, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(LEDGER_INJECT_KEY, '', IN_CHAT, 0, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(TIMETAG_INJECT_KEY, '', IN_CHAT, TIMETAG_INJECT_DEPTH, false, ROLE_SYSTEM, null);
}
