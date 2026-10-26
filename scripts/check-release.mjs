import { readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { diffPromptExports, extractUpdateNotice, findStaleSources, listSome } from './release-checks.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFile(path.join(root, p), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const manifest = JSON.parse(await read('manifest.json'));
assert.equal(pkg.name, 'st-prism-book');
assert.equal(pkg.private, true);
assert.equal(manifest.display_name, '棱镜宝书');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.js, 'dist/index.js?ver=' + encodeURIComponent(pkg.version));
assert.equal(manifest.auto_update, true);
assert.equal(manifest.generate_interceptor, 'bbs_generateInterceptor');
assert.equal(manifest.homePage, undefined);
const built = await read('dist/index.js');
const map = JSON.parse(await read('dist/index.js.map'));
assert(Array.isArray(map.sources) && map.sources.length > 0, '构建source map无效');
assert(map.sources.every(p => p.startsWith('../src/') || p.startsWith('node_modules/')), 'source map含外部构建目录');
assert(Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length, 'source map 缺少 sourcesContent，无法核对 dist 是否由当前源码构建');
/** 构建和提示词导出是否最新：问题先收集，最后一起列出，一次就能看到要补做哪几步。 */
const problems = [];
// dist 是否由当前源码构建：source map 记下了构建时每个源文件的内容，逐个与现在的文件比较。
const stale = await findStaleSources(map, source => readFile(path.join(root, 'dist', source), 'utf8').catch(() => null));
if (stale.length) problems.push('源码在构建后有改动，请先 pnpm build。共 ' + stale.length + ' 个文件：' + listSome(stale));
if (!built.includes(pkg.version)) problems.push('构建版本不一致：dist/index.js 中没有版本号 ' + pkg.version + '，请先 pnpm build');
assert(built.includes('棱镜宝书'), '构建品牌缺失');
// 更新说明从源码取字面量再核对是否进了构建产物，改了措辞不必同步修改本脚本。
const updateNotice = extractUpdateNotice(await read('src/memory/update.ts'));
assert(updateNotice, '找不到 src/memory/update.ts 中 INTERNAL_UPDATE_NOTICE 的字符串字面量');
if (!built.includes(updateNotice)) problems.push('更新保护说明未构建：dist/index.js 中没有当前的 INTERNAL_UPDATE_NOTICE，请先 pnpm build');
for (const p of ['src/memory/update.ts', 'dist/index.js']) {
  const text = await read(p);
  assert(!text.includes('raw.githubusercontent.com/baibai-git'), '仍有上游更新端点：' + p);
}
assert((await read('dist/index.css')).length > 0);
for (const p of ['README.md', 'NOTICE.md', 'THIRD-PARTY-NOTICES.txt', 'docs/INTERNAL-RELEASE.md']) assert((await read(p)).length > 0, p);
const dirs = new Set(['src', 'scripts', 'dist', 'docs', 'assets']);
const files = new Set(['.gitignore', 'CHANGELOG.md', 'FAQ.md', 'NOTICE.md', 'PUBLIC_API.md', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'manifest.json', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts']);
const skip = new Set(['.git', 'node_modules']);
const paths = [];
async function walk(rel = '') {
  for (const entry of await readdir(path.join(root, rel), {withFileTypes: true})) {
    if (!rel && skip.has(entry.name)) continue;
    const p = rel ? rel + '/' + entry.name : entry.name;
    const st = await lstat(path.join(root, p));
    assert(!st.isSymbolicLink(), '发行内容不允许链接：' + p);
    if (!rel) assert(st.isDirectory() ? dirs.has(entry.name) : files.has(entry.name), '根目录存在未审核文件：' + p);
    assert(!/(^|\/)(?:\.env(?:\..*)?|settings\.json|secrets\.json|credentials\.json|chats|backups|node_modules|\.git|verification[^/]*)$|\.(?:pem|key|pfx|p12|zip)$/i.test(p), '禁止发行路径：' + p);
    if (st.isDirectory()) await walk(p); else paths.push(p);
  }
}
await walk();
const checks = [
  ['本机用户路径', /[A-Z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/[A-Za-z0-9_-]+\//i],
  ['私钥内容', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub令牌', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['疑似API密钥', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
];
for (const p of paths) {
  if (!/\.(?:ts|vue|js|mjs|json|map|md|txt|yaml|css)$/.test(p) && p !== '.gitignore') continue;
  const text = await read(p);
  for (const [kind, pattern] of checks) assert(!pattern.test(text), kind + '（只报告位置，不输出内容）：' + p);
}
const PROMPT_EXPORT_COUNT = 17;
const promptFiles = paths.filter(p => /^docs\/prompts\/.*\.txt$/.test(p));
if (promptFiles.length !== PROMPT_EXPORT_COUNT) problems.push('提示词导出必须包含 ' + PROMPT_EXPORT_COUNT + ' 份 txt，现有 ' + promptFiles.length + ' 份，请先 pnpm export:prompts');
// 提示词导出是否与当前源码一致：导出到临时目录，再与 docs/prompts 逐字比较（统一换行后）。
const exportDir = await mkdtemp(path.join(os.tmpdir(), 'prism-prompts-'));
try {
  let exported = true;
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'export-prompts.mjs'), exportDir], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    exported = false;
    problems.push('提示词导出失败，无法核对 docs/prompts：' + String(error?.stderr || error?.message || error).trim().slice(0, 800));
  }
  if (exported) {
    const load = async dir => new Map(await Promise.all((await readdir(dir)).map(async name => [name, await readFile(path.join(dir, name), 'utf8')])));
    const outdated = diffPromptExports(await load(exportDir), await load(path.join(root, 'docs', 'prompts')));
    if (outdated.length) problems.push('提示词导出与当前源码不一致，请先 pnpm export:prompts：' + listSome(outdated));
  }
} finally {
  await rm(exportDir, { recursive: true, force: true });
}
if (problems.length) {
  console.error('发布检查未通过：\n' + problems.map(p => '- ' + p).join('\n'));
  process.exit(1);
}
console.log('发布检查通过：' + paths.length + '个受控文件；版本=' + pkg.version);
console.log('说明：启发式敏感信息检查不等于全面秘密扫描；真实酒馆UI和模型语义需人工验收。');
