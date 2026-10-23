/**
 * 向量索引编排:把当前聊天的有效叶子同步进后端向量库(该角色的 chat:<chatId> scope)。
 *
 * 流程(增量、幂等):
 *  1. 扫 chat 收集有效叶子 → present = [{leafId, docHash, payloadHash}]。
 *  2. vec/reconcile:后端删掉陈旧，并区分摘要变化与「仅全文/时间变化」。
 *  3. 摘要变化才重新 embed+upsert(每批算完立即写入,失败时已写入的保留);仅全文/时间变化走轻量 payload 更新。
 * 同文本(同 hash)不重复 embed —— 这是「边玩边索引」不卡的关键。
 *
 * 调用时机:叶子生成/编辑/删除后(防抖触发,见 schedule)、每次召回前、设置页手动补齐。
 * 失败不抛错:结果里带 error/skipped,后台索引与召回前补索引照常忽略,设置页据此显示原因。
 * 向量是增强项,失败绝不影响摘要主流程。
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import type { VecItem, VecPayloadItem } from '@/api/baibaoku';
import { resetVectorStoreProbe, vecClearScope, vecReconcile, vecUpdatePayload, vecUpsert } from './store';
import { getLeaf, leafValid } from '../apply';
import { isAiFloor } from '../engine';
import { memory, memoryWriteIssue } from '../store';
import { cleanBody } from '../timeTag';
import type { LeafExtra } from '../types';
import { EMBED_BATCH, embedTexts, encodeFloat32Base64 } from './embed';
import { currentChatId, currentVectorDb } from './scope';
import { invalidateRecallCache } from './cache';
import { forgetIndexModel, noteIndexModel } from './indexModel';

/** 轻量稳定 hash(FNV-1a,16 进制);叶子摘要文本变了 hash 即变,触发重 embed。 */
function docHashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 全文与故事时间的版本指纹；二者变化只刷新 payload，不重新生成摘要向量。 */
function payloadHashOf(mesFull: string, storyTime: string): string {
  return docHashOf(JSON.stringify([mesFull, storyTime]));
}

export interface LeafForIndex {
  leafId: string;
  docHash: string;
  payloadHash: string;
  document: string; // 叶子摘要文本(向量化对象 + 摘要档回传)
  mesFull: string; // 叶子覆盖的原文:用户发言 + AI 回复(全文档回传、rerank 打分)
  storyTime: string;
  msgIndex: number;
}

/** 每条用户发言放进「原文」的字数上限;超出部分省略并注明。 */
const USER_TURN_MAX_CHARS = 1500;

/**
 * 清洗后的楼层正文(与喂摘要模型同口径的 cleanBody),按消息缓存:
 * 正文与自定义清洗标签都没变时直接复用,长聊天每次对账不必把全部楼层重洗一遍。
 */
const cleanCache = new WeakMap<STMessage, { mes: string; tags: string; text: string }>();
function cleanedFloor(m: STMessage): string {
  const mes = typeof m.mes === 'string' ? m.mes : '';
  const tags = Array.isArray(apiSettings.customStripTags) ? apiSettings.customStripTags.join('\u0001') : '';
  const hit = cleanCache.get(m);
  if (hit && hit.mes === mes && hit.tags === tags) return hit.text;
  const text = cleanBody(mes).trim();
  cleanCache.set(m, { mes, tags, text });
  return text;
}

/**
 * 叶子覆盖范围内的用户发言:从这条 AI 楼往前到上一条 AI 楼为止(与摘要的覆盖范围同口径)。
 * 番外楼跳过;插件隐藏的旧发言照常算;用户自己隐藏的发言不算。
 */
function userTurnsBefore(chat: STMessage[], aiFloor: number): STMessage[] {
  const out: STMessage[] = [];
  for (let i = aiFloor - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m) continue;
    if (m.extra?.bbs_omit) continue;
    if (isAiFloor(m)) break;
    if (m.is_user && (!m.is_system || m.extra?.bbs_hidden)) out.unshift(m);
  }
  return out;
}

function clipUserTurn(text: string): string {
  if (text.length <= USER_TURN_MAX_CHARS) return text;
  return `${text.slice(0, USER_TURN_MAX_CHARS).trimEnd()}……（这条发言较长，后文省略）`;
}

/**
 * 叶子的「原文」:有用户发言时按说话人标注「主角：」「角色：」,与摘要覆盖的范围一致,
 * 主角在用户楼里许下的约定、说出的关键台词也能随全文档召回、参与 rerank 打分。
 * 各段都已过 cleanBody(剔除状态栏/思维链/自定义标签,时间标签转成内联文本);
 * 清洗设置改变时 payloadHash 随之改变,下次对账走轻量 payload 更新,不必重新 embedding。
 */
function leafFullText(chat: STMessage[], aiFloor: number): string {
  const ai = cleanedFloor(chat[aiFloor]);
  const users = userTurnsBefore(chat, aiFloor)
    .map(m => clipUserTurn(cleanedFloor(m)))
    .filter(Boolean);
  if (!users.length) return ai;
  return [...users.map(t => `主角：${t}`), ai ? `角色：${ai}` : ''].filter(Boolean).join('\n\n');
}

/**
 * 叶子的故事时间,存为**未压缩**的完整起止段「起 - 止」(起止相同/缺一端则单点)。
 * 为何不压缩(不删结束端重复日期):召回端要从这串里拆回**完整结束时间**算相对时间,
 * 压缩后结束端会缺日期(如「06:55」)导致算不出相对。显示时召回端再 compactTimeLabel 压成区间。
 */
function leafStoryTime(leaf: LeafExtra): string {
  const start = leaf.timeStart?.trim() || '';
  const end = leaf.timeEnd?.trim() || '';
  if (start && end) return start === end ? start : `${start} - ${end}`;
  return start || end || leaf.timeLabel?.trim() || '';
}

/**
 * 种子叶子的 id 集合(carryover 挂 #0、承载旧对话合并总结的那条,不索引进向量库)。
 * 识别两条口径,任一命中即算:
 *  - 新数据:leaf.seed === true(carryover.ts 显式打标)。
 *  - 老数据(标记出现前建的 carryover 聊天):被 id 以 `sum_carry_` 开头的总结节点 childIds 收纳的叶子。
 * 这样已存在的老聊天无需迁移——reconcile 下次对账时会把这条陈旧索引自动删掉。
 */
function seedLeafIds(): Set<string> {
  const ids = new Set<string>();
  for (const s of memory.summaries) {
    if (!s.id.startsWith('sum_carry_')) continue;
    for (const c of s.childIds ?? []) ids.add(c);
  }
  return ids;
}

/** 扫当前 chat 收集所有有效叶子的索引素材(种子叶子除外)。关键词召回也用它,和向量库收录的范围一致。 */
export function collectLeaves(chat: STMessage[]): LeafForIndex[] {
  const seeds = seedLeafIds();
  const out: LeafForIndex[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i]) as LeafExtra;
    if (leaf.seed || seeds.has(leaf.id)) continue; // 种子叶子:承载整段总结,不进向量库(见 LeafExtra.seed)
    const document = (leaf.text ?? '').trim();
    if (!document) continue; // 空摘要不索引
    const mesFull = leafFullText(chat, i);
    const storyTime = leafStoryTime(leaf);
    out.push({
      leafId: leaf.id,
      docHash: docHashOf(document),
      payloadHash: payloadHashOf(mesFull, storyTime),
      document,
      mesFull,
      storyTime,
      msgIndex: i,
    });
  }
  return out;
}

/** 一条没能生成向量、已跳过的摘要。 */
export interface FailedLeaf {
  /** 所在楼层号 */
  floor: number;
  /** 被拒收的原因(接口原话已脱敏) */
  reason: string;
}

export interface VectorSyncResult {
  /** 本轮新写入向量的条数 */
  embedded: number;
  /** 本轮只更新全文/时间的条数 */
  payloadUpdated: number;
  /** 没能完成时的原因(已写明处理方法和设置位置);已写入的批次保留。后台索引与召回前补索引不提示它。 */
  error?: string;
  /** 本次没有执行的原因(向量记忆未启用、不是单角色聊天、数据保护中等)。 */
  skipped?: string;
  /** 内容被 embedding 接口拒收、已跳过的摘要(其余照常写入) */
  failedLeaves?: FailedLeaf[];
}

let indexingPromise: Promise<VectorSyncResult> | null = null;
let indexingKey = '';
let mutationRevision = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/* —— 补索引进度:召回状态据此显示「正在补建索引(剩余 n 条)」 —— */
let pendingCount = 0;
const pendingListeners = new Set<(pending: number) => void>();
function setPending(n: number): void {
  pendingCount = Math.max(0, n);
  for (const fn of pendingListeners) {
    try {
      fn(pendingCount);
    } catch {
      /* 显示用的回调出错不影响索引 */
    }
  }
}

/* —— 被 embedding 接口拒收的摘要:本次会话内不再反复请求;摘要改动、换模型或手动补齐时重新尝试 —— */
const rejectedLeaves = new Map<string, string>();
function rejectedKey(model: string, database: string, scope: string, leaf: LeafForIndex): string {
  return [model, database, scope, leaf.leafId, leaf.docHash].join('\u0000');
}

/** 手动补齐前调用:之前被拒收的摘要重新尝试一次。 */
export function forgetRejectedLeaves(): void {
  rejectedLeaves.clear();
}

function embeddingModelName(): string {
  const model = apiSettings.vector?.embedding?.model;
  return typeof model === 'string' ? model.trim() : '';
}

/**
 * 当前聊天不能建立向量索引的原因;可以索引时返回空串。
 * 设置页据此说明为什么不能补齐,不再笼统地显示「索引已是最新」。
 */
export function vectorIndexBlockReason(): string {
  const issue = memoryWriteIssue();
  if (issue) return `当前聊天的记忆处于保护状态，暂不写入向量索引。${issue}`;
  if (!apiSettings.enabled) return '棱镜宝书已停用（设置页顶部的总开关），不建立向量索引。';
  if (!engineActiveHere()) return '当前角色在「设置 → 高级过滤 → 排除角色」名单中，不建立向量索引。';
  if (!apiSettings.vector.enabled) return '向量记忆未启用，请先在「设置 → 向量记忆」中打开「启用向量记忆」。';
  if (!currentVectorDb()) return '当前不是单角色聊天（群聊或没有选择角色），不建立向量索引。';
  if (!currentChatId()) return '还没有打开聊天，不建立向量索引。';
  return '';
}

/** 向量记忆是否在当前聊天可索引(总开关开 + 当前角色未排除 + 向量开关开 + 进入了单角色聊天)。 */
export function vectorIndexableHere(): boolean {
  return !vectorIndexBlockReason();
}

/** 把索引失败写成一句完整说明:原因、处理方法和设置位置。 */
function indexErrorText(e: unknown): string {
  const err = e as { name?: string; kind?: string; code?: unknown; message?: string } | null;
  const msg = e instanceof Error ? e.message : String(e);
  if (err?.kind === 'cancelled') return '补建索引已取消（停止了生成或切换了聊天），下次召回前会继续补齐。';
  // 向量接口的错误已写明原因、处理方法和设置位置
  if (err?.name === 'EmbedError') return msg;
  if (err?.name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return '浏览器存储空间不足，向量索引没有写完。请清理浏览器的网站数据，或安装柏宝库后端后，到「设置 → 向量记忆 → 索引维护」点「补齐当前聊天索引」。';
  }
  if (err?.code !== undefined || msg.includes('柏宝库')) {
    const base = msg.replace(/[。.]$/, '');
    return msg.includes('柏宝库')
      ? `${base}。可以到「设置 → 向量记忆 → 索引维护」点「补齐当前聊天索引」重试。`
      : `柏宝库向量接口出错：${base}。请确认柏宝库后端正常运行后，到「设置 → 向量记忆 → 索引维护」点「补齐当前聊天索引」。`;
  }
  return `写入向量索引失败：${msg.replace(/[。.]$/, '')}。可以到「设置 → 向量记忆 → 索引维护」点「补齐当前聊天索引」重试。`;
}

/**
 * 把当前聊天的叶子同步进向量库(增量)。可被防抖 schedule、召回前补索引或设置页「补齐当前聊天索引」调用。
 * 不抛错:失败写进 error,不能索引写进 skipped;已写入的批次保留,下次只补剩下的。
 * @returns 本轮重新生成向量与仅更新附属数据的条数,以及失败或跳过的原因。
 */
export async function syncVectorIndex(signal?: AbortSignal): Promise<VectorSyncResult> {
  const blocked = vectorIndexBlockReason();
  if (blocked) return { embedded: 0, payloadUpdated: 0, skipped: blocked };
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return { embedded: 0, payloadUpdated: 0, skipped: '还没有打开单角色聊天，不建立向量索引。' };
  const scope = `chat:${chatId}`;
  const taskKey = `${database}\0${scope}`;
  if (indexingPromise) {
    if (indexingKey === taskKey) return indexingPromise;
    // 上一聊天正在收尾时先等它结束，再按新聊天重新取上下文，绝不把新叶子写进旧 scope。
    await indexingPromise;
    return syncVectorIndex(signal);
  }

  const run = async (): Promise<VectorSyncResult> => {
    const total: VectorSyncResult = { embedded: 0, payloadUpdated: 0 };
    const failed: FailedLeaf[] = [];
    try {
      let passRevision: number;
      do {
        passRevision = mutationRevision;
        if (currentVectorDb() !== database || currentChatId() !== chatId) break;
        const leaves = collectLeaves(getContext()?.chat ?? []);
        const present = leaves.map(l => ({
          leafId: l.leafId,
          docHash: l.docHash,
          payloadHash: l.payloadHash,
        }));

        // 摘要变化走 embed+upsert；仅全文/时间变化走轻量 payload 更新。
        const { deleted = 0, missing, stalePayload = [] } = await vecReconcile(database, scope, present);
        // 后端对账删掉了陈旧条目（如用户经 ST 原生删楼、叶子随之消失）→ 召回依赖的内容已变，
        // 立即失效缓存，避免后续复用含已删记忆的旧注入。
        if (deleted > 0) invalidateRecallCache();
        const model = embeddingModelName();
        // 已有向量但还没有模型记录的老索引:视为当前模型(见 indexModel.ts)
        if (present.length > missing.length) noteIndexModel(database, scope, model);
        const missingSet = new Set(missing);
        const staleSet = new Set(stalePayload);
        const todo = leaves.filter(l => missingSet.has(l.leafId) && !rejectedLeaves.has(rejectedKey(model, database, scope, l)));
        const probe: RejectProbe = { written: 0, rejects: [] };
        try {
          await embedAndUpsert(database, scope, todo, model, probe, failed, signal);
        } finally {
          // 中途失败时,已写入的批次也计入结果
          total.embedded += probe.written;
        }
        const updated = await updatePayload(
          database,
          scope,
          leaves.filter(l => staleSet.has(l.leafId)),
        );
        total.payloadUpdated += updated;
        // 原文或时间变了:召回会读到新内容,旧的召回结果不再复用
        if (updated > 0) invalidateRecallCache();
        // 索引运行期间又发生编辑时，再扫一轮，避免 single-flight 吞掉新变化。
      } while (passRevision !== mutationRevision);
    } catch (e) {
      console.warn('[棱镜宝书向量] 索引同步失败(不影响摘要):', e);
      total.error = indexErrorText(e);
    } finally {
      setPending(0);
    }
    if (failed.length) total.failedLeaves = failed;
    return total;
  };

  indexingKey = taskKey;
  indexingPromise = run().finally(() => {
    indexingPromise = null;
    indexingKey = '';
  });
  return indexingPromise;
}

function toVecItem(l: LeafForIndex, vec: Float32Array): VecItem {
  return {
    leafId: l.leafId,
    docHash: l.docHash,
    payloadHash: l.payloadHash,
    vector: encodeFloat32Base64(vec),
    dim: vec.length,
    document: l.document,
    mesFull: l.mesFull,
    storyTime: l.storyTime,
    msgIndex: l.msgIndex,
  };
}

/** 这类错误多半是某条摘要本身的问题(过长、含接口不接受的内容),逐条重试能找出它。 */
function isBadInputError(e: unknown): boolean {
  const kind = (e as { kind?: string } | null)?.kind;
  return kind === 'bad-request' || kind === 'context-length';
}

/**
 * 逐批 embed 并立即写入(每批 EMBED_BATCH 条):中途失败时已写入的批次保留,下次只补剩下的。
 * 某一批被接口以「请求内容有误」拒收时逐条重试,找出被拒的摘要跳过并记录,其余照常写入。
 * 本轮一条都没写成、逐条重试又连续被拒 3 条时,多半是接口或模型本身的问题,不再逐条试,整体报错;
 * 这时已记下的拒收也不保留,免得把正常的摘要当成坏条目。
 * 写入条数累计在 probe.written(中途失败时也保留);被拒收的摘要在全部批次完成后追加到 failed。
 */
async function embedAndUpsert(
  database: string,
  scope: string,
  todo: LeafForIndex[],
  model: string,
  probe: RejectProbe,
  failed: FailedLeaf[],
  signal?: AbortSignal,
): Promise<void> {
  if (!todo.length) return;
  let remaining = todo.length;
  setPending(remaining);
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    // 记录这一批实际使用的模型:embedTexts 发请求时才读设置,一轮没跑完时用户可能已经换了模型(并清空重建)
    const usedModel = embeddingModelName();
    let vectors: Float32Array[] | null = null;
    try {
      vectors = await embedTexts(batch.map(l => l.document), signal);
    } catch (e) {
      if (!isBadInputError(e)) throw e;
    }
    if (vectors) {
      await vecUpsert(database, scope, batch.map((l, k) => toVecItem(l, vectors![k])));
      noteIndexModel(database, scope, usedModel, vectors[0]?.length);
      probe.written += batch.length;
    } else {
      await embedOneByOne(database, scope, batch, probe, signal);
    }
    remaining -= batch.length;
    setPending(remaining);
  }
  for (const { leaf, reason } of probe.rejects) {
    rejectedLeaves.set(rejectedKey(model, database, scope, leaf), reason);
    failed.push({ floor: leaf.msgIndex, reason });
  }
}

/** 本轮写入的统计:写成的条数,以及逐条重试时被拒收的摘要(本轮结束才记为坏条目)。 */
interface RejectProbe {
  written: number;
  rejects: Array<{ leaf: LeafForIndex; reason: string }>;
}

/** 逐条 embed 并写入,跳过被接口拒收的摘要。 */
async function embedOneByOne(
  database: string,
  scope: string,
  batch: LeafForIndex[],
  probe: RejectProbe,
  signal?: AbortSignal,
): Promise<void> {
  for (const leaf of batch) {
    try {
      const usedModel = embeddingModelName();
      const [vec] = await embedTexts([leaf.document], signal);
      await vecUpsert(database, scope, [toVecItem(leaf, vec)]);
      noteIndexModel(database, scope, usedModel, vec.length);
      probe.written++;
    } catch (e) {
      if (!isBadInputError(e)) throw e;
      if (!probe.written && probe.rejects.length >= 2) throw e;
      probe.rejects.push({ leaf, reason: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** payload 更新每次最多发送的条数:升级后首次对账会刷新全部叶子的原文,分批发送。 */
const PAYLOAD_BATCH = 100;

/** 摘要未变时只更新全文和时间，不调用 embedding。 */
async function updatePayload(database: string, scope: string, todo: LeafForIndex[]): Promise<number> {
  let updated = 0;
  for (let i = 0; i < todo.length; i += PAYLOAD_BATCH) {
    const items: VecPayloadItem[] = todo.slice(i, i + PAYLOAD_BATCH).map(l => ({
      leafId: l.leafId,
      payloadHash: l.payloadHash,
      mesFull: l.mesFull,
      storyTime: l.storyTime,
    }));
    const result = await vecUpdatePayload(database, scope, items);
    updated += result.updated;
  }
  return updated;
}

/** 召回前补索引的结果:是否超过等待时限、剩余条数、失败原因。 */
export interface RecallIndexState {
  /** 补索引没在时限内完成,本次先用已有索引召回(索引任务继续在后台进行) */
  timedOut?: boolean;
  /** 时限到时还剩多少条没写入 */
  pending?: number;
  /** 补索引失败的原因 */
  error?: string;
}

/**
 * 召回前补齐索引并刷新过期 payload。与后台索引共用 single-flight；
 * 运行期间发生的新编辑会在当前任务结束前自动补跑。
 *  - maxWaitMs:最多等这么久;到时先用已有索引召回,索引任务继续在后台跑(每批写入后即可被检索到)。
 *  - onPending:补索引期间报告剩余条数,召回状态据此显示「正在补建索引」。
 * 返回 undefined 或空对象表示没有需要说明的情况。
 */
export async function ensureRecallIndex(
  signal?: AbortSignal,
  opts: { maxWaitMs?: number; onPending?: (pending: number) => void } = {},
): Promise<RecallIndexState | undefined> {
  if (!vectorIndexableHere()) return {};
  const listener = opts.onPending;
  if (listener) pendingListeners.add(listener);
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const task = syncVectorIndex(signal);
    if (listener && pendingCount > 0) listener(pendingCount);
    const maxWait = opts.maxWaitMs;
    const result = typeof maxWait === 'number' && Number.isFinite(maxWait) && maxWait > 0
      ? await Promise.race([
        task,
        new Promise<'timeout'>(resolve => {
          waitTimer = setTimeout(() => resolve('timeout'), maxWait);
        }),
      ])
      : await task;
    if (result === 'timeout') return { timedOut: true, pending: pendingCount };
    return result.error ? { error: result.error } : {};
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
    if (listener) pendingListeners.delete(listener);
  }
}

/**
 * 清空当前聊天的向量索引(只清 chat:<chatId> scope,不动继承的 bundle 快照)。
 * 清空后下次召回前(或下一条摘要写入后)会自动重新建立全部索引;也可以用「清空并重建」立即重建。返回删除条数。
 * 不走 vectorIndexableHere 闸门(用户手动操作,即便向量开关临时关也应允许清理),
 * 但仍需当前库+聊天 id 才有目标 scope。
 */
export async function clearVectorIndex(): Promise<number> {
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return 0;
  const scope = `chat:${chatId}`;
  invalidateRecallCache();
  resetVectorStoreProbe(); // 手动维护前重测后端,后端刚就绪/刚停都能切到对的 store
  const { deleted } = await vecClearScope(database, scope);
  forgetIndexModel(database, scope);
  forgetRejectedLeaves();
  // 正在运行的索引任务按清空前的对账结果写入;让它结束前再对账一轮,把清空掉的部分补回来
  mutationRevision++;
  return deleted;
}

/** 清空并立即重建当前聊天的索引(换了 Embedding 模型后使用)。 */
export async function rebuildVectorIndex(): Promise<{ deleted: number; result: VectorSyncResult }> {
  const deleted = await clearVectorIndex();
  const result = await syncVectorIndex();
  return { deleted, result };
}

/** 防抖触发索引同步:叶子生成/编辑/删除后调用,合并连续变动为一次。
 * 注意:这里**不再**顺带失效召回缓存——重生成/翻页时 ST 会先发 MESSAGE_DELETED/MESSAGE_SWIPED
 * 再跑拦截器,若在此失效,缓存永远赶在拦截器查询之前被清空,重生成/翻页永远重新召回。
 * 召回缓存的失效只发生在「叶子内容真正变化」的落点(见 applyLeafForFloor / apply.ts 编辑删除 /
 * 对账删除),见 recall.ts 的 buildRecallCacheKey 注释:key 已排除正在重写的末 AI 楼,
 * 重生成/翻页本就该命中缓存。 */
export function scheduleVectorIndex(): void {
  mutationRevision++;
  if (timer) clearTimeout(timer);
  if (!vectorIndexableHere()) {
    timer = null;
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void syncVectorIndex();
  }, 2500);
}
