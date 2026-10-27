import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import * as client from '@/api/client';
import * as notices from '@/st/toast';
import type { ApiChannel } from '@/api/settings';
import type { STContext, STMessage } from '@/st/context';
import { currentSummaryPromise, summarizeFloor } from './engine';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

const saved = JSON.stringify(settings.apiSettings);
const channel = (model: string): ApiChannel => ({
  id: 'ch', name: '渠道', url: 'https://relay.example/v1', key: 'k', model, temperature: 1,
  maxTokens: 4096, timeoutSec: 60, stream: false, prefill: true, excludeParams: [], reasoningEffort: '',
});
const ai = (text: string): STMessage => ({ name: '角色', is_user: false, is_system: false, mes: text, extra: {} });
const user = (text: string): STMessage => ({ name: '林舟', is_user: true, is_system: false, mes: text, extra: {} });
const reply = JSON.stringify({ summary: '林舟推门出发。', stateChanges: [] });
let chat: STMessage[];
let main: { mainApi: string; onlineStatus: string; model: string };

function useChat() {
  chat = [user('出发吧。'), ai('林舟推开门，雨已经停了。')];
  const ctx = { chat, name1: '林舟', name2: '角色', getCurrentChatId: () => 'model-test', chatMetadata: {},
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext;
  // 主界面的连接状态在发请求时读取:聊天补全的 onlineStatus 只是状态文字,模型名从 getChatCompletionModel 取
  vi.spyOn(context, 'getContext').mockImplementation(() => ({
    ...ctx, mainApi: main.mainApi, onlineStatus: main.onlineStatus, getChatCompletionModel: () => main.model,
  }) as unknown as STContext);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  recomputeDerived();
}
const systems = (messages: { role: string; content: string }[]) => messages.filter(m => m.role === 'system').map(m => m.content).join('\n');

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(settings.apiSettings, { summaryOnlyMode: false, verbosity: 'detailed', summaryMaxRetries: 0, leafBatchThreshold: 100 });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  settings.apiSettings.vector.enabled = false;
  main = { mainApi: 'openai', onlineStatus: 'Valid', model: '' };
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(settings.apiSettings, JSON.parse(saved));
});

describe('按模型决定是否发送内容边界', () => {
  it('副 API 渠道为 DeepSeek 时不发内容边界，其他模型照发', async () => {
    useChat();
    const send = vi.spyOn(client, 'requestCompletion').mockResolvedValue(reply);
    let model = 'deepseek-chat';
    vi.spyOn(settings, 'getChannelForTask').mockImplementation(() => channel(model));

    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[0][1])).not.toContain('【内容边界');
    expect(chat[1].extra?.bbs_leaf?.text).toBe('林舟推门出发。');

    model = 'qwen3-32b';
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[1][1])).toContain('【内容边界');
  });

  it('跟随主 API（聊天补全）时按当前选中的模型判断，不看连接状态文字', async () => {
    vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
    const send = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(reply);

    main = { mainApi: 'openai', onlineStatus: 'Status check bypassed', model: 'deepseek-v4-pro' };
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[0][0])).not.toContain('【内容边界');

    main = { mainApi: 'openai', onlineStatus: 'Valid', model: 'google/gemini-4-argon' };
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[1][0])).toContain('【内容边界');
  });

  it('跟随主 API（文本补全）时按连接状态里的模型名判断', async () => {
    vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
    const send = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(reply);

    main = { mainApi: 'textgenerationwebui', onlineStatus: 'deepseek-r1:14b', model: '' };
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[0][0])).not.toContain('【内容边界');

    main = { mainApi: 'textgenerationwebui', onlineStatus: 'no_connection', model: '' };
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[1][0])).toContain('【内容边界');
  });
});

describe('内容边界设置', () => {
  it('始终发送时 DeepSeek 渠道也带内容边界，不发送时其他模型也不带', async () => {
    useChat();
    const send = vi.spyOn(client, 'requestCompletion').mockResolvedValue(reply);
    let model = 'deepseek-chat';
    vi.spyOn(settings, 'getChannelForTask').mockImplementation(() => channel(model));

    settings.apiSettings.contentBoundary = 'always';
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[0][1])).toContain('【内容边界');

    settings.apiSettings.contentBoundary = 'never';
    model = 'qwen3-32b';
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[1][1])).not.toContain('【内容边界');
    expect(chat[1].extra?.bbs_leaf?.text).toBe('林舟推门出发。');
  });

  it('跟随主 API 时同样按设置，不看当前选中的模型', async () => {
    vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
    const send = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(reply);

    settings.apiSettings.contentBoundary = 'always';
    main = { mainApi: 'openai', onlineStatus: 'Valid', model: 'deepseek-v4-pro' };
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[0][0])).toContain('【内容边界');

    settings.apiSettings.contentBoundary = 'never';
    main = { mainApi: 'openai', onlineStatus: 'Valid', model: 'google/gemini-4-argon' };
    useChat();
    await summarizeFloor(1);
    expect(systems(vi.mocked(send).mock.calls[1][0])).not.toContain('【内容边界');
  });

  it('选「不发送」时自定义模板里自己写的内容边界照常发送', async () => {
    useChat();
    const send = vi.spyOn(client, 'requestCompletion').mockResolvedValue(reply);
    vi.spyOn(settings, 'getChannelForTask').mockReturnValue(channel('qwen3-32b'));
    settings.apiSettings.contentBoundary = 'never';
    settings.apiSettings.prompts.summary = '【内容边界(自定义)】只记录必要事实。\n{{content}}';
    await summarizeFloor(1);
    const sent = vi.mocked(send).mock.calls[0][1].map(m => m.content).join('\n');
    expect(sent).toContain('【内容边界(自定义)】');
    expect(sent).not.toContain('【内容边界(优先于其他规则)】');
  });
});
