/**
 * 设置备份：导出、导入棱镜宝书在酒馆 extension_settings 里的全部设置。
 *
 * 导出范围：摘要与记忆设置（baibai_book）、与柏宝绘等同源插件共用的 API 渠道（baibai_api_channels）
 * 和排除名单（baibai_exclude_settings），以及所有以 prism_book_ 开头的键（札记、规划、世界书设置等）。
 * 按前缀收集，以后新增的 prism_book_ 设置会自动带上。
 *
 * 密钥：导出时递归去掉字段名为 key（各渠道和向量端点的 API 密钥）以及 apiKey、api_key、secret、token、
 * password 的字段。只按确切字段名判断，keepRecent、keywordRoute、maxTokens 这类普通设置不受影响；
 * 变量模板是用户自己写的内容，里面的同名字段原样保留。
 *
 * 导入：先校验格式与版本，再逐项与本机对比，列出会改哪些内容，用户确认后通过各模块现有的保存函数落盘。
 * - 文件里的密钥为空时保留本机已有的密钥，不用空值覆盖。
 * - API 渠道按 id 合并：同 id 的更新（密钥保留本机的），新的追加，本机另有的保留；不删除渠道。
 *   这份渠道与同源插件共用，确认框里写明它们也会看到变化。
 * - 排除名单与清洗标签只增加不删除。角色变量模板按角色合并。
 * - 本机或文件里某项设置的格式认不出来（例如来自更新的版本）时跳过这一项，不覆盖。
 * - 当前版本不认识的 prism_book_ 键不导入，列出来告诉用户。
 */
import {
  apiSettings, normalizeApiSettings, replaceApiSettings,
  SETTINGS_KEY, SHARED_CHANNELS_KEY, SHARED_EXCLUDES_KEY,
} from '@/api/settings';
import { hydrateNotesSettings, NOTES_SETTINGS_KEY, saveNotesSettings } from '@/notes/settings';
import { hydrateOutlineSettings, OUTLINE_SETTINGS_KEY, saveOutlineSettings } from '@/outline/settings';
import { hydrateWorldbookSettings, saveWorldbookSettings, WORLDBOOK_SETTINGS_KEY } from '@/worldbook/settings';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';

export const BACKUP_FORMAT = 'prism-book-settings';
export const BACKUP_VERSION = 1;
export const BACKUP_NOTE = '已去掉密钥：导出时去掉了各渠道和向量端点的 API 密钥（key 字段）。导入后本机已填写的密钥会保留，新增的渠道需要重新填写密钥。';
/** 导入文件的大小上限（设置备份通常只有几十 KB）。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 存密钥的确切字段名。 */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set(['key', 'apiKey', 'api_key', 'secret', 'token', 'password']);
/** 用户自己写的内容：里面的同名字段是数据，不是密钥。 */
const USER_CONTENT_PATHS: ReadonlySet<string> = new Set([`${SETTINGS_KEY}.varsGlobalTemplate`, `${SETTINGS_KEY}.varsTemplateByChar`]);

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  note: string;
  secretsRemoved: true;
  /** 去掉的非空密钥字段数 */
  removedSecretFields: number;
  exportedAt: string;
  pluginVersion: string;
  settings: Record<string, unknown>;
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** 是否属于棱镜宝书的设置键。 */
export function isPrismSettingsKey(key: string): boolean {
  return key === SETTINGS_KEY || key === SHARED_CHANNELS_KEY || key === SHARED_EXCLUDES_KEY || key.startsWith('prism_book_');
}

/** 递归去掉密钥字段；removed 收集去掉的非空字段路径（不含值）。 */
export function stripSecrets(value: unknown, path = '', removed: string[] = []): unknown {
  if (USER_CONTENT_PATHS.has(path)) return clone(value);
  if (Array.isArray(value)) return value.map((item, i) => stripSecrets(item, `${path}[${i}]`, removed));
  if (isRecord(value)) {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) {
      const child = path ? `${path}.${k}` : k;
      if (SECRET_FIELD_NAMES.has(k)) {
        if (v !== '' && v != null) removed.push(child);
        continue;
      }
      out[k] = stripSecrets(v, child, removed);
    }
    return out;
  }
  return value;
}

/** 从 extension_settings 收集棱镜宝书的全部设置（深拷贝，含密钥）。 */
export function collectPrismSettings(ext: Rec): Rec {
  const out: Rec = {};
  for (const key of Object.keys(ext).sort()) {
    if (isPrismSettingsKey(key) && ext[key] !== undefined) out[key] = clone(ext[key]);
  }
  return out;
}

export function buildSettingsBackup(ext: Rec, now = new Date()): SettingsBackup {
  const removed: string[] = [];
  const settings: Rec = {};
  for (const [key, value] of Object.entries(collectPrismSettings(ext))) settings[key] = stripSecrets(value, key, removed);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    note: BACKUP_NOTE,
    secretsRemoved: true,
    removedSecretFields: removed.length,
    exportedAt: now.toISOString(),
    pluginVersion: PLUGIN_VERSION,
    settings,
  };
}

/** 文件名带本地日期，如「棱镜宝书设置-2026-10-21.json」。 */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `棱镜宝书设置-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** 导出并下载设置文件；返回文件名。 */
export function downloadSettingsBackup(now = new Date()): string {
  const ext = getContext()?.extensionSettings;
  if (!ext) throw new Error('酒馆设置接口还没有就绪，请稍后再试。');
  const text = JSON.stringify(buildSettingsBackup(ext, now), null, 2);
  const name = backupFileName(now);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export type ParseResult = { ok: true; backup: SettingsBackup } | { ok: false; error: string };

/** 解析并校验导入文件。 */
export function parseSettingsBackup(text: string): ParseResult {
  const how = '请选择用「设置 → 数据与迁移 → 设置备份 → 导出设置」得到的 .json 文件。';
  if (text.length > MAX_FILE_BYTES) return { ok: false, error: '导入失败：文件超过 2 MB，不是设置备份文件。' + how };
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { ok: false, error: '导入失败：文件不是有效的 JSON。' + how }; }
  if (!isRecord(data) || data.format !== BACKUP_FORMAT) return { ok: false, error: '导入失败：这不是棱镜宝书的设置备份文件。' + how };
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { ok: false, error: '导入失败：备份文件的版本号无效，文件可能已损坏。' + how };
  if (version > BACKUP_VERSION) {
    return { ok: false, error: `导入失败：这个文件来自更新的棱镜宝书（备份格式第 ${version} 版），当前版本只认识第 ${BACKUP_VERSION} 版。请先把棱镜宝书更新到导出时的版本或更新的版本，再导入。` };
  }
  if (!isRecord(data.settings)) return { ok: false, error: '导入失败：备份文件里没有设置内容，文件可能已损坏。' + how };
  return { ok: true, backup: data as unknown as SettingsBackup };
}

/* ============ 导入计划 ============ */

export interface ImportSection {
  id: string;
  label: string;
  status: 'change' | 'same' | 'skip';
  /** 会改的内容 */
  lines: string[];
  /** 跳过的原因 */
  reason?: string;
}

export interface ImportPlan {
  sections: ImportSection[];
  /** 当前版本不认识、不会导入的键 */
  unknownKeys: string[];
  /** 是否有需要导入的改动 */
  hasChanges: boolean;
  /** 导入后还没有密钥、需要用户填写的位置 */
  needKeys: string[];
  exportedAt: string;
  pluginVersion: string;
  /** 合并好的新值（只在用户确认后应用） */
  next: { api?: Rec; modules: Array<{ key: string; value: Rec }> };
}

const API_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: '总开关', keys: ['enabled'] },
  { label: '基本设置（主题、导航、快捷按钮、楼层面板、悬浮球）', keys: ['ui'] },
  { label: '副 API 的任务指派', keys: ['assignments'] },
  { label: '摘要设置', keys: ['autoSummaryEnabled', 'summaryMaxChars', 'verbosity', 'keepRecent', 'leafBatchThreshold', 'leafKeepRecent', 'resummaryThreshold', 'higherResummaryThreshold', 'recentResolvedPlansCount', 'summaryMaxRetries', 'npcEnrichAuto'] },
  { label: '批量补摘的合并参数', keys: ['batchMaxChars', 'batchMaxFloors', 'batchFullRecent'] },
  { label: '注入设置', keys: ['summaryOnlyMode', 'memoryBudgetTokens', 'injection'] },
  { label: '向量记忆（开关、端点地址与模型、召回参数）', keys: ['vector'] },
  { label: '自定义提示词与任务说明', keys: ['prompts', 'promptBases', 'taskContextMode'] },
  { label: '世界书模板渲染', keys: ['renderWorldInfoTemplates'] },
  { label: '变量模板', keys: ['varsGlobalTemplate', 'varsTemplateByChar'] },
];
/** 另行合并或只供内部使用、不单独列出的字段。 */
const API_SEPARATE = new Set(['channels', 'excludedChars', 'excludedWorldNames', 'excludedWorldInfoPatterns', 'customStripTags', 'wiPatternsSeeded']);
const EXCLUDE_LISTS = ['excludedChars', 'excludedWorldNames', 'excludedWorldInfoPatterns', 'customStripTags'] as const;
const VECTOR_ROLES = ['embedding', 'rerank', 'queryRewrite'] as const;

/** 键顺序无关的序列化，用于判断合并后的值与本机是否相同（含密钥：空密钥已先换成本机的）。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
const channelName = (c: Rec) => (filled(c.name) ? c.name.trim() : '未命名渠道');

/** 渠道按 id 合并：同 id 的更新（文件密钥为空时保留本机的），新的追加，本机另有的保留。 */
export function mergeChannels(local: Rec[], incoming: unknown[]): { channels: Rec[]; added: string[]; updated: string[]; keptLocal: number; needKey: string[] } {
  const channels = local.map(c => ({ ...c }));
  const position = new Map(channels.map((c, i) => [String(c.id), i]));
  const seen = new Set<string>();
  const added: string[] = [];
  const updated: string[] = [];
  const needKey: string[] = [];
  for (const raw of incoming) {
    if (!isRecord(raw) || !filled(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const at = position.get(raw.id);
    if (at !== undefined) {
      const existing = channels[at];
      const merged = { ...existing, ...clone(raw), key: filled(raw.key) ? raw.key : existing.key ?? '' };
      if (stable(merged) !== stable(existing)) updated.push(channelName(merged));
      channels[at] = merged;
    } else {
      const fresh = { ...clone(raw), key: filled(raw.key) ? raw.key : '' };
      channels.push(fresh);
      added.push(channelName(fresh));
      if (!filled(fresh.key)) needKey.push(channelName(fresh));
    }
  }
  return { channels, added, updated, keptLocal: local.filter(c => !seen.has(String(c.id))).length, needKey };
}

/**
 * 札记、规划、世界书设置：recognized 与各模块载入时的判断一致；load 从 extension_settings 重新载入，
 * save 用模块自己的保存函数整理后落盘。新增一项 prism_book_ 设置时在这里登记，否则导入时会列为「不认识」。
 */
const MODULES: Array<{ key: string; label: string; place: string; recognized: (v: unknown) => boolean; load: () => void; save: () => void }> = [
  {
    key: NOTES_SETTINGS_KEY, label: '札记设置', place: '札记页 → 独立 API 设置',
    recognized: v => isRecord(v) && v.version === 1 && isRecord(v.channel),
    load: hydrateNotesSettings, save: saveNotesSettings,
  },
  {
    key: OUTLINE_SETTINGS_KEY, label: '规划设置', place: '摘要页 → 创作规划 → 规划 API 设置',
    recognized: v => isRecord(v) && v.version === 1 && (v.apiMode === 'notes' || v.apiMode === 'independent') && isRecord(v.channel),
    load: hydrateOutlineSettings, save: saveOutlineSettings,
  },
  {
    key: WORLDBOOK_SETTINGS_KEY, label: '世界书设置', place: '世界书页 → API 设置',
    recognized: v => isRecord(v) && v.version === 1 && (v.apiMode === 'notes' || v.apiMode === 'independent') && isRecord(v.channel),
    load: hydrateWorldbookSettings, save: saveWorldbookSettings,
  },
];

function planApi(file: Rec, needKeys: string[]): { section: ImportSection | null; next?: Rec } {
  const fileMain = file[SETTINGS_KEY];
  const fileChannels = file[SHARED_CHANNELS_KEY];
  const fileExcludes = file[SHARED_EXCLUDES_KEY];
  if (fileMain === undefined && fileChannels === undefined && fileExcludes === undefined) return { section: null };
  const label = '摘要与记忆设置、API 渠道、排除名单';
  if (fileMain !== undefined && !isRecord(fileMain)) return { section: { id: 'api', label, status: 'skip', lines: [], reason: '文件里这部分的格式认不出来' } };
  const newer = (v: unknown) => isRecord(v) && typeof v.schemaVersion === 'number' && v.schemaVersion > 1;
  if (newer(fileChannels) || newer(fileExcludes)) {
    return { section: { id: 'api', label, status: 'skip', lines: [], reason: '共享渠道或排除名单来自更新的版本，当前版本不能安全合并' } };
  }
  const local = clone(apiSettings) as unknown as Rec;
  const base: Rec = isRecord(fileMain) ? clone(fileMain) : clone(local);
  const lines: string[] = [];

  // API 渠道：共享存储优先，没有时用主设置里的镜像
  const incomingChannels = isRecord(fileChannels) && Array.isArray(fileChannels.channels) ? fileChannels.channels
    : isRecord(fileMain) && Array.isArray(fileMain.channels) ? fileMain.channels : null;
  const localChannels = (local.channels as Rec[]) ?? [];
  const merged = incomingChannels ? mergeChannels(localChannels, incomingChannels) : { channels: localChannels, added: [], updated: [], keptLocal: localChannels.length, needKey: [] };
  base.channels = merged.channels;
  if (merged.added.length || merged.updated.length) {
    const quote = (names: string[]) => names.map(n => `「${n}」`).join('');
    const parts = [merged.added.length ? `新增 ${merged.added.length} 个${quote(merged.added)}` : '', merged.updated.length ? `更新 ${merged.updated.length} 个${quote(merged.updated)}` : ''].filter(Boolean);
    lines.push(`API 渠道：${parts.join('，')}${merged.keptLocal ? `；本机另有的 ${merged.keptLocal} 个保留不动` : ''}。柏宝绘等同源插件共用这份渠道，也会看到这些变化。`);
  }
  for (const name of merged.needKey) needKeys.push(`渠道「${name}」（设置 → 副 API）`);

  // 排除名单与清洗标签：只增加
  const excludeSource: Rec = isRecord(fileExcludes) ? fileExcludes : isRecord(fileMain) ? fileMain : {};
  let addedEntries = 0;
  for (const list of EXCLUDE_LISTS) {
    const mine = Array.isArray(local[list]) ? (local[list] as string[]) : [];
    const theirs = Array.isArray(excludeSource[list]) ? (excludeSource[list] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    const extra = theirs.filter(x => !mine.includes(x));
    addedEntries += extra.length;
    base[list] = [...mine, ...extra];
  }
  if (addedEntries) lines.push(`排除名单与清洗标签：增加 ${addedEntries} 条，本机已有的不删除。这份名单也与柏宝绘等插件共用。`);

  // 向量端点：文件密钥为空时保留本机密钥
  const vector = isRecord(base.vector) ? base.vector : null;
  const localVector = isRecord(local.vector) ? local.vector : {};
  if (vector) {
    for (const role of VECTOR_ROLES) {
      const target = vector[role];
      const mine = isRecord(localVector[role]) ? (localVector[role] as Rec).key : '';
      if (isRecord(target) && !filled(target.key) && filled(mine)) target.key = mine;
    }
  }
  // 角色变量模板按角色合并；任务指派只认合并后存在的渠道
  base.varsTemplateByChar = { ...(isRecord(local.varsTemplateByChar) ? local.varsTemplateByChar : {}), ...(isRecord(base.varsTemplateByChar) ? base.varsTemplateByChar : {}) };
  const ids = new Set(merged.channels.map(c => String(c.id)));
  const fileAssign = isRecord(base.assignments) ? base.assignments : {};
  const localAssign = isRecord(local.assignments) ? local.assignments : {};
  const pick = (task: string) => {
    const want = fileAssign[task];
    if (want === '' || (filled(want) && ids.has(want))) return want as string;
    const mine = localAssign[task];
    return filled(mine) && ids.has(mine) ? mine : '';
  };
  base.assignments = { summary: pick('summary'), resummary: pick('resummary') };
  base.wiPatternsSeeded = base.wiPatternsSeeded === true || local.wiPatternsSeeded === true;

  // 逐组对比整理后的结果，列出会改的设置（空密钥已换成本机的，剩下的差异都是真实改动）
  const nextNormalized = clone(normalizeApiSettings(base)) as unknown as Rec;
  const changedGroups = API_GROUPS.filter(g => g.keys.some(k => stable(nextNormalized[k]) !== stable(local[k]))).map(g => g.label);
  const known = new Set([...API_GROUPS.flatMap(g => g.keys), ...API_SEPARATE]);
  if (Object.keys(nextNormalized).some(k => !known.has(k) && stable(nextNormalized[k]) !== stable(local[k]))) changedGroups.push('其他设置');
  if (changedGroups.length) lines.unshift(`以下设置改用文件中的值：${changedGroups.join('、')}。`);

  const vectorEnabled = isRecord(nextNormalized.vector) && nextNormalized.vector.enabled === true;
  const embedding = isRecord(nextNormalized.vector) && isRecord((nextNormalized.vector as Rec).embedding) ? (nextNormalized.vector as Rec).embedding as Rec : null;
  if (vectorEnabled && embedding && !filled(embedding.key)) needKeys.push('向量记忆的文本向量化端点（设置 → 向量记忆）');

  if (!lines.length) return { section: { id: 'api', label, status: 'same', lines: [] } };
  return { section: { id: 'api', label, status: 'change', lines }, next: base };
}

/** 对比文件与本机，生成导入计划（不修改任何设置）。 */
export function planSettingsImport(backup: SettingsBackup, ext: Rec): ImportPlan {
  const file = backup.settings;
  const sections: ImportSection[] = [];
  const needKeys: string[] = [];
  const next: ImportPlan['next'] = { modules: [] };

  const api = planApi(file, needKeys);
  if (api.section) sections.push(api.section);
  if (api.next) next.api = api.next;

  for (const mod of MODULES) {
    const incoming = file[mod.key];
    if (incoming === undefined) continue;
    const localRaw = ext[mod.key];
    if (!mod.recognized(incoming)) {
      sections.push({ id: mod.key, label: mod.label, status: 'skip', lines: [], reason: '文件里这一项的格式或版本认不出来' });
      continue;
    }
    if (localRaw != null && !mod.recognized(localRaw)) {
      sections.push({ id: mod.key, label: mod.label, status: 'skip', lines: [], reason: '本机的这项设置处于只读保护（格式认不出来），为免覆盖没有导入' });
      continue;
    }
    const value = clone(incoming) as Rec;
    const channel = value.channel as Rec;
    const localKey = isRecord(localRaw) && isRecord(localRaw.channel) ? localRaw.channel.key : '';
    if (!filled(channel.key)) channel.key = filled(localKey) ? localKey : '';
    if (localRaw != null && stable(value) === stable(localRaw)) {
      sections.push({ id: mod.key, label: mod.label, status: 'same', lines: [] });
      continue;
    }
    sections.push({ id: mod.key, label: mod.label, status: 'change', lines: [`${mod.label}：改用文件中的设置（API 地址、模型和各项选项），本机的密钥保留。`] });
    next.modules.push({ key: mod.key, value });
    const usesOwnChannel = mod.key === NOTES_SETTINGS_KEY || value.apiMode === 'independent';
    if (usesOwnChannel && filled(channel.url) && !filled(channel.key)) needKeys.push(`${mod.label.replace('设置', '')}的 API 密钥（${mod.place}）`);
  }

  const known = new Set([SETTINGS_KEY, SHARED_CHANNELS_KEY, SHARED_EXCLUDES_KEY, ...MODULES.map(m => m.key)]);
  const unknownKeys = Object.keys(file).filter(k => isPrismSettingsKey(k) && !known.has(k));
  return {
    sections, unknownKeys, needKeys: [...new Set(needKeys)],
    hasChanges: sections.some(s => s.status === 'change'),
    exportedAt: typeof backup.exportedAt === 'string' ? backup.exportedAt : '',
    pluginVersion: typeof backup.pluginVersion === 'string' ? backup.pluginVersion : '',
    next,
  };
}

/** 确认框里逐行显示的说明。 */
export function describeImportPlan(plan: ImportPlan): string[] {
  const lines: string[] = [];
  for (const s of plan.sections) {
    if (s.status === 'change') lines.push(...s.lines);
    else if (s.status === 'skip') lines.push(`${s.label}：没有导入，${s.reason}。`);
  }
  if (plan.unknownKeys.length) lines.push(`当前版本不认识的设置（${plan.unknownKeys.join('、')}）：没有导入。`);
  const unchanged = plan.sections.filter(s => s.status === 'same').map(s => s.label);
  if (unchanged.length) lines.push(`与本机相同、不会改动：${unchanged.join('、')}。`);
  lines.push('文件不含密钥：本机已经填写的密钥都会保留。');
  if (plan.needKeys.length) lines.push(`导入后可能需要填写密钥：${plan.needKeys.join('、')}（不需要密钥的接口可以忽略）。`);
  return lines;
}

export interface ImportResult {
  applied: string[];
  failed: Array<{ label: string; error: string }>;
}

/** 应用导入计划：各项分别保存，一项失败不影响其他项（失败的一项恢复原值）。 */
export function applySettingsImport(plan: ImportPlan): ImportResult {
  const ctx = getContext();
  const ext = ctx?.extensionSettings;
  if (!ext || !ctx?.saveSettingsDebounced) throw new Error('酒馆设置接口还没有就绪，设置没有导入。请稍后再试。');
  const result: ImportResult = { applied: [], failed: [] };
  const label = (id: string) => plan.sections.find(s => s.id === id)?.label ?? id;
  if (plan.next.api) {
    try {
      replaceApiSettings(plan.next.api);
      result.applied.push(label('api'));
    } catch (error) {
      result.failed.push({ label: label('api'), error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const { key, value } of plan.next.modules) {
    const mod = MODULES.find(m => m.key === key);
    if (!mod) continue;
    const had = Object.prototype.hasOwnProperty.call(ext, key);
    const previous = ext[key];
    try {
      ext[key] = value;
      mod.load();
      mod.save();
      result.applied.push(mod.label);
    } catch (error) {
      // 恢复原值并重新载入；不再保存，免得把默认值写进原本没有的设置
      if (had) ext[key] = previous; else delete ext[key];
      try { mod.load(); } catch { /* 重新载入失败时保留模块自己的保护提示 */ }
      result.failed.push({ label: mod.label, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
