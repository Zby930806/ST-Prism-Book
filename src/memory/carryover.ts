/**
 * 带数据创建新对话(Carryover)。
 *
 * 把当前聊天(一堆历史楼层 + 最近全文窗口)→ 新建一个对话,带过去:
 *  - 合并历史摘要(窗口之前的剧情,选最高存活压缩层拼接)= 种子叶子的 text;
 *  - 当前结构化状态(截止窗口起点的 items/plans)→ 编码成「全量 add」delta = 种子叶子的 delta;
 *  - 最近保留窗口的楼层(原样全文 + 各自叶子)搬过去。
 *
 * 新对话靠现成重放管线(deriveMemory:空白起步逐叶子 fold)还原状态——无需特殊载体,
 * 只要造一片把状态编码成全量 add 的「种子叶子」挂在 #0,并另置一条 L2 总结收纳它(承载合并摘要文本)。
 *
 * 同时(若向量记忆开):把源聊天的向量快照成一个 bundle,哈希写进新聊天 metadata.bbs_bundles(累加),
 * 使新对话能向量召回源聊天的旧剧情。
 */

import { getContext, getDoNewChat, setMessageText, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { apiSettings } from '@/api/settings';
import { deriveMemory, makeLeafId } from './apply';
import { resolveKeepStart } from './engine';
import { refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { latestStoryTime } from './timeTag';
import { assertMemoryWritable, memoryWriteIssue, memory, recomputeDerived } from './store';
import { inspectCompatibility } from './compatibility';
import { MEMORY_KEY, MEMORY_VERSION } from './types';
import type { JsonValue, LeafExtra, MemSummary, StoredDelta } from './types';
import { isBaiBaoKuAvailable, vecBundleCreate } from '@/api/baibaoku';
import { appendBundleHash, BUNDLES_META_KEY, currentBundleHashes, currentVectorDb } from './vector/scope';

/** 携带计划:供 UI 预览「将携带多少」。 */
export interface CarryoverPlan {
  /** 保护态不是空历史；供调用方展示禁用原因。 */
  blockedReason?: string;
  /** 保留窗口起点(此索引起的楼层搬去新对话) */
  carryStart: number;
  /** 实际要搬的消息条数(窗口内非系统楼) */
  carryCount: number;
  /** 其中 AI 楼条数 */
  aiCount: number;
  /** 合并历史摘要字符数(0 = 无历史可摘) */
  recapLen: number;
  /** 当前是否有可携带数据 */
  hasData: boolean;
}

function cloneJsonRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortJson(v);
    }
    return out;
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
}

function deltaHasData(delta: StoredDelta): boolean {
  return !!(
    delta.time ||
    delta.location ||
    delta.locationPath !== undefined ||
    delta.sceneFocus ||
    delta.lifeDetails?.add?.length ||
    delta.lifeDetails?.update?.length ||
    delta.lifeDetails?.archive?.length ||
    delta.lifeDetails?.remove?.length ||
    (delta.protagonist && Object.keys(delta.protagonist).length) ||
    delta.items?.add?.length ||
    delta.items?.update?.length ||
    delta.items?.remove?.length ||
    delta.scenes?.add?.length ||
    delta.scenes?.update?.length ||
    delta.scenes?.reparent?.length ||
    delta.scenes?.remove?.length ||
    delta.scenes?.ops?.length ||
    delta.npcs?.add?.length ||
    delta.npcs?.update?.length ||
    delta.npcs?.remove?.length ||
    delta.plans?.add?.length ||
    delta.plans?.update?.length ||
    delta.plans?.resolve?.length ||
    delta.plans?.remove?.length ||
    delta.plans?.reopen?.length ||
    delta.varOps?.length
  );
}

/** 把「截止窗口起点的派生状态」编码成全量 add 的 StoredDelta(种子叶子的 delta)。
 *  leafId:种子叶子的 id(生活细节的稳定 id 由它派生,需先生成)。 */
function encodeStateAsDelta(state: ReturnType<typeof deriveMemory>, leafId: string): StoredDelta {
  const delta: StoredDelta = {};
  if (state.state.time) delta.time = state.state.time;
  if (state.state.location) {
    delta.location = state.state.location;
  }
  if (state.state.locationPath !== undefined) delta.locationPath = [...state.state.locationPath];
  if (Object.values(state.protagonist).some(Boolean)) {
    delta.protagonist = { ...state.protagonist };
  }
  // 局势卡:当前场面快照一并带走(新对话从同一局面接着演)
  if (state.state.sceneFocus) {
    delta.sceneFocus = { ...state.state.sceneFocus, participants: [...state.state.sceneFocus.participants] };
  }
  // 生活小档案:全量带走(含沉降层——带走的是档案本身,投放层继续按 tier 工作)
  if (state.lifeDetails.length) {
    delta.lifeDetails = {
      add: state.lifeDetails.map(d => ({
        subject: d.subject,
        text: d.text,
        topics: [...d.topics],
        anchors: [...d.anchors],
        until: d.until,
      })),
      // 非 active 的层级用 update 恢复(pinned/archive 在种子里先以 active 落地,再逐条拨回)
      update: state.lifeDetails
        .map((d, i) => ({ id: `detail:${leafId}#${i}`, tier: d.tier }))
        .filter(u => u.tier !== 'active'),
    };
  }

  if (state.items.length) {
    delta.items = {
      add: state.items.map(i => ({
        name: i.name,
        qty: i.qty,
        desc: i.desc,
        carried: i.carried,
        location: i.location,
      })),
    };
  }
  if (state.scenes.length) {
    delta.scenes = {
      add: [...state.scenes]
        .sort((a, b) => a.path.length - b.path.length || a.createdAt - b.createdAt || a.name.localeCompare(b.name))
        .map(s => ({
          path: [...s.path],
          // 种子恢复既有树结构，清空过描述的节点也必须保留。
          desc: s.desc ?? '',
        })),
    };
  }
  if (state.npcs.length) {
    delta.npcs = {
      add: state.npcs.map(n => ({
        name: n.name,
        gender: n.gender,
        // 年龄连同原锚点一起带走:不带 ageTime 的话,种子叶子重放会把锚点刷成建新对话当天,年龄推算全错
        age: n.age,
        ageTime: n.ageTime,
        relation: n.relation,
        affinityInner: n.affinityInner,
        affinityOuter: n.affinityOuter,
        affinityNote: n.affinityNote,
        ties: n.ties,
        title: n.title,
        desc: n.desc,
        personality: n.personality,
        outfit: n.outfit,
        condition: n.condition,
        important: n.important,
        follow: n.follow,
        location: n.location,
        locationStale: n.locationStale,
        lastKnownLocation: n.lastKnownLocation,
      })),
    };
  }
  const openPlans = state.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    delta.plans = {
      add: openPlans.map(p => ({
        kind: p.kind,
        content: p.content,
        createdTime: p.createdTime,
        targetTime: p.targetTime,
      })),
    };
  }
  const initialVars = deriveMemory(null).vars;
  if (!sameJson(state.vars, initialVars)) {
    delta.varOps = [{ op: 'set', path: '', value: cloneJsonRecord(state.vars) }];
  }
  return delta;
}

/** 深拷贝一条要搬运的消息,取消隐藏、保留叶子。 */
function sanitizeCarryMessage(m: STMessage, detailIds: ReadonlyMap<string, string>): STMessage {
  const clone: STMessage = JSON.parse(JSON.stringify(m));
  clone.is_system = false;
  if (clone.extra && 'bbs_hidden' in clone.extra) {
    const { bbs_hidden: _h, ...rest } = clone.extra;
    clone.extra = rest;
  }
  // 窗口前的生活条目已改挂种子叶:同步窗口内引用,否则纠正归属/修改/沉降/删除会失效。
  const life = clone.extra?.bbs_leaf?.delta.lifeDetails;
  if (life) {
    for (const update of life.update ?? []) update.id = detailIds.get(update.id) ?? update.id;
    for (const key of ['archive', 'remove'] as const) {
      if (life[key]) life[key] = life[key].map(id => detailIds.get(id) ?? id);
    }
  }
  return clone;
}

/** 计算携带计划(不产生副作用),供 UI 预览。 */
export function computeCarryoverPlan(): CarryoverPlan {
  const blockedReason = memoryWriteIssue();
  if (blockedReason) return { carryStart: 0, carryCount: 0, aiCount: 0, recapLen: 0, hasData: false, blockedReason };
  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const carryStart = resolveKeepStart(chat);

  let carryCount = 0;
  let aiCount = 0;
  for (let i = carryStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    // ST 原生系统楼(带 type)不搬;真实楼(含被隐藏的)搬
    if (m.is_system && m.extra?.type) continue;
    carryCount++;
    if (!m.is_user) aiCount++;
  }

  const recap = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, carryStart));
  const seedDelta = encodeStateAsDelta(deriveMemory(chat, carryStart), 'preview');
  return {
    carryStart,
    carryCount,
    aiCount,
    recapLen: recap.length,
    hasData: chat.length > 0 && (carryCount > 0 || recap.length > 0 || deltaHasData(seedDelta)),
  };
}

/**
 * 执行带数据创建新对话。返回是否成功。
 * 全程 try/catch:失败 toast 并尽量不破坏当前聊天(doNewChat 前只读不写源)。
 */
export async function createNewChatWithCarryover(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) {
    toast('SillyTavern 上下文不可用', 'error');
    return false;
  }
  if (ctx.groupId) {
    toast('群聊暂不支持带数据建新对话', 'warning');
    return false;
  }
  const sourceChat = ctx.chat;
  const sourceMeta = ctx.chatMetadata;
  const sourceChatId = ctx.getCurrentChatId?.();
  const sourceCharacter = ctx.characterId;
  const sourceDb = currentVectorDb();
  const requireSource = () => {
    const current = getContext();
    if (current?.chat !== sourceChat || current?.chatMetadata !== sourceMeta ||
        current?.getCurrentChatId?.() !== sourceChatId || current?.characterId !== sourceCharacter ||
        current?.groupId || currentVectorDb() !== sourceDb) {
      throw new Error('携带期间源聊天归属已变化，停止后续操作');
    }
    assertMemoryWritable();
  };
  let rollback: (() => void) | undefined;
  let persistenceStarted = false;
  let creatingChat = false;
  try {
    requireSource(); // 在加载宿主接口、读取派生/森林或向量外发前阻断。
    if (!sourceChatId || !sourceMeta) throw new Error('请先进入一个聊天再携带数据');
    if (!sourceChat?.length) {
      toast('当前对话没有可携带的数据', 'warning');
      return false;
    }
    if (typeof ctx.saveChat !== 'function') throw new Error('宿主缺少聊天保存接口');
    const doNewChat = await getDoNewChat();
    requireSource(); // 接口加载期间可能已换 chat、metadata 或 id。
    if (!doNewChat) throw new Error('无法创建新对话(ST 接口不可用)');

    // ===== 1. 在建新对话前,从源聊天提取要携带的一切(只读) =====
    const carryStart = resolveKeepStart(sourceChat);
    const parentBundles = currentBundleHashes(); // 源聊天已携带的 bundle 哈希(将继承给新聊天)

    // 截止窗口起点的派生状态 → 种子叶子 delta(窗口楼层自己的叶子会继续累加,故截到窗口前避免重复)
    const stateBefore = deriveMemory(sourceChat, carryStart);
    // 种子叶 id 先生成:生活细节的稳定 id 由「叶子id#序号」派生,编码 delta 时就要用
    const seedLeafId = makeLeafId();
    const seedDelta = encodeStateAsDelta(stateBefore, seedLeafId);
    const detailIds = new Map(stateBefore.lifeDetails.map((d, i) => [d.id, `detail:${seedLeafId}#${i}`]));

    // 合并历史摘要(窗口之前的剧情) = 种子叶子 text
    const mergedSummary = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, sourceChat, carryStart));

    // 种子叶子的时间锚:截止窗口前的状态时间(无则故事最新时间)
    const seedTime = stateBefore.state.time || latestStoryTime(sourceChat) || '';

    // 搬运的窗口楼层(深拷贝、取消隐藏、保留叶子)
    const carryMessages: STMessage[] = [];
    for (let i = carryStart; i < sourceChat.length; i++) {
      const m = sourceChat[i];
      if (!m) continue;
      if (m.is_system && m.extra?.type) continue; // 原生系统楼不搬
      carryMessages.push(sanitizeCarryMessage(m, detailIds));
    }

    if (!mergedSummary && !carryMessages.length && !deltaHasData(seedDelta)) {
      toast('当前对话没有可携带的数据', 'warning');
      return false;
    }


    // 向量失败可降级，但归属/兼容失败不能被「仅警告」吞掉。
    let newBundleHash: string | null = null;
    if (apiSettings.vector.enabled && sourceDb) {
      requireSource();
      try {
        const available = await isBaiBaoKuAvailable();
        requireSource();
        if (available) {
          const { hash } = await vecBundleCreate(sourceDb, sourceChatId);
          requireSource();
          newBundleHash = hash;
        }
      } catch (e) {
        requireSource();
        console.warn('[棱镜宝书向量] 建 bundle 失败(新对话将不带源向量召回):', e);
      }
    }

    requireSource();
    await ctx.saveChat();
    requireSource();
    creatingChat = true;
    await doNewChat({ deleteCurrentChat: false });

    const targetCtx = getContext();
    if (!targetCtx?.chat || !targetCtx.chatMetadata) throw new Error('新对话上下文不可用');
    const targetChat = targetCtx.chat;
    const targetMeta = targetCtx.chatMetadata;
    const targetId = targetCtx.getCurrentChatId?.();
    // 新聊天必须有独立消息数组；宿主可暂时复用 metadata/id，不能要求三者都更换。
    // 后续等待仍绑定这次捕获的完整三元组，任何单项漂移都停止。
    if (!targetId || targetChat === sourceChat ||
        targetCtx.characterId !== sourceCharacter || targetCtx.groupId || currentVectorDb() !== sourceDb) {
      throw new Error('无法确认新对话归属，未写入携带数据');
    }
    const stillTarget = () => {
      const current = getContext();
      return current?.chat === targetChat && current?.chatMetadata === targetMeta &&
        current?.getCurrentChatId?.() === targetId && current?.characterId === sourceCharacter && !current?.groupId;
    };
    const requireTarget = () => {
      if (!stillTarget()) throw new Error('写入期间新对话归属已变化，停止后续操作');
      assertMemoryWritable();
    };
    requireTarget(); // 先检查目标兼容性，再读目标快照。
    if (typeof targetCtx.saveChat !== 'function') {
      throw new Error('新对话缺少可靠保存接口，未写入携带数据');
    }
    const oldRaw = targetMeta[MEMORY_KEY];
    const raw = oldRaw as Record<string, unknown> | undefined;
    if (targetChat.some(m => m.is_user || m.extra?.bbs_leaf) ||
        (Array.isArray(raw?.summaries) && raw.summaries.length)) {
      throw new Error('目标对话已有历史，拒绝覆盖');
    }
    // 所有候选（包括 bundle 列表）先在独立对象中构造，失败不留下半个锚点。
    const candidateChat: STMessage[] = JSON.parse(JSON.stringify(targetChat));
    if (carryMessages.length) candidateChat.splice(1);
    if (!candidateChat.length) candidateChat.push({ name: targetCtx.name2 || '', is_user: false, is_system: true, mes: '', extra: {} });
    const anchor = candidateChat[0];
    anchor.is_system = true;
    setMessageText(anchor, '');
    const seedLeaf: LeafExtra = {
      id: seedLeafId, text: mergedSummary, delta: seedDelta,
      timeEnd: seedTime || undefined, timeStart: seedTime || undefined,
      createdAt: Date.now(), seed: true, v: 1,
    };
    anchor.extra = { ...(anchor.extra ?? {}), bbs_leaf: seedLeaf };
    const summaries: MemSummary[] = mergedSummary ? [{
      id: `sum_carry_${Date.now().toString(36)}`, text: mergedSummary, level: 2, createdAt: Date.now(), auto: true,
      timeStart: seedTime || undefined, timeEnd: seedTime || undefined, childIds: [seedLeaf.id],
    }] : [];
    candidateChat.push(...carryMessages);
    const candidate = { ...raw, version: MEMORY_VERSION, summaries };
    const bundleMeta: Record<string, unknown> = {};
    if (newBundleHash) appendBundleHash(bundleMeta, parentBundles, newBundleHash);
    else if (parentBundles.length) bundleMeta[BUNDLES_META_KEY] = [...parentBundles];
    const report = inspectCompatibility(candidate, candidateChat);
    if (report.mode !== 'ready') throw new Error('携带候选不完整：' + report.issues.join('；'));

    const originalMessages = [...targetChat];
    const oldSummaries = [...memory.summaries];
    const hadRaw = Object.prototype.hasOwnProperty.call(targetMeta, MEMORY_KEY);
    const hadBundles = Object.prototype.hasOwnProperty.call(targetMeta, BUNDLES_META_KEY);
    const oldBundles = targetMeta[BUNDLES_META_KEY];
    const candidateState = JSON.stringify({ chat: candidateChat, raw: candidate, summaries, bundles: bundleMeta[BUNDLES_META_KEY] ?? oldBundles });
    requireTarget(); // 首次修改前再次检查。
    rollback = () => {
      if (!stillTarget() || targetMeta[MEMORY_KEY] !== candidate ||
          targetChat.length !== candidateChat.length || targetChat.some((m, i) => m !== candidateChat[i]) ||
          JSON.stringify({ chat: targetChat, raw: targetMeta[MEMORY_KEY], summaries: memory.summaries, bundles: targetMeta[BUNDLES_META_KEY] }) !== candidateState) return;
      targetChat.splice(0, targetChat.length, ...originalMessages);
      if (hadRaw) targetMeta[MEMORY_KEY] = oldRaw;
      else delete targetMeta[MEMORY_KEY];
      if (bundleMeta[BUNDLES_META_KEY] && targetMeta[BUNDLES_META_KEY] === bundleMeta[BUNDLES_META_KEY]) {
        if (hadBundles) targetMeta[BUNDLES_META_KEY] = oldBundles;
        else delete targetMeta[BUNDLES_META_KEY];
      }
      memory.summaries.splice(0, memory.summaries.length, ...oldSummaries);
      recomputeDerived();
    };
    targetChat.splice(0, targetChat.length, ...candidateChat);
    targetMeta[MEMORY_KEY] = candidate;
    if (bundleMeta[BUNDLES_META_KEY]) targetMeta[BUNDLES_META_KEY] = bundleMeta[BUNDLES_META_KEY];
    memory.summaries.splice(0, memory.summaries.length, ...summaries);
    recomputeDerived();
    requireTarget();
    persistenceStarted = true;
    // 不使用 fire-and-forget flush 或防抖保存，逐步等待并核对归属。
    await targetCtx.saveChat();
    requireTarget();
    // saveChat 保存完整聊天；兼容仅提供它的宿主，额外 metadata 接口存在才等待。
    if (typeof targetCtx.saveMetadata === 'function') {
      await targetCtx.saveMetadata();
      requireTarget();
    }
    rollback = undefined; // 可用的保存接口已确认，重载失败不回滚已保存内容。
    if (typeof targetCtx.reloadCurrentChat === 'function') {
      await targetCtx.reloadCurrentChat();
      // 重载合法地更换 chat/meta 引用；以 id/角色确认后，捕获新引用。
      const reloaded = getContext();
      if (!reloaded || reloaded.getCurrentChatId?.() !== targetId || reloaded.characterId !== sourceCharacter || reloaded.groupId) {
        throw new Error('重载期间已切换聊天，停止刷新');
      }
      assertMemoryWritable();
    } else requireTarget();
    refreshInjection();
    toast('已创建新对话:携带 AI ' + carryMessages.filter(m => !m.is_user).length + ' 条,旧剧情摘要 ' + (mergedSummary ? '1' : '0') + ' 条', 'success');
    return true;
  } catch (e) {
    try { rollback?.(); } catch (restoreError) { console.error('[棱镜宝书] 恢复携带内存失败:', restoreError); }
    const warning = persistenceStarted ? '；保存可能已部分完成，请核对源/目标聊天，未执行磁盘回滚'
      : creatingChat ? '；新聊天可能已创建，源历史未被本入口改写，请核对' : '';
    toast('带数据创建新对话失败:' + (e instanceof Error ? e.message : String(e)) + warning, 'error');
    return false;
  }
}
