/**
 * 向量召回调试快照(全局,reactive)。
 *
 * 只为「设置 → 记忆与召回 → 召回调试」卡片、召回速览和快捷回复栏的「召回」按钮服务:把上一次召回各阶段的中间结果
 * 留一份在内存里供 UI 订阅。纯调试观测,不参与召回逻辑,失败/降级也照样记录(写明 status)。
 * 全局单例(非按聊天):只关心「最近一次」,切聊天后下一次召回自然覆盖。
 */

import { reactive } from 'vue';

/** Embedding 检索命中(后端 max 融合后) */
export interface RecallDebugEmbedHit {
  leafId: string;
  similarity: number;
  /** 来源 Q 下标(后端回传);-1 = 未知(旧后端未回传) */
  queryIndex: number;
  /** 来源标记:本聊天命中为楼层号「#5」,bundle 快照为「旧档」 */
  source: string;
  storyTime: string;
  preview: string;
}

/**
 * 没有注入的原因:
 *  threshold = 两档都没达到阈值;limit = 达标但「最终召回条数」已满;
 *  history = 只够摘要档,而这条摘要已在[历史剧情摘要]里原样发送;keyword-cap = 没有重排时,只由关键词命中的段落已收满。
 */
export type RecallDropReason = 'threshold' | 'limit' | 'history' | 'keyword-cap';

/** Rerank 候选及其分档结果 */
export interface RecallDebugRerankHit {
  leafId: string;
  rerankScore: number;
  similarity: number;
  /** 分档:full=发全文,brief=发摘要,drop=没有注入(原因见 dropReason),cut=达标但放不进召回预算 */
  tier: 'full' | 'brief' | 'drop' | 'cut';
  /** 没有注入的原因;旧快照没有此字段,按「丢弃」显示 */
  dropReason?: RecallDropReason;
  /** 达到全文档,但原文放不进召回预算,改发了摘要 */
  downgraded?: boolean;
  /** 这条摘要已在[历史剧情摘要]里原样发送(记忆注入预算不限制时才判断) */
  inHistory?: boolean;
  /** 来源标记:本聊天命中为楼层号「#5」,bundle 快照为「旧档」 */
  source: string;
  storyTime: string;
  preview: string;
  /** 来自哪一路:向量、关键词、两路都有,或上一轮保留;旧快照没有此字段(按向量处理) */
  route?: 'vector' | 'keyword' | 'both' | 'sticky';
  /** false = 只由关键词命中,没有向量相似度 */
  similarityKnown?: boolean;
  /** false = 本轮没有重排,rerankScore 记的是 embedding 相似度;旧快照没有此字段(按已重排处理) */
  reranked?: boolean;
}

/** 召回完成但一段都没注入:有达标的段落,却都放不进召回预算。 */
export const RECALL_DONE_OVER_BUDGET = '召回完成:超出注入预算,本回合未注入';
/** 召回完成但一段都没注入:没有段落达到阈值。 */
export const RECALL_DONE_NONE_PASSED = '召回完成:无内容达标,本回合未注入';
/** 召回进行中。 */
export const RECALL_RUNNING = '进行中…';
/** 用户点了停止生成,召回随之取消。 */
export const RECALL_STOPPED = '未召回:已停止生成';

/** 关键词一路的命中 */
export interface RecallDebugKeywordHit {
  leafId: string;
  source: string;
  score: number;
  matched: string[];
  storyTime: string;
  preview: string;
}

export interface RecallDebug {
  /** 记录时刻(Date.now);0 = 尚无记录 */
  at: number;
  /** 状态文案:'召回完成' | '进行中…' | '未召回:…' | '失败:…' */
  status: string;
  /** 查询重写的场景意图(兼作 rerank query;为空时重排改用全部检索语句) */
  intent: string;
  /** 查询重写产出的多条检索 query */
  queries: string[];
  embedding: RecallDebugEmbedHit[];
  /** 关键词一路的命中(关闭关键词召回或没提到已知名字时为空) */
  keyword: RecallDebugKeywordHit[];
  rerank: RecallDebugRerankHit[];
  /** 最终注入主对话的文本(空 = 本回合未注入) */
  injectedText: string;
  /** 本轮没有重排时的说明(已写成完整句子);重排成功或没有候选时为空。旧快照没有此字段 */
  rerankIssue?: string;
  /** 召回前补建索引时剩余的条数;没有在补时为 0。旧快照没有此字段 */
  indexPending?: number;
  /** 索引方面的提示(补建超时、补建失败、换了 Embedding 模型等,已写成完整句子);没有时为空。旧快照没有此字段 */
  indexNote?: string;
}

function empty(): RecallDebug {
  return {
    at: 0, status: '', intent: '', queries: [], embedding: [], keyword: [], rerank: [], injectedText: '',
    rerankIssue: '', indexPending: 0, indexNote: '',
  };
}

/** 全局召回调试快照。UI 直接订阅;recall.ts 在各阶段写入。 */
export const recallDebug = reactive<RecallDebug>(empty());

// 快照每次开新/还原/改状态/清空都 +1。拦截器据此判断这次生成前召回是否真的跑过,
// 跑过才把结果登记给本次回复(见 floorRecall.ts);不能看 at,复用缓存时 at 是旧值。
let writes = 0;
export function recallDebugWrites(): number {
  return writes;
}

/** 摘要预览:取摘要文本截断,供面板单行展示(去换行,限长)。 */
export function previewOf(text: string | null | undefined, max = 80): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 开一次新召回:清空各阶段、置「进行中」。在 runVectorRecall 进入有效路径后调用。 */
export function resetRecallDebug(): void {
  writes++;
  Object.assign(recallDebug, empty(), { at: Date.now(), status: RECALL_RUNNING });
}

/** 仅更新状态文案(各早退路径写明原因,如「未召回:Query 重写未配置」)。 */
export function setRecallStatus(status: string): void {
  writes++;
  recallDebug.status = status;
  if (!recallDebug.at) recallDebug.at = Date.now();
}

export function setRecallRewrite(intent: string, queries: string[]): void {
  recallDebug.intent = intent;
  recallDebug.queries = [...queries];
}

export function setRecallEmbedding(hits: RecallDebugEmbedHit[]): void {
  recallDebug.embedding = hits;
}

export function setRecallKeyword(hits: RecallDebugKeywordHit[]): void {
  recallDebug.keyword = hits;
}

export function setRecallRerank(hits: RecallDebugRerankHit[]): void {
  recallDebug.rerank = hits;
}

export function setRecallInjected(text: string): void {
  recallDebug.injectedText = text;
}

/** 本轮没有重排时写入说明;重排成功时写空串。 */
export function setRecallRerankIssue(text: string): void {
  recallDebug.rerankIssue = text;
}

/** 召回前补建索引的剩余条数(0 = 没有在补)。 */
export function setRecallIndexPending(n: number): void {
  recallDebug.indexPending = Math.max(0, Math.floor(n) || 0);
}

/** 索引方面的提示(补建超时、补建失败、换了 Embedding 模型等)。 */
export function setRecallIndexNote(text: string): void {
  recallDebug.indexNote = text;
}

/** 快照当前调试结果(深拷贝),供召回缓存留存,命中时再 restore 回面板。 */
export function snapshotRecallDebug(): RecallDebug {
  return JSON.parse(JSON.stringify(recallDebug));
}

/** 把缓存的调试快照还原到面板(命中缓存时用,免得 reset 后面板空白)。旧快照缺的字段按空值补齐。 */
export function restoreRecallDebug(snap: RecallDebug): void {
  writes++;
  Object.assign(recallDebug, empty(), snap);
}

/** 清空快照(切聊天时用):「上次召回」只说当前聊天,不把别的聊天的召回留给面板和快捷回复按钮。 */
export function clearRecallDebug(): void {
  writes++;
  Object.assign(recallDebug, empty());
}
