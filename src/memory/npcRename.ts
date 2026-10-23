import { createSourceEvidenceMatcher, type EvidenceDropReason } from './sourceEvidence';

/**
 * npcs.rename 的校验:只接受「名册里已有的名字 → 名册里没有的新名字」,并要求本楼原文的连续原句中含新名字。
 * 不从正文猜改名;校验不通过时整份结果按格式错误处理(由 sendAndParse 附原因重试)。
 * 最后一次尝试(传入 onDrop)时只去掉不合格的那条改名,并把同楼引用改到正确的名字上,以免建出重复角色;
 * 多余字段直接忽略。
 */
export class NpcRenameError extends Error {}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (s: string) => s.trim().toLowerCase();
const squash = (s: string) => s.replace(/\s+/g, '');

/** 最后一次尝试中去掉的一条改名。 */
export interface DroppedRename {
  from: string;
  to: string;
  reason: EvidenceDropReason;
  /** 一句说明(给提示和楼层面板用) */
  detail: string;
}

export interface NpcRenameOptions {
  /** 本楼之前的名册名字 */
  roster: readonly string[];
  /** 主角名;不能把角色改成主角 */
  userName?: string;
  /** 本楼原文(每条消息一项,不跨消息拼接) */
  sourceTexts: readonly string[] | string;
  /** 最后一次尝试:不合格的改名只去掉这一条,不让整楼失败 */
  onDrop?: (dropped: DroppedRename) => void;
}

class RenameCheck extends Error {
  constructor(message: string, readonly reason: EvidenceDropReason, readonly detail: string) { super(message); }
}

/**
 * 校验并整理 parsed.npcs.rename(就地删掉 evidence)。返回「旧名(规范化) → 新名」,供伤情补丁按新名找回旧伤情。
 * 没有 rename 时返回空表。
 */
export function validateNpcRenames(parsed: Record<string, unknown>, options: NpcRenameOptions): Map<string, string> {
  const map = new Map<string, string>();
  const npcs = parsed.npcs;
  if (!record(npcs) || !('rename' in npcs)) return map;
  const lenient = !!options.onDrop;
  let list = npcs.rename;
  if (!Array.isArray(list)) {
    if (!lenient) throw new NpcRenameError('npcs.rename 必须是数组,每项包含 from、to、evidence。');
    list = record(list) ? [list] : [];
    if (!(list as unknown[]).length) {
      options.onDrop!({ from: '', to: '', reason: 'invalid', detail: '改名不是数组' });
      delete npcs.rename;
      return map;
    }
  }
  const roster = new Map(options.roster.map(name => [norm(name), name]));
  const userKey = options.userName?.trim() ? norm(options.userName) : '';
  const matches = createSourceEvidenceMatcher(options.sourceTexts);
  const targets = new Set<string>();
  /** 去掉的改名里,同楼用新名字的操作应改回哪个名字(新名字 → 旧名) */
  const revert = new Map<string, string>();
  const kept: unknown[] = [];
  (list as unknown[]).forEach((entry, index) => {
    const path = 'npcs.rename[' + index + ']';
    const from = record(entry) && typeof entry.from === 'string' ? entry.from.trim() : '';
    const to = record(entry) && typeof entry.to === 'string' ? entry.to.trim() : '';
    try {
      if (!record(entry)) throw new RenameCheck(path + ' 必须是对象,包含 from、to、evidence。', 'invalid', '改名条目不是对象');
      const extra = Object.keys(entry).filter(k => !['from', 'to', 'evidence'].includes(k));
      if (extra.length) {
        if (!lenient) throw new RenameCheck(path + ' 含未知字段 ' + extra.join('、') + ';只允许 from、to、evidence。', 'invalid', '');
        for (const k of extra) delete entry[k];
      }
      const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
      if (!from || !to) throw new RenameCheck(path + ' 的 from、to 必须是非空字符串。', 'missing', '缺少原名或新名字');
      if (!roster.has(norm(from))) throw new RenameCheck(path + '.from「' + from + '」不在本楼之前的名册中;改名只用于名册已有的角色,新登场的角色直接用 add。', 'invalid', '原名不在名册中');
      if (map.has(norm(from))) {
        revert.set(norm(to), map.get(norm(from))!);
        throw new RenameCheck(path + ' 重复改名同一角色;每个角色每楼最多改名一次。', 'invalid', '同一角色本楼改名了不止一次，只保留第一次');
      }
      if (norm(to) === norm(from)) throw new RenameCheck(path + ' 的新名字与原名相同,不需要改名。', 'invalid', '新名字与原名相同');
      if (roster.has(norm(to))) throw new RenameCheck(path + '.to「' + to + '」已在名册中;不能改成已有角色的名字。若确是同一人,请直接 update 已有的「' + to + '」,不要改名。', 'invalid', '新名字已是名册中的另一个角色；两条记录可能是同一人，可在「角色」页编辑或删除其中一条');
      if (userKey && norm(to) === userKey) throw new RenameCheck(path + '.to 不能是主角的名字;主角只写 protagonist。', 'invalid', '新名字是主角的名字');
      if (targets.has(norm(to))) throw new RenameCheck(path + '.to「' + to + '」与本楼另一项改名重复。', 'invalid', '与本楼另一项改名的新名字重复');
      if (!evidence) { revert.set(norm(to), from); throw new RenameCheck(path + '.evidence 缺失;请连续照录本楼正文中含新名字的原句。', 'missing', '没有给出正文原句'); }
      if (!squash(evidence).includes(squash(to))) { revert.set(norm(to), from); throw new RenameCheck(path + '.evidence 中没有新名字「' + to + '」;请照录正文中报出或称呼该名字的原句。', 'mismatch', '给出的原句里没有新名字'); }
      if (!matches(evidence)) { revert.set(norm(to), from); throw new RenameCheck(path + '.evidence 与本楼正文不匹配;请连续照录【本轮对话】中的原句,不改写、不拼接,不引用旧名册或历史。', 'mismatch', '给出的原句与本楼正文对不上'); }
      map.set(norm(from), to);
      targets.add(norm(to));
      delete entry.evidence;
      kept.push(entry);
    } catch (error) {
      if (!(error instanceof RenameCheck)) throw error;
      if (!lenient) throw new NpcRenameError(error.message);
      options.onDrop!({ from, to, reason: error.reason, detail: error.detail });
    }
  });
  if (lenient) {
    if (kept.length) npcs.rename = kept;
    else delete npcs.rename;
  }
  // 同一楼对改名角色的其他操作必须使用新名字;新名字已在名册里,不能再用 add 新建。
  // 最后一次尝试时就地改正:仍用旧名的改成新名字;新建了改名后角色的改成 update;
  // 去掉的改名,用它新名字的操作改回旧名(名册里已有,同样改成 update)。
  const resolveName = (name: string): { name: string; existing: boolean } | null => {
    const key = norm(name);
    if (map.has(key)) return { name: map.get(key)!, existing: true };
    if (revert.has(key) && !targets.has(key) && !roster.has(key)) return { name: revert.get(key)!, existing: true };
    return null;
  };
  for (const op of ['add', 'update', 'remove'] as const) {
    const values = npcs[op];
    if (!Array.isArray(values)) continue;
    const stay: unknown[] = [];
    values.forEach((value, index) => {
      const name = typeof value === 'string' ? value : record(value) && typeof value.name === 'string' ? value.name : '';
      if (!name.trim()) { stay.push(value); return; }
      if (!lenient) {
        if (map.has(norm(name))) throw new NpcRenameError('npcs.' + op + '[' + index + '] 仍使用改名前的名字「' + name.trim() + '」;本楼改名后,对该角色的其他操作一律使用新名字。');
        if (op === 'add' && targets.has(norm(name))) throw new NpcRenameError('npcs.add[' + index + '] 新建了刚改名的角色「' + name.trim() + '」;改名后档案已接续,本楼的其他变化请用 update。');
        stay.push(value);
        return;
      }
      const fixed = resolveName(name) ?? (op === 'add' && targets.has(norm(name)) ? { name: name.trim(), existing: true } : null);
      if (!fixed) { stay.push(value); return; }
      // 就地改名(保留对象引用,后面的伤情与定位校验仍认得它)
      let next: unknown = fixed.name;
      if (record(value)) { value.name = fixed.name; next = value; }
      if (op === 'add' && fixed.existing) {
        // 名册里已有这个角色:新建改为更新,档案接续
        const update = Array.isArray(npcs.update) ? npcs.update : (npcs.update = []);
        (update as unknown[]).push(next);
        return;
      }
      stay.push(next);
    });
    if (lenient) {
      if (stay.length) npcs[op] = stay;
      else delete npcs[op];
    }
  }
  return map;
}
