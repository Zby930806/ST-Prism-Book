import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReactive, isRef } from 'vue';
import type { STContext, STMessage } from '@/st/context';
import type { OutlineContent } from './types';
import type { ViewNode } from '@/memory/select';
import * as host from '@/st/context';
import { apiSettings } from '@/api/settings';
import { notesSettings, settingsIssue as notesIssue, hydrateNotesSettings, NOTES_SETTINGS_KEY } from '@/notes/settings';
import { selectHistoryNodesBefore, renderHistoryNodes } from '@/memory/inject';
import { memoryWriteIssue } from '@/memory/store';
import { outlineSettings, outlineSettingsIssue, hydrateOutlineSettings, saveOutlineSettings, resolveOutlineChannel, OUTLINE_SETTINGS_KEY } from './settings';
import { parseOutlineReply, validateOutlineContent } from './protocol';
import { buildOutlineContext } from './context';
import { OUTLINE_PROMPT } from './prompt';
import { OUTLINE_LIMITS as L } from './limits';
import { outlineGuidanceLength, renderOutlineGuidance } from './injection';
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
vi.mock('@/api/settings', () => ({ apiSettings: { customStripTags: [], channels: [{ url: 'https://forbidden.invalid', model: '禁止回退' }], memoryBudgetTokens: 0 } }));

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
  apiSettings.memoryBudgetTokens = 0;
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
    expect(outlineSettings.channel).toMatchObject({ url: '', key: '', model: '', temperature: 0.7, maxTokens: 8000, timeoutSec: 180, stream: true });
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
  it('默认最大输出 8000；旧版保存时仍是默认 6000 的跟着新默认，改过的保留', () => {
    ctx.extensionSettings![OUTLINE_SETTINGS_KEY] = { version: 1, apiMode: 'independent', channel: { url: 'https://o.invalid/v1', model: 'm', maxTokens: 6000 } };
    hydrateOutlineSettings(); expect(outlineSettings.channel.maxTokens).toBe(8000);
    ctx.extensionSettings![OUTLINE_SETTINGS_KEY] = { version: 1, apiMode: 'independent', channel: { maxTokens: 5000 } };
    hydrateOutlineSettings(); expect(outlineSettings.channel.maxTokens).toBe(5000);
    ctx.extensionSettings![OUTLINE_SETTINGS_KEY] = { version: 1, apiMode: 'independent', defaultMaxTokens: 8000, channel: { maxTokens: 6000 } };
    hydrateOutlineSettings(); expect(outlineSettings.channel.maxTokens).toBe(6000);
    outlineSettings.channel.maxTokens = 12000; saveOutlineSettings();
    expect(ctx.extensionSettings![OUTLINE_SETTINGS_KEY]).toMatchObject({ version: 1, defaultMaxTokens: 8000, channel: { maxTokens: 12000 } });
    hydrateOutlineSettings(); expect(outlineSettings.channel.maxTokens).toBe(12000);
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
    expect(parseOutlineReply(json)).toEqual({ content: value, warnings: [] });
    expect(parseOutlineReply('<think>私密推理</think>\n```json\n' + json + '\n```\n<thinking>尾部思考</thinking>').content).toEqual(value);
  });
  it.each([
    (s: string) => '以下是规划：' + s,
    (s: string) => s + '\n以上规划供参考。',
    (s: string) => '```javascript\n' + s + '\n```',
    (s: string) => '先说明 {不是 JSON} 的写法：\n' + s,
    (s: string) => '思考到此为止</think>\n' + s,
  ])('与世界书相同的提取方式：跳过前后说明文字和代码围栏，取第一个完整的大纲 JSON %#', wrap => {
    expect(parseOutlineReply(wrap(JSON.stringify(content())))).toEqual({ content: content(), warnings: [] });
  });
  it('大纲被包在别的对象里（如 {"outline": {…}}）时照样取出，不误报「JSON 语法无效」', () => {
    const value = content();
    expect(parseOutlineReply(JSON.stringify({ outline: value }))).toEqual({ content: value, warnings: [] });
    expect(parseOutlineReply('结果如下：\n' + JSON.stringify({ result: { plan: value }, note: '仅供参考' }, null, 2))).toEqual({ content: value, warnings: [] });
    // 外层里放了两份大纲时仍无法确定用哪一个
    expect(() => parseOutlineReply(JSON.stringify({ old: value, new: value }))).toThrow('多个大纲 JSON');
  });
  it.each([
    [(s: string) => s + s, '多个大纲 JSON'],
    [(s: string) => '```json\n' + s + '\n```\n```json\n' + s + '\n```', '多个大纲 JSON'],
    [(s: string) => '<think>没有闭合' + s, '思考过程没有写完'],
    [(s: string) => s.slice(0, -1), 'JSON 语法无效或不完整'],
  ])('多个对象、没闭合的思考块和残缺 JSON 仍然拒绝 %#', (wrap, reason) => {
    expect(() => parseOutlineReply(wrap(JSON.stringify(content())))).toThrow(reason);
  });
  it('模型输出：忽略多余字段、超长文字截断、超出项数只保留前面的，并把调整写成警告；嵌在里面的阶段对象不会被当成大纲', () => {
    const value: any = { ...content(), enabled: true, TOP_SECRET_FIELD: 1 };
    value.title = '题'.repeat(L.title + 30);
    value.constraints = Array.from({ length: L.constraints + 2 }, (_, i) => `约束${i}`);
    value.chapters = [{ ...content().chapters[0], currentChapter: 3, approach: '方'.repeat(L.approach + 1), beats: Array.from({ length: L.beats + 2 }, (_, i) => `要点${i}`) }];
    const { content: parsed, warnings } = parseOutlineReply('```json\n' + JSON.stringify(value) + '\n```');
    expect(parsed.title).toHaveLength(L.title);
    expect(parsed.constraints).toHaveLength(L.constraints);
    expect(parsed.chapters[0].approach).toHaveLength(L.approach);
    expect(parsed.chapters[0].beats).toEqual(Array.from({ length: L.beats }, (_, i) => `要点${i}`));
    expect(parsed).not.toHaveProperty('enabled'); expect(parsed.chapters[0]).not.toHaveProperty('currentChapter');
    expect(warnings).toEqual(expect.arrayContaining([
      '忽略了回复中 3 个不支持的字段。', '规划标题超过240字，已截断。', '整体约束超过12条，只保留前12条。',
      '第1阶段·发展方式超过3200字，已截断。', '第1阶段的剧情要点超过8条，只保留前8条。',
    ]));
    expect(warnings.join()).not.toContain('TOP_SECRET');
    // 用户手动编辑保存仍用严格校验
    expect(() => validateOutlineContent(value)).toThrow('大纲格式无效');
  });
  it('缺少必填内容时照常报错，不凭空补齐；只有阶段对象的回复不当作大纲', () => {
    const noApproach: any = content(); delete noApproach.chapters[0].approach;
    expect(() => parseOutlineReply(JSON.stringify(noApproach))).toThrow('chapters[0].approach 缺失');
    expect(() => parseOutlineReply(JSON.stringify(content().chapters[0]))).toThrow('不是大纲');
    expect(() => parseOutlineReply(JSON.stringify({ ...content(), chapters: [] }))).toThrow('chapters 应为1～12项的数组');
    const noConstraints: any = content(); delete noConstraints.constraints;
    expect(parseOutlineReply(JSON.stringify(noConstraints))).toEqual({ content: { ...content(), constraints: [] }, warnings: ['回复没有 constraints（整体约束），按没有约束处理。'] });
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
    for (const value of ['TOP_SECRET_RAW', '{"TOP_SECRET_KEY":1}', JSON.stringify({ title: 'TOP_SECRET_RAW'.repeat(100), premise: 'TOP_SECRET_RAW' })]) {
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
    expect(parseOutlineReply(JSON.stringify(value)).content).toEqual(value);
    expect(renderOutlineGuidance(active(value)).length).toBeLessThan(L.injection);
  });
  it('闭合的无标签代码围栏仅作包装兼容，不修补残缺JSON', () => {
    const json = JSON.stringify(content());
    expect(parseOutlineReply('\x60\x60\x60\n' + json + '\n\x60\x60\x60').content).toEqual(content());
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
    // 按各推进节奏里最长的注入文字检查上限:切换节奏后也不会超出
    const remaining = L.injection - outlineGuidanceLength(record);
    expect(remaining).toBeGreaterThan(0);
    value.chapters[0].goal += '目'.repeat(remaining);
    expect(() => validateOutlineContent(value)).not.toThrow();
    expect(outlineGuidanceLength(record)).toBe(L.injection);
    expect(() => renderOutlineGuidance(record, 'slow')).not.toThrow();
    expect(renderOutlineGuidance(record, 'fast').length).toBeLessThanOrEqual(L.injection);
    value.chapters[0].goal += '目';
    expect(() => validateOutlineContent(value)).not.toThrow();
    expect(() => renderOutlineGuidance(record)).toThrow('16000');
  });
  it('推进节奏:默认适中;慢每轮最多一个要点,适中最多一到两个,快可以多个但不一轮写完整个阶段', () => {
    const record = active(content());
    const normal = renderOutlineGuidance(record);
    expect(normal).toBe(renderOutlineGuidance(record, 'normal'));
    expect(normal).toContain('每轮最多推进一到两个剧情要点，不在一轮写完所有要点，回复停在需要用户回应的地方');
    expect(normal).toContain('剧情要点（尚未发生；按顺序分多轮展开，每轮最多推进一到两个）');
    const slow = renderOutlineGuidance(record, 'slow');
    expect(slow).toContain('每轮最多推进一个剧情要点，也可以一个都不推进');
    expect(slow).toContain('每轮最多推进一个）');
    const fast = renderOutlineGuidance(record, 'fast');
    expect(fast).toContain('每轮可以推进多个剧情要点，但不在一轮写完整个阶段');
    expect(fast).not.toContain('回复停在需要用户回应的地方');
    for (const text of [slow, normal, fast]) expect(text).toContain('不提前执行后续阶段');
    // 生成规划时要求阶段经过多轮回复展开
    expect(OUTLINE_PROMPT).toContain('每个阶段要在正文中经过多轮回复才能逐步展开');
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
  it('允许被宝书隐藏的正文；构建上下文时不自行读取札记记录、世界书或独立注入（世界书与已确认安排由调用方传入）', () => {
    ctx.chat = [message('已隐藏正文事实', { is_system: true, extra: { bbs_hidden: true } })];
    for (const key of ['extensionPrompts', 'worldInfo', 'notesState']) Object.defineProperty(ctx, key, { get() { throw new Error('越界读取'); } });
    Object.defineProperty(ctx.chatMetadata, 'prism_book_notes_data', { get() { throw new Error('禁止札记'); } });
    expect(buildOutlineContext(ctx, '需求', 1)[3].content).toContain('已隐藏正文事实');
  });
  it('逐楼摘要（L0）和总结都带上，按时间顺序保留完整节点', () => {
    const nodes = [node('早期L1'), node('尚未压缩的逐楼摘要', 0), node('较近L2', 2)];
    vi.mocked(selectHistoryNodesBefore).mockReturnValue(nodes);
    const before = copy(nodes);
    const memory = buildOutlineContext(ctx, '需求', 2)[2].content;
    expect(memory).toContain('[已有的摘要和总结，按时间顺序]\n早期L1\n\n尚未压缩的逐楼摘要\n\n较近L2');
    expect(memory).toContain('当前地点：现有地点');
    expect(nodes).toEqual(before); expect(renderHistoryNodes).toHaveBeenCalledTimes(3);
  });
  it('状态改为紧凑文字：去掉内部 id 和时间戳，未了结的计划和悬念排在最前', () => {
    const original = copy(boundary.memory);
    Object.assign(boundary.memory, {
      plans: [
        { id: 'plan-secret-id', kind: 'plan', content: '月底前还清欠款', status: 'open', createdAt: 1700000000000, targetTime: '月底' },
        { id: 'plan-done-id', kind: 'suspense', content: '谁寄的信', status: 'resolved', createdAt: 1, resolvedAt: 2, outcome: 'done', resolvedReason: '查明是旧友' },
      ],
      items: [{ id: 'item-id', name: '旧怀表', qty: 1, desc: '停在三点', createdAt: 1, updatedAt: 2 }],
    });
    try {
      const memory = buildOutlineContext(ctx, '需求', 2)[2].content;
      const state = memory.slice(memory.indexOf('[当前状态'));
      expect(state.indexOf('[未了结的计划与悬念]')).toBeLessThan(state.indexOf('[时间、地点与局势]'));
      expect(state).toContain('- [计划] 月底前还清欠款（目标 月底）');
      expect(state).toContain('旧怀表 ×1 —— 停在三点');
      expect(state).toContain('谁寄的信');
      expect(memory).not.toMatch(/plan-secret-id|plan-done-id|item-id|1700000000000|createdAt|leafId/);
      expect(memory).not.toContain('{"');
    } finally {
      Object.assign(boundary.memory, original);
    }
  });
  it('保护期连 memory 属性也不读，不渲染压缩层，不泄漏保护诊断原文', () => {
    boundary.guardMemory = true; vi.mocked(memoryWriteIssue).mockReturnValue('敏感诊断详情');
    const result = buildOutlineContext(ctx, '需求', 1);
    expect(result[2].content).toContain('未读取'); expect(result[2].content).not.toContain('敏感诊断');
    expect(selectHistoryNodesBefore).not.toHaveBeenCalled(); expect(renderHistoryNodes).not.toHaveBeenCalled();
    expect(result[3].content).toContain('最新约束');
  });
  it('填写了记忆注入预算时：摘要与总结 7800、状态 4200，从新到旧连续保留并注明省略；最近正文 24000，角色卡 12000', () => {
    apiSettings.memoryBudgetTokens = 6000;
    ctx.chat = Array.from({ length: 8 }, () => message('文'.repeat(10000)));
    ctx.characters![0].description = '卡'.repeat(20000);
    boundary.memory.state.location = '状'.repeat(20000);
    vi.mocked(selectHistoryNodesBefore).mockReturnValue([node('旧'.repeat(100)), node('中'.repeat(7500)), node('近'.repeat(700), 2)]);
    const result = buildOutlineContext(ctx, '需求', 12);
    expect(result[2].content.length).toBeLessThanOrEqual(7800 + 4200);
    // 连续保留：最新的「近」放得下，「中」放不下就停，更早、更短的「旧」也不再跳过去取
    expect(result[2].content).toContain('近'.repeat(700));
    expect(result[2].content).not.toContain('中'.repeat(10)); expect(result[2].content).not.toContain('旧'.repeat(10));
    expect(result[2].content).toContain('更早的 2 条摘要和总结因字数上限省略');
    // 状态整条省略并注明，不在中间截断
    expect(result[2].content).not.toContain('状'.repeat(10));
    expect(result[2].content).toContain('因字数上限另有 1 条状态没有列出：时间地点与局势');
    expect(result[3].content.length).toBeLessThanOrEqual(24000);
    expect(result[1].content.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(12000);
    expect(result[1].content).toContain('截断'); expect(result[3].content).toContain('截断');
  });
  it('记忆注入预算为 0（默认）时摘要、总结和状态都不封顶', () => {
    vi.mocked(selectHistoryNodesBefore).mockReturnValue([node('旧'.repeat(8000)), node('近'.repeat(7700), 2)]);
    boundary.memory.state.location = '状'.repeat(20000);
    const memory = buildOutlineContext(ctx, '需求', 2)[2].content;
    expect(memory).toContain('旧'.repeat(8000)); expect(memory).toContain('近'.repeat(7700));
    expect(memory).toContain('状'.repeat(20000));
    expect(memory).not.toMatch(/省略|没有列出/);
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
