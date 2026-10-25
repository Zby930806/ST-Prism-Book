import { taskContextPrompt } from '@/memory/taskContext';
/**
 * 向量召回的查询重写(Query Rewrite)。
 *
 * 复刻 Horae 的「小模型把当前剧情重写成 INTENT + 多条检索 Q」思路与提示词(用户已优化版),
 * 但**上下文构造是棱镜宝书自己的**(见 .carryover-plan.md「查询重写上下文构造」):
 *  结构 = [历史剧情摘要] + 最近窗口全文 + [状态快照] + [用户输入]
 *  - 状态一律走 deriveMemory(不假设 getLatestState 干净);
 *  - 状态快照精确放置:从窗口起点扫到第一个「无有效叶子」的楼停下,
 *    快照 = deriveMemory(chat, 洞楼index),插在「连续叶子前缀末尾」之后、洞楼之前;
 *  - 快照只含**滚出窗口的主角档案/items/plans**(时间/地点/在场已在全文里,不重复)。
 *
 * 产出多条 query,各自 embed → 后端 vec/search 多路检索 + RRF 融合;INTENT 兼作 rerank 的 query
 * (INTENT 为空或因超长被清空时,召回端改用全部检索语句拼成的文本)。
 * 附带的上下文超过「附带上下文上限」(默认 16000 字)时按新近和相关程度精简:最近几楼从新到旧保留,
 * 状态快照只带随身物品、在场或同区域的人物和最近几楼提到名字的物品与人物,历史摘要从新到旧保留。
 * 上限填 0 时不精简(1.4.0 及以前的做法)。
 * 任何失败都抛错,由召回侧 catch 后清空召回槽,不阻断正文生成。
 */

import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { apiSettings, resolveVectorModel } from '@/api/settings';
import { classifyNpcPresence, deriveMemory, getLeaf, leafValid } from '../apply';
import { resolveKeepStart } from '../engine';
import { renderHistoryNodes, selectHistoryNodesBefore } from '../inject';
import { fmtItems, fmtNpcs, fmtPlans, fmtProtagonist, QUERY_REWRITE_SYSTEM, QUERY_REWRITE_TAIL } from '../prompts';
import { memory } from '../store';
import { cleanBody } from '../timeTag';
import type { RecallRewriteStats } from './debug';
import { EmbedError, fetchWithTimeoutRetry, vectorFailure } from './embed';
import { normalizeQueryRewriteContextChars, normalizeQueryRewriteMaxTokens, runtimeEndpoint } from './params';
import { classifyHttpFailure, emptyReply, finishKind, truncatedReply } from '@/api/errors';

/** rewrite 模型最多取几条 query(对齐 Horae) */
const MAX_QUERIES = 5;
/** 单条 query 限长:超出整条丢弃(不截断,以免截掉句末的否定或条件) */
const MAX_QUERY_LEN = 220;
/** INTENT 限长:超出时清空,重排改用全部检索语句 */
const MAX_INTENT_LEN = 400;

export interface RewriteResult {
  /** 场景意图描述(兼作 rerank 的 query);为空时召回端改用全部检索语句做重排查询 */
  intent: string;
  /** 多条检索 query(已去重限长) */
  queries: string[];
  /** 这次请求的规模(发送字数、精简情况、token 用量、是否在思考);parseResponse 不带 */
  stats?: RecallRewriteStats;
}

/** parseResponse 的完整结果:另外带出解析过程,供报错区分原因。 */
export interface ParsedRewrite extends RewriteResult {
  /** 认出的 Q 行数(含因超长丢弃、重复的) */
  queryLines: number;
  /** 因超过长度上限整条丢弃的 Q 行数 */
  droppedLong: number;
  /** INTENT 是否因超长被清空 */
  intentDropped: boolean;
  /** 回复只有思考过程(<think> 没有闭合),没有正文 */
  thinkingOnly: boolean;
}

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 把楼层正文清洗成可读文本,与喂摘要模型同口径(cleanBody:裁正文段 + 整块删噪声标签 + 时间转文本)。 */
function cleanFloor(m: STMessage): string {
  return cleanBody(m.mes);
}

/** 状态快照开头的说明行。 */
const SNAPSHOT_HEAD = '[状态快照:以下为已滚出最近窗口、但仍有效的主角档案、物品、NPC 与未了结计划,供你解析模糊指代]';
const PROTAGONIST_TITLE = '主角当前档案:';

/** 状态快照的一节:标题 + 逐行内容。计划悬念超出上限时删最早的,其余列表删最后的。 */
interface SnapshotSection {
  title: string;
  lines: string[];
  dropFromStart?: boolean;
  /** 精简时删过条目 */
  omitted?: boolean;
}

/**
 * 状态快照的各节(只含滚出窗口、长期有效的主角档案、物品、NPC 与未了结计划)。
 * upTo = 第一个无叶子楼的索引(快照截到它之前)。
 * 给出 focus(精简时附带的最近几楼正文)时,物品只带随身的和 focus 里提到名字的,
 * 人物只带在场、在附近、随行的和 focus 里提到名字的;不给时全部带上(不限制上下文时的做法)。
 */
function snapshotSections(chat: STMessage[], upTo: number, focus?: string): SnapshotSection[] {
  const st = deriveMemory(chat, upTo);
  const sections: SnapshotSection[] = [];
  const mentioned = (name: string | undefined) => {
    const n = (name ?? '').trim();
    return focus !== undefined && n.length >= 2 && focus.includes(n);
  };
  if (Object.values(st.protagonist).some(Boolean)) {
    sections.push({ title: PROTAGONIST_TITLE, lines: fmtProtagonist(st.protagonist).split('\n') });
  }
  const items = focus === undefined ? st.items : st.items.filter(i => i.carried !== false || mentioned(i.name));
  if (items.length) {
    sections.push({ title: '物品清单:', lines: fmtItems(items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location }))).split('\n') });
  }
  const npcs = focus === undefined ? st.npcs : st.npcs.filter(n => {
    const presence = classifyNpcPresence(n, st.scenes ?? [], st.state?.location ?? '', st.state?.locationPath);
    return presence === 'present' || presence === 'nearby' || mentioned(n.name);
  });
  if (npcs.length) {
    sections.push({ title: 'NPC名册:', lines: fmtNpcs(npcs.map(n => ({ name: n.name, gender: n.gender, title: n.title, follow: n.follow, location: n.location, locationStale: n.locationStale, lastKnownLocation: n.lastKnownLocation }))).split('\n') });
  }
  const openPlans = st.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    sections.push({ title: '未了结的计划/悬念:', lines: fmtPlans(openPlans.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime }))).split('\n'), dropFromStart: true });
  }
  return sections;
}

/** 拼出状态快照文本;没有任何一节时返回空串。删过条目的节末尾注明从略。 */
function renderSnapshot(sections: SnapshotSection[]): string {
  const parts = sections
    .filter(s => s.lines.length || s.omitted)
    .map(s => `${s.title}\n${[...s.lines, ...(s.omitted ? ['  (其余从略)'] : [])].join('\n')}`);
  return parts.length ? `${SNAPSHOT_HEAD}\n${parts.join('\n')}` : '';
}

/** 把快照压到 limit 字以内:每次从条目最多的列表删一条(主角档案不删),删到放得下或列表删空为止。 */
function fitSnapshot(sections: SnapshotSection[], limit: number): string {
  let text = renderSnapshot(sections);
  while (text.length > limit) {
    const lists = sections.filter(s => s.title !== PROTAGONIST_TITLE && s.lines.length);
    if (!lists.length) break;
    const longest = lists.reduce((a, b) => (b.lines.length > a.lines.length ? b : a));
    if (longest.dropFromStart) longest.lines.shift();
    else longest.lines.pop();
    longest.omitted = true;
    text = renderSnapshot(sections);
  }
  return text;
}

/**
 * 找状态快照的插入点:从窗口起点向后扫,返回第一个「无有效叶子」楼的索引。
 * 全部有叶子则返回 chat.length(快照截到全部窗口,放最末)。
 */
function findSnapshotCut(chat: STMessage[], windowStart: number): number {
  for (let i = windowStart; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) return i;
  }
  return chat.length;
}

interface ConvoEntry {
  role: 'user' | 'assistant';
  content: string;
  /** 在聊天里的楼层号,用来定位快照插入点 */
  index: number;
}

/** 截短到一楼时至少保留这么多字;更少就整楼不带。 */
const MIN_FLOOR_KEEP = 400;
/** 精简时最近几楼至少能用上限的这一份,状态快照至少这一份,其余留给历史摘要。 */
const WINDOW_SHARE = 0.55;
const SNAPSHOT_SHARE = 0.2;

/** 一楼放不下时截短:用户的话保留开头,回复保留结尾(结尾离当前剧情最近)。 */
function shortenFloor(c: ConvoEntry, keep: number): ConvoEntry {
  const room = Math.max(0, keep - 6);
  const content = c.role === 'user' ? `${c.content.slice(0, room)}……(后略)` : `(前略)……${c.content.slice(-room)}`;
  return { ...c, content };
}

/** 最近几楼从新到旧放进 limit 字;最新的一楼一定带上,放不下就截短。 */
function fitWindow(convo: ConvoEntry[], limit: number): ConvoEntry[] {
  const kept: ConvoEntry[] = [];
  let used = 0;
  for (let i = convo.length - 1; i >= 0; i--) {
    const c = convo[i];
    const remaining = limit - used;
    if (c.content.length <= remaining) {
      kept.unshift(c);
      used += c.content.length;
      continue;
    }
    const keep = kept.length ? remaining : Math.max(remaining, MIN_FLOOR_KEEP);
    if (keep >= MIN_FLOOR_KEEP) kept.unshift(shortenFloor(c, keep));
    break;
  }
  return kept;
}

/** 历史摘要从新到旧放进 limit 字;放不下的更早部分整条略去,并在开头注明。 */
function fitHistory(nodes: ReturnType<typeof selectHistoryNodesBefore>, limit: number): string {
  const parts = nodes.map(n => renderHistoryNodes([n]));
  const kept: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const cost = parts[i].length + (kept.length ? 2 : 0);
    if (used + cost > limit) break;
    kept.unshift(parts[i]);
    used += cost;
  }
  if (kept.length === parts.length) return parts.join('\n\n');
  return kept.length ? `(更早的剧情从略)\n\n${kept.join('\n\n')}` : '';
}

/** buildMessages 的结果:消息序列和附带上下文的规模。 */
interface BuiltMessages {
  messages: ChatMsg[];
  /** 附带上下文(历史摘要 + 最近几楼 + 状态快照)精简前的字数 */
  contextChars: number;
  /** 实际附带的字数 */
  sentContextChars: number;
  trimmed: boolean;
}

const totalChars = (entries: Array<{ content: string }>) => entries.reduce((n, c) => n + c.content.length, 0);

/**
 * 构造发给 rewrite 模型的消息序列。
 *
 * ⚠️ 许多向量渠道要求 system 消息**仅允许出现在数组最开头**,中间不得再有 system。
 * 故对齐 Horae 的形态:**开头唯一一条 system + 中间纯 user/assistant 对话 + 结尾一条 user**。
 *  - 历史剧情摘要并入开头那条 system(属背景设定,合法地待在开头);
 *  - 状态快照不独立成 system,而是**拼进对话消息正文**(放在 cut 点前一条之后、洞楼之前),
 *    保持中间无 system,从而兼容「system 只能在开头」的渠道。
 *
 * cap = 附带上下文的字数上限(0 = 不限制)。超出时先放最近几楼(从新到旧),再放精简后的状态快照,
 * 剩下的给历史摘要(从新到旧);历史和快照用不完的份额让给最近几楼。
 */
function buildMessages(chat: STMessage[], cap: number): BuiltMessages {
  const windowStart = resolveKeepStart(chat);
  const cut = findSnapshotCut(chat, windowStart);
  const nodes = selectHistoryNodesBefore(memory.summaries, chat, windowStart);
  const fullHistory = renderHistoryNodes(nodes);

  // 平铺窗口对话(纯 user/assistant),记录原 msgIndex 以定位快照插入点
  const convo: ConvoEntry[] = [];
  for (let i = windowStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    if (m.extra?.bbs_omit) continue;
    if (m.is_system && m.extra?.type) continue; // 原生系统楼跳过
    const text = cleanFloor(m);
    if (!text) continue;
    convo.push({ role: m.is_user ? 'user' : 'assistant', content: text, index: i });
  }
  // 语义 = 截止 cut(第一个无叶子楼)之前的确凿状态
  const fullSnapshot = renderSnapshot(snapshotSections(chat, cut));
  const contextChars = fullHistory.length + totalChars(convo) + fullSnapshot.length;

  let history = fullHistory;
  let kept = convo;
  let snapshot = fullSnapshot;
  const trimmed = cap > 0 && contextChars > cap;
  if (trimmed) {
    const snapshotNeed = Math.min(fullSnapshot.length, Math.floor(cap * SNAPSHOT_SHARE));
    kept = fitWindow(convo, Math.max(Math.floor(cap * WINDOW_SHARE), cap - snapshotNeed - fullHistory.length));
    const windowUsed = totalChars(kept);
    snapshot = fitSnapshot(
      snapshotSections(chat, cut, kept.map(c => c.content).join('\n')),
      Math.max(Math.floor(cap * SNAPSHOT_SHARE), cap - windowUsed - fullHistory.length),
    );
    history = fitHistory(nodes, Math.max(0, cap - windowUsed - snapshot.length));
  }

  // 开头唯一 system:系统提示词 +(可选)历史剧情摘要,合并为一条,保证 system 只出现在开头
  let systemContent = history ? `${QUERY_REWRITE_SYSTEM}\n\n[历史剧情摘要]\n${history}` : QUERY_REWRITE_SYSTEM;
  // 启用附加任务说明时,置顶拼进开头这条唯一 system。
  // 不新增一条 system,以守住「system 仅允许出现在数组最开头」的渠道约束——拼进即等于「最开头 + system 身份」。
  // 与摘要/总结共用 default/custom/disabled 解析;自定义空白不回退默认。
  if (apiSettings.vector.queryRewriteJailbreak) {
    const jb = taskContextPrompt();
    if (jb) systemContent = `${jb}\n\n${systemContent}`;
  }
  const messages: ChatMsg[] = [{ role: 'system', content: systemContent }];

  // 状态快照:拼进对话消息正文(不独立成 system)
  const dialog = kept.map(c => ({ ...c }));
  if (snapshot) {
    if (!dialog.length) {
      // 窗口无可用对话消息 → 兜底放一条 user 承载(仍非 system)
      messages.push({ role: 'user', content: snapshot });
    } else {
      const cutPos = dialog.findIndex(c => c.index >= cut);
      if (cutPos === -1) {
        // cut 在所有对话之后(窗口全有叶子)→ 拼进最后一条末尾
        const last = dialog[dialog.length - 1];
        last.content = `${last.content}\n\n${snapshot}`;
      } else if (cutPos === 0) {
        // cut 点即首条对话(之前无对话可承载)→ 拼进它的前缀
        dialog[0].content = `${snapshot}\n\n${dialog[0].content}`;
      } else {
        // 拼进 cut 点前一条对话的末尾(连续叶子前缀末尾之后、洞楼之前)
        const prev = dialog[cutPos - 1];
        prev.content = `${prev.content}\n\n${snapshot}`;
      }
    }
  }

  for (const c of dialog) messages.push({ role: c.role, content: c.content });

  // 收尾提示词
  messages.push({ role: 'user', content: QUERY_REWRITE_TAIL });
  return { messages, contextChars, sentContextChars: history.length + totalChars(kept) + snapshot.length, trimmed };
}

/** base url 规整到 /chat/completions 端点 */
function chatCompletionsEndpoint(rawUrl: string): string {
  const base = String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/chat\/completions$/i, '');
  return base ? `${base}/chat/completions` : '';
}

/** 行首可重复出现的 Markdown/列表标记(引用 >、标题 #、加粗/斜体 * _、列表 - •),以及一个数字编号。 */
function stripLineMarkers(raw: string): string {
  return raw
    .replace(/^[\s>#*_\-•·]+/, '')
    .replace(/^\d+\s*[.)、．）]\s*/, '')
    .replace(/^[\s*_]+/, '')
    .trim();
}

/** 标签后面可以跟着收尾的 **、__(如 `**INTENT:**`、`**Q1**:`),Q 编号后接受冒号、句点、顿号或右括号。 */
const INTENT_LINE = /^INTENT\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.+)$/i;
const QUERY_LINE = /^Q\s*\d*\s*(?:\*\*|__)?\s*[:：.．、)）]\s*(?:\*\*|__)?\s*(.+)$/i;

/**
 * 去掉思考过程:整段闭合的 <think>/<thinking> 块先删掉;只剩结尾标签时,它之前都算思考;
 * 开始标签没有闭合时,之后都算思考。返回剩下的正文,以及是否遇到了没闭合的思考块。
 */
function stripThinking(text: string): { body: string; unclosed: boolean } {
  let body = text.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const lower = body.toLowerCase();
  const close = Math.max(lower.lastIndexOf('</think>'), lower.lastIndexOf('</thinking>'));
  if (close >= 0) body = body.slice(close).replace(/^<\/think(?:ing)?>/i, '');
  const open = body.search(/<think(?:ing)?\b/i);
  if (open >= 0) return { body: body.slice(0, open), unclosed: true };
  return { body, unclosed: false };
}

/**
 * 解析 INTENT + 多行 Q(对齐 Horae:去前缀符号、去重、限长)。
 * 容忍常见的格式偏差:行首的 Markdown 标记和编号、加粗的标签、「Q1.」「Q1、」这类编号写法。
 * 超长的 Q 整条丢弃(不截断);超长的 INTENT 清空,由召回端改用全部检索语句做重排查询。
 */
export function parseResponse(text: string): ParsedRewrite {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n');
  // 即便请求关了 enable_thinking,个别模型仍会吐思考过程,先去掉再逐行解析,
  // 否则思维链里出现的 INTENT/Q 字样会污染解析结果。
  const { body, unclosed } = stripThinking(normalized);
  const lines = body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let intent = '';
  let intentDropped = false;
  let queryLines = 0;
  let droppedLong = 0;
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = stripLineMarkers(raw);
    const im = line.match(INTENT_LINE);
    if (im) {
      intent = sanitize(im[1], MAX_INTENT_LEN);
      intentDropped = !intent && !!cleanValue(im[1]);
      continue;
    }
    const qm = line.match(QUERY_LINE);
    if (qm) {
      queryLines++;
      const q = sanitize(qm[1]);
      if (!q) {
        if (cleanValue(qm[1])) droppedLong++;
        continue;
      }
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(q);
      if (queries.length >= MAX_QUERIES) break;
    }
  }
  return {
    intent,
    queries,
    queryLines,
    droppedLong,
    intentDropped,
    thinkingOnly: unclosed && !queryLines && !intent,
  };
}

/** 去掉包在值两端的引号、反引号和 Markdown 标记,压缩空白。 */
function cleanValue(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitize(text: string, limit = MAX_QUERY_LEN): string {
  const clean = cleanValue(text);
  // 单条查询视为完整语义单元;句号后的否定也可能改变前句,不能只保留前半段。
  return clean.length <= limit ? clean : '';
}

/** 解析结果里没有可用检索语句时,按原因写一句说明(含处理方法与设置位置)。 */
function noQueryMessage(parsed: ParsedRewrite): string {
  const where = '「设置 → 向量记忆 → Query 重写」';
  if (parsed.thinkingOnly) {
    return `Query 重写的回复只有思考过程，没有给出检索语句。可以在${where}调大「最大输出」，或换一个对话模型。`;
  }
  if (parsed.queryLines > 0 && parsed.droppedLong >= parsed.queryLines) {
    return `Query 重写给出的检索语句都超过 ${MAX_QUERY_LEN} 字，已整条丢弃（不截断，以免改变原意）。可以重新生成一次，或在${where}换一个更遵守格式的对话模型。`;
  }
  return `Query 重写的回复里没有检索语句（需要以「Q:」开头的行）。可以重新生成一次，或在${where}换一个对话模型。`;
}

/* ============ 服务商拒收的可选参数 ============ */

/**
 * 查询重写默认附带 enable_thinking:false(关闭国产模型默认的思维链)和 top_p。
 * 严格校验参数的接口会因为不认识它们返回 400/422:报错原文提到哪个参数,就去掉它重试,
 * 并按接口地址记住,本次会话内不再发送。
 */
const OPTIONAL_PARAMS = ['enable_thinking', 'top_p'] as const;
type OptionalParam = (typeof OPTIONAL_PARAMS)[number];
const droppedParams = new Map<string, Set<OptionalParam>>();

/** 清掉已记住的拒收参数(测试用)。 */
export function resetRewriteParamMemory(): void {
  droppedParams.clear();
}

function rejectedParams(status: number, body: string): OptionalParam[] {
  if (status !== 400 && status !== 422) return [];
  return OPTIONAL_PARAMS.filter(p => body.toLowerCase().includes(p));
}

/* ============ 慢请求补发 ============ */

/**
 * 重写请求等了这么久还没返回时,再发一个同样的请求,先返回的那个算数,另一个取消。
 * 服务商排队时偶尔会卡住几十秒(实测 Qwen3.5-27B 多数 4–10 秒返回,16 次里有 1 次等到 90 秒超时),
 * 同样的请求再发一次通常几秒就回来。只在慢的时候多花一次请求。
 */
export const REWRITE_HEDGE_AFTER_MS = 12000;

/**
 * 发出请求;超过 REWRITE_HEDGE_AFTER_MS 还没返回就补发一次,先返回的结果算数(包括报错的响应,交给调用方处理),
 * 另一个取消。补发前第一个请求就失败(超时、网络错误)时照常报错;补发后两个都失败才报错,报第一个的错。
 */
function hedgedFetch(start: (signal: AbortSignal) => Promise<Response>, external: AbortSignal | undefined, onHedge: () => void): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false, hedged = false, running = 0, firstError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortAll = () => { for (const c of controllers) c.abort(); };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      external?.removeEventListener('abort', abortAll);
      finish();
      abortAll(); // 取消还在等的那一个
    };
    external?.addEventListener('abort', abortAll, { once: true });
    const launch = () => {
      const ctrl = new AbortController();
      if (external?.aborted) ctrl.abort();
      controllers.push(ctrl);
      running++;
      start(ctrl.signal).then(
        resp => settle(() => resolve(resp)),
        error => {
          running--;
          if (firstError === undefined) firstError = error;
          if (!hedged || running === 0) settle(() => reject(firstError));
        },
      );
    };
    launch();
    timer = setTimeout(() => {
      if (settled || external?.aborted) return;
      hedged = true;
      onHedge();
      launch();
    }, REWRITE_HEDGE_AFTER_MS);
  });
}

/**
 * 执行查询重写。queryRewrite 端点未配 model 时抛错(调用方降级)。
 * 走前端直连 chat/completions(与 embed 同源策略,渠道地址/密钥可留空复用 embedding)。
 * 超时不重试:召回在正文生成前阻塞,超时多半是服务商卡住;服务端出错或限流时仍按重试次数重试。
 * 第一次请求 12 秒还没返回时补发一次(见 hedgedFetch)。
 */
export async function rewriteQuery(signal?: AbortSignal): Promise<RewriteResult> {
  const ep = runtimeEndpoint(resolveVectorModel('queryRewrite'), 'queryRewrite');
  if (!ep.model) throw new EmbedError('向量记忆还没有填写 Query 重写模型，请到「设置 → 向量记忆」里补全。', { kind: 'config' });
  const endpoint = chatCompletionsEndpoint(ep.url);
  if (!endpoint) throw new EmbedError('向量记忆还没有填写 Query 重写地址（或 Embedding 地址），请到「设置 → 向量记忆」里补全。', { kind: 'config' });

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!chat.length) throw new Error('无对话上下文可重写');

  const built = buildMessages(chat, normalizeQueryRewriteContextChars(apiSettings.vector.queryRewriteContextChars));
  const messages = built.messages;
  const maxTokens = normalizeQueryRewriteMaxTokens(apiSettings.vector.queryRewriteMaxTokens);
  const dropped = droppedParams.get(endpoint) ?? new Set<OptionalParam>();
  let hedged = false;
  const send = () => {
    // 对齐 Horae:低温更服从格式;enable_thinking:false 关思维链——
    // 国产模型(Qwen3/GLM 等)默认开思维链会先吐 <think> 推理,冲乱 INTENT/Q 行格式导致解析失败。
    const body: Record<string, unknown> = { model: ep.model, messages, temperature: 0.1, max_tokens: maxTokens, stream: false };
    if (!dropped.has('top_p')) body.top_p = 0.8;
    if (!dropped.has('enable_thinking')) body.enable_thinking = false;
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key || ''}` },
      body: JSON.stringify(body),
    };
    return hedgedFetch(
      requestSignal => fetchWithTimeoutRetry(endpoint, init, { timeoutSec: ep.timeoutSec, retries: ep.retries, label: 'Query 重写', externalSignal: requestSignal, retryOnTimeout: false }),
      signal,
      () => { hedged = true; },
    );
  };

  let resp = await send();
  // 报错原文提到可选参数时,去掉它再试(两个参数都被拒时最多再试两次)
  for (let round = 0; !resp.ok && round < OPTIONAL_PARAMS.length; round++) {
    const text = await resp.text().catch(() => '');
    const rejected = rejectedParams(resp.status, text).filter(p => !dropped.has(p));
    if (!rejected.length) {
      throw vectorFailure('Query 重写', classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text, direct: true }));
    }
    for (const p of rejected) dropped.add(p);
    droppedParams.set(endpoint, dropped);
    resp = await send();
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw vectorFailure('Query 重写', classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text, direct: true }));
  }
  const json = await resp.json().catch(() => {
    throw new EmbedError('Query 重写接口返回的不是有效数据，请确认地址指向对话接口（OpenAI 兼容接口的地址通常以 /v1 结尾）。', { kind: 'format' });
  });
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) {
    // 输出上限太小时,思考型模型常常整段都花在思考上,正文为空。
    const meta = {
      finishReason: choice?.finish_reason,
      maxTokens,
      sawReasoning: !!(choice?.message?.reasoning_content || choice?.message?.reasoning),
    };
    throw vectorFailure('Query 重写', finishKind(meta.finishReason) === 'truncated' ? truncatedReply(meta, '') : emptyReply(meta));
  }

  const parsed = parseResponse(raw);
  if (!parsed.queries.length) throw new EmbedError(noQueryMessage(parsed), { kind: 'format' });
  const usage = json?.usage;
  const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const reasoningTokens = tokens(usage?.completion_tokens_details?.reasoning_tokens);
  const stats: RecallRewriteStats = {
    inputChars: totalChars(messages),
    contextChars: built.contextChars,
    sentContextChars: built.sentContextChars,
    trimmed: built.trimmed,
    hedged,
    promptTokens: tokens(usage?.prompt_tokens),
    completionTokens: tokens(usage?.completion_tokens),
    reasoningTokens,
    // 思考型模型(或服务商没认 enable_thinking)会先输出思考内容,这是重写变慢最常见的原因
    thinking: (reasoningTokens ?? 0) > 0 || !!(choice?.message?.reasoning_content || choice?.message?.reasoning) || /<think(?:ing)?\b/i.test(raw),
  };
  return { intent: parsed.intent, queries: parsed.queries, stats };
}
