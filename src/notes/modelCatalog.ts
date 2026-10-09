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
      error.value = '先填好 API 地址：要写完整的 http(s) 地址，不能带账号、? 参数或 #。';
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
        ? `拉到 ${models.value.length} 个模型，从列表里选一个，再点保存。`
        : '接口没有返回任何模型，可以直接手动填写模型名。';
    } catch (cause) {
      if (id !== requestId) return;
      // 上游错误可能回显密钥、URL或HTML，只呈现状态码与分类后的恢复提示。
      const status = cause instanceof ApiError ? cause.status : undefined;
      const kind = cause instanceof ApiError && cause.title ? cause.kind : undefined;
      const reason = kind === 'network' && cause instanceof ApiError ? `${cause.title}。${cause.hint}`
        : kind === 'timeout' ? '等了太久没有响应。检查网络，或调大超时再试。'
        : kind === 'format' ? '返回的不是模型列表。检查地址是不是指向接口（一般以 /v1 结尾）。'
        : kind === 'upstream' ? '服务商没有给出列表：可能是地址不对、密钥无效，或这家服务不提供模型列表。'
        : kind === 'quota' ? '账户余额或额度不足。'
        : status === 401 || status === 403 ? '密钥无效或没有权限，请检查 API 密钥。'
        : status === 404 || status === 405 ? '这个地址没有提供模型列表。'
        : status === 429 ? '请求太频繁，被限流了，稍后再试。'
        : '检查地址、网络或超时设置后再试。';
      error.value = `拉取模型列表失败${status ? `（HTTP ${status}）` : ''}：${reason}也可以直接手动填写模型名。`;
    } finally {
      if (id === requestId) { loading.value = false; controller = undefined; }
    }
  }

  return { models, loading, message, error, pull, cancel };
}
