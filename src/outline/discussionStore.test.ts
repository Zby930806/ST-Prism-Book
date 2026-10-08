import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReactive } from 'vue';
import * as host from '@/st/context';
import type { STContext } from '@/st/context';
import * as sources from './source';
import {
  DISCUSSION_DATA_KEY, discussionState, loadOutlineDiscussion, discussionWriteIssue,
  appendDiscussionTurn, clearOutlineDiscussion, type DiscussionMessage,
} from './discussionStore';

// 宿主、网络完全 mock；来源快照 / 正文 fingerprint 使用真实实现。
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const pair = (question = '问题', answer = '回答'): DiscussionMessage[] => [
  { role: 'user', content: question }, { role: 'assistant', content: answer },
];
const data = (messages = pair()) => ({ version: 1, messages });
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const contexts: STContext[] = [];
const unrelated = {
  prism_book_outline: { version: 99, draft: { future: true }, active: null },
  prism_book_notes: { version: 1, records: [{ text: '原札记' }] },
  bbs_memory: { summaries: ['原记忆'], state: { location: '房间' } },
  prism_book_memory: { future: true }, unrelated: { keep: true },
};
function context(id = 'chat-a'): STContext {
  const result = {
    chat: [{ name: '角色', is_user: false, is_system: false, mes: '她走进房间。', swipe_id: 0,
      extra: { bbs_leaf: { id: 'leaf', text: '原叶子摘要' } } }],
    chatMetadata: copy(unrelated), characterId: '0', groupId: undefined,
    getCurrentChatId: vi.fn(() => id),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    saveChat: vi.fn(), saveMetadataDebounced: vi.fn(), saveSettingsDebounced: vi.fn(),
    setExtensionPrompt: vi.fn(), generateRaw: vi.fn(),
    ConnectionManagerRequestService: { sendRequest: vi.fn() },
  } as unknown as STContext;
  contexts.push(result);
  return result;
}
let ctx: STContext, current: STContext | null;
const saved = (target = ctx) => target.chatMetadata[DISCUSSION_DATA_KEY];
const append = (question = '新问题', answer = '新回答') =>
  appendDiscussionTurn(question, answer, discussionState.revision, sources.captureOutlineSource(current!));
function seed(messages = pair()) {
  ctx.chatMetadata[DISCUSSION_DATA_KEY] = data(messages);
  loadOutlineDiscussion();
}
beforeEach(() => {
  contexts.length = 0;
  ctx = context(); current = ctx;
  vi.spyOn(host, 'getContext').mockImplementation(() => current);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('禁止真实网络')));
  loadOutlineDiscussion();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  for (const target of contexts) {
    expect(target.saveChat).not.toHaveBeenCalled();
    expect(target.saveMetadataDebounced).not.toHaveBeenCalled();
    expect(target.saveSettingsDebounced).not.toHaveBeenCalled();
    expect(target.generateRaw).not.toHaveBeenCalled();
    expect(target.ConnectionManagerRequestService!.sendRequest).not.toHaveBeenCalled();
    expect(target.setExtensionPrompt).not.toHaveBeenCalled();
    const { [DISCUSSION_DATA_KEY]: _discussion, ...rest } = target.chatMetadata;
    expect(rest).toEqual(unrelated);
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('独立 sidecar / 旧聊天兼容', () => {
  it('精确导出 key 与 reactive 状态；旧聊天空载入不创建 key、不保存，且每次递增 revision', () => {
    expect(DISCUSSION_DATA_KEY).toBe('prism_book_outline_discussion');
    expect(isReactive(discussionState)).toBe(true);
    const revision = discussionState.revision;
    loadOutlineDiscussion(); loadOutlineDiscussion();
    expect(discussionState).toEqual({ messages: [], revision: revision + 2, saving: false, issue: '' });
    expect(Object.hasOwn(ctx.chatMetadata, DISCUSSION_DATA_KEY)).toBe(false);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(discussionWriteIssue()).toBe('');
  });
  it('读取合法 v1 及空历史，无迁移保存；复制隔离 metadata', () => {
    seed();
    expect(discussionState.messages).toEqual(pair());
    discussionState.messages[0].content = '仅视图被改';
    expect(saved()).toEqual(data());
    loadOutlineDiscussion();
    expect(discussionState.messages).toEqual(pair());
    seed([]);
    expect(discussionState.messages).toEqual([]);
    expect(discussionWriteIssue()).toBe('');
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('完整添加一轮后才提交可见记录，重载可恢复；不改正文、leaf 或旧 metadata', async () => {
    seed();
    const chat = copy(ctx.chat), revision = discussionState.revision, wait = deferred();
    vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    expect(discussionState.saving).toBe(true);
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.revision).toBe(revision);
    expect(saved()).toEqual(data([...pair(), ...pair('新问题', '新回答')]));
    expect(discussionWriteIssue()).toContain('正在保存');
    wait.resolve(); await task;
    expect(discussionState.saving).toBe(false);
    expect(discussionState.revision).toBe(revision + 1);
    expect(discussionState.messages).toEqual([...pair(), ...pair('新问题', '新回答')]);
    loadOutlineDiscussion();
    expect(discussionState.messages).toEqual([...pair(), ...pair('新问题', '新回答')]);
    expect(ctx.chat).toEqual(chat);
    expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
  });
  it('新增轮次不持久化外部对 reactive 历史的直接修改', async () => {
    seed(); discussionState.messages[0].content = '意外修改';
    await append();
    expect(saved()).toEqual(data([...pair(), ...pair('新问题', '新回答')]));
  });
  it('clear 必须显式执行；保存成功前不清空，成功后写独立空 v1', async () => {
    seed(); const wait = deferred(), revision = discussionState.revision;
    vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = clearOutlineDiscussion(revision);
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.revision).toBe(revision);
    wait.resolve(); await task;
    expect(discussionState.messages).toEqual([]);
    expect(saved()).toEqual(data([]));
    expect(discussionState.revision).toBe(revision + 1);
    loadOutlineDiscussion(); expect(discussionState.messages).toEqual([]);
  });
});

describe('严格格式 / 未知版本只读', () => {
  const bad: [string, () => unknown][] = [
    ['未来版本', () => ({ version: 2, messages: pair() })],
    ['旧版本', () => ({ version: 0, messages: pair() })],
    ['字符串版本', () => ({ version: '1', messages: pair() })],
    ['缺版本', () => ({ messages: pair() })],
    ['缺 messages', () => ({ version: 1 })],
    ['null', () => null], ['字符串', () => '秘密坏数据'], ['数组', () => pair()],
    ['顶层未知字段', () => ({ ...data(), secret: '不可回显' })],
    ['顶层 symbol 字段', () => ({ ...data(), [Symbol('future')]: true })],
    ['消息未知字段', () => data([{ ...pair()[0], extra: true }, pair()[1]] as DiscussionMessage[])],
    ['消息 symbol 字段', () => data([{ ...pair()[0], [Symbol('extra')]: true }, pair()[1]])],
    ['system', () => data([{ role: 'system', content: '系统内容' }, pair()[1]] as DiscussionMessage[])],
    ['tool', () => data([pair()[0], { role: 'tool', content: '工具内容' }] as DiscussionMessage[])],
    ['角色倒序', () => data(pair().reverse())],
    ['两个 user', () => data([pair()[0], pair()[0]])],
    ['未配对', () => data([pair()[0]])],
    ['非数组 messages', () => ({ version: 1, messages: {} })],
    ['稀疏数组', () => data(new Array<DiscussionMessage>(2))],
    ['数组未知字段', () => data(Object.assign(pair(), { extra: true }))],
    ['继承的版本', () => Object.assign(Object.create({ version: 1 }), { messages: pair(), extra: 1 })],
    ['空问题', () => data(pair('', '答'))], ['空回复', () => data(pair('问', ''))],
    ['空白内容', () => data(pair('  \n', '答'))],
    ['非字符串内容', () => data([{ role: 'user', content: 123 }, pair()[1]] as unknown as DiscussionMessage[])],
    ['问题过长', () => data(pair('问'.repeat(4001)))],
    ['回复过长', () => data(pair('问', '答'.repeat(8001)))],
    ['超过24条', () => data(Array.from({ length: 13 }, () => pair()).flat())],
    ['总内容超过48000', () => data([...Array.from({ length: 4 }, () => pair('问'.repeat(4000), '答'.repeat(8000))).flat(), ...pair()])],
    ['循环数据', () => { const value: Record<string, unknown> = data(); value.self = value; return value; }],
  ];
  it.each(bad)('%s：不删改原值，append / clear 均拒绝，无异常内容回显', async (_name, make) => {
    const raw = make(); ctx.chatMetadata[DISCUSSION_DATA_KEY] = raw;
    const revision = discussionState.revision;
    loadOutlineDiscussion();
    expect(discussionState.revision).toBe(revision + 1);
    expect(discussionState.messages).toEqual([]);
    expect(discussionWriteIssue()).toContain('只读保护');
    expect(discussionState.issue).not.toMatch(/秘密|系统内容|不可回显/);
    await expect(append()).rejects.toThrow('只读保护');
    await expect(clearOutlineDiscussion(discussionState.revision)).rejects.toThrow('只读保护');
    expect(saved()).toBe(raw);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('保护状态在切到正常旧聊天后解除，不修改原聊天未来数据', async () => {
    const future = { version: 999, messages: pair(), future: true };
    ctx.chatMetadata[DISCUSSION_DATA_KEY] = future; loadOutlineDiscussion();
    current = context('chat-b'); loadOutlineDiscussion();
    expect(discussionWriteIssue()).toBe('');
    await append();
    expect(saved()).toBe(future);
    expect(saved(current)).toEqual(data(pair('新问题', '新回答')));
  });
});

describe('输入与整轮容量限制', () => {
  it.each([
    ['', '答'], [' \n', '答'], ['问', ''], ['问', '\t'],
    ['问'.repeat(4001), '答'], ['问', '答'.repeat(8001)],
    [null, '答'], ['问', 123],
  ])('无效输入不保存 %#', async (question, answer) => {
    seed(); const revision = discussionState.revision, before = saved();
    await expect(append(question as string, answer as string)).rejects.toThrow(/1到/);
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.revision).toBe(revision);
    expect(saved()).toBe(before);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('接受1字和最大长度，不截断有效内容', async () => {
    await append('问', '答');
    await append('问'.repeat(4000), '答'.repeat(8000));
    expect(discussionState.messages).toEqual([...pair('问', '答'), ...pair('问'.repeat(4000), '答'.repeat(8000))]);
  });
  it('第13轮明确拒绝，不保存且不丢弃最老记录；确认清空后才能继续', async () => {
    const original = Array.from({ length: 12 }, (_, i) => pair(`问${i}`, `答${i}`)).flat();
    seed(original); const previous = saved(), state = copy(discussionState);
    await expect(append()).rejects.toThrow('请先确认清空讨论');
    expect(saved()).toBe(previous);
    expect(discussionState).toEqual(state);
    expect(discussionState.messages).toEqual(original);
    expect(discussionState.messages).toHaveLength(24);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    loadOutlineDiscussion(); expect(discussionState.messages).toEqual(original);
    await clearOutlineDiscussion(discussionState.revision); await append();
    expect(discussionState.messages).toEqual(pair('新问题', '新回答'));
  });
  it('48000字边界可载入；再新增明确拒绝，不写不丢任何旧记录', async () => {
    const original = Array.from({ length: 4 }, () => pair('问'.repeat(4000), '答'.repeat(8000))).flat();
    seed(original); expect(discussionWriteIssue()).toBe('');
    const previous = saved(), state = copy(discussionState);
    await expect(append('问', '答')).rejects.toThrow('请缩短本轮内容或先确认清空讨论');
    expect(saved()).toBe(previous);
    expect(discussionState).toEqual(state);
    expect(discussionState.messages).toEqual(original);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('总量超限但轮数未超限也拒绝，不静默移除多轮小记录', async () => {
    const original = [...Array.from({ length: 8 }, () => pair('问'.repeat(500), '答'.repeat(1000))).flat(),
      ...Array.from({ length: 3 }, () => pair('问'.repeat(4000), '答'.repeat(8000))).flat()];
    seed(original); const previous = saved(), state = copy(discussionState);
    await expect(append('新'.repeat(4000), '新'.repeat(8000))).rejects.toThrow('48000');
    expect(saved()).toBe(previous);
    expect(discussionState).toEqual(state);
    expect(discussionState.messages).toEqual(original);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('恰好达到12轮且48000字可成功；超过1字拒绝后缩短可重试', async () => {
    const original = Array.from({ length: 11 }, () => pair('问'.repeat(1000), '答'.repeat(3000))).flat();
    seed(original); const previous = saved(), state = copy(discussionState);
    await expect(append('问'.repeat(1000), '答'.repeat(3001))).rejects.toThrow('48000');
    expect(saved()).toBe(previous); expect(discussionState).toEqual(state);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    await append('问'.repeat(1000), '答'.repeat(3000));
    expect(discussionState.messages).toHaveLength(24);
    expect(discussionState.messages.reduce((sum, message) => sum + message.content.length, 0)).toBe(48000);
    expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
  });
});

describe('revision / 来源 / metadata 并发保护', () => {
  it('必须调用 outlineInputUnchanged(source, true)', async () => {
    const spy = vi.spyOn(sources, 'outlineInputUnchanged');
    const source = sources.captureOutlineSource(ctx);
    await appendDiscussionTurn('问', '答', discussionState.revision, source);
    expect(spy).toHaveBeenCalledWith(source, true);
  });
  it('load 使已捕获 revision 失效，append 与 clear 均不保存', async () => {
    const revision = discussionState.revision, source = sources.captureOutlineSource(ctx);
    loadOutlineDiscussion();
    await expect(appendDiscussionTurn('问', '答', revision, source)).rejects.toThrow('已经变化');
    await expect(clearOutlineDiscussion(revision)).rejects.toThrow('版本已变化');
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it.each(['追加楼层', '删除楼层', '正文编辑', 'swipe', '角色名', '用户角色', 'character', 'group', 'chat引用', 'metadata引用', 'id'])(
    '%s 变化使来源失效', async kind => {
      const source = sources.captureOutlineSource(ctx), revision = discussionState.revision;
      if (kind === '追加楼层') ctx.chat.push({ ...ctx.chat[0] });
      if (kind === '删除楼层') ctx.chat.pop();
      if (kind === '正文编辑') ctx.chat[0].mes = '已编辑正文';
      if (kind === 'swipe') ctx.chat[0].swipe_id = 1;
      if (kind === '角色名') ctx.chat[0].name = '另一角色';
      if (kind === '用户角色') ctx.chat[0].is_user = true;
      if (kind === 'character') ctx.characterId = '1';
      if (kind === 'group') ctx.groupId = 'group-b';
      if (kind === 'chat引用') ctx.chat = [...ctx.chat];
      if (kind === 'metadata引用') ctx.chatMetadata = { ...ctx.chatMetadata };
      if (kind === 'id') vi.mocked(ctx.getCurrentChatId).mockReturnValue('chat-b');
      await expect(appendDiscussionTurn('问', '答', revision, source)).rejects.toThrow(/已经变化|聊天已切换/);
      expect(ctx.saveMetadata).not.toHaveBeenCalled();
    },
  );
  it('来源属于别的聊天时即使 revision 一致也拒绝', async () => {
    const source = sources.captureOutlineSource(context('other'));
    await expect(appendDiscussionTurn('问', '答', discussionState.revision, source)).rejects.toThrow('已经变化');
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it.each(['替换', '原地修改', '删除', '未来版本'])('外部%s被 fingerprint 检出；重载但不覆盖', async kind => {
    seed(); const revision = discussionState.revision;
    if (kind === '替换') ctx.chatMetadata[DISCUSSION_DATA_KEY] = data(pair('外部问题', '外部回答'));
    if (kind === '原地修改') (saved() as ReturnType<typeof data>).messages[0].content = '外部编辑';
    if (kind === '删除') delete ctx.chatMetadata[DISCUSSION_DATA_KEY];
    if (kind === '未来版本') ctx.chatMetadata[DISCUSSION_DATA_KEY] = { version: 2, messages: [] };
    const raw = saved();
    expect(discussionWriteIssue()).toContain('其它操作中改变');
    expect(discussionState.revision).toBe(revision + 1);
    await expect(clearOutlineDiscussion(revision)).rejects.toThrow(/版本已变化|只读保护/);
    expect(saved()).toBe(raw);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('没有宿主或没有已保存聊天 id 时只返回安全提示', async () => {
    current = null; loadOutlineDiscussion();
    expect(discussionWriteIssue()).toContain('已保存的聊天');
    await expect(clearOutlineDiscussion(discussionState.revision)).rejects.toThrow('已保存的聊天');
    current = ctx; vi.mocked(ctx.getCurrentChatId).mockReturnValue(undefined);
    expect(discussionWriteIssue()).toContain('已保存的聊天');
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it.each(['symbol', '不可枚举'])('外部添加%s未知字段也进入只读保护，不被 JSON fingerprint 忽略', async kind => {
    seed(); const raw = saved() as object;
    Object.defineProperty(raw, kind === 'symbol' ? Symbol('future') : 'future', { value: 'secret' });
    expect(discussionWriteIssue()).toContain('其它操作中改变');
    expect(discussionWriteIssue()).toContain('只读保护');
    await expect(append()).rejects.toThrow('只读保护');
    expect(saved()).toBe(raw);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });
  it('writeIssue 不回显宿主异常', () => {
    vi.mocked(ctx.getCurrentChatId).mockImplementation(() => { throw new Error('secret-api-key'); });
    expect(discussionWriteIssue()).toBe('讨论存储不可用。');
  });
  it('同一聊天保存中拒绝 append 和 clear，不产生第二次保存', async () => {
    const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    await expect(append()).rejects.toThrow('正在保存');
    await expect(clearOutlineDiscussion(discussionState.revision)).rejects.toThrow('正在保存');
    expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
    wait.resolve(); await task;
  });
});

describe('失败回滚与迟到保存隔离', () => {
  it.each(['append', 'clear'])('%s 保存失败完整保留旧记录与 revision，不泄露异常，允许重试', async operation => {
    seed(); const previous = saved(), revision = discussionState.revision;
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('secret-api-key / 私密正文 / server response'));
    const task = operation === 'append' ? append() : clearOutlineDiscussion(revision);
    await expect(task).rejects.toThrow('已有记录保持不变');
    expect(saved()).toBe(previous);
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.revision).toBe(revision);
    expect(discussionState.issue).not.toMatch(/secret|私密|server/);
    expect(discussionState.saving).toBe(false);
    expect(discussionWriteIssue()).toBe('');
    await append(); expect(discussionState.issue).toBe('');
  });
  it.each([false, true])('首次写失败恢复 key 原本存在性：%s', async existed => {
    if (existed) ctx.chatMetadata[DISCUSSION_DATA_KEY] = undefined;
    loadOutlineDiscussion();
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce('secret string error');
    await expect(append()).rejects.toThrow('保存失败');
    expect(Object.hasOwn(ctx.chatMetadata, DISCUSSION_DATA_KEY)).toBe(existed);
    expect(saved()).toBeUndefined();
    expect(discussionState.messages).toEqual([]);
  });
  it('同步 saveMetadata 异常同样回滚并消毒', async () => {
    seed(); const previous = saved();
    vi.mocked(ctx.saveMetadata).mockImplementationOnce(() => { throw new Error('secret-sync'); });
    await expect(append()).rejects.toThrow('保存失败');
    expect(saved()).toBe(previous);
    expect(discussionState.messages).toEqual(pair());
  });
  it.each(['替换', '原地修改'])('保存成功期间被外部%s：不覆盖外部值，重载冲突', async kind => {
    seed(); const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    if (kind === '替换') ctx.chatMetadata[DISCUSSION_DATA_KEY] = data(pair('外部问题', '外部回答'));
    else (saved() as ReturnType<typeof data>).messages[0].content = '外部修改';
    const external = saved(); wait.resolve();
    await expect(task).rejects.toThrow('其它操作修改');
    expect(saved()).toBe(external);
    expect(discussionState.messages).toEqual((external as ReturnType<typeof data>).messages);
    expect(discussionState.saving).toBe(false);
  });
  it.each(['替换', '原地修改'])('失败期间被外部%s：回滚不覆盖外部值，可见历史保持原状', async kind => {
    seed(); const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    if (kind === '替换') ctx.chatMetadata[DISCUSSION_DATA_KEY] = data(pair('外部问题', '外部回答'));
    else (saved() as ReturnType<typeof data>).messages[0].content = '外部修改';
    const external = saved(); wait.reject(new Error('secret'));
    await expect(task).rejects.toThrow('保存失败');
    expect(saved()).toBe(external);
    expect(discussionState.messages).toEqual(pair());
    expect(discussionWriteIssue()).toContain('其它操作中改变');
  });
  it('保存期间变为未来版本：成功也不能覆盖或展示未来字段', async () => {
    seed(); const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append(), future = { version: 123, privateFutureData: 'secret' };
    ctx.chatMetadata[DISCUSSION_DATA_KEY] = future;
    wait.resolve(); await expect(task).rejects.toThrow('其它操作修改');
    expect(saved()).toBe(future);
    expect(discussionState.messages).toEqual([]);
    expect(discussionWriteIssue()).toContain('只读保护');
    expect(discussionState.saving).toBe(false);
  });
  it.each([true, false])('暂存值被加上非 JSON 字段时也不认领或回滚（成功=%s）', async success => {
    seed(); const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append(), external = saved() as object;
    Object.defineProperty(external, Symbol('future'), { value: 'secret' });
    if (success) wait.resolve(); else wait.reject(new Error('secret'));
    await expect(task).rejects.toThrow(success ? '其它操作修改' : '保存失败');
    expect(saved()).toBe(external);
    if (!success) expect(discussionWriteIssue()).toContain('其它操作中改变');
    expect(discussionWriteIssue()).toContain('只读保护');
  });
  it.each([true, false])('切聊后旧保存结束（成功=%s）不动新聊天 state，包括新保存的 saving', async success => {
    seed(); const previous = saved(), waitA = deferred(), waitB = deferred();
    vi.mocked(ctx.saveMetadata).mockReturnValueOnce(waitA.promise);
    const taskA = append('A问', 'A答');
    current = context('chat-b'); loadOutlineDiscussion();
    vi.mocked(current.saveMetadata).mockReturnValueOnce(waitB.promise);
    const taskB = append('B问', 'B答');
    const stateB = copy(discussionState);
    if (success) waitA.resolve(); else waitA.reject(new Error('secret-old-chat'));
    await expect(taskA).rejects.toThrow('聊天已切换');
    expect(discussionState).toEqual(stateB);
    expect(discussionState.saving).toBe(true);
    if (!success) expect(saved()).toBe(previous);
    else expect(saved()).toEqual(data([...pair(), ...pair('A问', 'A答')]));
    waitB.resolve(); await taskB;
    expect(discussionState.messages).toEqual(pair('B问', 'B答'));
    expect(discussionState.saving).toBe(false);
  });
  it('旧聊天失败不能污染新聊天的未来版本保护状态', async () => {
    const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    current = context('chat-b'); current.chatMetadata[DISCUSSION_DATA_KEY] = { version: 7 };
    loadOutlineDiscussion(); const state = copy(discussionState);
    wait.reject(new Error('secret'));
    await expect(task).rejects.toThrow('聊天已切换');
    expect(discussionState).toEqual(state);
    expect(discussionWriteIssue()).toContain('只读保护');
  });
  it('宿主复用可变 context：迟到失败只回滚捕获的旧 metadata', async () => {
    seed(); const oldMetadata = ctx.chatMetadata, previous = saved(), wait = deferred();
    vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    ctx.chat = copy(ctx.chat); ctx.chatMetadata = copy(unrelated);
    vi.mocked(ctx.getCurrentChatId).mockReturnValue('chat-b');
    loadOutlineDiscussion(); const state = copy(discussionState);
    wait.reject(new Error('secret')); await expect(task).rejects.toThrow('聊天已切换');
    expect(oldMetadata[DISCUSSION_DATA_KEY]).toBe(previous);
    expect(saved()).toBeUndefined();
    expect(discussionState).toEqual(state);
  });
  it('切聊未显式 load 也由 writeIssue 自动发现，且绝不保存', () => {
    seed(); current = context('chat-b'); const revision = discussionState.revision;
    expect(discussionWriteIssue()).toContain('聊天已切换');
    expect(discussionState.messages).toEqual([]);
    expect(discussionState.revision).toBe(revision + 1);
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(current.saveMetadata).not.toHaveBeenCalled();
  });
  it.each([true, false])('保存中同聊天重载不展示未持久化消息或解除锁（成功=%s）', async success => {
    seed(); const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    loadOutlineDiscussion();
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.saving).toBe(true);
    expect(discussionWriteIssue()).toContain('正在保存');
    const revision = discussionState.revision;
    if (success) wait.resolve(); else wait.reject(new Error('secret'));
    await expect(task).rejects.toThrow('讨论已重新载入');
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.revision).toBe(revision);
    expect(discussionState.saving).toBe(false);
    loadOutlineDiscussion();
    expect(discussionState.messages).toEqual(success ? [...pair(), ...pair('新问题', '新回答')] : pair());
  });
  it('A→B→A 即使引用和 id 恢复，旧请求也不能认领新载入的 state', async () => {
    seed(); const wait = deferred(); vi.mocked(ctx.saveMetadata).mockReturnValueOnce(wait.promise);
    const task = append();
    current = context('chat-b'); loadOutlineDiscussion();
    current = ctx; loadOutlineDiscussion();
    const revision = discussionState.revision;
    wait.resolve(); await expect(task).rejects.toThrow('讨论已重新载入');
    expect(discussionState.messages).toEqual(pair());
    expect(discussionState.revision).toBe(revision);
    expect(discussionState.saving).toBe(false);
    expect(discussionWriteIssue()).toContain('其它操作中改变');
    expect(discussionState.messages).toEqual([...pair(), ...pair('新问题', '新回答')]);
  });
});
