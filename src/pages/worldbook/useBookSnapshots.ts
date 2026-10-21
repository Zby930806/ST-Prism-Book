/**
 * 页面显示用的世界书数据：读取建议所涉及的各本世界书，供冲突判断和改前改后对比。
 * 世界书被保存（WORLDINFO_UPDATED）、写入或撤销后重新读取；只读，不修改数据。
 */
import { onMounted, shallowRef, watch } from 'vue';
import { loadBook, worldHost } from '@/worldbook/host';
import type { WorldData } from '@/worldbook/types';

export interface BookView { data: WorldData | null; error: string }

export function useBookSnapshots(names: () => string[]) {
  const books = shallowRef(new Map<string, BookView>());
  const loading = shallowRef(false);
  let seq = 0;
  async function refresh(): Promise<void> {
    const id = ++seq;
    const list = [...new Set(names().filter(Boolean))];
    loading.value = true;
    const next = new Map<string, BookView>();
    for (const name of list) {
      try {
        const data = await loadBook(name);
        next.set(name, { data, error: data ? '' : '读不到世界书「' + name + '」，可能已被删除或改名。' });
      } catch (error) {
        next.set(name, { data: null, error: error instanceof Error ? error.message : '读不到世界书「' + name + '」。' });
      }
      if (id !== seq) return;
    }
    if (id !== seq) return;
    books.value = next;
    loading.value = false;
  }
  // 世界书只在保存（WORLDINFO_UPDATED）、写入或撤销后变化，这些都会更新 worldHost.revision；聊天消息的变化不需要重读
  watch(() => [names().join('\u0000'), worldHost.revision], () => { void refresh(); });
  onMounted(() => { void refresh(); });
  return { books, loading, refresh };
}
