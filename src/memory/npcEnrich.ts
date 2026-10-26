/**
 * 回看原文补档案:角色的外貌、身份或性别为空时,到较早楼层的原文里按名字检索,
 * 用摘要同一渠道发一个小请求,只填原文明确支持的空字段。
 *
 * - 自动:单楼摘要解析之后、写入叶子之前进行(见 engine.summarizeFloorWork)。对象是本楼新增的角色,
 *   以及本楼正文提到、档案仍缺外貌/身份/性别的已有角色;只检索它建档之前、最近约 40 个回复楼层的原文
 *   (含已隐藏的楼层,不含番外楼)。没有摘录就不发请求。结果存在本楼叶子的 enriched 上,重放时只填空。
 * - 手动:角色页「从原文补全档案」,检索全部楼层,确认后写进最新一条有效叶子的 enriched。
 * - 记录:每个聊天在 chatMetadata 里记下哪些角色补过,补过或确认没有可补内容的不再自动请求;
 *   请求失败,或模型给出的字段因超出长度上限、原句对不上而全被丢弃时,只记失败次数(最多自动尝试两次),不影响摘要本身。
 * - 重新摘要(含先对比):沿用该楼原有的补档结果,不再发新请求。
 */
import { reactive } from 'vue';
import type { ChatMsg } from '@/api/client';
import { ApiError, describeFailure } from '@/api/errors';
import { getContext, type STMessage } from '@/st/context';
import { appendEnrichmentToLatestLeaf, cleanEnrichment, latestLeaf, npcId } from './apply';
import { isAiFloor, isRealAiReply, resolveSender } from './engine';
import { refreshInjection } from './inject';
import { extractJsonObject } from './json';
import { npcLabelBase, npcMentioned, npcSearchTerms } from './npcLabel';
import { buildNpcEnrichPrompt } from './prompts';
import { createSourceEvidenceMatcher } from './sourceEvidence';
import { memory, memoryWriteIssue } from './store';
import { taskContextPrompt } from './taskContext';
import { cleanBody } from './timeTag';
import { NPC_ENRICH_FIELDS, type LeafExtra, type MemNpc, type NpcEnrichField, type NpcEnrichment } from './types';

/** chatMetadata 里的补档记录键。 */
export const ENRICH_RECORD_KEY = 'prism_book_npc_enrich';
/** 自动补档只检索建档前最近这么多个回复楼层。 */
export const ENRICH_AUTO_AI_FLOORS = 40;
/** 每个角色的摘录上限(字)。 */
export const ENRICH_TARGET_CHARS = 1200;
/** 一次请求所有角色的摘录合计上限(字)。 */
export const ENRICH_TOTAL_CHARS = 3000;
/** 手动补全只有一个角色,摘录上限放宽。 */
export const ENRICH_MANUAL_CHARS = 2400;
/** 一次自动请求最多补几个角色;其余留到之后提到时再补。 */
export const ENRICH_MAX_TARGETS = 4;
/** 失败后最多自动尝试的次数。 */
export const ENRICH_MAX_ATTEMPTS = 2;
/** 自动补档请求的等待上限(毫秒);超时按失败记录,本楼摘要照常写入。 */
export const ENRICH_TIMEOUT_MS = 90_000;

/** 各字段的长度上限:超出多半是把整段原文抄了进来,不采用。 */
export const ENRICH_FIELD_MAX: Record<NpcEnrichField, number> = { gender: 12, age: 24, title: 60, desc: 240, personality: 160 };
const FIELD_MAX = ENRICH_FIELD_MAX;
export const ENRICH_FIELD_LABELS: Record<NpcEnrichField, string> = { gender: '性别', age: '年龄', title: '身份', desc: '外貌', personality: '性格' };

const norm = (s: string) => s.trim().toLowerCase();
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

export type EnrichFields = Partial<Record<NpcEnrichField, string>>;

/* ============ 记录 ============ */

export interface EnrichRecordEntry {
  /** filled=已补到内容;empty=请求成功但原文没有可补内容;failed=请求或解析失败 */
  status: 'filled' | 'empty' | 'failed';
  attempts: number;
  /** 写入的楼层(chat 索引);同一楼重新摘要或翻页时可沿用 fields,不再请求 */
  floor: number;
  at: number;
  fields?: EnrichFields;
}
export interface EnrichRecord { version: 1; npcs: Record<string, EnrichRecordEntry> }

function cleanFields(raw: unknown): EnrichFields | undefined {
  if (!record(raw)) return undefined;
  const out: EnrichFields = {};
  for (const key of NPC_ENRICH_FIELDS) if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = (raw[key] as string).trim();
  return Object.keys(out).length ? out : undefined;
}

/** 读当前聊天的补档记录;格式不对时当作空记录,不改动原数据。 */
export function readEnrichRecord(meta?: Record<string, unknown>): EnrichRecord {
  const raw = (meta ?? (getContext()?.chatMetadata as Record<string, unknown> | undefined))?.[ENRICH_RECORD_KEY];
  const out: EnrichRecord = { version: 1, npcs: {} };
  if (!record(raw) || !record(raw.npcs)) return out;
  for (const [key, value] of Object.entries(raw.npcs)) {
    if (!record(value)) continue;
    const status = value.status === 'filled' || value.status === 'empty' || value.status === 'failed' ? value.status : null;
    if (!status) continue;
    out.npcs[key] = {
      status,
      attempts: typeof value.attempts === 'number' && value.attempts > 0 ? Math.floor(value.attempts) : 1,
      floor: typeof value.floor === 'number' ? value.floor : -1,
      at: typeof value.at === 'number' ? value.at : 0,
      fields: cleanFields(value.fields),
    };
  }
  return out;
}

export interface EnrichRecordUpdate {
  name: string;
  status: EnrichRecordEntry['status'];
  floor: number;
  fields?: EnrichFields;
}

/** 写入补档记录并保存聊天元数据;记忆处于保护状态时不写。失败次数在原记录上累加。 */
export function writeEnrichRecords(updates: EnrichRecordUpdate[]): void {
  if (!updates.length || memoryWriteIssue()) return;
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  if (!meta) return;
  const current = readEnrichRecord(meta);
  const now = Date.now();
  for (const u of updates) {
    const key = norm(u.name);
    const prev = current.npcs[key];
    const attempts = u.status === 'failed' ? (prev?.status === 'failed' ? prev.attempts + 1 : 1) : 1;
    current.npcs[key] = { status: u.status, attempts, floor: u.floor, at: now, ...(u.fields && Object.keys(u.fields).length ? { fields: { ...u.fields } } : {}) };
  }
  meta[ENRICH_RECORD_KEY] = current;
  ctx?.saveMetadataDebounced?.();
}

/** 这个角色还能不能自动请求补档:补到过或确认没有内容的不再请求,失败的最多再试到 ENRICH_MAX_ATTEMPTS 次。 */
export function autoEnrichBlocked(entry: EnrichRecordEntry | undefined): boolean {
  if (!entry) return false;
  return entry.status !== 'failed' || entry.attempts >= ENRICH_MAX_ATTEMPTS;
}

/* ============ 选人与摘录 ============ */

/** 档案里为空的可补字段。 */
export function enrichMissingFields(npc: Pick<MemNpc, NpcEnrichField>): NpcEnrichField[] {
  return NPC_ENRICH_FIELDS.filter(key => !npc[key]?.trim());
}

/** 外貌、身份、性别有一项为空才需要补档(年龄、性格只在顺带时补)。 */
export function needsEnrichment(npc: Pick<MemNpc, NpcEnrichField>): boolean {
  return !npc.desc?.trim() || !npc.title?.trim() || !npc.gender?.trim();
}

/** 能作为原文来源的楼层:真实的回复或用户发言,含已隐藏的,不含番外楼、提示楼和原生系统楼。 */
export function isSourceMessage(m: STMessage | undefined): boolean {
  if (!m || m.extra?.bbs_omit) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (m.is_user) return !m.is_system || !!m.extra?.bbs_hidden;
  return isRealAiReply(m);
}

/** 某个回复楼层所在段落的起点(上一个回复楼层之后);这一段整体送去摘要,不算「之前的原文」。 */
export function segmentStart(chat: STMessage[], floor: number): number {
  let i = Math.min(floor, chat.length) - 1;
  while (i >= 0 && !isAiFloor(chat[i])) i--;
  return i + 1;
}

export interface EnrichExcerpt {
  floor: number;
  text: string;
}

/** 按句切开(句末标点连同后面的收引号留在本句)。 */
function sentences(text: string): string[] {
  return (text.match(/[^。！？!?…\n]+(?:[。！？!?…]+[」』”"’）)]*)?|[。！？!?…]+[」』”"’）)]*/g) ?? []).map(s => s.trim()).filter(Boolean);
}

/** 一段里与检索词相关的部分:短段整段取,长段取含检索词的句子和它后面一句。 */
function excerptOf(paragraph: string, terms: string[]): string {
  if (paragraph.length <= 300) return paragraph;
  const list = sentences(paragraph);
  const keep = new Set<number>();
  list.forEach((s, i) => {
    if (terms.some(t => s.includes(t))) { keep.add(i); if (i + 1 < list.length) keep.add(i + 1); }
  });
  return [...keep].sort((a, b) => a - b).map(i => list[i]).join('');
}

/** 超出余量时在句末截断;一句也放不下就整段放弃,不截半句。 */
function fitText(text: string, room: number): string {
  if (text.length <= room) return text;
  let out = '';
  for (const s of sentences(text)) {
    if (out.length + s.length > room) break;
    out += s;
  }
  return out;
}

/**
 * 在 [起点, end) 内检索含检索词的原文,按楼层先后取段落或句子,合计不超过 maxChars 字。
 * maxAiFloors 给出时,起点为 end 之前第 maxAiFloors 个回复楼层;不给则从头检索。
 */
export function collectNpcExcerpts(chat: STMessage[], terms: string[], opts: { end: number; maxChars: number; maxAiFloors?: number }): EnrichExcerpt[] {
  const end = Math.min(opts.end, chat.length);
  if (!terms.length || opts.maxChars <= 0 || end <= 0) return [];
  let start = 0;
  if (opts.maxAiFloors !== undefined) {
    let count = 0;
    for (let i = end - 1; i >= 0; i--) {
      if (!isAiFloor(chat[i])) continue;
      count++;
      if (count > opts.maxAiFloors) { start = i + 1; break; }
    }
  }
  const out: EnrichExcerpt[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (let i = start; i < end && used < opts.maxChars; i++) {
    const m = chat[i];
    if (!isSourceMessage(m)) continue;
    const body = cleanBody(m.mes);
    if (!terms.some(t => body.includes(t))) continue;
    for (const paragraph of body.split(/\n+/).map(p => p.trim()).filter(Boolean)) {
      if (!terms.some(t => paragraph.includes(t))) continue;
      const text = fitText(excerptOf(paragraph, terms), opts.maxChars - used);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ floor: i, text });
      used += text.length;
      if (used >= opts.maxChars) break;
    }
  }
  return out;
}

export interface EnrichTarget {
  name: string;
  /** 档案里为空、要请模型补的字段 */
  missing: NpcEnrichField[];
  /** 已有档案(给模型核对人物用) */
  profile: EnrichFields;
  /** 无名角色的职业词;不是标签时为空串 */
  labelBase: string;
  terms: string[];
  excerpts: EnrichExcerpt[];
}

function profileOf(npc: MemNpc): EnrichFields {
  const out: EnrichFields = {};
  for (const key of NPC_ENRICH_FIELDS) if (npc[key]?.trim()) out[key] = npc[key]!.trim();
  return out;
}

function pickFields(fields: EnrichFields | undefined, keys: readonly NpcEnrichField[]): EnrichFields {
  const out: EnrichFields = {};
  for (const key of keys) if (fields?.[key]) out[key] = fields[key];
  return out;
}

export interface AutoEnrichPlan {
  /** 不发请求即可写入的结果:重新摘要沿用的旧结果,以及同一楼翻页后沿用的记录 */
  reused: NpcEnrichment[];
  /** 要发请求的角色(已带摘录) */
  targets: EnrichTarget[];
}

/**
 * 决定本楼要补哪些角色。before/after 为本楼之前、之后(已施加本楼摘要)的状态;
 * floorText 为本楼送去摘要的正文;replaceLeaf 为重新摘要时的原叶子(沿用其结果,不发新请求)。
 * allowRequests=false(设置里关闭了「回看原文补全角色档案」)时只沿用已补好的结果,不检索、不发请求。
 */
export function planAutoEnrichment(a: {
  chat: STMessage[];
  aiFloor: number;
  beforeIndex: number;
  before: { npcs: MemNpc[] };
  after: { npcs: MemNpc[] };
  floorText: string;
  replaceLeaf?: LeafExtra;
  charName?: string;
  record: EnrichRecord;
  allowRequests?: boolean;
}): AutoEnrichPlan {
  const afterByKey = new Map(a.after.npcs.map(n => [norm(n.name), n]));
  const reused: NpcEnrichment[] = [];
  const covered = new Set<string>();
  for (const e of cleanEnrichment(a.replaceLeaf?.enriched)) {
    if (!afterByKey.has(norm(e.name)) || covered.has(norm(e.name))) continue;
    reused.push(e);
    covered.add(norm(e.name));
  }
  const beforeIds = new Set(a.before.npcs.map(n => n.id));
  const charKey = a.charName?.trim() ? norm(a.charName) : '';
  // 职业词只在名册里没有同职业的其他无名角色时才用来检索:已有「酒保A」时,早先原文里的「酒保」多半指他,
  // 拿来给新的「酒保B」补档只会白发请求。
  const baseOwners = new Map<string, Set<string>>();
  for (const n of a.after.npcs) {
    for (const base of [n.name, ...(n.formerNames ?? [])].map(npcLabelBase).filter(Boolean)) {
      if (!baseOwners.has(base)) baseOwners.set(base, new Set());
      baseOwners.get(base)!.add(n.id);
    }
  }
  const sharedBase = (term: string) => (baseOwners.get(term)?.size ?? 0) > 1;
  const targets: EnrichTarget[] = [];
  let budget = ENRICH_TOTAL_CHARS;
  for (const npc of a.after.npcs) {
    const key = norm(npc.name);
    if (covered.has(key) || key === charKey) continue;
    const renamed = (npc.formerNames ?? []).some(f => beforeIds.has(npcId(f)));
    const isNew = !beforeIds.has(npc.id) && !renamed;
    if (!isNew && !npcMentioned(a.floorText, npc.name, npc.formerNames)) continue;
    if (!needsEnrichment(npc)) continue;
    const missing = enrichMissingFields(npc);
    const entry = a.record.npcs[key];
    if (entry?.fields && entry.floor === a.aiFloor) {
      const fields = pickFields(entry.fields, missing);
      if (Object.keys(fields).length) reused.push({ name: npc.name, fields, source: 'auto' });
      covered.add(key);
      continue;
    }
    if (autoEnrichBlocked(entry) || a.replaceLeaf || a.allowRequests === false) continue;
    if (targets.length >= ENRICH_MAX_TARGETS || budget <= 0) continue;
    const end = isNew ? a.beforeIndex : Math.min(a.beforeIndex, segmentStart(a.chat, npc.firstFloor ?? a.beforeIndex));
    const terms = npcSearchTerms(npc.name, npc.formerNames).filter(t => !sharedBase(t));
    const excerpts = collectNpcExcerpts(a.chat, terms, { end, maxChars: Math.min(ENRICH_TARGET_CHARS, budget), maxAiFloors: ENRICH_AUTO_AI_FLOORS });
    if (!excerpts.length) continue;
    budget -= excerpts.reduce((n, e) => n + e.text.length, 0);
    const base = npcLabelBase(npc.name);
    targets.push({ name: npc.name, missing, profile: profileOf(npc), labelBase: terms.includes(base) ? base : '', terms, excerpts });
  }
  return { reused, targets };
}

/* ============ 请求与解析 ============ */

function fmtTargets(targets: EnrichTarget[]): string {
  return targets.map((t, i) => {
    const profile = NPC_ENRICH_FIELDS.filter(k => t.profile[k]).map(k => `${ENRICH_FIELD_LABELS[k]}:${oneLine(t.profile[k]!)}`).join(';');
    const lines = [
      `${i + 1}. ${t.name}`,
      `   已有档案:${profile || '(无)'}`,
      `   待补字段:${t.missing.map(k => `${ENRICH_FIELD_LABELS[k]} ${k}`).join('、')}`,
    ];
    if (t.labelBase) lines.push(`   说明:无名角色,摘录按职业词「${t.labelBase}」检索,可能混有同职业的其他人`);
    return lines.join('\n');
  }).join('\n');
}

function fmtExcerpts(targets: EnrichTarget[]): string {
  return targets.map(t => `〔${t.name}〕\n${t.excerpts.map(e => `[#${e.floor}] ${e.text}`).join('\n')}`).join('\n\n');
}

/** 组装请求消息:任务说明(与摘要同一设置)、规则、材料。 */
export function buildEnrichMessages(targets: EnrichTarget[], opts: { user: string; char: string; contentBoundary: boolean }): ChatMsg[] {
  const prompt = buildNpcEnrichPrompt({ user: opts.user, char: opts.char, targets: fmtTargets(targets), content: fmtExcerpts(targets) }, { contentBoundary: opts.contentBoundary });
  const messages: ChatMsg[] = [];
  const jb = taskContextPrompt();
  if (jb) messages.push({ role: 'system', content: jb });
  messages.push({ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user });
  return messages;
}

export class EnrichReplyError extends Error {}

export interface EnrichResult {
  fields: EnrichFields;
  evidence: EnrichFields;
  /** 模型给了内容、但因超出长度上限或原句与摘录对不上而没有采用的字段数 */
  rejected: number;
}

/**
 * 解析补档结果:根键 npcs 为数组。只收待补字段;每个字段都要有能在该角色摘录中连续找到的 evidence,
 * 且不超过长度上限(外貌 240、性格 160、身份 60 字),否则只丢弃这个字段(不截断)。结构不对时抛 EnrichReplyError。
 * 给了内容却全被丢弃的角色也在结果里(fields 为空、rejected 大于 0),调用方据此记为失败、之后可以再试。
 */
export function parseEnrichReply(raw: string, targets: EnrichTarget[]): Map<string, EnrichResult> {
  const parsed = extractJsonObject<unknown>(raw);
  if (!record(parsed) || !Array.isArray(parsed.npcs)) {
    throw new EnrichReplyError(raw.trim() ? '补档结果不是根键 npcs 为数组的 JSON 对象。' : '模型返回了空内容。');
  }
  const out = new Map<string, EnrichResult>();
  for (const item of parsed.npcs) {
    if (!record(item) || typeof item.name !== 'string') continue;
    const target = targets.find(t => norm(t.name) === norm(item.name as string));
    if (!target) continue;
    const evidence = record(item.evidence) ? item.evidence : {};
    const matches = createSourceEvidenceMatcher(target.excerpts.map(e => e.text));
    const result = out.get(target.name) ?? { fields: {}, evidence: {}, rejected: 0 };
    for (const key of target.missing) {
      const value = typeof item[key] === 'string' ? oneLine(item[key] as string) : '';
      if (!value || /^(未知|不详|未提及|不明|无)$/.test(value)) continue;
      const quote = typeof evidence[key] === 'string' ? (evidence[key] as string).trim() : '';
      if (value.length > FIELD_MAX[key] || !quote || !matches(quote)) { result.rejected++; continue; }
      result.fields[key] = value;
      result.evidence[key] = quote;
    }
    if (Object.keys(result.fields).length || result.rejected) out.set(target.name, result);
  }
  return out;
}

/** 发请求并解析;失败抛出(调用方决定怎么记录)。 */
export async function requestEnrichment(
  send: (messages: ChatMsg[]) => Promise<string>,
  targets: EnrichTarget[],
  opts: { user: string; char: string; contentBoundary: boolean },
): Promise<Map<string, EnrichResult>> {
  const raw = await send(buildEnrichMessages(targets, opts));
  return parseEnrichReply(raw, targets);
}

/** 自动补档的结果:写进本楼叶子的条目,以及提交时要写的记录。 */
export interface AutoEnrichOutcome {
  entries: NpcEnrichment[];
  records: EnrichRecordUpdate[];
}

/**
 * 摘要落叶前的自动补档。请求失败或超时不抛出,只把这些角色记为失败;结果交给调用方随叶子一起提交。
 * 超时上限 ENRICH_TIMEOUT_MS:补档是附带请求,不能让本楼摘要一直等着写入。
 */
export async function runAutoEnrichment(
  plan: AutoEnrichPlan,
  floor: number,
  send: (messages: ChatMsg[]) => Promise<string>,
  opts: { user: string; char: string; contentBoundary: boolean },
): Promise<AutoEnrichOutcome> {
  const entries = [...plan.reused];
  const records: EnrichRecordUpdate[] = [];
  if (!plan.targets.length) return { entries, records };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`补档请求超过 ${ENRICH_TIMEOUT_MS / 1000} 秒没有返回`)), ENRICH_TIMEOUT_MS);
    });
    const results = await Promise.race([requestEnrichment(send, plan.targets, opts), timeout]);
    for (const t of plan.targets) {
      const r = results.get(t.name);
      if (r && Object.keys(r.fields).length) {
        entries.push({ name: t.name, fields: r.fields, source: 'auto' });
        records.push({ name: t.name, status: 'filled', floor, fields: r.fields });
      } else if (r?.rejected) {
        // 给了内容却因超长或原句对不上全被丢弃:记为失败,之后按尝试次数上限再试,不当作「原文没有可补内容」
        records.push({ name: t.name, status: 'failed', floor });
      } else {
        records.push({ name: t.name, status: 'empty', floor });
      }
    }
  } catch (error) {
    console.warn('[棱镜宝书] 回看原文补档案失败(不影响本楼摘要):', error instanceof Error ? error.message : error);
    for (const t of plan.targets) records.push({ name: t.name, status: 'failed', floor });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { entries, records };
}

/* ============ 角色页手动补全 ============ */

/** 角色页的补档状态(模块级,关窗重开后仍能看到进行中的角色)。 */
export const npcEnrichState = reactive({
  /** 正在请求的角色名;空表示空闲 */
  running: '',
});

export interface ManualEnrichResult {
  name: string;
  /** ok=有可补内容;empty=原文没有可补内容;complete=档案已完整;error=请求失败 */
  status: 'ok' | 'empty' | 'complete' | 'error';
  fields: EnrichFields;
  evidence: EnrichFields;
  /** 检索到的摘录条数 */
  excerpts: number;
  error?: { message: string; title: string; hint: string; detail: string };
}

/** 检索全部楼层并请求补档,结果交给角色页确认;此时不写入。 */
export async function previewManualEnrichment(name: string): Promise<ManualEnrichResult> {
  const empty = (status: ManualEnrichResult['status'], excerpts = 0): ManualEnrichResult => ({ name, status, fields: {}, evidence: {}, excerpts });
  const ctx = getContext();
  const npc = memory.npcs.find(n => n.id === npcId(name));
  if (!ctx || !npc) return { ...empty('error'), error: { message: '找不到这个角色，可能刚被改名或删除。', title: '找不到这个角色', hint: '关闭后重新打开角色页再试。', detail: '' } };
  const missing = enrichMissingFields(npc);
  if (!missing.length) return empty('complete');
  const chat = ctx.chat ?? [];
  const excerpts = collectNpcExcerpts(chat, npcSearchTerms(npc.name, npc.formerNames), { end: chat.length, maxChars: ENRICH_MANUAL_CHARS });
  if (!excerpts.length) return empty('empty');
  const sender = resolveSender('summary');
  if ('error' in sender) return { ...empty('error', excerpts.length), error: { message: sender.error, title: '没有可用的 API', hint: sender.error, detail: '' } };
  const target: EnrichTarget = { name: npc.name, missing, profile: profileOf(npc), labelBase: npcLabelBase(npc.name), terms: npcSearchTerms(npc.name, npc.formerNames), excerpts };
  npcEnrichState.running = npc.name;
  try {
    const results = await requestEnrichment(sender.send, [target], { user: ctx.name1, char: ctx.name2, contentBoundary: sender.contentBoundary });
    const r = results.get(npc.name);
    if (r && Object.keys(r.fields).length) return { name: npc.name, status: 'ok', fields: r.fields, evidence: r.evidence, excerpts: excerpts.length };
    if (r?.rejected) {
      const hint = '外貌不超过 240 字、性格不超过 160 字、身份不超过 60 字，且每项都要附与原文一致的原句；超出或原句对不上的字段不采用，也不截断。可以重试，或换一个模型。';
      return { ...empty('error', excerpts.length), error: { message: '模型给出的档案没有采用。' + hint, title: '模型给出的档案超出长度上限或原句与原文对不上', hint, detail: '' } };
    }
    return empty('empty', excerpts.length);
  } catch (error) {
    if (error instanceof EnrichReplyError) {
      const hint = `可以重试；也可以在「${sender.settings}」中换一个模型。`;
      return { ...empty('error', excerpts.length), error: { message: '模型没有按要求输出补档结果。' + hint, title: '模型没有按要求输出补档结果', hint, detail: error.message } };
    }
    const view = describeFailure(error, '补全档案没有完成', sender.settings);
    const hint = view.hint || `可以重试；摘要任务所用的 API 在「${sender.settings}」中设置。`;
    return { ...empty('error', excerpts.length), error: { message: view.hint ? view.message : view.title + '。' + hint, title: view.title, hint, detail: view.detail || (error instanceof Error && !(error instanceof ApiError) ? error.message : '') } };
  } finally {
    npcEnrichState.running = '';
  }
}

/**
 * 写入确认后的补档结果:挂在最新一条有效叶子上,重放时只填空字段;同时记下已补,之后不再自动请求。
 * fields 为空表示用户确认「没有可补内容」,只写记录。无有效叶子或记忆受保护时返回 false。
 */
export function applyManualEnrichment(name: string, fields: EnrichFields): boolean {
  if (memoryWriteIssue()) return false;
  const found = latestLeaf();
  if (!found) return false;
  const clean = pickFields(fields, NPC_ENRICH_FIELDS);
  if (Object.keys(clean).length) {
    if (!appendEnrichmentToLatestLeaf({ name, fields: clean, source: 'manual' })) return false;
    writeEnrichRecords([{ name, status: 'filled', floor: found.index, fields: clean }]);
    refreshInjection();
    return true;
  }
  writeEnrichRecords([{ name, status: 'empty', floor: found.index }]);
  return true;
}
