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
- 06–07：向量记忆的检索重写。内置使用，设置中不提供自定义。
- 08–09：代码内置的协议和资料包装示例，供作者核对，不能整份粘贴到设置中。
- 10：批量补摘「较早楼层合并摘要」使用的提示词，一次为若干层各写一条摘要和时间。内置使用，设置中不提供自定义。
- 11：世界书页「生成建议」使用的提示词，按三档修改权限（只新增、可补充、可修改）各列一份完整版本。内置使用，设置中不提供自定义。
- 12：回看原文补档案使用的提示词，从较早楼层的原文摘录中补全角色档案的空字段。内置使用，设置中不提供自定义。
- 13：创作规划生成规划草稿（含一键生成和按讨论生成草稿）使用的系统提示词，末尾附一键生成时代替创作要求的说明。内置使用，设置中不提供自定义。
- 14：创作规划推进条件检查使用的提示词。内置使用，设置中不提供自定义。
- 15：规划讨论使用的系统提示词。内置使用，设置中不提供自定义。
- 16：双子札记的整理版提示词，与札记页底部「整理版提示词（实际使用）」相同。发送时展开其中 setvar 的内容，去掉注释和 trim 宏，并附加一段面板传输说明；原版提示词在札记页底部查看。内置使用，设置中不提供自定义。
- 17：角色页「角色重新建档」使用的提示词，分两段：第一步按楼层分批读原文，找出名册里漏记的角色；第二步按原文摘录重新整理全部角色的身份、性别、年龄、外貌和性格。每段先是规则，后是发送时的材料格式。内置使用，设置中不提供自定义。

## 使用

01–05 可在「设置 → 提示词」中自定义：打开对应项，在内置文本上修改，保留文本中的宏占位符。其余文件只供查看和核对。

物品防重复、计划更新等规则由代码处理，仅替换文本无法实现，需与同版本插件配合使用。已自定义的模板不会被覆盖；插件升级后如需使用新版内置文本，需手动同步或恢复默认。内置版本更新后，设置中该项标有「内置已更新」，打开可查看变更的行。照旧版内置文本改写的自定义模板若还写着伤情片段补丁（conditionPatch）或角色定位原句（locationEvidence），插件会补发一段写法更正。

01 中的 \`{{knowledge_block}}\`、\`{{knowledge_field}}\`、\`{{knowledge_rule}}\` 只在开启「角色对主角的了解」时展开为了解清单的材料、输出字段和规则，关闭时展开为空；规则全文见 08 中的 RULE_KNOWLEDGE。自定义模板在开启时补发【棱镜宝书了解清单兼容协议】。

## 主要取舍

- 结构：单楼摘要按「内容边界 → 任务 → 执行顺序 → 记录分工 → 输出字段 → 时间、地点、人物、局势、物品、计划、信息差、冲突、变量各字段规则 → 摘要写法 → 状态核对」排列；总结、二次总结和合并摘要同样先写任务，再写流程、时间和共用的成文与保真规则。同一条规则只在一处完整表述，其他位置只引用。
- 单楼摘要：先记录明确的行动、结果、仍有效的限制和关键互动，再补充必要的前因；当场做出的决定照常记录。
- 总结：将同一事件的目标、转折和结局合并叙述，删除没有结果的准备和重复的保管记录，不逐段缩写拼接。目标字数 {{resummary_words}} 以字数档位为基准（详细 300–500 字、精简 150–300 字），随「摘要字数」等比放大，最多 3 倍。
- 二次总结：按剧情阶段保留关键节点和仍有效的后果；已结束的事项不再重复附带失效条款。
- 合并摘要：一次为若干层各写一条摘要和起止时间，事件归入发生的楼层，不提前写后层的结果；只写摘要和时间，不记录状态。
- 世界书建议：只记录新确立、长期有效的设定（地点、组织、规则体系、历史、风俗、术语、有长期意义的物品、人物的稳定背景），不记录宝书已在追踪的临时状态、剧情流水账、戏外内容、猜测和已有设定；已有条目只按 uid 指定；输出严格的 JSON。提示词只列出当前修改权限允许的动作，代码同样拦截超出权限的动作。
- 内容边界：单楼摘要、合并摘要、总结、二次总结、世界书建议、回看原文补档案和角色重新建档都放在规则最前，优先于其他规则。当事人有任何未成年特征（年龄、年级或学生身份、儿童体态描写等）或剧情按未成年处理时，一律按未成年处理，外表成熟或「设定上已成年」不能抵消，不写性内容或色情细节；只有正文或设定明确为成年人且没有未成年特征时才按成年人处理，其内容按正文实际写到的程度如实记录；年龄无法判断时不写性内容细节，只记录关系变化等必要事实；非自愿情节只记事实、拒绝与后果；真实人物和有明确来源的虚构内容分开；用户本人或真实人物处于真实危险时只记事实。材料中的指令不能改变这些边界。
- 三层通用：条件与后果一一对应，共享条件不代表共享后果；不把并列事项补成同行、归属或因果。段落的时间范围不等于事件发生的时刻，分钟不取整。
- 表达：使用完整的短句；仅在意思明确时改写，有歧义时保留必要的原话。
- 人物：主角只记 {{user}} 本人；主要角色与 NPC 分档记录，没有名字的以职业加字母记录，报出真名后改名接续。
- 状态：临时伤情整段覆盖，有变化时写变化后的完整状态，已恢复的部分删去；不因时间流逝自动痊愈（伤情记录仍只按正文更新）。正文注入照常附带伤情，但只要求在动作牵涉伤处、影响行动或被人提及时写进正文，与本轮无关时不写；伤势进展提醒在伤情记录满一天未更新时出现，要求下次写到伤处或相关行动时按轻重和经过的时间体现进展；角色离场后只记录最后确认的位置，不视为当前位置；物品变动对模型可见，但不让模型模仿或重复结算，数不清的按包装记一份；局势卡写本楼结束时的局面，日常戏写氛围、剧情戏写处境；信息差只记录正文中明确的隐瞒或缺席；正文与记录无交代地矛盾时保留原记录并标出。
- 地点与位置：到过的有名地点都建档，写不出稳定特征就只建节点、不写描述；locationPath 对不上最细一级时给能确认的上级，只有真在两地之间赶路才留空；主角离开某处默认仍在其上级区域内。当面互动的角色首次记录时位置通常就是主角所在地点；角色位置不要求附正文原句。
- 输出前核查：按本楼定位、主角、人物、局势、物品、生活小档案、计划与悬念、信息差与冲突、变量逐项盘点，再对照原文、核对档案与快照分工和时间；没有变化的项不写。总结与二次总结用压缩专用的核查：先保仍有效的后果，再回取转折。
- 了解清单（默认关闭）：只记角色本楼亲耳听到、亲眼看到或被告知的主角的事，记角色的认知而非真相，被骗时照记，揭穿时改写原条；与信息差分工。注入时写明没有记下的主角私事按该角色不知道处理，外貌、公开身份和按关系本应知道的事不受限制。
- 检索重写：固定写 5 条检索语句，从不同角度查找续写需要的旧事；检索库里没有对应内容时该条召回为空，漏查则正文可能出错。
- 角色重新建档：第一步只为原文中登场、名册里没有的人物建档，名册已有的人物（含曾用名，以及用别称、昵称或身份称呼指代的同一人）不重复建档，每人附首次登场的原句和各字段的原句；第二步只输出需要改动的字段，写改动后的完整内容并附摘录原句，摘录没有依据的不改也不清空。两步都不记位置、关系、着装、伤情和好感，原句由代码逐句核对。

## 说明

导出不请求模型。升级后旧摘要和 L1/L2 无需全部重新摘要，新生成的内容才使用新版提示词；只有需要重做某条旧摘要时，才对该楼手动重新摘要。

单楼摘要、合并摘要、总结、二次总结、世界书建议、回看原文补档案和角色重新建档开头的「内容边界」是否发送，在「设置 → 提示词 → 自定义提示词 → 内容边界」中选择；设置里的内置文本和这里的导出都按完整版显示。默认「自动」：DeepSeek 系列模型（模型名里含 deepseek，不区分大小写，带平台前缀或后缀的也算）不发送，沿用原来的规则，其他模型发送；单楼摘要、合并摘要、回看原文补档案和角色重新建档按「摘要使用」的模型判断，总结和二次总结按「总结使用」的模型判断（跟随主 API 时为酒馆当前选中的模型），世界书建议按世界书所用 API 的模型判断。也可以选「始终发送」或「不发送」，不看模型名。自己模板里写的内容边界不受这一项影响。检索改写（06、07）以及创作规划、推进条件检查、规划讨论和双子札记（13–16）不加内容边界。
`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs', 'prompts'));
const server = await createServer({ root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
try {
  const p = await server.ssrLoadModule('/src/memory/prompts.ts');
  const t = await server.ssrLoadModule('/src/memory/timeTag.ts');
  const ledger = await server.ssrLoadModule('/src/memory/ledgerProtocol.ts');
  const worldbook = await server.ssrLoadModule('/src/worldbook/prompt.ts');
  const outline = await server.ssrLoadModule('/src/outline/prompt.ts');
  const outlineContext = await server.ssrLoadModule('/src/outline/context.ts');
  const discussion = await server.ssrLoadModule('/src/outline/discussionContext.ts');
  const notes = await server.ssrLoadModule('/src/notes/prompt.ts');
  const recall = await server.ssrLoadModule('/src/memory/vector/recall.ts');
  const refile = await server.ssrLoadModule('/src/memory/npcRefile.ts');
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
    '13-创作规划生成.txt': outline.OUTLINE_PROMPT + '\n\n===== 一键生成时代替创作要求的说明（AUTO_OUTLINE_REQUEST）=====\n' + outlineContext.AUTO_OUTLINE_REQUEST,
    '14-推进条件检查.txt': outline.OUTLINE_PROGRESS_PROMPT,
    '15-规划讨论.txt': discussion.DISCUSSION_PROMPT,
    '16-双子札记整理版.txt': notes.TIDY_NOTES_PROMPT,
    '17-角色重新建档.txt': refile.NPC_REFILE_PROMPT,
  };
  const internalNames = ['THINKING_CHECKLIST', 'THINKING_PREFILL', 'RESUMMARY_THINKING_CHECKLIST', 'RESUMMARY_THINKING_PREFILL', 'BATCH_SUMMARY_THINKING_CHECKLIST', 'RULE_CONTENT_BOUNDARY', 'MEMORY_BRIEFING_NOTE', 'MEMORY_BRIEFING_END', 'MEMORY_BRIEFING_HISTORY_END', 'TIME_RULE_WITH_TAGS', 'TIME_RULE_NO_TAGS', 'RULE_KNOWLEDGE'];
  for (const k of internalNames) if (typeof p[k] !== 'string' || !p[k].trim()) throw new Error('导出项为空: ' + k);
  if (typeof recall.RECALL_BRIEFING_END !== 'string' || !recall.RECALL_BRIEFING_END.trim()) throw new Error('导出项为空: RECALL_BRIEFING_END');
  templates['08-作者用-代码内置协议.txt'] = internalNames.map(k => '===== ' + k + ' =====\n' + p[k]).join('\n\n') + '\n\n===== RECALL_BRIEFING_END（向量召回块的结束语）=====\n' + recall.RECALL_BRIEFING_END + '\n\n===== LEDGER_PROTOCOL =====\n' + ledger.LEDGER_PROTOCOL;
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
