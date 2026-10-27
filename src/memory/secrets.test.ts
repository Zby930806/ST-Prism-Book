import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, finalizeDelta, legacyDeltaIssue, removeSecret, reopenSecret, resolveSecret } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { continuityNoteText, markContinuitySent, prepareContinuityNote, setConflictStatus } from './continuity';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { buildSummaryPrompt, fmtSecrets, RULE_CONFLICTS, RULE_SECRETS, SUMMARY_PROMPT } from './prompts';
import { memory, recomputeDerived } from './store';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import { createEmptyMemory, type StoredDelta } from './types';

const original = {
  injection: { ...settings.apiSettings.injection },
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
};
let seq = 0;
const message = (delta: StoredDelta = {}, mes = '两人在旧街说话。'): STMessage => ({
  name: '洛伊', is_user: false, is_system: false, mes,
  extra: { bbs_leaf: { id: `sec-${++seq}`, text: '旧街谈话', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const slots = new Map<string, string>();
function useChat(chat: STMessage[]) {
  const ctx = {
    chat, chatMetadata: {}, name1: '沈遥', name2: '洛伊',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'secret-test', setExtensionPrompt: (key: string, value: string) => { slots.set(key, value); },
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const secretAdd = { content: '沈遥收到了一封没有署名的信', knownBy: ['沈遥'], unaware: ['洛伊'] };

beforeEach(() => {
  vi.useFakeTimers();
  slots.clear();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.prompts.summary = '';
  settings.apiSettings.vector.enabled = false;
  settings.apiSettings.summaryOnlyMode = false;
  Object.assign(settings.apiSettings.injection, { npcs: true, scenes: true, secrets: true });
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
});

describe('信息差：固化与重放', () => {
  it('短序号翻成稳定 id，名单清洗去重，找不到的编号丢弃', () => {
    const open = [{ id: 'secret:a#0' }, { id: 'secret:b#0' }];
    const stored = finalizeDelta({
      secrets: {
        add: [{ content: ' 信藏在钟塔 ', knownBy: ['沈遥', '沈遥', ' '], unaware: ['洛伊'] }, { content: '' } as never],
        update: [{ id: 's2', knownBy: ['沈遥', '洛伊'], unaware: [] }, { id: 's9', unaware: ['梅芙'] }],
        resolve: ['s1', 'p1'],
      },
    }, [], [], open);
    expect(stored.secrets).toEqual({
      add: [{ content: '信藏在钟塔', knownBy: ['沈遥'], unaware: ['洛伊'] }],
      update: [{ id: 'secret:b#0', knownBy: ['沈遥', '洛伊'], unaware: [] }],
      resolve: ['secret:a#0'],
    });
  });

  it('按楼层顺序重放：新增、得知后更新名单、结案；手动删除与重开', () => {
    const first = message({ secrets: { add: [secretAdd] } });
    const id = `secret:${first.extra!.bbs_leaf!.id}#0`;
    const second = message({ secrets: { update: [{ id, knownBy: ['沈遥', '洛伊'], unaware: ['梅芙'] }] } });
    useChat([first, second]);
    expect(memory.secrets).toMatchObject([{ id, status: 'open', knownBy: ['沈遥', '洛伊'], unaware: ['梅芙'] }]);
    expect(resolveSecret(id)).toBe(true);
    expect(memory.secrets[0].status).toBe('resolved');
    expect(reopenSecret(id)).toBe(true);
    expect(memory.secrets[0].status).toBe('open');
    expect(removeSecret(id)).toBe(true);
    expect(memory.secrets).toEqual([]);
    expect(deriveMemory([first]).secrets).toHaveLength(1);
  });

  it('旧数据转换认得 secrets 字段', () => {
    expect(legacyDeltaIssue({ secrets: { add: [secretAdd], resolve: ['secret:x#0'] } })).toBeNull();
    expect(legacyDeltaIssue({ secrets: { archive: ['x'] } })).toContain('secrets.archive');
  });
});

describe('信息差：提示词与注入', () => {
  it('摘要提示词带规则和编号列表；自定义模板缺规则时补协议', () => {
    expect(SUMMARY_PROMPT).toContain('【信息差规则】');
    expect(SUMMARY_PROMPT).toContain('【记录冲突规则】');
    expect(fmtSecrets([{ content: '信藏在钟塔', knownBy: ['沈遥'], unaware: ['洛伊', '梅芙'] }])).toBe('  s1. 信藏在钟塔(知情:沈遥;不知情:洛伊、梅芙)');
    const args: Parameters<typeof buildSummaryPrompt>[0] = {
      user: '沈遥', char: '洛伊', time: '', location: '', protagonist: {}, sceneFocus: null, lifeDetails: [], items: [], itemLog: [],
      scenes: [], npcs: [], openPlans: [], resolvedPlans: [], history: '', content: '正文', hasTimeTags: true,
      varsState: {}, varsMeaning: '', varsRule: '', secrets: [{ content: '信藏在钟塔', knownBy: ['沈遥'], unaware: ['洛伊'] }],
    };
    expect(buildSummaryPrompt(args).user).toContain('s1. 信藏在钟塔');
    settings.apiSettings.prompts.summary = '只写一句摘要。{{content}}';
    const custom = buildSummaryPrompt(args);
    expect(custom.system).toContain(RULE_SECRETS.replace('{{user}}', '沈遥'));
    expect(custom.system).toContain(RULE_CONFLICTS);
    expect(custom.user).toContain('【信息差(本轮之前');
  });

  it('只提醒在场的不知情者；主角始终在场；结案和关闭开关后不注入', () => {
    const chat = [message({
      npcs: { add: [{ name: '洛伊', follow: true }, { name: '梅芙', location: '港口' }] },
      location: '旧街',
      secrets: { add: [secretAdd, { content: '梅芙知道船期', knownBy: ['洛伊'], unaware: ['梅芙'] }, { content: '洛伊藏了钥匙', knownBy: ['洛伊'], unaware: ['沈遥'] }] },
    })];
    useChat(chat);
    const text = inject.buildStateInjectionText();
    expect(text).toContain('[信息差·保持人物视角]');
    expect(text).toContain('- 洛伊不知道:沈遥收到了一封没有署名的信(知情:沈遥)');
    expect(text).toContain('- 沈遥不知道:洛伊藏了钥匙');
    expect(text).not.toContain('梅芙知道船期');
    settings.apiSettings.injection.secrets = false;
    expect(inject.buildStateInjectionText()).not.toContain('信息差');
  });

  it('不知情者有在场角色的排在前面,其余新的在前;超过上限时注明另有几条未列出', () => {
    const old = message({
      npcs: { add: [{ name: '洛伊', follow: true }] },
      location: '旧街',
      secrets: { add: Array.from({ length: inject.SECRET_INJECT_LIMIT }, (_, i) => ({ content: `瞒着主角的旧事${i}`, knownBy: ['洛伊'], unaware: ['沈遥'] })) },
    });
    const recent = message({ secrets: { add: [
      { content: '瞒着主角的新事', knownBy: ['洛伊'], unaware: ['沈遥'] },
      { content: '洛伊不知道的事', knownBy: ['沈遥'], unaware: ['洛伊'] },
    ] } });
    useChat([old, recent]);
    const lines = inject.buildStateInjectionText().split('\n').filter(l => l.startsWith('- ') && l.includes('不知道:'));
    expect(lines).toHaveLength(inject.SECRET_INJECT_LIMIT);
    expect(lines[0]).toBe('- 洛伊不知道:洛伊不知道的事(知情:沈遥)');
    expect(lines[1]).toBe('- 沈遥不知道:瞒着主角的新事(知情:洛伊)');
    expect(inject.buildStateInjectionText()).toContain('- 另有 2 条信息差未列出,不代表已被知晓');
  });
});

describe('信息差与记录冲突：实际摘要（本地 mock 模型回复）', () => {
  it('解析后叶子保存信息差和有原文依据的冲突，下一楼提示词带 s1', async () => {
    const second = message({}, '洛伊换上了便服，跟着沈遥走出门。');
    delete second.extra!.bbs_leaf;
    const chat = [message({ npcs: { add: [{ name: '洛伊', outfit: '制服', follow: true }] } }), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '沈遥把信藏进口袋，洛伊跟着出门。', stateChanges: ['secrets'], timeStart: '2031/5/8 16:00', timeEnd: '2031/5/8 16:10',
      secrets: { add: [secretAdd] },
      conflicts: [
        { about: '洛伊的着装', record: '制服', text: '洛伊换上了便服' },
        { about: '编造的冲突', record: '甲', text: '正文里没有这句' },
      ],
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain('【信息差规则】');
    const leaf = chat[1].extra!.bbs_leaf!;
    expect(leaf.conflicts).toEqual([{ about: '洛伊的着装', record: '制服', text: '洛伊换上了便服' }]);
    expect(leaf.delta.secrets?.add?.[0].content).toBe(secretAdd.content);
    expect(memory.secrets.map(s => s.id)).toEqual([`secret:${leaf.id}#0`]);
  });

  it('内置模板输出了 secrets 但旧清单没写时照常保存(状态清单已停用)', () => {
    const d = parseSummaryResponse(JSON.stringify({ summary: '摘要', stateChanges: [], secrets: { add: [secretAdd] } }), {
      builtin: true, sourceTexts: ['正文'], finalize: v => finalizeDelta(v, []),
    });
    expect(d.secrets?.add?.[0].content).toBe(secretAdd.content);
    expect(() => parseSummaryResponse(JSON.stringify({ summary: '摘要', secrets: { add: [{ knownBy: ['甲'] }] } }), {
      builtin: true, sourceTexts: ['正文'], finalize: v => finalizeDelta(v, []),
    })).toThrow(SummaryResponseError);
  });
});

describe('记录冲突：连续性提醒', () => {
  it('选「提醒正文模型」后下一次生成注入一次，回复到达后标为已提醒并清空', () => {
    const chat = [message({}, '洛伊换上了便服。')];
    chat[0].extra!.bbs_leaf!.conflicts = [{ about: '洛伊的着装', record: '制服', text: '洛伊换上了便服' }];
    useChat(chat);
    expect(continuityNoteText()).toBe('');
    expect(setConflictStatus(0, 0, 'pending')).toBe(true);
    expect(slots.get('prism_book_continuity_note')).toContain('洛伊的着装:按「制服」继续,不沿用「洛伊换上了便服」');
    prepareContinuityNote('quiet');
    markContinuitySent();
    expect(chat[0].extra!.bbs_leaf!.conflicts![0].status).toBe('pending');
    prepareContinuityNote('normal');
    markContinuitySent();
    expect(chat[0].extra!.bbs_leaf!.conflicts![0].status).toBe('reminded');
    expect(slots.get('prism_book_continuity_note')).toBe('');
    expect(setConflictStatus(0, 5, 'ignored')).toBe(false);
  });
});

describe('信息差：带数据创建新对话', () => {
  it('只带未结案的信息差，窗口内的引用改到种子叶上', async () => {
    settings.apiSettings.keepRecent = 1;
    const first = message({ secrets: { add: [secretAdd, { content: '已结案的事', unaware: ['洛伊'] }] } });
    const [openId, doneId] = [0, 1].map(i => `secret:${first.extra!.bbs_leaf!.id}#${i}`);
    const middle = message({ secrets: { resolve: [doneId] } });
    const last = message({ secrets: { update: [{ id: openId, knownBy: ['沈遥', '洛伊'], unaware: [] }] } });
    const source = useChat([first, middle, last]);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'secret-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    const carried = deriveMemory(target.chat).secrets;
    expect(carried.map(s => [s.content, s.status, s.knownBy])).toEqual([[secretAdd.content, 'open', ['沈遥', '洛伊']]]);
  });
});
