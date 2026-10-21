import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as host from '@/st/context';
import { RULE_CONTENT_BOUNDARY } from '@/memory/prompts';
import { makeTavern, message } from './testEnv';
import { buildWorldbookContext, indexLine, relatedEntries } from './context';
import { cursorBefore, makeRange, newAiFloors, planRead, rangeCurrent } from './source';
import { buildWorldbookSystem, worldbookPromptBody, worldbookPromptExport } from './prompt';
import { listEntries } from './entries';
import { messageHash } from '@/notes/source';
import type { WorldData, WorldbookSettings } from './types';

// 上下文：目标书索引、触发条目全文、预算、参考书只读；读取楼层与依据范围；提示词档位与内容边界。
vi.mock('@/memory/engine', () => ({ isAiFloor: (m: { is_user?: boolean; extra?: Record<string, unknown> }) => !!m && !m.is_user && !m.extra?.bbs_omit && !m.extra?.bbs_internal_notice }));

const read: WorldbookSettings['read'] = { maxFloors: 24, maxChars: 24000, entryChars: 6000, refChars: 4000 };
let tavern: ReturnType<typeof makeTavern>;
beforeEach(() => {
  tavern = makeTavern({ chat: [
    message('去港口。', { is_user: true }),
    message('雾港的钟塔在城北。'),
    message('内部提示', { extra: { bbs_internal_notice: 'backlog' } }),
    message('番外：海边的一天。', { extra: { bbs_omit: true } }),
    message('<think>不该读到</think>看守接过怀表，放他们进了档案室。'),
  ] });
  vi.spyOn(host, 'getContext').mockImplementation(() => tavern.ctx);
});
afterEach(() => { vi.restoreAllMocks(); });

function bookWith(n: number, extra: Record<string, Record<string, unknown>> = {}): WorldData {
  const entries: WorldData['entries'] = {};
  for (let i = 0; i < n; i++) entries[i] = { uid: i, comment: '条目' + i, key: ['词' + i], content: '内容' + i + '。'.repeat(3) };
  for (const [k, v] of Object.entries(extra)) entries[k] = { uid: Number(k), ...v };
  return { entries };
}

describe('读取的楼层', () => {
  it('第一次读最近的楼层；跳过插件提示楼、番外楼；正文去掉思考块', () => {
    const plan = planRead(tavern.ctx, null, read, { allowReread: true, floorText: 8000 })!;
    expect(plan.mode).toBe('first');
    expect(plan.floors).toEqual([0, 1, 4]);
    const built = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '书', data: bookWith(0) }, references: [], plan, read, permission: 'create', contentBoundary: true });
    const floors = built.messages.find(m => m.content.startsWith('[新的剧情正文'))!.content;
    expect(floors).toContain('第4楼 正文：\n看守接过怀表');
    expect(floors).not.toMatch(/不该读到|内部提示|番外/);
  });

  it('有处理记录时读之后的新楼层；超过上限先读较早的，下次接着读', () => {
    tavern.ctx.chat.push(...Array.from({ length: 6 }, (_, i) => message('新的一层 ' + i)));
    const cursor = { floor: 1, hash: messageHash(tavern.ctx.chat[1]) };
    const plan = planRead(tavern.ctx, cursor, { ...read, maxFloors: 4 }, { allowReread: true, floorText: 8000 })!;
    expect(plan).toMatchObject({ mode: 'new', floors: [4, 5, 6, 7], remaining: 3 });
  });

  it('字数上限按整层计，至少读一层', () => {
    tavern.ctx.chat.push(message('长'.repeat(500)), message('短'));
    const cursor = { floor: 4, hash: messageHash(tavern.ctx.chat[4]) };
    const plan = planRead(tavern.ctx, cursor, { ...read, maxChars: 100 }, { allowReread: true, floorText: 8000 })!;
    expect(plan.floors).toEqual([5]);
    expect(plan.remaining).toBe(1);
  });

  it('处理过的那一层被重抽后从那一层重新读；没有新楼层时手动重读、自动不运行', () => {
    const cursor = { floor: 4, hash: messageHash(tavern.ctx.chat[4]) };
    expect(planRead(tavern.ctx, cursor, read, { allowReread: false, floorText: 8000 })).toBeNull();
    expect(planRead(tavern.ctx, cursor, read, { allowReread: true, floorText: 8000 })!.mode).toBe('reread');
    tavern.ctx.chat[4] = message('重抽后的第四楼。');
    expect(planRead(tavern.ctx, cursor, read, { allowReread: false, floorText: 8000 })!.floors).toEqual([4]);
  });

  it('可以设定从第 0 楼开始读取', () => {
    const plan = planRead(tavern.ctx, cursorBefore(tavern.ctx, 0), { ...read, maxFloors: 2 }, { allowReread: true, floorText: 8000 })!;
    expect(plan).toMatchObject({ mode: 'new', floors: [0, 1] });
  });

  it('依据范围被改写、重抽、删除后失效；范围之外的改动不影响', () => {
    const range = makeRange(tavern.ctx, 1, 4);
    expect(rangeCurrent(range)).toBe(true);
    tavern.ctx.chat.push(message('后面新增的楼层'));
    expect(rangeCurrent(range)).toBe(true);
    tavern.ctx.chat[0] = message('范围之前的楼层改了', { is_user: true });
    expect(rangeCurrent(range)).toBe(true);
    tavern.ctx.chat[1] = { ...tavern.ctx.chat[1], swipe_id: 1, mes: '另一页' };
    expect(rangeCurrent(range)).toBe(false);
    const range2 = makeRange(tavern.ctx, 1, 4);
    tavern.ctx.chat.splice(2, 1);
    expect(rangeCurrent(range2)).toBe(false);
  });

  it('自动建议的计数：上次处理之后新增的 AI 楼层', () => {
    expect(newAiFloors(tavern.ctx, null)).toBe(2);
    expect(newAiFloors(tavern.ctx, { floor: 1, hash: messageHash(tavern.ctx.chat[1]) })).toBe(1);
  });
});

describe('请求内容', () => {
  const plan = () => planRead(tavern.ctx, null, read, { allowReread: true, floorText: 8000 })!;

  it('目标书索引列出 uid（含 0）、标题、关键词、标记和内容开头；不发整本书', () => {
    const data = bookWith(2, { 5: { comment: '钟塔', key: ['钟塔', '/档案[室馆]/'], content: '城北的旧钟塔，' + '很长的内容'.repeat(200), constant: false, disable: true } });
    const built = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '雾港设定', data }, references: [], plan: plan(), read, permission: 'create', contentBoundary: true });
    const target = built.messages[1].content;
    expect(target).toContain('[目标世界书：雾港设定，共 3 条]');
    expect(target).toContain('[uid 0] 条目0 ｜ 关键词：词0');
    expect(indexLine(data.entries[5])).toContain('已停用');
    // 钟塔被正文触发（普通关键词和正则关键词），附全文但单条有上限
    expect(target).toContain('[相关条目全文');
    expect(target).toContain('[uid 5] 钟塔（已停用）');
    expect(target.length).toBeLessThan(6000);
    expect(built.stats).toMatchObject({ indexed: 3, omitted: 0, related: 1 });
  });

  it('索引超出预算时相关条目优先，并注明省略的条数', () => {
    const data = bookWith(400, { 999: { comment: '钟塔', key: ['钟塔'], content: '城北的旧钟塔。' } });
    const built = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '大书', data }, references: [], plan: plan(), read, permission: 'create', contentBoundary: true });
    expect(built.stats.omitted).toBeGreaterThan(0);
    expect(built.messages[1].content).toContain('[uid 999] 钟塔');
    expect(built.messages[1].content).toContain('另有 ' + built.stats.omitted + ' 条没有列出');
  });

  it('相关条目全文受字数上限约束；常驻条目排在触发条目之后', () => {
    const data = bookWith(0, {
      1: { comment: '常驻规则', key: ['不会出现的词'], content: '常驻'.repeat(50), constant: true },
      2: { comment: '钟塔', key: ['钟塔', '城北'], content: '钟'.repeat(3000) },
      3: { comment: '怀表', key: ['怀表'], content: '表'.repeat(100) },
    });
    const related = relatedEntries(listEntries(data), '雾港的钟塔在城北。看守接过怀表');
    expect(related.map(e => e.uid)).toEqual([2, 3, 1]);
    const built = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '书', data }, references: [], plan: plan(), read: { ...read, entryChars: 1500 }, permission: 'create', contentBoundary: true });
    const part = built.messages[1].content.split('[相关条目全文')[1];
    expect(part).toContain('[uid 2] 钟塔');
    expect(part).toContain('以下截断');
    expect(part.length).toBeLessThan(1700);
  });

  it('参考书只读：只带被触发的启用条目，有字数上限；设为 0 时不发送', () => {
    const ref = bookWith(0, { 1: { comment: '雾港总览', key: ['雾港'], content: '参考内容。' }, 2: { comment: '停用', key: ['钟塔'], content: 'x', disable: true }, 3: { comment: '无关', key: ['沙漠'], content: 'y' } });
    const built = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '书', data: bookWith(0) }, references: [{ name: '全局书', data: ref }], plan: plan(), read, permission: 'create', contentBoundary: true });
    const refPart = built.messages.find(m => m.content.startsWith('[参考世界书'))!.content;
    expect(refPart).toContain('《全局书》雾港总览');
    expect(refPart).not.toContain('停用');
    expect(refPart).not.toContain('无关');
    const none = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '书', data: bookWith(0) }, references: [{ name: '全局书', data: ref }], plan: plan(), read: { ...read, refChars: 0 }, permission: 'create', contentBoundary: true });
    expect(none.messages.some(m => m.content.startsWith('[参考世界书'))).toBe(false);
  });

  it('内容边界复用摘要提示词的实现；模型名含 deepseek 时省略', () => {
    expect(buildWorldbookSystem('create').startsWith(RULE_CONTENT_BOUNDARY)).toBe(true);
    expect(buildWorldbookSystem('create', { contentBoundary: false })).toBe(worldbookPromptBody('create'));
    const built = buildWorldbookContext({ ctx: tavern.ctx, target: { name: '书', data: bookWith(0) }, references: [], plan: plan(), read, permission: 'modify', contentBoundary: false });
    expect(built.messages[0].content).not.toContain('内容边界');
    expect(built.messages.at(-1)!.content).toContain('当前修改权限：可修改');
  });

  it('提示词随档位变化，只列出该档允许的动作', () => {
    const create = worldbookPromptBody('create'), supplement = worldbookPromptBody('supplement'), modify = worldbookPromptBody('modify');
    expect(create).toContain('- create：');
    expect(create).not.toMatch(/- append：|- replace：|- rewrite：/);
    expect(supplement).toMatch(/- append：[\s\S]*- keys：/);
    expect(supplement).not.toMatch(/- replace：|- rewrite：/);
    expect(modify).toMatch(/- replace：[\s\S]*- rewrite：/);
    for (const p of [create, supplement, modify]) {
      expect(p).toContain('{"actions":[]}');
      expect(p).toContain('记忆系统已经在追踪的临时状态');
      expect(p).toContain('不要编造索引中没有的 uid');
    }
    expect(worldbookPromptExport().match(/===== 修改权限：/g)).toHaveLength(3);
  });
});
