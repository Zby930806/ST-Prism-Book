/** 从实际源码导出,不维护第二份手抄模板。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/** 导出目录里的说明文件。提示词本身从源码读取，这里只写怎么用。 */
const README = `# 棱镜宝书提示词导出

这些文件由 scripts/export-prompts.mjs 从源码直接导出，和插件实际使用的提示词一致。

## 文件

- 01–03：单楼摘要、总结、二次总结。
- 04：任务说明（旧称破限）。
- 05：时间标签指令，发给正文模型。
- 06–07：向量记忆的检索重写。
- 08–09：代码里内置的协议和资料包装示例，给作者核对用，不能整份粘进设置框。

## 怎么用

想自定义时，在「设置 → 提示词」里打开对应的一项，在内置文本上修改。文本里的宏占位符要保留。

提示词只是一部分：伤势局部更新、位置证据、物品防重复、计划更新这些规则要靠代码处理，只换文本替代不了，请和同版本的插件一起用。已经自定义过的模板不会被覆盖；插件升级后想用新版内置文本，需要自己同步，或者恢复默认。

## 提示词的主要取舍

- 单楼摘要：先记明确的行动、结果、仍然有效的限制和关键互动，再补必要的前因；当场做的决定照常记下。
- 总结：把同一件事的目标、转折和结局合在一起写，删掉没有结果的准备和重复的保管记录，不逐段缩写拼接。
- 二次总结：按剧情阶段保留关键节点和仍然有效的后果；已经结束的事不再反复带着失效的条款。
- 三层通用：条件和后果一一对应，共享条件不代表共享后果；不把并列的事补成同行、归属或因果。段落的时间范围不等于事件发生的时刻，分钟不取整。
- 表达：用自然完整的短句；意思明确时才改写，有歧义就保留必要的原话。
- 状态：临时伤势按局部更新，不因时间流逝自动痊愈；角色离场后只记最后确认的位置，不当成现在的位置；物品变动对模型可见，但不让它模仿或重复结算；局势卡只写当前的行动和阻碍。

## 说明

导出不需要请求模型。升级后旧摘要和 L1/L2 不用重建，新生成的内容才会用到新版提示词；只有确实想重做某一条旧摘要时，才对那一楼手动重新摘要。
`;

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
  await writeFile(path.join(out, '00-说明.md'), README, 'utf8');
  console.log('Exported ' + Object.keys(templates).length + ' templates to ' + out);
} finally {
  await server.close();
}
