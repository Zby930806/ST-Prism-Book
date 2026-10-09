import { getContext } from '@/st/context';
import type { ApiChannel } from './settings';
import {
  ApiError, apiFailure, classifyHttpFailure, describeFailure, emptyReply, filteredReply, finishKind, interruptedReply,
  invalidResponse, networkFailure, parseUpstreamError, sanitizeDetail, statusFromText, timeoutFailure,
  truncatedReply, type ReplyMeta,
} from './errors';

export { ApiError } from './errors';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留,避免破坏 /v2/coding 等自定义路由。
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 测试渠道时备用的 /v1 形式。只在首个地址明确返回 404/405 时才会尝试。 */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** 仅流式请求:每次非空文本增量后传入累计原文(未 trim),而非单个片段。 */
  onDelta?: (text: string) => void;
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * 给完整请求生命周期套超时:不仅覆盖 fetch 建连,也覆盖非流式 JSON 读取和流式 SSE 读取。
 * 外部 signal 仍可提前取消;只有本定时器触发时才转换成明确的超时报错。
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw timeoutFailure(label, timeoutSec);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/** fetch 本身抛出的 TypeError 只可能是浏览器连不上酒馆;取消与超时原样交给上层。 */
async function fetchHost(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof TypeError && !init.signal?.aborted) throw networkFailure(e.message, { toHost: true });
    throw e;
  }
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

/**
 * 构造发给 ST 代理的请求体(纯函数,便于测两条分支的产物)。
 *
 * 两条分支,按渠道有没有设思考强度二选一:
 *
 * ① 未设(reasoningEffort 为空 = auto):走 `chat_completion_source: 'openai'`,
 *    与加本功能之前**逐字节一致**——存量用户零变化。
 *
 * ② 已设:走 `'custom'`。因为 ST 代理对 openai 源的 reasoning_effort 卡**模型名白名单**
 *    (src/constants.js 的 OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),
 *    模型名对不上就静默丢弃、还照样返回 200(实测确认),用户设了却无效且看不出来。
 *    custom 源的 custom_include_body 由服务端 mergeObjectWithYaml 直接并进上游请求体,
 *    不过任何白名单,任意字段/嵌套对象都能透传。
 *
 * 两条路都仍然走 ST 服务端转发(同一个 /generate 端点),没有浏览器直连,
 * 因此 CORS、密钥不落浏览器、SSE 转发等性质完全不变。
 *
 * custom 源的两个坑(都已规避):
 * - 它**不读 proxy_password**,只读 ST 自己存的 Custom 密钥,所以 key 必须靠
 *   custom_include_headers 注入 Authorization(服务端 `...headers` 排在默认
 *   Authorization 之后,覆盖成立);
 * - custom_include_* 是 YAML 字符串且**解析失败会静默忽略**(util.js 的 catch 是空的)。
 *   key 里带 `:` `#` `{` 或以 `*` 开头都会让 YAML 解析炸 → header 没注入 →
 *   退回用 ST 的 Custom 密钥,可能把用户另一个服务商的 key 发到本端点。
 *   故一律用 JSON.stringify 生成(YAML 是 JSON 的超集),转义交给它,不手拼。
 *
 * 另:请求体固定带 `tool_choice: 'none'`,这是给第三方 fetch 拦截器的声明式放行握手。
 * 酒馆助手预设脚本(如 Kemini Dramatron 面板)可能 monkey-patch `window.parent.fetch`,
 * 拦截所有 `/api/backends/…/generate` 请求并塞入合成工具 + 控制消息,把摘要劫持成
 * 工具调用(实测拖慢数倍)。这类拦截器普遍支持「调用方自带 tool_choice 就放行」
 * (Dramatron 的 callerControlsTools 对 'none' 明确 bypass),所以我们主动声明不用工具。
 * 对上游无影响:ST 服务端只在 tools 为非空数组时才转发 tool_choice
 * (src/endpoints/backends/chat-completions.js),本函数从不发 tools,该字段到不了服务商。
 *
 * (与柏宝绘 src/api/client.ts 的同名函数同源,行为保持一致。)
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  stream: boolean,
): Record<string, unknown> {
  const effort = channel.reasoningEffort?.trim() ?? '';
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // 不用工具:见函数头注释,防第三方 fetch 拦截器把摘要改写成工具调用
    tool_choice: 'none',
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  // 注:固定路由字段(chat_completion_source/reverse_proxy 等)不应被删,但全凭用户填写,
  // 这里只做忠实剔除——文案会提示填采样参数名(temperature/max_tokens/...)。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

/** 本次请求实际发送的最大输出;被「排除参数」去掉时由服务商自行决定。 */
function sentMaxTokens(channel: ApiChannel): number | undefined {
  return (channel.excludeParams ?? []).some(p => p.trim() === 'max_tokens') ? undefined : channel.maxTokens ?? 65535;
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw apiFailure('config', '酒馆上下文还没准备好', '请等页面加载完成后重试。');
  if (!channel.url || !channel.model) {
    throw apiFailure('config', `「${channel.name || '未命名渠道'}」还没有填写${!channel.url ? ' API 地址' : '模型名'}`, '请先在对应的 API 设置里补全。');
  }

  const stream = channel.stream ?? false;
  // 预填充开关(默认开):关闭时丢掉末尾那条 assistant 预填充消息。
  // 摘要/批量请求会在末尾追加一条 assistant 预填充引导思维链;对不支持预填充(不续写)的端点
  // 形同浪费、个别端点还要求「最后一条须为 user」。关掉只是不发它,思维链引导仍由 system 清单承担。
  const outMessages =
    channel.prefill === false && messages[messages.length - 1]?.role === 'assistant'
      ? messages.slice(0, -1)
      : messages;
  const body = buildRequestBody(channel, outMessages, reverseProxy, stream);
  const maxTokens = sentMaxTokens(channel);

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, opts.signal, 'API 请求', async signal => {
    const resp = await fetchHost(GENERATE_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text });
    }

    // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
    if (stream) {
      const reply = await readSseContent(resp, signal, opts.onDelta);
      return finishReply(reply.text, { ...reply.meta, maxTokens });
    }

    let data: any;
    try {
      data = await resp.json();
    } catch (e) {
      if (e instanceof SyntaxError) throw invalidResponse(e.message);
      throw e;
    }
    if (data?.error) throw envelopeFailure(data);
    const reply = parseCompletion(data);
    return finishReply(reply.text, { ...reply.meta, maxTokens });
  });
}

/**
 * 截断、内容审核、服务端中断都要明确报出来:模型写到一半的 JSON 不能当成完整结果,
 * 也不能被笼统地说成「格式错误」。半截回复放进 ApiError.partial,由调用方决定是否保留。
 */
function finishReply(text: string, meta: ReplyMeta): string {
  switch (finishKind(meta.finishReason)) {
    case 'truncated': throw truncatedReply(meta, text);
    case 'filtered': throw filteredReply(meta, text);
    case 'interrupted': throw interruptedReply(meta, text);
  }
  if (!text) throw emptyReply(meta);
  return text;
}

/** 酒馆非流式代理把上游错误改写为 200 + { error: { message: statusText }, quota_error }。 */
function envelopeFailure(data: any): ApiError {
  const message = data?.error && typeof data.error === 'object' ? String(data.error.message ?? '') : typeof data?.error === 'string' ? data.error : '';
  return classifyHttpFailure({ status: statusFromText(message), body: data, quotaFlag: data?.quota_error === true });
}

/** content 既可能是字符串,也可能是 [{ type:'text', text }] 分段。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/** 优先取能识别的结束原因(OpenRouter 的 native_finish_reason、Anthropic 的 stop_reason 等)。 */
function finishReasonOf(json: any): string | undefined {
  const choice = json?.choices?.[0];
  const values = [choice?.finish_reason, choice?.native_finish_reason, choice?.stop_reason, json?.stop_reason, json?.delta?.stop_reason]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return values.find(v => finishKind(v)) ?? values[0];
}

function outputTokensOf(json: any): number | undefined {
  const value = json?.usage?.completion_tokens ?? json?.usage?.output_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 从标准 OpenAI(及兼容 Anthropic 结构)的完整响应体提取文本与结束信息。 */
function parseCompletion(data: any): { text: string; meta: ReplyMeta } {
  const choice = data?.choices?.[0];
  const text = (textOf(choice?.message?.content) || textOf(choice?.text) || textOf(data?.content)).trim();
  const reasoning = textOf(choice?.message?.reasoning_content) || textOf(choice?.message?.reasoning);
  return { text, meta: { finishReason: finishReasonOf(data), outputTokens: outputTokensOf(data), sawReasoning: !!reasoning.trim() } };
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content,同时记下结束原因。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 * 有的中转无视 stream 直接回整段 JSON,或把错误写成普通 JSON;没有任何 data 行时按整体 JSON 处理。
 */
async function readSseContent(
  resp: Response,
  signal: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<{ text: string; meta: ReplyMeta }> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // 无法流式读取(理论上不会):退回当作整体 JSON 处理
    const data = await resp.json().catch(() => null);
    signal.throwIfAborted();
    if (data?.error) throw envelopeFailure(data);
    const reply = data ? parseCompletion(data) : { text: '', meta: {} };
    if (reply.text) onDelta?.(reply.text);
    signal.throwIfAborted();
    return reply;
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let reachedEof = false;
  let sawData = false;
  let plain = '';
  const meta: ReplyMeta = {};
  // 主动打断 reader.read,不只依赖 fetch 实现对 signal 的转发。
  // 不等待底层 cancel 完成,避免上游清理阻塞取消/超时错误的返回。
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });

  const readLine = (line: string): boolean => {
    signal.throwIfAborted();
    const t = line.trim();
    if (!t) return false;
    if (!t.startsWith('data:')) {
      // 注释、event/id/retry 字段是 SSE 协议本身;其余文本留作「整段 JSON」兜底。
      if (!sawData && !/^(?::|event:|id:|retry:)/.test(t) && plain.length < 65536) plain += line + '\n';
      return false;
    }
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return true;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      // 单行 JSON 解析失败忽略;回调异常及上游错误不能在此吞掉。
      return false;
    }
    sawData = true;
    if (json?.error) throw classifyHttpFailure({ body: json });
    const choice = json?.choices?.[0];
    const delta = textOf(choice?.delta?.content) || textOf(choice?.message?.content) || textOf(choice?.text)
      || (json?.type === 'content_block_delta' ? textOf(json?.delta?.text) : '');
    if (textOf(choice?.delta?.reasoning_content) || textOf(choice?.delta?.reasoning)) meta.sawReasoning = true;
    const finish = finishReasonOf(json);
    if (finish) meta.finishReason = finish;
    const tokens = outputTokensOf(json);
    if (tokens !== undefined) meta.outputTokens = tokens;
    if (delta.length > 0) {
      out += delta;
      onDelta?.(out);
      signal.throwIfAborted();
    }
    return false;
  };

  const finish = (): { text: string; meta: ReplyMeta } => {
    if (!sawData && plain.trim()) {
      let data: any = null;
      try { data = JSON.parse(plain); } catch { /* 不是 JSON:当作空流处理 */ }
      if (data?.error) throw envelopeFailure(data);
      if (data) {
        const reply = parseCompletion(data);
        if (reply.text) onDelta?.(reply.text);
        return reply;
      }
    }
    return { text: out.trim(), meta };
  };

  try {
    signal.throwIfAborted();
    for (; ;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        reachedEof = true;
        // flush 解码器并消费尾行,即使上游在 EOF 前没有发送换行。
        buf += decoder.decode();
        if (buf) readLine(buf);
        return finish();
      }
      buf += decoder.decode(value, { stream: true });
      // 按行解析,保留最后一段不完整的行到下次。
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (readLine(line)) return finish();
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    if (!reachedEof) cancelReader();
    reader.releaseLock();
  }
}

/* ============ 跟随主 API(主界面当前在用的 API 设置) ============ */

/** 摘要/总结跟随主 API 时的响应上限:够装下思维链 + JSON,避免被主 API 默认 max tokens 截断。 */
const MAIN_API_RESPONSE_LENGTH = 65535;

/**
 * 是否具备「跟随主 API」的条件:ST 暴露了 generateRaw(稳定 API)即可。
 * 不再依赖连接管理/连接档——直接借用主界面当前正在用的 API。
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次补全。
 * 走 ST 的 generateRaw:只发我们给的这几条消息,不带聊天历史/角色卡;无需连接档。
 * quiet 类型内部强制非流式,返回清洗后的整段文本;失败抛 ApiError。
 *
 * ⚠️ 这条路径的请求体由 ST 构造,带不上 `tool_choice: 'none'`,第三方 fetch 拦截器
 * (如防截断脚本)仍可能改写它。摘要/重摘要尽量指派副 API 渠道,走 buildRequestBody 那条路。
 */
export async function requestViaMainApi(messages: ChatMsg[], _opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw apiFailure('config', '当前酒馆版本不支持「跟随主 API」', '请在设置 → 副 API 里给这个任务指派一个渠道。');
  }
  let content: string | undefined;
  try {
    content = (await ctx.generateRaw({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // 酒馆的 generateRaw 有时抛 Error(对象),message 只剩 [object Object];真实原因在酒馆自己的报错弹窗里。
    const raw = e instanceof Error ? e.message : parseUpstreamError(e).message;
    if (/no message generated/i.test(raw)) {
      throw apiFailure('empty', '主 API 没有返回内容', '可能被内容审核拦截或输出为空；可以重试，或在设置 → 副 API 里给这个任务单独指派渠道。');
    }
    if (/cancel|abort/i.test(raw)) throw apiFailure('unknown', '主 API 请求被中止', '正文生成被停止时会一并中止，重新发起即可。');
    throw apiFailure('upstream', '主 API 请求失败', '具体原因请看酒馆弹出的报错提示；也可以在设置 → 副 API 里给这个任务单独指派渠道。', {
      detail: raw && raw !== '[object Object]' ? sanitizeDetail(raw) : '',
    });
  }
  if (!content) throw apiFailure('empty', '主 API 返回了空内容', '可以重试，或在设置 → 副 API 里给这个任务单独指派渠道。');
  return content;
}

const TEST_PROMPT: ChatMsg[] = [{ role: 'user', content: '回复"ok"两个字符即可。' }];

/** 能连通、只是回复本身有问题时,连接测试应当报「连得上」并说明问题。 */
function testWarning(e: unknown): string {
  if (!(e instanceof ApiError)) return '';
  if (e.kind === 'truncated') return `连接正常，但测试回复被截断：${e.hint}`;
  if (e.kind === 'filtered') return '连接正常，但测试回复被服务商的内容审核拦截了。';
  if (e.kind === 'empty') return `连接正常，但${e.title}。`;
  return '';
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; warning?: boolean; message: string; detail?: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(channel, TEST_PROMPT, primaryUrl);
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `连接正常${changed ? `，地址已规范为 ${primaryUrl}` : ''}。模型回复：${reply.slice(0, 40)}`,
    };
  } catch (e) {
    const warning = testWarning(e);
    if (warning) return { ok: true, warning: true, message: warning, detail: (e as ApiError).detail };
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      const view = describeFailure(e, '测试没有完成');
      return { ok: false, message: view.message, detail: view.detail };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      const view = describeFailure(e);
      return { ok: false, message: view.message, detail: view.detail };
    }
    try {
      const reply = await requestCompletionAtUrl(channel, TEST_PROMPT, fallbackUrl);
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `连接正常，已自动改用 ${fallbackUrl}。模型回复：${reply.slice(0, 40)}`,
      };
    } catch (fallbackError) {
      const fallbackWarning = testWarning(fallbackError);
      if (fallbackWarning) {
        channel.url = fallbackUrl;
        return { ok: true, warning: true, message: `已自动改用 ${fallbackUrl}。${fallbackWarning}`, detail: (fallbackError as ApiError).detail };
      }
      // 备用地址也失败时保留首个错误,避免把模型名等真实问题掩盖成路径错误。
      const view = describeFailure(e);
      return { ok: false, message: view.message, detail: view.detail };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
  opts: Pick<RequestOptions, 'signal'> = {},
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw apiFailure('config', '酒馆上下文还没准备好', '请等页面加载完成后重试。');
  if (!channel.url) throw apiFailure('config', '请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, opts.signal, '拉取模型', async signal => {
    const resp = await fetchHost(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw classifyHttpFailure({ status: resp.status, statusText: resp.statusText, body: text });
    }

    let data: any;
    try {
      data = await resp.json();
    } catch (e) {
      if (e instanceof SyntaxError) throw invalidResponse(e.message);
      throw e;
    }
    // 酒馆的模型列表代理失败时只回 { error: true },不带状态码和原因。
    if (data?.error && !Array.isArray(data?.data)) {
      throw apiFailure('upstream', '服务商没有返回模型列表', '常见原因是地址不对、密钥无效，或这个服务不提供模型列表；可以直接手动填写模型名。', {
        detail: typeof data?.message === 'string' ? sanitizeDetail(data.message) : '',
      });
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
