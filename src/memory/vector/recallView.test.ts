import { describe, expect, it } from 'vitest';
import type { RecallDebug, RecallDebugRerankHit } from './debug';
import type { FloorRecallRecord } from './floorRecall';
import { floorRecallView, recallButtonLabel, recalledItems, recallPhase, recallStatusText } from './recallView';

const hit = (leafId: string, tier: RecallDebugRerankHit['tier'], source = '#12'): RecallDebugRerankHit => ({
  leafId, tier, source, rerankScore: 0.9, similarity: 0.8, storyTime: '第3天 夜', preview: `${leafId} 的摘要`,
});
const debug = (patch: Partial<RecallDebug>): RecallDebug => ({
  at: Date.now(), status: '', intent: '', queries: [], embedding: [], keyword: [], rerank: [], injectedText: '', ...patch,
});
const record = (patch: Partial<FloorRecallRecord>): FloorRecallRecord => ({ v: 1, at: 1, swipe: 0, status: '召回完成', items: [], ...patch });

// 只验证「召回」按钮、速览弹层和楼层面板的显示逻辑，不涉及真实召回。
describe('召回结果的显示', () => {
  it('召回完成：只列实际注入的段落，按钮写段数', () => {
    const d = debug({ status: '召回完成', rerank: [hit('a', 'full'), hit('b', 'drop'), hit('c', 'brief', '旧档')], injectedText: '……' });
    expect(recallPhase(d)).toBe('done');
    expect(recalledItems(d).map(i => [i.source, i.tierLabel, i.preview])).toEqual([['#12', '全文', 'a 的摘要'], ['旧档', '摘要', 'c 的摘要']]);
    expect(recallButtonLabel(d).text).toBe('召回 2');
    expect(recallStatusText(d)).toBe('召回 2 段，已注入本次生成。');
  });

  it('复用上次结果时注明', () => {
    const d = debug({ status: '召回完成(复用缓存)', rerank: [hit('a', 'full')] });
    expect(recallButtonLabel(d).text).toBe('召回 1');
    expect(recallStatusText(d)).toContain('复用了上次的结果');
  });

  it('完成但没有达标内容：0 段，说明未注入', () => {
    const d = debug({ status: '召回完成:无内容达标,本回合未注入', rerank: [hit('a', 'drop')] });
    expect(recallButtonLabel(d).text).toBe('召回 0');
    expect(recallStatusText(d)).toBe('召回完成，没有达到阈值的内容，本次未注入。');
  });

  it('没召回时不列旧的段落，说明原因', () => {
    const d = debug({ status: '未召回:楼层未达起召门槛或全在窗口内', rerank: [hit('旧', 'full')] });
    expect(recallPhase(d)).toBe('skipped');
    expect(recalledItems(d)).toEqual([]);
    expect(recallButtonLabel(d).text).toBe('未召回');
    expect(recallStatusText(d)).toContain('开始召回的 AI 楼数');
  });

  it('失败、进行中、还没召回过', () => {
    expect(recallButtonLabel(debug({ status: '失败:Embedding 超时' })).text).toBe('召回失败');
    expect(recallStatusText(debug({ status: '失败:Embedding 超时' }))).toBe('召回失败：Embedding 超时。本次生成未注入召回内容。');
    expect(recallButtonLabel(debug({ status: '进行中…' })).text).toBe('召回中…');
    expect(recallButtonLabel(debug({ at: 0, status: '' })).text).toBe('召回');
    expect(recallStatusText(debug({ at: 0, status: '' }))).toContain('尚未召回');
  });

  it('楼层面板：按记录显示段落和说明，没有记录返回 null', () => {
    expect(floorRecallView(null)).toBeNull();
    const done = floorRecallView(record({ items: [{ source: '#5', storyTime: '第1天', tier: 'full', preview: '旧事' }, { source: '旧档', storyTime: '', tier: 'brief', preview: '更早' }] }));
    expect(done?.phase).toBe('done');
    expect(done?.items.map(i => [i.source, i.tierLabel])).toEqual([['#5', '全文'], ['旧档', '摘要']]);
    expect(done?.statusText).toBe('召回 2 段，已注入本次生成。');
    const skipped = floorRecallView(record({ status: '未召回:检索无候选', items: [{ source: '#5', storyTime: '', tier: 'full', preview: '不该显示' }] }));
    expect(skipped?.items).toEqual([]);
    expect(skipped?.statusText).toBe('未召回：没有检索到相关内容。');
    expect(floorRecallView(record({ status: '失败:超时' }))?.phase).toBe('failed');
  });
});
