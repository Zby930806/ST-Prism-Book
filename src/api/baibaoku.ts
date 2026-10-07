/**
 * 柏宝库向量接口的前端纯传输层。
 * 只负责把 /api/plugins/baibaoku/v1/vec/* 请求发出去;database/scope 等业务参数由调用方传入。
 * 向量记忆的「选哪个库/哪个 scope」逻辑在 memory/vector/scope.ts,不在这里。
 */

import { getContext } from '@/st/context';

const BASE_URL = '/api/plugins/baibaoku/v1';

/** upsert 单条向量项(向量为 base64 编码的 float32 小端) */
export interface VecItem {
  leafId: string;
  docHash: string;
  payloadHash: string;
  vector: string;
  dim: number;
  document: string;
  mesFull?: string | null;
  storyTime?: string | null;
  msgIndex?: number | null;
}

/** 摘要向量未变时，仅更新全文和故事时间。 */
export interface VecPayloadItem {
  leafId: string;
  payloadHash: string;
  mesFull?: string | null;
  storyTime?: string | null;
}

/** search 单条命中 */
export interface VecHit {
  leafId: string;
  scope: string;
  similarity: number;
  /** 取得最佳相似度的 query 下标(来源 Q);旧后端未回传时为 -1 */
  queryIndex: number;
  document: string;
  mesFull: string | null;
  storyTime: string | null;
  msgIndex: number | null;
}

function headers(): Record<string, string> {
  const ctx = getContext();
  const h = ctx?.getRequestHeaders?.();
  return h ?? { 'Content-Type': 'application/json' };
}

/** 发一个 vec 动作请求;非 ok 抛错(带后端 code/message)。 */
async function request<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${BASE_URL}/${action}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const payload = (await resp.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { code?: string; message?: string } }
    | null;
  if (!resp.ok || !payload?.ok) {
    const msg = (payload && !payload.ok && payload.error?.message) || `柏宝库请求失败:${action}`;
    const err = new Error(msg) as Error & { code?: string };
    if (payload && !payload.ok) err.code = payload.error?.code;
    throw err;
  }
  return payload.data;
}

/** 后端柏宝库是否可用(驱动就绪)。失败静默返回 false,不阻断主流程。 */
export async function isBaiBaoKuAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/status`, { method: 'GET' });
    const payload = (await resp.json().catch(() => null)) as
      | { ok: true; data: { driver?: { available?: boolean } } }
      | null;
    return Boolean(payload?.ok && payload.data?.driver?.available);
  } catch {
    return false;
  }
}

export function vecUpsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }> {
  return request('vec/upsert', { database, scope, items });
}

export function vecUpdatePayload(
  database: string,
  scope: string,
  items: VecPayloadItem[],
): Promise<{ updated: number }> {
  return request('vec/update-payload', { database, scope, items });
}

export function vecSearch(
  database: string,
  scopes: string[],
  queryVectors: string[],
  opts: { topK?: number; excludeLeafIds?: string[] } = {},
): Promise<{ results: VecHit[] }> {
  return request('vec/search', {
    database,
    scopes,
    queryVectors,
    topK: opts.topK,
    excludeLeafIds: opts.excludeLeafIds,
  });
}

export function vecDelete(database: string, scope: string, leafIds: string[]): Promise<{ deleted: number }> {
  return request('vec/delete', { database, scope, leafIds });
}

export function vecClearScope(database: string, scope: string): Promise<{ deleted: number }> {
  return request('vec/clear-scope', { database, scope });
}

/** 对账:删后端陈旧叶子,返回需(重新)embed 的 leafId。 */
export function vecReconcile(
  database: string,
  scope: string,
  present: Array<{ leafId: string; docHash: string; payloadHash: string }>,
): Promise<{ deleted: number; missing: string[]; stalePayload: string[] }> {
  return request('vec/reconcile', { database, scope, present });
}

export function vecStats(database: string, scopes: string[]): Promise<{ stats: Record<string, number> }> {
  return request('vec/stats', { database, scopes });
}

export function vecBundleCreate(
  database: string,
  sourceChatId: string,
): Promise<{ hash: string; scope: string; copied: number; reused: boolean }> {
  return request('vec/bundle/create', { database, sourceChatId });
}
