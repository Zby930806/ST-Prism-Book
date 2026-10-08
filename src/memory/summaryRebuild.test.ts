import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as engine from './engine';
import { buildStateInjectionText } from './inject';
import { createNewChatWithCarryover } from './carryover';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { batchBackfill, cancelBatchBackfill, currentSummaryPromise, engineState, regenerateFloor } from './engine';
import { classifyNpcPresence, deriveMemory, editPlan, planContentById } from './apply';
import { memory, recomputeDerived, flushLeavesNow } from './store';
import { createEmptyMemory, type SummaryDelta, type LeafExtra } from './types';

const saved = JSON.stringify(settings.apiSettings);
const msg = (text: string, old = false): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text,
  extra: old ? { bbs_leaf: { id: text, text: '旧摘要', delta: {}, createdAt: 1, swipe: 0, v: 1 } } : {} });
function useChat(chat: STMessage[]) {
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'rebuild-test',
    chatMetadata: {}, saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
function response(summary: string, delta: SummaryDelta = {}) {
  return JSON.stringify({ summary, ...delta, stateChanges: Object.keys(delta).filter(k => !['time', 'timeStart', 'timeEnd'].includes(k)) });
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(response('新摘要。'));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('逐楼完整重建的生产入口', () => {
  it('五楼借图回归：状态进入后楼，闪回不改伤势，还图闭合物品和计划', async () => {
    const chat = ['借图与约定', '前往广场', '三年前的回忆', '返回但小A不在', '次晨还图结账，小A说仍需休养四五天'].map(t => msg(t, true));
    chat[0].mes = '小A在厨房借图与约定。';
    chat[4].mes = '次晨小A在厨房收回地图，说仍需休养四五天。';
    useChat(chat);
    const responses = [
      response('小A借图，约定明晚八点归还；小B同行。', { timeEnd: '2031/4/12 19:10', location: '厨房',
        npcs: { add: [{ name: '小A', location: '厨房', locationEvidence: '小A在厨房借图与约定。', condition: '右腕受伤', follow: false }, { name: '小B', follow: true }] },
        items: { add: [{ name: '地图', qty: 1, carried: true }] }, plans: { add: [{ kind: 'plan', content: '归还地图', targetTime: '2031/4/13 20:00' }] } }),
      response('林舟与小B到广场等待，没有进入水渠。', { location: '广场', timeEnd: '2031/4/12 19:40' }),
      response('林舟想起2028年的借册往事；当前仍在广场，地图未还。', { timeEnd: '2031/4/12 19:55' }),
      response('守卫增多，两人撤回厨房，小A未在场。', { location: '厨房', timeEnd: '2031/4/12 21:00' }),
      response('次晨小A验收地图、账目结清；她仍需养伤，拒绝同行。', { timeEnd: '2031/4/13 08:00',
        npcs: { update: [{ name: '小A', location: '厨房', locationEvidence: '次晨小A在厨房收回地图', follow: false, conditionPatch: { add: [{ text: '仍需休养四五天', evidence: '仍需休养四五天' }] } }] },
        items: { remove: ['地图'] }, plans: { resolve: [{ id: 'p1', outcome: 'done', reason: '已验收结账' }] } }),
    ];
    let i = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (i === 1) expect(messages.map(m => m.content).join(' ')).toContain('归还地图');
      if (i === 4) {
        const before = deriveMemory(chat, 4);
        expect(before.npcs[0].condition).toBe('右腕受伤');
        expect(classifyNpcPresence(before.npcs[0], before.scenes, before.state.location, before.state.locationPath)).toBe('unknown');
        expect(messages.map(m => m.content).join(' ')).toContain('p1');
      }
      return responses[i++];
    });
    expect(await batchBackfill({ regenerate: true })).toEqual({ done: 5, total: 5, cancelled: false });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(5);
    const st = deriveMemory(chat);
    expect(st.npcs.find(n => n.name === '小A')).toMatchObject({ location: '厨房', follow: false, condition: '右腕受伤；仍需休养四五天', locationStale: false });
    expect(st.npcs.find(n => n.name === '小B')?.follow).toBe(true);
    expect(st.items.find(x => x.name === '地图')).toBeUndefined();
    expect(st.plans).toHaveLength(1);
    expect(st.plans[0]).toMatchObject({ status: 'resolved', outcome: 'done', resolvedReason: '已验收结账' });
    expect(chat[0].extra?.bbs_leaf).toMatchObject({ id: '借图与约定', createdAt: 1 });
    expect(chat.every(m => m.extra?.bbs_leaf?.text !== '旧摘要')).toBe(true);
  });
  it('超长首答带纠错重试，保持 assistant 预填最后，不截断存储', async () => {
    settings.apiSettings.summaryMaxRetries = 1;
    const chat = [msg('原文', true)]; useChat(chat);
    vi.mocked(client.requestViaMainApi).mockResolvedValueOnce(response('长'.repeat(301))).mockResolvedValueOnce(response('压缩后的完整短句。'));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 1 });
    const retry = vi.mocked(client.requestViaMainApi).mock.calls[1][0];
    expect(retry.at(-1)?.role).toBe('assistant');
    expect(retry.at(-2)?.content).toContain('超过 300 字符');
    expect(retry.some(m => m.content.includes('长'.repeat(301)))).toBe(false);
    expect(chat[0].extra?.bbs_leaf?.text).toBe('压缩后的完整短句。');
  });
  it('失败保留旧叶子和旧上层总结，停止后续楼层', async () => {
    const chat = [msg('一', true), msg('二', true)]; useChat(chat);
    memory.summaries.push({ id: 'old-l1', text: '旧上层总结', level: 1, auto: false, childIds: ['一', '二'], createdAt: 0 });
    const oldSummaries = JSON.stringify(memory.summaries);
    const before = JSON.stringify(chat);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('长'.repeat(301)));
    expect(await batchBackfill({ regenerate: true })).toEqual({ done: 0, total: 2, cancelled: false });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(chat)).toBe(before);
    expect(JSON.stringify(memory.summaries)).toBe(oldSummaries);
    expect(engineState.lastError).toContain('超过 300');
  });
  it('取消在楼层边界生效，保留已成功结果和未处理旧叶子', async () => {
    const chat = [msg('一', true), msg('二', true)]; useChat(chat);
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => { cancelBatchBackfill(); return response('第一楼新摘要。'); });
    expect(await batchBackfill({ regenerate: true })).toEqual({ done: 1, total: 2, cancelled: true });
    expect(chat[0].extra?.bbs_leaf?.text).toBe('第一楼新摘要。');
    expect(chat[1].extra?.bbs_leaf?.text).toBe('旧摘要');
  });
  it.each(['chat', 'body', 'swipe', 'user'] as const)('请求中变更 %s 时拒绝落盘', async kind => {
    const user = { ...msg('用户原文'), is_user: true };
    const chat = [user, msg('原文', true)]; const ctx = useChat(chat);
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      if (kind === 'chat') vi.mocked(context.getContext).mockReturnValue({ ...ctx, chat: [], getCurrentChatId: () => 'other' });
      if (kind === 'body') chat[1].mes = '改写';
      if (kind === 'swipe') chat[1].swipe_id = 1;
      if (kind === 'user') user.mes = '用户改写';
      return response('不应写入。');
    });
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 0 });
    expect(chat[1].extra?.bbs_leaf?.text).toBe('旧摘要');
    expect(engineState.lastError).toContain('发生变化');
  });
  it('重建跳过继承种子，不抹掉跨聊天状态', async () => {
    const seed = msg('继承', true);
    (seed.extra!.bbs_leaf as LeafExtra).seed = true;
    const chat = [seed, msg('后文', true)]; useChat(chat);
    const before = JSON.stringify(seed);
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 1, total: 1 });
    expect(JSON.stringify(seed)).toBe(before);
  });
  it('重建成功使旧上层总结失效，导入历史保持原样', async () => {
    const chat = [msg('导入原文'), msg('当前', true)]; useChat(chat);
    memory.summaries.push(
      { id: 'import', text: '导入的历史', level: 1, auto: false, childIds: [], imported: true, importedFloorStart: 0, importedFloorEnd: 0, createdAt: 0 },
      { id: 'old-l1', text: '过时总结', level: 1, auto: false, childIds: ['当前'], createdAt: 0 },
    );
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 1, total: 1 });
    expect(chat[0].extra?.bbs_leaf).toBeUndefined();
    expect(memory.summaries.some(s => s.id === 'old-l1')).toBe(false);
    expect(memory.summaries.some(s => s.id === 'import')).toBe(true);
  });
  it('错误合同耗尽有限重试，保留旧数据而非只保存摘要', async () => {
    settings.apiSettings.summaryMaxRetries = 1;
    const chat = [msg('原文', true)]; useChat(chat);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '小A重新出现在厨房。' }));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 0 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(chat[0].extra?.bbs_leaf?.text).toBe('旧摘要');
    expect(engineState.lastError).toContain('stateChanges');
  });
  it('整个批量操作可被生成拦截器等待，避免摘要和新正文并行', async () => {
    const chat = [msg('一'), msg('二')]; useChat(chat);
    let finish!: (v: string) => void;
    vi.mocked(client.requestViaMainApi).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const job = batchBackfill();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const pending = currentSummaryPromise();
    expect(pending).not.toBeNull();
    let settled = false;
    void pending?.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    finish(response('一完成。'));
    await job; await pending;
    expect(settled).toBe(true);
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
  });
});

// 故意让模型漏掉旧限制，验证正式入口会拒绝而不是靠 mock 返回完整旧伤情。
describe('v0.7 伤情补丁的生产链', () => {
  function fixture() {
    const seed = msg('小A此前手腕受伤，爬不了沉降井。', true);
    seed.extra!.bbs_leaf = { ...seed.extra!.bbs_leaf!, seed: true, delta: { npcs: { add: [{ name: '小A', condition: '手腕受伤，爬不了沉降井' }] } } };
    const chat = [seed, msg('小A说：“还需休养四五天。”', true)];
    useChat(chat); return chat;
  }
  const patchResponse = () => response('小A自述还需休养四五天。', { npcs: { update: [{ name: '小A', conditionPatch: { add: [{ text: '自述还需休养四五天', evidence: '还需休养四五天' }] } }] } });
  it('原样覆盖丢失触发有限纠错，未重新输出旧限制也保留它', async () => {
    const chat = fixture(); settings.apiSettings.summaryMaxRetries = 1;
    vi.mocked(client.requestViaMainApi)
      .mockResolvedValueOnce(response('她仍需养伤。', { npcs: { update: [{ name: '小A', condition: '自述还需休养四五天' }] } }))
      .mockResolvedValueOnce(patchResponse());
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 1 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    const second = vi.mocked(client.requestViaMainApi).mock.calls[1][0];
    expect(second.at(-2)?.content).toContain('conditionPatch');
    expect(second.at(-1)?.role).toBe('assistant');
    expect(second.map(m => m.content).join(' ')).toContain('"id":"c2","text":"爬不了沉降井"');
    expect(deriveMemory(chat).npcs[0].condition).toBe('手腕受伤，爬不了沉降井；自述还需休养四五天');
    expect(JSON.stringify(chat[1].extra!.bbs_leaf)).not.toContain('conditionPatch');
    expect(JSON.stringify(chat[1].extra!.bbs_leaf)).not.toContain('evidence');
  });
  it('纠错耗尽不写坏状态、不继续后楼', async () => {
    const chat = fixture(); chat.push(msg('下一楼', true)); const before = JSON.stringify(chat);
    settings.apiSettings.summaryMaxRetries = 1;
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('省略了旧限制。', { npcs: { update: [{ name: '小A', condition: '还需休养' }] } }));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 0 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat)).toBe(before);
    expect(engineState.lastError).toContain('conditionPatch');
  });
  it('单楼重摘和连续重建均用楼前旧状态，不叠加当前叶子的休养估计', async () => {
    const chat = fixture();
    vi.mocked(client.requestViaMainApi).mockResolvedValue(patchResponse());
    expect(await regenerateFloor(1)).toBe(true);
    const first = deriveMemory(chat).npcs[0].condition;
    await batchBackfill({ regenerate: true });
    await batchBackfill({ regenerate: true });
    expect(deriveMemory(chat).npcs[0].condition).toBe(first);
    expect(first?.match(/四五天/g)).toHaveLength(1);
  });
  it('新增未来伤情不会泄漏进重摘早楼的局部编号', async () => {
    const chat = fixture();
    const future = msg('之后手臂受伤。', true);
    future.extra!.bbs_leaf!.delta = { npcs: { update: [{ name: '小A', condition: '手臂受伤，不能抬举' }] } };
    chat.push(future);
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      const protocol = messages.find(m => m.content.startsWith('【伤情局部更新协议】'))?.content;
      expect(protocol).toContain('爬不了沉降井'); expect(protocol).not.toContain('不能抬举');
      return patchResponse();
    });
    expect(await regenerateFloor(1)).toBe(true);
    expect(chat[1].extra!.bbs_leaf!.delta.npcs?.update?.[0].condition).toContain('爬不了沉降井');
  });
});


describe('v0.8 NPC定位证据的生产链', () => {
  function fixture() {
    const seed = msg('早晨小A在归雁客栈厨房，右腕缠绷带。', true);
    seed.extra!.bbs_leaf = { ...seed.extra!.bbs_leaf!, seed: true, delta: {
      time: '2031/4/13 08:00', location: '归雁客栈',
      npcs: { add: [{ name: '小A', location: '归雁客栈', condition: '右腕受伤，爬不了沉降井' }, { name: '小B', follow: true }] },
    } };
    const chat = [seed, msg('林舟与小B来到南门。小A没有同行，暂时没有她的新消息。小B赠送铜哨，林舟收下。', true)];
    useChat(chat); return chat;
  }
  const good = () => response('林舟与小B到南门，小B赠予铜哨；小A未同行，暂无新消息。', {
    timeEnd: '2031/4/13 08:35', location: '南门', items: { add: [{ name: '铜哨', qty: 1, carried: true }] },
  });
  it('真实错误形态触发纠错，旧位置不刷新，伤势不丢，重摘不重复物品', async () => {
    const chat = fixture(); settings.apiSettings.summaryMaxRetries = 1;
    const previous = deriveMemory(chat, 1).npcs[0].lastKnownLocation;
    vi.mocked(client.requestViaMainApi)
      .mockResolvedValueOnce(response('小A仍在归雁客栈。', { location: '南门', npcs: { update: [{ name: '小A', location: '归雁客栈' }] } }))
      .mockResolvedValueOnce(good());
    expect(await regenerateFloor(1)).toBe(true);
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.requestViaMainApi).mock.calls[1][0].at(-2)?.content).toContain('locationEvidence');
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ locationStale: true, lastKnownLocation: previous, condition: '右腕受伤，爬不了沉降井' });
    expect(chat[1].extra!.bbs_leaf!.delta.npcs).toBeUndefined();
    vi.mocked(client.requestViaMainApi).mockResolvedValue(good());
    expect(await regenerateFloor(1)).toBe(true);
    expect(deriveMemory(chat).items.filter(x => x.name === '铜哨')).toHaveLength(1);
    expect(deriveMemory(chat).items[0].qty).toBe(1);
    expect(deriveMemory(chat).npcs[0].lastKnownLocation).toEqual(previous);
    expect(JSON.stringify(chat[1])).not.toContain('locationEvidence');
  });
  it('旧历史引文不能充当本楼证据，耗尽后保留旧叶子并停止后楼', async () => {
    const chat = fixture(); chat.push(msg('后续楼', true)); const before = JSON.stringify(chat);
    settings.apiSettings.summaryMaxRetries = 1;
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('小A仍在客栈。', { npcs: { update: [{ name: '小A', location: '归雁客栈', locationEvidence: '早晨小A在归雁客栈厨房' }] } }));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 0 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat)).toBe(before);
    expect(engineState.lastError).toContain('locationEvidence');
  });
  it('本轮明确重逢可以恢复确认，临时引文不写入叶子或正文', async () => {
    const chat = fixture(); chat[1].mes = '午后林舟在菜市遇到小A。';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('林舟在菜市与小A重逢。', {
      timeEnd: '2031/4/13 14:00', location: '菜市', npcs: { update: [{ name: '小A', location: '菜市', locationEvidence: '林舟在菜市遇到小A' }] },
    }));
    expect(await regenerateFloor(1)).toBe(true);
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ location: '菜市', locationStale: false, lastKnownLocation: { place: '菜市', time: '2031/4/13 14:00', leafId: chat[1].extra!.bbs_leaf!.id } });
    expect(JSON.stringify(chat)).not.toContain('locationEvidence');
  });
  it('自定义旧模板经正式入口仍能直接定位，不隐式强制新协议', async () => {
    const chat = fixture(); settings.apiSettings.prompts.summary = '自定义摘要 {{content}}';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('旧模板位置。', { npcs: { update: [{ name: '小A', location: '菜市' }] } }));
    expect(await regenerateFloor(1)).toBe(true);
    expect(deriveMemory(chat).npcs[0].location).toBe('菜市');
  });
});


describe('v0.9 交易方向与未知余额的正式入口', () => {
  const body = '主角从钱袋取出三张交易凭证支付给向导，对方收下。文中没有说明钱袋总数或剩余数量。';
  const bad = () => response('主角支付三张交易凭证。', { items: { add: [{ name: '交易凭证', desc: '已付出三张，余额未知', carried: true }] } });
  it('真实缺数量的错账响应进入有限纠错，付款留摘要而不造库存', async () => {
    const chat = [msg(body, true)]; useChat(chat); settings.apiSettings.summaryMaxRetries = 1;
    vi.mocked(client.requestViaMainApi).mockResolvedValueOnce(bad()).mockResolvedValueOnce(response('主角已付三张交易凭证，剩余数量未交代。'));
    expect(await regenerateFloor(0)).toBe(true);
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.requestViaMainApi).mock.calls[1][0].at(-2)?.content).toContain('qty');
    expect(deriveMemory(chat).items).toEqual([]);
    expect(chat[0].mes).not.toContain('获得');
    expect(chat[0].extra!.bbs_leaf!.text).toContain('已付三张');
    expect(chat[0].extra!.bbs_leaf!.delta.items).toBeUndefined();
  });
  it('无有效数量且纠错耗尽时不落盘、不生成获得旁注', async () => {
    const chat = [msg(body, true)]; useChat(chat); const before = JSON.stringify(chat);
    settings.apiSettings.summaryMaxRetries = 1; vi.mocked(client.requestViaMainApi).mockResolvedValue(bad());
    expect(await regenerateFloor(0)).toBe(false);
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat)).toBe(before);
    expect(engineState.lastError).toContain('qty');
  });
  it('已知余额转出使用新余额，之后获得同类物品仅加本次增量，重摘不重复', async () => {
    const seed = msg('原有十枚筹码。', true);
    seed.extra!.bbs_leaf = { ...seed.extra!.bbs_leaf!, seed: true, delta: { items: { add: [{ name: '筹码', qty: 10 }] } } };
    const chat = [seed, msg('支付四枚筹码。', true), msg('收到两枚筹码。', true)]; useChat(chat);
    vi.mocked(client.requestViaMainApi).mockResolvedValueOnce(response('付出四枚，剩六枚。', { items: { update: [{ name: '筹码', qty: 6 }] } }))
      .mockResolvedValueOnce(response('新收到两枚。', { items: { add: [{ name: '筹码', qty: 2 }] } }));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 2 });
    expect(deriveMemory(chat).items[0].qty).toBe(8);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('新收到两枚。', { items: { add: [{ name: '筹码', qty: 2 }] } }));
    expect(await regenerateFloor(2)).toBe(true);
    expect(deriveMemory(chat).items[0].qty).toBe(8);
  });
});


// 不调用模型。响应夹具验证的是正式请求、解析、写回、重放和幂等，不证明模型语义理解。
describe('v0.10 跨题材正式重建合同（预设模型响应）', () => {
  const routes = [
    { name: '科幻分段通行', place: '轨道实验站', next: '正向南前往货运走廊，所属区域未确认',
      desc: '设有实验舱和维修台的科研设施。', text: '旅行者从轨道实验站向东走，随后朝南面的货运走廊出发，尚在途中。',
      summary: '旅行者离开轨道实验站，先向东行，随后向南前往货运走廊，尚未抵达。' },
    { name: '现代远望与归属', place: '市立展馆', next: '前往远处仓库途中，具体所属未明',
      desc: '设有常设展厅与接待柜台。', text: '旅行者离开展馆，从桥边望见河对岸仓库，随后出发前往那里。',
      summary: '旅行者离开展馆，从桥边看见河对岸仓库后向那里出发，尚未抵达。' },
    { name: '奇幻相对参照', place: '山顶书院', next: '石柱右侧的岔道途中，所属区域未确认',
      desc: '设有藏书楼与讲堂的书院。', text: '旅行者离开山顶书院，到石柱处向右转入岔道。',
      summary: '旅行者离开山顶书院，到石柱处向右转入岔道。' },
  ];
  it.each(routes)('$name：未知路径清旧锚点、旧NPC位置过期而伤情不丢、重摘不重复结算', async test => {
    const seed = msg('此前状态', true);
    seed.extra!.bbs_leaf = { ...seed.extra!.bbs_leaf!, seed: true, delta: {
      location: test.place, locationPath: [test.place],
      scenes: { add: [{ path: [test.place], desc: test.desc }] },
      npcs: { add: [{ name: '同伴甲', location: test.place, condition: '手臂受伤；暂不能提重物' }] },
      items: { add: [{ name: '补给剂', qty: 4 }] },
    } };
    const chat = [seed, msg(test.text + '旅行者使用了一份补给剂，还剩三份。', true)];
    const ctx = useChat(chat); ctx.name1 = '旅行者';
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      expect(system).toContain('分段移动按先后保留');
      expect(system).toContain('完整是指已证实的父子链,不是补齐世界地图');
      expect(system).toContain('只消耗其中一件不等于清空整组');
      return response(test.summary, { location: test.next, locationPath: [], items: { update: [{ name: '补给剂', qty: 3 }] } });
    });
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 1 });
    await regenerateFloor(1);
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2);
    const st = deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(st.state.location).toBe(test.next);
    expect(st.state.locationPath ?? []).toEqual([]);
    expect(st.scenes).toHaveLength(1);
    expect(st.scenes[0].desc).toBe(test.desc);
    expect(st.items.find(x => x.name === '补给剂')?.qty).toBe(3);
    const npc = st.npcs.find(x => x.name === '同伴甲')!;
    expect(npc.condition).toBe('手臂受伤；暂不能提重物');
    expect(classifyNpcPresence(npc, st.scenes, st.state.location, st.state.locationPath)).toBe('unknown');
    expect(chat[1].extra?.bbs_leaf?.text).toBe(test.summary);
  });
  it('寄存与取回仅改保管状态，未知付款不造币，NPC互赠不入主角账', async () => {
    const seed = msg('此前持有相机', true);
    seed.extra!.bbs_leaf = { ...seed.extra!.bbs_leaf!, seed: true, delta: { items: { add: [{ name: '相机', qty: 1 }] } } };
    const chat = [seed, msg('旅行者把相机寄存在展馆柜台，支付三枚代币但未说明余额。店员把一支笔送给同事。', true),
      msg('旅行者取回自己的相机。', true)];
    const ctx = useChat(chat); ctx.name1 = '旅行者';
    vi.mocked(client.requestViaMainApi)
      .mockResolvedValueOnce(response('旅行者付三枚代币将相机寄存在展馆柜台；店员向同事赠笔。', {
        items: { update: [{ name: '相机', carried: false, location: '展馆柜台' }] } }))
      .mockResolvedValueOnce(response('旅行者取回寄存的相机。', { items: { update: [{ name: '相机', carried: true }] } }));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 2 });
    const stored = deriveMemory(chat, 2).items.find(x => x.name === '相机');
    expect(stored).toMatchObject({ qty: 1, carried: false, location: '展馆柜台' });
    const st = deriveMemory(JSON.parse(JSON.stringify(chat)));
    expect(st.items).toHaveLength(1);
    expect(st.items[0]).toMatchObject({ name: '相机', qty: 1, carried: true });
    expect(chat[1].mes + chat[2].mes).not.toMatch(/获得 相机/);
  });
});


describe('v0.10 空路径实际保存与继承消费', () => {
  it('正式重摘保存的JSON经重放、正文注入和新聊天种子均不误认目的地', async () => {
    const seed = msg('此前在档案馆寄存相机。', true);
    seed.extra!.bbs_leaf = { ...seed.extra!.bbs_leaf!, seed: true, delta: {
      location: '档案馆', locationPath: ['档案馆'],
      scenes: { add: [{ path: ['档案馆'], desc: '设有文献阅览室。' }] },
      items: { add: [{ name: '相机', qty: 1, carried: false, location: '档案馆' }] },
    } };
    const chat = [seed, msg('旅行者正在前往档案馆，尚未抵达。', true)];
    const ctx = useChat(chat); ctx.name1 = '旅行者';
    const saves: string[] = [];
    vi.mocked(ctx.saveChat).mockImplementation(async () => { saves.push(JSON.stringify(ctx.chat)); });
    Object.assign(settings.apiSettings.injection, { scenes: true, items: true });
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('旅行者前往档案馆，尚在途中。', {
      location: '前往档案馆途中', locationPath: [], scenes: { update: [{ path: ['档案馆'], desc: '' }] },
    }));
    expect(await regenerateFloor(1), engineState.lastError ?? '').toBe(true);
    flushLeavesNow();
    const saved = JSON.parse(saves.at(-1)!);
    expect(saved[1].extra.bbs_leaf.delta.locationPath).toEqual([]);
    expect(deriveMemory(saved).state.locationPath).toEqual([]);
    expect(deriveMemory(saved).scenes).toHaveLength(1);
    expect(deriveMemory(saved).scenes[0].desc).toBeUndefined();
    const injected = buildStateInjectionText();
    expect(injected.split('他处寄存物品')[0]).not.toContain('相机');
    expect(injected.split('他处寄存物品')[1]).toContain('相机');
    vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(chat.length);
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { ctx.chat = []; });
    expect(await createNewChatWithCarryover()).toBe(true);
    const carried = JSON.parse(saves.at(-1)!);
    expect(carried[0].extra.bbs_leaf.seed).toBe(true);
    expect(carried[0].extra.bbs_leaf.delta.locationPath).toEqual([]);
    expect(deriveMemory(carried).state.locationPath).toEqual([]);
    expect(deriveMemory(carried).scenes).toHaveLength(1);
    expect(deriveMemory(carried).scenes[0].desc).toBeUndefined();
    expect(buildStateInjectionText().split('他处寄存物品')[0]).not.toContain('相机');
  });
});


describe('v0.11 离场伤势从模型协议到正文消费者', () => {
  it('跨题材模拟完整重建：新增限制与局部恢复保存重放后仍可见，未变部分不丢', async () => {
    // 模拟的是模型响应和持久化链路，不证明真实模型理解。
    const chat = [msg('岑岚在基地医务室接受诊治，左腿骨折，不能负重。', true),
      msg('旅行者驶离基地，进入外海航线。岑岚通过无线电说还需休养两周。', true),
      msg('两周后，岑岚通过无线电转述医生复查结果：左腿骨折已愈合，已可短距离行走。', true)];
    const ctx = useChat(chat); ctx.name1 = '旅行者';
    Object.assign(settings.apiSettings.injection, { scenes: true, npcs: true });
    settings.apiSettings.memoryBudgetTokens = 6000;
    const saves: string[] = [];
    vi.mocked(ctx.saveChat).mockImplementation(async () => { saves.push(JSON.stringify(ctx.chat)); });
    const responses = [
      response('岑岚左腿骨折，不能负重，在医务室诊治。', { timeEnd: '2042/5/6 10:00', location: '医务室',
        npcs: { add: [{ name: '岑岚', location: '医务室', locationEvidence: '岑岚在基地医务室接受诊治', condition: '左腿骨折；不能负重', follow: false }] } }),
      response('旅行者驶入外海；岑岚通过无线电自述还需休养两周。', { location: '外海航线', locationPath: [],
        npcs: { update: [{ name: '岑岚', conditionPatch: { add: [{ text: '自述还需休养两周', evidence: '岑岚通过无线电说还需休养两周' }] } }] } }),
      response('岑岚通过无线电转述复查结果：左腿骨折已愈合，已可短距离行走。', { timeEnd: '2042/5/20 10:00',
        npcs: { update: [{ name: '岑岚', conditionPatch: { replace: [
          { id: 'c1', text: '据其转述复查结果左腿骨折已愈合', evidence: '岑岚通过无线电转述医生复查结果：左腿骨折已愈合' },
          { id: 'c2', text: '据其转述已可短距离行走', evidence: '已可短距离行走' },
          { id: 'c3', text: '', evidence: '岑岚通过无线电转述医生复查结果：左腿骨折已愈合，已可短距离行走' },
        ] } }] } }),
    ];
    let i = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (i === 2) {
        const before = deriveMemory(chat, 2);
        expect(before.npcs[0].condition).toBe('左腿骨折；不能负重；自述还需休养两周');
        expect(messages.map(m => m.content).join(' ')).toContain('不能负重');
        expect(buildStateInjectionText()).toContain('身体状态(最后记录):左腿骨折；不能负重；自述还需休养两周');
      }
      return responses[i++];
    });
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 3 });
    flushLeavesNow();
    const stored = JSON.parse(saves.at(-1)!);
    const st = deriveMemory(stored);
    expect(st.npcs[0].condition).toBe('据其转述复查结果左腿骨折已愈合；据其转述已可短距离行走');
    expect(classifyNpcPresence(st.npcs[0], st.scenes, st.state.location, st.state.locationPath)).toBe('unknown');
    expect(JSON.stringify(stored)).not.toMatch(/conditionPatch|locationEvidence/);
    const injected = buildStateInjectionText();
    expect(injected).toContain('身体状态(最后记录):据其转述复查结果左腿骨折已愈合；据其转述已可短距离行走');
    expect(injected).not.toContain('不能负重');
    expect(injected).not.toContain('自述还需休养两周');
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(3);
  });
});

// 本组替换模型与宿主保存接口，只证明正式协议/存储/消费者链，不证明实模语义。
describe('v0.12 计划调整贯穿重建、注入与继承', () => {
  it('同一事项暂缓不重复新增，清除旧期限并将条件保留到新聊天', async () => {
    const chat = [msg('观测员约好周四校准仪器。', true), msg('校准暂缓，等供电恢复后另定日期。', true)];
    const ctx = useChat(chat); ctx.name1 = '观测员';
    settings.apiSettings.memoryBudgetTokens = 6000;
    const saves: string[] = [];
    vi.mocked(ctx.saveChat).mockImplementation(async () => { saves.push(JSON.stringify(ctx.chat)); });
    let request = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      const input = messages.map(m => m.content).join(' ');
      expect(input).toContain('plans.update');
      if (request++ === 0) return response('观测员约好周四校准仪器。', {plans:{add:[{kind:'plan',content:'观测员校准仪器',targetTime:'周四'}]}});
      expect(input).toContain('p1'); expect(input).toContain('观测员校准仪器');
      return response('校准暂缓，待供电恢复后另定日期。', {plans:{update:[{id:'p1',content:'观测员暂缓校准仪器，待供电恢复后另定日期',targetTime:''}]}});
    });
    expect(await batchBackfill({regenerate:true})).toMatchObject({done:2});
    flushLeavesNow();
    const stored = JSON.parse(saves.at(-1)!);
    const st = deriveMemory(stored);
    expect(st.plans).toHaveLength(1);
    expect(st.plans[0]).toMatchObject({status:'open',content:'观测员暂缓校准仪器，待供电恢复后另定日期'});
    expect(st.plans[0].targetTime).toBeUndefined();
    expect(stored[1].extra.bbs_leaf.delta.plans.update[0].id).toBe(st.plans[0].id);
    expect(buildStateInjectionText()).toContain('待供电恢复后另定日期');
    expect(buildStateInjectionText()).not.toContain('周四');
    vi.spyOn(engine,'resolveKeepStart').mockReturnValue(chat.length);
    vi.spyOn(context,'getDoNewChat').mockResolvedValue(async () => {ctx.chat=[];});
    expect(await createNewChatWithCarryover()).toBe(true);
    const carried=deriveMemory(JSON.parse(saves.at(-1)!));
    expect(carried.plans).toHaveLength(1);
    expect(carried.plans[0].content).toBe(st.plans[0].content);
    expect(carried.plans[0].targetTime).toBeUndefined();
    expect(buildStateInjectionText()).toContain('待供电恢复后另定日期');
  });
  it('方案明确被替代后旧方案结案，新目标不冒充已完成', async () => {
    const chat=[msg('考察组决定三日后从山道运输设备。',true),msg('考察组放弃山道方案，决定待船修好后走水路。',true)];
    useChat(chat); let i=0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => i++ === 0
      ? response('考察组决定三日后从山道运输设备。',{plans:{add:[{kind:'plan',content:'考察组从山道运输设备'}]}})
      : response('考察组放弃山道运输，决定待船修好后走水路。',{plans:{resolve:[{id:'p1',outcome:'cancelled',reason:'明确放弃山道方案，改用水路'}],add:[{kind:'plan',content:'考察组待船修好后走水路运输设备'}]}}));
    expect(await batchBackfill({regenerate:true})).toMatchObject({done:2});
    const plans=deriveMemory(JSON.parse(JSON.stringify(chat))).plans;
    expect(plans.find(p=>p.content==='考察组从山道运输设备')).toMatchObject({status:'resolved',outcome:'cancelled'});
    expect(plans.filter(p=>p.status==='open').map(p=>p.content)).toEqual(['考察组待船修好后走水路运输设备']);
    const active=buildStateInjectionText().split('未了结的计划/悬念:')[1].split('近期已了结')[0];
    expect(active).toContain('待船修好'); expect(active).not.toContain('山道');
  });
});

describe('v0.12 计划变更的现有手工消费者', () => {
  it('后续调整存在时编辑当前计划不会被旧update覆盖，楼内查询不泄漏未来', async () => {
    const chat=[msg('筹备演出。'),msg('暂缓演出。')]; useChat(chat);
    let i=0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async()=>i++===0
      ? response('演出定于周五。',{plans:{add:[{kind:'plan',content:'筹备演出',targetTime:'周五',createdTime:'周一'}]}})
      : response('演出暂缓，待设备修好。',{plans:{update:[{id:'p1',content:'暂缓演出，待设备修好',targetTime:''}]}}));
    expect(await batchBackfill({regenerate:true})).toMatchObject({done:2});
    const id=deriveMemory(chat).plans[0].id;
    expect(planContentById(id)).toBe('暂缓演出，待设备修好');
    expect(planContentById(id,1)).toBe('筹备演出');
    expect(editPlan(id,{content:'暂缓演出，待更换设备',targetTime:'周日',createdTime:'周二'})).toBe(true);
    const plan=deriveMemory(JSON.parse(JSON.stringify(chat))).plans[0];
    expect(plan).toMatchObject({content:'暂缓演出，待更换设备',targetTime:'周日',createdTime:'周二'});
    expect(chat[0].extra?.bbs_leaf?.delta.plans?.add?.[0].content).toBe('筹备演出');
    expect(editPlan(id,{content:'  '})).toBe(false);
  });
});

// 伤情证据与有限纠错：经正式补录/重摘入口验证落盘和保护，而非只测 helper。
describe('伤情排版证据与失败恢复生产链', () => {
  function fixture() {
    const seed = msg('此前岑岚右腕受伤，不能负重。', true);
    seed.extra!.bbs_leaf!.seed = true;
    seed.extra!.bbs_leaf!.delta = { npcs: { add: [{ name: '岑岚', condition: '右腕受伤，不能负重' }] } };
    const chat = [seed, msg('岑岚说：“**右腕仍需休养**\n三天。”')];
    useChat(chat); return chat;
  }
  const valid = () => response('岑岚仍需休养三天。', { npcs: { update: [{ name: '岑岚', conditionPatch: { add: [{ text: '仍需休养三天', evidence: '右腕仍需休养三天' }] } }] } });
  it('排版差异无需重试，仍保留旧伤处与限制且不持久化证据', async () => {
    const chat = fixture(); vi.mocked(client.requestViaMainApi).mockResolvedValue(valid());
    expect(await batchBackfill()).toMatchObject({ done: 1 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(deriveMemory(chat).npcs[0].condition).toBe('右腕受伤，不能负重；仍需休养三天');
    expect(JSON.stringify(chat[1].extra!.bbs_leaf)).not.toMatch(/conditionPatch|evidence/);
  });
  it('缺证据有限纠错有精确路径，修正后只写一次', async () => {
    const chat = fixture(); settings.apiSettings.summaryMaxRetries = 1;
    const bad = { summary: '仍需养伤。', stateChanges: ['npcs'], npcs: { update: [{ name: '岑岚', conditionPatch: { add: [{ text: '仍需休养三天' }] } }] } };
    vi.mocked(client.requestViaMainApi).mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(valid());
    expect(await batchBackfill()).toMatchObject({ done: 1 });
    const second = vi.mocked(client.requestViaMainApi).mock.calls[1][0];
    expect(second.at(-2)?.content).toContain('岑岚.conditionPatch.add[0].evidence');
    expect(second.at(-2)?.content).toContain('缺失'); expect(second.at(-1)?.role).toBe('assistant');
    expect(deriveMemory(chat).npcs[0].condition?.match(/三天/g)).toHaveLength(1);
  });
  it('无效证据耗尽后标出失败楼层，不覆盖旧摘要或继续后楼；局部重试可恢复', async () => {
    const chat = fixture(); chat[1].extra!.bbs_leaf = { id: 'old', text: '保留的旧摘要', delta: {}, createdAt: 1, swipe: 0, v: 1 };
    chat.push(msg('下一楼不得在前楼失败后继续处理。'));
    const before = JSON.stringify(chat); settings.apiSettings.summaryMaxRetries = 1;
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response('错误恢复。', { npcs: { update: [{ name: '岑岚', conditionPatch: { replace: [{ id: 'c1', text: '', evidence: '右腕已经痊愈' }] } }] } }));
    expect(await batchBackfill({ regenerate: true })).toMatchObject({ done: 0 });
    expect(client.requestViaMainApi).toHaveBeenCalledTimes(2); expect(JSON.stringify(chat)).toBe(before);
    expect(engineState.lastError).toContain('楼层 #1 摘要未保存'); expect(engineState.lastError).toContain('replace[0].evidence');
    vi.mocked(client.requestViaMainApi).mockResolvedValue(valid());
    expect(await regenerateFloor(1)).toBe(true); expect(engineState.lastError).toBe('');
    expect(chat[1].extra!.bbs_leaf!.text).toBe('岑岚仍需休养三天。'); expect(chat[2].extra!.bbs_leaf).toBeUndefined();
  });
});
