/** 从实际源码导出,不维护第二份手抄模板。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs', 'prompts'));
const server = await createServer({ root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
try {
  const p = await server.ssrLoadModule('/src/memory/prompts.ts');
  const t = await server.ssrLoadModule('/src/memory/timeTag.ts');
  const ledger = await server.ssrLoadModule('/src/memory/ledgerProtocol.ts');
  const condition = await server.ssrLoadModule('/src/memory/conditionPatch.ts');
  const location = await server.ssrLoadModule('/src/memory/npcLocationEvidence.ts');
  const templates = {
    '01-摘要提示词.txt': p.SUMMARY_PROMPT,
    '02-总结提示词.txt': p.RESUMMARY_PROMPT,
    '03-二次总结提示词.txt': p.RESUMMARY2_PROMPT,
    '04-任务说明-旧破限.txt': p.JAILBREAK_PROMPT,
    '05-时间标签指令.txt': t.TIME_TAG_PROMPT,
    '06-检索重写系统.txt': p.QUERY_REWRITE_SYSTEM,
    '07-检索重写尾部.txt': p.QUERY_REWRITE_TAIL,
  };
  const internalNames = ['THINKING_CHECKLIST', 'THINKING_PREFILL', 'RESUMMARY_THINKING_CHECKLIST', 'RESUMMARY_THINKING_PREFILL', 'MEMORY_BRIEFING_NOTE', 'MEMORY_BRIEFING_END', 'TIME_RULE_WITH_TAGS', 'TIME_RULE_NO_TAGS'];
  templates['08-作者用-代码内置协议.txt'] = internalNames.map(k => '===== ' + k + ' =====\n' + p[k]).join('\n\n') + '\n\n===== LEDGER_PROTOCOL =====\n' + ledger.LEDGER_PROTOCOL + '\n\n===== CONDITION_PATCH_PROTOCOL（片段编号由正式请求动态附加）=====\n' + condition.CONDITION_PATCH_PROTOCOL + '\n\n===== NPC_LOCATION_EVIDENCE_PROTOCOL =====\n' + location.NPC_LOCATION_EVIDENCE_PROTOCOL;
  templates['09-作者用-资料包装示例.txt'] = [p.buildPersonaSystem('〔主角设定占位〕'), p.buildWorldInfoSystem('〔世界书内容占位〕'), p.buildCharCardSystem('〔角色卡内容占位〕')].join('\n\n');
  await mkdir(out, { recursive: true });
  for (const [name, text] of Object.entries(templates)) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('导出项为空: ' + name);
    await writeFile(path.join(out, name), text + '\n', 'utf8');
  }
  await writeFile(path.join(out, '00-说明.md'), "# 棱镜宝书提示词导出\n\n由 scripts/export-prompts.mjs 从实际源码导出，生产文本不含本次测试人物或场景。\n\n## 使用\n01—03：单楼摘要、总结、二次总结；04—05：任务说明与时间标签；06—07：检索重写；08—09：供作者核对代码内置协议与资料包装，不能整份粘进一个设置框。保留宏占位符。\n\n请配合完整的 1.2.9-prism.1 安装包使用。仅替换文本无法代替伤势补丁、位置证据、物品防重及计划更新等代码。既有自定义模板不会被覆盖；使用自定义模板时须自行同步对应文本。本次未修改聊天、设置或预设。\n\n## 本轮实质调整\n- 条件更新按后果及适用对象逐条定位，补充与替代分开；提供完整更新前后示范，禁止新增条件扩大另一后果。\n- 范围词逐词比对，歧义留必要原话，不自动改成债务或付款。\n- 物品描述只承载识别、功能、可用状态及来源；借用义务不复制到描述里另行改述。\n- 自然语言摘要与人物档案同样要求本次位置证据，不在新场景末尾补旧位置为当前实况。\n- 三层共用真正删除无信息动作的正向压缩示范；保留临时伤势、新决定、技术阈值和关系证据。了结只写实际结果，不反复复述旧惩罚。\n- 局势能一句说清就不补第二句，摘要没有最低篇幅任务。\n\n## 延续的三层取舍\n- 单楼：先留明确行动变化、结果、有效限制和关键互动，再补必要前因；即时决定不受新增长期计划门槛阻挡。\n- 总结：按同一事项重组目标、转折与末态，删除无结果的准备与重复保管，不逐段缩写拼接。\n- 二次总结：按剧情阶段保留关键节点及有效后果，结束事项不反复携带失效条款；有效临时伤势仍保留。\n- 三层共用：完整命题才是合并单位，共享条件不代表共享后果；并列不补成同行、归属或因果。\n- 时间：段落范围不等于事件时点，不借旧当前时间或范围端点，不把分钟取整。\n- 表达：用自然完整短句，不强制复用含糊俗语或财务术语；语义明确才改述，歧义保留必要原话。\n- 局势卡：只写当前行动与阻碍，pendingBeat 不重复 situation。\n\n## 保留的保护\n临时伤势局部更新、不凭时间自动康复；离场位置保留最后确认而非永久定位；物品变动继续可见但只读、不仿写、不重复结算；同一计划更新与实际结束方式保持区分。完整原文与来源索引继续发送。JSON格式、字数预算、状态处理代码不变。\n\n## 验证边界\n本地合同测试验证规则到达正式请求，mock验证解析与保存，不证明真实模型语义通过。未自动重建或调用模型。安装后需刷新并重建一次；新生成内容才消费新版提示词，旧摘要不会自动改写。\n", 'utf8');
  console.log('Exported ' + Object.keys(templates).length + ' templates to ' + out);
} finally {
  await server.close();
}
