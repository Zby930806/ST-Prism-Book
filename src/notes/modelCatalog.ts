import { onScopeDispose, ref, watch } from 'vue';
import { ApiError, fetchModels } from '@/api/client';

type ModelSource = { url: string; key: string; timeoutSec?: number };

/** 列表只属于当前札记 API 草稿；不保存密钥/列表，不替用户选择或保存模型。 */
export function useNotesModelCatalog(source: ModelSource) {
  const models = ref<string[]>([]);
  const loading = ref(false);
  const message = ref('');
  const error = ref('');
  let requestId = 0;
  let controller: AbortController | undefined;

  function cancel() {
    ++requestId;
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
  function reset() {
    cancel();
    models.value = [];
    message.value = '';
    error.value = '';
  }
  // 同一事件内改地址后立即重新拉取，也必须先失效旧请求。
  watch(() => [source.url, source.key], reset, { flush: 'sync' });
  onScopeDispose(reset);

  async function pull() {
    if (loading.value) return;
    error.value = '';
    message.value = '';
    const snapshot = { url: source.url.trim(), key: source.key, timeoutSec: source.timeoutSec };
    try {
      const url = new URL(snapshot.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch {
      error.value = '请先填写不含账号、查询参数或片段的完整 HTTP / HTTPS API 地址。';
      return;
    }
    const id = ++requestId;
    controller = new AbortController();
    loading.value = true;
    models.value = [];
    try {
      const list = await fetchModels(snapshot, { signal: controller.signal });
      if (id !== requestId) return;
      models.value = [...new Set(list.map(model => model.trim()).filter(Boolean))].sort();
      message.value = models.value.length
        ? `已获取 ${models.value.length} 个模型，请下拉选择后保存；不会自动更换当前模型。`
        : '接口未返回可用模型，可以手动填写模型 ID 后保存。';
    } catch (cause) {
      if (id !== requestId) return;
      // 上游错误可能回显密钥、URL或HTML，只呈现状态码及固定恢复提示。
      const status = cause instanceof ApiError ? cause.status : undefined;
      const reason = status === 401 || status === 403 ? '请检查札记 API 密钥和访问权限。'
        : status === 404 || status === 405 ? '接口可能未提供模型列表。'
        : status === 429 ? '接口请求过于频繁，请稍后重试。'
        : '请检查地址、网络或超时设置后重试。';
      error.value = `拉取模型失败${status ? `（HTTP ${status}）` : ''}。${reason}仍可手动填写模型 ID。`;
    } finally {
      if (id === requestId) { loading.value = false; controller = undefined; }
    }
  }

  return { models, loading, message, error, pull, cancel };
}
