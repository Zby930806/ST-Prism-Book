import type { STMessage } from '@/st/context';
import { legacyDeltaIssue } from './apply';
import type { LeafExtra, MemSummary } from './types';

/** 兼容检查只读：不补造剧情、状态、页码，也不调用模型。 */
export interface CompatibilityReport {
  mode: 'ready' | 'convert' | 'protected';
  leaves: number;
  summaries: number;
  issues: string[];
  conversion: Array<{ floor: number; leaf: LeafExtra }>;
}
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasText = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

/** 缺省页码只兼容第一页；不能把无法归属的旧摘要猜到当前新回复。 */
export function legacyLeafIssue(raw: unknown, message: STMessage): string | null {
  if (raw == null) return null;
  if (!isRecord(raw) || !hasText(raw.id) || typeof raw.text !== 'string' || !isRecord(raw.delta)) return '摘要结构不完整（需保留原记录核对）';
  if (raw.v !== undefined && raw.v !== 1) return '摘要版本尚未支持';
  if (raw.swipe !== undefined && (!Number.isInteger(raw.swipe) || (raw.swipe as number) < 0)) return '摘要分页标记无效';
  if (raw.swipe === undefined && (message.swipe_id ?? 0) !== 0) return '旧摘要未记录分页，不能确定属于当前哪一条回复';
  return null;
}

export function inspectCompatibility(raw: unknown, chat: STMessage[]): CompatibilityReport {
  const result: CompatibilityReport = { mode: 'ready', leaves: 0, summaries: 0, issues: [], conversion: [] };
  const issue = (text: string) => { if (result.issues.length < 12) result.issues.push(text); result.mode = 'protected'; };
  const ids = new Set<string>();
  const addId = (id: string) => { if (ids.has(id)) issue('重复的记忆 ID：' + id); ids.add(id); };
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    const leaf = m?.extra?.bbs_leaf;
    if (leaf == null) continue;
    const why = legacyLeafIssue(leaf, m);
    if (why) { issue('#' + i + '：' + why); continue; }
    addId(leaf.id);
    result.leaves++;
  }
  if (raw == null) return result;
  if (!isRecord(raw)) { issue('聊天记忆不是可识别的对象'); return result; }
  // 不把未来格式当成 V3，也不把未标版本的旧状态强塞进叶子。
  if (raw.version !== 3 && raw.version !== 2) { issue('记忆版本 ' + String(raw.version ?? '未标记') + ' 尚未验证；原数据已保留'); return result; }
  if (!Array.isArray(raw.summaries)) { issue('总结列表格式不完整'); return result; }
  const nodes: Record<string, unknown>[] = [];
  const targets = new Set<number>();
  for (const value of raw.summaries) {
    if (!isRecord(value) || !hasText(value.id) || typeof value.text !== 'string' || !Number.isInteger(value.level) || (value.level as number) < 0) { issue('存在无法识别的历史总结节点'); continue; }
    const s = value;
    if (raw.version === 2 && s.level === 0) {
      const cov = s.coveredIndices;
      if (!Array.isArray(cov) || cov.length !== 1 || !Number.isInteger(cov[0])) { issue('旧摘要 ' + s.id + ' 覆盖范围不是单一确定楼层，暂不自动转换'); continue; }
      const floor = cov[0] as number;
      const m = chat[floor];
      if (!m || m.is_user || m.extra?.bbs_omit || m.extra?.bbs_internal_notice || (m.swipe_id ?? 0) !== 0 || targets.has(floor) || !isRecord(s.delta)) { issue('旧摘要 ' + s.id + ' 无法安全对应原楼层/分页/状态'); continue; }
      const deltaIssue = legacyDeltaIssue(s.delta);
      if (deltaIssue) { issue('旧摘要 ' + s.id + '：' + deltaIssue); continue; }
      const existing = m.extra?.bbs_leaf;
      if (existing) { issue('旧摘要 ' + s.id + ' 的目标楼层已有记录；不覆盖'); continue; }
      targets.add(floor);
      addId(s.id as string);
      result.conversion.push({ floor, leaf: { ...s, id: s.id as string, text: s.text as string, delta: s.delta, createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0, swipe: 0, v: 1 } as LeafExtra });
      continue;
    }
    if ((s.level as number) < 1 || !Array.isArray(s.childIds) || !s.childIds.every(hasText)) { issue('总结 ' + s.id + ' 的层级或引用关系不完整'); continue; }
    if (s.imported === true) {
      if (!Number.isInteger(s.importedFloorEnd) || (s.importedFloorEnd as number) < 0 || (s.importedFloorEnd as number) >= chat.length || (s.importedFloorStart !== undefined && (!Number.isInteger(s.importedFloorStart) || (s.importedFloorStart as number) < 0 || (s.importedFloorStart as number) > (s.importedFloorEnd as number)))) issue('导入历史 ' + s.id + ' 覆盖范围不明确');
    } else if (!s.childIds.length) issue('总结 ' + s.id + ' 缺少下层引用，不能将历史误判成全部未摘');
    addId(s.id as string);
    nodes.push(s);
  }
  result.summaries = nodes.length;
  // 同一楼的其它分页属于有效存档，不能因当前页不显示而判为丢失。
  for (const m of chat) {
    const pages = (m as unknown as Record<string, unknown>).swipe_info;
    if (!Array.isArray(pages)) continue;
    for (const page of pages) {
      const extra = isRecord(page) && isRecord(page.extra) ? page.extra : null;
      if (!extra || extra.bbs_leaf == null) continue;
      const archived = extra.bbs_leaf;
      const pageIndex = pages.indexOf(page);
      const why = legacyLeafIssue(archived, { ...m, swipe_id: pageIndex });
      if (why) { issue('历史分页摘要：' + why); continue; }
      ids.add((archived as unknown as LeafExtra).id);
    }
  }
  const byId = new Map(nodes.map(s => [s.id as string, s]));
  const parents = new Map<string, string>();
  for (const n of nodes) for (const child of n.childIds as string[]) {
    if (parents.has(child)) issue('下层记忆被重复引用：' + child);
    parents.set(child, n.id as string);
    const lower = byId.get(child);
    if (lower && (lower.level as number) >= (n.level as number)) issue('总结层级倒置：' + n.id);
  }
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (visiting.has(id)) { issue('总结引用形成循环：' + id); return 0; }
    if (visited.has(id)) return depths.get(id) ?? 0;
    if (visiting.size >= 64) { issue('总结层级过深，停止自动解析'); return 65; }
    const n = byId.get(id);
    if (!n || n.imported) return 0;
    visiting.add(id);
    let depth = 1;
    for (const child of n.childIds as string[]) {
      if (!ids.has(child)) issue('总结 ' + id + ' 引用的历史记录缺失：' + child);
      else depth = Math.max(depth, 1 + visit(child));
    }
    if (depth > 64) issue('总结层级过深，停止自动解析');
    visiting.delete(id); visited.add(id); depths.set(id, depth);
    return depth;
  };
  for (const id of byId.keys()) visit(id);
  if (result.mode !== 'protected' && raw.version === 2) result.mode = 'convert';
  return result;
}

export function convertedForest(raw: Record<string, unknown>): MemSummary[] {
  return (raw.summaries as MemSummary[]).filter(s => s.level >= 1);
}
