/**
 * OpenAI 兼容接口地址的规整与比较。
 * 发请求（client.ts）和导入设置备份时判断「地址是否还是同一个服务器」（settingsBackup.ts）用同一套规则。
 */

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留,避免破坏 /v2/coding 等自定义路由。
 */
export function normalizeApiUrl(url: string): string {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 地址的协议、主机和端口（小写）；解析不了时返回规整后的整串，空地址返回空串。 */
export function urlOrigin(url: string): string {
  const u = normalizeApiUrl(url);
  if (!u) return '';
  try {
    return new URL(u).origin.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** 两个地址是否指向同一个服务器（协议、主机、端口相同；路径不同不算换了服务器）。两个都为空时视为相同。 */
export function sameOrigin(a: string, b: string): boolean {
  return urlOrigin(a) === urlOrigin(b);
}

/** 给用户看的地址：规整后去掉查询参数和锚点（其中可能带令牌）；空地址写「（空）」。 */
export function displayUrl(url: string): string {
  const u = normalizeApiUrl(url).replace(/[?#].*$/, '');
  return u || '（空）';
}
