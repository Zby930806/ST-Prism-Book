import { describe, expect, it } from 'vitest';
import type { VectorRecallSettings } from '@/api/settings';
import {
  endpointBudgetMs,
  normalizeEndpointRetries,
  normalizeEndpointTimeout,
  normalizeQueryRewriteMaxTokens,
  normalizeRecallParams,
  recallDeadlineMs,
  RECALL_PARAM_DEFAULTS,
  runtimeEndpoint,
} from './params';

const valid: VectorRecallSettings = {
  injectionDepth: 2, rerankCandidates: 12, embeddingThreshold: 0.6, rerankThreshold: 0.7,
  fullTextCount: 1, finalRecallCount: 4, minAiFloors: 0, keywordRoute: false, presentBoost: true, stickyTurns: 2,
};

describe('召回参数的运行时规整', () => {
  it('合法值原样保留,开关不动', () => {
    expect(normalizeRecallParams(valid)).toEqual(valid);
  });

  it('输入框清空后的空串回退默认值', () => {
    const blank = Object.fromEntries(Object.keys(valid).map(k => [k, ''])) as unknown as VectorRecallSettings;
    const out = normalizeRecallParams({ ...blank, keywordRoute: true, presentBoost: false });
    expect(out).toMatchObject({
      injectionDepth: 0,
      rerankCandidates: RECALL_PARAM_DEFAULTS.rerankCandidates,
      embeddingThreshold: RECALL_PARAM_DEFAULTS.embeddingThreshold,
      rerankThreshold: RECALL_PARAM_DEFAULTS.rerankThreshold,
      fullTextCount: RECALL_PARAM_DEFAULTS.fullTextCount,
      finalRecallCount: RECALL_PARAM_DEFAULTS.finalRecallCount,
      minAiFloors: RECALL_PARAM_DEFAULTS.minAiFloors,
      stickyTurns: 0,
      keywordRoute: true,
      presentBoost: false,
    });
  });

  it('越界值:阈值超出 0–1、条数为负时回退默认（与载入设置时一致）；候选数至少 1，小数向下取整，保留轮数最多 5', () => {
    const out = normalizeRecallParams({
      ...valid, embeddingThreshold: 80, rerankThreshold: -0.2, rerankCandidates: 0,
      fullTextCount: 2.9, finalRecallCount: -3, minAiFloors: 12.5, stickyTurns: 9, injectionDepth: 3.7,
    });
    expect(out).toMatchObject({
      embeddingThreshold: RECALL_PARAM_DEFAULTS.embeddingThreshold, rerankThreshold: RECALL_PARAM_DEFAULTS.rerankThreshold, rerankCandidates: 1,
      fullTextCount: 2, finalRecallCount: RECALL_PARAM_DEFAULTS.finalRecallCount, minAiFloors: 12, stickyTurns: 5, injectionDepth: 3,
    });
  });

  it('NaN、无穷大和缺失字段同样回退默认', () => {
    const out = normalizeRecallParams({ rerankThreshold: Number.NaN, finalRecallCount: Number.POSITIVE_INFINITY } as Partial<VectorRecallSettings>);
    expect(out.rerankThreshold).toBe(RECALL_PARAM_DEFAULTS.rerankThreshold);
    expect(out.finalRecallCount).toBe(RECALL_PARAM_DEFAULTS.finalRecallCount);
    expect(normalizeRecallParams(undefined).rerankCandidates).toBe(RECALL_PARAM_DEFAULTS.rerankCandidates);
  });
});

describe('向量端点数值的运行时规整', () => {
  it('超时:非法或不大于 0 回退各端点默认值,不足 1 秒按 1 秒', () => {
    expect(normalizeEndpointTimeout('', 'queryRewrite')).toBe(90);
    expect(normalizeEndpointTimeout(0, 'embedding')).toBe(10);
    expect(normalizeEndpointTimeout(-5, 'rerank')).toBe(20);
    expect(normalizeEndpointTimeout(0.4, 'rerank')).toBe(1);
    expect(normalizeEndpointTimeout(45, 'queryRewrite')).toBe(45);
  });

  it('重试次数:非负整数,非法回退默认 1', () => {
    expect(normalizeEndpointRetries('', 'embedding')).toBe(1);
    expect(normalizeEndpointRetries(-1, 'embedding')).toBe(1);
    expect(normalizeEndpointRetries(2.7, 'rerank')).toBe(2);
    expect(normalizeEndpointRetries(0, 'queryRewrite')).toBe(0);
  });

  it('查询重写最大输出:非法回退 8192,低于 256 按 256', () => {
    expect(normalizeQueryRewriteMaxTokens('')).toBe(8192);
    expect(normalizeQueryRewriteMaxTokens(100)).toBe(256);
    expect(normalizeQueryRewriteMaxTokens(9000.6)).toBe(9000);
  });

  it('运行时端点副本只改超时和重试', () => {
    const ep = runtimeEndpoint({ url: 'u', key: 'k', model: 'm', timeoutSec: '' as unknown as number, retries: -2 }, 'rerank');
    expect(ep).toEqual({ url: 'u', key: 'k', model: 'm', timeoutSec: 20, retries: 1 });
  });

  it('整次召回的兜底时限 = 三个端点「超时 ×(重试次数 + 1)」之和', () => {
    expect(endpointBudgetMs({ timeoutSec: 90, retries: 1 }, 'queryRewrite')).toBe(180_000);
    expect(recallDeadlineMs({
      embedding: { timeoutSec: 10, retries: 1 },
      rerank: { timeoutSec: 20, retries: 1 },
      queryRewrite: { timeoutSec: 90, retries: 1 },
    })).toBe(240_000);
    // 缺失或非法时按各端点默认值计算
    expect(recallDeadlineMs(undefined)).toBe(240_000);
    expect(recallDeadlineMs({ queryRewrite: { timeoutSec: 30, retries: 0 } })).toBe(20_000 + 40_000 + 30_000);
  });
});
