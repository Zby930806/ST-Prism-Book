import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFile(path.join(root, p), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const manifest = JSON.parse(await read('manifest.json'));
assert.equal(pkg.name, 'st-prism-book');
assert.equal(pkg.private, true);
assert.equal(manifest.display_name, '棱镜宝书');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.js, 'dist/index.js?ver=' + encodeURIComponent(pkg.version));
assert.equal(manifest.auto_update, false);
assert.equal(manifest.generate_interceptor, 'bbs_generateInterceptor');
assert.equal(manifest.homePage, undefined);
const built = await read('dist/index.js');
assert(built.includes(pkg.version), '构建版本不一致');
assert(built.includes('棱镜宝书'), '构建品牌缺失');
assert(built.includes('内部版采用手动更新'), '内部更新保护未构建');
for (const p of ['src/memory/update.ts', 'dist/index.js']) {
  const text = await read(p);
  assert(!text.includes('raw.githubusercontent.com/baibai-git'), '仍有上游更新端点：' + p);
}
const map = JSON.parse(await read('dist/index.js.map'));
assert(Array.isArray(map.sources) && map.sources.length > 0, '构建source map无效');
assert(map.sources.every(p => p.startsWith('../src/') || p.startsWith('node_modules/')), 'source map含外部构建目录');
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
assert.equal(paths.filter(p => /^docs\/prompts\/.*\.txt$/.test(p)).length, 9, '提示词导出必须包含9份txt');
console.log('发布检查通过：' + paths.length + '个受控文件；版本=' + pkg.version);
console.log('说明：启发式敏感信息检查不等于全面秘密扫描；真实酒馆UI和模型语义需人工验收。');
