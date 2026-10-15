/**
 * 一楼摘要带来的状态变动 → 可读的标签行。楼层面板(就地编辑)和重新摘要的对比弹窗共用,
 * 两处显示同一份变动时说法一致。纯函数:不改聊天,计划只通过 planContentById 查内容。
 */
import { describeVarOp, planContentById, secretContentById } from './apply';
import { fmtNpcAffinity } from './npcRelations';
import type { ItemDelta, NpcDelta, StoredDelta, VarOp } from './types';

export type DeltaOp = 'add' | 'update' | 'remove' | 'resolve' | 'reopen' | 'reparent';
// 单字符曾让人费解(「改」是什么?),改用明确词条 + 语义色徽标(见 .bbs-fp-op 的 op-* 着色)
export const DELTA_OP_LABEL: Record<DeltaOp, string> = { add: '新增', update: '更新', remove: '移除', resolve: '了结', reopen: '重启', reparent: '迁移' };

// key 用于定位到 delta 里的具体桶+序号,如 'item:add:0'
// text=主文本(名字/标题,一行),sub=副文本(描述/字段细节,淡色小字另起一行)。
// 之前把所有细节挤进一行、加大圆角、还居中,长内容就成了臃肿的居中泡泡。拆成「主 + 副」的
// 账册式左对齐条目后,名字为纲、细节为目,长短皆可读。
export interface DeltaTag {
  key: string;
  op: DeltaOp;
  bucket: string; // add/update/remove/reparent/resolve/reopen
  idx: number;
  text: string;
  sub?: string; // 副文本(可选)
  editable: boolean; // items/npcs 可就地改字段;scenes/plans 只可删
}

export interface DeltaTagGroup {
  title: string;
  /** 复用导航同款描边图标,给每个类目一个可辨识的视觉锚点 */
  icon: string;
  tags: DeltaTag[];
}

type Delta = StoredDelta | null | undefined;

function fmtItem(x: ItemDelta): { text: string; sub?: string } {
  const text = typeof x.qty === 'number' ? `${x.name} ×${x.qty}` : x.name;
  return { text, sub: x.desc || undefined };
}

// 角色变动:主文本=名(·身份);副文本=delta 里本轮出现的字段。更新 delta 只含被改字段,
// 故副文本恰好就是「这层楼改了什么」。
function fmtNpc(x: NpcDelta): { text: string; sub?: string } {
  const text = x.title ? `${x.name}·${x.title}` : x.name;
  const parts: string[] = [];
  // 身份已进主文本(名·身份),副文本从「年龄」起,避免重复
  if (x.age) parts.push(`年龄:${x.age}`);
  if (x.relation) parts.push(`关系:${x.relation}`);
  const affinity = fmtNpcAffinity(x, true);
  if (affinity) parts.push(`好感估计:${affinity}`);
  if (x.outfit) parts.push(`着装:${x.outfit}`);
  if (x.condition) parts.push(`状态:${x.condition}`);
  if (x.desc) parts.push(`外貌:${x.desc}`);
  if (x.personality) parts.push(`性格:${x.personality}`);
  if (x.ties) parts.push(`人际:${x.ties}`);
  if (x.location) parts.push(`位置:${x.location}`);
  if (x.follow === true) parts.push('随行');
  if (x.important === true) parts.push('主要角色');
  return { text, sub: parts.length ? parts.join(' · ') : undefined };
}

function itemTags(d: Delta): DeltaTag[] {
  const it = d?.items;
  if (!it) return [];
  const out: DeltaTag[] = [];
  (it.add ?? []).forEach((x, i) => out.push({ key: `item:add:${i}`, op: 'add', bucket: 'add', idx: i, ...fmtItem(x), editable: true }));
  (it.update ?? []).forEach((x, i) => out.push({ key: `item:update:${i}`, op: 'update', bucket: 'update', idx: i, ...fmtItem(x), editable: true }));
  (it.remove ?? []).forEach((name, i) => out.push({ key: `item:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: name, editable: true }));
  return out;
}

function npcTags(d: Delta): DeltaTag[] {
  const np = d?.npcs;
  if (!np) return [];
  const out: DeltaTag[] = [];
  (np.add ?? []).forEach((x, i) => out.push({ key: `npc:add:${i}`, op: 'add', bucket: 'add', idx: i, ...fmtNpc(x), editable: true }));
  (np.update ?? []).forEach((x, i) => out.push({ key: `npc:update:${i}`, op: 'update', bucket: 'update', idx: i, ...fmtNpc(x), editable: true }));
  (np.remove ?? []).forEach((name, i) => out.push({ key: `npc:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: name, editable: true }));
  return out;
}

function protagonistTags(d: Delta): DeltaTag[] {
  const protagonist = d?.protagonist;
  if (!protagonist) return [];
  const labels: Record<keyof typeof protagonist, string> = {
    gender: '性别',
    age: '年龄',
    ageTime: '年龄锚点',
    identity: '身份',
    appearance: '外貌',
    outfit: '着装',
    condition: '状态',
  };
  const parts = (Object.keys(labels) as Array<keyof typeof protagonist>)
    .filter(key => protagonist[key] !== undefined)
    .map(key => `${labels[key]}:${protagonist[key] || '(清空)'}`);
  if (!parts.length) return [];
  return [{
    key: 'protagonist:update:0',
    op: 'update',
    bucket: 'update',
    idx: 0,
    text: '主角档案',
    sub: parts.join(' · '),
    editable: false,
  }];
}

function sceneTags(d: Delta): DeltaTag[] {
  const sc = d?.scenes;
  if (!sc) return [];
  const out: DeltaTag[] = [];
  (sc.add ?? []).forEach((x, i) => out.push({ key: `scene:add:${i}`, op: 'add', bucket: 'add', idx: i, text: (x.path ?? []).join(' / '), editable: false }));
  (sc.update ?? []).forEach((x, i) => out.push({ key: `scene:update:${i}`, op: 'update', bucket: 'update', idx: i, text: (x.path ?? []).join(' / '), editable: false }));
  (sc.reparent ?? []).forEach((x, i) => out.push({ key: `scene:reparent:${i}`, op: 'reparent', bucket: 'reparent', idx: i, text: `${(x.node ?? []).join('/')} → ${(x.newPath ?? []).join('/')}`, editable: false }));
  (sc.remove ?? []).forEach((p, i) => out.push({ key: `scene:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: (p ?? []).join(' / '), editable: false }));
  return out;
}

/** 计划只存 id 时反查内容;按「该楼之前及本楼」查,不泄漏后面楼层的改动。 */
function planLabel(verb: string, id: string, floor: number): string {
  const c = planContentById(id, floor + 1);
  return c ? `${verb}:${c}` : `${verb}一项`;
}

/** 信息差只存 id 时反查新增时的内容(只扫叶子,不重放)。 */
function secretLabel(verb: string, id: string, floor: number): string {
  const c = secretContentById(id, floor + 1);
  return c ? `${verb}:${c}` : `${verb}一项`;
}

function secretNames(knownBy?: string[], unaware?: string[]): string | undefined {
  const parts: string[] = [];
  if (knownBy?.length) parts.push(`知情:${knownBy.join('、')}`);
  if (unaware?.length) parts.push(`不知情:${unaware.join('、')}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function secretTags(d: Delta, floor: number): DeltaTag[] {
  const sc = d?.secrets;
  if (!sc) return [];
  const out: DeltaTag[] = [];
  (sc.add ?? []).forEach((x, i) => out.push({ key: `secret:add:${i}`, op: 'add', bucket: 'add', idx: i, text: x.content, sub: secretNames(x.knownBy, x.unaware), editable: false }));
  (sc.update ?? []).forEach((x, i) => out.push({ key: `secret:update:${i}`, op: 'update', bucket: 'update', idx: i, text: x.content || secretLabel('更新', x.id, floor), sub: secretNames(x.knownBy, x.unaware), editable: false }));
  (sc.resolve ?? []).forEach((id, i) => out.push({ key: `secret:resolve:${i}`, op: 'resolve', bucket: 'resolve', idx: i, text: secretLabel('结案', id, floor), editable: false }));
  (sc.reopen ?? []).forEach((id, i) => out.push({ key: `secret:reopen:${i}`, op: 'reopen', bucket: 'reopen', idx: i, text: secretLabel('重开', id, floor), editable: false }));
  (sc.remove ?? []).forEach((id, i) => out.push({ key: `secret:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: secretLabel('删除', id, floor), editable: false }));
  return out;
}

function planTags(d: Delta, floor: number): DeltaTag[] {
  const pl = d?.plans;
  if (!pl) return [];
  const out: DeltaTag[] = [];
  (pl.add ?? []).forEach((x, i) =>
    out.push({ key: `plan:add:${i}`, op: 'add', bucket: 'add', idx: i, text: x.content, sub: x.kind === 'suspense' ? '悬念' : '计划', editable: true }),
  );
  (pl.update ?? []).forEach((x, i) =>
    out.push({ key: `plan:update:${i}`, op: 'update', bucket: 'update', idx: i, text: x.content,
      sub: x.targetTime === undefined ? '调整安排' : x.targetTime ? `目标时间:${x.targetTime}` : '旧期限已撤销', editable: false }),
  );
  // resolve/reopen/remove 存 id,反查内容显示;resolve 还带 outcome/reason(兼容裸字符串旧数据)
  (pl.resolve ?? []).forEach((r, i) => {
    const id = typeof r === 'string' ? r : r.id;
    const oc = typeof r === 'string' ? undefined : r.outcome;
    const verb = oc === 'done' ? '达成' : oc === 'cancelled' ? '取消' : oc === 'failed' ? '失败' : '了结';
    const reason = typeof r === 'string' ? '' : (r.reason?.trim() ?? '');
    out.push({ key: `plan:resolve:${i}`, op: 'resolve', bucket: 'resolve', idx: i, text: planLabel(verb, id, floor), sub: reason || undefined, editable: false });
  });
  (pl.reopen ?? []).forEach((id, i) => out.push({ key: `plan:reopen:${i}`, op: 'reopen', bucket: 'reopen', idx: i, text: planLabel('重启', id, floor), editable: false }));
  (pl.remove ?? []).forEach((id, i) => out.push({ key: `plan:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: planLabel('删除', id, floor), editable: false }));
  return out;
}

// 变量变动:varOps 是扁平命令数组(非 add/update/remove 分桶),逐条映射成标签。
// op 复用现有徽标语义:set/add=更新(中性)、assign=新增(强调)、remove=移除(危险)。
const VAR_OP_TO_TAGOP: Record<VarOp['op'], DeltaOp> = { set: 'update', add: 'update', assign: 'add', remove: 'remove' };
function varTags(d: Delta): DeltaTag[] {
  const ops = d?.varOps;
  if (!ops?.length) return [];
  return ops.map((op, i) => {
    const { text, sub } = describeVarOp(op);
    return { key: `var:op:${i}`, op: VAR_OP_TO_TAGOP[op.op], bucket: 'op', idx: i, text, sub, editable: true };
  });
}

/** 按类目分组(顺序即显示顺序);没有变动的组 tags 为空,由调用方决定是否隐藏。 */
export function deltaTagGroups(d: Delta, floor: number): DeltaTagGroup[] {
  return [
    { title: '主角', icon: 'characters', tags: protagonistTags(d) },
    { title: '物品', icon: 'items', tags: itemTags(d) },
    { title: '角色', icon: 'npcs', tags: npcTags(d) },
    { title: '场景', icon: 'scenes', tags: sceneTags(d) },
    { title: '悬念簿', icon: 'plans', tags: planTags(d, floor) },
    { title: '信息差', icon: 'eye-off', tags: secretTags(d, floor) },
    { title: '变量', icon: 'vars', tags: varTags(d) },
  ];
}
