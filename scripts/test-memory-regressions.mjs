import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

async function importStandalone(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const sourcePath = fileURLToPath(sourceUrl);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
      verbatimModuleSyntax: true,
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
  // 纯模块增加了共享 helper 后,相对 import 也必须转成可解析的 data URL。
  let output = transpiled.outputText;
  for (const dep of ts.preProcessFile(output).importedFiles) {
    if (!dep.fileName.startsWith('.')) throw new Error('Standalone test only accepts relative pure modules');
    const depUrl = new URL(dep.fileName + (dep.fileName.endsWith('.ts') ? '' : '.ts'), sourceUrl);
    const depSource = await readFile(depUrl, 'utf8');
    const depJs = ts.transpileModule(depSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    if (ts.preProcessFile(depJs).importedFiles.length) throw new Error('Nested runtime import needs a Vitest integration test');
    const encoded = 'data:text/javascript;base64,' + Buffer.from(depJs).toString('base64');
    output = output.replaceAll("'" + dep.fileName + "'", "'" + encoded + "'").replaceAll('"' + dep.fileName + '"', '"' + encoded + '"');
  }
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(output).toString('base64');
  return import(moduleUrl);
}

let assertions = 0;
function equal(actual, expected, message) {
  assertions++;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions++;
  assert.deepEqual(actual, expected, message);
}
function includes(text, expected, message) {
  assertions++;
  assert.ok(text.includes(expected), message ?? `缺少文本: ${expected}`);
}
function occurrence(text, needle, expected, message) {
  const count = text.split(needle).length - 1;
  equal(count, expected, message ?? `${JSON.stringify(needle)} 出现次数错误`);
}

const { mergeProtagonistDelta } = await importStandalone('../src/memory/protagonist.ts');
const { mergeLifeDetailsOp } = await importStandalone('../src/memory/lifeDetails.ts');
const { stripBaiBaiImageTags } = await importStandalone('../src/memory/imageTag.ts');

equal(
  stripBaiBaiImageTags('第一行\n<bbi_image>tag<size>portrait</size></bbi_image>\n第二行'),
  '第一行\n第二行',
  '柏宝绘独占行标签应连同前置 LF 删除',
);
equal(
  stripBaiBaiImageTags('第一行\r\n<bbi_image>tag\r\n<nl>scene</nl></bbi_image>\r\n第二行'),
  '第一行\r\n第二行',
  '柏宝绘跨行标签应兼容 CRLF',
);
equal(
  stripBaiBaiImageTags('第一行\n<bbi_image>a</bbi_image>\n<bbi_image>b</bbi_image>\n第二行'),
  '第一行\n第二行',
  '同一位置连续多个柏宝绘标签不应留下空行',
);
equal(
  stripBaiBaiImageTags('前文<bbi_image>tag</bbi_image>后文'),
  '前文后文',
  '手写行内柏宝绘标签只删除标签本身',
);

// 年龄没有参与补丁时，绝不能误删已有锚点。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1', identity: '学生' }, { identity: '教师' }),
  { age: '18', ageTime: '2020/1/1', identity: '教师' },
  '编辑非年龄字段不应改变年龄锚点',
);

// 用户修改年龄而未显式给新锚点：必须删除旧锚点，交给当前叶子重新建立。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '25' }),
  { age: '25' },
  '修改年龄后旧锚点不应残留',
);

// UI 在年龄未变化时会显式带回原锚点，必须原样保留。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '18', ageTime: '2020/1/1' }),
  { age: '18', ageTime: '2020/1/1' },
  '未修改年龄时应保留原锚点',
);

// carryover/导入等调用方显式给了新锚点时，以新锚点为准。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '20', ageTime: '2022/1/1' }),
  { age: '20', ageTime: '2022/1/1' },
  '显式新锚点不应被删除',
);

// 清空年龄必须连旧锚点一起移除；随后再次填写也不能复活旧锚点。
const cleared = mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '' });
deepEqual(cleared, { age: '' }, '清空年龄时应删除锚点');
deepEqual(mergeProtagonistDelta(cleared, { age: '30' }), { age: '30' }, '清空后重新填写不应复活旧锚点');

// 同一叶子连续多次修改时，只保留最终年龄，且没有任何历史锚点泄漏。
const firstEdit = mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1', outfit: '校服' }, { age: '24' });
const secondEdit = mergeProtagonistDelta(firstEdit, { age: '25' });
deepEqual(secondEdit, { age: '25', outfit: '校服' }, '同叶子反复编辑年龄应保持 last-write-wins');

// 合并函数不能改写传入对象，否则 Vue 当前状态或叶子克隆可能被意外污染。
const original = { age: '18', ageTime: '2020/1/1' };
mergeProtagonistDelta(original, { age: '25' });
deepEqual(original, { age: '18', ageTime: '2020/1/1' }, '合并不应修改原对象');

// 生活小档案手动操作必须真正合并进叶子 delta；同一叶子连续新增不能覆盖。
const lifeTarget = {};
equal(
  mergeLifeDetailsOp(lifeTarget, { add: [{ text: '不吃香菜' }] }),
  true,
  '生活小档案新增应报告已写入',
);
mergeLifeDetailsOp(lifeTarget, { add: [{ text: '习惯早睡' }] });
deepEqual(
  lifeTarget.lifeDetails.add.map(d => d.text),
  ['不吃香菜', '习惯早睡'],
  '同一叶子连续新增应保留全部条目及其 add 序号',
);

// 同一条反复编辑按字段 last-write-wins，并保留空数组/空字符串这些显式清除值。
mergeLifeDetailsOp(lifeTarget, {
  update: [{ id: 'detail:leaf#0', text: '不吃葱', topics: ['饮食'], until: '明天' }],
});
mergeLifeDetailsOp(lifeTarget, {
  update: [{ id: 'detail:leaf#0', anchors: [], until: '', tier: 'pinned' }],
});
deepEqual(
  lifeTarget.lifeDetails.update,
  [{
    id: 'detail:leaf#0',
    text: '不吃葱',
    topics: ['饮食'],
    anchors: [],
    until: '',
    tier: 'pinned',
  }],
  '连续编辑应合并为最终补丁且允许清除标签/时效',
);

// 手动恢复/置顶必须取消同叶里 AI 较早写入的 archive，否则固定重放顺序会再次把它沉降。
const archivedLifeTarget = {
  lifeDetails: { archive: ['detail:old#0', 'detail:other#0'] },
};
mergeLifeDetailsOp(archivedLifeTarget, {
  update: [{ id: 'detail:old#0', tier: 'active' }],
});
deepEqual(
  archivedLifeTarget.lifeDetails.archive,
  ['detail:other#0'],
  '手动层级切换应覆盖同叶较早的 archive 指令',
);

// 删除只登记稳定 id，不能裁剪 add 数组导致后续条目的序号和 id 漂移；重复删除需去重。
mergeLifeDetailsOp(lifeTarget, { remove: ['detail:leaf#0'] });
mergeLifeDetailsOp(lifeTarget, { remove: ['detail:leaf#0'] });
equal(lifeTarget.lifeDetails.add.length, 2, '删除不得裁剪依赖序号生成稳定 id 的 add 数组');
deepEqual(lifeTarget.lifeDetails.remove, ['detail:leaf#0'], '重复删除应去重');
equal(mergeLifeDetailsOp({}, {}), false, '空生活小档案操作不应伪报成功');

// 同叶新增→删除→同文案重加：必须原位复活，不能追加后被去重再由旧墓碑删除。
const sameLeafReaddTarget = {
  lifeDetails: {
    add: [{ text: '不吃香菜' }, { text: '习惯早睡' }],
    remove: ['detail:leaf#0'],
  },
};
mergeLifeDetailsOp(sameLeafReaddTarget, {
  add: [{ text: '不吃香菜', topics: ['饮食'] }],
}, {
  leafId: 'leaf',
});
equal(sameLeafReaddTarget.lifeDetails.add.length, 2, '同叶重加不应产生第三个 add 序号');
deepEqual(
  sameLeafReaddTarget.lifeDetails.add[0],
  { text: '不吃香菜', topics: ['饮食'] },
  '同叶重加应以新输入原位恢复原条目',
);
equal(sameLeafReaddTarget.lifeDetails.remove, undefined, '同叶重加应撤销对应删除标记');
equal(
  sameLeafReaddTarget.lifeDetails.update?.some(update => update.id === 'detail:leaf#0') ?? false,
  false,
  '同叶重加应清除旧编辑与层级补丁，恢复为 active 新记录',
);

// 更早叶子的条目在当前叶删除后重加：撤销删除，并用完整 update 覆盖旧元数据和层级。
const crossLeafTarget = {
  lifeDetails: {
    remove: ['detail:old#0'],
    archive: ['detail:old#0'],
  },
};
mergeLifeDetailsOp(crossLeafTarget, {
  add: [{ text: '不吃香菜' }],
}, {
  leafId: 'latest',
  existingDetails: [{
    id: 'detail:old#0',
    text: '不吃香菜',
    topics: ['旧标签'],
    anchors: ['旧关键词'],
    tier: 'pinned',
    until: '昨天',
    createdAt: 1,
  }],
});
equal(crossLeafTarget.lifeDetails.add, undefined, '跨叶重加应复活旧稳定 id，而不是追加重复 add');
equal(crossLeafTarget.lifeDetails.remove, undefined, '跨叶重加应撤销旧删除标记');
equal(crossLeafTarget.lifeDetails.archive, undefined, '跨叶重加应撤销旧沉降标记');
deepEqual(
  crossLeafTarget.lifeDetails.update,
  [{
    id: 'detail:old#0',
    text: '不吃香菜',
    topics: [],
    anchors: [],
    until: '',
    tier: 'active',
  }],
  '跨叶重加应按本次输入清空旧元数据并恢复 active',
);

// 直观复现用户看到的故障：新年龄若误套旧锚点会再次增长；锚到当前时间才显示用户输入值。
const { ageDisplay } = await importStandalone('../src/memory/timeRel.ts');
equal(ageDisplay('25', '2020/1/1', '2025/1/1'), '约30岁(2020年时25岁)', '旧锚点会让刚输入的年龄被二次推算');
equal(ageDisplay('25', '2025/1/1', '2025/1/1'), '25', '新年龄锚到当前时间后应原样显示');

const { fmtNpcTiesContext, fmtNpcSummaryList } = await importStandalone('../src/memory/npcRelations.ts');

// 四个对象模拟主要/在场/同区域/不在场。关系块不接收分档，因此必须全部出现且各一次。
const allTiers = fmtNpcTiesContext([
  { name: '主要甲', ties: '乙之父' },
  { name: '在场乙', ties: '主要甲之子' },
  { name: '附近丙', ties: '与丁为宿敌' },
  { name: '远处丁', ties: '丙的宿敌' },
]);
for (const name of ['主要甲', '在场乙', '附近丙', '远处丁']) occurrence(allTiers, `  - ${name}:`, 1, `${name} 的关系应恰好注入一次`);

// 空白字段不产生空壳；多行用户输入必须压成单行，避免破坏提示词结构。
const sparse = fmtNpcTiesContext([
  { name: '无关系', ties: '   ' },
  { name: '多行', ties: '阿黛尔之父\n与镇长有旧怨' },
]);
occurrence(sparse, '无关系', 0, '空 ties 不应生成关系行');
includes(sparse, '  - 多行:阿黛尔之父 与镇长有旧怨', '多行 ties 应压成单行');

// 异常导入可能产生大小写/空白不同的同名项：相同关系去重，不同关系合并且不丢失。
const duplicateLegacy = fmtNpcTiesContext([
  { name: 'Alice', ties: 'Bob之姐；与Carol为宿敌' },
  { name: ' alice ', ties: 'Bob之姐;Dave的主人' },
  { name: 'ALICE', ties: ' 与Carol为宿敌 ' },
]);
occurrence(duplicateLegacy, '  - Alice:', 1, '同名旧数据应合并为一行');
occurrence(duplicateLegacy, 'Bob之姐', 1, '交叠关系不应重复');
occurrence(duplicateLegacy, '与Carol为宿敌', 1, '跨记录重复关系不应重复');
occurrence(duplicateLegacy, 'Dave的主人', 1, '后续独有关系不应丢失');

equal(fmtNpcTiesContext([]), '', '无 NPC 时不应输出关系块');
equal(fmtNpcTiesContext([{ name: '甲', ties: undefined }]), '', '全无 ties 时不应输出关系块');

// 摘要模型看到的旧状态必须同时包含两类关系，且用户多行内容只能占一条 NPC 记录。
const summaryNpc = fmtNpcSummaryList([{
  name: '阿黛尔',
  gender: '女',
  age: '30',
  ageTime: '2024/1/1',
  relation: '主角的导师,态度严厉',
  ties: '鲍勃之姐\n与卡萝有旧怨',
  title: '炼金术师',
  important: true,
  follow: true,
  outfit: '黑袍',
  condition: '左臂受伤',
}]);
occurrence(summaryNpc, '与主角:主角的导师,态度严厉', 1, '摘要输入应包含一次与主角关系');
occurrence(summaryNpc, '人际:鲍勃之姐 与卡萝有旧怨', 1, '摘要输入应包含一次长期关系');
occurrence(summaryNpc, '  - ★ 阿黛尔', 1, '一个 NPC 不应因两类关系被拆成重复记录');
equal(fmtNpcSummaryList([]), '  (无)', '空 NPC 名册应保持既有占位格式');

// store.ts 的 recomputeDerived 曾用不含 age/ageTime 的字段清单拷贝主角档案,
// 导致重放算出的年龄永远到不了响应式镜像(UI 空白 + 注入缺失)。recomputeDerived
// 依赖 ST context 难以单测,这里做源码级守卫:拷贝循环必须带上年龄锚点对。
const storeSource = await readFile(new URL('../src/memory/store.ts', import.meta.url), 'utf8');
const protagonistCopy = storeSource.match(/for \(const key of \[([^\]]+)\][^{]*\{\s*memory\.protagonist\[key\]/s);
assert.ok(protagonistCopy, '未找到 recomputeDerived 的主角字段拷贝循环');
includes(protagonistCopy[1], "'age'", '主角拷贝循环必须包含 age');
includes(protagonistCopy[1], "'ageTime'", '主角拷贝循环必须包含 ageTime');

// 注入端主角块必须读 memory.protagonist(响应式镜像),且年龄行走 ageDisplay 推算。
const injectSource = await readFile(new URL('../src/memory/inject.ts', import.meta.url), 'utf8');
includes(injectSource, "['年龄', ageDisplay(protagonist.age, protagonist.ageTime, now)]", '主角注入块必须包含年龄推算');
includes(injectSource, 'fmtProtagonistContext(memory.protagonist', '主角注入必须读响应式镜像');

// 手动入口必须接入生活小档案和局势卡，并在没有识别到任何操作时返回失败，防止 UI 静默关闭。
const applySource = await readFile(new URL('../src/memory/apply.ts', import.meta.url), 'utf8');
includes(applySource, 'mergeLifeDetailsOp(d, op.lifeDetails,', '手动叶子写入必须合并生活小档案操作');
includes(applySource, 'if (op.sceneFocus !== undefined)', '手动叶子写入必须处理局势卡覆盖/清空');
includes(applySource, 'if (!changed) return false;', '未写入任何操作时不得返回成功');

const timeTagSource = await readFile(new URL('../src/memory/timeTag.ts', import.meta.url), 'utf8');
includes(timeTagSource, 's = stripBaiBaiImageTags(s);', '统一正文清洗必须过滤柏宝绘标签');

console.log(`memory regression tests passed: ${assertions} assertions`);
