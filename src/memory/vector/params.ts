/**
 * 召回参数与向量端点数值的运行时规整。
 *
 * 设置页的数字框清空时会暂时写入空串，越界值也会原样保存。召回读取参数时先按这里的规则收敛，
 * 设置页的输入框失焦时用同一套规则回填合法值。默认值与 api/settings.ts 的 defaults() 保持一致。
 * 只依赖设置的类型，不读设置对象，便于单测和在设置页复用。
 */
import type { VectorEndpoint, VectorRecallSettings } from '@/api/settings';
import { normalizeRecallInjectionDepth } from './depth';

/** 召回参数的默认值(与 api/settings.ts 一致)。 */
export const RECALL_PARAM_DEFAULTS = {
  rerankCandidates: 20,
  embeddingThreshold: 0.8,
  rerankThreshold: 0.9,
  fullTextCount: 2,
  finalRecallCount: 5,
  minAiFloors: 30,
  stickyTurns: 0,
} as const;

/** 召回保留轮数的上限。 */
export const STICKY_TURNS_MAX = 5;

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 阈值:0–1。非数字(含清空后的空串)或超出 0–1(比如按百分数填了 80)时回退默认值,与载入设置时的规整一致。 */
export function normalizeRecallThreshold(v: unknown, fallback: number): number {
  const n = finiteNumber(v);
  return n === null || n < 0 || n > 1 ? fallback : n;
}

/** 条数:不小于 min 的整数。非数字或负数回退默认值(与载入设置时一致),小数向下取整。 */
export function normalizeRecallCount(v: unknown, fallback: number, min = 0): number {
  const n = finiteNumber(v);
  return n === null || n < 0 ? fallback : Math.max(min, Math.floor(n));
}

/** 召回保留轮数:0–5 的整数,非数字回退 0(关闭)。 */
export function normalizeRecallStickyTurns(v: unknown): number {
  const n = finiteNumber(v);
  return n === null ? RECALL_PARAM_DEFAULTS.stickyTurns : Math.min(STICKY_TURNS_MAX, Math.max(0, Math.floor(n)));
}

/**
 * 召回参数整体规整:两个阈值限制在 0–1;候选数至少为 1;全文数、最终条数、起召楼数取非负整数;
 * 非法值回退默认。开关类字段原样保留。
 */
export function normalizeRecallParams(raw: Partial<VectorRecallSettings> | null | undefined): VectorRecallSettings {
  const r = (raw ?? {}) as Partial<VectorRecallSettings>;
  const d = RECALL_PARAM_DEFAULTS;
  return {
    ...r,
    injectionDepth: normalizeRecallInjectionDepth(r.injectionDepth),
    rerankCandidates: normalizeRecallCount(r.rerankCandidates, d.rerankCandidates, 1),
    embeddingThreshold: normalizeRecallThreshold(r.embeddingThreshold, d.embeddingThreshold),
    rerankThreshold: normalizeRecallThreshold(r.rerankThreshold, d.rerankThreshold),
    fullTextCount: normalizeRecallCount(r.fullTextCount, d.fullTextCount),
    finalRecallCount: normalizeRecallCount(r.finalRecallCount, d.finalRecallCount),
    minAiFloors: normalizeRecallCount(r.minAiFloors, d.minAiFloors),
    stickyTurns: normalizeRecallStickyTurns(r.stickyTurns),
  } as VectorRecallSettings;
}

/* ============ 向量端点 ============ */

export type VectorRole = 'embedding' | 'rerank' | 'queryRewrite';

/** 各端点超时(秒)与重试次数的默认值(与 api/settings.ts 一致)。 */
export const VECTOR_ENDPOINT_DEFAULTS: Record<VectorRole, { timeoutSec: number; retries: number }> = {
  embedding: { timeoutSec: 10, retries: 1 },
  rerank: { timeoutSec: 20, retries: 1 },
  queryRewrite: { timeoutSec: 90, retries: 1 },
};

/** 查询重写最大输出的默认值与下限。 */
export const QUERY_REWRITE_MAX_TOKENS_DEFAULT = 8192;
export const QUERY_REWRITE_MAX_TOKENS_MIN = 256;

/** 超时(秒):非数字或不大于 0 时回退该端点的默认值;不足 1 秒按 1 秒。 */
export function normalizeEndpointTimeout(v: unknown, role: VectorRole): number {
  const n = finiteNumber(v);
  if (n === null || n <= 0) return VECTOR_ENDPOINT_DEFAULTS[role].timeoutSec;
  return Math.max(1, n);
}

/** 重试次数:非负整数,非数字回退该端点的默认值。 */
export function normalizeEndpointRetries(v: unknown, role: VectorRole): number {
  const n = finiteNumber(v);
  return n === null || n < 0 ? VECTOR_ENDPOINT_DEFAULTS[role].retries : Math.floor(n);
}

/** 查询重写最大输出:不小于 256 的整数,非数字回退 8192。 */
export function normalizeQueryRewriteMaxTokens(v: unknown): number {
  const n = finiteNumber(v);
  return n === null ? QUERY_REWRITE_MAX_TOKENS_DEFAULT : Math.max(QUERY_REWRITE_MAX_TOKENS_MIN, Math.floor(n));
}

/** 端点的运行时副本:超时与重试按上面的规则收敛,地址、密钥、模型原样保留。 */
export function runtimeEndpoint(ep: VectorEndpoint, role: VectorRole): VectorEndpoint {
  return {
    ...ep,
    timeoutSec: normalizeEndpointTimeout(ep.timeoutSec, role),
    retries: normalizeEndpointRetries(ep.retries, role),
  };
}

type EndpointTimes = Partial<Pick<VectorEndpoint, 'timeoutSec' | 'retries'>> | null | undefined;

/** 某端点一次请求最长可能等待的时间(毫秒):超时 ×(重试次数 + 1)。 */
export function endpointBudgetMs(ep: EndpointTimes, role: VectorRole): number {
  const timeout = normalizeEndpointTimeout(ep?.timeoutSec, role);
  const retries = normalizeEndpointRetries(ep?.retries, role);
  return Math.round(timeout * (retries + 1) * 1000);
}

/**
 * 整次召回的兜底时限(毫秒):三个端点「超时 ×(重试次数 + 1)」之和。
 * 只防止某一步一直没有返回、把正文生成卡住;各请求自己的超时仍按端点设置生效。
 */
export function recallDeadlineMs(vector: Partial<Record<VectorRole, EndpointTimes>> | null | undefined): number {
  return (['embedding', 'rerank', 'queryRewrite'] as const)
    .reduce((sum, role) => sum + endpointBudgetMs(vector?.[role], role), 0);
}
