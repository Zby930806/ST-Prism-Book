import { BUDGET_NOTICE, estimateTokens, slotBudget } from '../budget';
/**
 * 阻塞式向量召回:生成主回复前,按用户输入 + 近期上下文检索相关旧记忆,注入主对话。
 *
 * 管线(全程阻塞,对齐既定方案,不做预取/异步):
 *  0. 补索引:召回前补齐缺失的向量;最多等 Embedding 端点「超时 ×(重试次数+1)」,到时先用已有索引,补建在后台继续。
 *  1. 查询重写(必需):小模型把当前剧情重写成 INTENT + 多条检索 Q;失败则清空召回槽,不阻断正文生成。
 *     补索引与查询重写互不依赖,同时进行;检索等两者都结束后再开始。各步用时记进召回调试。
 *  2. 各 query 各自 embed → vec/search(scopes = 当前 chat + 各 bundle,后端多路融合),
 *     纯按 embedding 得分取前 rerankCandidates 条(不套阈值)。
 *  3. rerank 候选(用 INTENT 作 query;INTENT 为空时用全部 Q 拼接)。没有重排(未填模型、接口不支持或请求失败)时
 *     按融合顺序继续,并在召回状态和调试面板写明原因。
 *  4. 分档:全文档(已重排且 rerank≥阈值,取前 fullTextCount,发原文)/ 摘要档(其余达到 rerank 阈值的,
 *     或 embedding≥阈值的,发摘要)。没有重排时不发原文。
 *  5. 按 leaf_id 去重 + 排除当前窗口内已全文的叶子 → 放进召回预算(原文放不下改发摘要)→ 拼注入文本 → setExtensionPrompt。
 *
 * 失败/未配置全程静默降级(清空注入槽),向量是增强项,绝不阻断生成;用户点停止生成时召回随之取消。
 * 整次召回另有兜底时限(三个端点「超时 ×(重试次数+1)」之和),防止某一步一直没有返回。
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { memory, memoryWriteIssue } from '../store';
import type { VecHit } from '@/api/baibaoku';
import { vecSearch } from './store';
import { classifyNpcPresence, getLeaf, leafValid } from '../apply';
import { MEMORY_BRIEFING_NOTE } from '../prompts';
import { selectInjectionNodes } from '../inject';
import { embedTexts, encodeFloat32Base64, rerankDocuments } from './embed';
import { rewriteQuery } from './rewrite';
import { collectLeaves, ensureRecallIndex } from './index';
import { fuseRecallRoutes, keywordHits, presentOrderKey, recallEntities, type FusedCandidate, type KeywordHit } from './routes';
import { currentBundleHashes, currentChatId, currentChatScope, currentVectorDb, recallScopes } from './scope';
import { isAiFloor, resolveKeepStart } from '../engine';
import { cleanBody, compactTimeLabel, latestStoryTime, splitTimeLabel } from '../timeTag';
import { relativeTimeLabel } from '../timeRel';
import { normalizeRecallInjectionDepth } from './depth';
import { RECALL_CACHE_STORAGE_KEY } from './cache';
import { indexModelIssue } from './indexModel';
import { endpointBudgetMs, normalizeRecallParams, recallDeadlineMs } from './params';
import {
  previewOf,
  RECALL_DONE_NONE_PASSED,
  RECALL_DONE_OVER_BUDGET,
  RECALL_STOPPED,
  resetRecallDebug,
  restoreRecallDebug,
  setRecallEmbedding,
  setRecallIndexNote,
  setRecallIndexPending,
  setRecallInjected,
  setRecallKeyword,
  setRecallRerank,
  setRecallRerankIssue,
  setRecallRewrite,
  setRecallRewriteStats,
  setRecallStatus,
  setRecallTiming,
  snapshotRecallDebug,
  type RecallDebug,
  type RecallDebugRerankHit,
  type RecallDropReason,
} from './debug';

// 注入槽位:贴近历史摘要层(顶部附近),与 inject.ts 的历史摘要同一区域但独立 key。
const RECALL_INJECT_KEY = 'baibai_book_vector_recall';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/**
 * 召回块专用的短结束语。完整的结束说明(位置、伤情、计划等)放在离回复最近的状态块;
 * 这里只保留和旧片段有关的要点:按各自时间理解、当前剧情优先、人物知情范围、不复述不模仿。
 * 标点与 MEMORY_BRIEFING_NOTE、历史块的短收尾保持一致。
 */
export const RECALL_BRIEFING_END =
  '〔相关回忆结束〕以上是按需取回的旧片段,按各自标注的时间理解;当前明确剧情优先,人物只知道自己经历或得知的事。不要复述,也不要模仿其中的记录句式。';

/** 没有重排时,只由关键词命中的段落最多收几条(没有相关度打分,只凭名字出现过)。 */
const KEYWORD_ONLY_LIMIT_UNRERANKED = 2;

/** 当前召回注入深度;运行时再归一化,兼容用户正在编辑输入框时产生的临时非法值。 */
function recallInjectionDepth(): number {
  return normalizeRecallInjectionDepth(apiSettings.vector.recall.injectionDepth);
}

/**
 * 命中来源标记:
 *  - scope 等于当前聊天 → 本聊天命中,显示楼层号「#5」(召回时按 leafId 在当前聊天里重新定位);
 *  - 否则(bundle:<hash>)→ 来自「带数据建新对话」冻结的旧聊天快照,显示「旧档」。
 * 旧聊天的真实名字/楼层号未追踪(bundle 只存 hash),故统一标「旧档」让用户知道非本聊天。
 */
function sourceLabel(hit: VecHit, selfScope: string | null): string {
  if (selfScope && hit.scope === selfScope) {
    return typeof hit.msgIndex === 'number' && hit.msgIndex >= 0 ? `#${hit.msgIndex}` : '本聊天';
  }
  return '旧档';
}

/** 当前保留窗口内、已发全文的叶子 id(召回要排除它们,避免与全文重复)。 */
function windowLeafIds(chat: STMessage[]): string[] {
  const keepStart = resolveKeepStart(chat);
  const ids: string[] = [];
  for (let i = keepStart; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (leafValid(chat[i])) ids.push(getLeaf(chat[i])!.id);
  }
  return ids;
}

/**
 * 当前聊天里每条有效叶子所在的楼层号。索引里的楼层号只在写入向量时记下,
 * 用酒馆原生功能删掉更早的楼层后会过期,召回时按 leafId 重新定位。
 */
function leafFloorMap(chat: STMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) continue;
    const id = getLeaf(chat[i])?.id;
    if (id) map.set(id, i);
  }
  return map;
}

/** 本聊天命中的楼层号换成当前位置;找不到(索引还没对账)时保留原值。 */
function relocateHit<T extends VecHit>(hit: T, selfScope: string | null, floors: Map<string, number>): T {
  if (!selfScope || hit.scope !== selfScope) return hit;
  const floor = floors.get(hit.leafId);
  return floor === undefined || floor === hit.msgIndex ? hit : { ...hit, msgIndex: floor };
}

/**
 * 已在[历史剧情摘要]里原样发送的叶子 id。召回时它们不再按摘要档发送(重复),全文档照常允许(原文比摘要详细)。
 * 只在记忆注入预算为 0(不限制)时判断:这时选出的叶子全部会发出去;填写了预算时历史块可能被截断,不排除。
 */
function historyLeafIds(chat: STMessage[]): Set<string> {
  if (Number.isFinite(slotBudget('history'))) return new Set();
  return new Set(selectInjectionNodes(memory.summaries, chat).filter(n => n.kind === 'leaf').map(n => n.id));
}

/** 当前聊天 AI 楼数(与 keepRecent/minAiFloors 同口径:只数 AI 消息)。 */
function aiFloorCount(chat: STMessage[]): number {
  let n = 0;
  for (const m of chat) if (isAiFloor(m)) n++;
  return n;
}

/**
 * 本回合是否值得跑召回。带数据建新对话的旧档(bundle)始终值得召回——里面是当前聊天没有的旧记忆,
 * 不受任何阈值限制,直接放行。无 bundle 时才看本聊天是否有「窗口外」可召的旧楼:
 *  - resolveKeepStart===0:没有任何 AI 楼被推出滑动窗口,全在窗口内全文发送,
 *    召回的旧楼都会被 windowLeafIds 排除掉,纯属浪费(重写+embed+search+rerank 的额度与延迟)→ 跳过。
 *  - AI 楼数 < minAiFloors(用户设的起召门槛):早期剧情旧记忆少,用户嫌没必要 → 跳过。
 * 任一跳过条件命中即返回 false;否则 true。
 */
function recallWorthRunning(chat: STMessage[], cfg: typeof apiSettings.vector.recall): boolean {
  if (currentBundleHashes().length > 0) return true; // 旧档无条件召回
  if (resolveKeepStart(chat) === 0) return false; // 全在窗口内,无窗口外旧楼可召
  const min = cfg.minAiFloors;
  if (min > 0 && aiFloorCount(chat) < min) return false; // 未达用户起召门槛
  return true;
}

/** 轻量稳定 hash(FNV-1a,16 进制),与 index.ts 同口径。用于缓存 key 的内容指纹。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 召回结果缓存:重新生成 / 翻页(swipe)时召回输入一字不变,直接复用上次结果,
 * 省掉重写+embed+search+rerank 的额度与时间。只存「最近一次」一条,key 不匹配即覆盖。
 *
 * key = chatId | 最新user楼层号 | hash(最新user文本) | hash(上一条AI文本) | 召回参数指纹
 *  - 带 user 文本 hash:编辑最新输入后重生成,楼层号没变但内容变了,靠它失效(否则错误复用)。
 *  - 带 AI 文本 hash:编辑上一条 AI 楼后重生成,靠它失效。
 *  - 带召回参数指纹:rerank/embedding 阈值、条数等任一改动则失效;只改别的设置(渠道/开关)不失效。
 *  - 带 chatId:换聊天后楼层号/哈希偶然相同也不跨聊天误命中。
 */
interface RecallCache {
  key: string;
  text: string;
  debug: RecallDebug;
}

// 暂存到 localStorage:切后台被浏览器丢弃、刷新、开新标签页后召回缓存仍在,免得白白重召回。
// 跨天/跨标签的残留无副作用:key 已含 chatId+楼层+内容哈希+参数指纹,对不上只会重算,绝不误命中。
// (不违反「设置别用 localStorage」那条——那是设置要跨设备同步必走服务器;召回缓存是本机临时结果,无需同步。)
// 失败全静默(隐私模式/配额满):退化为无缓存,绝不影响召回主流程。
function loadRecallCache(): RecallCache | null {
  try {
    const raw = localStorage.getItem(RECALL_CACHE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecallCache) : null;
  } catch {
    return null;
  }
}

function saveRecallCache(cache: RecallCache): void {
  try {
    localStorage.setItem(RECALL_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* 配额满/不可用:放弃持久化,本次仅本进程内有效 */
  }
}

/**
 * 召回参数指纹:覆盖全部影响最终注入文本的档位参数。
 * 注入深度只改变同一文本的位置,不改变检索结果,故不计入并可直接复用缓存。
 */
function recallParamFingerprint(cfg: typeof apiSettings.vector.recall): string {
  return [
    cfg.rerankCandidates,
    cfg.embeddingThreshold,
    cfg.rerankThreshold,
    cfg.fullTextCount,
    cfg.finalRecallCount,
    apiSettings.memoryBudgetTokens,
    cfg.keywordRoute === true,
    cfg.presentBoost === true,
    cfg.stickyTurns ?? 0,
    // 拼注入文本或分档的规则变了就换标记,让旧缓存失效
    // (v3:原文放不下改发摘要;v4:超出全文数的高分段落改发摘要、未重排不发原文、跳过历史块里的摘要、召回块短结束语)
    "prompt-v4",
  ].join(',');
}

/**
 * 构造当前轮的缓存 key。取「最新 user 楼层」需从后往前扫第一条 is_user——
 * 重生成时末尾可能是待替换的 AI 楼/系统楼,直接取 chat[length-1] 会取错。
 * 上一条 AI 文本 = 该 user 楼**之前**第一条非 user 楼(没有则空)。
 * ⚠️ 不能取 user 之后那条:swipe 时那正是被重生成、内容每次都变的当前 AI 楼,
 *    取了它缓存永不命中、白做。取 user 之前的稳定 AI 楼才对。
 * 缺 chatId 或无 user 楼 → 返回 null,本轮不走缓存(照常实算)。
 */
function buildRecallCacheKey(chat: STMessage[], cfg: typeof apiSettings.vector.recall): string | null {
  const chatId = currentChatId();
  if (!chatId) return null;

  let userIdx = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]?.is_user) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return null;

  const userText = chat[userIdx]?.mes ?? '';
  let aiText = '';
  for (let i = userIdx - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) {
      aiText = chat[i]?.mes ?? '';
      break;
    }
  }

  return `${chatId}|${userIdx}|${fnv1a(userText)}|${fnv1a(aiText)}|${recallParamFingerprint(cfg)}`;
}

interface RecallRun {
  generation: number;
  chat: STMessage[];
  metadata: NonNullable<ReturnType<typeof getContext>>['chatMetadata'];
  chatId: string | undefined;
  database: string;
  scopes: string[];
  cacheKey: string | null;
  controller: AbortController;
  externalSignal?: AbortSignal;
  promise?: Promise<void>;
  /** 整次召回的兜底时限(毫秒) */
  deadlineMs: number;
  /** 兜底时限已到,召回被放弃 */
  timedOut?: boolean;
}

let recallGeneration = 0;
let activeRecall: RecallRun | null = null;

/** 不比较 getContext() 包装对象:宿主可能每次返回新包装,但 chat/meta 必须仍属本聊天。 */
function ownsRecallContext(run: RecallRun): boolean {
  const ctx = getContext();
  return activeRecall === run && run.generation === recallGeneration && !!ctx
    && ctx.chat === run.chat && ctx.chatMetadata === run.metadata
    && ctx.getCurrentChatId?.() === run.chatId;
}

function recallRunAllowed(run: RecallRun): boolean {
  return ownsRecallContext(run) && !run.controller.signal.aborted
    && !memoryWriteIssue() && recallActiveHere()
    && currentVectorDb() === run.database
    && JSON.stringify(recallScopes()) === JSON.stringify(run.scopes);
}

function assertRecallCurrent(run: RecallRun): void {
  if (recallRunAllowed(run)) return;
  run.controller.abort();
  const error = new Error('召回已取消或聊天上下文已变化');
  error.name = 'AbortError';
  throw error;
}

function cancelActiveRecall(): void {
  const previous = activeRecall;
  activeRecall = null;
  recallGeneration++;
  previous?.controller.abort();
}

/** 即使底层忽略 signal(例如 vecSearch),取消也及时放行旧调用;迟到结果不再继续管线。 */
async function awaitRecall<T>(run: RecallRun, task: () => Promise<T>): Promise<T> {
  assertRecallCurrent(run); // 每次外发前重新检查,不让 helper 的下一步绕过保护
  const signal = run.controller.signal;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('召回已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([task(), cancelled]);
    assertRecallCurrent(run);
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** 内部清槽不取消别的任务;调用者必须先验证 owner。公开清槽则使整条旧管线失效。 */
function clearRecallSlot(): void {
  getContext()?.setExtensionPrompt?.(RECALL_INJECT_KEY, '', IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
}

/** 召回是否在当前聊天生效。 */
function recallActiveHere(): boolean {
  if (!engineActiveHere()) return false; // 插件总开关关 / 当前角色被排除 → 不召回
  if (!apiSettings.vector.enabled) return false;
  return !!currentVectorDb() && recallScopes().length > 0;
}

/** 这种生成类型是否该触发召回:只在产出新正文的生成前召回。 */
export function shouldRecallForType(type: string | undefined): boolean {
  // 续写/安静/扮演不需要召回旧记忆(continue 接着写、quiet/impersonate 非剧情推进)
  return type !== 'continue' && type !== 'quiet' && type !== 'impersonate';
}

/**
 * 生成前召回的取消信号:召回期间临时监听一次酒馆的「停止生成」(GENERATION_STOPPED),
 * 用户点停止即中止召回(召回保留表不动);召回结束后调用 dispose 取消监听。
 * 宿主不提供移除监听的方法时,监听在 dispose 之后不再生效。
 */
export function recallStopSignal(): { signal: AbortSignal; dispose: () => void } {
  type StopSource = {
    on(event: string, fn: () => void): void;
    off?(event: string, fn: () => void): void;
    removeListener?(event: string, fn: () => void): void;
  };
  const controller = new AbortController();
  const ctx = getContext();
  const es = ctx?.eventSource as StopSource | undefined;
  const event = ctx?.eventTypes?.GENERATION_STOPPED;
  let active = true;
  const onStop = () => {
    if (active) controller.abort();
  };
  if (es && event) es.on(event, onStop);
  return {
    signal: controller.signal,
    dispose: () => {
      if (!active) return;
      active = false;
      if (!es || !event) return;
      if (typeof es.removeListener === 'function') es.removeListener(event, onStop);
      else es.off?.(event, onStop);
    },
  };
}

/** 清空召回注入槽(降级/未命中/切聊天时)。 */
export function clearRecallInjection(): void {
  cancelActiveRecall();
  clearRecallSlot();
  sticky = null;
}

/* ============ 召回保留(上一轮注入的段落在之后几轮有空位时保留) ============ */

interface StickyEntry {
  hit: RankedHit;
  turnsLeft: number;
}
let sticky: { chatId: string; entries: Map<string, StickyEntry> } | null = null;

/** 本轮可补位的保留段落:同一聊天、还有剩余轮数、不在全文窗口内、本轮候选里没有的。 */
function stickyCandidates(chatId: string | undefined, exclude: Set<string>, taken: Set<string>): RankedHit[] {
  if (!chatId || sticky?.chatId !== chatId) return [];
  const out: RankedHit[] = [];
  for (const [id, e] of sticky.entries) {
    if (e.turnsLeft > 0 && !exclude.has(id) && !taken.has(id)) out.push({ ...e.hit, route: 'sticky' });
  }
  return out;
}

/** 一次新召回结束后更新保留表:本轮新入选的重置为 N 轮,其余(含靠保留补位的)各减一轮。 */
function updateSticky(chatId: string | undefined, pool: RankedHit[], selected: Map<string, 'full' | 'brief'>, turns: number): void {
  if (!chatId || turns <= 0) { sticky = null; return; }
  const prev = sticky?.chatId === chatId ? sticky.entries : new Map<string, StickyEntry>();
  const next = new Map<string, StickyEntry>();
  for (const [id, e] of prev) if (e.turnsLeft > 1) next.set(id, { hit: e.hit, turnsLeft: e.turnsLeft - 1 });
  for (const h of pool) {
    if (h.route !== 'sticky' && selected.has(h.leafId)) next.set(h.leafId, { hit: { ...h }, turnsLeft: turns });
  }
  sticky = { chatId, entries: next };
}

/* ============ 关键词一路 ============ */

/** 当前对话里用来找名字的文字:查询重写的意图和问题 + 最新用户输入 + 它前面那条 AI 回复。 */
function keywordQueryText(chat: STMessage[], intent: string, queries: string[]): string {
  const parts = [intent, ...queries];
  let userIdx = -1;
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user) { userIdx = i; break; }
  if (userIdx >= 0) {
    parts.push(cleanBody(chat[userIdx].mes ?? ''));
    for (let i = userIdx - 1; i >= 0; i--) if (isAiFloor(chat[i])) { parts.push(cleanBody(chat[i].mes ?? '')); break; }
  }
  return parts.filter(Boolean).join('\n');
}

/** 名册、物品、地点名字在本聊天(全文窗口外)摘要里的精确匹配。 */
function findKeywordHits(chat: STMessage[], exclude: Set<string>, queryText: string, limit: number): KeywordHit[] {
  const ctx = getContext();
  const leaves = collectLeaves(chat).filter(l => !exclude.has(l.leafId));
  const entities = recallEntities(memory, [ctx?.name1 ?? '', ctx?.name2 ?? '']);
  return keywordHits(leaves, entities, queryText, limit);
}

/** 当前在场的角色名(名册在场判定 + 局势卡在场者),主角除外。 */
function presentNames(): string[] {
  const names = new Set<string>();
  for (const n of memory.npcs) {
    if (classifyNpcPresence(n, memory.scenes, memory.state.location, memory.state.locationPath) === 'present') names.add(n.name);
  }
  for (const p of memory.state.sceneFocus?.participants ?? []) names.add(p);
  names.delete(getContext()?.name1?.trim() ?? '');
  return [...names];
}

/**
 * 执行一次阻塞召回并写注入槽。在生成拦截器放行路径里 await。
 * 任何失败都清空槽并返回(静默降级)。
 */
export async function runVectorRecall(signal?: AbortSignal): Promise<void> {
  if (memoryWriteIssue() || !recallActiveHere()) {
    clearRecallInjection();
    return;
  }
  // 已取消的调用不接管/清空一个正在正常运行的新任务。
  if (signal?.aborted) return;
  const database = currentVectorDb();
  const ctx = getContext();
  if (!database || !ctx || typeof ctx.setExtensionPrompt !== 'function' || !ctx.chat.length) {
    cancelActiveRecall();
    return;
  }
  const chat = ctx.chat;
  // 输入框可能暂时为空或越界:召回参数先按设置页失焦回填的同一套规则收敛
  const cfg = normalizeRecallParams(apiSettings.vector.recall);
  const cacheKey = buildRecallCacheKey(chat, cfg);
  // 同上下文、同输入的重入仍阻塞等待同一次召回,既不重复计费也不提前放行正文。
  if (activeRecall && recallRunAllowed(activeRecall) && cacheKey !== null
    && activeRecall.cacheKey === cacheKey && activeRecall.externalSignal === signal) {
    return activeRecall.promise;
  }
  cancelActiveRecall();
  const run: RecallRun = {
    generation: recallGeneration, chat, metadata: ctx.chatMetadata,
    chatId: ctx.getCurrentChatId?.(), database, scopes: recallScopes(), cacheKey,
    controller: new AbortController(), externalSignal: signal,
    deadlineMs: recallDeadlineMs(apiSettings.vector),
  };
  activeRecall = run;
  const onAbort = () => run.controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  // 兜底时限:某一步一直没有返回时放弃本次召回,放行正文生成
  const deadline = setTimeout(() => {
    run.timedOut = true;
    run.controller.abort();
  }, run.deadlineMs);
  run.promise = executeRecall(run, cfg).finally(() => {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
    // 旧任务完成/失败绝不能释放新任务的 owner。
    if (activeRecall === run && run.generation === recallGeneration) activeRecall = null;
  });
  return run.promise;
}

/** 兜底时限到了还没完成时的说明。 */
function recallTimeoutText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `超过 ${seconds} 秒仍未完成（时限为三个端点「超时 ×（重试次数 + 1）」之和），已放弃本次召回。请检查「设置 → 向量记忆」中各端点的地址和网络`;
}

function currentEmbeddingModel(): string {
  const model = apiSettings.vector?.embedding?.model;
  return typeof model === 'string' ? model.trim() : '';
}

async function executeRecall(run: RecallRun, cfg: typeof apiSettings.vector.recall): Promise<void> {
  const { chat, database, scopes, cacheKey } = run;
  const signal = run.controller.signal;
  const inject = (text: string) => {
    assertRecallCurrent(run);
    getContext()!.setExtensionPrompt!(RECALL_INJECT_KEY, text, IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
    // 宿主回调也可能触发切换/清槽,后续 debug/cache 同样不得写入。
    assertRecallCurrent(run);
  };
  // 本次实算开始的时刻(复用缓存或没走到实算时为 0),失败时同样记下整次用时
  let started = 0;
  try {
    assertRecallCurrent(run);
    if (!recallWorthRunning(chat, cfg)) {
      // 先清掉上一次的各阶段结果,免得面板和快捷回复按钮把旧的召回内容当成这一次的
      resetRecallDebug();
      setRecallStatus('未召回:楼层未达起召门槛或全在窗口内');
      inject('');
      return;
    }
    const cached = cacheKey ? loadRecallCache() : null;
    if (cacheKey && cached && cached.key === cacheKey && estimateTokens(cached.text) <= slotBudget('recall')) {
      inject(cached.text);
      restoreRecallDebug(cached.debug);
      setRecallStatus(`${cached.debug.status}(复用缓存)`);
      return;
    }
    resetRecallDebug();
    started = Date.now();
    // 0. 补索引与 1. 查询重写同时进行:两者互不依赖,重写往往是最慢的一步,先后执行要白等补索引。
    // 补索引最多等 Embedding 端点「超时 ×(重试次数+1)」;到时先用已建好的部分召回,补建在后台继续。
    // 检索要等补索引结束:刚滚出全文窗口的楼要先进索引。
    const indexTask = awaitRecall(run, () => ensureRecallIndex(signal, {
      maxWaitMs: endpointBudgetMs(apiSettings.vector?.embedding, 'embedding'),
      onPending: n => {
        if (ownsRecallContext(run) && !signal.aborted) setRecallIndexPending(n);
      },
    })).finally(() => {
      if (ownsRecallContext(run)) setRecallTiming('index', Date.now() - started);
    });
    // 重写先失败时本次召回直接结束,补建照常在后台继续;这里只防止留下未处理的拒绝
    indexTask.catch(() => {});
    const { queryVectors, rerankQuery, intent, queries, queryDim } = await resolveQueryVectors(run);
    const index = await indexTask;
    assertRecallCurrent(run);
    setRecallIndexPending(0);
    const indexNotes: string[] = [];
    if (index?.timedOut) {
      indexNotes.push(`向量索引还在补建（剩余 ${index.pending ?? 0} 条），本次先用已建好的部分召回，补建在后台继续。`);
    } else if (index?.error) {
      indexNotes.push(`补建向量索引失败：${index.error}本次只用已有索引召回。`);
    }
    setRecallIndexNote(indexNotes.join(''));
    assertRecallCurrent(run);
    if (!queryVectors.length) {
      setRecallStatus('未召回:查询重写未产出 query');
      inject('');
      return;
    }

    const excludeIds = windowLeafIds(chat);
    const exclude = new Set(excludeIds);
    const selfScope = currentChatScope();
    // 换了 Embedding 模型后旧向量与查询不可比(见 indexModel.ts),写进召回调试
    const modelIssue = selfScope ? indexModelIssue(database, selfScope, currentEmbeddingModel(), queryDim) : '';
    if (modelIssue) {
      indexNotes.push(modelIssue);
      setRecallIndexNote(indexNotes.join(''));
    }
    const topK = cfg.rerankCandidates;
    const searchStarted = Date.now();
    const { results: found } = await awaitRecall(run, () => vecSearch(database, scopes, queryVectors, {
      topK, excludeLeafIds: excludeIds,
    }));
    assertRecallCurrent(run);
    setRecallTiming('search', Date.now() - searchStarted);
    // 本聊天命中的楼层号按当前聊天重新定位(删掉更早的楼层后,索引里记的楼层号会过期)
    const floors = selfScope ? leafFloorMap(chat) : new Map<string, number>();
    const results = found.map(h => relocateHit(h, selfScope, floors));
    setRecallEmbedding(results.map(h => ({
      leafId: h.leafId, similarity: h.similarity, queryIndex: h.queryIndex ?? -1,
      source: sourceLabel(h, selfScope), storyTime: compactTimeLabel((h.storyTime || '').trim()),
      preview: previewOf(h.document),
    })));
    // 已在[历史剧情摘要]里原样发送的叶子:关键词一路和保留补位直接跳过,向量一路只允许全文档
    const inHistory = historyLeafIds(chat);
    const skipForBrief = inHistory.size ? new Set([...exclude, ...inHistory]) : exclude;
    // 关键词一路只查本聊天;没有本聊天 scope 时跳过
    const keyword = cfg.keywordRoute === true && selfScope
      ? findKeywordHits(chat, skipForBrief, keywordQueryText(chat, intent, queries), topK)
      : [];
    setRecallKeyword(keyword.map(k => ({
      leafId: k.leaf.leafId, source: `#${k.leaf.msgIndex}`, score: k.score, matched: k.matched,
      storyTime: compactTimeLabel(k.leaf.storyTime.trim()), preview: previewOf(k.leaf.document),
    })));
    if (!results.length && !keyword.length) {
      setRecallTiming('total', Date.now() - started);
      setRecallStatus('未召回:检索无候选');
      inject('');
      return;
    }
    const present = cfg.presentBoost === true ? presentNames() : [];
    const candidates = fuseRecallRoutes(results, keyword, selfScope ?? '', present, topK);
    const rerankStarted = Date.now();
    const { ranked, issue } = await rerankCandidates(rerankQuery, candidates, run);
    assertRecallCurrent(run);
    setRecallTiming('rerank', Date.now() - rerankStarted);
    setRecallRerankIssue(issue);
    // 在场角色加权:rerank 成功时在 rerank 分上加一点排序加成;降级时融合顺序里已经计入
    if (present.length && ranked[0]?.reranked) {
      ranked.sort((a, b) => presentOrderKey(b.rerankScore, b.presentHits) - presentOrderKey(a.rerankScore, a.presentHits));
    }
    const stickyTurns = cfg.stickyTurns;
    const pool: RankedHit[] = stickyTurns > 0
      ? [...ranked, ...stickyCandidates(run.chatId, skipForBrief, new Set(ranked.map(h => h.leafId)))
        .map(h => relocateHit(h, selfScope, floors))]
      : ranked;
    const result = buildRecallText(pool, cfg, selfScope, latestStoryTime(chat), { inHistory });
    const { text, tiers, cut } = result;
    assertRecallCurrent(run);
    recordRerankDebug(pool, result, selfScope, inHistory);
    setRecallTiming('total', Date.now() - started);
    inject(text);
    setRecallInjected(text);
    setRecallStatus(text ? '召回完成' : cut.size ? RECALL_DONE_OVER_BUDGET : RECALL_DONE_NONE_PASSED);
    assertRecallCurrent(run);
    updateSticky(run.chatId, pool, tiers, stickyTurns);
    // 索引没补完或补建失败时不缓存:重生成时用补得更全的索引重新召回
    if (cacheKey && !index?.timedOut && !index?.error) saveRecallCache({ key: cacheKey, text, debug: snapshotRecallDebug() });
  } catch (e) {
    // 切聊天/被更新代次取代:失败收尾也不准动共享槽、debug 或缓存。
    if (!ownsRecallContext(run)) { run.controller.abort(); return; }
    if (started) setRecallTiming('total', Date.now() - started);
    if (run.timedOut) {
      run.controller.abort();
      setRecallStatus(`失败:${recallTimeoutText(run.deadlineMs)}`);
    } else if (signal.aborted || !recallRunAllowed(run)) {
      run.controller.abort();
      // 用户点了停止生成:召回随之取消(保留表不动)
      setRecallStatus(run.externalSignal?.aborted ? RECALL_STOPPED : '未召回:已取消或保护状态变化');
    } else {
      console.warn('[棱镜宝书向量] 召回失败(降级为不召回):', e);
      setRecallStatus(`失败:${e instanceof Error ? e.message : String(e)}`);
    }
    setRecallIndexPending(0);
    if (ownsRecallContext(run)) clearRecallSlot();
  }
}

/**
 * 把分档结果写入调试快照:按 leaf_id 去重(保留首条),tier 取 buildRecallText 标记;
 * 达标却放不进预算的记为 cut,其余记为 drop 并附原因(未达阈值 / 超出最终条数 / 已在历史摘要中 / 关键词已收满)。
 */
function recordRerankDebug(
  ranked: RankedHit[],
  result: RecallTextResult,
  selfScope: string | null,
  inHistory: Set<string>,
): void {
  const seen = new Set<string>();
  const hits: RecallDebugRerankHit[] = [];
  for (const h of ranked) {
    if (seen.has(h.leafId)) continue;
    seen.add(h.leafId);
    const tier = result.tiers.get(h.leafId) ?? (result.cut.has(h.leafId) ? 'cut' : 'drop');
    const dropReason = tier === 'drop' ? result.dropped.get(h.leafId) : undefined;
    hits.push({
      leafId: h.leafId,
      rerankScore: h.rerankScore,
      similarity: h.similarity,
      tier,
      ...(dropReason ? { dropReason } : {}),
      ...(result.downgraded.has(h.leafId) ? { downgraded: true } : {}),
      ...(inHistory.has(h.leafId) ? { inHistory: true } : {}),
      source: sourceLabel(h, selfScope),
      storyTime: compactTimeLabel((h.storyTime || '').trim()),
      preview: previewOf(h.document),
      route: h.route ?? 'vector',
      similarityKnown: h.similarityKnown !== false && h.route !== 'sticky',
      reranked: h.reranked !== false,
    });
  }
  setRecallRerank(hits);
}

/**
 * 解析检索用的多条 query 向量 + rerank 用的 query 文本。
 * 查询重写**强制启用、无降级**:rewrite 得 INTENT + 多条 Q,各自 embed;
 * rerank query 用 INTENT,INTENT 为空或因超长被清空时用全部 Q 拼接(不只用第一条,免得其余 Q 取回的段落被判低分)。
 * 重写失败 / 无 query → 直接抛错,由 runVectorRecall 结束本次召回(不再降级为单 query)。
 */
async function resolveQueryVectors(
  run: RecallRun,
): Promise<{ queryVectors: string[]; rerankQuery: string; intent: string; queries: string[]; queryDim: number }> {
  const rewriteStarted = Date.now();
  const { intent, queries, stats } = await awaitRecall(run, () => rewriteQuery(run.controller.signal));
  assertRecallCurrent(run);
  setRecallTiming('rewrite', Date.now() - rewriteStarted);
  setRecallRewrite(intent, queries);
  setRecallRewriteStats(stats ?? null);
  if (!queries.length) throw new Error('查询重写未产出任何 query');
  // 检索向量:多条 Q(INTENT 偏长偏全文,留给 rerank,不进检索向量以免稀释)
  const embedStarted = Date.now();
  const vecs = await awaitRecall(run, () => embedTexts(queries, run.controller.signal));
  assertRecallCurrent(run);
  setRecallTiming('embed', Date.now() - embedStarted);
  const queryVectors = vecs.map(v => encodeFloat32Base64(v));
  return { queryVectors, rerankQuery: intent || queries.join('；'), intent, queries, queryDim: vecs[0]?.length ?? 0 };
}

interface RankedHit extends VecHit {
  rerankScore: number; // 无 rerank 时 = similarity
  /** 来自哪一路;旧调用方(单测)不带,按向量处理 */
  route?: FusedCandidate['route'] | 'sticky';
  /** false = 只由关键词命中,similarity 不可信 */
  similarityKnown?: boolean;
  keywordScore?: number;
  presentHits?: number;
  /** rerank 实际打过分(false = 本轮没有重排,按融合顺序降级);旧调用方(单测)不带,按已重排处理 */
  reranked?: boolean;
}

function withPeriod(text: string): string {
  const t = text.trim();
  return /[。！？.!?]$/.test(t) ? t : `${t}。`;
}

/** 本轮没有重排时写进召回状态的一句话:写明没有重排、按什么分档、只发摘要,以及原因。 */
function rerankIssueText(e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  const msg = e instanceof Error ? e.message.trim() : String(e).trim();
  const tail = '已按 embedding 相似度分档，只发送摘要。';
  if (kind === 'config') return `${msg.replace(/[。.]$/, '')}，${tail}如需重排，请在「设置 → 向量记忆 → Rerank」中补全。`;
  if (kind === 'unsupported') return `重排不可用，${tail}原因：${withPeriod(msg)}`;
  return `重排失败，${tail}原因：${withPeriod(msg)}`;
}

/**
 * 对候选做 rerank;失败/未配置则保持融合顺序降级,rerank 分取向量相似度(只由关键词命中的记 0),
 * 并给出写进召回状态的说明(重排成功时为空串)。
 */
async function rerankCandidates<T extends VecHit>(
  query: string,
  hits: T[],
  run: RecallRun,
): Promise<{ ranked: Array<T & { rerankScore: number; reranked: boolean }>; issue: string }> {
  // rerank 未填模型 / 本会话已判定接口不支持 / 请求失败 → 降级(由 rerankDocuments 抛错区分)
  try {
    // 全文精排:发叶子覆盖的原文(mesFull:用户发言 + AI 回复,已含内嵌起止时间)给 rerank,语义比摘要更全;
    // 无原文(如种子叶子)退摘要 document,此时补 【故事时间】头给时间上下文。
    // (超长由 rerankDocuments 内部按 token 截断/分批)
    const docs = hits.map(h => {
      // 新索引存的是已清洗的原文;老索引存的是只剥了思维链的原文,发给 rerank 前再过一次 cleanBody(幂等)。
      const full = h.mesFull ? cleanBody(h.mesFull).trim() : '';
      if (full) return full;
      const body = (h.document || '').trim();
      const t = (h.storyTime || '').trim();
      return t ? `【${t}】\n${body}` : body;
    });
    const order = await awaitRecall(run, () => rerankDocuments(query, docs, hits.length, run.controller.signal));
    assertRecallCurrent(run);
    // order 是 {index, score} 降序;映射回 hit
    const ranked = order
      .filter(o => hits[o.index])
      .map(o => ({ ...hits[o.index], rerankScore: o.score, reranked: true }));
    return { ranked, issue: '' };
  } catch (e) {
    assertRecallCurrent(run); // 仅真实重排失败可降级,取消/切聊天不能变成正常命中
    // 降级:保持融合顺序,rerankScore 复用 similarity
    return { ranked: hits.map(h => ({ ...h, rerankScore: h.similarity, reranked: false })), issue: rerankIssueText(e) };
  }
}

/** 选中要注入的一段:选定的档,以及原文放不进预算时改发的摘要。 */
interface RecallPick {
  hit: RankedHit;
  tier: 'full' | 'brief';
  /** 全文档的原文段落(摘要档没有) */
  full?: string;
  /** 这一条的摘要段落;摘要为空时为空串 */
  brief: string;
}

/** buildRecallText 的结果:注入文本,以及每条候选最后的去向(供调试面板和保留轮数使用)。 */
export interface RecallTextResult {
  text: string;
  /** 实际注入的段落及其档(含原文放不下、改发摘要的) */
  tiers: Map<string, 'full' | 'brief'>;
  /** 达到阈值、但原文和摘要都放不进召回预算,没有注入 */
  cut: Set<string>;
  /** 达到全文档、原文放不进召回预算,改发了摘要 */
  downgraded: Set<string>;
  /** 没有入选的候选及原因 */
  dropped: Map<string, RecallDropReason>;
}

export interface RecallTextOptions {
  /** 已在[历史剧情摘要]里原样发送的叶子:不再按摘要档发送,全文档照常允许 */
  inHistory?: Set<string>;
}

/**
 * 摘要档准入(全文档没轮到时):
 *  - 已重排且 rerank≥阈值(超出「召回全文数」的高分段落)→ 改发摘要;
 *  - 向量相似度≥embedding 阈值 → 发摘要;
 *  - 向量相似度不够、但关键词命中:已重排时 rerank≥阈值一半即可;没有重排时最多收 2 条;
 *  - 上一轮保留的段落直接放行(只占剩余空位);
 *  - 已在[历史剧情摘要]里原样发送的,摘要档不再重复发送。
 * 返回 true 表示可以入选,否则返回原因。
 */
function briefVerdict(
  h: RankedHit,
  cfg: typeof apiSettings.vector.recall,
  reranked: boolean,
  inHistory: Set<string>,
  keywordAdmitted: number,
): true | RecallDropReason {
  let eligible = false;
  let keywordCapped = false;
  if (h.route === 'sticky') eligible = true;
  else if (reranked && h.rerankScore >= cfg.rerankThreshold) eligible = true;
  else if (h.similarityKnown !== false && h.similarity >= cfg.embeddingThreshold) eligible = true;
  else if ((h.keywordScore ?? 0) > 0) {
    if (reranked) eligible = h.rerankScore >= cfg.rerankThreshold / 2;
    else {
      eligible = keywordAdmitted < KEYWORD_ONLY_LIMIT_UNRERANKED;
      keywordCapped = !eligible;
    }
  }
  if (!eligible) return keywordCapped ? 'keyword-cap' : 'threshold';
  if (inHistory.has(h.leafId)) return 'history';
  return true;
}

/**
 * 按分档规则拼注入文本:
 *  - 全文档:已重排且 rerankScore ≥ rerankThreshold,取前 fullTextCount,发 mes_full(无则退 document)。
 *    没有重排时不发原文(余弦相似度与 rerank 分不是一个尺度,不能拿来比 rerank 阈值)。
 *  - 摘要档:见 briefVerdict;上一轮保留的段落(route=sticky)排在最后,只在有空位时以摘要补入。
 *  - 总数 ≤ finalRecallCount;达标但条数已满的记为「超出最终条数」;按 leaf_id 去重(已在后端跨 scope 合并,这里再兜底)。
 *  - 放进召回预算(记忆注入预算的召回份额):原文放不下时改发这一条的摘要,摘要也放不下才不注入。
 */
export function buildRecallText(
  ranked: RankedHit[],
  cfg: typeof apiSettings.vector.recall,
  selfScope: string | null,
  now: string,
  opts: RecallTextOptions = {},
): RecallTextResult {
  const inHistory = opts.inHistory ?? new Set<string>();
  const seen = new Set<string>();
  const picks: RecallPick[] = [];
  const dropped = new Map<string, RecallDropReason>();
  let fullUsed = 0;
  let keywordAdmitted = 0;

  for (const h of ranked) {
    if (seen.has(h.leafId)) continue;
    seen.add(h.leafId);

    const doc = (h.document || '').trim();
    // 摘要档无内嵌时间,补 【(相对) 区间】头
    const brief = doc ? fmtChunk(h, doc, false, selfScope, now) : '';
    const reranked = h.reranked !== false;
    const isFull = h.route !== 'sticky' && reranked && h.rerankScore >= cfg.rerankThreshold && fullUsed < cfg.fullTextCount;
    if (isFull) {
      // 全文档优先发 mesFull(原文,过 cleanBody 清洗后已含内嵌起止时间),无则退 document
      const cleanFull = h.mesFull ? cleanBody(h.mesFull).trim() : '';
      const body = cleanFull || doc;
      if (!body) continue;
      if (picks.length >= cfg.finalRecallCount) {
        dropped.set(h.leafId, 'limit');
        continue;
      }
      fullUsed++;
      // mesFull 自带 (起始时间…)/(结束时间…),不再加 【】头避免时间重复;退到 document 时才补头
      picks.push({ hit: h, tier: 'full', full: fmtChunk(h, body, !!cleanFull, selfScope, now), brief });
      continue;
    }
    const verdict = briefVerdict(h, cfg, reranked, inHistory, keywordAdmitted);
    if (verdict !== true) {
      dropped.set(h.leafId, verdict);
      continue;
    }
    if (!brief) continue;
    if (picks.length >= cfg.finalRecallCount) {
      dropped.set(h.leafId, 'limit');
      continue;
    }
    // 没有重排时,靠关键词入选(向量相似度不够)的段落计数,最多收 2 条
    if (!reranked && h.route !== 'sticky' && !(h.similarityKnown !== false && h.similarity >= cfg.embeddingThreshold)) keywordAdmitted++;
    picks.push({ hit: h, tier: 'brief', brief });
  }
  return { ...fitRecallPicks(picks), dropped };
}

/**
 * 把选中的段落放进召回预算:全文档在前、摘要档在后,各按重排顺序。
 * 全部放得下就原样注入;放不下时逐条放,原文放不下改发这一条的摘要(排在摘要档最前),
 * 摘要也放不下才不注入,并在末尾附预算提示。一段都放不下时不注入,不留只有说明文字的空框。
 */
function fitRecallPicks(picks: RecallPick[]): Omit<RecallTextResult, 'dropped'> {
  const result: Omit<RecallTextResult, 'dropped'> = { text: '', tiers: new Map(), cut: new Set(), downgraded: new Set() };
  if (!picks.length) return result;
  const limit = slotBudget('recall');
  // 开头用私密简报说明框定,结尾用召回块专用的短结束语,避免主模型把召回回忆当成要复述/输出的模板
  const render = (units: string[], omitted: boolean) =>
    [`${MEMORY_BRIEFING_NOTE}\n[相关回忆]`, ...units, omitted ? BUDGET_NOTICE : '', RECALL_BRIEFING_END].filter(Boolean).join('\n\n');
  const fits = (units: string[], omitted: boolean) => estimateTokens(render(units, omitted)) <= limit;
  const ordered = [...picks.filter(p => p.tier === 'full'), ...picks.filter(p => p.tier === 'brief')];

  const preferred = ordered.map(p => (p.tier === 'full' ? p.full! : p.brief));
  if (fits(preferred, false)) {
    for (const p of ordered) result.tiers.set(p.hit.leafId, p.tier);
    result.text = render(preferred, false);
    return result;
  }
  // 逐条放时为预算提示留出位置
  const full: string[] = [];
  const fallback: string[] = [];
  const brief: string[] = [];
  const kept = () => [...full, ...fallback, ...brief];
  for (const p of ordered) {
    const id = p.hit.leafId;
    if (p.tier === 'full' && fits([...kept(), p.full!], true)) {
      full.push(p.full!);
      result.tiers.set(id, 'full');
    } else if (p.brief && fits([...kept(), p.brief], true)) {
      (p.tier === 'full' ? fallback : brief).push(p.brief);
      result.tiers.set(id, 'brief');
      if (p.tier === 'full') result.downgraded.add(id);
    } else {
      result.cut.add(id);
    }
  }
  const units = kept();
  if (units.length) result.text = render(units, result.cut.size > 0);
  return result;
}

/**
 * 把索引时存的「未压缩起止段」格式化成展示用时间头:【(相对) 起 - 止】。
 *  - 压缩成区间显示(compactTimeLabel:删结束端重复日期);
 *  - 用结束时间相对「现在」(故事内最新时间 now)算相对前缀(对齐历史摘要的 inject.ts)。
 * 无时间 → 空串。
 */
function fmtStoryTimeHead(storyTime: string, now: string): string {
  const t = storyTime.trim();
  if (!t) return '';
  const shown = compactTimeLabel(t);
  const end = splitTimeLabel(t).end ?? '';
  const rel = relativeTimeLabel(end, now);
  return rel ? `【(${rel}) ${shown}】` : `【${shown}】`;
}

/**
 * 单条召回片段:行首加来源标记(本聊天「#5」/ 旧档),让主模型知道这段回忆出处;
 * body 未自带内嵌时间时再补一个故事时间头【(相对) 起 - 止】(若有)。
 */
function fmtChunk(h: RankedHit, body: string, bodyHasInlineTime: boolean, selfScope: string | null, now: string): string {
  const src = `[${sourceLabel(h, selfScope)}]`;
  if (bodyHasInlineTime) {
    // 全文自身保留原始起止时间标签，但仍需在全文前补充相对时间，
    // 避免全文档与摘要档在时间感知上表现不一致。
    const end = splitTimeLabel((h.storyTime || '').trim()).end ?? '';
    const rel = relativeTimeLabel(end, now);
    return rel ? `${src}【${rel}】 ${body}` : `${src} ${body}`;
  }
  const head = fmtStoryTimeHead(h.storyTime || '', now);
  return head ? `${src}${head}${body}` : `${src} ${body}`;
}
