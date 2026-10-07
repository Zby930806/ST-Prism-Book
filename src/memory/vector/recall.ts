import { fitMemoryUnits, estimateTokens, slotBudget } from '../budget';
/**
 * 阻塞式向量召回:生成主回复前,按用户输入 + 近期上下文检索相关旧记忆,注入主对话。
 *
 * 管线(全程阻塞,对齐既定方案,不做预取/异步):
 *  1. 查询重写(开关开 + 配了 Query 重写模型时):小模型把当前剧情重写成 INTENT + 多条检索 Q;
 *     失败/未启用则清空召回槽,不阻断正文生成。
 *  2. 各 query 各自 embed → vec/search(scopes = 当前 chat + 各 bundle,后端多路 RRF 融合),
 *     纯按 embedding 得分取前 rerankCandidates 条(不套阈值)。
 *  3. rerank 候选(用 INTENT 作 query;渠道未配则降级:跳过 rerank,用 embedding 序)。
 *  4. 分档:全文档(rerank≥阈值,取前 fullTextCount,发原文 mes_full)/ 摘要档(embedding≥阈值,发 document)。
 *  5. 按 leaf_id 去重 + 排除当前窗口内已全文的叶子 → 拼注入文本 → setExtensionPrompt。
 *
 * 失败/未配置全程静默降级(清空注入槽),向量是增强项,绝不阻断生成。
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import type { VecHit } from '@/api/baibaoku';
import { vecSearch } from './store';
import { getLeaf, leafValid } from '../apply';
import { MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from '../prompts';
import { embedTexts, encodeFloat32Base64, rerankDocuments } from './embed';
import { rewriteQuery } from './rewrite';
import { ensureRecallIndex } from './index';
import { currentBundleHashes, currentChatId, currentChatScope, currentVectorDb, recallScopes } from './scope';
import { isAiFloor, resolveKeepStart } from '../engine';
import { cleanBody, compactTimeLabel, latestStoryTime, splitTimeLabel } from '../timeTag';
import { relativeTimeLabel } from '../timeRel';
import { normalizeRecallInjectionDepth } from './depth';
import { RECALL_CACHE_STORAGE_KEY } from './cache';
import {
  previewOf,
  resetRecallDebug,
  restoreRecallDebug,
  setRecallEmbedding,
  setRecallInjected,
  setRecallRerank,
  setRecallRewrite,
  setRecallStatus,
  snapshotRecallDebug,
  type RecallDebug,
  type RecallDebugRerankHit,
} from './debug';

// 注入槽位:贴近历史摘要层(顶部附近),与 inject.ts 的历史摘要同一区域但独立 key。
const RECALL_INJECT_KEY = 'baibai_book_vector_recall';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** 当前召回注入深度;运行时再归一化,兼容用户正在编辑输入框时产生的临时非法值。 */
function recallInjectionDepth(): number {
  return normalizeRecallInjectionDepth(apiSettings.vector.recall.injectionDepth);
}

/**
 * 命中来源标记:
 *  - scope 等于当前聊天 → 本聊天命中,显示楼层号「#5」(msgIndex 即当前楼层号);
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
function recallWorthRunning(chat: STMessage[]): boolean {
  if (currentBundleHashes().length > 0) return true; // 旧档无条件召回
  if (resolveKeepStart(chat) === 0) return false; // 全在窗口内,无窗口外旧楼可召
  const min = Math.max(0, apiSettings.vector.recall.minAiFloors);
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
    "prompt-v2",
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

let recalling = false;

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

/** 清空召回注入槽(降级/未命中/切聊天时)。 */
export function clearRecallInjection(): void {
  getContext()?.setExtensionPrompt?.(RECALL_INJECT_KEY, '', IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
}

/**
 * 执行一次阻塞召回并写注入槽。在生成拦截器放行路径里 await。
 * 任何失败都清空槽并返回(静默降级)。
 */
export async function runVectorRecall(signal?: AbortSignal): Promise<void> {
  if (!recallActiveHere()) {
    clearRecallInjection();
    return;
  }
  if (recalling) return;
  const database = currentVectorDb();
  if (!database) return;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const fn = ctx?.setExtensionPrompt;
  if (typeof fn !== 'function' || !chat.length) return;

  // 楼层还少 / 全在窗口内且无旧档:本回合无召回价值,跳过整条管线(清空注入槽,避免残留上次召回)。
  if (!recallWorthRunning(chat)) {
    setRecallStatus('未召回:楼层未达起召门槛或全在窗口内');
    clearRecallInjection();
    return;
  }

  const cfg = apiSettings.vector.recall;
  const scopes = recallScopes();

  // 缓存命中(重生成/翻页且召回输入未变):直接复用上次注入文本 + 调试快照,跳过整条管线。
  const cacheKey = buildRecallCacheKey(chat, cfg);
  const cached = cacheKey ? loadRecallCache() : null;
  if (cacheKey && cached && cached.key === cacheKey && estimateTokens(cached.text) <= slotBudget('recall')) {
    fn(RECALL_INJECT_KEY, cached.text, IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
    restoreRecallDebug(cached.debug);
    setRecallStatus(`${cached.debug.status}(复用缓存)`);
    return;
  }

  recalling = true;
  try {
    // 开一次新调试快照(进入有效召回路径才记录,避免「功能未启用」时反复清空上次结果)
    resetRecallDebug();

    // 召回前先补齐窗口外缺失的向量索引(载入老聊天/向量后开 → 旧叶子可能从未索引),
    // 否则这些旧剧情会直接漏召回。只阻塞窗口外,窗口内交给防抖增量。
    await ensureRecallIndex(signal);

    // 1) 查询重写(强制启用,无降级):得多条 query 向量 + rerank 用的 query 文本。
    // 重写失败/无 query 会抛错 → 落到外层 catch,清空注入槽、结束本次召回。
    const { queryVectors, rerankQuery } = await resolveQueryVectors(signal);
    if (!queryVectors.length) {
      setRecallStatus('未召回:查询重写未产出 query');
      clearRecallInjection();
      return;
    }

    // 2) 后端检索:多路在范围内纯按 embedding 得分取前 rerankCandidates(后端 max 融合,不套阈值),排除窗口内叶子
    const exclude = windowLeafIds(chat);
    const selfScope = currentChatScope();
    const { results } = await vecSearch(database, scopes, queryVectors, {
      topK: Math.max(1, cfg.rerankCandidates),
      excludeLeafIds: exclude,
    });
    setRecallEmbedding(
      results.map(h => ({
        leafId: h.leafId,
        similarity: h.similarity,
        queryIndex: h.queryIndex ?? -1,
        source: sourceLabel(h, selfScope),
        storyTime: compactTimeLabel((h.storyTime || '').trim()),
        preview: previewOf(h.document),
      })),
    );
    if (!results.length) {
      setRecallStatus('未召回:检索无候选');
      clearRecallInjection();
      return;
    }

    // 3) rerank(用 INTENT/重写 query;渠道未配 → 降级:用 embedding 序,score 复用 similarity)
    const ranked = await rerankCandidates(rerankQuery, results, signal);

    // 4) 分档 + 上限(now = 故事内最新时间,作相对时间参照点,对齐历史摘要注入)
    const now = latestStoryTime(chat);
    const { text, tiers } = buildRecallText(ranked, cfg, selfScope, now);
    recordRerankDebug(ranked, tiers, selfScope);
    fn(RECALL_INJECT_KEY, text, IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
    setRecallInjected(text);
    setRecallStatus(text ? '召回完成' : '召回完成:无内容达标,本回合未注入');
    // 实算成功才落缓存(失败/降级路径不缓存,下次重试)。存调试快照供命中时还原面板。
    if (cacheKey) saveRecallCache({ key: cacheKey, text, debug: snapshotRecallDebug() });
  } catch (e) {
    console.warn('[棱镜宝书向量] 召回失败(降级为不召回):', e);
    setRecallStatus(`失败:${e instanceof Error ? e.message : String(e)}`);
    clearRecallInjection();
  } finally {
    recalling = false;
  }
}

/** 把分档结果写入调试快照:按 leaf_id 去重(保留首条),tier 取 buildRecallText 标记,缺省 drop。 */
function recordRerankDebug(
  ranked: RankedHit[],
  tiers: Map<string, 'full' | 'brief'>,
  selfScope: string | null,
): void {
  const seen = new Set<string>();
  const hits: RecallDebugRerankHit[] = [];
  for (const h of ranked) {
    if (seen.has(h.leafId)) continue;
    seen.add(h.leafId);
    hits.push({
      leafId: h.leafId,
      rerankScore: h.rerankScore,
      similarity: h.similarity,
      tier: tiers.get(h.leafId) ?? 'drop',
      source: sourceLabel(h, selfScope),
      storyTime: compactTimeLabel((h.storyTime || '').trim()),
      preview: previewOf(h.document),
    });
  }
  setRecallRerank(hits);
}

/**
 * 解析检索用的多条 query 向量 + rerank 用的 query 文本。
 * 查询重写**强制启用、无降级**:rewrite 得 INTENT + 多条 Q,各自 embed;rerank query 用 INTENT(无则首条 Q)。
 * 重写失败 / 无 query → 直接抛错,由 runVectorRecall 结束本次召回(不再降级为单 query)。
 */
async function resolveQueryVectors(
  signal?: AbortSignal,
): Promise<{ queryVectors: string[]; rerankQuery: string }> {
  const { intent, queries } = await rewriteQuery(signal);
  setRecallRewrite(intent, queries);
  if (!queries.length) throw new Error('查询重写未产出任何 query');
  // 检索向量:多条 Q(INTENT 偏长偏全文,留给 rerank,不进检索向量以免稀释)
  const vecs = await embedTexts(queries, signal);
  const queryVectors = vecs.map(v => encodeFloat32Base64(v));
  return { queryVectors, rerankQuery: intent || queries[0] };
}

interface RankedHit extends VecHit {
  rerankScore: number; // 无 rerank 时 = similarity
}

/** 对候选做 rerank;失败/未配置则用 embedding 相似度序降级。 */
async function rerankCandidates(query: string, hits: VecHit[], signal?: AbortSignal): Promise<RankedHit[]> {
  // rerank 渠道未配置 → 直接降级(embedTexts/resolveVectorModel 在 rerank 缺渠道时会抛错)
  try {
    // 全文精排:发楼层原文(mesFull,已含内嵌起止时间)给 rerank,语义比摘要更全;
    // 无原文(如种子叶子)退摘要 document,此时补 【故事时间】头给时间上下文。
    // (超长由 rerankDocuments 内部按 token 截断/分批)
    const docs = hits.map(h => {
      // mesFull 现存原文,发给 rerank 前过 cleanBody(剔除状态栏/思维链/自定义标签等,
      // 保留内嵌起止时间);老索引存的是已清洗文本,再洗幂等无副作用。
      const full = h.mesFull ? cleanBody(h.mesFull).trim() : '';
      if (full) return full;
      const body = (h.document || '').trim();
      const t = (h.storyTime || '').trim();
      return t ? `【${t}】\n${body}` : body;
    });
    const order = await rerankDocuments(query, docs, hits.length, signal);
    // order 是 {index, score} 降序;映射回 hit
    return order
      .filter(o => hits[o.index])
      .map(o => ({ ...hits[o.index], rerankScore: o.score }));
  } catch {
    // 降级:保持 embedding 序,rerankScore 复用 similarity
    return hits.map(h => ({ ...h, rerankScore: h.similarity }));
  }
}

/**
 * 按分档规则拼注入文本:
 *  - 全文档:rerankScore ≥ rerankThreshold,取前 fullTextCount,发 mes_full(无则退 document)。
 *  - 摘要档:rerankScore < rerankThreshold 但 similarity ≥ embeddingThreshold,发 document。
 *  - 总数 ≤ finalRecallCount;按 leaf_id 去重(已在后端跨 scope 合并,这里再兜底)。
 *
 * 返回拼好的注入文本 + 每条被采纳叶子的分档(full/brief),供调试面板标注 tier。
 */
export function buildRecallText(
  ranked: RankedHit[],
  cfg: typeof apiSettings.vector.recall,
  selfScope: string | null,
  now: string,
): { text: string; tiers: Map<string, 'full' | 'brief'> } {
  const seen = new Set<string>();
  const tiers = new Map<string, 'full' | 'brief'>();
  const fullChunks: string[] = [];
  const briefChunks: string[] = [];
  const fullIds: string[] = [];
  const briefIds: string[] = [];
  let fullUsed = 0;

  for (const h of ranked) {
    if (seen.size >= cfg.finalRecallCount) break;
    if (seen.has(h.leafId)) continue;

    const isFull = h.rerankScore >= cfg.rerankThreshold && fullUsed < cfg.fullTextCount;
    if (isFull) {
      // 全文档优先发 mesFull(原文,过 cleanBody 清洗后已含内嵌起止时间),无则退 document
      const cleanFull = h.mesFull ? cleanBody(h.mesFull).trim() : '';
      const useMesFull = !!cleanFull;
      const body = cleanFull || (h.document || '').trim();
      if (!body) continue;
      seen.add(h.leafId);
      tiers.set(h.leafId, 'full');
      fullUsed++;
      // mesFull 自带 (起始时间…)/(结束时间…),不再加 【】头避免时间重复;退到 document 时才补头
      fullIds.push(h.leafId);
      fullChunks.push(fmtChunk(h, body, useMesFull, selfScope, now));
    } else if (h.similarity >= cfg.embeddingThreshold) {
      const body = (h.document || '').trim();
      if (!body) continue;
      seen.add(h.leafId);
      tiers.set(h.leafId, 'brief');
      briefIds.push(h.leafId);
      briefChunks.push(fmtChunk(h, body, false, selfScope, now)); // 摘要档无内嵌时间,补 【(相对) 区间】头
    }
    // 两档都不达标:丢弃
  }

  const chunks = [...fullChunks, ...briefChunks];
  if (!chunks.length) return { text: '', tiers };
  // 首尾私密简报框定,避免主模型把召回回忆当成要复述/输出的模板
  const fitted = fitMemoryUnits(chunks, 'recall', `${MEMORY_BRIEFING_NOTE}\n[相关回忆]`, MEMORY_BRIEFING_END);
  const ids = [...fullIds, ...briefIds];
  const kept = new Set(fitted.indices.map(i => ids[i]));
  for (const id of tiers.keys()) if (!kept.has(id)) tiers.delete(id);
  return { text: fitted.text, tiers };
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
