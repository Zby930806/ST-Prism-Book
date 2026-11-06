import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceUrl = new URL('../src/memory/vector/depth.ts', import.meta.url);
const sourcePath = fileURLToPath(sourceUrl);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    strict: true,
  },
});

const compileErrors = (transpiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
if (compileErrors.length) {
  const host = {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };
  throw new Error(ts.formatDiagnosticsWithColorAndContext(compileErrors, host));
}

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
const { DEFAULT_RECALL_INJECTION_DEPTH, normalizeRecallInjectionDepth } = await import(moduleUrl);

assert.equal(DEFAULT_RECALL_INJECTION_DEPTH, 0);

const cases = [
  [0, 0],
  [1, 1],
  [9999, 9999],
  [3.9, 3],
  [-1, 0],
  [Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0],
  [null, 0],
  [undefined, 0],
  ['', 0],
  ['4', 0],
];
for (const [input, expected] of cases) {
  assert.equal(normalizeRecallInjectionDepth(input), expected, `depth normalization failed: ${String(input)}`);
}

console.log(`vector depth tests passed: ${cases.length + 1} assertions`);
