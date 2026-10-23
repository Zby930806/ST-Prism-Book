/** 模型下拉（ModelCombo.vue）最多显示的条数；更多的用关键词筛选。 */
export const MODEL_LIST_LIMIT = 200;

/**
 * 按关键词（不区分大小写的子串）筛选模型列表，最多返回 limit 条；
 * more 是超出、没有显示的条数，列表底部据此提示「还有 N 个，输入关键词筛选」。
 */
export function filterModelOptions(list: readonly string[], query: string, limit = MODEL_LIST_LIMIT): { shown: string[]; more: number } {
  const q = query.trim().toLowerCase();
  const matched = q ? list.filter(m => m.toLowerCase().includes(q)) : [...list];
  return { shown: matched.slice(0, limit), more: Math.max(0, matched.length - limit) };
}
