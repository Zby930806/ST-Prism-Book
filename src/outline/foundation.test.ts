import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReactive, isRef } from 'vue';
import type { STContext, STMessage } from '@/st/context';
import type { OutlineContent } from './types';
import type { ViewNode } from '@/memory/select';
import * as host from '@/st/context';
import { notesSettings, settingsIssue as notesIssue, hydrateNotesSettings, NOTES_SETTINGS_KEY } from '@/notes/settings';
import { selectHistoryNodesBefore, renderHistoryNodes } from '@/memory/inject';
import { memoryWriteIssue } from '@/memory/store';
import { outlineSettings, outlineSettingsIssue, hydrateOutlineSettings, saveOutlineSettings, resolveOutlineChannel, OUTLINE_SETTINGS_KEY } from './settings';
import { parseOutlineReply, validateOutlineContent } from './protocol';
import { buildOutlineContext } from './context';
import { OUTLINE_PROMPT } from './prompt';
import { OUTLINE_LIMITS as L } from './limits';
import { renderOutlineGuidance } from './injection';
import type { OutlineActive } from './types';

// 仅 mock 外部边界；四个大纲模块、札记设置和正文清洗均使用真实实现。
const boundary = vi.hoisted(() => ({
  guardMemory: false,
  memory: { summaries: [], state: { location: '现有地点' }, protagonist: {}, npcs: [], items: [], scenes: [], plans: [], lifeDetails: [], vars: {} },
}));
vi.mock('@/memory/store', () => ({
  memory: new Proxy(boundary.memory, {
    get(target, key) {
      if (boundary.guardMemory) throw new Error('保护期禁止读取任何记忆字段');
      return Reflect.get(target, key);
    },
    set() { throw new Error('禁止写记忆'); },
  }),
  memoryWriteIssue: vi.fn(() => ''),
}));
vi.mock('@/memory/inject', () => ({ selectHistoryNodesBefore: vi.fn(() => []), renderHistoryNodes: vi.fn(() => '') }));
vi.mock('@/api/settings', () => ({ apiSettings: { customStripTags: [], channels: [{ url: 'https://forbidden.invalid', model: '禁止回退' }] } }));

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function content(): OutlineContent {
  return { title: '远行的可能性', premise: '在既有事实基础上规划后续选择。', constraints: ['不得替用户作决定'],
    chapters: [{ title: '了解局势', goal: '获得足够线索供用户选择', approach: '通过调查揭示人物动机，根据用户决定选择继续追问或暂缓行动。', beats: ['提供可核实的线索', '保留不同选择的后续方向'], exitCriteria: '用户取得足够信息并自行决定下一步' }] };
}
function message(mes: string, fields: Partial<STMessage> = {}): STMessage {
  return { name: '角色', is_user: false, is_system: false, mes, ...fields };
}
function makeContext(): STContext {
  return {
    chat: [message('已发生的正文'), message('最新约束', { is_user: true })],
    chatMetadata: {}, extensionSettings: {}, name1: '用户', name2: '角色', characterId: 0,
    characters: [{ name: '角色', avatar: 'role.png', description: '角色设定' }],
    getCurrentChatId: () => 'outline-test', saveSettingsDebounced: vi.fn(),
    saveMetadata: vi.fn(), saveMetadataDebounced: vi.fn(), saveChat: vi.fn(), setExtensionPrompt: vi.fn(),
    generateRaw: vi.fn(() => { throw new Error('禁止正文 API'); }),
  } as unknown as STContext;
}
function node(text: string, level = 1): ViewNode {
  return { id: text.slice(0, 8), kind: level ? 'comp' : 'leaf', level, text, childIds: [], msgIndex: -1, createdAt: 1, active: true };
}
let ctx: STContext;
beforeEach(() => {
  ctx = makeContext();
  vi.spyOn(host, 'getContext').mockReturnValue(ctx);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('禁止真实网络'); }));
  boundary.guardMemory = false;
  boundary.memory.state.location = '现有地点';
  vi.mocked(memoryWriteIssue).mockReturnValue('');
  vi.mocked(selectHistoryNodesBefore).mockReset().mockReturnValue([]);
  vi.mocked(renderHistoryNodes).mockReset().mockImplementation(nodes => nodes.map(n => n.text).join('\n\n'));
  hydrateNotesSettings(); hydrateOutlineSettings();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  boundary.guardMemory = false;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('独立大纲设置与渠道边界', () => {
  function configure() {
    Object.assign(notesSettings.channel, { url: 'https://notes.example.invalid/v1', model: 'notes-model', key: 'notes-secret', excludeParams: ['top_p'] });
    Object.assign(outlineSettings.channel, { url: 'http://localhost:9000/v1', model: 'outline-model', key: 'outline-secret', excludeParams: ['seed'] });
  }
  it('响应式默认值与独立存储键正确，hydrate 不保存', () => {
    expect(isReactive(outlineSettings)).toBe(true); expect(isRef(outlineSettingsIssue)).toBe(true);
    expect(OUTLINE_SETTINGS_KEY).toBe('prism_book_outline_settings');
    expect(outlineSettings.apiMode).toBe('notes');
    expect(outlineSettings.channel).toMatchObject({ url: '', key: '', model: '', temperature: 0.7, maxTokens: 6000, timeoutSec: 180, stream: true });
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
  it('札记未启用仍只复用札记 channel，并返回隔离副本', () => {
    configure(); notesSettings.enabled = false;
    const before = copy(notesSettings);
    const resolved = resolveOutlineChannel();
    expect(resolved).toEqual(notesSettings.channel);
    resolved.key = 'changed'; resolved.excludeParams.push('temperature');
    expect(notesSettings).toEqual(before);
  });
  it('independent 只读自己的渠道，不受札记异常影响，不修改任一源', () => {
    configure(); outlineSettings.apiMode = 'independent'; notesIssue.value = '札记只读';
    const before = copy(outlineSettings);
    const resolved = resolveOutlineChannel();
    expect(resolved.model).toBe('outline-model');
    resolved.excludeParams.push('max_tokens');
    expect(outlineSettings).toEqual(before);
  });
  it('notes 模式尊重札记保护，不使用有效的独立或摘要渠道兜底', () => {
    configure(); notesIssue.value = '设置版本未知';
    expect(() => resolveOutlineChannel()).toThrow('札记设置');
    notesIssue.value = ''; notesSettings.channel.url = '';
    expect(() => resolveOutlineChannel()).toThrow('不会改用正文或摘要');
    outlineSettings.apiMode = 'independent'; outlineSettings.channel.model = ' ';
    expect(() => resolveOutlineChannel()).toThrow('模型');
  });
  it.each(['file:///tmp/a', 'ftp://example.invalid', 'https://user:secret@example.invalid', 'https://@example.invalid', 'https://example.invalid?token=secret', 'https://example.invalid#part', 'https://example.invalid?', 'https://example.invalid#', 'https:example.invalid', 'not-a-url', 'https://exa mple.invalid', 'https://example.invalid\\path'])('拒绝不安全或无效地址 %s', url => {
    notesSettings.channel.url = url; notesSettings.channel.model = 'model';
    expect(() => resolveOutlineChannel()).toThrow(/API|HTTP/);
  });
  it('允许本地 HTTP 和无密钥渠道，规范 URL/model 空白', () => {
    Object.assign(notesSettings.channel, { url: ' http://localhost:5000/v1 ', model: ' m ', key: '' });
    expect(resolveOutlineChannel()).toMatchObject({ url: 'http://localhost:5000/v1', model: 'm', key: '' });
  });
  it('只保存独立 version1 key，保存与重新载入均无共享对象', () => {
    configure(); outlineSettings.apiMode = 'independent';
    const other = { version: 99, secret: 'untouched' };
    ctx.extensionSettings![NOTES_SETTINGS_KEY] = other;
    saveOutlineSettings();
    const stored = ctx.extensionSettings![OUTLINE_SETTINGS_KEY];
    expect(stored).toMatchObject({ version: 1, apiMode: 'independent', channel: { model: 'outline-model' } });
    expect(ctx.extensionSettings![NOTES_SETTINGS_KEY]).toBe(other);
    outlineSettings.channel.excludeParams.push('local');
    expect(stored).toMatchObject({ channel: { excludeParams: ['seed'] } });
    hydrateOutlineSettings(); expect(outlineSettings.channel.excludeParams).toEqual(['seed']);
    expect(ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
  });
  it.each([2, 0, '1', undefined])('未知版本 %s 保护读取和写入，原对象不动', version => {
    const raw = { version, apiMode: 'independent', channel: { url: 'do-not-read' } };
    ctx.extensionSettings![OUTLINE_SETTINGS_KEY] = raw;
    hydrateOutlineSettings();
    expect(outlineSettings.channel.url).toBe(''); expect(outlineSettingsIssue.value).toContain('只读');
    expect(() => saveOutlineSettings()).toThrow('保护'); expect(() => resolveOutlineChannel()).toThrow('保护');
    expect(ctx.extensionSettings![OUTLINE_SETTINGS_KEY]).toBe(raw);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
  it.each([[], 'bad', { version: 1, apiMode: 'main', channel: {} }, { version: 1, apiMode: 'notes', channel: [] }])('损坏设置同样保护 %#', raw => {
    ctx.extensionSettings![OUTLINE_SETTINGS_KEY] = raw; hydrateOutlineSettings();
    expect(() => saveOutlineSettings()).toThrow('保护');
  });
  it('保存前重查版本，防止 hydrate 后覆盖新版数据', () => {
    ctx.extensionSettings![OUTLINE_SETTINGS_KEY] = { version: 8 };
    expect(() => saveOutlineSettings()).toThrow('版本');
    expect(ctx.extensionSettings![OUTLINE_SETTINGS_KEY]).toEqual({ version: 8 });
  });
  it('同步保存失败恢复原存储引用与响应式已保存值，并允许重试', () => {
    configure(); saveOutlineSettings();
    const previous = ctx.extensionSettings![OUTLINE_SETTINGS_KEY];
    const snapshot = copy(outlineSettings);
    outlineSettings.channel.model = 'unsaved'; outlineSettings.apiMode = 'independent';
    vi.mocked(ctx.saveSettingsDebounced!).mockImplementationOnce(() => { throw new Error('secret storage text'); });
    expect(() => saveOutlineSettings()).toThrow('已回滚');
    expect(ctx.extensionSettings![OUTLINE_SETTINGS_KEY]).toBe(previous); expect(outlineSettings).toEqual(snapshot);
    expect(outlineSettingsIssue.value).not.toContain('secret');
    saveOutlineSettings(); expect(outlineSettingsIssue.value).toBe('');
  });
  it('首次保存失败删除新 key，不写 notes，并回滚默认值', () => {
    outlineSettings.apiMode = 'independent';
    vi.mocked(ctx.saveSettingsDebounced!).mockImplementation(() => { throw new Error('failed'); });
    expect(() => saveOutlineSettings()).toThrow('回滚');
    expect(ctx.extensionSettings).toEqual({}); expect(outlineSettings.apiMode).toBe('notes');
  });
  it('宿主未就绪不落盘', () => {
    vi.mocked(host.getContext).mockReturnValue(null);
    expect(() => saveOutlineSettings()).toThrow('未就绪');
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
});

describe('严格大纲内容与回复协议', () => {
  it('规范空白并返回深层独立副本', () => {
    const input = content(); input.title = '  标题\n'; input.chapters[0].beats[0] = ' 节点 ';
    const output = validateOutlineContent(input);
    expect(output.title).toBe('标题'); expect(output.chapters[0].beats[0]).toBe('节点');
    output.chapters[0].beats.push('new'); output.constraints.push('new');
    expect(input.chapters[0].beats).toHaveLength(2); expect(input.constraints).toHaveLength(1);
  });
  it('支持裸 JSON、一个 JSON 围栏及闭合 think/thinking，不改变 JSON 字符串内容', () => {
    const value = content(); value.premise = '文本中的 <think>字面内容</think> 保留';
    const json = JSON.stringify(value);
    expect(parseOutlineReply(json)).toEqual(value);
    expect(parseOutlineReply('<think>私密推理</think>\n```json\n' + json + '\n```\n<thinking>尾部思考</thinking>')).toEqual(value);
  });
  it.each([
    (s: string) => '正文不应混入' + s,
    (s: string) => s + '正文不应混入',
    (s: string) => s + s,
    (s: string) => '```json\n' + s + '\n```\n```json\n' + s + '\n```',
    (s: string) => '<think>没有闭合' + s,
    (s: string) => '```javascript\n' + s + '\n```',
  ])('不从混合回复中捞取 JSON %#', wrap => {
    expect(() => parseOutlineReply(wrap(JSON.stringify(content())))).toThrow('大纲格式无效');
  });
  it.each(['enabled', 'currentChapter', 'state', 'id', '__proto__', 'unknown'])('拒绝根或章节额外字段 %s', key => {
    const root = { ...content(), [key]: true };
    expect(() => validateOutlineContent(root)).toThrow();
    const nested = content(); Object.defineProperty(nested.chapters[0], key, { value: true, enumerable: true });
    expect(() => validateOutlineContent(nested)).toThrow();
  });
  it.each([
    ['title', L.title], ['premise', L.premise], ['constraints.0', L.constraint],
    ['chapters.0.title', L.title], ['chapters.0.goal', L.goal], ['chapters.0.approach', L.approach], ['chapters.0.beats.0', L.beat], ['chapters.0.exitCriteria', L.exitCriteria],
  ] as const)('%s 的下界、上界与错误类型', (path, limit) => {
    function sample(value: unknown) {
      const root = content(); const parts = path.split('.');
      let parent: any = root;
      for (const key of parts.slice(0, -1)) parent = parent[key];
      parent[parts.at(-1)!] = value; return root;
    }
    expect(() => validateOutlineContent(sample('字'))).not.toThrow();
    expect(() => validateOutlineContent(sample('字'.repeat(limit)))).not.toThrow();
    for (const value of ['', ' \n ', '字'.repeat(limit + 1), null, 42, {}, []]) expect(() => validateOutlineContent(sample(value))).toThrow();
  });
  it('数组数量边界、空洞和缺失必填字段均严格校验', () => {
    const value = content(); value.constraints = []; expect(() => validateOutlineContent(value)).not.toThrow();
    value.constraints = Array(12).fill('约束'); value.chapters = Array.from({ length: 12 }, () => content().chapters[0]);
    value.chapters[0].beats = Array(8).fill('节点'); expect(() => validateOutlineContent(value)).not.toThrow();
    value.constraints.push('溢出'); expect(() => validateOutlineContent(value)).toThrow(); value.constraints = [];
    value.chapters.push(content().chapters[0]); expect(() => validateOutlineContent(value)).toThrow();
    value.chapters = []; expect(() => validateOutlineContent(value)).toThrow();
    value.chapters = [content().chapters[0]]; value.chapters[0].beats = []; expect(() => validateOutlineContent(value)).toThrow();
    value.chapters[0].beats = Array(9).fill('节点'); expect(() => validateOutlineContent(value)).toThrow();
    value.chapters[0].beats = new Array(1); expect(() => validateOutlineContent(value)).toThrow();
    const { title: _title, ...missing } = content(); expect(() => validateOutlineContent(missing)).toThrow();
    const noApproach = content(); delete (noApproach.chapters[0] as Partial<typeof noApproach.chapters[0]>).approach;
    expect(() => validateOutlineContent(noApproach)).toThrow();
    expect(() => validateOutlineContent(Object.create(content()))).toThrow();
    expect(() => validateOutlineContent(null)).toThrow();
  });
  it('总 JSON 严守48000，包括未规范化空白；raw reply 严守100000', () => {
    const value = content(); value.chapters = Array.from({ length: 4 }, () => ({ ...content().chapters[0], beats: Array(8).fill('字'.repeat(L.beat)) }));
    expect(() => validateOutlineContent(value)).toThrow();
    const json = JSON.stringify(content());
    expect(() => parseOutlineReply(json + ' '.repeat(L.reply - json.length))).not.toThrow();
    expect(() => parseOutlineReply(json + ' '.repeat(L.reply + 1 - json.length))).toThrow(String(L.reply));
    const base = content(); const size = JSON.stringify(base).length;
    base.title += ' '.repeat(L.json - size);
    expect(() => validateOutlineContent(base)).not.toThrow();
    base.title += ' '; expect(() => validateOutlineContent(base)).toThrow();
    expect(() => parseOutlineReply(JSON.stringify(base))).toThrow(String(L.json));
    const padded = '{' + ' '.repeat(L.json) + json.slice(1); expect(() => parseOutlineReply(padded)).toThrow();
  });
  it('错误不回显原文、字段名或底层异常', () => {
    for (const value of ['TOP_SECRET_RAW', '{"TOP_SECRET_KEY":1}', JSON.stringify({ ...content(), title: 'TOP_SECRET_RAW'.repeat(100) })]) {
      try { parseOutlineReply(value); throw new Error('未拒绝'); } catch (error) {
        expect((error as Error).message).toContain('大纲'); expect((error as Error).message).not.toContain('TOP_SECRET');
      }
    }
    const circular: any = content(); circular.chapters = [circular];
    expect(() => validateOutlineContent(circular)).toThrow('大纲格式无效');
  });
});

describe('放宽篇幅、角色连续性与安全诊断', () => {
  function active(value = content()): OutlineActive {
    return { id: 'fixture', createdAt: 1, sourceFloor: 0, sourceHash: 'fixture',
      brief: '通用创作要求', content: value, enabled: true, currentChapter: 0 };
  }
  it('内容上限翻倍，正文注入单独受限，不改变阶段数量', () => {
    expect(L).toMatchObject({ json: 48000, reply: 100000, injection: 16000, chapters: 12, beats: 8 });
    const value = content();
    value.premise = '前'.repeat(3000);
    value.constraints = ['约'.repeat(1000)];
    value.chapters = Array.from({ length: 10 }, () => ({
      ...content().chapters[0], approach: '动'.repeat(2000), beats: ['要'.repeat(1000)],
    }));
    expect(JSON.stringify(value).length).toBeGreaterThan(24000);
    expect(parseOutlineReply(JSON.stringify(value))).toEqual(value);
    expect(renderOutlineGuidance(active(value)).length).toBeLessThan(L.injection);
  });
  it('闭合的无标签代码围栏仅作包装兼容，不修补残缺JSON', () => {
    const json = JSON.stringify(content());
    expect(parseOutlineReply('\x60\x60\x60\n' + json + '\n\x60\x60\x60')).toEqual(content());
    expect(() => parseOutlineReply(json.slice(0, -1))).toThrow('JSON 语法无效或不完整');
    expect(() => parseOutlineReply('<think>仅思考</think>')).toThrow('没有大纲 JSON');
  });
  it('提示具体已知字段路径，不回显错误文本和未知键', () => {
    const missing = content();
    delete (missing.chapters[0] as Partial<typeof missing.chapters[0]>).approach;
    expect(() => validateOutlineContent(missing)).toThrow('chapters[0].approach 缺失');
    const overflow = content(); overflow.chapters[0].approach = '密'.repeat(L.approach + 1);
    expect(() => validateOutlineContent(overflow)).toThrow('chapters[0].approach 超过3200');
    expect(() => validateOutlineContent(overflow)).toThrow('第1阶段·发展方式');
    const wrong = content(); wrong.chapters[0].beats = [];
    expect(() => validateOutlineContent(wrong)).toThrow('chapters[0].beats 应为1～8项的数组');
    expect(() => validateOutlineContent({ ...content(), TOP_SECRET: 'private' })).toThrow('存在不支持的字段');
    const accessor = content();
    Object.defineProperty(accessor, 'title', { get() { throw new Error('TOP_SECRET'); } });
    expect(() => validateOutlineContent(accessor)).toThrow('内容无法读取');
  });
  it('生成提示词提供有效结构示例，规则涵盖人物动机、有限知情与关系惯性', () => {
    const example = OUTLINE_PROMPT.slice(OUTLINE_PROMPT.lastIndexOf('\n') + 1);
    expect(() => parseOutlineReply(example)).not.toThrow();
    for (const phrase of ['欲望、顾虑、边界', '自己实际知道的信息', '情绪与关系有惯性', '不预先写死人物台词',
      '允许延后、变形或放弃节点', '不要为“活人感”强加', '不把所有人物反应压成标签']) {
      expect(OUTLINE_PROMPT).toContain(phrase);
    }
    expect(OUTLINE_PROMPT).toContain('总 JSON 不超过 48000');
  });
  it('正文规则不强制完成节点，不把人物说明变台词，不注入未来阶段', () => {
    const value = content();
    value.chapters.push({ ...value.chapters[0], title: '未来阶段专属标题', approach: '未来阶段专属发展' });
    const text = renderOutlineGuidance(active(value));
    for (const phrase of ['不要求每轮完成节点', '实际知情范围', '情绪与关系有惯性', '允许延后、调整或不兑现',
      '不要照抄规划中的动机说明当台词', '不得替用户角色', '保留原正文文风', '不凭空添加秘密或创伤']) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toContain('未来阶段专属');
    expect(renderOutlineGuidance({ ...active(value), enabled: false })).toBe('');
  });
  it('注入精确计入固定指引，达到16000可用，多1字符拒绝而非截断', () => {
    const value = content(); value.premise = '前'.repeat(L.premise);
    value.constraints = Array(8).fill('约'.repeat(L.constraint));
    const record = active(value);
    const remaining = L.injection - renderOutlineGuidance(record).length;
    expect(remaining).toBeGreaterThan(0);
    value.chapters[0].goal += '目'.repeat(remaining);
    expect(() => validateOutlineContent(value)).not.toThrow();
    expect(renderOutlineGuidance(record)).toHaveLength(L.injection);
    value.chapters[0].goal += '目';
    expect(() => validateOutlineContent(value)).not.toThrow();
    expect(() => renderOutlineGuidance(record)).toThrow('16000');
  });
});

describe('只读上下文与通用未来提示词', () => {
  it('只选最近八个有效楼层，清洗思考/札记/时间区间外正文，保留用户约束', () => {
    ctx.chat = Array.from({ length: 10 }, (_, i) => message(`楼层标记${i}结束`));
    ctx.chat[9] = message('<think>思考秘密</think>区间外前文<bbs_start>今天</bbs_start>正文事实<bbs_end>今天</bbs_end>区间外后文<aftertalk>札记秘密提案</aftertalk>');
    ctx.chat.push(message('内部秘密', { extra: { bbs_internal_notice: 'backlog' } }), message('番外秘密', { extra: { bbs_omit: true } }), message('独立注入秘密', { is_system: true }));
    const result = buildOutlineContext(ctx, '最新用户明确约束', 3);
    const recent = result[3].content;
    expect(recent).not.toContain('楼层标记1结束'); expect(recent).toContain('楼层标记2结束'); expect(recent).toContain('正文事实');
    expect(recent).not.toMatch(/思考秘密|札记秘密|区间外|内部秘密|番外秘密|独立注入秘密/);
    expect(result.at(-1)!.content).toContain('最新用户明确约束'); expect(result.at(-1)!.content).toContain('严格输出 3 个规划阶段');
    expect(result.at(-1)!.content).toContain('chapters 数组长度必须为 3');
    expect(result.at(-1)!.content).toContain('approach 发展方式');
    expect(selectHistoryNodesBefore).toHaveBeenCalledWith(boundary.memory.summaries, ctx.chat, 2);
  });
  it('允许被宝书隐藏的正文，不读札记记录、世界书或独立注入', () => {
    ctx.chat = [message('已隐藏正文事实', { is_system: true, extra: { bbs_hidden: true } })];
    for (const key of ['extensionPrompts', 'worldInfo', 'notesState']) Object.defineProperty(ctx, key, { get() { throw new Error('越界读取'); } });
    Object.defineProperty(ctx.chatMetadata, 'prism_book_notes_data', { get() { throw new Error('禁止札记'); } });
    expect(buildOutlineContext(ctx, '需求', 1)[3].content).toContain('已隐藏正文事实');
  });
  it('仅使用已有压缩节点，按顺序保留完整节点，不混入 L0', () => {
    const nodes = [node('早期L1'), node('不能混入的L0', 0), node('较近L2', 2)];
    vi.mocked(selectHistoryNodesBefore).mockReturnValue(nodes);
    const before = copy(nodes);
    const memory = buildOutlineContext(ctx, '需求', 2)[2].content;
    expect(memory).toContain('早期L1\n\n较近L2'); expect(memory).not.toContain('不能混入'); expect(memory).toContain('现有地点');
    expect(nodes).toEqual(before); expect(renderHistoryNodes).toHaveBeenCalledTimes(2);
  });
  it('保护期连 memory 属性也不读，不渲染压缩层，不泄漏保护诊断原文', () => {
    boundary.guardMemory = true; vi.mocked(memoryWriteIssue).mockReturnValue('敏感诊断详情');
    const result = buildOutlineContext(ctx, '需求', 1);
    expect(result[2].content).toContain('未读取'); expect(result[2].content).not.toContain('敏感诊断');
    expect(selectHistoryNodesBefore).not.toHaveBeenCalled(); expect(renderHistoryNodes).not.toHaveBeenCalled();
    expect(result[3].content).toContain('最新约束');
  });
  it('严格计入截断标记与分隔符：memory <=12000，recent <=24000，角色卡 <=3000', () => {
    ctx.chat = Array.from({ length: 8 }, () => message('文'.repeat(10000)));
    ctx.characters![0].description = '卡'.repeat(10000);
    boundary.memory.state.location = '状'.repeat(20000);
    vi.mocked(selectHistoryNodesBefore).mockReturnValue([node('旧'.repeat(8000)), node('近'.repeat(7700), 2)]);
    const result = buildOutlineContext(ctx, '需求', 12);
    expect(result[2].content.length).toBeLessThanOrEqual(12000);
    expect(result[2].content).not.toContain('旧'); expect(result[2].content).toContain('近'.repeat(7700));
    expect(result[3].content.length).toBeLessThanOrEqual(24000);
    expect(result[1].content.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(3000);
    expect(result[2].content).toContain('截断'); expect(result[3].content).toContain('截断');
  });
  it('无聊天及无角色卡时正常；群聊不误取第零张卡', () => {
    ctx.chat = []; ctx.characterId = ''; expect(buildOutlineContext(ctx, '需求', 1)[1].content).not.toContain('角色设定');
    ctx.characterId = 0; ctx.groupId = 'group'; expect(buildOutlineContext(ctx, '需求', 1)[1].content).not.toContain('角色设定');
  });
  it('不变更聊天、记忆及设置，不调用宿主写入或真实 API', () => {
    const before = copy({ chat: ctx.chat, metadata: ctx.chatMetadata, settings: ctx.extensionSettings, memory: boundary.memory });
    buildOutlineContext(ctx, '需求', 1);
    expect({ chat: ctx.chat, metadata: ctx.chatMetadata, settings: ctx.extensionSettings, memory: boundary.memory }).toEqual(before);
    for (const fn of [ctx.saveSettingsDebounced, ctx.saveMetadata, ctx.saveMetadataDebounced, ctx.saveChat, ctx.setExtensionPrompt, ctx.generateRaw]) expect(fn).not.toHaveBeenCalled();
  });
  it.each([0, 13, 1.5, NaN, Infinity])('拒绝无效章节数 %s', count => {
    expect(() => buildOutlineContext(ctx, '需求', count)).toThrow('规划阶段数量');
  });
  it('拒绝空需求，通用提示词明确未来/事实/主角自主性及禁止写状态', () => {
    expect(() => buildOutlineContext(ctx, '  ', 1)).toThrow('需求');
    expect(OUTLINE_PROMPT).toContain('尊重事实'); expect(OUTLINE_PROMPT).toContain('主角自主性');
    expect(OUTLINE_PROMPT).toContain('最新用户约束'); expect(OUTLINE_PROMPT).toContain('推进条件');
    expect(OUTLINE_PROMPT).toContain(`approach（发展方式，1..${L.approach} 字）`);
    expect(OUTLINE_PROMPT).toContain('必须严格输出本次指定数量的规划阶段');
    expect(OUTLINE_PROMPT).toContain('用户本次 input 优先'); expect(OUTLINE_PROMPT).toContain('人物动机及可选发展');
    expect(OUTLINE_PROMPT).toContain('不写入 memory.plans 或正文 leaf');
    expect(OUTLINE_PROMPT).toContain('严禁把提案'); expect(OUTLINE_PROMPT).toContain('不输出状态更新');
    expect(OUTLINE_PROMPT).not.toMatch(/凝嘤嘤|远行的可能性|楼层标记/);
  });
});
