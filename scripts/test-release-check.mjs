/** 发布检查比较规则的测试（scripts/release-checks.mjs）。运行：node scripts/test-release-check.mjs */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffPromptExports, extractUpdateNotice, findStaleSources, listSome, normalizeEol } from './release-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    console.error('未通过：' + name);
    throw error;
  }
}

await test('统一换行后比较', () => {
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(normalizeEol('a\nb'), 'a\nb');
});

await test('名单过长时只列前几项', () => {
  assert.equal(listSome(['a', 'b']), 'a、b');
  assert.equal(listSome(['a', 'b', 'c'], 2), 'a、b 等');
});

await test('源文件与构建时一致（含只差换行）时不报告', async () => {
  const map = { sources: ['../src/a.ts', '../src/b.vue', 'node_modules/x/index.js'], sourcesContent: ['const a = 1;\n', '<template></template>\n', 'lib'] };
  const files = { '../src/a.ts': 'const a = 1;\r\n', '../src/b.vue': '<template></template>\n' };
  assert.deepEqual(await findStaleSources(map, s => files[s] ?? null), []);
});

await test('构建后改动或删除的源文件都报告，依赖库不核对', async () => {
  const map = { sources: ['../src/a.ts', '../src/gone.ts', 'node_modules/x/index.js'], sourcesContent: ['const a = 1;\n', 'x', 'lib'] };
  const files = { '../src/a.ts': 'const a = 2;\n', 'node_modules/x/index.js': 'changed' };
  assert.deepEqual(await findStaleSources(map, s => files[s] ?? null), ['src/a.ts', 'src/gone.ts（已删除）']);
});

await test('取出更新说明的字面量', () => {
  assert.equal(extractUpdateNotice("export const INTERNAL_UPDATE_NOTICE = '在「管理扩展」里更新。';\nexport const x = 1;"), '在「管理扩展」里更新。');
  assert.equal(extractUpdateNotice('export const INTERNAL_UPDATE_NOTICE = `模板`;'), '');
});

await test('当前源码里的更新说明能取出', async () => {
  const notice = extractUpdateNotice(await readFile(path.join(root, 'src/memory/update.ts'), 'utf8'));
  assert.ok(notice.includes('插件自己不检查更新'), notice);
});

await test('提示词导出一致（含只差换行）时不报告', () => {
  const fresh = new Map([['01.txt', 'a\n'], ['00-说明.md', '说明\n']]);
  const saved = new Map([['01.txt', 'a\r\n'], ['00-说明.md', '说明\n']]);
  assert.deepEqual(diffPromptExports(fresh, saved), []);
});

await test('提示词导出内容不同、缺少或多出的文件都报告', () => {
  const fresh = new Map([['01.txt', 'new\n'], ['13.txt', 'x\n']]);
  const saved = new Map([['01.txt', 'old\n'], ['99.txt', 'x\n']]);
  assert.deepEqual(diffPromptExports(fresh, saved), ['01.txt', '13.txt（尚未导出）', '99.txt（源码已不导出）']);
});

console.log('发布检查规则测试通过：' + passed + ' 项');
