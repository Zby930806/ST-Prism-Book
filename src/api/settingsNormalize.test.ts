import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAIN_API_MAX_TOKENS_DEFAULT, newChannel, normalizeApiSettings, normalizeChannelMaxTokens, normalizeChannelTemperature,
  normalizeKeepRecent, normalizeMainApiMaxTokens, normalizeRecallParams, normalizeSummaryThreshold,
} from './settings';
import { buildRequestBody } from './client';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// v-model.number 在输入框被清空时写入空串并立即保存；这些值在载入、导入和输入框失焦时都要规整。
describe('数值设置的规整', () => {
  it('保留窗口与三个总结阈值：空串回退默认，总结阈值 1 规整为 0（与 0 一样表示关闭）', () => {
    const s = normalizeApiSettings({ keepRecent: '', leafBatchThreshold: 1, resummaryThreshold: '', higherResummaryThreshold: 1 });
    expect(s.keepRecent).toBe(4);
    expect(s.leafBatchThreshold).toBe(0);
    expect(s.resummaryThreshold).toBe(6);
    expect(s.higherResummaryThreshold).toBe(0);
    expect(normalizeApiSettings({ keepRecent: 0, leafBatchThreshold: 8.6, resummaryThreshold: 0 })).toMatchObject({ keepRecent: 0, leafBatchThreshold: 8, resummaryThreshold: 0 });
    expect(normalizeKeepRecent(-2)).toBe(4);
    expect(normalizeSummaryThreshold('12', 12)).toBe(12);
    expect(normalizeSummaryThreshold(1.4, 12)).toBe(0);
  });

  it('召回参数：阈值须在 0–1 之间，条数为非负整数，候选数至少 1，起始 AI 楼数非法时回退 30', () => {
    const s = normalizeApiSettings({
      vector: { recall: { rerankCandidates: 0, embeddingThreshold: 80, rerankThreshold: '', fullTextCount: -1, finalRecallCount: '', minAiFloors: 'abc', stickyTurns: 9 } },
    });
    expect(s.vector.recall).toMatchObject({
      rerankCandidates: 1, embeddingThreshold: 0.8, rerankThreshold: 0.9, fullTextCount: 2, finalRecallCount: 5, minAiFloors: 30, stickyTurns: 5,
    });
    expect(normalizeApiSettings({ vector: { recall: { minAiFloors: 0, finalRecallCount: 0, embeddingThreshold: 0.65 } } }).vector.recall)
      .toMatchObject({ minAiFloors: 0, finalRecallCount: 0, embeddingThreshold: 0.65 });
    expect(normalizeRecallParams({ rerankCandidates: '' as unknown as number, fullTextCount: 3.7 })).toMatchObject({ rerankCandidates: 20, fullTextCount: 3 });
  });

  it('总开关、自动摘要、仅摘要模式、向量记忆开关不接受非布尔值', () => {
    const s = normalizeApiSettings({ enabled: 'no', autoSummaryEnabled: 0, summaryOnlyMode: 'yes', vector: { enabled: 'true' } });
    expect(s).toMatchObject({ enabled: true, autoSummaryEnabled: true, summaryOnlyMode: false });
    expect(s.vector.enabled).toBe(false);
    expect(normalizeApiSettings({ enabled: false, summaryOnlyMode: true, vector: { enabled: true } })).toMatchObject({ enabled: false, summaryOnlyMode: true, vector: { enabled: true } });
  });

  it('内容边界：旧设置没有这一项时为自动，认不出的值也按自动', () => {
    expect(normalizeApiSettings({}).contentBoundary).toBe('auto');
    expect(normalizeApiSettings({ contentBoundary: 'always' }).contentBoundary).toBe('always');
    expect(normalizeApiSettings({ contentBoundary: 'never' }).contentBoundary).toBe('never');
    for (const bad of ['', 'off', true, false, 1, null]) expect(normalizeApiSettings({ contentBoundary: bad }).contentBoundary).toBe('auto');
  });

  it('Query 重写的请求方式：旧设置没有这一项时为浏览器直连（与 1.4.18 相同），只有明确存成 backend 才经酒馆后端转发', () => {
    expect(normalizeApiSettings({}).vector.queryRewriteRoute).toBe('direct');
    expect(normalizeApiSettings({ vector: { enabled: true, queryRewriteMaxTokens: 4096 } }).vector.queryRewriteRoute).toBe('direct');
    expect(normalizeApiSettings({ vector: { queryRewriteRoute: 'direct' } }).vector.queryRewriteRoute).toBe('direct');
    expect(normalizeApiSettings({ vector: { queryRewriteRoute: 'backend' } }).vector.queryRewriteRoute).toBe('backend');
    for (const bad of ['', 'Backend', 'proxy', true, 1, null]) {
      expect(normalizeApiSettings({ vector: { queryRewriteRoute: bad } }).vector.queryRewriteRoute).toBe('direct');
    }
  });

  it('创作规划的三项提示词：旧设置没有时为空串（用内置的），已有的自定义原样保留，类型不对的按空串', () => {
    // 全新安装（没有任何存档）时三项都是空串
    expect(normalizeApiSettings(null).prompts).toMatchObject({ outline: '', outlineGuidance: '', outlineProgress: '' });
    const old = normalizeApiSettings({ prompts: { summary: '我的摘要提示词', jailbreak: '' } });
    expect(old.prompts).toMatchObject({ summary: '我的摘要提示词', outline: '', outlineGuidance: '', outlineProgress: '' });
    const kept = normalizeApiSettings({ prompts: { outline: '只规划日常线。', outlineGuidance: '{{pace_rule}}保持文风。', outlineProgress: '从严判断。' } });
    expect(kept.prompts).toMatchObject({ outline: '只规划日常线。', outlineGuidance: '{{pace_rule}}保持文风。', outlineProgress: '从严判断。', summary: '' });
    const bad = normalizeApiSettings({ prompts: { outline: 5, outlineGuidance: null, outlineProgress: { text: 'x' } } });
    expect(bad.prompts).toMatchObject({ outline: '', outlineGuidance: '', outlineProgress: '' });
    // 基准版本同样只认这些键里的非空字符串
    expect(normalizeApiSettings({ promptBases: { outline: '旧内置', outlineGuidance: ' ', bogus: 'x' } }).promptBases).toEqual({ outline: '旧内置' });
  });
});

describe('跟随主 API 时的最大回复与预填充', () => {
  it('旧设置没有这两项时按默认 32000、保留预填充；超出范围的值钳到 1024–200000', () => {
    const s = normalizeApiSettings({ keepRecent: 3 });
    expect(s.mainApiMaxTokens).toBe(MAIN_API_MAX_TOKENS_DEFAULT);
    expect(s.mainApiPrefill).toBe(true);
    expect(normalizeApiSettings({ mainApiMaxTokens: 16384, mainApiPrefill: false })).toMatchObject({ mainApiMaxTokens: 16384, mainApiPrefill: false });
    expect(normalizeMainApiMaxTokens(999999)).toBe(200000);
    expect(normalizeMainApiMaxTokens(100)).toBe(1024);
    expect(normalizeMainApiMaxTokens('')).toBe(32000);
    expect(normalizeApiSettings({ mainApiPrefill: 'off' }).mainApiPrefill).toBe(true);
  });
});

describe('渠道的温度与最大输出', () => {
  it('清空或填错时回退默认值并钳制范围，不把空串发给服务商', () => {
    expect(normalizeChannelTemperature('')).toBe(1);
    expect(normalizeChannelTemperature(3)).toBe(2);
    expect(normalizeChannelTemperature(-1)).toBe(0);
    expect(normalizeChannelMaxTokens('')).toBe(65535);
    expect(normalizeChannelMaxTokens(0)).toBe(65535);
    expect(normalizeChannelMaxTokens(4096.7)).toBe(4096);
    const loaded = normalizeApiSettings({ channels: [{ id: 'c', temperature: '', maxTokens: '', timeoutSec: '' }] }).channels[0];
    expect(loaded).toMatchObject({ temperature: 1, maxTokens: 65535, timeoutSec: 180 });
    const draft = { ...newChannel(), temperature: '' as unknown as number, maxTokens: '' as unknown as number };
    const body = buildRequestBody(draft, [{ role: 'user', content: 'hi' }], 'https://api.example.com/v1', false);
    expect(body).toMatchObject({ temperature: 1, max_tokens: 65535 });
  });
});

describe('载入旧存档', () => {
  it('旧存档里清空过的数值经 hydrate 回到有效值', async () => {
    vi.resetModules();
    const context = await import('@/st/context');
    const settings = await import('./settings');
    const stored = JSON.parse(JSON.stringify(settings.apiSettings));
    Object.assign(stored, { wiPatternsSeeded: true, keepRecent: '', leafBatchThreshold: 1 });
    delete stored.mainApiMaxTokens;
    stored.vector.recall.finalRecallCount = '';
    vi.spyOn(context, 'getContext').mockReturnValue({
      chat: [], chatMetadata: {}, extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn(),
    } as unknown as import('@/st/context').STContext);
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    settings.hydrateSettings();
    expect(settings.apiSettings).toMatchObject({ keepRecent: 4, leafBatchThreshold: 0, mainApiMaxTokens: 32000, mainApiPrefill: true });
    expect(settings.apiSettings.vector.recall.finalRecallCount).toBe(5);
  });
});
