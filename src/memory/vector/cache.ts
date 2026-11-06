/** 最近一次向量召回结果的本机缓存键。 */
export const RECALL_CACHE_STORAGE_KEY = 'bbs_vec_recall_cache';

/** 索引素材变化后立即失效旧召回结果，避免下一次生成复用修改前的内容。 */
export function invalidateRecallCache(): void {
  try {
    localStorage.removeItem(RECALL_CACHE_STORAGE_KEY);
  } catch {
    /* 隐私模式/存储不可用时无需处理。 */
  }
}
