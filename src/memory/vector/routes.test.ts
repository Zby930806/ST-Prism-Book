import { describe, expect, it } from 'vitest';
import type { VecHit } from '@/api/baibaoku';
import type { LeafForIndex } from './index';
import { fuseRecallRoutes, keywordHits, presentOrderKey, recallEntities } from './routes';

const leaf = (i: number, document: string): LeafForIndex => ({
  leafId: `L${i}`, docHash: '', payloadHash: '', document, mesFull: `原文${i}`, storyTime: `第${i}天`, msgIndex: i,
});
const vec = (leafId: string, similarity: number, document = ''): VecHit => ({
  leafId, scope: 'chat:A', similarity, queryIndex: 0, document, mesFull: null, storyTime: null, msgIndex: null,
});

describe('召回关键词一路', () => {
  it('名字取自名册、物品、地点；去重，太短的和主角、角色卡名字除外', () => {
    const names = recallEntities({
      npcs: [{ name: '洛伊' }, { name: '沈遥' }, { name: '梅' }],
      items: [{ name: '银色罗盘' }, { name: ' 洛伊 ' }],
      scenes: [{ name: '钟塔' }],
    }, ['沈遥']);
    expect(names).toEqual(['洛伊', '银色罗盘', '钟塔']);
  });

  it('只匹配当前对话提到的名字，少见的名字权重更高，同分时新楼在前', () => {
    const leaves = [leaf(1, '洛伊在钟塔下等人。'), leaf(2, '洛伊买了面包。'), leaf(3, '钟塔的钟停了。'), leaf(4, '洛伊和梅芙吵架。')];
    const hits = keywordHits(leaves, ['洛伊', '钟塔', '银色罗盘'], '我们去钟塔找洛伊', 10);
    expect(hits.map(h => h.leaf.leafId)).toEqual(['L1', 'L3', 'L4', 'L2']);
    expect(hits[0].matched).toEqual(['洛伊', '钟塔']);
    expect(keywordHits(leaves, ['银色罗盘'], '我们去钟塔找洛伊', 10)).toEqual([]);
    expect(keywordHits(leaves, ['洛伊'], '洛伊', 2)).toHaveLength(2);
  });

  it('候选够多时，出现在过半摘要里的名字不参与匹配', () => {
    const leaves = Array.from({ length: 12 }, (_, i) => leaf(i, i < 8 ? `洛伊做了第${i}件事。` : `第${i}件事和钟塔有关。`));
    const hits = keywordHits(leaves, ['洛伊', '钟塔'], '洛伊在钟塔', 20);
    expect(hits.every(h => h.matched.every(m => m === '钟塔'))).toBe(true);
    expect(hits).toHaveLength(4);
  });
});

describe('多路融合与在场角色加权', () => {
  it('两路都有的段落加分靠前；只由关键词命中的没有可信相似度', () => {
    const keyword = keywordHits([leaf(7, '洛伊交出罗盘。'), leaf(9, '洛伊离开。')], ['洛伊'], '洛伊', 5);
    const fused = fuseRecallRoutes([vec('L3', 0.9, 'A'), vec('L7', 0.8, '洛伊交出罗盘。')], keyword, 'chat:A', [], 10);
    expect(fused.map(c => [c.leafId, c.route])).toEqual([['L7', 'both'], ['L3', 'vector'], ['L9', 'keyword']]);
    const only = fused.find(c => c.leafId === 'L9')!;
    expect(only).toMatchObject({ similarityKnown: false, similarity: 0, scope: 'chat:A', msgIndex: 9, mesFull: '原文9' });
  });

  it('提到在场角色的候选排序靠前，但不改相似度；rerank 后的加成很小且最多两次', () => {
    const fused = fuseRecallRoutes([vec('L1', 0.9, '梅芙修表。'), vec('L2', 0.85, '洛伊在港口。')], [], 'chat:A', ['洛伊'], 10);
    expect(fused.map(c => c.leafId)).toEqual(['L2', 'L1']);
    expect(fused[0]).toMatchObject({ presentHits: 1, similarity: 0.85 });
    expect(presentOrderKey(0.9, 5)).toBeCloseTo(0.94);
    expect(presentOrderKey(0.9, undefined)).toBe(0.9);
  });

  it('按融合分截取 rerank 候选数', () => {
    const fused = fuseRecallRoutes([vec('A', 0.9), vec('B', 0.8), vec('C', 0.7)], [], 'chat:A', [], 2);
    expect(fused.map(c => c.leafId)).toEqual(['A', 'B']);
  });
});
