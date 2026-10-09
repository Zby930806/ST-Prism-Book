/**
 * API 失败的分类与说明。
 *
 * 把状态码、酒馆代理的错误信封、上游报错正文和 finish_reason 翻译成用户能直接处理的话：
 * 先说发生了什么，再说怎么办；服务商原话只放进脱敏后的 detail，供需要时展开查看。
 */

export type ApiErrorKind =
  | 'config'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'not-found'
  | 'rate-limit'
  | 'quota'
  | 'context-length'
  | 'bad-request'
  | 'server'
  | 'filtered'
  | 'truncated'
  | 'empty'
  | 'format'
  | 'upstream'
  | 'unknown';

export interface ApiErrorInfo {
  kind?: ApiErrorKind;
  /** 一句话说明发生了什么，不含处理建议。 */
  title?: string;
  /** 用户可以怎么处理。 */
  hint?: string;
  /** 已脱敏的技术细节：状态码、finish_reason、服务商原话等。 */
  detail?: string;
  /** 回复被截断或过滤前已经收到的文本。 */
  partial?: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly title: string;
  readonly hint: string;
  readonly detail: string;
  readonly partial: string;

  constructor(message: string, readonly status?: number, info: ApiErrorInfo = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = info.kind ?? 'unknown';
    this.title = info.title ?? '';
    this.hint = info.hint ?? '';
    this.detail = info.detail ?? '';
    this.partial = info.partial ?? '';
  }
}

/** 由本模块生成的说明性错误；title/hint 都是我们自己写的，可以直接展示。 */
export function apiFailure(kind: ApiErrorKind, title: string, hint = '', extra: { status?: number; detail?: string; partial?: string } = {}): ApiError {
  return new ApiError(joinSentences(title, hint), extra.status, { kind, title, hint, detail: extra.detail, partial: extra.partial });
}

function joinSentences(...parts: string[]): string {
  return parts
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => (/[。！？!?]$/.test(p) ? p : p + '。'))
    .join('');
}

/* ============ 脱敏 ============ */

/** 服务商原话可能带密钥、带参数的地址或整页 HTML；只留能帮助判断原因的部分。 */
export function sanitizeDetail(raw: unknown, max = 200): string {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw == null) text = '';
  else {
    try { text = JSON.stringify(raw); } catch { text = String(raw); }
  }
  if (/<\s*(?:!doctype|html|head|body|script|style|div|title)\b/i.test(text)) {
    const title = text.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim();
    text = title ? `返回了一个网页：${title}` : '返回了一个网页，而不是接口数据';
  }
  text = text
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer ***')
    .replace(/\b([sarp]k)-[A-Za-z0-9*._-]{4,}/gi, '$1-***')
    .replace(/https?:\/\/[^\s"'<>，。]+/gi, url => {
      const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
      return '…' + path;
    })
    .replace(/([?&](?:key|api[_-]?key|token|access_token|auth|sig|signature)=)[^&\s"']+/gi, '$1***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/* ============ 上游报错解析 ============ */

export interface UpstreamError {
  message: string;
  code: string;
  type: string;
}

/** 兼容 OpenAI / Anthropic / Gemini / 各家中转的错误结构；解析不出时返回原文。 */
export function parseUpstreamError(body: unknown): UpstreamError {
  let value: any = body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return { message: '', code: '', type: '' };
    try { value = JSON.parse(trimmed); } catch { return { message: trimmed, code: '', type: '' }; }
  }
  if (!value || typeof value !== 'object') return { message: String(value ?? ''), code: '', type: '' };
  const err = value.error ?? value;
  const pick = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  if (typeof err === 'string') return { message: err, code: pick(value.code), type: pick(value.type) };
  const nested = Array.isArray(value.errors) ? value.errors[0] : undefined;
  const message = pick(err?.message) || pick(value.message) || pick(value.detail) || pick(value.msg)
    || pick(nested?.message) || pick(value.error_msg) || pick(err?.status);
  return { message, code: pick(err?.code) || pick(value.code), type: pick(err?.type) || pick(value.type) || pick(err?.status) };
}

const STATUS_BY_TEXT: Record<string, number> = {
  'bad request': 400, unauthorized: 401, 'payment required': 402, forbidden: 403, 'not found': 404,
  'method not allowed': 405, 'request timeout': 408, 'payload too large': 413, 'request entity too large': 413,
  'unprocessable entity': 422, 'too many requests': 429, 'internal server error': 500, 'bad gateway': 502,
  'service unavailable': 503, 'gateway timeout': 504,
};

/** 酒馆非流式代理只回传上游的 statusText；据此还原状态码。 */
export function statusFromText(text: string): number | undefined {
  return STATUS_BY_TEXT[text.trim().toLowerCase()];
}

const RE = {
  dns: /enotfound|getaddrinfo|eai_again|name not resolved|dns/i,
  refused: /econnrefused|connection refused|connect refused/i,
  tls: /certificate|cert_|self[- ]signed|ssl|tls|unable to verify/i,
  netTimeout: /etimedout|timed out|timeout|esockettimedout/i,
  network: /econnreset|socket hang up|fetch failed|failed to fetch|load failed|network|other side closed|ehostunreach|enetunreach|epipe|terminated|und_err/i,
  context: /context[_ ]?length|maximum context|context window|too many tokens|prompt is too long|input is too long|reduce the length|token limit|exceeds? (?:the )?(?:model'?s? )?(?:maximum|max)|max_prompt|超出.{0,8}(?:上下文|长度|token)|上下文.{0,6}(?:超|过长|超出)|输入.{0,4}过长/i,
  quota: /insufficient[_ ]?quota|quota|balance|credit|billing|payment|arrear|余额|额度|欠费|充值/i,
  rate: /rate[_ ]?limit|too many requests|throttl|频率|限流|并发|请求过多/i,
  auth: /invalid[_ ]?api[_ ]?key|incorrect api key|api key|unauthorized|authenticat|permission|access denied|forbidden|令牌|密钥|鉴权|未授权|无权/i,
  model: /model.{0,40}(?:not found|does not exist|not exist|unavailable|no such|not supported|invalid)|invalid model|unknown model|模型.{0,10}(?:不存在|未找到|不可用|不支持)/i,
  filtered: /content[_ ]?filter|safety|moderation|blocked|flagged|prohibited|违规|敏感|审核|内容安全|不安全/i,
  prefill: /prefill|last message|final message|must end with|ends with an assistant|assistant message prefill|role.{0,20}(?:user|last)/i,
  // 各家说法：max_tokens is too large / valid range of max_tokens is [1, 8192] / max_tokens: 100000 > 64000 / max_tokens 参数非法……
  maxOutput: /max[_ ]?(?:completion|output|new)?[_ ]?tokens?\b[\s\S]{0,100}?(?:too large|too big|too high|exceed|range|invalid|not valid|maximum|at most|should be|must be|less than|<=|≤|>|超过|超出|范围|非法|不合法|上限|过大)|(?:valid range|maximum allowed|at most)[\s\S]{0,80}?max[_ ]?(?:completion|output)?[_ ]?tokens?/i,
};

export interface HttpFailureInput {
  status?: number;
  statusText?: string;
  body?: unknown;
  /** 是否由浏览器直连上游（向量接口）；影响网络错误的说明。 */
  direct?: boolean;
  /** 酒馆代理报告的配额错误。 */
  quotaFlag?: boolean;
}

/** 把一次失败的 HTTP 响应翻译成 ApiError。 */
export function classifyHttpFailure(input: HttpFailureInput): ApiError {
  const upstream = parseUpstreamError(input.body);
  let status = input.status;
  // 酒馆为避免触发浏览器登录框，会把上游 401 改成 400，但保留原 statusText。
  const fromText = input.statusText ? statusFromText(input.statusText) : undefined;
  if (fromText && (!status || status === 400 || status === 200)) status = fromText;
  // 网关或网站首页返回的整页 HTML 里什么词都可能出现，只按状态码判断。
  const html = /<\s*(?:!doctype|html|head|body)\b/i.test(upstream.message);
  const haystack = html ? '' : [upstream.message, upstream.code, upstream.type].join(' ');
  const parts = [status ? `HTTP ${status}` : '', upstream.code && upstream.code !== String(status) ? upstream.code : '', html ? sanitizeDetail(upstream.message) : upstream.message];
  const detail = sanitizeDetail(parts.filter(Boolean).join(' · '));
  const code = status ? `（HTTP ${status}）` : '';
  const extra = { status, detail };
  if (html && (!status || status < 400)) return invalidResponse(upstream.message);

  // 酒馆连上游时抛出的网络异常会以 500/502 + 错误信封返回。
  if ((!status || status === 500 || status === 502) && (RE.dns.test(haystack) || RE.refused.test(haystack) || RE.tls.test(haystack) || (RE.network.test(haystack) && !RE.context.test(haystack)))) {
    return networkFailure(haystack, { direct: input.direct, detail });
  }
  if (input.quotaFlag || status === 402 || ((status === 429 || status === 403 || !status) && RE.quota.test(haystack))) {
    return apiFailure('quota', `账户余额或额度不足${code}`, '请到服务商后台查看余额，或换一个渠道。', extra);
  }
  if (status === 401 || status === 403) {
    return apiFailure('auth', `API 密钥无效或没有权限${code}`, '请检查密钥有没有填错或过期，以及这个密钥能否使用所选模型。', extra);
  }
  if (status === 429) {
    return apiFailure('rate-limit', `请求太频繁，被服务商限流${code}`, '等一会儿再试；批量补摘时可以分几次进行。', extra);
  }
  if ((!status || status === 400 || status === 422) && RE.maxOutput.test(haystack)) {
    return apiFailure('bad-request', `最大输出超过了这个模型的上限${code}`, '请把该 API 的「最大输出」调小到模型支持的范围；展开技术细节一般能看到服务商写的上限。', extra);
  }
  if (status === 413 || RE.context.test(haystack)) {
    return apiFailure('context-length', `发送的内容超出了模型的上下文长度${code}`, '可以换用上下文更长的模型，或减少一次发送的内容；有些接口会把最大输出也算进上下文，调小该 API 的「最大输出」也可能有用。', extra);
  }
  if ((status === 404 || status === 400 || status === 422) && RE.model.test(haystack)) {
    return apiFailure('not-found', `模型不存在，或当前密钥不能使用这个模型${code}`, '请核对模型名，可以用「拉取模型列表」选一个可用的模型。', extra);
  }
  if (status === 404) {
    return apiFailure('not-found', `接口地址不对${code}`, 'OpenAI 兼容接口的地址通常以 /v1 结尾，请检查是否多写或少写了路径。', extra);
  }
  if (status === 405) {
    return apiFailure('not-found', `这个地址不接受该请求${code}`, 'OpenAI 兼容接口的地址通常以 /v1 结尾，请检查是否多写或少写了路径。', extra);
  }
  if (RE.filtered.test(haystack) && (!status || status < 500)) {
    return apiFailure('filtered', `请求被服务商的内容审核拦截了${code}`, '可以换一个模型或渠道再试。', extra);
  }
  if ((status === 400 || status === 422) && RE.prefill.test(haystack)) {
    return apiFailure('bad-request', `这个接口不接受「预填充」消息${code}`, '请在渠道设置里关闭「发送预填充」后重试。', extra);
  }
  if (status === 400 || status === 422) {
    return apiFailure('bad-request', `服务商拒绝了这次请求${code}`, '常见原因是模型名不对、「最大输出」超过了模型的上限，或者接口不支持某个参数。可以核对模型名，调小该 API 的「最大输出」；用副 API 渠道时，还可以在渠道的「排除参数」里填上不支持的参数（例如 temperature），或关闭「发送预填充」后再试。', extra);
  }
  if (status === 408 || status === 504 || status === 524) {
    return apiFailure('timeout', `服务商处理超时${code}`, '服务商繁忙或内容过长，稍后重试或换个渠道。', extra);
  }
  if (status && status >= 500) {
    return apiFailure('server', `服务商出错${code}`, '多半是服务商临时故障或过载，稍后重试或换个渠道。', extra);
  }
  if (RE.auth.test(haystack)) {
    return apiFailure('auth', `API 密钥无效或没有权限${code}`, '请检查密钥有没有填错或过期，以及这个密钥能否使用所选模型。', extra);
  }
  if (/unknown error occurred/i.test(haystack) || (!upstream.message && !status)) {
    return apiFailure('upstream', 'API 返回了错误，但酒馆没有转发具体原因', '打开渠道的「流式传输」再试一次，通常能看到服务商的原始报错；也可以查看运行酒馆的命令行窗口。', extra);
  }
  return apiFailure('upstream', `API 返回了错误${code}`, '可以展开技术细节查看服务商的原话，按提示调整后重试。', extra);
}

/** 连不上服务器时的说明；direct=true 表示浏览器直连上游（会受跨域限制）。 */
export function networkFailure(message: string, opts: { direct?: boolean; toHost?: boolean; detail?: string } = {}): ApiError {
  const detail = opts.detail ?? sanitizeDetail(message);
  if (opts.toHost) {
    return apiFailure('network', '连不上酒馆服务器', '请确认酒馆还在运行、网页没有断线，然后重试。', { detail });
  }
  if (opts.direct) {
    return apiFailure('network', '浏览器无法访问这个地址', '可能是地址写错、网络不通，或服务商不允许网页直接访问（跨域 CORS 限制）。', { detail });
  }
  if (RE.dns.test(message)) {
    return apiFailure('network', '找不到 API 服务器（域名解析失败）', '请检查 API 地址有没有拼错；需要代理才能访问的服务，请确认运行酒馆的电脑能连上它。', { detail });
  }
  if (RE.refused.test(message)) {
    return apiFailure('network', 'API 服务器拒绝连接', '地址或端口可能不对，或者本地模型服务还没启动。', { detail });
  }
  if (RE.tls.test(message)) {
    return apiFailure('network', '连接 API 时证书校验失败', '请确认地址的 http / https 写对了；自建服务需要有效证书。', { detail });
  }
  if (RE.netTimeout.test(message)) {
    return apiFailure('network', '连接 API 服务器超时', '网络不稳或需要代理才能访问，请检查网络后重试。', { detail });
  }
  return apiFailure('network', '酒馆连不上 API 服务器', '请检查 API 地址和网络；需要代理的服务，请确认酒馆能通过代理访问。', { detail });
}

/* ============ 回复本身的问题：截断、过滤、空内容 ============ */

export type FinishKind = 'truncated' | 'filtered' | 'interrupted' | '';

/** 归一各家的结束原因（OpenAI、Gemini、Anthropic、OpenRouter、DeepSeek）。 */
export function finishKind(reason: unknown): FinishKind {
  const r = String(reason ?? '').trim().toLowerCase();
  if (!r) return '';
  if (r === 'length' || r === 'max_tokens' || r === 'max_output_tokens' || r === 'model_length' || r === 'token_limit' || r.includes('max_token')) return 'truncated';
  if (['content_filter', 'safety', 'recitation', 'prohibited_content', 'blocklist', 'spii', 'image_safety', 'refusal', 'sensitive'].includes(r)) return 'filtered';
  if (r === 'insufficient_system_resource' || r === 'error') return 'interrupted';
  return '';
}

export interface ReplyMeta {
  finishReason?: string;
  /** 服务商报告的输出 token 数（流式时常常没有）。 */
  outputTokens?: number;
  /** 本次请求的最大输出设置；被「排除参数」去掉时为 undefined。 */
  maxTokens?: number;
  /** 是否收到过思考内容（reasoning_content / reasoning）。 */
  sawReasoning?: boolean;
}

function metaDetail(meta: ReplyMeta): string {
  return [
    meta.finishReason ? `finish_reason=${sanitizeDetail(meta.finishReason, 40)}` : '',
    typeof meta.outputTokens === 'number' ? `已输出 ${meta.outputTokens} tokens` : '',
    typeof meta.maxTokens === 'number' ? `最大输出设置 ${meta.maxTokens}` : '最大输出未发送（由服务商决定）',
  ].filter(Boolean).join(' · ');
}

/** 输出达到长度上限。partial 为截断前收到的文本，调用方可以决定是否保留。 */
export function truncatedReply(meta: ReplyMeta, partial: string): ApiError {
  const limit = typeof meta.maxTokens === 'number' ? `当前最大输出是 ${meta.maxTokens} tokens，` : '';
  // 思考块没写完就到上限时，可见正文是空的。
  const visible = partial.replace(/<think(?:ing)?\b[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '').trim();
  if (!visible) {
    return apiFailure('truncated', '模型的输出额度在思考阶段就用完了，正文还没开始写',
      `${limit}请调大该 API 的「最大输出」，或把思考强度调低。`, { detail: metaDetail(meta), partial });
  }
  return apiFailure('truncated', '回复被截断：输出达到长度上限，模型没写完就停了',
    `${limit}请调大该 API 的「最大输出」；如果已经调得很大，说明服务商限制了单次输出，需要换用输出上限更高的模型。思考型模型的思考过程也算在输出里，降低思考强度也有帮助。`,
    { detail: metaDetail(meta), partial });
}

export function filteredReply(meta: ReplyMeta, partial: string): ApiError {
  return apiFailure('filtered', partial.trim() ? '回复写到一半被服务商的内容审核截断了' : '回复被服务商的内容审核拦截了',
    '可以重试，或换一个模型、渠道。', { detail: metaDetail(meta), partial });
}

export function interruptedReply(meta: ReplyMeta, partial: string): ApiError {
  return apiFailure('server', '服务商中途中断了回复', '通常是服务商资源不足或临时出错，稍后重试。', { detail: metaDetail(meta), partial });
}

export function emptyReply(meta: ReplyMeta = {}): ApiError {
  if (meta.sawReasoning) {
    return apiFailure('empty', '模型只输出了思考过程，没有给出正文', '可以重试，或换一个模型；如果开着思考强度，可以先调低。', { detail: metaDetail(meta) });
  }
  return apiFailure('empty', 'API 返回了空内容', '可能是模型拒答、被内容审核静默拦截，或接口与流式输出不兼容；可以重试，或切换渠道的「流式传输」开关。', { detail: meta.finishReason ? metaDetail(meta) : '' });
}

export function invalidResponse(detail = ''): ApiError {
  return apiFailure('format', 'API 返回的不是有效数据', '请确认地址指向接口而不是网站首页；OpenAI 兼容接口的地址通常以 /v1 结尾。', { detail: sanitizeDetail(detail) });
}

export function timeoutFailure(label: string, seconds: number): ApiError {
  return apiFailure('timeout', `${label}超时（超过 ${seconds} 秒）`, '可以在该 API 的设置里调大超时；经常超时多半是服务商繁忙或网络不稳。');
}

/* ============ 展示 ============ */

export interface FailureView {
  kind: ApiErrorKind;
  title: string;
  hint: string;
  detail: string;
  /** title + hint 合成的一段话，适合只能显示一行文字的地方。 */
  message: string;
}

/**
 * 统一读取任意异常的展示信息。
 * 只有本模块生成的 ApiError 会原样展示；其它异常可能含有密钥或上游原文，只给通用说明。
 * settingsPath 是该 API 在界面上的位置（如「札记 → 独立 API 设置」），用来把「该 API 的设置」说具体。
 */
export function describeFailure(error: unknown, fallbackTitle = '请求没有完成', settingsPath = ''): FailureView {
  const localize = (text: string) => !settingsPath ? text : text
    .replace(/该 API 的设置|对应的 API 设置/g, `「${settingsPath}」`)
    .replace(/该 API 的/g, `「${settingsPath}」里的`);
  const view = (kind: ApiErrorKind, title: string, hint: string, detail: string): FailureView => {
    const localHint = localize(hint);
    return { kind, title, hint: localHint, detail, message: joinSentences(title, localHint) };
  };
  if (error instanceof ApiError && error.title) return view(error.kind, error.title, error.hint, error.detail);
  if (error instanceof ApiError && error.status) {
    const generic = classifyHttpFailure({ status: error.status });
    return view(generic.kind, generic.title, generic.hint, `HTTP ${error.status}`);
  }
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
    const net = networkFailure(error.message, { toHost: true });
    return view(net.kind, net.title, net.hint, '');
  }
  return view('unknown', fallbackTitle, '', '');
}

/** 给失败加上发生位置（如「楼层 #12 摘要未完成」）和设置入口，保留原有分类与细节。 */
export function withContext(error: unknown, prefix: string, settingsPath = ''): unknown {
  if (!(error instanceof ApiError) || !error.title) return error;
  const view = describeFailure(error, '', settingsPath);
  return apiFailure(error.kind, `${prefix}：${view.title}`, view.hint, { status: error.status, detail: error.detail, partial: error.partial });
}

/** 重试也不会成功的失败：配置、密钥、额度、地址、上下文、参数，以及达到输出上限。 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return !['config', 'auth', 'quota', 'not-found', 'context-length', 'bad-request', 'truncated'].includes(error.kind);
}

/** 截断/过滤类错误里保留的半截回复。 */
export function partialReply(error: unknown): string {
  return error instanceof ApiError && (error.kind === 'truncated' || error.kind === 'filtered' || error.kind === 'server') ? error.partial : '';
}

/** 回复看起来是写到一半的 JSON（花括号或字符串没闭合）。用于无法拿到 finish_reason 的主 API。 */
export function looksLikeUnfinishedJson(raw: string): boolean {
  return jsonState(raw) === 'open';
}

/** 回复里至少有一个完整闭合的 JSON 对象（截断发生在 JSON 之后时，结果仍可使用）。 */
export function containsCompleteJson(raw: string): boolean {
  return jsonState(raw) === 'closed';
}

function jsonState(raw: string): 'none' | 'open' | 'closed' {
  let text = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  // 思考块还没写完就结束了。
  if (/^\s*<think(?:ing)?\b/i.test(text)) return 'open';
  // 预填充场景下回复从思考正文续写，只有结尾标签；之前的内容都是思考。
  const lower = text.toLowerCase();
  const close = Math.max(lower.lastIndexOf('</think>'), lower.lastIndexOf('</thinking>'));
  if (close >= 0) text = text.slice(close).replace(/^<\/think(?:ing)?>/i, '');
  const start = text.indexOf('{');
  if (start < 0) return 'none';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return 'closed';
    }
  }
  return depth > 0 || inString ? 'open' : 'none';
}
