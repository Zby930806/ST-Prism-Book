/**
 * 向量存储的调度层 + 纯前端本地实现(IndexedDB),集中在这一个文件,尽量不污染其它代码。
 *
 * 后端柏宝库装了 → 走 BackendStore(转发 api/baibaoku.ts);没装 → 自动透明降级到
 * LocalStore:索引存浏览器 IndexedDB,召回只在当前聊天范围(不跨聊天、不跨设备)。
 *
 * 对外导出与 api/baibaoku.ts **同名同签名**的 vec* 函数:调用方(index.ts / recall.ts)
 * 只需把 import 来源从 '@/api/baibaoku' 换成 './store',函数名与逻辑零改动。
 *
 * bundle(带数据建新对话的跨聊天快照)是后端独占能力,本地不实现——carryover.ts 仍直连
 * baibaoku,后端不在时它自会跳过建 bundle(新对话不带旧向量召回,摘要文本照常携带),
 * 正是降级想要的行为,故 carryover.ts 不动。
 *
 * 探测一次后端 /status,结果带 TTL 缓存:后端可用长缓存,本地短缓存(后端稍后就绪能切回)。
 */

import {
  isBaiBaoKuAvailable,
  vecUpsert as vecUpsertBackend,
  vecUpdatePayload as vecUpdatePayloadBackend,
  vecSearch as vecSearchBackend,
  vecReconcile as vecReconcileBackend,
  vecClearScope as vecClearScopeBackend,
  vecStats as vecStatsBackend,
  type VecItem,
  type VecPayloadItem,
  type VecHit,
} from '@/api/baibaoku';
import { decodeFloat32Base64 } from './embed';

type SearchOpts = { topK?: number; excludeLeafIds?: string[] };

/** 与 baibaoku.ts 的 vec* 一一对应的最小存储接口(bundle 后端独占,不入接口)。 */
export interface VectorStore {
  kind: 'backend' | 'local';
  upsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }>;
  updatePayload(database: string, scope: string, items: VecPayloadItem[]): Promise<{ updated: number }>;
  search(database: string, scopes: string[], queryVectors: string[], opts?: SearchOpts): Promise<{ results: VecHit[] }>;
  reconcile(
    database: string,
    scope: string,
    present: Array<{ leafId: string; docHash: string; payloadHash: string }>,
  ): Promise<{ deleted: number; missing: string[]; stalePayload: string[] }>;
  clearScope(database: string, scope: string): Promise<{ deleted: number }>;
  stats(database: string, scopes: string[]): Promise<{ stats: Record<string, number> }>;
}

/* ============ 后端实现:转发 api/baibaoku.ts ============ */

const backendStore: VectorStore = {
  kind: 'backend',
  upsert: vecUpsertBackend,
  updatePayload: vecUpdatePayloadBackend,
  search: (db, scopes, qv, opts = {}) => vecSearchBackend(db, scopes, qv, opts),
  reconcile: vecReconcileBackend,
  clearScope: vecClearScopeBackend,
  stats: vecStatsBackend,
};

/* ============ 本地实现:IndexedDB + JS 余弦 ============ */

const DB_NAME = 'bbs_vec_local';
const DB_VERSION = 1;
const STORE = 'items';

/** IndexedDB 单库单表:key = [database, scope, leafId];by_scope 索引按 [database, scope] 取整段。 */
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: ['database', 'scope', 'leafId'] });
        os.createIndex('by_scope', ['database', 'scope'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 落库记录:向量以 Float32Array 直存(IndexedDB 结构化克隆原生支持类型化数组,免反复编解码)。 */
interface LocalRecord {
  database: string;
  scope: string;
  leafId: string;
  docHash: string;
  payloadHash?: string;
  vector: Float32Array;
  dim: number;
  document: string;
  mesFull: string | null;
  storyTime: string | null;
  msgIndex: number | null;
}

/** 取某 [database, scope] 下全部记录(规模 = 当前聊天叶子数,单角色可控)。 */
async function getScopeRows(database: string, scope: string): Promise<LocalRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const idx = tx.objectStore(STORE).index('by_scope');
  const rows = await reqDone(idx.getAll(IDBKeyRange.only([database, scope])));
  return rows as LocalRecord[];
}

/* —— 向量归一化 / 余弦,口径对齐后端 vector-store.js —— */

function normalize(vec: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const norm = Math.sqrt(s);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** a 已归一化,b 在此归一化后点积 = 余弦相似度;维度不一致返回 -1(不可比)。 */
function dotNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(nb);
  if (norm === 0) return -1;
  return dot / norm;
}

const localStore: VectorStore = {
  kind: 'local',

  async upsert(database, scope, items) {
    if (!items.length) return { upserted: 0 };
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const it of items) {
      const rec: LocalRecord = {
        database,
        scope,
        leafId: it.leafId,
        docHash: it.docHash,
        payloadHash: it.payloadHash,
        vector: decodeFloat32Base64(it.vector),
        dim: it.dim,
        document: it.document,
        mesFull: it.mesFull ?? null,
        storyTime: it.storyTime ?? null,
        msgIndex: it.msgIndex ?? null,
      };
      os.put(rec);
    }
    await txDone(tx);
    return { upserted: items.length };
  },

  async updatePayload(database, scope, items) {
    if (!items.length) return { updated: 0 };
    const rows = await getScopeRows(database, scope);
    const byId = new Map(rows.map(row => [row.leafId, row]));
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    let updated = 0;
    for (const it of items) {
      const rec = byId.get(it.leafId);
      if (!rec) continue;
      rec.payloadHash = it.payloadHash;
      rec.mesFull = it.mesFull ?? null;
      rec.storyTime = it.storyTime ?? null;
      os.put(rec);
      updated++;
    }
    await txDone(tx);
    return { updated };
  },

  // max 融合:每个叶子取它在各 query 上的最高余弦,跨 scope 同叶子合并留最高分。
  // 纯按最终分取前 topK,不套阈值(阈值留召回端分档)。完全对齐后端 search。
  async search(database, scopes, queryVectors, opts = {}) {
    const topK = Number.isInteger(opts.topK) && (opts.topK as number) > 0 ? (opts.topK as number) : 20;
    const exclude = new Set((opts.excludeLeafIds ?? []).map(String));
    if (!scopes.length || !queryVectors.length) return { results: [] };

    const queries = queryVectors.map(decodeFloat32Base64).map(normalize);
    const fused = new Map<string, { row: LocalRecord; bestSim: number; bestQuery: number }>();

    for (const scope of scopes) {
      const rows = await getScopeRows(database, scope);
      for (const r of rows) {
        if (exclude.has(String(r.leafId))) continue;
        const v = r.vector instanceof Float32Array ? r.vector : Float32Array.from(r.vector as ArrayLike<number>);
        let best = -1;
        let bestQ = -1;
        for (let qi = 0; qi < queries.length; qi++) {
          const sim = dotNormalized(queries[qi], v);
          if (sim > best) {
            best = sim;
            bestQ = qi;
          }
        }
        const key = String(r.leafId);
        const prev = fused.get(key);
        if (!prev || best > prev.bestSim || (best === prev.bestSim && r.scope === scopes[0] && prev.row.scope !== scopes[0])) {
          fused.set(key, { row: r, bestSim: best, bestQuery: bestQ });
        }
      }
    }

    const merged = [...fused.values()].sort((a, b) => b.bestSim - a.bestSim).slice(0, topK);
    return {
      results: merged.map(({ row, bestSim, bestQuery }) => ({
        leafId: row.leafId,
        scope: row.scope,
        similarity: bestSim,
        queryIndex: bestQuery,
        document: row.document,
        mesFull: row.mesFull ?? null,
        storyTime: row.storyTime ?? null,
        msgIndex: row.msgIndex ?? null,
      })),
    };
  },

  // 删 scope 下不在 present 的陈旧叶子;返回后端没有 / hash 变了的 leafId(需重 embed)。
  async reconcile(database, scope, present) {
    const rows = await getScopeRows(database, scope);
    const presentMap = new Map(present.map(p => [String(p.leafId), {
      docHash: String(p.docHash ?? ''),
      payloadHash: String(p.payloadHash ?? ''),
    }]));
    const existing = new Map(rows.map(r => [String(r.leafId), {
      docHash: String(r.docHash),
      payloadHash: String(r.payloadHash ?? ''),
    }]));

    const toDelete: string[] = [];
    for (const id of existing.keys()) if (!presentMap.has(id)) toDelete.push(id);

    const missing: string[] = [];
    const stalePayload: string[] = [];
    for (const [id, hashes] of presentMap) {
      const cur = existing.get(id);
      if (cur === undefined || cur.docHash !== hashes.docHash) missing.push(id);
      else if (cur.payloadHash !== hashes.payloadHash) stalePayload.push(id);
    }

    if (toDelete.length) {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      for (const id of toDelete) os.delete([database, scope, id]);
      await txDone(tx);
    }
    return { deleted: toDelete.length, missing, stalePayload };
  },

  async clearScope(database, scope) {
    const rows = await getScopeRows(database, scope);
    if (!rows.length) return { deleted: 0 };
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const r of rows) os.delete([database, r.scope, r.leafId]);
    await txDone(tx);
    return { deleted: rows.length };
  },

  async stats(database, scopes) {
    const out: Record<string, number> = {};
    for (const s of scopes) {
      const rows = await getScopeRows(database, s);
      out[s] = rows.length;
    }
    return { stats: out };
  },
};

/* ============ 调度:探测后端,选 store(带 TTL 缓存) ============ */

let probe: { store: VectorStore; at: number } | null = null;
const TTL_BACKEND = 5 * 60_000; // 后端可用:5 分钟内不再探测
const TTL_LOCAL = 15_000; // 已降级本地:15 秒后允许重探(后端可能刚就绪)

/** 取当前生效的 store:探测后端 /status,可用走后端,否则降级本地。结果带 TTL 缓存。 */
export async function getVectorStore(): Promise<VectorStore> {
  const now = Date.now();
  if (probe) {
    const ttl = probe.store.kind === 'backend' ? TTL_BACKEND : TTL_LOCAL;
    if (now - probe.at < ttl) return probe.store;
  }
  let store: VectorStore;
  try {
    store = (await isBaiBaoKuAvailable()) ? backendStore : localStore;
  } catch {
    store = localStore;
  }
  probe = { store, at: now };
  return store;
}

/** 当前向量后端类型('backend' 后端 / 'local' 本地降级),供设置页状态指示。 */
export async function vectorBackendKind(): Promise<'backend' | 'local'> {
  return (await getVectorStore()).kind;
}

/** 清探测缓存:手动「重建/清空索引」前调用,强制重测一次后端是否就绪。 */
export function resetVectorStoreProbe(): void {
  probe = null;
}

/* ============ 对外转发:与 api/baibaoku.ts 同名同签名 ============ */

export async function vecUpsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }> {
  return (await getVectorStore()).upsert(database, scope, items);
}

export async function vecUpdatePayload(
  database: string,
  scope: string,
  items: VecPayloadItem[],
): Promise<{ updated: number }> {
  return (await getVectorStore()).updatePayload(database, scope, items);
}

export async function vecSearch(
  database: string,
  scopes: string[],
  queryVectors: string[],
  opts: SearchOpts = {},
): Promise<{ results: VecHit[] }> {
  return (await getVectorStore()).search(database, scopes, queryVectors, opts);
}

export async function vecReconcile(
  database: string,
  scope: string,
  present: Array<{ leafId: string; docHash: string; payloadHash: string }>,
): Promise<{ deleted: number; missing: string[]; stalePayload: string[] }> {
  return (await getVectorStore()).reconcile(database, scope, present);
}

export async function vecClearScope(database: string, scope: string): Promise<{ deleted: number }> {
  return (await getVectorStore()).clearScope(database, scope);
}

export async function vecStats(database: string, scopes: string[]): Promise<{ stats: Record<string, number> }> {
  return (await getVectorStore()).stats(database, scopes);
}
