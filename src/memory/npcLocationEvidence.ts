/** 只验证定位引文来源，不用关键词猜测角色实际位置。 */
export const NPC_LOCATION_EVIDENCE_PROTOCOL = `【NPC 定位证据】
- 本楼输出 npcs.add/update 的非空 location 时，同对象必须给 locationEvidence：从【待摘要正文】连续照录能说明该角色本轮位置的短句，须包含人物与定位依据。不能引用旧名册、历史摘要、闪回或计划作为当前定位。
- 主角离开而定点角色未同行、此前打算留守、暂无新消息，都不构成重新确认旧位置；此时省略该角色 location/locationEvidence，由系统保留最后确认并标记过期。角色重逢或正文明确交代其远方现位置时才重新确认。
- 空 location 表示去向不明，不需引文；follow:true 表示同行，不同时写 location。只有定位操作才附 locationEvidence，同一角色每楼最多一次定位。证据仅用于解析校验，存储前移除，不进入正文或档案。
`;

export class NpcLocationEvidenceError extends Error {}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function validateNpcLocationEvidence(parsed: Record<string, unknown>, options: { strict: boolean; content?: string }): void {
  const ops = record(parsed.npcs) ? parsed.npcs : {};
  const entries = ['add', 'update'].flatMap(op => Array.isArray(ops[op]) ? (ops[op] as unknown[]).filter(record) : []);
  const allowed = new Set(entries);
  // 主角、根层、物品或嵌套对象里的同名字段不能被 finalize 静默吞掉。
  function checkPlacement(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(checkPlacement); return; }
    if (!record(value)) return;
    if ('locationEvidence' in value && !allowed.has(value)) {
      throw new NpcLocationEvidenceError('locationEvidence 只能放在 npcs.add/update 的对应角色对象内。');
    }
    Object.values(value).forEach(checkPlacement);
  }
  checkPlacement(parsed);
  const located = new Set<string>();
  for (const entry of entries) {
    const provided = 'locationEvidence' in entry;
    // 自定义旧模板不强制新合同；主动采用时仍须校验。
    if (!options.strict && !provided) continue;
    const place = typeof entry.location === 'string' ? entry.location.trim() : '';
    if ('location' in entry && typeof entry.location !== 'string') {
      throw new NpcLocationEvidenceError('NPC location 必须是字符串；去向不明用空字符串。');
    }
    if ('location' in entry || 'follow' in entry) {
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name || located.has(name)) throw new NpcLocationEvidenceError('同一NPC每楼只能输出一次定位，须使用唯一非空 name。');
      located.add(name);
    }
    if (entry.follow === true && 'location' in entry) {
      throw new NpcLocationEvidenceError('follow:true 表示同行，请省略 location 和 locationEvidence。');
    }
    if (!place && provided) throw new NpcLocationEvidenceError('locationEvidence 必须配合同对象的非空 location；无新定位则一并省略。');
    if (place) {
      const quote = entry.locationEvidence;
      if (typeof quote !== 'string' || !quote.trim()) {
        throw new NpcLocationEvidenceError('NPC非空 location 必须附 locationEvidence 本楼连续原文。未同行或暂无消息不能重报旧地点，请省略定位更新。');
      }
      if (!options.content || !options.content.includes(quote.trim())) {
        throw new NpcLocationEvidenceError('locationEvidence 必须连续照录本楼待摘要正文；旧历史、名册或拼接引文不能用来确认当前位置。');
      }
    }
  }
  for (const entry of entries) delete entry.locationEvidence;
}
