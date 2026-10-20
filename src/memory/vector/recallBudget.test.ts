import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import type { VecHit } from '@/api/baibaoku';
import { BUDGET_NOTICE, estimateTokens, slotBudget } from '../budget';
import { memory } from '../store';
import { createEmptyMemory } from '../types';
import * as rewrite from './rewrite';
import * as scope from './scope';
import * as vectorIndex from './index';
import * as vectorStore from './store';
import * as embed from './embed';
import { RECALL_DONE_OVER_BUDGET, recallDebug } from './debug';
import { recallStatusText } from './recallView';
import { buildRecallText, runVectorRecall } from './recall';

const { apiSettings } = settings;
const saved = JSON.stringify(apiSettings);
const cfg = () => ({ ...apiSettings.vector.recall, embeddingThreshold: 0.8, rerankThreshold: 0.9, fullTextCount: 2, finalRecallCount: 5 });
const hit = (leafId: string, patch: Partial<VecHit> & { rerankScore?: number } = {}) => ({
  leafId, scope: 'test', similarity: 0.85, rerankScore: 0.5, queryIndex: 0, document: `${leafId}的摘要。`, mesFull: null, storyTime: null, msgIndex: 3, ...patch,
});

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  apiSettings.memoryBudgetTokens = 6000;
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.assign(apiSettings, JSON.parse(saved));
});

describe('召回内容放进预算', () => {
  it('全部放得下时照常发原文和摘要', () => {
    const r = buildRecallText([hit('甲', { rerankScore: 0.95, mesFull: '甲的原文，短。' }), hit('乙')], cfg(), 'test', '');
    expect([...r.tiers]).toEqual([['甲', 'full'], ['乙', 'brief']]);
    expect(r.text).toContain('甲的原文，短。');
    expect(r.text).toContain('乙的摘要。');
    expect(r.text).not.toContain(BUDGET_NOTICE);
    expect(r.cut.size + r.downgraded.size).toBe(0);
  });

  it('原文放不进召回预算时改发这一段的摘要，排在摘要档最前', () => {
    const r = buildRecallText([hit('甲', { rerankScore: 0.95, mesFull: '甲的原文。'.repeat(400) }), hit('乙')], cfg(), 'test', '');
    expect(r.tiers.get('甲')).toBe('brief');
    expect([...r.downgraded]).toEqual(['甲']);
    expect(r.text).not.toContain('甲的原文。');
    expect(r.text.indexOf('甲的摘要。')).toBeLessThan(r.text.indexOf('乙的摘要。'));
    expect(r.text).not.toContain(BUDGET_NOTICE);
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(slotBudget('recall'));
  });

  it('放不下的段落不注入，其余照常注入并附预算提示', () => {
    const long = (id: string) => hit(id, { document: `${id}：` + '旧事。'.repeat(130) });
    const r = buildRecallText([long('甲'), long('乙'), long('丙')], cfg(), 'test', '');
    expect([...r.tiers.keys()]).toEqual(['甲']);
    expect([...r.cut]).toEqual(['乙', '丙']);
    expect(r.text).toContain(BUDGET_NOTICE);
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(slotBudget('recall'));
  });

  it('一段都放不下时不注入，不留只有说明文字的空框', () => {
    const r = buildRecallText([hit('甲', { rerankScore: 0.95, mesFull: '原文。'.repeat(800), document: '摘要。'.repeat(800) })], cfg(), 'test', '');
    expect(r.text).toBe('');
    expect([...r.cut]).toEqual(['甲']);
    apiSettings.memoryBudgetTokens = 2000; // 召回份额连说明文字都放不下
    const small = buildRecallText([hit('乙')], cfg(), 'test', '');
    expect(small.text).toBe('');
    expect([...small.cut]).toEqual(['乙']);
  });
});

describe('召回流程里的预算结果', () => {
  function setup(results: VecHit[]) {
    const slots = new Map<string, string>();
    const chat: STMessage[] = [{ name: '主角', is_user: true, is_system: false, mes: '还记得那个约定吗？' }];
    const ctx = { chat, chatMetadata: {}, name1: '主角', name2: '角色', getCurrentChatId: () => 'budget',
      setExtensionPrompt: vi.fn((key: string, text: string) => slots.set(key, text)) } as unknown as STContext;
    vi.spyOn(context, 'getContext').mockReturnValue(ctx);
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
    apiSettings.vector.enabled = true;
    vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
    vi.spyOn(scope, 'currentVectorDb').mockReturnValue('test');
    vi.spyOn(scope, 'recallScopes').mockReturnValue(['test']);
    vi.spyOn(scope, 'currentBundleHashes').mockReturnValue(['bundle']);
    vi.spyOn(scope, 'currentChatScope').mockReturnValue('test');
    vi.spyOn(scope, 'currentChatId').mockReturnValue('budget');
    vi.spyOn(vectorIndex, 'ensureRecallIndex').mockResolvedValue(undefined);
    vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: '约定', queries: ['约定'] });
    vi.spyOn(embed, 'embedTexts').mockResolvedValue([new Float32Array([1, 0])]);
    vi.spyOn(embed, 'encodeFloat32Base64').mockReturnValue('AA');
    vi.spyOn(embed, 'rerankDocuments').mockRejectedValue(new Error('测试:未配重排'));
    vi.spyOn(vectorStore, 'vecSearch').mockResolvedValue({ results });
    return slots;
  }

  it('达标的段落都放不下：不注入，状态和第 4 步写明超出预算', async () => {
    const slots = setup([{ leafId: 'old', scope: 'test', similarity: 0.99, queryIndex: 0, document: '先前的约定。'.repeat(300), mesFull: null, storyTime: null, msgIndex: 0 }]);
    await runVectorRecall();
    expect(slots.get('baibai_book_vector_recall')).toBe('');
    expect(recallDebug.status).toBe(RECALL_DONE_OVER_BUDGET);
    expect(recallDebug.rerank.map(h => h.tier)).toEqual(['cut']);
    expect(recallStatusText(recallDebug)).toBe('召回完成，达到阈值的 1 段超出召回预算，本次未注入。可在「设置 → 注入设置」中调高「记忆注入预算」。');
  });

  it('原文放不下改发摘要：第 4 步标为摘要并注明原文超出预算', async () => {
    const slots = setup([{ leafId: 'old', scope: 'test', similarity: 0.99, queryIndex: 0, document: '先前约定周五还书。', mesFull: '那天他们约定……'.repeat(300), storyTime: null, msgIndex: 0 }]);
    await runVectorRecall();
    expect(slots.get('baibai_book_vector_recall')).toContain('先前约定周五还书。');
    expect(recallDebug.status).toBe('召回完成');
    expect(recallDebug.rerank[0]).toMatchObject({ tier: 'brief', downgraded: true });
  });
});
