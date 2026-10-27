import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { STContext } from '@/st/context';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Rec = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** 每个用例用一份新的模块实例（设置模块只载入一次）。build 拿到默认设置后返回本机的 extension_settings。 */
async function setup(build: (defaults: Rec) => Rec) {
  vi.resetModules();
  const context = await import('@/st/context');
  const settings = await import('@/api/settings');
  const ext = build(clone(settings.apiSettings));
  const ctx = { chat: [], chatMetadata: {}, extensionSettings: ext, saveSettingsDebounced: vi.fn(), getCurrentChatId: () => '' } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  const win = { addEventListener: vi.fn(), dispatchEvent: vi.fn() };
  vi.stubGlobal('window', win);
  settings.hydrateSettings();
  const notes = await import('@/notes/settings');
  notes.hydrateNotesSettings();
  const outline = await import('@/outline/settings');
  outline.hydrateOutlineSettings();
  const backup = await import('./settingsBackup');
  return { ext, ctx, win, settings, notes, outline, backup };
}

const channel = (id: string, name: string, key: string) => ({
  id, name, url: `https://${id}.example/v1`, key, model: 'model-' + id, temperature: 1, maxTokens: 65535,
  timeoutSec: 180, stream: false, prefill: false, excludeParams: ['top_p'], reasoningEffort: '',
});

function localExt(defaults: Rec): Rec {
  const main = clone(defaults);
  main.wiPatternsSeeded = true;
  main.keepRecent = 5;
  main.memoryBudgetTokens = 8000;
  main.vector.recall.keywordRoute = false;
  main.vector.queryRewriteMaxTokens = 4096;
  main.vector.embedding.key = 'sk-embed-LOCAL';
  main.vector.rerank.key = 'sk-rerank-LOCAL';
  main.channels = [channel('ch-a', '摘要渠道', 'sk-a-LOCAL')];
  main.assignments = { summary: 'ch-a', resummary: '' };
  main.excludedChars = ['甲'];
  // 变量模板是用户内容：里面叫 key / token 的字段不是密钥
  main.varsGlobalTemplate = { json: { key: '铜钥匙', token: 3 }, meaning: '', rule: '' };
  return {
    baibai_book: main,
    baibai_api_channels: { schemaVersion: 1, revision: 3, channels: clone(main.channels) },
    baibai_exclude_settings: { schemaVersion: 1, revision: 1, excludedChars: ['甲'], excludedWorldNames: [], excludedWorldInfoPatterns: clone(main.excludedWorldInfoPatterns), customStripTags: [] },
    prism_book_notes_settings: {
      version: 1, defaultMaxTokens: 8000, enabled: true, autoGenerate: false, injectConfirmed: false, showInChat: true, recentFloors: 8, memoryChars: 12000,
      channel: { id: 'prism-notes-independent', name: '双子札记独立 API', url: 'https://notes.example/v1', key: 'sk-notes-LOCAL', model: 'notes-model', temperature: 0.8, maxTokens: 8000, timeoutSec: 180, stream: true, prefill: false, excludeParams: [], reasoningEffort: '' },
    },
    prism_book_outline_settings: {
      version: 1, apiMode: 'independent', progressCheck: { auto: false, interval: 3, autoAdvance: false },
      channel: { id: 'prism-outline-independent', name: '独立大纲 API', url: 'https://outline.example/v1', key: 'sk-outline-LOCAL', model: 'outline-model', temperature: 0.7, maxTokens: 6000, timeoutSec: 180, stream: true, prefill: false, excludeParams: [], reasoningEffort: '' },
    },
    other_extension: { key: 'sk-other-extension' },
    baibai_draw: { apiKey: 'sk-other-plugin' },
  };
}

describe('导出：收集范围与去掉密钥', () => {
  it('按键名和前缀收集棱镜宝书的设置，以后新增的 prism_book_ 键自动带上，别的插件不带', async () => {
    const { ext, backup } = await setup(d => ({ ...localExt(d), prism_book_future_settings: { version: 1, apiKey: 'sk-future', depth: 2 } }));
    const file = backup.buildSettingsBackup(ext, new Date(2026, 9, 21, 9, 30));
    expect(Object.keys(file.settings)).toEqual(['baibai_api_channels', 'baibai_book', 'baibai_exclude_settings', 'prism_book_future_settings', 'prism_book_notes_settings', 'prism_book_outline_settings']);
    expect(file.settings.prism_book_future_settings).toEqual({ version: 1, depth: 2 });
    expect(file).toMatchObject({ format: 'prism-book-settings', version: 1, secretsRemoved: true });
    expect(file.note).toContain('已去掉密钥');
    expect(backup.backupFileName(new Date(2026, 9, 21, 9, 30))).toBe('棱镜宝书设置-2026-10-21.json');
  });

  it('递归去掉所有密钥字段，不误删名字里带 key 的普通设置和变量模板里的用户内容', async () => {
    const { ext, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    const text = JSON.stringify(file);
    expect(text).not.toContain('sk-');
    const main = file.settings.baibai_book as Rec;
    expect(main.channels[0]).not.toHaveProperty('key');
    expect(main.channels[0]).toMatchObject({ id: 'ch-a', name: '摘要渠道', maxTokens: 65535, excludeParams: ['top_p'] });
    expect(main.vector.embedding).not.toHaveProperty('key');
    expect(main.vector.embedding.url).toBe('https://api.siliconflow.cn/v1');
    expect(main.keepRecent).toBe(5);
    expect(main.leafKeepRecent).toBe(3);
    expect(main.memoryBudgetTokens).toBe(8000);
    expect(main.vector.recall.keywordRoute).toBe(false);
    expect(main.vector.queryRewriteMaxTokens).toBe(4096);
    expect(main.varsGlobalTemplate.json).toEqual({ key: '铜钥匙', token: 3 });
    expect((file.settings.baibai_api_channels as Rec).channels[0]).not.toHaveProperty('key');
    expect((file.settings.prism_book_notes_settings as Rec).channel).not.toHaveProperty('key');
    expect((file.settings.prism_book_notes_settings as Rec).channel.maxTokens).toBe(8000);
    expect(file.removedSecretFields).toBe(6); // 主设置的渠道与两个端点、共享渠道、札记、规划；空的 queryRewrite 密钥不计
    // 本机设置没有被改动
    expect(ext.baibai_book.channels[0].key).toBe('sk-a-LOCAL');
  });
});

describe('导入：校验格式与版本', () => {
  it.each([
    ['不是 JSON', '{oops', '不是有效的 JSON'],
    ['不是备份文件', JSON.stringify({ hello: 1 }), '不是棱镜宝书的设置备份文件'],
    ['版本更新', JSON.stringify({ format: 'prism-book-settings', version: 2, settings: {} }), '更新的棱镜宝书'],
    ['版本无效', JSON.stringify({ format: 'prism-book-settings', version: 'x', settings: {} }), '版本号无效'],
    ['没有设置内容', JSON.stringify({ format: 'prism-book-settings', version: 1 }), '没有设置内容'],
  ])('%s', async (_name, text, message) => {
    const { backup } = await setup(localExt);
    const parsed = backup.parseSettingsBackup(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(message);
  });
});

describe('导入：合并与保存', () => {
  it('导出后原样导入：没有需要改的内容', async () => {
    const { ext, backup } = await setup(localExt);
    const parsed = backup.parseSettingsBackup(JSON.stringify(backup.buildSettingsBackup(ext)));
    expect(parsed.ok).toBe(true);
    const plan = backup.planSettingsImport((parsed as { ok: true; backup: any }).backup, ext);
    expect(plan.sections.map(s => s.status)).toEqual(['same', 'same', 'same']);
    expect(plan.hasChanges).toBe(false);
  });

  it('确认框按设置页的卡片分组：「回看原文补全角色档案」算在摘要设置里', async () => {
    const { ext, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    (file.settings.baibai_book as Rec).npcEnrichAuto = false;
    const lines = backup.describeImportPlan(backup.planSettingsImport(file, ext));
    expect(lines).toContain('以下设置改用文件中的值：摘要设置。');
    expect(lines.join('\n')).not.toContain('其他设置');
  });

  it('内容边界算在「自定义提示词、任务说明与内容边界」里，导入后生效', async () => {
    const { ext, settings, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    expect((file.settings.baibai_book as Rec).contentBoundary).toBe('auto');
    (file.settings.baibai_book as Rec).contentBoundary = 'never';
    const plan = backup.planSettingsImport(file, ext);
    expect(backup.describeImportPlan(plan)).toContain('以下设置改用文件中的值：自定义提示词、任务说明与内容边界。');
    backup.applySettingsImport(plan);
    expect(settings.apiSettings.contentBoundary).toBe('never');
  });

  it('合并：渠道按 id 合并、只增不删，排除名单只增加，确认框写明共享插件会看到变化；地址换了服务器的密钥不保留', async () => {
    const { ext, win, settings, notes, outline, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    const main = file.settings.baibai_book as Rec;
    main.keepRecent = 8;
    main.channels = [{ ...main.channels[0], name: '摘要渠道（改名）' }, channel('ch-b', '新渠道', '')];
    delete main.channels[1].key;
    (file.settings.baibai_api_channels as Rec).channels = clone(main.channels);
    main.vector.embedding.url = 'https://embed.example/v1';
    main.vector.embedding.key = '';
    (file.settings.baibai_exclude_settings as Rec).excludedChars = ['乙', '甲'];
    (file.settings.prism_book_notes_settings as Rec).channel.model = 'notes-model-2';
    (file.settings.prism_book_outline_settings as Rec).channel.key = ''; // 空值不覆盖本机密钥
    (file.settings.prism_book_outline_settings as Rec).channel.model = 'outline-model-2';
    file.settings.prism_book_future_settings = { version: 1 };

    const plan = backup.planSettingsImport(file, ext);
    expect(plan.hasChanges).toBe(true);
    expect(plan.unknownKeys).toEqual(['prism_book_future_settings']);
    const lines = backup.describeImportPlan(plan).join('\n');
    expect(lines).toContain('摘要设置');
    expect(lines).toContain('向量记忆');
    expect(lines).toContain('API 渠道：新增 1 个「新渠道」，更新 1 个「摘要渠道（改名）」。');
    expect(lines).toContain('柏宝绘等同源插件共用这份渠道');
    expect(lines).toContain('排除名单与清洗标签：增加 1 条');
    expect(lines).toContain('当前版本不认识的设置（prism_book_future_settings）');
    // Embedding 换了服务器；Rerank 的地址留空、沿用 Embedding 的地址，也跟着换了服务器
    expect(lines).toContain('向量记忆 · Embedding（向量化）的地址由 https://api.siliconflow.cn/v1 改为 https://embed.example/v1，导入后需要重新填写密钥。');
    expect(lines).toContain('向量记忆 · Rerank（重排）的地址由 https://api.siliconflow.cn/v1 改为 https://embed.example/v1，导入后需要重新填写密钥。');
    expect(lines).toContain('札记设置：改用文件中的设置（API 地址、模型和各项选项）；地址与本机是同一个服务器，保留本机的密钥。');
    expect(lines).not.toContain('本机已经填写的密钥都会保留');
    expect(plan.needKeys).toEqual([
      '渠道「新渠道」（设置 → 副 API）',
      '向量记忆 · Embedding（向量化）的密钥（设置 → 向量记忆）',
      '向量记忆 · Rerank（重排）的密钥（设置 → 向量记忆）',
    ]);

    const result = backup.applySettingsImport(plan);
    expect(result.failed).toEqual([]);
    expect(result.applied).toEqual(['摘要与记忆设置、API 渠道、排除名单', '札记设置', '规划设置']);
    const a = settings.apiSettings;
    expect(a.keepRecent).toBe(8);
    expect(a.channels.map(c => [c.id, c.name, c.key])).toEqual([['ch-a', '摘要渠道（改名）', 'sk-a-LOCAL'], ['ch-b', '新渠道', '']]);
    expect(a.assignments.summary).toBe('ch-a');
    expect(a.vector.embedding).toMatchObject({ url: 'https://embed.example/v1', key: '' });
    expect(a.vector.rerank.key).toBe('');
    expect(a.excludedChars).toEqual(['甲', '乙']);
    expect(a.varsGlobalTemplate.json).toEqual({ key: '铜钥匙', token: 3 });
    expect(notes.notesSettings.channel).toMatchObject({ model: 'notes-model-2', key: 'sk-notes-LOCAL' });
    expect(ext.prism_book_notes_settings.channel.key).toBe('sk-notes-LOCAL');
    expect(outline.outlineSettings.channel).toMatchObject({ model: 'outline-model-2', key: 'sk-outline-LOCAL' });
    expect(ext.prism_book_future_settings).toBeUndefined();

    // 现有的保存逻辑落盘：主设置与共享渠道都写回，密钥仍在，并广播给同源插件
    await nextTick();
    expect(ext.baibai_book.keepRecent).toBe(8);
    expect(ext.baibai_book.channels[0].key).toBe('sk-a-LOCAL');
    expect(ext.baibai_api_channels.channels.map((c: Rec) => c.id)).toEqual(['ch-a', 'ch-b']);
    expect(ext.baibai_api_channels.channels[0].key).toBe('sk-a-LOCAL');
    expect(ext.baibai_exclude_settings.excludedChars).toEqual(['甲', '乙']);
    expect(win.dispatchEvent).toHaveBeenCalled();
  });

  it('地址写法不同但还是同一个服务器（末尾斜杠、少写 /v1、不同路径）时保留本机密钥', async () => {
    const { ext, settings, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    const main = file.settings.baibai_book as Rec;
    main.keepRecent = 6;
    main.vector.embedding.url = 'https://API.siliconflow.cn/';
    main.channels = [{ ...main.channels[0], url: 'https://ch-a.example/v2/coding' }];
    (file.settings.baibai_api_channels as Rec).channels = clone(main.channels);
    (file.settings.prism_book_notes_settings as Rec).channel.url = 'https://notes.example/';
    (file.settings.prism_book_notes_settings as Rec).channel.model = 'notes-model-2';
    const plan = backup.planSettingsImport(file, ext);
    expect(plan.needKeys).toEqual([]);
    expect(backup.describeImportPlan(plan).join('\n')).not.toContain('重新填写');
    backup.applySettingsImport(plan);
    expect(settings.apiSettings.vector.embedding.key).toBe('sk-embed-LOCAL');
    expect(settings.apiSettings.vector.rerank.key).toBe('sk-rerank-LOCAL');
    expect(settings.apiSettings.channels[0]).toMatchObject({ url: 'https://ch-a.example/v2/coding', key: 'sk-a-LOCAL' });
    expect(ext.prism_book_notes_settings.channel.key).toBe('sk-notes-LOCAL');
  });

  it('渠道和札记的地址换了服务器时不保留本机密钥，确认框写明由哪个地址改为哪个地址', async () => {
    const { ext, settings, notes, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    const main = file.settings.baibai_book as Rec;
    main.channels = [{ ...main.channels[0], url: 'https://other.example/v1?token=abc' }];
    (file.settings.baibai_api_channels as Rec).channels = clone(main.channels);
    (file.settings.prism_book_notes_settings as Rec).channel.url = 'https://evil.example/v1';
    const plan = backup.planSettingsImport(file, ext);
    const lines = backup.describeImportPlan(plan).join('\n');
    expect(lines).toContain('渠道「摘要渠道」的地址由 https://ch-a.example/v1 改为 https://other.example/v1，导入后需要重新填写密钥。');
    expect(lines).not.toContain('token=abc');
    expect(lines).toContain('札记设置：改用文件中的设置（API 地址、模型和各项选项）；API 地址由 https://notes.example/v1 改为 https://evil.example/v1，本机的密钥没有保留，导入后需要重新填写。');
    expect(plan.needKeys).toEqual(['渠道「摘要渠道」（设置 → 副 API）', '札记的 API 密钥（札记页 → 独立 API 设置）']);
    backup.applySettingsImport(plan);
    expect(settings.apiSettings.channels[0].key).toBe('');
    expect(notes.notesSettings.channel).toMatchObject({ url: 'https://evil.example/v1', key: '' });
  });

  it('Rerank 改到本机没用过的服务器、又没有单独的密钥时，会沿用 Embedding 的密钥，所以 Embedding 的密钥也不保留', async () => {
    const { ext, settings, backup } = await setup(d => {
      const e = localExt(d);
      e.baibai_book.vector.rerank.key = ''; // 本机 Rerank 沿用 Embedding 的地址和密钥
      return e;
    });
    const file = backup.buildSettingsBackup(ext);
    (file.settings.baibai_book as Rec).vector.rerank.url = 'https://rerank.example/v1';
    const plan = backup.planSettingsImport(file, ext);
    const lines = backup.describeImportPlan(plan).join('\n');
    expect(lines).toContain('向量记忆 · Rerank（重排）将使用 https://rerank.example/v1，没有单独的密钥时会沿用 Embedding 的密钥；为免把本机密钥发到新的地址，Embedding 的密钥没有保留，导入后需要重新填写。');
    expect(plan.needKeys).toEqual(['向量记忆 · Embedding（向量化）的密钥（设置 → 向量记忆）']);
    backup.applySettingsImport(plan);
    expect(settings.apiSettings.vector.embedding.key).toBe('');
  });

  it('本机另有的渠道保留；文件里有密钥时按文件填写', async () => {
    const { ext, settings, backup } = await setup(d => {
      const e = localExt(d);
      e.baibai_book.channels.push(channel('ch-local', '只在本机', 'sk-local-only'));
      e.baibai_api_channels.channels = clone(e.baibai_book.channels);
      return e;
    });
    const file = backup.buildSettingsBackup(ext);
    const main = file.settings.baibai_book as Rec;
    main.channels = [{ ...main.channels[0], key: 'sk-a-FROM-FILE' }];
    (file.settings.baibai_api_channels as Rec).channels = clone(main.channels);
    const plan = backup.planSettingsImport(file, ext);
    expect(backup.describeImportPlan(plan).join('\n')).toContain('；本机另有的 1 个保留不动');
    backup.applySettingsImport(plan);
    expect(settings.apiSettings.channels.map(c => [c.id, c.key])).toEqual([['ch-a', 'sk-a-FROM-FILE'], ['ch-local', 'sk-local-only']]);
  });

  it('本机设置处于只读保护或文件里格式认不出来时跳过，不覆盖', async () => {
    const { ext, backup } = await setup(d => ({ ...localExt(d), prism_book_notes_settings: { version: 2, channel: { key: 'sk-notes-LOCAL' } } }));
    const file = backup.buildSettingsBackup(ext);
    file.settings.prism_book_notes_settings = { version: 1, channel: { url: 'https://n2.example/v1', model: 'x' }, enabled: true };
    file.settings.prism_book_outline_settings = { version: 9, apiMode: 'independent', channel: {} };
    const plan = backup.planSettingsImport(file, ext);
    const notesSection = plan.sections.find(s => s.id === 'prism_book_notes_settings');
    const outlineSection = plan.sections.find(s => s.id === 'prism_book_outline_settings');
    expect(notesSection).toMatchObject({ status: 'skip' });
    expect(notesSection?.reason).toContain('只读保护');
    expect(outlineSection).toMatchObject({ status: 'skip' });
    expect(outlineSection?.reason).toContain('认不出来');
    expect(plan.hasChanges).toBe(false);
    expect(ext.prism_book_notes_settings).toEqual({ version: 2, channel: { key: 'sk-notes-LOCAL' } });
  });

  it('保存失败的一项恢复原值，其他项照常导入', async () => {
    const { ext, ctx, settings, backup } = await setup(localExt);
    const file = backup.buildSettingsBackup(ext);
    (file.settings.baibai_book as Rec).keepRecent = 9;
    (file.settings.prism_book_notes_settings as Rec).channel.model = 'notes-model-2';
    const before = clone(ext.prism_book_notes_settings);
    const plan = backup.planSettingsImport(file, ext);
    // 札记保存时第一次调用酒馆的保存函数就失败；主设置之后的落盘照常
    vi.mocked(ctx.saveSettingsDebounced!).mockImplementationOnce(() => { throw new Error('磁盘已满'); });
    const result = backup.applySettingsImport(plan);
    expect(result.applied).toEqual(['摘要与记忆设置、API 渠道、排除名单']);
    expect(result.failed.map(f => f.label)).toEqual(['札记设置']);
    expect(ext.prism_book_notes_settings).toEqual(before);
    expect(settings.apiSettings.keepRecent).toBe(9);
  });
});
