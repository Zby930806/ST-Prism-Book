import { describe, expect, it } from 'vitest';
import { RECALL_STOPPED, type RecallDebug, type RecallDebugRerankHit } from './debug';
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

  it('部分段落放不进召回预算：写明注入段数和未注入段数', () => {
    const d = debug({ status: '召回完成', rerank: [hit('a', 'full'), hit('b', 'cut'), hit('c', 'brief'), hit('d', 'drop')] });
    expect(recallButtonLabel(d).text).toBe('召回 2');
    expect(recalledItems(d).map(i => i.preview)).toEqual(['a 的摘要', 'c 的摘要']);
    expect(recallStatusText(d)).toBe('召回 2 段，已注入本次生成。另有 1 段超出召回预算，未注入。');
  });

  it('达标的段落都放不进召回预算：说明原因和设置位置', () => {
    const d = debug({ status: '召回完成:超出注入预算,本回合未注入', rerank: [hit('a', 'cut'), hit('b', 'cut'), hit('c', 'drop')] });
    expect(recallButtonLabel(d).text).toBe('召回 0');
    expect(recallStatusText(d)).toBe('召回完成，达到阈值的 2 段超出召回预算，本次未注入。可在「设置 → 注入设置」中调高「记忆注入预算」，或填 0 不限制。');
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
    const partial = floorRecallView(record({ items: [{ source: '#5', storyTime: '', tier: 'brief', preview: '旧事' }], cut: 2 }));
    expect(partial?.statusText).toBe('召回 1 段，已注入本次生成。另有 2 段超出召回预算，未注入。');
  });

  it('补建索引期间说明剩余条数，并提示可以停止', () => {
    const d = debug({ status: '进行中…', indexPending: 7 });
    expect(recallPhase(d)).toBe('running');
    expect(recallButtonLabel(d).text).toBe('补索引中…');
    expect(recallStatusText(d)).toBe('正在补建向量索引（剩余 7 条），完成后召回并开始生成回复；点酒馆的停止键可以取消。');
    expect(recallStatusText(debug({ status: '进行中…' }))).toContain('点酒馆的停止键可以取消');
  });

  it('停止生成时写明召回随之取消', () => {
    const d = debug({ status: RECALL_STOPPED });
    expect(recallPhase(d)).toBe('skipped');
    expect(recallButtonLabel(d).text).toBe('未召回');
    expect(recallStatusText(d)).toBe('未召回：已停止生成，本次召回随之取消。');
  });

  it('没有重排、索引提示接在完成说明后面；失败原因句末不重复句号', () => {
    const d = debug({
      status: '召回完成', rerank: [hit('a', 'brief')],
      rerankIssue: '未填写 Rerank 模型，已按 embedding 相似度分档，只发送摘要。',
      indexNote: '向量索引还在补建（剩余 3 条），本次先用已建好的部分召回，补建在后台继续。',
    });
    expect(recallStatusText(d)).toBe('召回 1 段，已注入本次生成。未填写 Rerank 模型，已按 embedding 相似度分档，只发送摘要。向量索引还在补建（剩余 3 条），本次先用已建好的部分召回，补建在后台继续。');
    const failed = debug({ status: '失败:Query 重写：请求超时（超过 90 秒）。可以调大超时。', rerankIssue: '不该出现', indexNote: '补建向量索引失败：密钥无效。本次只用已有索引召回。' });
    expect(recallStatusText(failed)).toBe('召回失败：Query 重写：请求超时（超过 90 秒）。可以调大超时。本次生成未注入召回内容。补建向量索引失败：密钥无效。本次只用已有索引召回。');
    expect(recallStatusText(failed)).not.toContain('。。');
  });

  it('楼层面板也显示没有重排的说明', () => {
    const view = floorRecallView(record({ items: [{ source: '#5', storyTime: '', tier: 'brief', preview: '旧事' }], rerankIssue: '重排失败，已按 embedding 相似度分档，只发送摘要。原因：超时。' }));
    expect(view?.statusText).toBe('召回 1 段，已注入本次生成。重排失败，已按 embedding 相似度分档，只发送摘要。原因：超时。');
  });
});
