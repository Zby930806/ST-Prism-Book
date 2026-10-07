import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { batchBackfill, summarizeFloor, currentSummaryPromise } from './engine';
import { deriveMemory, syncItemLogFromMessage } from './apply';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type SummaryDelta } from './types';
import { refreshInjection, clearInjection, estimateInjectionTokenBreakdown } from './inject';
import { LEDGER_ATTRIBUTES, LEDGER_PROTOCOL } from './ledgerProtocol';
import { estimateTokens, slotBudget } from './budget';
import { cleanBody, readItemsTagText, readVarsTagText, writeItemLogTag, writeVarLogTag, ensureHideRegexRegistered } from './timeTag';

const saved = JSON.stringify(settings.apiSettings);
const msg = (mes: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes, extra: {} });
const response = (delta: SummaryDelta = {}) => JSON.stringify({ summary: '发生了正文所述事件。', ...delta, stateChanges: Object.keys(delta) });
function useChat(chat: STMessage[]) {
  const slots = new Map<string, string>();
  const regex: Array<Record<string, unknown>> = [];
  const ctx = { chat, name1: '主角', name2: '角色', getCurrentChatId: () => 'ledger-test', chatMetadata: {},
    extensionSettings: { regex }, saveSettingsDebounced: vi.fn(),
    setExtensionPrompt: vi.fn((key: string, text: string) => slots.set(key, text)),
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return { slots, regex };
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100, memoryBudgetTokens: 6000 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '', timeTag: '' });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(response());
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('主模型只读账本协议', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('auto=%s summaryOnly=%s仍保留历史可见及独立协议', (auto, only) => {
    settings.apiSettings.autoSummaryEnabled = auto;
    settings.apiSettings.summaryOnlyMode = only;
    settings.apiSettings.prompts.timeTag = '自定义时间指令';
    const chat = [msg('正文。\n<bbs_items>\n获得 罗盘 1\n</bbs_items>')];
    const original = chat[0].mes;
    const { slots } = useChat(chat);
    refreshInjection();
    expect(slots.get('baibai_book_ledger_protocol')).toBe(LEDGER_PROTOCOL);
    expect(slots.get('baibai_book_time_tag')).toBe(auto ? '自定义时间指令' : '');
    expect(chat[0].mes).toBe(original);
    expect(estimateInjectionTokenBreakdown().other).toBeGreaterThanOrEqual(estimateTokens(LEDGER_PROTOCOL));
    clearInjection();
    expect([...slots.values()].every(s => s === '')).toBe(true);
    refreshInjection();
    vi.mocked(settings.engineActiveHere).mockReturnValue(false);
    refreshInjection();
    expect([...slots.values()].every(s => s === '')).toBe(true);
  });
  it.each([2000, 6000, 50000])('预算%s包含账本且不挤掉原时间份额', budget => {
    settings.apiSettings.memoryBudgetTokens = budget;
    expect(slotBudget('ledger')).toBe(estimateTokens(LEDGER_PROTOCOL));
    expect(slotBudget('state')).toBeGreaterThan(0);
    expect(slotBudget('timeTag')).toBe(Math.floor(budget * 0.05));
    expect(['history', 'state', 'timeTag', 'recall', 'ledger'].reduce((n, slot) => n + slotBudget(slot as Parameters<typeof slotBudget>[0]), 0)).toBeLessThanOrEqual(budget);
    const { slots } = useChat([]); refreshInjection();
    expect(slots.get('baibai_book_ledger_protocol')).toBe(LEDGER_PROTOCOL);
  });
});

describe('旧旁注与来源属性兼容', () => {
  it.each(['', ' ' + LEDGER_ATTRIBUTES])('格式%s读取、隐藏、幂等写回且不吞正文同名示例', attr => {
    const { regex } = useChat([]);
    const example = '正文中的引用：\n<bbs_items>\n获得 示例 9\n</bbs_items>\n引用结束，不是尾部旁注。';
    const body = example + '\n<bbs_end>2031/4/12 20:00</bbs_end>';
    const old = body + '\n<bbs_items' + attr + '>\n获得 罗盘 1\n</bbs_items>\n<bbs_vars' + attr + '>\n变更 能量 -1\n</bbs_vars>';
    expect(readItemsTagText(old)).toBe('获得 罗盘 1');
    expect(readVarsTagText(old)).toBe('变更 能量 -1');
    const written = writeVarLogTag(writeItemLogTag(old, '消耗 药剂 1'), '变更 能量 -2');
    expect(written).toContain(example);
    expect(written).toContain('<bbs_items ' + LEDGER_ATTRIBUTES + '>');
    expect(writeVarLogTag(writeItemLogTag(written, '消耗 药剂 1'), '变更 能量 -2')).toBe(written);
    expect(cleanBody(written)).toContain(example);
    expect(cleanBody(written)).not.toContain('消耗 药剂');
    expect(cleanBody(written)).not.toContain('变更 能量');
    ensureHideRegexRegistered(); ensureHideRegexRegistered();
    expect(regex).toHaveLength(3);
    for (const script of regex) {
      expect(script).toMatchObject({ markdownOnly: true, promptOnly: false });
      const raw = String(script.findRegex); const slash = raw.lastIndexOf('/');
      const re = new RegExp(raw.slice(1, slash), raw.slice(slash + 1));
      if (script.id === 'bbs-items-tag-hide') expect(old.replace(re, '')).not.toContain('获得 罗盘');
      if (script.id === 'bbs-vars-tag-hide') expect(old.replace(re, '')).not.toContain('变更 能量');
    }
  });
  it('无时间锚的旧旁注升级后仍读取,仅摘要模式不改原文', () => {
    const old = '正文。\n<bbs_items>\n获得 罗盘 1\n</bbs_items>';
    const fresh = writeItemLogTag(old, '获得 罗盘 2');
    expect(readItemsTagText(fresh)).toBe('获得 罗盘 2');
    expect(cleanBody(fresh)).toBe('正文。');
    settings.apiSettings.summaryOnlyMode = true;
    expect(writeItemLogTag(old, '获得 罗盘 2')).toBe(old);
    expect(writeVarLogTag(old, '变更 能量 -1')).toBe(old);
  });
});

describe('摘要生产入口的结算边界（mock不证明模型遵从率）', () => {
  it('前楼日志可见,复制尾注不作为新叙事,真正再次消耗仍结算,全量重建不累加', async () => {
    const copied = '\n<bbs_items>\n获得 药剂 3\n</bbs_items>';
    const chat = [msg('收到三瓶备用药剂。'), msg('在门边等待。' + copied), msg('新的一天再次喝下一瓶药剂。')];
    const { slots } = useChat(chat);
    chat[0].swipe_id = 0; chat[0].swipes = [chat[0].mes, '另一个候选正文'];
    const deltas: SummaryDelta[] = [{ items: { add: [{ name: '药剂', qty: 3 }] } }, {}, { items: { update: [{ name: '药剂', qty: 2 }] } }];
    let call = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      const index = call++ % 3;
      const input = messages.map(m => m.content).join('\n');
      if (index > 0) {
        expect(input).toContain('近期物品变动');
        expect(input).toContain('药剂');
        expect(input).toContain('同一次旧消耗不再处理');
      }
      if (index === 1) {
        expect(input).toContain('在门边等待。');
        expect(input).not.toContain(copied);
        expect(deriveMemory(chat, index).items[0].qty).toBe(3);
      }
      if (index === 2) expect(deriveMemory(chat, index).items[0].qty).toBe(3);
      return response(deltas[index]);
    });
    for (let run = 0; run < 2; run++) {
      expect(await batchBackfill({ regenerate: true })).toEqual({ done: 3, total: 3, cancelled: false });
      expect(deriveMemory(chat).items[0].qty).toBe(2);
      expect(readItemsTagText(chat[0].mes)).toBe('获得 药剂 3');
      expect(chat[0].swipes?.[0]).toBe(chat[0].mes);
      expect(chat[0].swipes?.[1]).toBe('另一个候选正文');
      expect(readItemsTagText(chat[1].mes)).toBeNull();
      expect(readItemsTagText(chat[2].mes)).toBe('消耗 药剂 1');
      expect(slots.get('baibai_book_ledger_protocol')).toBe(LEDGER_PROTOCOL);
    }
    expect(call).toBe(6);
  });
  it('新楼自称settled不直接入账,已有叶子的用户改数仍可反向同步', async () => {
    const chat = [msg(writeItemLogTag('主角收到三瓶药剂。', '获得 药剂 99'))];
    useChat(chat);
    expect(syncItemLogFromMessage(0)).toBe(false);
    expect(deriveMemory(chat).items).toHaveLength(0);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(response({ items: { add: [{ name: '药剂', qty: 3 }] } }));
    await summarizeFloor(0);
    expect(deriveMemory(chat).items[0].qty).toBe(3);
    chat[0].mes = chat[0].mes.replace('获得 药剂 3', '获得 药剂 5');
    expect(syncItemLogFromMessage(0)).toBe(true);
    expect(deriveMemory(chat).items[0].qty).toBe(5);
    expect(syncItemLogFromMessage(0)).toBe(false);
    expect(chat[0].mes).toContain(LEDGER_ATTRIBUTES);
  });
  it('后楼请求可见旧外貌与完整伤势,并收到跨字段结账和覆盖保留约束', async () => {
    const chat = [msg('甲受伤。'), msg('甲说还得休养两天,本次账目了结。')];
    useChat(chat); let call = 0;
    vi.mocked(client.requestViaMainApi).mockImplementation(async messages => {
      if (call++ === 0) return response({ npcs: { add: [{ name: '甲', desc: '黑发,脚踝缠绷带', condition: '脚踝扭伤,不能负重' }] } });
      const input = messages.map(m => m.content).join('\n');
      expect(input).toContain('既有外貌记录:黑发,脚踝缠绷带');
      expect(input).toContain('最后记录状态:脚踝扭伤,不能负重');
      expect(input).toContain('本轮只新增休养估计');
      expect(input).toContain('对方表示不再追究某项义务，不等于义务人已经付款或履约');
      return response({ npcs: { update: [{ name: '甲', desc: '黑发', conditionPatch: { add: [{ text: '自述还需休养两天', evidence: '甲说还得休养两天' }] } }] } });
    });
    await batchBackfill({ regenerate: true });
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ desc: '黑发', condition: '脚踝扭伤,不能负重；自述还需休养两天' });
  });
});
