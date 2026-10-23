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
 * 任何失败都抛错,由召回侧 catch 后清空召回槽,不阻断正文生成。
 */

import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { apiSettings, resolveVectorModel } from '@/api/settings';
import { deriveMemory, getLeaf, leafValid } from '../apply';
import { resolveKeepStart } from '../engine';
import { renderHistoryNodes, selectHistoryNodesBefore } from '../inject';
import { fmtItems, fmtNpcs, fmtPlans, fmtProtagonist, QUERY_REWRITE_SYSTEM, QUERY_REWRITE_TAIL } from '../prompts';
import { memory } from '../store';
import { cleanBody } from '../timeTag';
import { EmbedError, fetchWithTimeoutRetry, vectorFailure } from './embed';
import { normalizeQueryRewriteMaxTokens, runtimeEndpoint } from './params';
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

/**
 * 构造状态快照文本(只含滚出窗口、长期有效的 items/plans)。
 * upTo = 第一个无叶子楼的索引(快照截到它之前)。无有意义内容返回空串。
 */
function buildStateSnapshot(chat: STMessage[], upTo: number): string {
  const st = deriveMemory(chat, upTo);
  const lines: string[] = [];
  if (Object.values(st.protagonist).some(Boolean)) {
    lines.push(`主角当前档案:\n${fmtProtagonist(st.protagonist)}`);
  }
  if (st.items.length) {
    lines.push(`物品清单:\n${fmtItems(st.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`);
  }
  if (st.npcs.length) {
    lines.push(`NPC名册:\n${fmtNpcs(st.npcs.map(n => ({ name: n.name, gender: n.gender, title: n.title, follow: n.follow, location: n.location, locationStale: n.locationStale, lastKnownLocation: n.lastKnownLocation })))}`);
  }
  const openPlans = st.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    lines.push(`未了结的计划/悬念:\n${fmtPlans(openPlans.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })))}`);
  }
  if (!lines.length) return '';
  return `[状态快照:以下为已滚出最近窗口、但仍有效的主角档案、物品、NPC 与未了结计划,供你解析模糊指代]\n${lines.join('\n')}`;
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

/**
 * 构造发给 rewrite 模型的消息序列。
 *
 * ⚠️ 许多向量渠道要求 system 消息**仅允许出现在数组最开头**,中间不得再有 system。
 * 故对齐 Horae 的形态:**开头唯一一条 system + 中间纯 user/assistant 对话 + 结尾一条 user**。
 *  - 历史剧情摘要并入开头那条 system(属背景设定,合法地待在开头);
 *  - 状态快照不独立成 system,而是**拼进对话消息正文**(放在 cut 点前一条之后、洞楼之前),
 *    保持中间无 system,从而兼容「system 只能在开头」的渠道。
 */
function buildMessages(chat: STMessage[]): ChatMsg[] {
  const windowStart = resolveKeepStart(chat);
  const cut = findSnapshotCut(chat, windowStart);

  // 开头唯一 system:系统提示词 +(可选)历史剧情摘要,合并为一条,保证 system 只出现在开头
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, windowStart));
  let systemContent = history ? `${QUERY_REWRITE_SYSTEM}\n\n[历史剧情摘要]\n${history}` : QUERY_REWRITE_SYSTEM;
  // 启用附加任务说明时,置顶拼进开头这条唯一 system。
  // 不新增一条 system,以守住「system 仅允许出现在数组最开头」的渠道约束——拼进即等于「最开头 + system 身份」。
  // 与摘要/总结共用 default/custom/disabled 解析;自定义空白不回退默认。
  if (apiSettings.vector.queryRewriteJailbreak) {
    const jb = taskContextPrompt();
    if (jb) systemContent = `${jb}\n\n${systemContent}`;
  }
  const messages: ChatMsg[] = [{ role: 'system', content: systemContent }];

  // 平铺窗口对话(纯 user/assistant),记录原 msgIndex 以定位快照插入点
  const convo: Array<{ role: 'user' | 'assistant'; content: string; index: number }> = [];
  for (let i = windowStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    if (m.extra?.bbs_omit) continue;
    if (m.is_system && m.extra?.type) continue; // 原生系统楼跳过
    const text = cleanFloor(m);
    if (!text) continue;
    convo.push({ role: m.is_user ? 'user' : 'assistant', content: text, index: i });
  }

  // 状态快照:拼进对话消息正文(不独立成 system)。语义 = 截止 cut(第一个无叶子楼)之前的确凿状态。
  const snapshot = buildStateSnapshot(chat, cut);
  if (snapshot) {
    if (!convo.length) {
      // 窗口无可用对话消息 → 兜底放一条 user 承载(仍非 system)
      messages.push({ role: 'user', content: snapshot });
    } else {
      const cutPos = convo.findIndex(c => c.index >= cut);
      if (cutPos === -1) {
        // cut 在所有对话之后(窗口全有叶子)→ 拼进最后一条末尾
        const last = convo[convo.length - 1];
        last.content = `${last.content}\n\n${snapshot}`;
      } else if (cutPos === 0) {
        // cut 点即首条对话(之前无对话可承载)→ 拼进它的前缀
        convo[0].content = `${snapshot}\n\n${convo[0].content}`;
      } else {
        // 拼进 cut 点前一条对话的末尾(连续叶子前缀末尾之后、洞楼之前)
        const prev = convo[cutPos - 1];
        prev.content = `${prev.content}\n\n${snapshot}`;
      }
    }
  }

  for (const c of convo) messages.push({ role: c.role, content: c.content });

  // 收尾提示词
  messages.push({ role: 'user', content: QUERY_REWRITE_TAIL });
  return messages;
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

/**
 * 执行查询重写。queryRewrite 端点未配 model 时抛错(调用方降级)。
 * 走前端直连 chat/completions(与 embed 同源策略,渠道地址/密钥可留空复用 embedding)。
 * 超时不重试:召回在正文生成前阻塞,超时多半是服务商卡住;服务端出错或限流时仍按重试次数重试。
 */
export async function rewriteQuery(signal?: AbortSignal): Promise<RewriteResult> {
  const ep = runtimeEndpoint(resolveVectorModel('queryRewrite'), 'queryRewrite');
  if (!ep.model) throw new EmbedError('向量记忆还没有填写 Query 重写模型，请到「设置 → 向量记忆」里补全。', { kind: 'config' });
  const endpoint = chatCompletionsEndpoint(ep.url);
  if (!endpoint) throw new EmbedError('向量记忆还没有填写 Query 重写地址（或 Embedding 地址），请到「设置 → 向量记忆」里补全。', { kind: 'config' });

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!chat.length) throw new Error('无对话上下文可重写');

  const messages = buildMessages(chat);
  const maxTokens = normalizeQueryRewriteMaxTokens(apiSettings.vector.queryRewriteMaxTokens);
  const dropped = droppedParams.get(endpoint) ?? new Set<OptionalParam>();
  const send = () => {
    // 对齐 Horae:低温更服从格式;enable_thinking:false 关思维链——
    // 国产模型(Qwen3/GLM 等)默认开思维链会先吐 <think> 推理,冲乱 INTENT/Q 行格式导致解析失败。
    const body: Record<string, unknown> = { model: ep.model, messages, temperature: 0.1, max_tokens: maxTokens, stream: false };
    if (!dropped.has('top_p')) body.top_p = 0.8;
    if (!dropped.has('enable_thinking')) body.enable_thinking = false;
    return fetchWithTimeoutRetry(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key || ''}` },
        body: JSON.stringify(body),
      },
      { timeoutSec: ep.timeoutSec, retries: ep.retries, label: 'Query 重写', externalSignal: signal, retryOnTimeout: false },
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
  return { intent: parsed.intent, queries: parsed.queries };
}
