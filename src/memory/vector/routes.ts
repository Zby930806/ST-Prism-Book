/**
 * 召回的关键词一路、在场角色加权与多路融合。纯函数,不访问宿主,便于单测。
 *
 * 向量检索对自造的人名、地名容易漏:这里用名册、物品、地点的名字在本聊天摘要里精确匹配,
 * 作为第二路候选,和向量结果按倒数排名融合(RRF)后一起进 rerank。
 * 在场角色加权只影响排序(谁先进 rerank、同分附近谁先入选),不改相似度,也不改分档阈值。
 */
import type { VecHit } from '@/api/baibaoku';
import type { LeafForIndex } from './index';

export interface RecallEntitySource {
  npcs: { name: string }[];
  items: { name: string }[];
  scenes: { name: string }[];
}

/** 少于这个字数的名字区分度太低,不参与匹配 */
const MIN_ENTITY_CHARS = 2;
/** 候选摘要不少于这个数时,出现在过半摘要里的名字(如主要角色)不参与匹配 */
const COMMON_CHECK_MIN_DOCS = 10;
const MAX_DOC_RATIO = 0.5;
/** RRF 常数:名次越靠后加分越少,常数越大各名次之间差距越小 */
const RRF_K = 60;
/** 提到在场角色的候选,融合分乘这个系数 */
const PRESENT_FUSION_BOOST = 1.25;
/** rerank 之后的排序加成(只排序,不参与阈值比较);每提到一个在场角色加一次,最多两次 */
const PRESENT_RERANK_BONUS = 0.02;

/** 可用于匹配的名字:去空白、去重;太短的,以及主角和角色卡的名字除外(几乎每段都有)。 */
export function recallEntities(src: RecallEntitySource, exclude: string[] = []): string[] {
  const skip = new Set(exclude.map(s => s.trim()).filter(Boolean));
  const out = new Set<string>();
  for (const list of [src.npcs, src.items, src.scenes]) {
    for (const x of list ?? []) {
      const name = (x?.name ?? '').trim();
      if (Array.from(name).length >= MIN_ENTITY_CHARS && !skip.has(name)) out.add(name);
    }
  }
  return [...out];
}

export interface KeywordHit {
  leaf: LeafForIndex;
  /** 命中名字的权重和(越少见的名字权重越高) */
  score: number;
  matched: string[];
}

/**
 * 关键词一路:先找出当前对话提到的名字,再在候选摘要正文里精确匹配。
 *  - 只用 queryText 里出现过的名字;
 *  - 权重按出现过的摘要数算(IDF),候选足够多时过于常见的名字直接跳过;
 *  - 只看摘要正文,不看楼层原文(原文很长,会把常见名字都带进来)。
 * 同分时较新的楼层在前。
 */
export function keywordHits(leaves: LeafForIndex[], entities: string[], queryText: string, limit: number): KeywordHit[] {
  const asked = entities.filter(e => queryText.includes(e));
  if (!asked.length || !leaves.length || limit <= 0) return [];
  const n = leaves.length;
  const weights = new Map<string, number>();
  for (const e of asked) {
    const df = leaves.filter(l => l.document.includes(e)).length;
    const tooCommon = n >= COMMON_CHECK_MIN_DOCS && df / n > MAX_DOC_RATIO;
    if (df > 0 && !tooCommon) weights.set(e, Math.log(1 + n / df));
  }
  if (!weights.size) return [];
  const hits: KeywordHit[] = [];
  for (const leaf of leaves) {
    const matched = [...weights.keys()].filter(e => leaf.document.includes(e));
    if (!matched.length) continue;
    hits.push({ leaf, score: matched.reduce((s, e) => s + (weights.get(e) ?? 0), 0), matched });
  }
  hits.sort((a, b) => b.score - a.score || b.leaf.msgIndex - a.leaf.msgIndex);
  return hits.slice(0, limit);
}

/** 融合后的候选:在 VecHit 上带出它来自哪一路,供分档和调试面板使用。 */
export interface FusedCandidate extends VecHit {
  route: 'vector' | 'keyword' | 'both';
  /** 只由关键词命中的候选没有向量相似度(similarity 记 0,不可信) */
  similarityKnown: boolean;
  keywordScore: number;
  keywordMatched: string[];
  /** 摘要里提到的在场角色数 */
  presentHits: number;
  fused: number;
}

function keywordHitToVecHit(h: KeywordHit, scope: string): VecHit {
  return {
    leafId: h.leaf.leafId, scope, similarity: 0, queryIndex: -1,
    document: h.leaf.document, mesFull: h.leaf.mesFull, storyTime: h.leaf.storyTime, msgIndex: h.leaf.msgIndex,
  };
}

/**
 * 倒数排名融合:各路按自己的顺序给分 1/(k+名次),同一段两路都有则相加;
 * 提到在场角色的候选再乘一个小系数。按融合分取前 limit 条进 rerank。
 */
export function fuseRecallRoutes(
  vector: VecHit[],
  keyword: KeywordHit[],
  scope: string,
  presentNames: string[],
  limit: number,
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>();
  vector.forEach((h, i) => {
    if (byId.has(h.leafId)) return; // 后端已跨 scope 合并,这里只留首条兜底
    byId.set(h.leafId, { ...h, route: 'vector', similarityKnown: true, keywordScore: 0, keywordMatched: [], presentHits: 0, fused: 1 / (RRF_K + i + 1) });
  });
  keyword.forEach((k, i) => {
    const add = 1 / (RRF_K + i + 1);
    const cur = byId.get(k.leaf.leafId);
    if (cur) {
      cur.route = 'both';
      cur.keywordScore = k.score;
      cur.keywordMatched = k.matched;
      cur.fused += add;
    } else {
      byId.set(k.leaf.leafId, {
        ...keywordHitToVecHit(k, scope), route: 'keyword', similarityKnown: false,
        keywordScore: k.score, keywordMatched: k.matched, presentHits: 0, fused: add,
      });
    }
  });
  const names = [...new Set(presentNames.map(s => s.trim()).filter(Boolean))];
  for (const c of byId.values()) {
    c.presentHits = names.filter(name => c.document.includes(name)).length;
    if (c.presentHits) c.fused *= PRESENT_FUSION_BOOST;
  }
  return [...byId.values()].sort((a, b) => b.fused - a.fused).slice(0, Math.max(0, limit));
}

/** rerank 之后的排序键:rerank 分加一点在场角色加成。阈值比较仍用原始 rerank 分。 */
export function presentOrderKey(rerankScore: number, presentHits: number | undefined): number {
  return rerankScore + PRESENT_RERANK_BONUS * Math.min(2, presentHits ?? 0);
}
