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
import { envelopeFailure, GENERATE_URL } from '@/api/client';
import { apiSettings, resolveVectorModel, type VectorEndpoint } from '@/api/settings';
import { classifyNpcPresence, deriveMemory, getLeaf, leafValid } from '../apply';
import { resolveKeepStart } from '../engine';
import { renderHistoryNodes, selectHistoryNodesBefore } from '../inject';
import { fmtItems, fmtNpcs, fmtPlans, fmtProtagonist, QUERY_REWRITE_SYSTEM, QUERY_REWRITE_TAIL } from '../prompts';
import { memory } from '../store';
import { cleanBody } from '../timeTag';
import type { RecallRewriteStats } from './debug';
import { EmbedError, fetchWithTimeoutRetry, RETRY_BACKOFF_MS, vectorFailure } from './embed';
import { normalizeQueryRewriteContextChars, normalizeQueryRewriteMaxTokens, runtimeEndpoint } from './params';
import {
  apiFailure, classifyHttpFailure, emptyReply, finishKind, interruptedReply, invalidResponse, networkFailure, sanitizeDetail, truncatedReply, type ApiError,
} from '@/api/errors';

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
 * 最近对话以回复开头时,放在最前面的一条 user 消息(见 alternating)。
 * 这句的写法会影响重写结果:写成「以下是最近对话」时,重写模型会少查状态快照里只列了名字的物品。改写法前先用真实模型比较。
 */
const RECENT_LEAD = '[最近对话开始]';

/**
 * 把对话消息排成 user、assistant 交替,以 user 开头:相邻的同角色消息并成一条(中间空一行),
 * 第一条是回复时前面补一条 user 的引导语。
 * 一些对话模板(Mistral、Gemma、Llama 2 等)按位置检查角色:system 之后第 1、3、5…条必须是 user,其余必须是 assistant,
 * 不满足就拒绝整个请求(Conversation roles must alternate user/assistant/...)。
 * 合并不改变正文的先后:各条正文按顺序用空行连起来,与合并前相同,只多出开头的引导语。
 */
function alternating(turns: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  const add = (role: ChatMsg['role'], content: string) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role, content });
  };
  if (turns[0]?.role === 'assistant') add('user', RECENT_LEAD);
  for (const t of turns) add(t.role, t.content);
  return out;
}

/**
 * 构造发给 rewrite 模型的消息序列。
 *
 * ⚠️ 许多向量渠道要求 system 消息**仅允许出现在数组最开头**,中间不得再有 system;
 * 一些对话模板还要求 system 之后 user、assistant 严格交替,并以 user 开头。
 * 故发出去的形态是:**开头唯一一条 system + user/assistant 交替的对话(以 user 开头) + 结尾一条 user**。
 *  - 历史剧情摘要并入开头那条 system(属背景设定,合法地待在开头);
 *  - 状态快照不独立成 system,而是**拼进对话消息正文**(放在 cut 点前一条之后、洞楼之前),
 *    保持中间无 system,从而兼容「system 只能在开头」的渠道;
 *  - 收尾提示词是最后一条 user:最后一楼是用户发言时并进那一条,否则单独成一条;
 *  - 相邻的同角色消息(连着两楼同一角色、中间有楼被跳过)并成一条,最近对话以回复开头时前面补一条引导语(见 alternating)。
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
  const turns: ChatMsg[] = [];
  if (snapshot) {
    if (!dialog.length) {
      // 窗口无可用对话消息 → 兜底放一条 user 承载(仍非 system);它与后面的收尾提示同为 user,会并成一条
      turns.push({ role: 'user', content: snapshot });
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

  for (const c of dialog) turns.push({ role: c.role, content: c.content });

  // 收尾提示词
  turns.push({ role: 'user', content: QUERY_REWRITE_TAIL });
  messages.push(...alternating(turns));
  return { messages, contextChars, sentContextChars: history.length + totalChars(kept) + snapshot.length, trimmed };
}

/** 把填写的地址规整成基础地址(去掉结尾的 /、/embeddings、/chat/completions);请求发往它后面的 /chat/completions。 */
function chatCompletionsBase(rawUrl: string): string {
  return String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/chat\/completions$/i, '');
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
 * 查询重写默认附带 enable_thinking:false(关闭国产模型默认的思维链)和 top_p;经酒馆后端转发时另外用流式传输(见下文「请求方式」)。
 * 严格校验参数的接口会因为不认识它们返回 400/422:报错原文提到 enable_thinking、top_p 哪个,就去掉它重试,
 * 并按接口地址和模型记住,本次会话内不再发送。
 * stream 只对经酒馆后端转发的请求有意义:原文提到了流式传输、又没有点前两个参数的名时,改用非流式试一次,
 * 原样重发成功了才记住。各家说「不支持流式传输」的写法太多,认不全;而认错的代价只是多发几个马上被拒绝的请求,所以提到就试、试成才记。
 */
const OPTIONAL_PARAMS = ['enable_thinking', 'top_p', 'stream'] as const;
type OptionalParam = (typeof OPTIONAL_PARAMS)[number];
/** 原文里出现名字就算点了名的两个。 */
const NAMED_PARAMS: readonly OptionalParam[] = ['enable_thinking', 'top_p'];
const droppedParams = new Map<string, Set<OptionalParam>>();
/**
 * 报错里整段回显的请求体不算点了参数的名:原文带着 model 或 messages 这两个键时,去掉和发出去的一模一样的键值。
 * 认三种写法:JSON("stream":true)、转义过的 JSON(\"stream\":true)、Python 字典('stream': True)。
 * 两条路发出的 stream 不一样(经后端是 true,直连是 false),各用各的。
 * 只列出被拒的一两个键值的(如 Unsupported parameters: {'enable_thinking': False})不是回显,照样算点名。
 */
const ECHOED_BODY = /\\*["'](?:model|messages)\\*["']\s*:/i;
const echoedParams = (stream: boolean) => new RegExp(
  String.raw`\\*["'](?:stream\\*["']\s*:\s*${stream}|top_p\\*["']\s*:\s*0\.8\d*(?![\d.])|enable_thinking\\*["']\s*:\s*false)(?![a-z0-9_])`, 'gi',
);
const ECHOED: Record<RewriteRoute, RegExp> = { backend: echoedParams(true), direct: echoedParams(false) };
/** 原文去掉回显的请求体、转成小写;下面几个判断都看它。 */
const spoken = (text: string, route: RewriteRoute) => (ECHOED_BODY.test(text) ? text.replace(ECHOED[route], '') : text).toLowerCase();
/**
 * 原文(已转小写)提到了流式传输:stream、streaming、streamed、streams、sse、流式。
 * upstream、event-stream、stream_options、名字里带 -stream 的模型不算。
 */
const STREAM_WORD = /(?:^|[^a-z0-9_\-/.])(?:stream(?:ing|ed|s)?|sse)(?![a-z0-9_\-])|流式/;
/** non-streaming、non-stream 也算提到(上一条为了排除带 -stream 的模型名,连字符后面的不认)。 */
const NON_STREAM = /(?:^|[^a-z0-9_])non-?stream(?:ing|ed)?(?![a-z0-9_])/;
/** 原文(已转小写)提到了流式传输。 */
const mentionsStream = (body: string) => STREAM_WORD.test(body) || NON_STREAM.test(body);
/**
 * 非流式转发时看不到原话,遇到 400/422 按这几种组合各试着去掉一次(每次都从开始盲试时的参数出发),哪种成功就记住哪种。
 * 不累加:只有 top_p 被拒收时,不该把 enable_thinking 也去掉(去掉之后模型会开始思考,重写慢很多)。
 */
const BLIND_PLANS: ReadonlyArray<readonly OptionalParam[]> = [['enable_thinking'], ['top_p'], ['enable_thinking', 'top_p']];
/** 一次调用里因为参数重发的次数上限。点名去掉的、试非流式的、盲试的加在一起到不了这么多,只是保险。 */
const MAX_RESENDS = OPTIONAL_PARAMS.length + BLIND_PLANS.length;

/* ============ 请求方式:酒馆后端转发 / 浏览器直连 ============ */

/**
 * 默认是「浏览器直连」(1.4.18 及以前的做法,非流式):只由浏览器发出,不经酒馆后端,升级后行为不变。
 *
 * 用户在设置里改成「酒馆后端转发」时,请求交给酒馆的 /api/backends/chat-completions/generate 转发
 * (custom 源,与副 API 请求、原版 1.3.4 起的查询重写是同一条通道):由酒馆服务器发出,不受浏览器跨域限制。
 * 本地模型(如 Ollama)默认只接受本机网页的请求,一般要走这条路。
 *
 * 经后端的请求用流式传输(stream:true)。酒馆对流式请求是把服务商的状态码和正文原样转回来,报错时看得到服务商的原话;
 * 非流式时酒馆只转来状态说明(Bad Request 之类),而且 1.13.3 及更早的酒馆遇到限流(429)会自己重试两分多钟才返回。
 * 回复等全部收完再解析,不逐段显示。400/422 的原话提到了流式传输时改用非流式试一次,原样重发成功了才按接口地址和模型记住;
 * 非流式时看不到原话,遇到 400/422 按 enable_thinking、top_p、两个一起这三种组合各试着去掉一次,哪种成功就记住哪种。
 * 非流式重发仍是 400/422 时,报最初那条带原话的拒绝,不记「不支持流式传输」。
 * 上游在流式回复中途断开连接(不是正常结束)时,酒馆不会结束这次转发,请求要等到超时:这是酒馆转发的做法,这里没有办法提前知道。
 *
 * 选了酒馆后端转发之后,浏览器直连留作后备(下面各条都只在设置为酒馆后端转发时起作用):
 *  - 酒馆服务器连不上这个地址(酒馆以 502 加请求库的连接错误返回)时,同一轮改由浏览器直连再试;
 *    直连有答复后本次会话先用直连,直连连不上时再回到后端。
 *  - 酒馆服务器访问不到的服务,连接可能一直挂着,不报错也不返回。所以本次会话里后端还没有为这个地址取回过答复时:
 *    公网地址的请求 12 秒没有返回,补发的那一次由浏览器直连发出(直连几秒内就失败的改回经后端补发),
 *    连续两轮都靠直连补发取得结果时,本次会话先用直连;
 *    后端一直等到超时、这一轮又还没试过直连的,把直连当第二条路再试,它有答复的话下一轮起先用直连
 *    (本机或局域网地址不补发,靠的是这一条)。
 *    直连补发得到的拒绝先不采用(可能只是浏览器这一路被限制),后端这一轮始终没有答复时才用它;
 *    原文点了可选参数名的拒绝例外,立刻按它去掉参数重发;提到流式传输的拒绝不留(直连是非流式的,那不是后端那边的原因)。
 *  - 后端取回过答复(成功或服务商的拒绝)就说明酒馆服务器连得上这个地址:之后的慢只是服务商慢,
 *    补发照旧经后端发出,不再换成直连;后端超时之后重新按「还没有取回过」处理。
 *  - 服务商的拒绝可能只针对酒馆服务器这一路(按地区、来源 IP 限制):后端转来 403、451,或原话同时提到地区、IP 一类的词和
 *    「不支持、被限制」一类的词,而后端在本次会话里还没有成功过时,公网地址由浏览器直连用同样的参数再试一次
 *    (不补发、不重试、最多等 45 秒),成功就用它的结果,之后先用直连;不成功仍报后端转来的拒绝。见 send 里的 routeBound。
 *  - 直连在本次会话里取得过服务商的答复,就说明这条路是通的,之后偶尔失败照常再试。
 *    从来没有取得过答复时:连不上的(跨域限制那一类)一次就停用,十分钟内不再用它;
 *    等到超时的可能只是服务商偶尔卡住,连着两次才停用。
 * 本机或局域网地址(多半是本地模型)不补发,也不因为被拒绝另由浏览器再发请求。
 */
type RewriteRoute = 'backend' | 'direct';

interface RouteMemo {
  /** 本次会话先用浏览器直连(酒馆服务器连不上这个地址,或连续两轮迟迟没有返回) */
  preferDirect: boolean;
  /** 连续几轮靠直连取得结果(后端一直没有返回) */
  silent: number;
  /** 直连从没取得过答复、又连不上(或连着两次超时)的时刻;十分钟内不再用直连。取得答复后清掉 */
  directFailedAt: number;
  /** 直连从没取得过答复时,等到超时的次数(连不上的不计在这里) */
  directStalls: number;
  /** 本次会话里直连取得过服务商的答复(成功或拒绝都算):这条路是通的,之后偶尔失败不再记 */
  directAnswered: boolean;
  /** 本次会话里后端为这个地址取回过服务商的答复(成功或拒绝都算):酒馆服务器连得上它,补发不必换成直连 */
  backendAnswered: boolean;
  /** 本次会话里后端为这个地址取回过成功的回复 */
  backendOk: boolean;
}
const routeMemos = new Map<string, RouteMemo>();
/** 直连从没取得过答复又连不上之后,过这么久才再用它。 */
export const REWRITE_DIRECT_RETRY_AFTER_MS = 10 * 60_000;
/**
 * 直连从没取得过答复时,连不上(跨域限制、地址不通)是确定的,一次就停用;
 * 超时可能只是服务商偶尔卡住(实测十几次里会有一次),连着这么多次才停用。
 */
const DIRECT_STALLS_TO_PAUSE = 2;
/** 连续这么多轮靠直连取得结果,本次会话改为先用直连。 */
const SILENT_ROUNDS_TO_SWITCH = 2;

function routeMemo(endpoint: string): RouteMemo {
  let memo = routeMemos.get(endpoint);
  if (!memo) {
    memo = { preferDirect: false, silent: 0, directFailedAt: -Infinity, directStalls: 0, directAnswered: false, backendAnswered: false, backendOk: false };
    routeMemos.set(endpoint, memo);
  }
  return memo;
}

/** 清掉本次会话记住的事:拒收的参数、各地址先走哪条路(测试用)。 */
export function resetRewriteParamMemory(): void {
  droppedParams.clear();
  routeMemos.clear();
}

/**
 * 地址是不是本机或局域网(多半是本地模型服务):localhost、回环、私有网段、链路本地、内网域名、不带点的主机名。
 * 这类地址不补发请求(慢是因为算力,再发一个只会更慢)。解析不了的地址同样处理。
 */
export function isLocalAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) {
    // IPv6:未指定、回环、映射的 IPv4、唯一本地(fc00::/7)、链路本地(fe80::/10)
    return host === '::' || host === '::1' || host.startsWith('::ffff:') || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!host.includes('.')) return true;
  return /\.(?:local|lan|internal|intranet|home|home\.arpa)$/.test(host);
}

const LABEL = 'Query 重写';

interface RewriteRequest {
  /** 上游的对话接口地址(浏览器直连用) */
  endpoint: string;
  /** 上游的基础地址(经酒馆后端转发用,酒馆会在后面补上 /chat/completions) */
  base: string;
  ep: VectorEndpoint;
  messages: ChatMsg[];
  maxTokens: number;
}

/**
 * 服务端明确给出、但不是成功回复的答复。
 * text:服务商的报错原文(酒馆非流式转发时拿不到,为空)。
 * fromHost:拒绝来自酒馆自己(登录过期、地址或密钥的格式酒馆发不出去),不是服务商的答复。
 * statusOnly:酒馆只转来了状态说明,没有原文(非流式转发)。
 * invalid:返回的不是有效数据(地址指向了网站首页之类)。
 * inBody:服务商用 200 报的错(正文里带着 error);status 是从正文的 code 读出来的,不按它重试。
 */
interface Refusal {
  ok: false;
  route: RewriteRoute;
  failure: ApiError;
  status: number | undefined;
  text: string;
  fromHost?: boolean;
  statusOnly?: boolean;
  invalid?: boolean;
  inBody?: boolean;
}
/**
 * 一次请求的结果。服务端有明确答复才算结果;连不上、超时、取消都以异常抛出。
 * incomplete:流式回复没有正常结束。cut = 最后一块没写完就断了;unmarked = 既没有结束原因也没有结束标记(可能是中途断开,也可能是这个服务不发)。
 */
type Outcome = { ok: true; route: RewriteRoute; json: any; incomplete?: 'cut' | 'unmarked' } | Refusal;

/**
 * 这条路连不上服务器:酒馆服务器连不上上游,或浏览器访问不了这个地址。可以换另一条路再试。
 * definite:连接阶段就失败了(拒绝连接、域名解析不了、连接超时、证书不对),同一条路上再发一个请求也只会得到同样的结果。
 */
class Unreachable extends Error {
  constructor(readonly route: RewriteRoute, readonly failure: ApiError, readonly definite = false) {
    super(failure.message);
    this.name = 'Unreachable';
  }
}

const invalidData = () => new EmbedError('Query 重写接口返回的不是有效数据，请确认地址指向对话接口（OpenAI 兼容接口的地址通常以 /v1 结尾）。', { kind: 'format' });
const invalidOutcome = (route: RewriteRoute, status: number | undefined): Refusal =>
  ({ ok: false, route, status, text: '', failure: invalidResponse(), invalid: true });

/**
 * 原文点了哪些可选参数的名(不看状态码,也不管已经去掉了哪些)。整段回显的请求体不算。
 * stream 是原文提到了流式传输就算,而且只对经后端转发的请求有意义。
 */
function namedParams(text: string, route: RewriteRoute): OptionalParam[] {
  const body = spoken(text, route);
  const named = NAMED_PARAMS.filter(p => body.includes(p));
  if (route === 'backend' && mentionsStream(body)) named.push('stream');
  return named;
}

/**
 * 这次拒绝之后要去掉哪些可选参数再发(sent 是这次发送时已经去掉的)。只看 400/422,以及用 200 报错、没有状态码的。
 * 原文点了 enable_thinking、top_p 的名就去掉它们;没有点、原文提到了流式传输时才轮到 stream,
 * 而且要服务商明确拒绝了请求(400/422)。
 */
function rejectedParams(out: Refusal, sent: ReadonlySet<OptionalParam>): OptionalParam[] {
  if (out.invalid || !out.text) return [];
  const explicit = out.status === 400 || out.status === 422;
  if (!explicit && out.status !== undefined) return [];
  const named = namedParams(out.text, out.route).filter(p => !sent.has(p));
  const plain = named.filter(p => p !== 'stream');
  if (plain.length) return plain;
  return explicit ? named : [];
}

/**
 * 两条路共用的上游参数。对齐 Horae:低温更服从格式;enable_thinking:false 关思维链——
 * 国产模型(Qwen3/GLM 等)默认开思维链会先吐 <think> 推理,冲乱 INTENT/Q 行格式导致解析失败。
 * enable_thinking 两条路放的位置不同,由调用方加。
 */
function upstreamParams(req: RewriteRequest, dropped: ReadonlySet<OptionalParam>, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.ep.model, messages: req.messages, temperature: 0.1, max_tokens: req.maxTokens, stream };
  if (!dropped.has('top_p')) body.top_p = 0.8;
  return body;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object';

/** 这段 JSON 带着非空的 error。 */
function hasError(data: Record<string, any>): boolean {
  const error = data.error;
  if (error === undefined || error === null || error === false || error === '') return false;
  return !(isObject(error) && !Array.isArray(error) && !Object.keys(error).length);
}

/** 这段 JSON 是不是在报错:带着非空的 error,又没有正常的回复(choices)。 */
const carriesError = (data: Record<string, any>) => hasError(data) && !(Array.isArray(data.choices) && data.choices.length > 0);

/**
 * 有的服务商用 200 加 error 字段报错:按拒绝处理,报错里带上它的原话。
 * error.code 是 HTTP 状态码时照它归类(说成限流、服务商出错等),但不按它重试:两条路都只对真正的 HTTP 状态重试。
 */
function errorIn200(route: RewriteRoute, data: Record<string, any>, text: string): Refusal {
  const code = Number(isObject(data.error) ? data.error.code ?? data.error.status : data.code);
  const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined;
  return { ok: false, route, status, text, failure: classifyHttpFailure({ status, body: data, provider: true }), inBody: true };
}

/** 浏览器直连上游(非流式)。网络错误(地址不通、跨域限制)重试用尽后抛 Unreachable,其说明由 explain 给出。 */
async function directAttempt(
  req: RewriteRequest,
  dropped: ReadonlySet<OptionalParam>,
  signal: AbortSignal | undefined,
  explain: (message: string) => ApiError,
): Promise<Outcome> {
  const body = upstreamParams(req, dropped, false);
  if (!dropped.has('enable_thinking')) body.enable_thinking = false;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.ep.key || ''}` },
    body: JSON.stringify(body),
  };
  let network: ApiError | undefined;
  let resp: Response;
  try {
    resp = await fetchWithTimeoutRetry(req.endpoint, init, {
      timeoutSec: req.ep.timeoutSec, retries: req.ep.retries, label: LABEL, externalSignal: signal, retryOnTimeout: false,
      network: message => (network = explain(message)),
    });
  } catch (e) {
    if (network && e instanceof EmbedError && e.kind === 'network') throw new Unreachable('direct', network);
    throw e;
  }
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    return {
      ok: false, route: 'direct', status: resp.status, text,
      failure: classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text, provider: true }),
    };
  }
  const json = parseJson(text);
  if (json === undefined) return invalidOutcome('direct', resp.status);
  if (isObject(json) && carriesError(json)) return errorIn200('direct', json, text);
  return { ok: true, route: 'direct', json };
}

/**
 * 发给酒馆后端的请求体。custom 源:酒馆把 custom_url 后面补上 /chat/completions 发出,
 * 标准字段原样转发,custom_include_body 并入上游请求体(enable_thinking 不是酒馆认识的字段,只能放这里)。
 * custom 源不读 proxy_password,密钥靠 custom_include_headers 覆盖 Authorization;即使密钥为空也要带上,
 * 否则酒馆会把自己保存的 Custom 密钥发到这个地址。两个 custom_include_* 都用 JSON.stringify 生成
 * (酒馆按 YAML 解析,解析失败会静默忽略;JSON 是 YAML 的子集)。说明见 api/client.ts 的 buildRequestBody。
 */
function backendBody(req: RewriteRequest, dropped: ReadonlySet<OptionalParam>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_completion_source: 'custom',
    custom_url: req.base,
    custom_include_headers: JSON.stringify({ Authorization: `Bearer ${req.ep.key || ''}` }),
    ...upstreamParams(req, dropped, !dropped.has('stream')),
    // 声明不用工具:让改写 /generate 请求的第三方脚本放行;酒馆只在带 tools 时才转发它,到不了服务商
    tool_choice: 'none',
  };
  if (!dropped.has('enable_thinking')) body.custom_include_body = JSON.stringify({ enable_thinking: false });
  return body;
}

/** content 既可能是字符串,也可能是 [{ type:'text', text }] 分段。 */
function pieceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}

/**
 * 把酒馆转回来的 200 正文还原成非流式回复的结构。
 * 流式(SSE)时逐行读 `data: {json}`,拼接 delta.content,记下结束原因、token 用量和思考内容,读到 `data: [DONE]` 为止;
 * 有的服务无视 stream 直接回整段 JSON,或把报错写成一段不带 data 前缀的 JSON:这些行另外收起来按整段 JSON 处理。
 * 返回:
 *  - reply:可以照非流式回复解析。既没有结束原因也没有 [DONE] 时带 incomplete:
 *    cut = 最后一条 data 行的 JSON 没写完就断了;unmarked = 其余的(可能是中途断开,也可能是这个服务不发结束标记);
 *  - error:正文里带着报错,raw 是那一段原文;
 *  - null:不是有效数据。
 */
export function assembleReply(text: string): { reply: any; incomplete?: 'cut' | 'unmarked' } | { error: Record<string, any>; raw: string } | null {
  let content = '';
  let reasoning = '';
  let finish: string | undefined;
  let usage: unknown;
  let sawData = false, sawDone = false, sawSse = false;
  /** 最近一条 data 行是一段没写完的 JSON */
  let broken = false;
  let eventName = '';
  const loose: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      eventName = '';
      continue;
    }
    if (!t.startsWith('data:')) {
      // 注释(心跳)和 event / id / retry 是 SSE 协议本身;其余的留着按整段 JSON 看
      const field = /^(event|id|retry)\s*:(.*)$/.exec(t);
      if (field || t.startsWith(':')) {
        sawSse = true;
        if (field?.[1] === 'event') eventName = field[2].trim().toLowerCase();
      } else {
        loose.push(line);
      }
      continue;
    }
    sawSse = true;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') {
      sawDone = true;
      break;
    }
    const chunk = parseJson(payload);
    broken = !isObject(chunk) && payload.startsWith('{');
    if (!isObject(chunk)) continue;
    const choice = chunk.choices?.[0];
    const reason = choice?.finish_reason ?? choice?.native_finish_reason;
    // 报错的一块:带着非空的 error 又没有正常的回复;或者同时带着 error 和「出错」一类的结束原因(流中途出错时有的服务这样写)
    if (carriesError(chunk) || (hasError(chunk) && finishKind(reason) === 'interrupted')) return { error: chunk, raw: payload };
    if (eventName === 'error') return { error: { error: chunk }, raw: payload };
    sawData = true;
    // 有的服务在最后一块里把全文放进 message 再发一遍:已经拼出正文时不再追加
    content += pieceText(choice?.delta?.content) || pieceText(choice?.text) || (content ? '' : pieceText(choice?.message?.content));
    reasoning += pieceText(choice?.delta?.reasoning_content) || pieceText(choice?.delta?.reasoning);
    if (typeof reason === 'string' && reason) finish = reason;
    if (isObject(chunk.usage)) usage = chunk.usage;
  }
  const rest = loose.join('\n').trim();
  const data = rest ? parseJson(rest) : undefined;
  if (isObject(data) && carriesError(data)) return { error: data, raw: rest };
  if (sawData || sawDone || (sawSse && !rest)) {
    const message: Record<string, unknown> = { content };
    if (reasoning) message.reasoning_content = reasoning;
    const reply = { choices: [{ message, finish_reason: finish }], usage };
    if (sawDone || finish) return { reply };
    return { reply, incomplete: broken ? 'cut' : 'unmarked' };
  }
  return isObject(data) && !Array.isArray(data) ? { reply: data } : null;
}

/** 酒馆自己生成的响应带着的记号:用 send、sendStatus 发出的有 ETag;出错页(CSRF 校验没过)有 default-src 'none' 的内容安全策略。转发来的都没有。 */
const hostMade = (resp: Response) => resp.headers.has('etag') || /default-src\s+'none'/i.test(resp.headers.get('content-security-policy') ?? '');
/** 酒馆自己的 403 正文:未登录是纯文本 Forbidden;CSRF 校验没过的出错页是 <pre>Forbidden…</pre>;白名单页里写着 config.yaml。 */
const HOST_FORBIDDEN = /^forbidden$|csrf|config\.yaml|<pre>[^<]*forbidden/i;

/**
 * 非 200 的响应是不是酒馆自己的拒绝(登录或 CSRF 校验没过、不在白名单里、请求不合酒馆的要求),而不是它转来的服务商的回复。
 * untyped:响应没有 Content-Type。酒馆流式转发只转状态码、状态说明和正文,不带 Content-Type;酒馆自己生成的响应都带。
 * 所以没有 Content-Type 的一定是转来的;有的却不一定是酒馆自己的(酒馆前面的反向代理可能给它补上),还要看别的:
 *  - 401:酒馆流式转发会把服务商的 401 改成 400 再转(免得浏览器弹出登录框),所以是酒馆自己的;
 *  - 403:非流式时服务商的报错不会以 403 出现;流式时要有酒馆自己生成的记号(见 hostMade),或正文是酒馆那几种 403 页面的样子;
 *  - 400 且正文是 { error: true }:酒馆不接受这个请求。
 */
function hostRefused(resp: Response, text: string, data: unknown, streaming: boolean, untyped: boolean): boolean {
  if (untyped) return false;
  if (resp.status === 401) return true;
  if (resp.status === 403) return !streaming || hostMade(resp) || (!isObject(data) && HOST_FORBIDDEN.test(text.trim()));
  return resp.status === 400 && isObject(data) && data.error === true;
}

/** 酒馆自己的拒绝怎么说明。 */
function hostFailure(resp: Response, text: string): ApiError {
  // 401/403 来自酒馆的登录、CSRF 或白名单校验,与服务商的密钥无关
  if (resp.status === 401 || resp.status === 403) {
    return apiFailure('auth', `酒馆服务器拒绝了这次请求（HTTP ${resp.status}）`, '登录状态可能已过期，请刷新页面后重试。', { status: resp.status });
  }
  if (resp.status === 400) {
    return apiFailure('bad-request', '酒馆没有接受这次请求（HTTP 400）', '请确认酒馆版本不低于 1.12.13；也可以把 Query 重写的「请求方式」改成「浏览器直连」。', { status: 400 });
  }
  return classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text });
}

/** 非流式时酒馆要把上游的回复读成 JSON,读不出来(上游返回了网页之类)会以 502 加这样的解析错误返回。 */
const NOT_JSON = /JSON|Unexpected token/i;

/** 酒馆还没发出请求就出的错:地址或密钥的格式不对。按错误代码认,返回给用户看的说明。 */
function hostConfigFailure(code: string): ApiError | null {
  // 漏写 http:// 的地址发请求之前就拦下了(见 rewriteQuery),到这里的是别的写法问题
  if (code === 'ERR_INVALID_URL') {
    return apiFailure('config', 'API 地址格式不对', '请检查地址里有没有空格、中文标点或多余的字符。');
  }
  if (code === 'ERR_INVALID_CHAR') {
    return apiFailure('config', 'API 密钥里有不能使用的字符', '请重新粘贴密钥，去掉多余的空格、换行或中文字符。');
  }
  return null;
}

/** 连接阶段就失败的错误代码:拒绝连接、域名解析不了、连接超时、网络不可达、证书不对(含 ERR_TLS_CERT_ALTNAME_INVALID)。 */
const CONNECT_FAILED = /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN)$|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/;
/** Node 的错误代码的样子(ECONNRESET、ERR_STREAM_PREMATURE_CLOSE)。服务商报错里的 code(server_error、502 之类)不是这个样子。 */
const NODE_ERROR_CODE = /^E[A-Z0-9_]+$/;
/**
 * 连接错误按错误代码归类,不看报错原文:原文里带着地址,地址里的字样(duckdns、tls 之类)会把按文字的归类带偏。
 * 多数代码本身就是 networkFailure 认得的词(ECONNREFUSED、ENOTFOUND、ETIMEDOUT);这两类要换个说法它才认得。
 */
const CODE_WORDING: ReadonlyArray<[RegExp, string]> = [
  [/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/, 'certificate'],
  // https 的地址写到了 http 的端口(或反过来)
  [/^EPROTO$/, 'ssl'],
];
const connectionWording = (code: string, message: string) => CODE_WORDING.find(([pattern]) => pattern.test(code))?.[1] ?? (code || message);
const LOOKS_LIKE_PAGE = /<\s*(?:!doctype|html|head|body)\b/i;

/** 酒馆转回来的响应怎么理解:成功、拒绝,或酒馆服务器连不上上游(可以换另一条路)。 */
function readBackendResponse(resp: Response, text: string, streaming: boolean): Outcome | Unreachable {
  if (resp.ok) {
    const assembled = assembleReply(text);
    if (!assembled) return invalidOutcome('backend', undefined);
    if ('reply' in assembled) return { ok: true, route: 'backend', json: assembled.reply, incomplete: assembled.incomplete };
    // 200 里带着报错。带 quota_error 字段的是酒馆非流式转发的信封,只有状态说明;否则是服务商自己用 200 报的错,有原话
    if ('quota_error' in assembled.error) {
      const failure = envelopeFailure(assembled.error);
      return { ok: false, route: 'backend', status: failure.status, text: '', failure, statusOnly: true };
    }
    return errorIn200('backend', assembled.error, assembled.raw);
  }
  const untyped = !resp.headers.has('content-type');
  const data = parseJson(text);
  // 酒馆发请求或读回复时自己出的错:502 加 { error: { message, type, code… } }。转来的服务商回复没有 Content-Type,不会是它
  const thrown = !untyped && resp.status === 502 && isObject(data) && isObject(data.error) ? data.error : null;
  if (thrown) {
    const code = String(thrown.code ?? '');
    const message = typeof thrown.message === 'string' ? thrown.message : '';
    const config = hostConfigFailure(code);
    if (config) return { ok: false, route: 'backend', status: undefined, text: '', failure: config, fromHost: true };
    // 非流式时酒馆读不出上游的 JSON:上游有回应(只是内容不对),酒馆服务器是连得上这个地址的
    if (!streaming && !thrown.type && !code && NOT_JSON.test(message)) return invalidOutcome('backend', undefined);
    // 请求库报的连接错误 type 为 system。连接阶段的错误代码(含证书不对)一定算连不上;
    // 其余的里,ERR_ 开头的代码、读正文读到一半断开(Invalid response body…)说明已经连上了,不算
    const connecting = CONNECT_FAILED.test(code);
    const detail = classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text }).detail;
    if (thrown.type === 'system' && (connecting || (!/^ERR_/.test(code) && !/^Invalid response body/i.test(message)))) {
      return new Unreachable('backend', networkFailure(connectionWording(code, message), { detail }), connecting);
    }
    // 酒馆转发时出的别的错(读回复读到一半断开等):不是服务商的答复,也不说明连不上。
    // 认得出是酒馆自己生成的(非流式、请求库的错误类型、Node 的错误代码、酒馆响应的记号)才这样说;
    // 认不出的可能是反向代理补了 Content-Type 的服务商回复,往下按服务商的回复处理
    if (!streaming || thrown.type === 'system' || NODE_ERROR_CODE.test(code) || hostMade(resp)) {
      const failure = apiFailure('server', '酒馆转发这次请求时出错（HTTP 502）',
        '多半是服务商中途断开了连接，或返回了酒馆读不了的内容；可以稍后重试，细节见运行酒馆的命令行窗口。', { status: 502, detail });
      return { ok: false, route: 'backend', status: 502, text: '', failure };
    }
  }
  if (hostRefused(resp, text, data, streaming, untyped)) {
    const failure = hostFailure(resp, text);
    return { ok: false, route: 'backend', status: failure.status, text: '', failure, fromHost: true };
  }
  // 带 Content-Type 的 502、503、504 网页:多半是酒馆前面的反向代理连不上酒馆(酒馆没在运行),也可能是它补了类型的服务商网页,分不出来就两种都说
  if (!untyped && (resp.status === 502 || resp.status === 503 || resp.status === 504) && LOOKS_LIKE_PAGE.test(text)) {
    const detail = classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text }).detail;
    const failure = apiFailure('server', `网关返回了出错页（HTTP ${resp.status}）`,
      '可能是酒馆前面的反向代理连不上酒馆（请确认酒馆还在运行），也可能是服务商出错；稍后重试。', { status: resp.status, detail });
    return { ok: false, route: 'backend', status: resp.status, text: '', failure, fromHost: true };
  }
  // 流式转发时酒馆把服务商的状态码和正文原样转来(401 会被改成 400,状态说明不变)。
  // 原话点了可选参数名或提到流式传输的 400 按真正的 400 处理(去掉参数或改用非流式再发),不按密钥问题改判
  const failure = classifyHttpFailure({
    status: resp.status, statusText: resp.statusText, body: text,
    provider: true, maskedAuth: streaming && !namedParams(text, 'backend').length,
  });
  return { ok: false, route: 'backend', status: failure.status ?? resp.status, text, failure };
}

/**
 * 经酒馆后端转发。流式(默认)时酒馆把服务商的状态码和正文原样转回来,等全部收完再解析;
 * 非流式(试着改用非流式,或记住了这个服务不支持流式传输之后)时上游报错只转来 200 + { error: { message: 状态说明 }, quota_error },拿不到原文。
 * 酒馆发请求时出错(拒绝连接、域名解析失败、连接超时等)两种方式都是 502 + { error: { message, type, code… } }。
 * 服务商出错(5xx)、限流和连接出错按重试次数重试;重试用尽仍连不上时抛 Unreachable。超时、认不出状态的错误和用 200 报的错不重试。
 */
async function backendAttempt(req: RewriteRequest, dropped: ReadonlySet<OptionalParam>, signal: AbortSignal | undefined): Promise<Outcome> {
  const streaming = !dropped.has('stream');
  const init: RequestInit = {
    method: 'POST',
    headers: getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
    body: JSON.stringify(backendBody(req, dropped)),
  };
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < req.ep.retries;
    let resp: Response;
    try {
      resp = await fetchWithTimeoutRetry(GENERATE_URL, init, {
        timeoutSec: req.ep.timeoutSec, retries: 0, label: LABEL, externalSignal: signal, retryOnTimeout: false,
        network: message => networkFailure(message, { toHost: true }),
      });
    } catch (e) {
      // 浏览器连不上酒馆:按重试次数再试,仍不行就照实报错(这时换成浏览器直连也没有意义)
      if (!(canRetry && e instanceof EmbedError && e.kind === 'network')) throw e;
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      continue;
    }
    const out = readBackendResponse(resp, await resp.text().catch(() => ''), streaming);
    const unreachable = out instanceof Unreachable;
    // 按重试次数重试的:连接出错、服务商出错(5xx)、限流(429,额度不足除外)。认不出状态的错误、用 200 报的错不重试
    const refusal = !unreachable && !out.ok && !out.invalid && !out.inBody ? out : null;
    const transient = unreachable
      || (!!refusal && refusal.failure.kind !== 'quota' && refusal.status !== undefined && (refusal.status >= 500 || refusal.status === 429));
    if (transient && canRetry) {
      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      continue;
    }
    if (unreachable) throw out;
    return out;
  }
}

/** 非流式转发时看不到服务商的原话(只在服务商不支持流式传输时才会这样),报错里写明去哪里看。 */
const BACKEND_NOTE = '这个服务不支持流式传输，经酒馆后端转发时看不到它的报错原文，可以查看运行酒馆的命令行窗口，或把 Query 重写的「请求方式」暂时改成「浏览器直连」再试一次。';
/** 还只是在试非流式(流式请求先被拒绝、原话提到了流式传输),这一次酒馆只转来了状态说明:不断言这个服务不支持流式传输。 */
const TRIAL_NOTE = '这是改用非流式重发那一次的结果（流式请求先被拒绝，原话见后）；经酒馆后端转发时看不到非流式这一次的原话，可以查看运行酒馆的命令行窗口，或把 Query 重写的「请求方式」暂时改成「浏览器直连」再试一次。';
/** 一般的 400 在查询重写里的常见原因。 */
const BAD_REQUEST_HINT = '常见原因是模型名不对、「最大输出」超过了模型的上限、发送的内容超出了模型的上下文长度，或接口不接受某个参数。';
/**
 * 接口对消息的角色顺序有要求(通用的分类把它说成「预填充」,那是副 API 渠道的设置)。
 * 发出去的消息已经是交替的(见 alternating),还报这类错的多半是模板不接受 system:
 * 较早的 Mistral、Mixtral 模板对开头的 system 报的也是 roles must alternate。
 */
const ROLE_ORDER_HINT = '这个接口对消息的角色顺序有要求。Query 重写发出的消息是开头一条 system，之后 user 和 assistant 交替；仍被拒绝时，多半是这个模型的对话模板不接受 system 消息，可以换一个对话模型或接口。';
/**
 * 原话说的是不接受 system 消息:Gemma 2 的模板(System role not supported)、
 * 个别接口对第一条消息角色的校验(does not support 'system')。
 */
const SYSTEM_REJECTED = /system\s+(?:role|message|prompt)s?\s+(?:is\s+|are\s+)?not\s+supported|does(?:n't|\s+not)\s+support\s+(?:the\s+|a\s+)?['"`]?system\b/i;
const NO_SYSTEM_HINT = '这个接口不接受 system 消息，而 Query 重写的提示词放在开头的 system 消息里，可以换一个对话模型或接口。';
/** 流式请求被拒绝、原话提到了流式传输,试过非流式也没成:报的是最初那条带原话的拒绝。 */
const NON_STREAM_TRIED_HINT = '已经试过改用非流式重发，仍被拒绝（经酒馆后端转发时看不到那一次的原话）；可以把 Query 重写的「请求方式」改成「浏览器直连」再试，那样能看到原话。';

/**
 * 通用的说明是写给副 API 渠道的,有几条(排除参数、发送预填充、流式传输开关)对查询重写不适用,这里换成查询重写的说法;
 * 酒馆只转来状态说明时(非流式转发)另外写明去哪里看原文。
 * nonStreamTried:out 是试着改用非流式之前那条带原话的拒绝,非流式重发仍被拒绝。
 * earlier:out 是试着改用非流式那一次的结果(只有状态说明),earlier 是此前流式请求被拒绝的那一条,把它的原话附在细节里。
 */
function rewriteWording(out: Refusal, opts: { nonStreamTried?: boolean; earlier?: Refusal } = {}): ApiError {
  const failure = out.failure;
  const note = !out.statusOnly ? '' : opts.earlier ? TRIAL_NOTE : BACKEND_NOTE;
  const tried = opts.nonStreamTried ? NON_STREAM_TRIED_HINT : '';
  const code = failure.status ? `（HTTP ${failure.status}）` : '';
  const detail = opts.earlier?.failure.detail
    ? [failure.detail, `流式请求被拒绝时的原话：${opts.earlier.failure.detail}`].filter(Boolean).join('；')
    : failure.detail;
  const extra = { status: failure.status, detail };
  // 通用的分类归到「预填充」的,在查询重写里是接口对角色顺序有要求。
  // 回显了请求体的报错里本来就有 "role": "user" 这样的字样(聊天内容里也什么词都可能出现),不能据此认定,按一般的 400 说明
  const prefillTitled = failure.title.startsWith('这个接口不接受「预填充」消息');
  const echoed = ECHOED_BODY.test(out.text);
  const roleOrder = prefillTitled && !echoed;
  const noSystem = !echoed && SYSTEM_REJECTED.test(out.text);
  if (failure.kind === 'bad-request' && (prefillTitled || failure.title.startsWith('服务商拒绝了这次请求'))) {
    const hint = noSystem ? NO_SYSTEM_HINT : roleOrder ? ROLE_ORDER_HINT : BAD_REQUEST_HINT;
    return apiFailure('bad-request', `服务商拒绝了这次请求${code}`, `${hint}${tried}${note}`, extra);
  }
  if (!out.statusOnly) {
    // 用 200 报错、又没有写原因的:通用的说明让人去打开渠道的「流式传输」,查询重写没有这个开关
    if (failure.kind === 'upstream' && failure.title.startsWith('API 返回了错误，但酒馆没有转发具体原因')) {
      return apiFailure('upstream', 'API 返回了错误，没有说明原因', '可以重试；仍然失败时请核对 API 地址、模型名和密钥。', extra);
    }
    // 归到更具体的分类(模型名、最大输出等)的,说明照旧;试过非流式的补上一句
    return tried ? apiFailure(failure.kind, failure.title, `${failure.hint}${tried}`, extra) : failure;
  }
  if (failure.kind === 'not-found' && failure.status === 404) {
    return apiFailure('not-found', `接口地址不对，或模型不存在${code}`,
      `请核对 API 地址（OpenAI 兼容接口的地址通常以 /v1 结尾）和模型名。${note}`, extra);
  }
  if (failure.kind === 'upstream') return apiFailure('upstream', failure.title, note, extra);
  // 其余的(密钥、限流、额度、服务商出错等)照状态说明的说法,末尾同样注明看不到原文
  return apiFailure(failure.kind, failure.title, `${failure.hint}${note}`, extra);
}

/** 回复是空的:思考占满了输出的另有说明;其余的按是不是流式取得的给建议(查询重写没有「流式传输」开关)。 */
function emptyRewriteReply(streamed: boolean, meta: { finishReason?: string; maxTokens?: number; sawReasoning?: boolean }): ApiError {
  const base = emptyReply(meta);
  if (meta.sawReasoning) return base;
  const hint = streamed
    ? '可能是模型拒答、被内容审核静默拦截，或这个接口的流式输出不兼容；可以重试，或把 Query 重写的「请求方式」改成「浏览器直连」再试。'
    : '可能是模型拒答，或被内容审核静默拦截；可以重试，或换一个模型。';
  return apiFailure('empty', base.title, hint, { detail: base.detail });
}

/** 流式回复没有正常结束(既没有结束原因也没有结束标记),里面又没有可用的检索语句:可能是中途断开,也可能是流式输出的格式不兼容。 */
function unfinishedReply(): ApiError {
  return apiFailure('server', '服务商的回复没有正常结束',
    '可能是服务商中途中断了回复，或这个接口的流式输出不兼容；可以重试，或把 Query 重写的「请求方式」改成「浏览器直连」再试。');
}

/** 原话(已转小写)里地区、来源 IP 一类的词。 */
const ORIGIN_WORD = /\b(?:country|countries|region|territor(?:y|ies)|location|area|mainland|vpn|geo(?:graph\w*|locat\w*|[- ]?(?:block|restrict|fenc)\w*)?)\b|(?:^|[^a-z])ips?(?![a-z])|地区|地域|区域|国家|所在地|大陆|境内|境外/;
/** 原话(已转小写)里「不支持、被限制」一类的词。 */
const BLOCKED_WORD = /(?:not|n't|n’t)\s+(?:be\s+)?(?:supported|available|allowed|permitted|authorized|accessible|in\b)|unsupported|unavailable|restrict|block|banned|forbidden|denied|deny|prohibit|reject|detected|whitelist|allowlist|blacklist|不支持|不可用|不提供|不在|未在|限制|禁止|拒绝|封禁|屏蔽|无法访问|无法使用|暂不|白名单|黑名单/;
/**
 * 后端转来的拒绝可能只针对酒馆服务器这一路:服务商按地区或来源 IP 限制访问时,多半回 403(个别回 451);
 * 也有用别的 4xx、在原话里说明的,要地区、IP 一类的词和「不支持、被限制」一类的词同时出现才算。
 * 5xx、整页的网页、整段回显了请求体的(里面有聊天内容)不按原话判:那里面什么词都可能出现。密钥不对的 401 不算:换一条路结果也一样。
 */
function routeBound(out: Refusal): boolean {
  if (out.status === 403 || out.status === 451) return true;
  if (out.status !== undefined && (out.status < 400 || out.status >= 500)) return false;
  if (!out.text || LOOKS_LIKE_PAGE.test(out.text) || ECHOED_BODY.test(out.text)) return false;
  const body = out.text.toLowerCase();
  return ORIGIN_WORD.test(body) && BLOCKED_WORD.test(body);
}
/**
 * 因为后端的拒绝改由浏览器直连再试时最多等这么久(秒)。拒绝通常立刻就回来,等得久多半是直连在生成,所以留出正常重写两倍多的时间;
 * 浏览器到服务商的连接被丢包时也会等满这段时间,直连从没取得过答复的话连着两次就停用十分钟。
 */
export const REWRITE_OTHER_ROUTE_TIMEOUT_SEC = 45;

/** 浏览器访问不了这个地址时的说明。设置为浏览器直连时提示可以改走酒馆后端。 */
function directNetworkFailure(message: string, setting: RewriteRoute): ApiError {
  if (setting !== 'direct') return networkFailure(message, { direct: true });
  return apiFailure('network', '浏览器无法访问这个地址',
    '可能是地址写错、网络不通，或服务商不允许网页直接访问（跨域 CORS 限制）。本地模型和不允许网页访问的服务，可以把 Query 重写的「请求方式」改成「酒馆后端转发」。',
    { detail: sanitizeDetail(message) });
}

/** 各条路都连不上时的报错:设置为酒馆后端转发时报后端的原因,试过直连的话注明直连也没有成功(连不上、超时,或被服务商拒绝)。 */
function unreachableError(failed: Unreachable[], directTried: boolean): EmbedError {
  const backend = failed.find(f => f.route === 'backend')?.failure;
  const direct = failed.find(f => f.route === 'direct')?.failure;
  if (!backend) return vectorFailure(LABEL, direct ?? apiFailure('network', '请求没有发出'));
  if (!direct && !directTried) return vectorFailure(LABEL, backend);
  return vectorFailure(LABEL, apiFailure('network', backend.title, `${backend.hint}改由浏览器直连也没有成功。`, { status: backend.status, detail: backend.detail }));
}

/**
 * 设置为酒馆后端转发时,记下这一次实际由哪条路取得答复,决定下一轮先走哪条。
 * first 是这一次先走的那条路;返回 true 表示这次是先走后端、却由直连给的答复(这一轮接下来的重发先走直连)。
 */
function noteRoute(memo: RouteMemo, first: RewriteRoute, out: Outcome, backendFailed: boolean): boolean {
  if (out.route === 'backend') {
    // 酒馆自己的拒绝(登录过期等)不说明酒馆服务器连得上服务商
    if (out.ok || !out.fromHost) memo.backendAnswered = true;
    if (out.ok) memo.backendOk = true;
    memo.silent = 0; // 先用直连的时候不会走到这里:直连连不上、改回后端之前,send 已经把 preferDirect 清掉了
    return false;
  }
  if (first !== 'backend') return false; // 这一次本来就先用直连
  if (backendFailed) {
    memo.preferDirect = true; // 后端这条路走不通(连不上、一直没有答复,或被服务商按来路拒绝),而直连有答复
    return true;
  }
  memo.silent += 1; // 后端迟迟没有返回,靠直连补发取得答复
  if (memo.silent >= SILENT_ROUNDS_TO_SWITCH) memo.preferDirect = true;
  return true;
}

/* ============ 慢请求补发 ============ */

/**
 * 重写请求等了这么久还没返回时,再发一个同样的请求,先返回的那个算数,另一个取消。
 * 服务商排队时偶尔会卡住几十秒(实测 Qwen3.5-27B 多数 4–10 秒返回,16 次里有 1 次等到 90 秒超时),
 * 同样的请求再发一次通常几秒就回来。只在慢的时候多花一次请求。本机或局域网地址不补发(见 isLocalAddress)。
 */
export const REWRITE_HEDGE_AFTER_MS = 12000;

/**
 * 走后端时,补发的那一次先试浏览器直连。直连在这么短的时间内就失败(跨域限制、地址不通、被服务商拒绝)时,
 * 改回经后端再补发一次;拖得更久才失败的不再补发——那时第一个请求也快到超时了,再发只会让正文多等一轮。
 */
const REWRITE_DIRECT_HEDGE_FAST_FAIL_MS = 5000;

/**
 * 发出请求;超过 REWRITE_HEDGE_AFTER_MS 还没有结果就补发一次(backup),先有结果的算数(包括服务端明确的拒绝,交给调用方处理),
 * 另一个取消。补发前第一个请求就失败(超时、连不上)时照常报错;补发后两个都失败才报错:
 * report 为 first 时报先失败的那个(两个请求走同一条路),为 primary 时报第一个请求的错(补发走的是另一条路,它的失败不代表这条路)。
 * final(error) 为真的失败不必等另一个请求(同一条路上另一个请求只会得到同样的结果),立刻报错。
 */
function raceWithHedge<T>(
  primary: (signal: AbortSignal) => Promise<T>,
  backup: (signal: AbortSignal) => Promise<T>,
  external: AbortSignal | undefined,
  onHedge: () => void,
  report: 'first' | 'primary',
  final?: (error: unknown) => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    // errors[0] 是第一个请求的错,errors[1] 是补发那次的错
    const errors: Array<{ error: unknown } | undefined> = [];
    let settled = false, hedged = false, running = 0, earliest: { error: unknown } | undefined;
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
    const launch = (index: number, start: (signal: AbortSignal) => Promise<T>) => {
      const ctrl = new AbortController();
      if (external?.aborted) ctrl.abort();
      controllers.push(ctrl);
      running++;
      start(ctrl.signal).then(
        result => settle(() => resolve(result)),
        error => {
          running--;
          errors[index] = { error };
          earliest ??= errors[index];
          if (final?.(error)) settle(() => reject(error));
          else if (!hedged || running === 0) settle(() => reject((report === 'first' ? earliest : errors[0] ?? errors[1])!.error));
        },
      );
    };
    launch(0, primary);
    timer = setTimeout(() => {
      if (settled || external?.aborted) return;
      hedged = true;
      onHedge();
      launch(1, backup);
    }, REWRITE_HEDGE_AFTER_MS);
  });
}

/**
 * 执行查询重写。queryRewrite 端点未配 model 时抛错(调用方降级)。
 * 请求方式按设置:默认只由浏览器直连;设为酒馆后端转发时经酒馆后端发出,酒馆服务器连不上或一直没有答复时改由浏览器直连(见上文「请求方式」)。
 * 渠道地址、密钥可留空复用 embedding。
 * 超时不重试:召回在正文生成前阻塞,超时多半是服务商卡住;服务端出错或限流时仍按重试次数重试。
 * 公网地址第一次请求 12 秒还没返回时补发一次(见 raceWithHedge)。
 */
export async function rewriteQuery(signal?: AbortSignal): Promise<RewriteResult> {
  const ep = runtimeEndpoint(resolveVectorModel('queryRewrite'), 'queryRewrite');
  if (!ep.model) throw new EmbedError('向量记忆还没有填写 Query 重写模型，请到「设置 → 向量记忆」里补全。', { kind: 'config' });
  const base = chatCompletionsBase(ep.url);
  if (!base) throw new EmbedError('向量记忆还没有填写 Query 重写地址（或 Embedding 地址），请到「设置 → 向量记忆」里补全。', { kind: 'config' });
  // 漏写协议的地址(如 localhost:11434/v1)两条路都发不出去,而且报出来的错看不出原因
  if (!/^https?:\/\//i.test(base)) {
    throw new EmbedError('Query 重写的地址（留空时是 Embedding 的地址）要以 http:// 或 https:// 开头，请到「设置 → 向量记忆」里检查。', { kind: 'config' });
  }
  const endpoint = `${base}/chat/completions`;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!chat.length) throw new Error('无对话上下文可重写');

  const built = buildMessages(chat, normalizeQueryRewriteContextChars(apiSettings.vector.queryRewriteContextChars));
  const messages = built.messages;
  const maxTokens = normalizeQueryRewriteMaxTokens(apiSettings.vector.queryRewriteMaxTokens);
  const req: RewriteRequest = { endpoint, base, ep, messages, maxTokens };
  // 只有明确设成酒馆后端转发才走后端;没有这一项的旧设置、认不出的值都按浏览器直连
  const setting: RewriteRoute = apiSettings.vector.queryRewriteRoute === 'backend' ? 'backend' : 'direct';
  const memo = routeMemo(endpoint);
  const local = isLocalAddress(endpoint);
  let hedged = false;
  /** 这一轮里先走后端、却由直连给了答复:接下来的重发(去掉参数再发)先走直连,不必再等后端 12 秒 */
  let directFirstThisRound = false;

  /** 直连这条路现在值不值得试:从没取得过答复又连不上的,十分钟内不试。 */
  const directUsable = () => Date.now() - memo.directFailedAt >= REWRITE_DIRECT_RETRY_AFTER_MS;

  /** 浏览器直连一次,并记下这条路通不通。 */
  const direct = async (params: ReadonlySet<OptionalParam>, s: AbortSignal | undefined, request: RewriteRequest = req): Promise<Outcome> => {
    try {
      const out = await directAttempt(request, params, s, message => directNetworkFailure(message, setting));
      memo.directAnswered = true;
      memo.directFailedAt = -Infinity;
      return out;
    } catch (e) {
      // 被取消的不算(另一个请求先有了结果,或用户停止了生成);取得过答复之后偶尔失败也不算。
      // 连不上是确定的,记一次就停用;超时可能只是服务商偶尔卡住,连着两次才停用
      if (!s?.aborted && !memo.directAnswered) {
        const stalled = e instanceof EmbedError && e.kind === 'timeout';
        if (stalled) memo.directStalls += 1;
        if (!stalled || memo.directStalls >= DIRECT_STALLS_TO_PAUSE) {
          memo.directFailedAt = Date.now();
          memo.directStalls = 0;
        }
      }
      throw e;
    }
  };

  /** 一次 send 里的临时情况:这一轮直连试过没有;直连补发给过的、暂时没有采用的拒绝。 */
  interface SendState { directTried: boolean; verdict?: Refusal }
  /** 直连补发不按重试次数重试:它失败得快才来得及改回经后端补发。 */
  const once: RewriteRequest = { ...req, ep: { ...ep, retries: 0 } };
  /** 因为后端的拒绝改由直连再试时:不重试,等待另有上限。 */
  const brief: RewriteRequest = { ...req, ep: { ...ep, retries: 0, timeoutSec: Math.min(ep.timeoutSec, REWRITE_OTHER_ROUTE_TIMEOUT_SEC) } };

  /**
   * 经一条路发出请求。公网地址 12 秒没有结果时补发一次。走后端、而后端这次会话还没有为这个地址取回过答复时,
   * 补发的那次先试浏览器直连:直连很快就失败的改回经后端补发,拖了很久才失败的不再补发。
   */
  const sendVia = (route: RewriteRoute, params: ReadonlySet<OptionalParam>, state: SendState): Promise<Outcome> => {
    const primary = (s: AbortSignal | undefined) => (route === 'backend' ? backendAttempt(req, params, s) : direct(params, s));
    if (local) return primary(signal);
    const cross = route === 'backend' && !memo.backendAnswered && directUsable();
    if (!cross) {
      // 两个请求都经后端:酒馆服务器在连接阶段就失败时不必等另一个,直接换路
      const final = route === 'backend' ? (e: unknown) => e instanceof Unreachable && e.definite : undefined;
      return raceWithHedge(primary, primary, signal, () => { hedged = true; }, 'first', final);
    }
    const backup = async (s: AbortSignal): Promise<Outcome> => {
      const started = Date.now();
      state.directTried = true;
      let failure: unknown;
      try {
        const out = await direct(params, s, once);
        if (out.ok) return out;
        // 原文点了可选参数的名:这是服务商对参数的定论,走哪条路都一样,立刻交给主流程去掉它
        if (rejectedParams(out, params).length) return out;
        // 其余的拒绝(或返回的不是有效数据)可能只针对浏览器这一路(来源、地区限制):先留着,后端这一轮没有答复时再用。
        // 说到流式传输的不留:直连是非流式的,只支持流式的模型会拒绝它,那不是后端那边的原因
        if (!mentionsStream(spoken(out.text, 'direct'))) state.verdict = out;
        failure = out.invalid ? invalidData() : vectorFailure(LABEL, out.failure);
      } catch (e) {
        if (s.aborted) throw e; // 另一个请求先有了结果,或用户停止了生成
        failure = e;
      }
      if (Date.now() - started > REWRITE_DIRECT_HEDGE_FAST_FAIL_MS) throw failure;
      return primary(s);
    };
    return raceWithHedge(primary, backup, signal, () => { hedged = true; }, 'primary');
  };

  /** 按顺序走各条路:前一条连不上服务器时换下一条,都连不上才报错。 */
  const send = async (params: ReadonlySet<OptionalParam>): Promise<Outcome> => {
    const order: RewriteRoute[] = setting === 'direct' ? ['direct']
      : memo.preferDirect || directFirstThisRound ? ['direct', 'backend'] : ['backend', 'direct'];
    const failed: Unreachable[] = [];
    const state: SendState = { directTried: false };
    const settle = (out: Outcome, backendFailed: boolean): Outcome => {
      if (setting === 'backend' && noteRoute(memo, order[0], out, backendFailed)) directFirstThisRound = true;
      return out;
    };
    for (const route of order) {
      // 这一轮直连已经试过、没有成功:不再把它当第二条路从头试一遍
      if (route === 'direct' && order[0] === 'backend' && state.directTried) break;
      const neverAnswered = !memo.backendAnswered;
      try {
        const out = settle(await sendVia(route, params, state), failed.length > 0);
        // 后端转来的拒绝可能只针对酒馆服务器这一路:后端这次会话还没成功过时,由浏览器直连用同样的参数再试一次
        const refusal = !out.ok && out.route === 'backend' && !out.fromHost && !out.invalid ? out : null;
        if (!refusal || order[0] !== 'backend' || local || memo.backendOk || state.directTried || !directUsable() || !routeBound(refusal)) return out;
        state.directTried = true;
        try {
          const other = await direct(params, signal, brief);
          // 直连成功,或原文点了可选参数的名(去掉之后接着走直连):用直连的
          if (other.ok || rejectedParams(other, params).length) return settle(other, true);
          // 后端只转来了状态说明、直连给出同样状态的拒绝:报直连的,里面有服务商的原话。别的拒绝仍报后端转来的那个
          if (refusal.statusOnly && !other.invalid && other.status === refusal.status) return other;
        } catch (inner) {
          if (signal?.aborted) throw inner; // 用户停止了生成
        }
        return out;
      } catch (e) {
        const timedOut = e instanceof EmbedError && e.kind === 'timeout';
        if (route === 'backend' && (timedOut || e instanceof Unreachable)) {
          if (timedOut) memo.backendAnswered = false; // 下一轮的补发重新试直连
          // 后端这一轮没有答复,而直连给过带原话的拒绝:用它,比「超时」「连不上」更说明问题
          if (state.verdict) return settle(state.verdict, e instanceof Unreachable);
        }
        if (route === 'backend' && timedOut) {
          // 后端这次会话从没取回过答复(酒馆服务器可能根本连不上这个地址,连接一直挂着),这一轮也还没试过直连:把直连当第二条路
          if (order[0] === 'backend' && neverAnswered && !state.directTried && directUsable()) {
            state.directTried = true;
            try {
              return settle(await sendVia('direct', params, state), true);
            } catch (inner) {
              if (signal?.aborted) throw inner;
            }
          }
          throw e;
        }
        if (route === 'direct' && setting === 'backend') {
          // 先用直连的时候它连不上了:回到先走后端。它只是超时的话,后端这次会话成功过才回去(否则后端多半还是不通)
          if (e instanceof Unreachable || (timedOut && memo.backendOk)) memo.preferDirect = false;
        }
        if (!(e instanceof Unreachable)) throw e;
        failed.push(e);
      }
    }
    throw unreachableError(failed, state.directTried);
  };

  // 被拒收的参数按接口地址和模型记:换了模型重新来过(支不支持流式传输、认不认 enable_thinking 都可能因模型而异)
  const paramKey = `${endpoint}\n${ep.model}`;
  const remember = (params: readonly OptionalParam[]) => droppedParams.set(paramKey, new Set([...(droppedParams.get(paramKey) ?? []), ...params]));
  /** 这一次发送去掉了哪些可选参数 */
  let sent = new Set<OptionalParam>(droppedParams.get(paramKey));
  let out = await send(sent);
  /** 试着改用非流式之前,后端转来的那条带原话的拒绝(原话提到了流式传输) */
  let streamRefusal: Refusal | undefined;
  /** 盲试(非流式转发时看不到原话):开始时已经去掉的参数、下一个要试的组合、上一次发送试的那个组合 */
  let blindBase: ReadonlySet<OptionalParam> | undefined;
  let nextPlan = 0;
  let blind: readonly OptionalParam[] = [];
  for (let round = 0; !out.ok && round < MAX_RESENDS; round++) {
    const named = rejectedParams(out, sent);
    let next: Set<OptionalParam> | undefined;
    let trying: readonly OptionalParam[] = [];
    if (named.length) {
      // 原文点了名:enable_thinking、top_p 去掉并记住;stream 先试,试成功了才记
      if (named[0] === 'stream') streamRefusal = out;
      else remember(named);
      next = new Set([...sent, ...named]);
    } else if (out.statusOnly && (out.status === 400 || out.status === 422)) {
      // 酒馆只转来状态说明:可能是可选参数被拒收,按组合各试一次,每次都从开始盲试时的参数出发
      const base = (blindBase ??= sent);
      while (nextPlan < BLIND_PLANS.length && BLIND_PLANS[nextPlan].some(p => base.has(p))) nextPlan++;
      if (nextPlan < BLIND_PLANS.length) {
        trying = BLIND_PLANS[nextPlan++];
        next = new Set([...base, ...trying]);
      }
    }
    if (!next) break;
    blind = trying;
    sent = next;
    out = await send(sent);
  }
  if (!out.ok) {
    // 试着改用非流式也没有成功,酒馆转来的又只是同一类的状态说明:报最初那条带原话的拒绝(不记「不支持流式传输」)。
    // 转来的是别的状态时报非流式这一次的,把最初那条的原话附在细节里
    const fellThrough = !!streamRefusal && !!out.statusOnly && (out.status === 400 || out.status === 422);
    const report = fellThrough ? streamRefusal! : out;
    if (report.invalid) throw invalidData();
    throw vectorFailure(LABEL, rewriteWording(report, { nonStreamTried: fellThrough, earlier: out.statusOnly && !fellThrough ? streamRefusal : undefined }));
  }
  // 试出来的在经后端取得成功时才记住(直连看得到原话,用不着猜)。盲试去掉参数才成功的只记那些参数:
  // 非流式原样重发成功,才说明问题出在流式传输上;下一轮带着记住的参数先用流式,仍被拒绝再试非流式
  if (out.route === 'backend') {
    const proven: readonly OptionalParam[] = blind.length ? blind : streamRefusal ? ['stream'] : [];
    if (proven.length) remember(proven);
  }

  const json = out.json;
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  let raw = typeof content === 'string' ? content : '';
  const meta = {
    finishReason: choice?.finish_reason,
    maxTokens,
    sawReasoning: !!(choice?.message?.reasoning_content || choice?.message?.reasoning),
  };
  // 服务商中断了回复(结束原因是出错一类,或流式回复的最后一块没写完):最后一行可能只写了一半,不拿去检索。
  // 只是没有结束标记的照用:多半是这个服务不发,丢掉最后一行反而每次都少一条
  const interrupted = out.incomplete === 'cut' || finishKind(meta.finishReason) === 'interrupted';
  if (interrupted) raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
  /** 没有可用内容时,回复没有正常结束的按中断报,不说成空回复或格式不对 */
  const unfinished = interrupted ? interruptedReply(meta, '') : out.incomplete ? unfinishedReply() : null;
  if (!raw.trim()) {
    if (unfinished) throw vectorFailure(LABEL, unfinished);
    // 输出上限太小时,思考型模型常常整段都花在思考上,正文为空。
    const streamed = out.route === 'backend' && !sent.has('stream');
    throw vectorFailure(LABEL, finishKind(meta.finishReason) === 'truncated' ? truncatedReply(meta, '') : emptyRewriteReply(streamed, meta));
  }

  const parsed = parseResponse(raw);
  if (!parsed.queries.length) {
    if (unfinished) throw vectorFailure(LABEL, unfinished);
    throw new EmbedError(noQueryMessage(parsed), { kind: 'format' });
  }
  const usage = json?.usage;
  const tokens = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const reasoningTokens = tokens(usage?.completion_tokens_details?.reasoning_tokens);
  const stats: RecallRewriteStats = {
    inputChars: totalChars(messages),
    contextChars: built.contextChars,
    sentContextChars: built.sentContextChars,
    trimmed: built.trimmed,
    hedged,
    route: out.route,
    fellBack: setting === 'backend' && out.route === 'direct',
    promptTokens: tokens(usage?.prompt_tokens),
    completionTokens: tokens(usage?.completion_tokens),
    reasoningTokens,
    // 思考型模型(或服务商没认 enable_thinking)会先输出思考内容,这是重写变慢最常见的原因
    thinking: (reasoningTokens ?? 0) > 0 || meta.sawReasoning || /<think(?:ing)?\b/i.test(raw),
  };
  return { intent: parsed.intent, queries: parsed.queries, stats };
}
