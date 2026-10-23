/**
 * 柏宝库向量接口的前端纯传输层。
 * 只负责把 /api/plugins/baibaoku/v1/vec/* 请求发出去;database/scope 等业务参数由调用方传入。
 * 向量记忆的「选哪个库/哪个 scope」逻辑在 memory/vector/scope.ts,不在这里。
 * 每个请求都带超时:召回在正文生成前阻塞,后端挂住时要能放行生成。
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

/** 检索、对账等轻量请求的超时(毫秒)。召回在正文生成前阻塞,后端挂住时不能一直等。 */
const READ_TIMEOUT_MS = 30_000;
/** 写入类请求(一次最多几十条向量和原文)的超时(毫秒)。 */
const WRITE_TIMEOUT_MS = 60_000;
/** 探测后端是否就绪的超时(毫秒)。 */
const STATUS_TIMEOUT_MS = 5_000;

/** 带超时的 fetch:到时中断请求;正文也在时限内读完(读正文时超时同样按超时报错)。 */
async function fetchWithin<T>(url: string, init: RequestInit, timeoutMs: number, read: (resp: Response) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const value = await read(resp);
    if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

type VecPayload<T> = { ok: true; data: T } | { ok: false; error?: { code?: string; message?: string } } | null;

/** 发一个 vec 动作请求;非 ok 抛错(带后端 code/message);超时抛错并写明等待了多久。 */
async function request<T>(action: string, body: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  let result: { resp: Response; payload: VecPayload<T> };
  try {
    result = await fetchWithin(
      `${BASE_URL}/${action}`,
      { method: 'POST', headers: headers(), body: JSON.stringify(body) },
      timeoutMs,
      async resp => ({ resp, payload: (await resp.json().catch(() => null)) as VecPayload<T> }),
    );
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') {
      const err = new Error(`柏宝库请求超时（${action}，超过 ${Math.round(timeoutMs / 1000)} 秒），请确认柏宝库后端正常运行`) as Error & { code?: string };
      err.code = 'timeout';
      throw err;
    }
    throw e;
  }
  const { resp, payload } = result;
  if (!resp.ok || !payload?.ok) {
    const msg = (payload && !payload.ok && payload.error?.message) || `柏宝库请求失败:${action}`;
    const err = new Error(msg) as Error & { code?: string };
    if (payload && !payload.ok) err.code = payload.error?.code;
    throw err;
  }
  return payload.data;
}

/** 后端柏宝库是否可用(驱动就绪)。失败或超时静默返回 false,不阻断主流程。 */
export async function isBaiBaoKuAvailable(): Promise<boolean> {
  try {
    const payload = await fetchWithin(
      `${BASE_URL}/status`,
      { method: 'GET' },
      STATUS_TIMEOUT_MS,
      async r => (await r.json().catch(() => null)) as { ok: true; data: { driver?: { available?: boolean } } } | null,
    );
    return Boolean(payload?.ok && payload.data?.driver?.available);
  } catch {
    return false;
  }
}

export function vecUpsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }> {
  return request('vec/upsert', { database, scope, items }, WRITE_TIMEOUT_MS);
}

export function vecUpdatePayload(
  database: string,
  scope: string,
  items: VecPayloadItem[],
): Promise<{ updated: number }> {
  return request('vec/update-payload', { database, scope, items }, WRITE_TIMEOUT_MS);
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
  return request('vec/delete', { database, scope, leafIds }, WRITE_TIMEOUT_MS);
}

export function vecClearScope(database: string, scope: string): Promise<{ deleted: number }> {
  return request('vec/clear-scope', { database, scope }, WRITE_TIMEOUT_MS);
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
  return request('vec/bundle/create', { database, sourceChatId }, WRITE_TIMEOUT_MS);
}
