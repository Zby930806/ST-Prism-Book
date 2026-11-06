/** 向量召回默认注入深度:D0,紧邻最新用户输入。 */
export const DEFAULT_RECALL_INJECTION_DEPTH = 0;

/** 注入深度只接受非负整数;旧配置缺失、输入为空或非法时保持默认 D0。 */
export function normalizeRecallInjectionDepth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_RECALL_INJECTION_DEPTH;
}
