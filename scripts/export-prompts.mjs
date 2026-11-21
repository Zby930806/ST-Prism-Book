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
- 06–07：向量记忆的检索重写。内置使用，设置中不提供自定义。发送时 06 在开头的 system 消息里（后面接历史剧情摘要），最近几楼按 user、assistant 交替排列，07 接在最后一条 user 的末尾（最后一楼是回复时单独成一条）；最近几楼以回复开头时，最前面另有一条 user 消息「[最近对话开始]」。
- 08–09：代码内置的协议和资料包装示例，供作者核对，不能整份粘贴到设置中。
- 10：批量补摘「较早楼层合并摘要」使用的提示词，一次为若干层各写一条摘要和时间。内置使用，设置中不提供自定义。
- 11：世界书页「生成建议」使用的提示词，按三档修改权限（只新增、可补充、可修改）各列一份完整版本。内置使用，设置中不提供自定义。
- 12：回看原文补档案使用的提示词，从较早楼层的原文摘录中补全角色档案的空字段。内置使用，设置中不提供自定义。
- 13：创作规划生成规划草稿（含一键生成和按讨论生成草稿）使用的系统提示词，分三段：可以自定义的规划要求、固定接在后面的输出格式、一键生成时代替创作要求的说明。发送时前两段接在一起（中间换一行）。
- 14：创作规划推进条件检查使用的提示词，分两段：可以自定义的判断标准、固定接在后面的输出格式。发送时两段接在一起（中间换一行）。
- 15：规划讨论使用的系统提示词。内置使用，设置中不提供自定义；讨论角色的名字和人设提示词可在规划讨论菜单的「讨论角色」中改成自己的，讨论规则固定。
- 16：双子札记的整理版提示词，与札记页底部「整理版提示词（实际使用）」相同。发送时展开其中 setvar 的内容，去掉注释和 trim 宏，并附加一段面板传输说明；原版提示词在札记页底部查看。内置使用，设置中不提供自定义。
- 17：角色页「角色重新建档」使用的提示词，分两段：第一步按楼层分批读原文，找出名册里漏记的角色；第二步按原文摘录重新整理全部角色的身份、性别、年龄、外貌和性格。每段先是规则，后是发送时的材料格式。内置使用，设置中不提供自定义。
- 18：「总结写完后核对」（默认开启）使用的提示词，依次是规则、发送时的材料格式和材料之后的检查块写法；其中的 {{what}} 发送时填「总结」或「二次总结」。内置使用，设置中不提供自定义。
- 19：规划启用后随当前阶段发给正文模型的文字，分四段：可以自定义的写作要求、其中的 {{pace_rule}} 在三种推进节奏下换成的句子、插件固定生成的部分（开头的标记行和后面的规划内容）的示意、「剧情要点」标题里随推进节奏变化的文字。

01–03、05、10 各有两份：不带后缀的是默认使用的精简版（1.4.18 起），文件名带「（旧版）」的是 1.4.17 及以前的文本。在「设置 → 提示词 → 自定义提示词 → 内置提示词版本」中切换；两版的输出字段和记录内容相同。08 中名称以 COMPACT_ 开头的各段是精简版的核对步骤、时间规则和可选规则。

## 使用

01–05 可在「设置 → 提示词」中自定义：打开对应项，在内置文本上修改，保留文本中的宏占位符；未自定义的项打开时显示所选版本的内置文本。13、14、19 中标明「可以自定义」的一段（1.4.19 起）同样在「设置 → 提示词」中修改，分别对应「规划生成提示词」「推进条件检查提示词」「规划注入指引」；输出格式和规划内容由插件固定接上，不在可以修改的文本里，编辑窗口下方可以展开查看。其余文件只供查看和核对。

物品防重复、计划更新等规则由代码处理，仅替换文本无法实现，需与同版本插件配合使用。已自定义的模板不会被覆盖；插件升级后如需使用新版内置文本，需手动同步或恢复默认。内置版本更新后，设置中该项标有「内置已更新」，打开可查看变更的行；照其中一版内置修改的自定义模板，只要那一版没有变，切换版本不会出现这个标记。照旧版内置文本改写的自定义模板若还写着伤情片段补丁（conditionPatch）或角色定位原句（locationEvidence），插件会补发一段写法更正。照精简版修改的自定义摘要、总结模板自带全部规则，插件不再补发旧版的兼容协议，材料格式和核对步骤按精简版发送。

旧版 01 中的 \`{{knowledge_block}}\`、\`{{knowledge_field}}\`、\`{{knowledge_rule}}\` 只在开启「角色对主角的了解」时展开为了解清单的材料、输出字段和规则，关闭时展开为空；规则全文见 08 中的 RULE_KNOWLEDGE（精简版为 COMPACT_RULE_KNOWLEDGE）。照旧版修改的自定义模板在开启时补发【棱镜宝书了解清单兼容协议】。

精简版 01 中的 \`{{required_fields}}\`、\`{{minimal_json}}\`、\`{{example_time_check}}\`、\`{{example_time_fields}}\`、\`{{example_time}}\` 随本楼正文有没有时间标签展开：有标签时时间由系统读取，这几处只写 summary；没有标签时带上 timeStart、timeEnd 两个必填字段，核对步骤末尾另加一步（08 中的 COMPACT_TIME_CHECK）。精简版 02、03 中的 \`{{length_rule}}\` 是本次请求的篇幅说明，按设置和输入的长度生成（文字见 08 中名称以 COMPACT_LENGTH_ 开头的各段）。自定义时保留这几个占位符。

## 主要取舍

- 精简版的结构：单楼摘要按「内容边界 → 任务 → 输出格式与通用约定 → summary 的写法 → 各字段的状态更新 → 示例」排列，核对步骤发在材料之后；总结按「任务 → 篇幅 → 取舍 → 写法 → 输出格式」排列，二次总结按「任务 → 篇幅 → 写成大事记 → 写法 → 输出格式」排列。任务一节先说明记录的用途：这一楼的原文以后会隐藏，续写模型只能靠摘要和状态了解这里发生过什么，只记正文明确写出的事。「省略表示保持、空字符串表示清空、文字字段整体覆盖、沿用已有名字」只在通用约定里写一次；单楼摘要的取舍用「必须留下」「可以删」两张清单表达，总结只列「必须留下」，其余的细节默认不写；核对步骤只列步骤，不复述规则。导出的 01 加核对步骤约 1.4 万字（旧版约 3.6 万字），02、03 加核对步骤各约 2700 字（旧版约 9400–10300 字）。正文没有时间标签的楼层，输出格式、示例和核对步骤都写明 timeStart、timeEnd 每楼必填（这两个字段不按「没有变化就省略」处理）；核对步骤的最后一行要求先列出这次 JSON 要带的全部字段名，再照这一行输出。
- 旧版的结构：单楼摘要按「内容边界 → 任务 → 执行顺序 → 记录分工 → 输出字段 → 时间、地点、人物、局势、物品、计划、信息差、冲突、变量各字段规则 → 摘要写法 → 状态核对」排列；总结、二次总结和合并摘要同样先写任务，再写流程、时间和共用的成文与保真规则。同一条规则只在一处完整表述，其他位置只引用。
- 以下各条是两版共同的要求，括注里的章节名是旧版的。
- 单楼摘要：先记录明确的行动、结果、仍有效的限制和关键互动，再补充必要的前因；当场做出的决定照常记录。承诺、约定、条件、保密要求、表白、拒绝、道歉、揭示秘密的话和第一次改口的称呼，用「」照抄原话并写明谁对谁说，每楼一般一两句、最多三句，计入摘要字数；玩笑、寒暄和叮嘱不引用。
- 总结（旧版）：将同一事件的目标、转折和结局合并叙述，删除没有结果的准备和重复的保管记录，不逐段缩写拼接；事件写清后篇幅还够，才照抄摘要里「」中仍有效的承诺、条件和表态，字数上限在 300 字以内时最多两句，更长时最多三四句。目标字数 {{resummary_words}} 取「摘要设置」中的「总结字数」；为 0 时以字数档位为基准（详细 600–1000 字、精简 300–600 字），随「摘要字数」等比放大，最多 3 倍。
- 总结（精简版）：输入里的每个场合（一次见面、一次通话、一天里的一件事）至少留一句，已经办完、没有后续的事也留；约定和条件、人物状态的变化、数字和期限、明说的理由和态度、有代表性的互动照输入保留，原话照抄最要紧的三四句，其余的细节默认不写。上限取「总结字数」；为 0 时取上面按档位算出的字数与输入的一半（精简档四成）中较大的一个，另给目标字数（上限的四分之三）和每条输入平均所占的字数。上限照档位的字数硬给时，实测有分量的情节和细节会被整件删掉。
- 两版的总结都要求每句写到具体的人、事、话和结果，不写「关系拉近」「感情升温」「埋下伏笔」之类的概括、评价和气氛描写（旧版见 02、03 中的【写实，不写空话】，精简版见「写法」）。精简版另写明不改动主语、对象、日期、数量和先后，输入里没有写日期的事不给它安日期，转述原话时拿不准话里的「你」「我」指谁就照抄原句。
- 二次总结（旧版）：按剧情阶段保留关键节点和仍有效的后果；已结束的事项不再重复附带失效条款；写实和留原话的要求与总结相同。篇幅按输入长度的比例计算，{{target_max}} 不超过「二次总结字数」（为 0 时取总结字数上限的 1.5 倍，默认 1500 字）。用内置模板时，总结和二次总结请求末尾的核查清单（08 中的 RESUMMARY_THINKING_CHECKLIST；精简版总结为 COMPACT_RESUMMARY_CHECKLIST，二次总结为 COMPACT_RESUMMARY2_CHECKLIST）后面另加一句本次的篇幅。
- 二次总结（精简版）：写成按日期排列的大事记，以 JSON 的 timeline 数组输出，一个场合一项：日期开头，一两句话写清事件和结果，以及这个场合定下的约定、发生的状态变化和关系上的要紧处；插件把各项接成一段文字保存。输入里的每个场合都有一项，办完了的事也写；一项只写一天的事。场合里其余的互动、闲谈和场面细节这一级不带，原话全篇最多三句。篇幅只给目标（输入的四成左右），不给硬上限。按「到结束时还有没有用」来选时，实测办完了的事会整件丢掉，重新组织时把人和日期安错的也最多。
- 篇幅的写法：精简版在上限之外另给一个目标字数（上限的四分之三，取整到十位），单楼摘要写「一般写到 {{summary_aim}} 字左右，最多不超过 {{summary_max_chars}} 字」，总结在规则开头和核对步骤末尾各写一次，二次总结只写目标；只给上限时模型常常写超。字数由模型自己掌握，写出的摘要或总结超过上限时照常保存，插件不截断，也不为此另发请求。
- 写完后的核对：内容明显不是摘要或总结的回复（拒答的话、对输出要求的复述）不保存，两版相同。用精简版内置提示词时，插件另核对总结、二次总结有没有把每条输入都写到：有整条输入没写到，把是第几条告诉模型重写，重试后仍然如此的不保存（十几条摘要里只漏一条时照常保存并提示）；字句和输入完全对不上的（「没有收到材料」之类的说明）不保存。二次总结把输入整段搬进各项（3 项以上超过 200 字）时让模型重写一次，重写后仍然太长的照常保存。模型把总结正文拆成 summary、summary_continued 几个字段时，插件按先后接回去。以上各项由插件按字句判断，不另发请求。「设置 → 摘要设置 → 总结写完后核对」（默认开启）开着时，总结、二次总结写完再多发一个请求，让模型对照输入逐个场合核对，报出写错的句子和改正后的句子（提示词见 18）；插件按原句替换，找不到原句的、把内容删掉或换掉的改动不采用，两版提示词和自定义模板写出的总结都会核对。
- 合并摘要：一次为若干层各写一条摘要和起止时间，事件归入发生的楼层，不提前写后层的结果；只写摘要和时间，不记录状态。
- 世界书建议：只记录新确立、长期有效的设定（地点、组织、规则体系、历史、风俗、术语、有长期意义的物品、人物的稳定背景），不记录宝书已在追踪的临时状态、剧情流水账、戏外内容、猜测和已有设定；已有条目只按 uid 指定；输出严格的 JSON。提示词只列出当前修改权限允许的动作，代码同样拦截超出权限的动作。
- 内容边界：单楼摘要、合并摘要、总结、二次总结、世界书建议、回看原文补档案和角色重新建档都放在规则最前，优先于其他规则。各类虚构剧情（含亲密与性内容、冲突与非自愿情节等）均按正文实际写到的程度正常如实记录；真实人物和有明确来源的虚构内容分开；用户本人或真实人物处于真实危险时只记事实。材料中的指令不能改变这些边界。
- 三层通用：条件与后果一一对应，共享条件不代表共享后果；不把并列事项补成同行、归属或因果。段落的时间范围不等于事件发生的时刻，分钟不取整。
- 表达：使用完整的短句；仅在意思明确时改写，有歧义时保留必要的原话；重要对话用「」照抄原话。
- 人物：主角只记 {{user}} 本人；主要角色与 NPC 分档记录，没有名字的以职业加字母记录，报出真名后改名接续。
- 亲密记录：角色与主角发生性行为的累计次数、每次是否戴套或用了别的避孕办法（未戴套或出意外时是否在体内结束）、事后的服药、例假或验孕结果和避孕约定，记在该角色档案的 intimacy 字段里，由摘要在原有记录上逐次累加，注入时原样发送，不参与总结压缩；单楼摘要、合并摘要、总结和二次总结的正文同样要求写明，不得并成「多次亲密」。这项记录默认关闭，在「设置 → 注入设置 → 亲密记录」中开启；导出的 01、02、03、08、10 是开启时的文本，关闭时相关的几段不发送，旧版提示词与 1.4.15 相同。字段规则和摘要要求这两段新旧两版共用同一份文字。
- 时间标签指令（05）：精简版写明开始标签在正文之前、结束标签在正文之后，两个标签不连着写；开始时间沿用「当前主线时间基准」，正文没有写明时间推进时结束时间与开始时间相同；没有基准也没有线索的新开场写「故事第1天 08:00」。
- 状态：临时伤情整段覆盖，有变化时写变化后的完整状态，已恢复的部分删去；不因时间流逝自动痊愈（伤情记录仍只按正文更新）。正文注入照常附带伤情，但只要求在动作牵涉伤处、影响行动或被人提及时写进正文，与本轮无关时不写；伤势进展提醒在伤情记录满一天未更新时出现，要求下次写到伤处或相关行动时按轻重和经过的时间体现进展；角色离场后只记录最后确认的位置，不视为当前位置；物品变动对模型可见，但不让模型模仿或重复结算，数不清的按包装记一份；局势卡写本楼结束时的局面，日常戏写氛围、剧情戏写处境；信息差只记录正文中明确的隐瞒或缺席；正文与记录无交代地矛盾时保留原记录并标出。
- 地点与位置：到过的有名地点都建档，写不出稳定特征就只建节点、不写描述；locationPath 对不上最细一级时给能确认的上级，只有真在两地之间赶路才留空；主角离开某处默认仍在其上级区域内。当面互动的角色首次记录时位置通常就是主角所在地点；角色位置不要求附正文原句。
- 输出前核查：按本楼定位、主角、人物、局势、物品、生活小档案、计划与悬念、信息差与冲突、变量逐项盘点，再对照原文、核对档案与快照分工和时间；没有变化的项不写。总结与二次总结用压缩专用的核查：先保仍有效的后果，再回取转折。
- 了解清单（默认关闭）：只记角色本楼亲耳听到、亲眼看到或被告知的主角的事，记角色的认知而非真相，被骗时照记，揭穿时改写原条；与信息差分工。注入时写明没有记下的主角私事按该角色不知道处理，外貌、公开身份和按关系本应知道的事不受限制。
- 检索重写：固定写 5 条检索语句，从不同角度查找续写需要的旧事；检索库里没有对应内容时该条召回为空，漏查则正文可能出错。
- 角色重新建档：第一步只为原文中登场、名册里没有的人物建档，名册已有的人物（含曾用名，以及用别称、昵称或身份称呼指代的同一人）不重复建档，每人附首次登场的原句和各字段的原句；第二步只输出需要改动的字段，写改动后的完整内容并附摘录原句，摘录没有依据的不改也不清空。两步都不记位置、关系、着装、伤情和好感，原句由代码逐句核对。

## 说明

导出不请求模型。升级后旧摘要和 L1/L2 无需全部重新摘要，新生成的内容才使用新版提示词；只有需要重做某条旧摘要时，才对该楼手动重新摘要。

单楼摘要、合并摘要、总结、二次总结、世界书建议、回看原文补档案和角色重新建档开头的「内容边界」是否发送，在「设置 → 提示词 → 自定义提示词 → 内容边界」中选择；设置里的内置文本和这里的导出都按完整版显示。默认「自动」：DeepSeek 系列模型（模型名里含 deepseek，不区分大小写，带平台前缀或后缀的也算）不发送，沿用原来的规则，其他模型发送；单楼摘要、合并摘要、回看原文补档案和角色重新建档按「摘要使用」的模型判断，总结和二次总结按「总结使用」的模型判断（跟随主 API 时为酒馆当前选中的模型），世界书建议按世界书所用 API 的模型判断。也可以选「始终发送」或「不发送」，不看模型名。自己模板里写的内容边界不受这一项影响。检索改写（06、07）以及创作规划、推进条件检查、规划讨论和双子札记（13–16）不加内容边界；规划注入指引（19）随正文一起发给正文模型，同样不加。创作规划和推进条件检查的请求也不带任务说明，需要时可以把相应的要求写进 13、14 的自定义文本。
`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs', 'prompts'));
const server = await createServer({ root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
try {
  const p = await server.ssrLoadModule('/src/memory/prompts.ts');
  const compact = await server.ssrLoadModule('/src/memory/promptsCompact.ts');
  const settings = await server.ssrLoadModule('/src/api/settings.ts');
  const t = await server.ssrLoadModule('/src/memory/timeTag.ts');
  const ledger = await server.ssrLoadModule('/src/memory/ledgerProtocol.ts');
  const worldbook = await server.ssrLoadModule('/src/worldbook/prompt.ts');
  const outline = await server.ssrLoadModule('/src/outline/prompt.ts');
  const outlineContext = await server.ssrLoadModule('/src/outline/context.ts');
  const outlineInjection = await server.ssrLoadModule('/src/outline/injection.ts');
  const discussion = await server.ssrLoadModule('/src/outline/discussionContext.ts');
  const notes = await server.ssrLoadModule('/src/notes/prompt.ts');
  const recall = await server.ssrLoadModule('/src/memory/vector/recall.ts');
  const refile = await server.ssrLoadModule('/src/memory/npcRefile.ts');
  const selfCheck = await server.ssrLoadModule('/src/memory/summarySelfCheck.ts');
  // 摘要、总结、二次总结、时间标签和合并摘要各有两版内置文本：不带后缀的文件是默认版本，另一版在文件名后注明。
  const def = settings.DEFAULT_PROMPT_STYLE;
  const alt = def === 'compact' ? 'classic' : 'compact';
  const altName = name => name.replace(/\.txt$/, alt === 'classic' ? '（旧版）.txt' : '（精简版）.txt');
  const versions = {
    '01-摘要提示词.txt': { classic: p.SUMMARY_PROMPT, compact: p.SUMMARY_PROMPT_COMPACT },
    '02-总结提示词.txt': { classic: p.RESUMMARY_PROMPT, compact: p.RESUMMARY_PROMPT_COMPACT },
    '03-二次总结提示词.txt': { classic: p.RESUMMARY2_PROMPT, compact: p.RESUMMARY2_PROMPT_COMPACT },
    '05-时间标签指令.txt': { classic: t.TIME_TAG_PROMPT, compact: t.TIME_TAG_PROMPT_COMPACT },
    '10-批量补摘合并摘要.txt': { classic: p.BATCH_SUMMARY_PROMPT, compact: p.BATCH_SUMMARY_PROMPT_COMPACT },
  };
  const templates = {
    ...Object.fromEntries(Object.entries(versions).flatMap(([name, text]) => [[name, text[def]], [altName(name), text[alt]]])),
    '04-任务说明-旧破限.txt': p.JAILBREAK_PROMPT,
    '06-检索重写系统.txt': p.QUERY_REWRITE_SYSTEM,
    '07-检索重写尾部.txt': p.QUERY_REWRITE_TAIL,
    '11-世界书建议.txt': worldbook.worldbookPromptExport(),
    '12-回看原文补档案.txt': p.NPC_ENRICH_PROMPT,
    '13-创作规划生成.txt': '===== 可以自定义的规划要求（OUTLINE_GUIDE）=====\n' + outline.OUTLINE_GUIDE
      + '\n\n===== 固定接在后面的输出格式（OUTLINE_FORMAT，不能自定义）=====\n' + outline.OUTLINE_FORMAT
      + '\n\n===== 一键生成时代替创作要求的说明（AUTO_OUTLINE_REQUEST）=====\n' + outlineContext.AUTO_OUTLINE_REQUEST,
    '14-推进条件检查.txt': '===== 可以自定义的判断标准（OUTLINE_PROGRESS_GUIDE）=====\n' + outline.OUTLINE_PROGRESS_GUIDE
      + '\n\n===== 固定接在后面的输出格式（OUTLINE_PROGRESS_FORMAT，不能自定义）=====\n' + outline.OUTLINE_PROGRESS_FORMAT,
    '15-规划讨论.txt': discussion.DISCUSSION_PROMPT,
    '16-双子札记整理版.txt': notes.TIDY_NOTES_PROMPT,
    '17-角色重新建档.txt': refile.NPC_REFILE_PROMPT,
    '18-总结写完后核对.txt': selfCheck.SELF_CHECK_RULES + '\n\n===== 发送时的材料格式（SELF_CHECK_INPUT）=====\n' + selfCheck.SELF_CHECK_INPUT + '\n\n===== 材料之后的检查块写法（SELF_CHECK_NOTE）=====\n' + selfCheck.SELF_CHECK_NOTE,
    '19-规划注入指引.txt': '===== 可以自定义的写作要求（OUTLINE_GUIDANCE_TEMPLATE）=====\n' + outlineInjection.OUTLINE_GUIDANCE_TEMPLATE
      + '\n\n===== ' + outlineInjection.OUTLINE_PACE_MACRO + ' 在三种推进节奏下换成的句子（PACE_RULE）=====\n'
      + [['慢', 'slow'], ['适中', 'normal'], ['快', 'fast']].map(([label, pace]) => label + '：' + outlineInjection.PACE_RULE[pace]).join('\n')
      + '\n\n===== 插件固定生成的部分（示意：第二行是写作要求的位置，规划内容用省略号代替；推进节奏为「适中」时）=====\n' + outlineInjection.outlineGuidanceLayout()
      + '\n\n===== 「剧情要点」标题括号里的文字在三种推进节奏下的写法（PACE_BEATS）=====\n'
      + [['慢', 'slow'], ['适中', 'normal'], ['快', 'fast']].map(([label, pace]) => label + '：' + outlineInjection.PACE_BEATS[pace]).join('\n'),
  };
  const internalNames = ['THINKING_CHECKLIST', 'THINKING_PREFILL', 'RESUMMARY_THINKING_CHECKLIST', 'RESUMMARY_THINKING_PREFILL', 'BATCH_SUMMARY_THINKING_CHECKLIST', 'RULE_CONTENT_BOUNDARY', 'MEMORY_BRIEFING_NOTE', 'MEMORY_BRIEFING_END', 'MEMORY_BRIEFING_HISTORY_END', 'TIME_RULE_WITH_TAGS', 'TIME_RULE_NO_TAGS', 'RULE_KNOWLEDGE'];
  for (const k of internalNames) if (typeof p[k] !== 'string' || !p[k].trim()) throw new Error('导出项为空: ' + k);
  if (typeof recall.RECALL_BRIEFING_END !== 'string' || !recall.RECALL_BRIEFING_END.trim()) throw new Error('导出项为空: RECALL_BRIEFING_END');
  // 精简版的核对步骤、时间规则、可选规则，以及总结、二次总结的篇幅说明（填进 {{length_rule}} 和接在核对步骤后面的那一句）
  const compactNames = ['COMPACT_THINKING_CHECKLIST', 'COMPACT_THINKING_PREFILL', 'COMPACT_KNOWLEDGE_CHECK', 'COMPACT_RESUMMARY_CHECKLIST', 'COMPACT_RESUMMARY2_CHECKLIST', 'COMPACT_BATCH_THINKING_CHECKLIST', 'COMPACT_TIME_RULE_WITH_TAGS', 'COMPACT_TIME_RULE_NO_TAGS', 'COMPACT_TIME_CHECK', 'COMPACT_RULE_KNOWLEDGE', 'COMPACT_RULE_VARS',
    'COMPACT_LENGTH_RULE', 'COMPACT_LENGTH_NOTE', 'COMPACT_LENGTH_RULE_SHORT', 'COMPACT_LENGTH_NOTE_SHORT', 'COMPACT_LENGTH_RULE2', 'COMPACT_LENGTH_NOTE2', 'COMPACT_LENGTH_RULE2_SHORT', 'COMPACT_LENGTH_NOTE2_SHORT'];
  for (const k of compactNames) if (typeof compact[k] !== 'string' || !compact[k].trim()) throw new Error('导出项为空: ' + k);
  templates['08-作者用-代码内置协议.txt'] = internalNames.map(k => '===== ' + k + ' =====\n' + p[k]).join('\n\n') + '\n\n' + compactNames.map(k => '===== ' + k + '（精简版） =====\n' + compact[k]).join('\n\n') + '\n\n===== RECALL_BRIEFING_END（向量召回块的结束语）=====\n' + recall.RECALL_BRIEFING_END + '\n\n===== LEDGER_PROTOCOL =====\n' + ledger.LEDGER_PROTOCOL;
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
