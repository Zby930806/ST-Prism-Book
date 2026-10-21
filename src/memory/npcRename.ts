import { createSourceEvidenceMatcher } from './sourceEvidence';

/**
 * npcs.rename 的校验:只接受「名册里已有的名字 → 名册里没有的新名字」,并要求本楼原文的连续原句中含新名字。
 * 不从正文猜改名;校验不通过时整份结果按格式错误处理(由 sendAndParse 附原因重试),不能只丢掉改名。
 */
export class NpcRenameError extends Error {}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (s: string) => s.trim().toLowerCase();
const squash = (s: string) => s.replace(/\s+/g, '');

export interface NpcRenameOptions {
  /** 本楼之前的名册名字 */
  roster: readonly string[];
  /** 主角名;不能把角色改成主角 */
  userName?: string;
  /** 本楼原文(每条消息一项,不跨消息拼接) */
  sourceTexts: readonly string[] | string;
}

/**
 * 校验并整理 parsed.npcs.rename(就地删掉 evidence)。返回「旧名(规范化) → 新名」,供伤情补丁按新名找回旧伤情。
 * 没有 rename 时返回空表。
 */
export function validateNpcRenames(parsed: Record<string, unknown>, options: NpcRenameOptions): Map<string, string> {
  const map = new Map<string, string>();
  const npcs = parsed.npcs;
  if (!record(npcs) || !('rename' in npcs)) return map;
  const list = npcs.rename;
  if (!Array.isArray(list)) throw new NpcRenameError('npcs.rename 必须是数组,每项包含 from、to、evidence。');
  const roster = new Map(options.roster.map(name => [norm(name), name]));
  const userKey = options.userName?.trim() ? norm(options.userName) : '';
  const matches = createSourceEvidenceMatcher(options.sourceTexts);
  const targets = new Set<string>();
  list.forEach((entry, index) => {
    const path = 'npcs.rename[' + index + ']';
    if (!record(entry)) throw new NpcRenameError(path + ' 必须是对象,包含 from、to、evidence。');
    const extra = Object.keys(entry).filter(k => !['from', 'to', 'evidence'].includes(k));
    if (extra.length) throw new NpcRenameError(path + ' 含未知字段 ' + extra.join('、') + ';只允许 from、to、evidence。');
    const from = typeof entry.from === 'string' ? entry.from.trim() : '';
    const to = typeof entry.to === 'string' ? entry.to.trim() : '';
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
    if (!from || !to) throw new NpcRenameError(path + ' 的 from、to 必须是非空字符串。');
    if (!roster.has(norm(from))) throw new NpcRenameError(path + '.from「' + from + '」不在本楼之前的名册中;改名只用于名册已有的角色,新登场的角色直接用 add。');
    if (map.has(norm(from))) throw new NpcRenameError(path + ' 重复改名同一角色;每个角色每楼最多改名一次。');
    if (norm(to) === norm(from)) throw new NpcRenameError(path + ' 的新名字与原名相同,不需要改名。');
    if (roster.has(norm(to))) throw new NpcRenameError(path + '.to「' + to + '」已在名册中;不能改成已有角色的名字。若确是同一人,请直接 update 已有的「' + to + '」,不要改名。');
    if (userKey && norm(to) === userKey) throw new NpcRenameError(path + '.to 不能是主角的名字;主角只写 protagonist。');
    if (targets.has(norm(to))) throw new NpcRenameError(path + '.to「' + to + '」与本楼另一项改名重复。');
    if (!evidence) throw new NpcRenameError(path + '.evidence 缺失;请连续照录本楼正文中含新名字的原句。');
    if (!squash(evidence).includes(squash(to))) throw new NpcRenameError(path + '.evidence 中没有新名字「' + to + '」;请照录正文中报出或称呼该名字的原句。');
    if (!matches(evidence)) throw new NpcRenameError(path + '.evidence 与本楼正文不匹配;请连续照录【待摘要正文】中的原句,不改写、不拼接,不引用旧名册或历史。');
    map.set(norm(from), to);
    targets.add(norm(to));
    delete entry.evidence;
  });
  // 同一楼对改名角色的其他操作必须使用新名字;新名字已在名册里,不能再用 add 新建。
  for (const op of ['add', 'update', 'remove'] as const) {
    const values = npcs[op];
    if (!Array.isArray(values)) continue;
    values.forEach((value, index) => {
      const name = typeof value === 'string' ? value : record(value) && typeof value.name === 'string' ? value.name : '';
      if (!name.trim()) return;
      if (map.has(norm(name))) throw new NpcRenameError('npcs.' + op + '[' + index + '] 仍使用改名前的名字「' + name.trim() + '」;本楼改名后,对该角色的其他操作一律使用新名字。');
      if (op === 'add' && targets.has(norm(name))) throw new NpcRenameError('npcs.add[' + index + '] 新建了刚改名的角色「' + name.trim() + '」;改名后档案已接续,本楼的其他变化请用 update。');
    });
  }
  return map;
}
