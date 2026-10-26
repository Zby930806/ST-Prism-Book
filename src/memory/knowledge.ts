import { normalizeLifeDetailText } from './lifeDetails';
import type { KnowledgeOp, MemKnowledge } from './types';

/**
 * 了解清单:每个角色目前知道或以为的主角的事。
 * 注入时说明:没记下、剧情中也没交代其得知的主角私事,该角色按不知道处理,防止角色凭人设或世界书对主角全知。
 * 记的是角色的认知,不是真相。叶子里存有序操作日志(KnowledgeOp),按楼层顺序重放出清单。
 */

const norm = (s: string): string => s.trim().toLowerCase();
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * 稳定 id:产生它的叶子 id + 序号,与计划、生活档案同一套规则:序号按该部分里 add 的先后,
 * 模型结果从 0 起、迁移状态从 MIGRATED_ADD_BASE 起;手动修改的 add 用写入时分配的显式 id(叶子移动后不变)。
 * 只数 add,删掉同一叶子里的改写或删除操作时,其后新增条目的 id 不变。
 */
export function knowledgeId(leafId: string, index: number): string {
  return `know:${leafId}#${index}`;
}

const EXPLICIT_ID = /^know:.+#\d+$/;

/** 同一角色的同义条目算重复;不同角色知道同一件事各记各的。 */
export function sameKnowledge(a: { subject: string; text: string }, b: { subject: string; text: string }): boolean {
  return norm(a.subject) === norm(b.subject) && normalizeLifeDetailText(a.text) === normalizeLifeDetailText(b.text);
}

/** 某角色的全部条目(名字按规范化匹配),保持清单顺序。 */
export function knowledgeOf(list: readonly MemKnowledge[], name: string): MemKnowledge[] {
  const key = norm(name);
  return key ? list.filter(k => norm(k.subject) === key) : [];
}

/** 清洗叶子里存的操作日志(模型结果、迁移状态、手动修改):丢掉缺字段的操作,其余保持原顺序;add 只保留插件格式的显式 id。 */
export function cleanKnowledgeOps(raw: unknown): KnowledgeOp[] {
  const out: KnowledgeOp[] = [];
  for (const r of arr(raw)) {
    if (!isRecord(r)) continue;
    if (r.op === 'add') {
      const subject = text(r.subject);
      const t = text(r.text);
      if (!subject || !t) continue;
      const id = text(r.id);
      out.push(EXPLICIT_ID.test(id) ? { op: 'add', subject, text: t, id } : { op: 'add', subject, text: t });
    } else if (r.op === 'update') {
      const id = text(r.id);
      const subject = text(r.subject);
      const t = text(r.text);
      if (!id || (!subject && !t)) continue;
      const u: Extract<KnowledgeOp, { op: 'update' }> = { op: 'update', id };
      if (subject) u.subject = subject;
      if (t) u.text = t;
      out.push(u);
    } else if (r.op === 'remove') {
      const id = text(r.id);
      if (id) out.push({ op: 'remove', id });
    }
  }
  return out;
}

/** 重放一部分操作时用到的叶子信息;idBase、explicitIds 的含义与其他条目的重放相同。 */
export interface KnowledgeReplayLeaf {
  id: string;
  createdAt: number;
  /** 叶子的故事内时间(新增条目的记录时间) */
  time: string;
  idBase?: number;
  /** 只对手动修改为真:新增条目自带的显式 id 优先 */
  explicitIds?: boolean;
}

/**
 * 按顺序把一部分操作施加到清单上。add 同角色同义去重;update 过的条目挪到末尾:
 * 注入时每个角色只发最近若干条,被纠正的认知往往最要紧,不能按最初记下的先后被截掉。
 */
export function applyKnowledgeOps(list: MemKnowledge[], ops: readonly KnowledgeOp[], leaf: KnowledgeReplayLeaf): void {
  let added = 0;
  for (const op of ops) {
    if (op.op === 'add') {
      const index = added++;
      const id = (leaf.explicitIds && op.id) || knowledgeId(leaf.id, (leaf.idBase ?? 0) + index);
      if (list.some(k => k.id === id || sameKnowledge(k, op))) continue;
      list.push({ id, subject: op.subject, text: op.text, createdTime: leaf.time || undefined, createdAt: leaf.createdAt, updatedAt: leaf.createdAt });
      continue;
    }
    const idx = list.findIndex(k => k.id === op.id);
    if (idx < 0) continue;
    const [k] = list.splice(idx, 1);
    if (op.op === 'remove') continue;
    if (op.subject) k.subject = op.subject;
    if (op.text) k.text = op.text;
    k.updatedAt = leaf.createdAt;
    // 改完和另一条成了同一句 → 去掉改的这条(那句话已有条目记着)
    if (list.some(o => sameKnowledge(o, k))) continue;
    list.push(k);
  }
}

/** 名册改名接续:该角色的条目改挂新名字,顺序不变。 */
export function renameKnowledgeSubject(list: MemKnowledge[], from: string, to: string): void {
  const key = norm(from);
  if (!key || !to.trim()) return;
  for (const k of list) if (norm(k.subject) === key) k.subject = to.trim();
}

/* ============ 模型输出 → 存储日志 ============ */

/** 固化模型输出时需要的上下文;功能开启时由摘要引擎给出,不给就不收模型输出的 knowledge。 */
export interface KnowledgeFinalizeContext {
  /** 提示词里展示的条目,顺序即 k1/k2… */
  shown: readonly { id: string }[];
  /** 本楼之前的名册名字 */
  roster: readonly string[];
  /** 主角名:主角本人不记 */
  userName?: string;
}

/** 本楼可以记了解的角色:本楼之前的名册,加上本楼新登场、更新到的角色和改名后的新名字。 */
export interface KnowledgeNames {
  /** 规范化名 → 名册写法 */
  names: Map<string, string>;
  /** 本楼改名:旧名(规范化)→ 新名 */
  renames: Map<string, string>;
}

/** 由本楼之前的名册和本楼的 npcs 操作(add/update/rename)得到可记了解的角色。 */
export function knowledgeNames(roster: readonly string[], npcs: unknown): KnowledgeNames {
  const names = new Map<string, string>();
  const renames = new Map<string, string>();
  const put = (name: unknown): void => {
    const n = text(name);
    if (n && !names.has(norm(n))) names.set(norm(n), n);
  };
  roster.forEach(put);
  if (isRecord(npcs)) {
    for (const op of ['add', 'update']) for (const entry of arr(npcs[op])) put(isRecord(entry) ? entry.name : entry);
    for (const r of arr(npcs.rename)) {
      if (!isRecord(r)) continue;
      const from = text(r.from);
      const to = text(r.to);
      if (!from || !to) continue;
      put(to);
      renames.set(norm(from), to);
    }
  }
  return { names, renames };
}

/** k1/k2… → 0 起的下标;不是这种写法返回 null。 */
export function parseKnowledgeRef(ref: unknown): number | null {
  const m = text(isRecord(ref) ? ref.id : ref).match(/^k(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n - 1 : null;
}

function isProtagonistName(who: string, userName?: string): boolean {
  const key = norm(who);
  return key === 'user' || key === '{{user}}' || key === '主角' || (!!userName?.trim() && key === norm(userName));
}

/** who → 名册写法;主角本人、名册外的返回 undefined。本楼改了名的旧名字按新名字记。 */
function resolveSubject(who: string, ctx: KnowledgeNames & { userName?: string }): string | undefined {
  if (!who || isProtagonistName(who, ctx.userName)) return undefined;
  const renamed = ctx.renames.get(norm(who));
  return ctx.names.get(norm(renamed ?? who));
}

const whoOf = (entry: Record<string, unknown>): string => text(entry.who) || text(entry.subject) || text(entry.name);

/** 校验用的上下文:提示词里展示了几条(k1–kN)、可记的角色、主角名。 */
export interface KnowledgeCheckContext extends KnowledgeNames {
  shownCount: number;
  userName?: string;
}

/**
 * 一条模型输出的问题:前几次尝试附原因重试,最后一次只去掉这一条并报告。没有问题返回 null。
 * 与 finalizeKnowledge 同一口径:这里判为没问题的条目,固化时一定保留。
 */
export function knowledgeEntryProblem(op: string, entry: unknown, ctx: KnowledgeCheckContext): { reason: 'missing' | 'invalid'; detail: string } | null {
  if (op === 'add') {
    if (!isRecord(entry)) return { reason: 'invalid', detail: '每条须是带 who 和 text 的对象' };
    const who = whoOf(entry);
    if (!who) return { reason: 'missing', detail: '缺少角色名 who' };
    if (!text(entry.text)) return { reason: 'missing', detail: '缺少内容 text' };
    if (isProtagonistName(who, ctx.userName)) return { reason: 'invalid', detail: `「${who}」是主角本人；这里只记其他角色对主角的了解` };
    if (!resolveSubject(who, ctx)) return { reason: 'invalid', detail: `「${who}」不在角色名册中；who 须写名册里的确切名字，本楼新登场的角色须同时在 npcs.add 建档` };
    return null;
  }
  const ref = text(isRecord(entry) ? entry.id : entry);
  if (!ref) return { reason: 'missing', detail: '缺少编号 id' };
  const index = parseKnowledgeRef(ref);
  if (index === null || index >= ctx.shownCount) {
    return { reason: 'invalid', detail: `编号 ${ref} 不存在${ctx.shownCount > 0 ? `（当前可用 k1–k${ctx.shownCount}）` : '（当前没有可引用的条目）'}` };
  }
  if (op === 'update' && !(isRecord(entry) && text(entry.text))) return { reason: 'missing', detail: `${ref} 缺少改写后的内容 text` };
  return null;
}

/**
 * 模型输出(按 add/update/remove 分组)→ 有序存储日志。
 *  - k1/k2… 按提示词里展示的顺序翻成稳定 id,查无的丢弃;
 *  - who 只认可记的角色,按名册写法归一;主角本人、名册外的整条丢弃;
 *  - 先改、删旧条,再加新条:纠正认知时「删旧加新」不会误删新加的。
 */
export function finalizeKnowledge(raw: unknown, ctx: KnowledgeNames & { shown: readonly { id: string }[]; userName?: string }): KnowledgeOp[] {
  if (!isRecord(raw)) return [];
  const check: KnowledgeCheckContext = { ...ctx, shownCount: ctx.shown.length };
  const idOf = (entry: unknown): string => ctx.shown[parseKnowledgeRef(entry) ?? -1]?.id ?? '';
  const out: KnowledgeOp[] = [];
  for (const u of arr(raw.update)) {
    if (knowledgeEntryProblem('update', u, check)) continue;
    out.push({ op: 'update', id: idOf(u), text: text((u as Record<string, unknown>).text) });
  }
  for (const r of arr(raw.remove)) {
    if (knowledgeEntryProblem('remove', r, check)) continue;
    out.push({ op: 'remove', id: idOf(r) });
  }
  for (const a of arr(raw.add)) {
    if (knowledgeEntryProblem('add', a, check)) continue;
    const entry = a as Record<string, unknown>;
    out.push({ op: 'add', subject: resolveSubject(whoOf(entry), check)!, text: text(entry.text) });
  }
  return out;
}

/* ============ 摘要材料与正文注入 ============ */

/** 摘要请求只附给定角色的清单;返回顺序即 k1/k2… 编号,按 names 的顺序分组。 */
export function selectKnowledgeForSummary(list: readonly MemKnowledge[], names: readonly string[]): MemKnowledge[] {
  const out: MemKnowledge[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(...knowledgeOf(list, name));
  }
  return out;
}

/** 摘要材料:按角色分组,编号全局连续(须与 selectKnowledgeForSummary 的顺序一致)。 */
export function fmtKnowledgeForSummary(shown: readonly MemKnowledge[]): string {
  if (!shown.length) return '  (无)';
  const lines: string[] = [];
  let current = '';
  shown.forEach((k, i) => {
    if (norm(k.subject) !== current) {
      current = norm(k.subject);
      lines.push(`  ${oneLine(k.subject)}:`);
    }
    lines.push(`    k${i + 1}. ${oneLine(k.text)}`);
  });
  return lines.join('\n');
}

/** 注入时每个角色最多发几条(取最近的)。 */
export const KNOWLEDGE_INJECT_CAP = 15;

/**
 * 正文注入:只发给定角色(主要角色、在场角色),没有记录的也列出,「没记下的按不知道处理」才对其生效。
 * 只限定私事:看得见的、公开的、按关系本该知道的、剧情中交代过得知的照常知道,免得矫枉过正成了失忆
 * (旧聊天开启时清单是空的,以前得知的事靠剧情记录)。
 */
export function fmtKnowledgeInjection(list: readonly MemKnowledge[], names: readonly string[], userName: string, cap = KNOWLEDGE_INJECT_CAP): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const name of names) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const own = knowledgeOf(list, name);
    if (!own.length) {
      rows.push(`${oneLine(name)}:暂无记录`);
      continue;
    }
    const shown = own.slice(-cap);
    const more = own.length - shown.length;
    rows.push(`${oneLine(name)}:${more > 0 ? `(另有 ${more} 条较早的从略)` : ''}\n${shown.map(k => `- ${oneLine(k.text)}`).join('\n')}`);
  }
  if (!rows.length) return '';
  const u = oneLine(userName) || '主角';
  return `[角色对${u}的了解·知情范围]\n${rows.join('\n')}\n`
    + `(上列角色对${u}的私事——身世、过往经历、秘密、私人喜好,以及${u}的名字——只知道这里记下的;没有记下、剧情中也没交代其得知的,按不知道处理,不凭人设或世界书说出。看得见的外貌举止、公开身份,以及按与${u}的关系本该知道的,照常知道。条目是角色自己的认知,未必是真相:角色按自己以为的说话行事,不要替角色看穿;这是写作参考,不要在正文中点破)`;
}
