import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';

const mocks = vi.hoisted(() => ({
  context: null as unknown as STContext,
  showFloorPanel: true, issue: '', active: true,
}));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/api/settings', () => ({
  apiSettings: { ui: { get showFloorPanel() { return mocks.showFloorPanel; } } },
  engineActiveHere: () => mocks.active,
}));
vi.mock('../store', () => ({ memoryWriteIssue: () => mocks.issue }));
vi.mock('../engine', () => ({
  isRealAiReply: (m: STMessage | undefined) => !!m && !m.is_user && !!m.mes?.trim(),
}));

import { armFloorRecall, attachFloorRecall, beginGenerationRecall, floorRecallFromDebug, readFloorRecall } from './floorRecall';
import { recallDebugWrites, resetRecallDebug, setRecallIndexNote, setRecallRerank, setRecallRerankIssue, setRecallStatus, snapshotRecallDebug } from './debug';

const ai = (mes: string, extra: Record<string, unknown> = {}): STMessage => ({ name: 'AI', is_user: false, is_system: false, mes, extra });
const user = (mes: string): STMessage => ({ name: 'User', is_user: true, is_system: false, mes });

function useChat(id: string, chat: STMessage[]) {
  mocks.context = { chat, chatMetadata: {}, getCurrentChatId: () => id } as unknown as STContext;
}
/** 模拟一次召回:按真实 debug 写法走一遍,最后的状态由参数决定。 */
function fakeRecall(status: string) {
  resetRecallDebug();
  setRecallRerank([
    { leafId: 'a', rerankScore: 0.9, similarity: 0.8, tier: 'full', source: '#3', storyTime: '第1天 夜', preview: '旧事一' },
    { leafId: 'b', rerankScore: 0.2, similarity: 0.1, tier: 'drop', source: '#4', storyTime: '', preview: '没达标' },
    { leafId: 'c', rerankScore: 0.4, similarity: 0.7, tier: 'brief', source: '旧档', storyTime: '', preview: '旧事二' },
  ]);
  setRecallStatus(status);
}
/** 拦截器里的顺序:开始 → 记下写入计数 → 召回 → 登记。 */
function generate(type: string, status: string | null = '召回完成') {
  beginGenerationRecall(type);
  const writes = recallDebugWrites();
  if (status) fakeRecall(status);
  armFloorRecall(type, writes);
}
function reply(chat: STMessage[], mes = '新的回复') {
  chat.push(ai(mes));
  return chat.length - 1;
}

beforeEach(() => {
  mocks.showFloorPanel = true; mocks.issue = ''; mocks.active = true;
  useChat('A', [user('开场'), ai('第一楼')]);
  beginGenerationRecall('normal'); // 清掉上一个用例残留的登记
});

describe('楼层召回记录：读写格式', () => {
  it('只记实际注入的段落，带页码', () => {
    fakeRecall('召回完成');
    const rec = floorRecallFromDebug(snapshotRecallDebug(), 2);
    expect(rec).toMatchObject({ v: 1, swipe: 2, status: '召回完成' });
    expect(rec.items.map(i => [i.source, i.tier, i.preview])).toEqual([['#3', 'full', '旧事一'], ['旧档', 'brief', '旧事二']]);
    expect(rec).not.toHaveProperty('cut');
  });

  it('记下放不进召回预算的段数，读回时保留', () => {
    resetRecallDebug();
    setRecallRerank([
      { leafId: 'a', rerankScore: 0.95, similarity: 0.9, tier: 'brief', downgraded: true, source: '#3', storyTime: '', preview: '改发摘要' },
      { leafId: 'b', rerankScore: 0.92, similarity: 0.9, tier: 'cut', source: '#4', storyTime: '', preview: '放不下' },
    ]);
    setRecallStatus('召回完成');
    const rec = floorRecallFromDebug(snapshotRecallDebug(), 0);
    expect(rec).toMatchObject({ cut: 1, items: [{ source: '#3', tier: 'brief', preview: '改发摘要' }] });
    expect(readFloorRecall(ai('回复', { bbs_recall: rec }))?.cut).toBe(1);
    expect(readFloorRecall(ai('回复', { bbs_recall: { ...rec, cut: -3 } }))).not.toHaveProperty('cut');
  });

  it('记下没有重排和索引方面的说明，读回时保留；非文字或空白的说明丢弃', () => {
    resetRecallDebug();
    setRecallRerank([{ leafId: 'a', rerankScore: 0.9, similarity: 0.9, tier: 'brief', source: '#3', storyTime: '', preview: '旧事', reranked: false }]);
    setRecallRerankIssue('未填写 Rerank 模型，已按 embedding 相似度分档，只发送摘要。');
    setRecallIndexNote('向量索引还在补建（剩余 2 条），本次先用已建好的部分召回，补建在后台继续。');
    setRecallStatus('召回完成');
    const rec = floorRecallFromDebug(snapshotRecallDebug(), 0);
    expect(rec).toMatchObject({ rerankIssue: '未填写 Rerank 模型，已按 embedding 相似度分档，只发送摘要。', indexNote: '向量索引还在补建（剩余 2 条），本次先用已建好的部分召回，补建在后台继续。' });
    const back = readFloorRecall(ai('回复', { bbs_recall: rec }));
    expect(back?.rerankIssue).toBe(rec.rerankIssue);
    expect(back?.indexNote).toBe(rec.indexNote);
    const bad = readFloorRecall(ai('回复', { bbs_recall: { ...rec, rerankIssue: 3, indexNote: '   ' } }));
    expect(bad).not.toHaveProperty('rerankIssue');
    expect(bad).not.toHaveProperty('indexNote');
  });

  it('页码对不上、格式不对时不显示；坏条目跳过', () => {
    const rec = { v: 1, at: 5, swipe: 1, status: '召回完成', items: [{ source: '#3', storyTime: '', tier: 'full', preview: 'x' }, { tier: 'drop' }, { tier: 'brief' }] };
    const m = { ...ai('回复', { bbs_recall: rec }), swipe_id: 1 };
    expect(readFloorRecall(m)?.items).toEqual([
      { source: '#3', storyTime: '', tier: 'full', preview: 'x' },
      { source: '旧档', storyTime: '', tier: 'brief', preview: '' },
    ]);
    expect(readFloorRecall({ ...m, swipe_id: 0 })).toBeNull();
    expect(readFloorRecall(ai('回复', { bbs_recall: { ...rec, v: 2 } }))).toBeNull();
    expect(readFloorRecall(ai('回复', { bbs_recall: { v: 1, swipe: 0, items: [] } }))).toBeNull();
    expect(readFloorRecall(ai('回复'))).toBeNull();
    expect(readFloorRecall(undefined)).toBeNull();
  });
});

describe('楼层召回记录：生成 → 回复的归属（全部本地 mock）', () => {
  it('召回结束后登记，本次回复到达时写入最后一楼，只写一次', () => {
    const chat = mocks.context.chat;
    generate('normal');
    const idx = reply(chat);
    expect(attachFloorRecall(idx, 'normal')).toBe(true);
    expect(readFloorRecall(chat[idx])?.items.length).toBe(2);
    expect(readFloorRecall(chat[1])).toBeNull();
    expect(attachFloorRecall(idx, 'normal')).toBe(false);
  });

  it('召回没跑或还没出结果时不登记', () => {
    const chat = mocks.context.chat;
    generate('normal', null);
    expect(attachFloorRecall(reply(chat), 'normal')).toBe(false);
    beginGenerationRecall('normal');
    const writes = recallDebugWrites();
    resetRecallDebug(); // 只有「进行中…」
    armFloorRecall('normal', writes);
    expect(attachFloorRecall(reply(chat), 'normal')).toBe(false);
  });

  it('没召回、失败也记下，楼层面板可以说明原因', () => {
    const chat = mocks.context.chat;
    generate('swipe', '未召回:楼层未达起召门槛或全在窗口内');
    expect(attachFloorRecall(reply(chat), 'swipe')).toBe(true);
    expect(readFloorRecall(chat[chat.length - 1])).toMatchObject({ status: '未召回:楼层未达起召门槛或全在窗口内', items: [] });
  });

  it('类型不同的消息不消耗登记；quiet 不清登记，下一次正常生成会清', () => {
    const chat = mocks.context.chat;
    generate('normal');
    beginGenerationRecall('quiet');
    expect(attachFloorRecall(reply(chat, '脚本插入'), 'command')).toBe(false);
    expect(attachFloorRecall(reply(chat), 'normal')).toBe(true);
    generate('normal');
    beginGenerationRecall('continue');
    expect(attachFloorRecall(reply(chat), 'normal')).toBe(false);
  });

  it('换了聊天、不是最后一楼、不是 AI 楼时不写', () => {
    generate('normal');
    useChat('B', [user('别的聊天'), ai('别的回复')]);
    expect(attachFloorRecall(1, 'normal')).toBe(false);
    expect(readFloorRecall(mocks.context.chat[1])).toBeNull();

    const chat = mocks.context.chat;
    generate('normal');
    reply(chat);
    expect(attachFloorRecall(1, 'normal')).toBe(false);

    generate('normal');
    chat.push(user('用户楼'));
    expect(attachFloorRecall(chat.length - 1, 'normal')).toBe(false);
  });

  it('楼层面板关着、数据保护或插件在当前聊天停用时不写', () => {
    const chat = mocks.context.chat;
    for (const block of [() => { mocks.showFloorPanel = false; }, () => { mocks.issue = '保护'; }, () => { mocks.active = false; }]) {
      mocks.showFloorPanel = true; mocks.issue = ''; mocks.active = true;
      generate('normal');
      block();
      const idx = reply(chat);
      expect(attachFloorRecall(idx, 'normal')).toBe(false);
      expect(chat[idx].extra?.bbs_recall).toBeUndefined();
    }
  });

  it('记录跟着 swipe 页码走', () => {
    const chat = mocks.context.chat;
    generate('swipe');
    chat[1].swipe_id = 2;
    expect(attachFloorRecall(1, 'swipe')).toBe(true);
    expect(readFloorRecall(chat[1])?.swipe).toBe(2);
    chat[1].swipe_id = 1;
    expect(readFloorRecall(chat[1])).toBeNull();
  });
});
