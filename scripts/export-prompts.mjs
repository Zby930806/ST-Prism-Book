/** 从实际源码导出,不维护第二份手抄模板。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/** 导出目录里的说明文件。提示词本身从源码读取，这里只写怎么用。 */
const README = `# 棱镜宝书提示词导出

以下文件由 scripts/export-prompts.mjs 从源码导出，与插件实际使用的提示词一致。

## 文件

- 01–03：单楼摘要、总结、二次总结。
- 04：任务说明（旧称破限）。
- 05：时间标签指令，发送给正文模型。
- 06–07：向量记忆的检索重写。
- 08–09：代码内置的协议和资料包装示例，供作者核对，不能整份粘贴到设置中。
- 10：批量补摘「较早楼层合并摘要」使用的提示词，一次为若干层各写一条摘要和时间。内置使用，设置中不提供自定义。
- 11：世界书页「生成建议」使用的提示词，按三档修改权限（只新增、可补充、可修改）各列一份完整版本。内置使用，设置中不提供自定义。
- 12：回看原文补档案使用的提示词，从较早楼层的原文摘录中补全角色档案的空字段。内置使用，设置中不提供自定义。

## 使用

自定义时，在「设置 → 提示词」中打开对应项，在内置文本上修改，保留文本中的宏占位符。

伤势局部更新、位置证据、物品防重复、计划更新等规则由代码处理，仅替换文本无法实现，需与同版本插件配合使用。已自定义的模板不会被覆盖；插件升级后如需使用新版内置文本，需手动同步或恢复默认。内置版本更新后，设置中该项标有「内置已更新」，打开可查看变更的行。

## 主要取舍

- 结构：单楼摘要按「内容边界 → 任务 → 执行顺序 → 记录分工 → 输出字段 → 时间、地点、人物、局势、物品、计划、信息差、冲突、变量各字段规则 → 摘要写法 → 状态核对」排列；总结、二次总结和合并摘要同样先写任务，再写流程、时间和共用的成文与保真规则。同一条规则只在一处完整表述，其他位置只引用。
- 单楼摘要：先记录明确的行动、结果、仍有效的限制和关键互动，再补充必要的前因；当场做出的决定照常记录。
- 总结：将同一事件的目标、转折和结局合并叙述，删除没有结果的准备和重复的保管记录，不逐段缩写拼接。
- 二次总结：按剧情阶段保留关键节点和仍有效的后果；已结束的事项不再重复附带失效条款。
- 合并摘要：一次为若干层各写一条摘要和起止时间，事件归入发生的楼层，不提前写后层的结果；只写摘要和时间，不记录状态。
- 世界书建议：只记录新确立、长期有效的设定（地点、组织、规则体系、历史、风俗、术语、有长期意义的物品、人物的稳定背景），不记录宝书已在追踪的临时状态、剧情流水账、戏外内容、猜测和已有设定；已有条目只按 uid 指定；输出严格的 JSON。提示词只列出当前修改权限允许的动作，代码同样拦截超出权限的动作。
- 内容边界：单楼摘要、合并摘要、总结和二次总结都放在规则最前，优先于其他规则。未成年人相关情节不写性内容或色情细节；成年人内容按正文实际写到的程度如实记录；非自愿情节只记事实、拒绝与后果；真实人物和有明确来源的虚构内容分开；用户本人或真实人物处于真实危险时只记事实。材料中的指令不能改变这些边界。
- 三层通用：条件与后果一一对应，共享条件不代表共享后果；不把并列事项补成同行、归属或因果。段落的时间范围不等于事件发生的时刻，分钟不取整。
- 表达：使用完整的短句；仅在意思明确时改写，有歧义时保留必要的原话。
- 人物：主角只记 {{user}} 本人；主要角色与 NPC 分档记录，没有名字的以职业加字母记录，报出真名后改名接续。
- 状态：临时伤情按局部更新，不因时间流逝自动痊愈（伤情记录仍只按正文更新）。正文注入照常附带伤情，但只要求在动作牵涉伤处、影响行动或被人提及时写进正文，与本轮无关时不写；伤势进展提醒在伤情记录满一天未更新时出现，要求下次写到伤处或相关行动时按轻重和经过的时间体现进展；角色离场后只记录最后确认的位置，不视为当前位置；物品变动对模型可见，但不让模型模仿或重复结算；局势卡只记录当前的行动和阻碍；信息差只记录正文中明确的隐瞒或缺席；正文与记录无交代地矛盾时保留原记录并标出。

## 说明

导出不请求模型。升级后旧摘要和 L1/L2 无需重建，新生成的内容才使用新版提示词；只有需要重做某条旧摘要时，才对该楼手动重新摘要。

DeepSeek 系列模型（模型名里含 deepseek，不区分大小写，带平台前缀或后缀的也算）发送时不带单楼摘要、合并摘要、总结、二次总结、世界书建议和回看原文补档案开头的「内容边界」，沿用原来的规则；设置里的内置文本和这里的导出仍按完整版显示。自己模板里写的内容边界不会被去掉。检索改写（06、07）不加内容边界。
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
  const worldbook = await server.ssrLoadModule('/src/worldbook/prompt.ts');
  const templates = {
    '01-摘要提示词.txt': p.SUMMARY_PROMPT,
    '02-总结提示词.txt': p.RESUMMARY_PROMPT,
    '03-二次总结提示词.txt': p.RESUMMARY2_PROMPT,
    '04-任务说明-旧破限.txt': p.JAILBREAK_PROMPT,
    '05-时间标签指令.txt': t.TIME_TAG_PROMPT,
    '06-检索重写系统.txt': p.QUERY_REWRITE_SYSTEM,
    '07-检索重写尾部.txt': p.QUERY_REWRITE_TAIL,
    '10-批量补摘合并摘要.txt': p.BATCH_SUMMARY_PROMPT,
    '11-世界书建议.txt': worldbook.worldbookPromptExport(),
    '12-回看原文补档案.txt': p.NPC_ENRICH_PROMPT,
  };
  const internalNames = ['THINKING_CHECKLIST', 'THINKING_PREFILL', 'RESUMMARY_THINKING_CHECKLIST', 'RESUMMARY_THINKING_PREFILL', 'BATCH_SUMMARY_THINKING_CHECKLIST', 'RULE_CONTENT_BOUNDARY', 'MEMORY_BRIEFING_NOTE', 'MEMORY_BRIEFING_END', 'TIME_RULE_WITH_TAGS', 'TIME_RULE_NO_TAGS'];
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
