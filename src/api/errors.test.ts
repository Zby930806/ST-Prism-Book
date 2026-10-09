import { describe, expect, it } from 'vitest';
import {
  ApiError, classifyHttpFailure, containsCompleteJson, describeFailure, finishKind, isRetryable,
  looksLikeUnfinishedJson, sanitizeDetail, truncatedReply, withContext,
} from './errors';

describe('上游报错分类', () => {
  it.each([
    [401, '', 'auth', 'API 密钥无效或没有权限（HTTP 401）'],
    [403, '', 'auth', 'API 密钥无效或没有权限（HTTP 403）'],
    [402, '', 'quota', '账户余额或额度不足（HTTP 402）'],
    [429, '', 'rate-limit', '请求太频繁，被服务商限流（HTTP 429）'],
    [429, '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}', 'quota', '账户余额或额度不足（HTTP 429）'],
    [404, '', 'not-found', '接口地址不对（HTTP 404）'],
    [404, '{"error":{"message":"The model `gpt-9` does not exist"}}', 'not-found', '模型不存在，或当前密钥不能使用这个模型（HTTP 404）'],
    [405, '', 'not-found', '这个地址不接受该请求（HTTP 405）'],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens.","code":"context_length_exceeded"}}', 'context-length', '发送的内容超出了模型的上下文长度（HTTP 400）'],
    [413, '', 'context-length', '发送的内容超出了模型的上下文长度（HTTP 413）'],
    [400, '{"error":{"message":"Assistant message prefill is not supported; the final message must be from the user"}}', 'bad-request', '这个接口不接受「预填充」消息（HTTP 400）'],
    [400, '{"error":{"message":"Unsupported parameter: temperature"}}', 'bad-request', '服务商拒绝了这次请求（HTTP 400）'],
    [400, '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead."}}', 'bad-request', '服务商拒绝了这次请求（HTTP 400）'],
    [400, '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]","type":"invalid_request_error"}}', 'bad-request', '最大输出超过了这个模型的上限（HTTP 400）'],
    [400, '{"error":{"message":"max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000."}}', 'bad-request', '最大输出超过了这个模型的上限（HTTP 400）'],
    [400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet"}}', 'bad-request', '最大输出超过了这个模型的上限（HTTP 400）'],
    [400, '{"error":{"message":"max_tokens 参数超过上限"}}', 'bad-request', '最大输出超过了这个模型的上限（HTTP 400）'],
    [503, '', 'server', '服务商出错（HTTP 503）'],
    [504, '', 'timeout', '服务商处理超时（HTTP 504）'],
  ] as const)('HTTP %s %s → %s', (status, body, kind, title) => {
    const error = classifyHttpFailure({ status, body });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind, title, status });
    expect(error.hint).not.toBe('');
    expect(error.message.startsWith(title + '。')).toBe(true);
  });

  it('最大输出超上限时指向对应的设置，不重试', () => {
    const error = classifyHttpFailure({ status: 400, body: '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"}}' });
    expect(describeFailure(error, '', '札记 → 独立 API 设置').hint).toContain('「札记 → 独立 API 设置」里的「最大输出」');
    expect(error.detail).toContain('[1, 8192]');
    expect(isRetryable(error)).toBe(false);
    expect(classifyHttpFailure({ status: 400 }).hint).toContain('「最大输出」');
  });

  it('酒馆流式代理把 401 改成 400 时按 statusText 还原', () => {
    expect(classifyHttpFailure({ status: 400, statusText: 'Unauthorized', body: '{}' })).toMatchObject({ kind: 'auth', status: 401 });
  });

  it('酒馆非流式错误信封只带 statusText 与配额标记', () => {
    expect(classifyHttpFailure({ status: 404, body: { error: { message: 'Not Found' } } })).toMatchObject({ kind: 'not-found' });
    expect(classifyHttpFailure({ body: { error: { message: 'Too Many Requests' } }, quotaFlag: true })).toMatchObject({ kind: 'quota' });
    expect(classifyHttpFailure({ body: { error: { message: 'Unknown error occurred' } } }))
      .toMatchObject({ kind: 'upstream', title: 'API 返回了错误，但酒馆没有转发具体原因' });
    expect(classifyHttpFailure({ body: { error: true } }).hint).toContain('流式传输');
  });

  it.each([
    ['request to https://api.bad.invalid/v1/chat/completions failed, reason: getaddrinfo ENOTFOUND api.bad.invalid', 'ENOTFOUND', '找不到 API 服务器（域名解析失败）'],
    ['connect ECONNREFUSED 127.0.0.1:5000', 'ECONNREFUSED', 'API 服务器拒绝连接'],
    ['unable to verify the first certificate', '', '连接 API 时证书校验失败'],
    ['socket hang up', 'ECONNRESET', '酒馆连不上 API 服务器'],
  ])('酒馆连上游失败（502 + 网络异常）：%s', (message, code, title) => {
    const error = classifyHttpFailure({ status: 502, body: JSON.stringify({ error: { message, code } }) });
    expect(error).toMatchObject({ kind: 'network', title });
    expect(error.detail).not.toContain('https://api.bad.invalid');
  });

  it('网关返回整页 HTML 时只按状态码判断，200 视为地址指向了网页', () => {
    const page = '<!DOCTYPE html><html><head><title>Bad gateway</title></head><body>network error at upstream</body></html>';
    expect(classifyHttpFailure({ status: 502, body: page })).toMatchObject({ kind: 'server' });
    expect(classifyHttpFailure({ status: 200, body: page })).toMatchObject({ kind: 'format' });
    expect(classifyHttpFailure({ status: 502, body: page }).detail).toBe('HTTP 502 · 返回了一个网页：Bad gateway');
  });

  it('浏览器直连（向量接口）的网络错误提示跨域', () => {
    const error = classifyHttpFailure({ status: 0, body: 'Failed to fetch', direct: true });
    expect(error.kind).toBe('network');
    expect(error.hint).toContain('CORS');
  });
});

describe('脱敏与结束原因', () => {
  it('去掉密钥、带参数的地址和长令牌，保留路径和原因', () => {
    const text = sanitizeDetail('Incorrect API key provided: sk-proj-abcdEFGH12345678. Bearer abc.def.ghi at https://relay.private.example/v1/chat?key=SECRET1234 token=' + 'x'.repeat(40));
    expect(text).not.toMatch(/abcdEFGH|abc\.def|relay\.private|SECRET1234|x{40}/);
    expect(text).toContain('sk-***');
    expect(text).toContain('…/v1/chat');
    expect(sanitizeDetail('字'.repeat(300)).length).toBeLessThanOrEqual(201);
  });

  it.each([
    ['length', 'truncated'], ['max_tokens', 'truncated'], ['MAX_TOKENS', 'truncated'],
    ['content_filter', 'filtered'], ['SAFETY', 'filtered'], ['refusal', 'filtered'],
    ['insufficient_system_resource', 'interrupted'], ['stop', ''], [undefined, ''], ['end_turn', ''],
  ] as const)('finish_reason=%s → %s', (reason, kind) => {
    expect(finishKind(reason)).toBe(kind);
  });

  it('截断说明带上最大输出设置；只剩思考时换成思考占满额度的说明', () => {
    const cut = truncatedReply({ finishReason: 'length', maxTokens: 3000, outputTokens: 3000 }, '{"summary":"写到一半');
    expect(cut).toMatchObject({ kind: 'truncated', partial: '{"summary":"写到一半' });
    expect(cut.hint).toContain('当前最大输出是 3000 tokens');
    expect(cut.detail).toBe('finish_reason=length · 已输出 3000 tokens · 最大输出设置 3000');
    expect(truncatedReply({ finishReason: 'length' }, '<think>还在推理').title).toContain('思考阶段');
    expect(truncatedReply({ finishReason: 'length' }, 'x').detail).toContain('最大输出未发送');
  });
});

describe('半截 JSON 判断', () => {
  it.each([
    ['{"summary":"完整"}', false, true],
    ['<thinking>先想想 {</thinking>\n{"summary":"完整"}', false, true],
    ['推理过程</thinking>{"summary":"完整"} 之后多写的说明', false, true],
    ['{"summary":"写到一半', true, false],
    ['{"summary":"含有 } 的字符串", "items":{"add":[', true, false],
    ['<thinking>还没想完', true, false],
    ['抱歉，我不能处理这个请求。', false, false],
    ['', false, false],
  ])('%s', (raw, unfinished, complete) => {
    expect(looksLikeUnfinishedJson(raw)).toBe(unfinished);
    expect(containsCompleteJson(raw)).toBe(complete);
  });
});

describe('展示与重试策略', () => {
  it('只有本模块生成的说明会原样展示，其它异常不回显原文', () => {
    expect(describeFailure(new Error('upstream sk-secret private body'), '请求没有完成')).toMatchObject({ kind: 'unknown', message: '请求没有完成。', detail: '' });
    expect(describeFailure(new ApiError('raw upstream text sk-secret', 401))).toMatchObject({ kind: 'auth', detail: 'HTTP 401' });
    expect(describeFailure(new ApiError('raw upstream text sk-secret', 401)).message).not.toContain('sk-secret');
    expect(describeFailure(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'network', title: '连不上酒馆服务器' });
  });

  it('把「该 API 的设置」换成具体位置', () => {
    const view = describeFailure(truncatedReply({ finishReason: 'length', maxTokens: 3000 }, 'x'), '', '札记 → 独立 API 设置');
    expect(view.hint).toContain('请调大「札记 → 独立 API 设置」里的「最大输出」');
    expect(view.message).not.toContain('该 API');
  });

  it('加上发生位置时保留分类、细节和半截回复', () => {
    const wrapped = withContext(truncatedReply({ finishReason: 'length', maxTokens: 10 }, '半截'), '楼层 #7 摘要未完成', '设置 → 副 API → 渠道「A」') as ApiError;
    expect(wrapped).toMatchObject({ kind: 'truncated', partial: '半截' });
    expect(wrapped.title.startsWith('楼层 #7 摘要未完成：')).toBe(true);
    expect(wrapped.hint).toContain('渠道「A」');
    const plain = new Error('普通异常');
    expect(withContext(plain, '前缀')).toBe(plain);
  });

  it('密钥、地址、额度、上下文、参数和截断不重试；网络、限流、服务端错误可重试', () => {
    for (const status of [401, 402, 404, 400, 413]) expect(isRetryable(classifyHttpFailure({ status }))).toBe(false);
    expect(isRetryable(truncatedReply({ finishReason: 'length' }, 'x'))).toBe(false);
    for (const status of [429, 500, 502, 503, 504]) expect(isRetryable(classifyHttpFailure({ status }))).toBe(true);
    expect(isRetryable(new Error('模型输出格式不对'))).toBe(true);
  });
});
