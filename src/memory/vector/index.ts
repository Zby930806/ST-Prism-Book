/**
 * 向量索引编排:把当前聊天的有效叶子同步进后端向量库(该角色的 chat:<chatId> scope)。
 *
 * 流程(增量、幂等):
 *  1. 扫 chat 收集有效叶子 → present = [{leafId, docHash, payloadHash}]。
 *  2. vec/reconcile:后端删掉陈旧，并区分摘要变化与「仅全文/时间变化」。
 *  3. 摘要变化才重新 embed+upsert；仅全文/时间变化走轻量 payload 更新。
 * 同文本(同 hash)不重复 embed —— 这是「边玩边索引」不卡的关键。
 *
 * 调用时机:叶子生成/编辑/删除后(防抖触发,见 schedule)。全程 try/catch 静默,
 * 向量是增强项,失败绝不影响摘要主流程。
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import type { VecItem, VecPayloadItem } from '@/api/baibaoku';
import { resetVectorStoreProbe, vecClearScope, vecReconcile, vecUpdatePayload, vecUpsert } from './store';
import { getLeaf, leafValid } from '../apply';
import { memory } from '../store';
import { stripThinkBlocks } from '../timeTag';
import type { LeafExtra } from '../types';
import { embedTexts, encodeFloat32Base64 } from './embed';
import { currentChatId, currentVectorDb } from './scope';
import { invalidateRecallCache } from './cache';

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

interface LeafForIndex {
  leafId: string;
  docHash: string;
  payloadHash: string;
  document: string; // 叶子摘要文本(向量化对象 + 摘要档回传)
  mesFull: string; // 楼层原文(全文档回传)
  storyTime: string;
  msgIndex: number;
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

/** 扫当前 chat 收集所有有效叶子的索引素材(种子叶子除外)。 */
function collectLeaves(chat: STMessage[]): LeafForIndex[] {
  const seeds = seedLeafIds();
  const out: LeafForIndex[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i]) as LeafExtra;
    if (leaf.seed || seeds.has(leaf.id)) continue; // 种子叶子:承载整段总结,不进向量库(见 LeafExtra.seed)
    const document = (leaf.text ?? '').trim();
    if (!document) continue; // 空摘要不索引
    const mesFull = stripThinkBlocks(chat[i].mes);
    const storyTime = leafStoryTime(leaf);
    out.push({
      leafId: leaf.id,
      docHash: docHashOf(document),
      payloadHash: payloadHashOf(mesFull, storyTime),
      document,
      // 存近乎原文:只预剥思维链(确定性噪声,省空间且零风险),其余清洗(自定义标签等)
      // 留到召回时过 cleanBody——这样用户日后调整「自定义清洗标签」设置,老索引也即时生效,无需重建。
      mesFull,
      storyTime,
      msgIndex: i,
    });
  }
  return out;
}

export interface VectorSyncResult {
  embedded: number;
  payloadUpdated: number;
}

let indexingPromise: Promise<VectorSyncResult> | null = null;
let indexingKey = '';
let mutationRevision = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 向量记忆是否在当前聊天可索引(总开关开 + 当前角色未排除 + 向量开关开 + 进入了单角色聊天)。 */
export function vectorIndexableHere(): boolean {
  if (!engineActiveHere()) return false; // 插件总开关关 / 当前角色被排除 → 不索引
  if (!apiSettings.vector.enabled) return false;
  return !!currentVectorDb() && !!currentChatId();
}

/**
 * 把当前聊天的叶子同步进向量库(增量)。可被防抖 schedule 或手动「重建索引」直接调用。
 * @returns 本轮重新生成向量与仅更新附属数据的条数。
 */
export async function syncVectorIndex(signal?: AbortSignal): Promise<VectorSyncResult> {
  if (!vectorIndexableHere()) return { embedded: 0, payloadUpdated: 0 };
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return { embedded: 0, payloadUpdated: 0 };
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
        const missingSet = new Set(missing);
        const staleSet = new Set(stalePayload);
        total.embedded += await embedAndUpsert(
          database,
          scope,
          leaves.filter(l => missingSet.has(l.leafId)),
          signal,
        );
        total.payloadUpdated += await updatePayload(
          database,
          scope,
          leaves.filter(l => staleSet.has(l.leafId)),
        );
        // 索引运行期间又发生编辑时，再扫一轮，避免 single-flight 吞掉新变化。
      } while (passRevision !== mutationRevision);
    } catch (e) {
      console.warn('[棱镜宝书向量] 索引同步失败(不影响摘要):', e);
    }
    return total;
  };

  indexingKey = taskKey;
  indexingPromise = run().finally(() => {
    indexingPromise = null;
    indexingKey = '';
  });
  return indexingPromise;
}

/** embed 一批叶子并 upsert 到指定 scope;返回实际写入条数。embedTexts 内部按 64 分批。 */
async function embedAndUpsert(database: string, scope: string, todo: LeafForIndex[], signal?: AbortSignal): Promise<number> {
  if (!todo.length) return 0;
  const vectors = await embedTexts(todo.map(l => l.document), signal);
  const items: VecItem[] = todo.map((l, i) => {
    const vec = vectors[i];
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
  });
  await vecUpsert(database, scope, items);
  return items.length;
}

/** 摘要未变时只更新全文和时间，不调用 embedding。 */
async function updatePayload(database: string, scope: string, todo: LeafForIndex[]): Promise<number> {
  if (!todo.length) return 0;
  const items: VecPayloadItem[] = todo.map(l => ({
    leafId: l.leafId,
    payloadHash: l.payloadHash,
    mesFull: l.mesFull,
    storyTime: l.storyTime,
  }));
  const { updated } = await vecUpdatePayload(database, scope, items);
  return updated;
}

/**
 * 召回前补齐索引并刷新过期 payload。与后台索引共用 single-flight；
 * 运行期间发生的新编辑会在当前任务结束前自动补跑。
 */
export async function ensureRecallIndex(signal?: AbortSignal): Promise<void> {
  if (!vectorIndexableHere()) return;
  await syncVectorIndex(signal);
}

/**
 * 清空当前聊天的向量索引(只清 chat:<chatId> scope,不动继承的 bundle 快照)。
 * 用于「索引脏了/想重来」:清空后可用「重建」从头索引。返回删除条数。
 * 不走 vectorIndexableHere 闸门(用户手动操作,即便向量开关临时关也应允许清理),
 * 但仍需当前库+聊天 id 才有目标 scope。
 */
export async function clearVectorIndex(): Promise<number> {
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return 0;
  invalidateRecallCache();
  resetVectorStoreProbe(); // 手动维护前重测后端,后端刚就绪/刚停都能切到对的 store
  const { deleted } = await vecClearScope(database, `chat:${chatId}`);
  return deleted;
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
