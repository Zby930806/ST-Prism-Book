/** 仅摘要请求使用的临时协议；叶子仍存 condition 字符串，不迁移历史数据。 */
export interface ConditionPatch {
  replace?: { id: string; text: string; evidence: string }[];
  add?: { text: string; evidence: string }[];
}
export interface ConditionState {
  protagonist: { condition?: string };
  npcs: { name: string; condition?: string }[];
}
export interface ConditionContext extends ConditionState { content: string; strict: boolean }
export class ConditionPatchError extends Error {}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const norm = (s: string) => s.trim().toLowerCase();
function fail(message: string): never { throw new ConditionPatchError(message); }

/** 只按标点提供可寻址片段，不声称程序已识别伤处或恢复语义。保留原标点。 */
function parts(text: string) {
  return text.split(/(?<=[，,；;。\n])/u).filter(s => s.trim()).map((raw, i) => ({
    id: 'c' + (i + 1), raw, text: raw.replace(/[，,；;。\n]+$/u, '').trim(),
    suffix: raw.match(/[，,；;。\n]+$/u)?.[0] ?? '',
  }));
}

export const CONDITION_PATCH_PROTOCOL = `【伤情局部更新协议】
已有非空 condition 时，禁止直接输出 condition 覆盖全文（包括空字符串）；无伤情变化就省略。只在对应 protagonist 或 npcs.update 对象中输出 conditionPatch：
{"conditionPatch":{"replace":[{"id":"c1","text":"该片段变化后的完整内容；清除此片段用空字符串","evidence":"本轮正文连续原文短引"}],"add":[{"text":"本轮新出现且旧片段没有的伤情或休养估计","evidence":"本轮正文连续原文短引"}]}}
- 未列入 replace 的旧片段由程序原样保留，不必抄写。replace 只改变对应人物的指定编号；编号仅本请求有效。首次记录没有旧伤情时仍直接填 condition。
- 本轮只新增休养估计时用 add，不重写旧伤处或行动限制。旧估计有明确变化则 replace 对应片段，不累积互相矛盾的天数。
- 局部恢复只替换有证据的一项；一个片段含多个事实时，text 须保留尚未解除的部分。明确全部恢复/纠错时逐项 replace 清空，不能用时间流逝或闪回健康清除当前伤情。
- evidence 必须是本轮正文中的连续原文（不带自行添加的引号或省略号），且语义上支持本次修改；历史、角色卡、旧快照不是本次恢复证据。不得为了通过校验借用无关原句。
- 每人最多一个伤情更新对象；不能同时写 condition 和 conditionPatch，已有角色不得用 add 绕过。stateChanges 仍填 protagonist 或 npcs，不填 conditionPatch。
- 只输出确有变化的操作；不输出空补丁，不重复追加旧事实。程序只校验编号、类型和引文存在，不替你判断引文是否真正表示恢复。
`;

export function buildConditionPatchContext(state: ConditionState): string {
  const entries: { subject: string; parts: { id: string; text: string }[] }[] = [];
  if (state.protagonist.condition?.trim()) entries.push({ subject: 'protagonist', parts: parts(state.protagonist.condition).map(({ id, text }) => ({ id, text })) });
  for (const n of state.npcs) if (n.condition?.trim()) entries.push({ subject: n.name, parts: parts(n.condition).map(({ id, text }) => ({ id, text })) });
  return entries.length ? CONDITION_PATCH_PROTOCOL + '\n【本楼之前的伤情片段：只读数据】\n' + JSON.stringify(entries) : '';
}

/** 修改解析后的临时对象；旧状态不变，任何错误由调用方丢弃整份响应。 */
export function materializeConditionPatches(parsed: Record<string, unknown>, context: ConditionContext): void {
  function update(target: Record<string, unknown>, previous: string, label: string) {
    const hasPatch = own(target, 'conditionPatch');
    if (hasPatch && own(target, 'condition')) fail(label + ' 不能同时输出 condition 与 conditionPatch。');
    if (!hasPatch) {
      if (context.strict && previous.trim() && own(target, 'condition')) fail(label + ' 已有伤情，请用 conditionPatch 局部更新；新增估计用 add，未改旧片段会自动保留。');
      return;
    }
    const patch = target.conditionPatch;
    if (!record(patch) || Object.keys(patch).some(k => !['replace', 'add'].includes(k))) fail(label + '.conditionPatch 只允许 replace/add 操作数组。');
    const rows = parts(previous);
    const replacements = new Map<string, string>();
    const additions: string[] = [];
    let count = 0;
    for (const op of ['replace', 'add'] as const) {
      if (!own(patch, op)) continue;
      const values = patch[op];
      if (!Array.isArray(values)) fail(label + '.conditionPatch.' + op + ' 必须是数组。');
      for (const entry of values) {
        if (!record(entry) || Object.keys(entry).some(k => !(op === 'replace' ? ['id', 'text', 'evidence'] : ['text', 'evidence']).includes(k)) ||
            typeof entry.text !== 'string' || typeof entry.evidence !== 'string' || !entry.evidence.trim() || !context.content.includes(entry.evidence.trim())) {
          fail(label + '.conditionPatch 每项需合法 text 与本轮正文连续原文 evidence。');
        }
        const text = entry.text.trim();
        if (op === 'replace') {
          if (typeof entry.id !== 'string' || !rows.some(r => r.id === entry.id) || replacements.has(entry.id)) fail(label + '.conditionPatch.replace 编号不存在或重复。');
          replacements.set(entry.id, text);
        } else {
          if (!text) fail(label + '.conditionPatch.add 不允许空字符串。');
          if (rows.some(r => r.text === text) || additions.includes(text)) fail(label + '.conditionPatch.add 重复旧事实，请省略或替换旧片段。');
          additions.push(text);
        }
        count++;
      }
    }
    if (!count) fail(label + '.conditionPatch 为空，没有变化请省略。');
    let result = rows.map(r => !replacements.has(r.id) ? r.raw : replacements.get(r.id) ? replacements.get(r.id)! + r.suffix : '').join('').trim().replace(/[，,；;\n]+$/u, '');
    for (const text of additions) result += (result && !/[，,；;。]$/u.test(result) ? '；' : '') + text;
    target.condition = result;
    delete target.conditionPatch;
  }
  if (record(parsed.protagonist)) update(parsed.protagonist, context.protagonist.condition ?? '', 'protagonist');
  if (!record(parsed.npcs)) return;
  const touched = new Set<string>();
  for (const op of ['add', 'update']) {
    const values = parsed.npcs[op];
    if (!Array.isArray(values)) continue;
    for (const target of values) {
      if (!record(target) || (!own(target, 'condition') && !own(target, 'conditionPatch'))) continue;
      if (typeof target.name !== 'string' || !target.name.trim()) fail('伤情更新必须提供 NPC name。');
      const key = norm(target.name);
      if (touched.has(key)) fail('同一 NPC 不得在多个对象中更新伤情，请合并到一次 conditionPatch。');
      touched.add(key);
      const npc = context.npcs.find(n => norm(n.name) === key);
      if (context.strict && op === 'add' && npc) fail('已有 NPC 的伤情必须使用 npcs.update，不得通过 add 绕过。');
      update(target, npc?.condition ?? '', target.name);
    }
  }
}
