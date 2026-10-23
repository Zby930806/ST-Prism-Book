/** 发布检查中与「构建、提示词导出是否最新」有关的比较规则，供 check-release.mjs 使用，测试见 test-release-check.mjs。 */

/** 比较前统一换行：仓库在不同系统上检出时可能是 CRLF。 */
export const normalizeEol = text => String(text).replace(/\r\n/g, '\n');

/** 名单过长时只列前几项。 */
export const listSome = (names, n = 10) => names.slice(0, n).join('、') + (names.length > n ? ' 等' : '');

/**
 * 找出构建后又改动过的源文件：source map 记下了构建时每个源文件的内容（sourcesContent），逐个与现在的文件比较。
 * 只核对 ../src/ 下的文件；readCurrent(source) 返回现在的内容，文件已删除时返回 null。
 */
export async function findStaleSources(map, readCurrent) {
  const stale = [];
  for (const [i, source] of map.sources.entries()) {
    if (!source.startsWith('../src/')) continue;
    const current = await readCurrent(source);
    const name = source.slice(3);
    if (current === null || current === undefined) stale.push(name + '（已删除）');
    else if (normalizeEol(current) !== normalizeEol(map.sourcesContent?.[i] ?? '')) stale.push(name);
  }
  return stale;
}

/** 从 src/memory/update.ts 的源码中取出 INTERNAL_UPDATE_NOTICE 的字符串字面量；写法不是单引号字面量时返回空串。 */
export function extractUpdateNotice(source) {
  return /export const INTERNAL_UPDATE_NOTICE\s*=\s*'([^'\\\n]+)'/.exec(source)?.[1] ?? '';
}

/**
 * 比较新导出的提示词与仓库里保存的导出：fresh、saved 都是「文件名 → 内容」的 Map。
 * 返回不一致的文件名，注明源码已不导出或尚未导出的情况。
 */
export function diffPromptExports(fresh, saved) {
  const outdated = [];
  for (const name of [...new Set([...fresh.keys(), ...saved.keys()])].sort()) {
    if (!fresh.has(name)) outdated.push(name + '（源码已不导出）');
    else if (!saved.has(name)) outdated.push(name + '（尚未导出）');
    else if (normalizeEol(fresh.get(name)) !== normalizeEol(saved.get(name))) outdated.push(name);
  }
  return outdated;
}
