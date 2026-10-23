import type { MemLifeDetail, StoredDelta } from './types';

type LifeDetailsDelta = NonNullable<StoredDelta['lifeDetails']>;
type LifeDetailAdd = NonNullable<LifeDetailsDelta['add']>[number];
type LifeDetailUpdate = NonNullable<LifeDetailsDelta['update']>[number];

export interface MergeLifeDetailsOptions {
  /** 当前目标叶子 id，用于识别该叶子 add 数组按序号生成的稳定 id(带显式 id 的手动条目不需要)。 */
  leafId?: string;
  /** 重放到目标之前的生活档案，用于恢复更早叶子中被本次删除的同文案条目。 */
  existingDetails?: MemLifeDetail[];
  /** 目标是叶子的手动修改(manualOps):新增条目带显式 id,删除后重加时按 id 对应同批新增。 */
  explicitIds?: boolean;
}

export function normalizeLifeDetailText(text: string): string {
  return text.trim().toLowerCase().replace(/[，。！？!?、；;：:\s]+$/u, '');
}

/** 旧档案原本仅记录主角;缺主语时沿用旧语义,不从正文猜角色。 */
export function lifeDetailSubject(detail: { subject?: string }): string {
  return detail.subject?.trim() || 'user';
}

/** 同一句偏好属于不同人物时必须各自保留。 */
export function sameLifeDetail(a: { subject?: string; text: string }, b: { subject?: string; text: string }): boolean {
  return lifeDetailSubject(a).toLowerCase() === lifeDetailSubject(b).toLowerCase()
    && normalizeLifeDetailText(a.text) === normalizeLifeDetailText(b.text);
}

/** 页面/副 API/主模型注入共用:每一条都明确标出是谁的,不依赖段落标题猜主语。 */
export function fmtLifeDetail(detail: { subject?: string; text: string }, userName = '主角'): string {
  const subject = lifeDetailSubject(detail);
  return `${subject === 'user' ? userName : subject}：${detail.text}`;
}

function upsertUpdate(out: LifeDetailsDelta, update: LifeDetailUpdate): void {
  const updates = (out.update ??= []);
  const index = updates.findIndex(existing => existing.id === update.id);
  if (index >= 0) updates[index] = { ...updates[index], ...update };
  else updates.push(update);
}

function sameLeafAddIndex(out: LifeDetailsDelta, id: string, options: MergeLifeDetailsOptions): number | null {
  // 手动修改的新增带显式 id:直接在本增量的新增里按 id 找
  if (options.explicitIds) {
    const explicit = out.add?.findIndex(add => add.id === id) ?? -1;
    return explicit >= 0 ? explicit : null;
  }
  if (!options.leafId) return null;
  const prefix = `detail:${options.leafId}#`;
  if (!id.startsWith(prefix)) return null;
  const index = Number(id.slice(prefix.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function effectiveRemovedDetail(
  out: LifeDetailsDelta,
  id: string,
  options: MergeLifeDetailsOptions,
): LifeDetailAdd | undefined {
  const sameLeafIndex = sameLeafAddIndex(out, id, options);
  const base = sameLeafIndex === null
    ? options.existingDetails?.find(detail => detail.id === id)
    : out.add?.[sameLeafIndex];
  const update = out.update?.find(entry => entry.id === id);
  return base ? { ...base, ...update } : undefined;
}

function reviveRemovedDetail(
  out: LifeDetailsDelta,
  add: LifeDetailAdd,
  options: MergeLifeDetailsOptions,
): boolean {
  const id = out.remove?.find(removedId => {
    const detail = effectiveRemovedDetail(out, removedId, options);
    return !!detail && sameLifeDetail(detail, add);
  });
  if (!id) return false;

  out.remove = out.remove?.filter(existing => existing !== id);
  if (!out.remove?.length) delete out.remove;
  out.archive = out.archive?.filter(existing => existing !== id);
  if (!out.archive?.length) delete out.archive;

  const sameLeafIndex = sameLeafAddIndex(out, id, options);
  if (sameLeafIndex !== null && out.add?.[sameLeafIndex]) {
    // 原条目由本增量的新增产生：原位替换，稳定 id 与后续 add 序号都不变(手动条目沿用原来的显式 id)。
    if (options.explicitIds) {
      const { id: _incomingId, ...rest } = add;
      out.add[sameLeafIndex] = { ...rest, id: out.add[sameLeafIndex].id };
    } else {
      out.add[sameLeafIndex] = add;
    }
    if (out.update) {
      out.update = out.update.filter(existing => existing.id !== id);
      if (!out.update.length) delete out.update;
    }
  } else {
    // 原条目来自更早叶子：撤销删除，并用完整补丁恢复成一次全新的 active 手动记录。
    upsertUpdate(out, {
      id,
      text: add.text,
      ...(add.subject ? { subject: add.subject } : {}),
      topics: add.topics ?? [],
      anchors: add.anchors ?? [],
      until: add.until ?? '',
      tier: 'active',
    });
  }
  return true;
}

/**
 * 把一段生活小档案手动操作合并进目标增量(叶子的 manualOps;旧版直接写进 delta)。
 * update 按 id 压成 last-write-wins；add 不做裁剪，因为条目稳定 id 依赖 add 数组序号(或条目自带的显式 id)。
 * 删除后重加同一人物的同一句,复活原条目:本增量里的新增按显式 id 或叶子序号原位恢复,更早的条目用完整补丁恢复。
 */
export function mergeLifeDetailsOp(
  target: StoredDelta,
  incoming: StoredDelta['lifeDetails'],
  options: MergeLifeDetailsOptions = {},
): boolean {
  if (!incoming) return false;
  const hasOps = !!(
    incoming.add?.length
    || incoming.update?.length
    || incoming.archive?.length
    || incoming.remove?.length
  );
  if (!hasOps) return false;

  const out: LifeDetailsDelta = (target.lifeDetails ??= {});

  for (const add of incoming.add ?? []) {
    if (!reviveRemovedDetail(out, add, options)) (out.add ??= []).push(add);
  }

  for (const update of incoming.update ?? []) {
    upsertUpdate(out, update);

    // 手动切换层级必须覆盖同一叶子里 AI 先前给出的 archive 指令。
    if (update.tier && out.archive) {
      out.archive = out.archive.filter(id => id !== update.id);
      if (!out.archive.length) delete out.archive;
    }
  }

  for (const id of incoming.archive ?? []) {
    out.archive = [...(out.archive ?? []).filter(existing => existing !== id), id];
  }

  for (const id of incoming.remove ?? []) {
    out.remove = [...(out.remove ?? []).filter(existing => existing !== id), id];
  }

  return true;
}
