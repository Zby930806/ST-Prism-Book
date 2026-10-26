import { getContext } from '@/st/context';
import { normalizeTemplate, type VarTemplate } from '@/memory/types';
import { reactive, watch } from 'vue';
import { DEFAULT_RECALL_INJECTION_DEPTH, normalizeRecallInjectionDepth } from '@/memory/vector/depth';
import { normalizeQueryRewriteContextChars, QUERY_REWRITE_CONTEXT_DEFAULT } from '@/memory/vector/params';
import { normalizeSavedTimeTag } from '@/memory/timeTagMigration';

/**
 * 副 API 设置(全局,跨聊天)。存进 ST 的 extension_settings(→ 服务器 settings.json),
 * 因而跨设备同步:手机/局域网另一端打开同一 ST 账户即可见到同一份设置。
 * (旧版本曾存浏览器 localStorage,只在本机生效;见 hydrateSettings 的一次性迁移。)
 * 渠道可配多个;两类摘要任务各指派一个渠道:summary=摘要,resummary=总结。
 */

export interface ApiChannel {
  id: string;
  /** 显示名 */
  name: string;
  /** OpenAI 兼容的 base url,如 https://api.openai.com/v1 */
  url: string;
  /** 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token */
  maxTokens: number;
  /** 单次请求超时(秒)。超过后主动中断;每个渠道独立配置,默认 180 秒。 */
  timeoutSec: number;
  /** 流式传输(默认关);开启后按 SSE 增量拼接 */
  stream: boolean;
  /**
   * 发送预填充(默认关)。打开后摘要/批量请求末尾带一条 assistant 预填充消息,引导模型从思维链续写、
   * 并压制拒答。Claude 等原生支持预填充的后端收益明显;很多端点要求「最后一条必须是 user」
   * 或为纯 OpenAI 端点(预填充不被续写、形同浪费),所以默认不发——关着只是不发那条尾 assistant,
   * 思维链引导仍由 system 检查清单承担,不影响功能。 */
  prefill: boolean;
  /** 排除参数:这些字段名会在构造请求体时从 body 中删除,
   *  用于规避不接受某些参数(如 temperature/max_tokens)的兼容端点报错。 */
  excludeParams: string[];
  /**
   * 思考强度(推理模型的 reasoning_effort)。空串 = auto = 不发这个参数(默认,老渠道即此值)。
   *
   * 取值不做白名单校验,原样发给端点:各家词汇不统一(OpenAI 的 minimal/low/medium/high/xhigh、
   * 部分中转站的 max/none……),中转站比我们更清楚自己的模型吃什么,校验只会误伤。
   *
   * 非空时整条请求改走 custom 源(见 api/client.ts 的 buildRequestBody):
   * ST 代理对 openai 源的 reasoning_effort 有**模型名白名单**(src/constants.js 的
   * OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),模型名对不上就**静默丢弃且照样返回 200**——
   * 用户设了却毫无效果、还看不出来。custom 源的 custom_include_body 是纯 merge,不过白名单。
   *
   * 跨插件:与柏宝绘/柏宝砚共享同一份渠道(baibai_api_channels),三家字段名一致。
   */
  reasoningEffort: string;
}

export type TaskType = 'summary' | 'resummary';

/** 自定义提示词:空串表示沿用 prompts.ts 内置模板,非空则整体覆盖该任务的模板。 */
export interface CustomPrompts {
  summary: string;
  /** 普通总结(L0 叶子 → L1):把多条楼层摘要压成一条 L1 总结。 */
  resummary: string;
  /** 二次总结(L1+ → 更上层):把多条总结再压一层,字数按输入规模动态放宽以少丢信息。 */
  resummary2: string;
  /** 自定义中性任务说明(旧字段名保留兼容);是否发送由 taskContextMode 决定。 */
  jailbreak: string;
  /** 固定提示词(时间标签):注入**主对话**模型,要求每条正文前后输出时间标签;空=用内置默认。 */
  timeTag: string;
}

/**
 * 单个向量角色的端点配置(扁平:自带地址+密钥+模型,不再经「渠道」中转)。
 * embedding 为基准必填;rerank/queryRewrite 的 url 留空 = 整体复用 embedding 的端点与模型。
 */
export interface VectorEndpoint {
  /** OpenAI 兼容 base url(如 https://api.openai.com/v1);rerank/query 留空=复用 embedding */
  url: string;
  /** API 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 单次请求超时(秒)。超时即中断该次请求;各角色默认不同(见 defaults),不随地址复用回落。 */
  timeoutSec: number;
  /** 失败自动重试次数:仅超时/网络异常/服务端 5xx/限流 429 才重试;4xx 不重试。非负整数。 */
  retries: number;
}

/**
 * 召回参数。召回管线:
 *  ① 所有向量索引各算一次 embedding 相似度,**纯按得分排序取前 N(rerankCandidates)进入 rerank**——
 *     这一步不套 embedding 阈值,哪怕前 N 全是低分(0.4/0.3…)也照样进候选;阈值只在 ② 的摘要档准入用。
 *  ② rerank 打分后分两档:
 *     · 全文档 = rerank 得分 ≥ rerankThreshold,取前 fullTextCount 条(发原文全文);
 *     · 摘要档 = rerank 得分 < rerankThreshold 但 embedding 得分 ≥ embeddingThreshold(发叶子摘要);
 *  ③ 最终召回条数 ≤ finalRecallCount(上限):先放全文档,不足再用摘要档补,补不满也无妨。
 */
export interface VectorRecallSettings {
  /** 召回内容注入深度:D0 最贴近最新输入,数字越大越靠前。 */
  injectionDepth: number;
  /** 进入 rerank 的候选数:纯按 embedding 相似度取 top-N(不套阈值过滤) */
  rerankCandidates: number;
  /** embedding 相似度阈值:仅用于 ② 摘要档准入门槛(低于此连摘要都不召回);不影响 ① 取候选 */
  embeddingThreshold: number;
  /** rerank 得分阈值:≥ 进全文档,< 退摘要档 */
  rerankThreshold: number;
  /** 召回全文数:全文档取前 N 条(发原文) */
  fullTextCount: number;
  /** 最终召回条数(上限):全文档 + 摘要档合计不超过它 */
  finalRecallCount: number;
  /**
   * 召回起始 AI 楼数:当前聊天 AI 消息数少于此值时**不触发召回**(0=不限制)。
   * 用 AI 消息数计(与 keepRecent 同口径),避免和「楼层」混淆。
   * 早期剧情还没多少旧记忆可召,跳过可省额度/延迟;「带数据建新对话」的旧档不受此限(始终召回)。
   */
  minAiFloors: number;
  /** 关键词召回:用名册、物品、地点的名字精确匹配本聊天摘要,作为一路与向量检索融合。默认开。 */
  keywordRoute: boolean;
  /** 在场角色加权:候选摘要涉及当前在场角色时排序靠前(不改变分档阈值)。默认开。 */
  presentBoost: boolean;
  /** 召回保留轮数:上一轮注入的段落在之后 N 轮内,有空位时以摘要形式保留。0=关(默认)。 */
  stickyTurns: number;
}

/** 向量记忆设置。embedding 为基准,rerank/queryRewrite 的 url 留空则整体复用 embedding。 */
export interface VectorSettings {
  /** 向量记忆开关 */
  enabled: boolean;
  /** 文本向量化端点(基准,必填) */
  embedding: VectorEndpoint;
  /** 重排端点;url 留空复用 embedding */
  rerank: VectorEndpoint;
  /** 查询重写端点;url 留空复用 embedding */
  queryRewrite: VectorEndpoint;
  /** 查询重写请求是否置顶注入任务说明(system;遵循默认/自定义/禁用模式)。默认关。 */
  queryRewriteJailbreak: boolean;
  /** 查询重写单次最大输出 token(三角色里仅它生成文本;够放 INTENT + 多条 Q 即可,偏小会截断)。默认 8192。 */
  queryRewriteMaxTokens: number;
  /**
   * 查询重写附带上下文(历史摘要、最近几楼全文、状态快照)的字数上限,超出时按新近和相关程度精简。
   * 默认 16000;0 = 不限制(1.4.0 及以前的做法,上下文两三万字时重写明显变慢)。
   */
  queryRewriteContextChars: number;
  /** 召回参数(候选数/阈值/条数) */
  recall: VectorRecallSettings;
}

/** 界面偏好里要跨设备同步的部分(主题/导航位置);activePage 等纯本机临时态不在此。 */
export interface UiPrefs {
  /** 主题名(合法值见 state/ui.ts 的 THEMES;这里只存字符串,避免 settings 反向依赖 ui) */
  theme: string;
  /** 导航位置:top/bottom/auto */
  navPosition: string;
  /** 移动端:再点当前页导航按钮即关闭整窗。默认开;怕误触的用户可关。 */
  navTapClose: boolean;
  /** 在 ST 顶栏注入一个快速打开按钮(魔杖菜单入口照旧保留)。默认关。 */
  showTopBar: boolean;
  /** 在聊天框上方注入「快速回复」式按钮,点击打开棱镜宝书。默认关。 */
  showQuickReply: boolean;
  /** 开了向量记忆时,在快捷回复栏放一个「召回」按钮:显示上次召回了几段,点开看召回了什么。默认开。 */
  showRecallQuickReply: boolean;
  /** 在每条 AI 楼层内注入摘要锚点(查看该楼摘要数据 + 标记番外)。默认关。 */
  showFloorPanel: boolean;
  /** 屏幕边缘悬浮球,点击打开棱镜宝书。默认关。 */
  showOrb: boolean;
  /** 悬浮球自定义图标:ST 服务器图片路径(saveBase64AsFile 返回的短串);空=用默认书签图标。跨设备同步。 */
  orbImage: string;
  /** 悬浮球形状:bookmark 书签(默认)/ circle 圆 / square 方。 */
  orbShape: string;
  /** 悬浮球静止时不透明度(百分比 20–100,默认 62)。唤起/拖动时一律全显。 */
  orbOpacity: number;
  /** 悬浮球基准尺寸(px,32–80,默认 48)。书签按比例放宽高,圆/方为等边边长。 */
  orbSize: number;
}

/** 字数详尽档位:detailed=详细(默认),concise=精简(总结/二次总结字数一并降低)。仅影响内置模板。 */
export type Verbosity = 'detailed' | 'concise';

/** 每楼摘要字数要求(含标点)的默认值与可设范围。 */
export const SUMMARY_MAX_CHARS_DEFAULT = 300;
export const SUMMARY_MAX_CHARS_MIN = 50;
export const SUMMARY_MAX_CHARS_MAX = 2000;

/**
 * 规整每楼摘要字数要求:钳到可设范围内的整数。
 * 缺失或非法时按档位推导(精简 150,其余 300),与旧版内置上限一致,老用户升级后篇幅不变。
 */
export function normalizeSummaryMaxChars(value: unknown, verbosity: Verbosity = 'detailed'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return verbosity === 'concise' ? 150 : SUMMARY_MAX_CHARS_DEFAULT;
  return Math.min(SUMMARY_MAX_CHARS_MAX, Math.max(SUMMARY_MAX_CHARS_MIN, Math.round(value)));
}

/** 召回保留轮数:0–5 的整数;缺失、非法或输入框暂时为空时按 0(关)。 */
export function normalizeStickyTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.floor(value)));
}

/** 跟随主 API 时的最大回复(tokens):默认值、可设范围,以及首次失败后重试用的值。 */
export const MAIN_API_MAX_TOKENS_DEFAULT = 32000;
export const MAIN_API_MAX_TOKENS_MIN = 1024;
export const MAIN_API_MAX_TOKENS_MAX = 200000;
export const MAIN_API_FALLBACK_TOKENS = 8192;

/** 规整跟随主 API 时的最大回复:钳到可设范围内的整数;缺失、非法或输入框暂时为空时按默认 32000。 */
export function normalizeMainApiMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAIN_API_MAX_TOKENS_DEFAULT;
  return Math.min(MAIN_API_MAX_TOKENS_MAX, Math.max(MAIN_API_MAX_TOKENS_MIN, Math.round(value)));
}

/** 非负整数:缺失、非法、负数或输入框暂时为空(v-model.number 写入空串)时按 fallback。 */
export function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 保留最近 AI 消息数:非负整数,缺失或非法时按默认 3(空串按 0 会把最近的回复也隐藏掉)。 */
export function normalizeKeepRecent(value: unknown): number {
  return normalizeNonNegativeInt(value, 3);
}

/**
 * 总结阈值(每次总结几条摘要、二次总结、高层总结):0 表示关闭,其余至少为 2。
 * 1 没有意义(引擎同样不总结),规整为 0;缺失或非法时按 fallback(各项默认值)。
 */
export function normalizeSummaryThreshold(value: unknown, fallback: number): number {
  const n = normalizeNonNegativeInt(value, fallback);
  return n === 1 ? 0 : n;
}

/** 记忆注入预算:0 = 不限制(默认);其他值钳到 2000–50000 的整数;缺失或非法时按 0。 */
export function normalizeMemoryBudgetTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value === 0 ? 0 : Math.max(2000, Math.min(50000, Math.round(value)));
}

/** 召回参数中会被清空或填错的数值项的默认值(与 defaults() 一致)。 */
const RECALL_NUMBER_DEFAULTS = {
  rerankCandidates: 20,
  embeddingThreshold: 0.8,
  rerankThreshold: 0.9,
  fullTextCount: 2,
  finalRecallCount: 5,
  minAiFloors: 30,
} as const;

/**
 * 规整召回参数里的候选数、两个阈值、全文数、最终条数与起始 AI 楼数(就地修改并返回同一对象):
 * 阈值须在 0–1 之间(误填成 80 这类百分数、空串或非数字时回退默认);
 * 候选数为正整数,全文数、最终条数与起始 AI 楼数为非负整数,非法时回退默认。
 */
export function normalizeRecallParams<T extends Partial<VectorRecallSettings>>(recall: T): T {
  const d = RECALL_NUMBER_DEFAULTS;
  const threshold = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : def);
  recall.rerankCandidates = Math.max(1, normalizeNonNegativeInt(recall.rerankCandidates, d.rerankCandidates));
  recall.embeddingThreshold = threshold(recall.embeddingThreshold, d.embeddingThreshold);
  recall.rerankThreshold = threshold(recall.rerankThreshold, d.rerankThreshold);
  recall.fullTextCount = normalizeNonNegativeInt(recall.fullTextCount, d.fullTextCount);
  recall.finalRecallCount = normalizeNonNegativeInt(recall.finalRecallCount, d.finalRecallCount);
  recall.minAiFloors = normalizeNonNegativeInt(recall.minAiFloors, d.minAiFloors);
  return recall;
}

/** 渠道采样温度:0–2 之间的有限数,缺失、非法或输入框暂时为空时按 1.0。 */
export function normalizeChannelTemperature(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1.0;
}

/** 渠道最大输出(tokens):至少为 1 的整数,缺失、非法或输入框暂时为空时按 65535。 */
export function normalizeChannelMaxTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 65535;
}

/** 渠道超时(秒):正整数,缺失、非法或输入框暂时为空时按 180。 */
export function normalizeChannelTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 180;
}

/** 合并摘要每次最多楼层数:1–30 的整数;缺失或非法按 10。上限防止一次输出几十条摘要被截断。 */
export function normalizeBatchMaxFloors(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 10;
  return Math.min(30, Math.floor(value));
}

/** 批量补摘中逐层完整摘要的最近楼层数:非负整数;缺失或非法按 20。 */
export function normalizeBatchFullRecent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 20;
  return Math.min(100000, Math.floor(value));
}

/**
 * 注入设置:各状态块是否注入**主模型**(生成正文的请求)。
 * 只影响 buildStateInjectionText;副 API 摘要始终看到全量状态、照常记录(防重复记录),不受此影响。
 * 依赖关系:NPC 名册的在场分档与物品清单的可达判定都走场景树,
 * 故 scenes 关闭时 npcs/items 实际不注入(界面同步置灰);主角状态自包含,不依赖场景。
 */
export interface InjectionSections {
  /** 眼下局势(sceneFocus 互动局势卡) */
  sceneFocus: boolean;
  /** 主角及主要角色的生活细节(仅控制注入;记录始终开启,无开关——不注入时记多少都不影响正文) */
  lifeDetails: boolean;
  /** 主角当前状态(性别/年龄/外貌/着装/状态) */
  protagonist: boolean;
  /** NPC 名册(依赖场景信息) */
  npcs: boolean;
  /** NPC 名册内的五档好感估计(内心好感/外在态度/说明);关闭后名册照发,只是不附带好感。
   *  适合角色卡自带好感系统、不想两套并行的场合。仅控制注入,记录与页面展示始终开启。 */
  npcAffinity: boolean;
  /** 物品清单(依赖场景信息) */
  items: boolean;
  /** 场景信息(当前地点+祖先链+其他已知地点);关闭后 NPC/物品随之不注入 */
  scenes: boolean;
  /** 信息差:提醒在场的不知情角色(依赖 NPC 名册的在场判定;仅控制注入,记录始终开启) */
  secrets: boolean;
  /** 伤势进展提醒:伤情记录满一天(无故事时间时按回复楼层数)未更新时,提醒正文模型按轻重体现进展(不改记录) */
  injuryReminder: boolean;
  /**
   * 角色对主角的了解清单,默认关闭。与其他项不同,它同时控制记录:关闭时摘要请求不带相关规则和材料,模型输出也不收;
   * 已有清单保留、照常重放。注入只看本项,不依赖 NPC 名册和场景信息(在场判定读的是记忆数据,不是注入文本)。
   */
  knowledge: boolean;
}

export interface ApiSettings {
  /** 插件总开关。关闭后停止一切自动注入/摘要/总结/隐藏;ST 菜单入口仍在,可重新打开界面再开启。 */
  enabled: boolean;
  /** 界面偏好(主题/导航位置),随设置存进 extension_settings → 跨设备同步 */
  ui: UiPrefs;
  /** 自定义提示词模板(空=用内置) */
  prompts: CustomPrompts;
  /**
   * 每份自定义提示词是照着哪一版内置改的:保存自定义时记下当时的内置全文。
   * 内置更新后,设置页据此标出「内置已更新」并列出内置改了什么;没记录的(旧版本里改的)只能和现在的内置对比。
   */
  promptBases: Partial<Record<keyof CustomPrompts, string>>;
  /** 任务说明三态;旧 jailbreak 字段保留作自定义内容。 */
  taskContextMode: 'default' | 'custom' | 'disabled';
  /** 主对话四类记忆槽的总估算token预算,0=不限(默认);不是模型精确token数。 */
  memoryBudgetTokens: number;
  /** 预算默认值改为不限制时的一次性迁移标记:旧版本按原默认值保存的 6000 改成 0,之后用户自己填的值不再改动。 */
  memoryBudgetMigrated: boolean;
  /** 内置模板的字数详尽档位:详细/精简,管总结与二次总结的篇幅。自定义模板不受影响。 */
  verbosity: Verbosity;
  /** 向量记忆配置 */
  vector: VectorSettings;
  channels: ApiChannel[];
  /** 各任务指派的渠道 id */
  assignments: Record<TaskType, string>;
  /** 自动摘要开关。开启即一并启用:自动隐藏、正文时间标签、积压拦截(不再各自独立开关)。 */
  autoSummaryEnabled: boolean;
  /**
   * 回复结束后立即摘要(默认关):AI 回复生成结束就摘这条回复,不等发送下一条消息。
   * 之后重抽/翻页生成新回复时,旧回复的摘要作废、新回复结束后重摘;续写或编辑后按新内容重写。需开启自动摘要。
   */
  summarizeOnReplyEnd: boolean;
  /**
   * 仅摘要模式。继续分析、保存结构化状态,但不向主模型注入当前状态,
   * 也不再把物品/变量变动旁注写回正文。已有正文旁注不主动清理。
   */
  summaryOnlyMode: boolean;
  /** 注入设置:各状态块是否注入主模型(仅摘要模式开启时整组不生效) */
  injection: InjectionSections;
  /** 保留最近 N 条 AI 消息发全文(滑动窗口);更早的自动摘要并隐藏 */
  keepRecent: number;
  /** 排除的角色名:这些名字(含重名卡)的聊天里,记忆系统所有功能都不生效 */
  excludedChars: string[];
  /** 摘要/总结时**整本排除**的世界书文件名:这些书的所有激活条目都不进摘要上下文。
   *  用于全局挂载的附加知识书等——它们对当前剧情摘要无用,排除可省 token。仅影响副API。 */
  excludedWorldNames: string[];
  /** 摘要/总结时按**条目名(comment)**过滤的规则:命中任一规则的条目不进摘要上下文。
   *  每条当正则编译(普通名字天然=包含匹配),编译失败降级为字面子串包含。仅影响副API。 */
  excludedWorldInfoPatterns: string[];
  /** 内置默认条目名规则是否已「播种」进上面的列表(见 DEFAULT_WI_PATTERNS / hydrateSettings)。
   *  只发放一次:老用户首次载入时补进默认规则并置 true;之后用户删空也不再补回,尊重其选择。 */
  wiPatternsSeeded: boolean;
  /** 渲染世界书模板(默认开):摘要副 API 取世界书条目前,先展开 {{宏}} 并执行 ST-Prompt-Template 的
   *  EJS(<% %>),让「按好感度切换人设」等动态条目拿到成品而非原文。副作用:含写变量的 EJS 每次摘要
   *  都会额外执行一次,污染变量状态——遇到这类世界书可关掉。未装 ST-Prompt-Template 时仅展开宏。 */
  renderWorldInfoTemplates: boolean;
  /** 叶子摘要积累到 N 条时,压成一条 L1 总结(L0→L1 阈值,0=关闭) */
  leafBatchThreshold: number;
  /**
   * 总结时**在叶子层保留最近 N 条摘要不压缩**(仅 L0→L1 生效,不影响更高层)。
   * 作用:压缩把一批叶子塌成一段 L1 后,注入端只走「根」——被收纳的叶子不再单独注入,
   * 细颗粒会一次性丢失(用户实测的「断崖」)。留一截最新叶子当根,注入端始终有细节兜底。
   * 机制:触发门槛抬到 `leafBatchThreshold + leafKeepRecent`,但每次仍只压最旧的
   * `leafBatchThreshold` 条(不改总结质量),newest 的 N 条自然留下。
   * 0=保持旧行为(攒够即全压);默认 3。设太大 = 迟迟不压、叶子堆积。 */
  leafKeepRecent: number;
  /** L1 每积累到 N 条时,压成一条 L2 总结(L1→L2 阈值,0=关闭) */
  resummaryThreshold: number;
  /** L2 及以上每积累到 N 条时,压成上一层总结(L≥2→L+1 阈值,0=关闭) */
  higherResummaryThreshold: number;
  /** 状态快照里附带「近期已完成计划/悬念」的条数:**计划、悬念各取最近 N 条**(0=不附带)。
   *  防 AI 把刚了结的计划当未完成又去推进/重新 add;注入与副API摘要两端同口径附带。 */
  recentResolvedPlansCount: number;
  /** 摘要/总结失败(请求报错或 JSON 解析失败)的最大重试次数。0=不重试;默认 1(最多再试一次)。 */
  summaryMaxRetries: number;
  /**
   * 跟随主 API(未给摘要/总结指派副 API 渠道)时,请求期间临时设置的主 API 最大回复(tokens)。
   * 酒馆的 generateRaw 会把它原样作为 max_tokens 发给服务商,超过模型的输出上限会被拒绝。
   * 默认 32000,可设 1024–200000;首次失败时改用 8192 重试一次(见 client.ts 的 requestViaMainApi)。
   */
  mainApiMaxTokens: number;
  /** 跟随主 API 时保留摘要、总结请求末尾的 assistant 预填充消息。默认开(与旧版本相同);接口不接受时关闭。 */
  mainApiPrefill: boolean;
  /**
   * 回看原文补全角色档案(默认开):摘要时新登场或被提到的角色缺外貌、身份或性别,
   * 到之前的楼层找原文补全,每次多发一个请求。关闭后自动补档不发请求,已补好的结果保持不变;
   * 角色卡上的「从原文补全」不受影响。
   */
  npcEnrichAuto: boolean;
  /** 每楼摘要字数要求(含标点),写进内置摘要提示词。只是给模型的要求:写超了照常保存,不因此判失败。 */
  summaryMaxChars: number;
  /** 批量补摘「较早楼层合并摘要」时，一次请求的原文字数上限(清洗后);超出就分到下一次。 */
  batchMaxChars: number;
  /** 批量补摘「较早楼层合并摘要」时，一次请求最多合并的楼层数(1–30)。 */
  batchMaxFloors: number;
  /** 批量补摘「较早楼层合并摘要」时，最近 N 层 AI 回复仍逐层完整摘要(记录状态);更早的才合并。0=全部合并。 */
  batchFullRecent: number;
  /**
   * 用户自定义「整块删除」标签名(只填标签名,不带尖括号,如 snow)。清洗正文时
   * `<snow>…</snow>` 连同内部内容一并删掉。用于剔除其它插件/世界书写进正文的状态栏、
   * 旁注等格式。改动对**召回时**即时生效(向量库存的是原文,召回再清洗),无需重建索引。
   */
  customStripTags: string[];
  /** 全局变量模板:所有角色所有聊天共享的初始 JSON 结构 + 说明(值仍每聊天独立)。见 memory 的 VarTier。 */
  varsGlobalTemplate: VarTemplate;
  /** 角色变量模板:键=角色卡 avatar 文件名,值=该角色所有聊天共享的初始模板(值仍每聊天独立)。 */
  varsTemplateByChar: Record<string, VarTemplate>;
}

// extension_settings 里的命名空间键;localStorage 是旧版残留,仅用于一次性迁移。
// 三个键都导出给设置备份(settingsBackup.ts)按键名收集。
export const SETTINGS_KEY = 'baibai_book';
export const SHARED_CHANNELS_KEY = 'baibai_api_channels';
const SHARED_CHANNELS_EVENT = 'st-baibai-api-channels:changed';
const SHARED_CHANNELS_SCHEMA_VERSION = 1;

/* —— 排除设置共享存储:与柏宝绘等「柏宝」插件共用同一份排除名单(渠道同款协议) ——
   真身存在 extensionSettings[SHARED_EXCLUDES_KEY](带 revision),各插件的设置里只留镜像。
   任一端写入后广播事件,其他端收到后从 extensionSettings 重读并应用,实现跨插件实时同步。
   双端语义一致:排除角色=功能停用、整本/条目名排除=副API世界书过滤、清洗标签=正文整块删除。 */
export const SHARED_EXCLUDES_KEY = 'baibai_exclude_settings';
const SHARED_EXCLUDES_EVENT = 'st-baibai-exclude-settings:changed';
const SHARED_EXCLUDES_SCHEMA_VERSION = 1;

interface SharedChannelsStore {
  schemaVersion: number;
  revision: number;
  channels: ApiChannel[];
}

interface SharedExcludesStore {
  schemaVersion: number;
  revision: number;
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  customStripTags: string[];
}

/** 条目名过滤的内置默认规则:首次载入时「播种」进用户列表(见 hydrateSettings),之后用户可自由增删。
 *  \[mvu…\] = 过滤变量框架 MVU 的机制条目(对剧情摘要是纯噪音)。大小写不敏感(engine 编译带 i)。 */
const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];
/** 注入预算原来的默认值;首次载入时把按它保存的设置改为不限制(见 hydrateSettings)。 */
const LEGACY_MEMORY_BUDGET_DEFAULT = 6000;
const LEGACY_STORAGE_KEY = 'bbs.api.v1';
// 旧版界面偏好(主题/导航位置/分页)曾单独存这里;现把主题+导航迁进 ui,分页仍留本机(见 state/ui.ts)。
const LEGACY_UI_STORAGE_KEY = 'bbs.ui.v1';

/** 从旧 localStorage(bbs.ui.v1)取出主题/导航位置,填进 target.ui。仅在 server 尚无 ui 时调用一次。 */
function migrateLegacyUiPrefs(target: ApiSettings): void {
  try {
    const raw = localStorage.getItem(LEGACY_UI_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Partial<UiPrefs>;
    if (typeof obj.theme === 'string') target.ui.theme = obj.theme;
    if (typeof obj.navPosition === 'string') target.ui.navPosition = obj.navPosition;
  } catch {
    /* 解析失败则维持默认,不阻断 */
  }
}

function defaults(): ApiSettings {
  return {
    enabled: true,
    ui: {
      theme: 'day',
      navPosition: 'auto',
      navTapClose: true,
      showTopBar: false,
      showQuickReply: false,
      showRecallQuickReply: true,
      showFloorPanel: false,
      showOrb: false,
      orbImage: '',
      orbShape: 'bookmark',
      orbOpacity: 62,
      orbSize: 48,
    },
    prompts: { summary: '', resummary: '', resummary2: '', jailbreak: '', timeTag: '' },
    promptBases: {},
    taskContextMode: 'default',
    memoryBudgetTokens: 0,
    memoryBudgetMigrated: false,
    verbosity: 'detailed',
    vector: {
      enabled: false,
      // 默认填硅基流动地址 + 各角色模型,用户只需在 embedding 填一次 key 即可跑通:
      // rerank/queryRewrite 的 url/key 留空会回落复用 embedding 的(见 resolveVectorModel)。
      embedding: { url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-Embedding-8B', timeoutSec: 10, retries: 1 },
      rerank: { url: '', key: '', model: 'Qwen/Qwen3-Reranker-4B', timeoutSec: 20, retries: 1 },
      queryRewrite: { url: '', key: '', model: 'Qwen/Qwen3.5-27B', timeoutSec: 90, retries: 1 },
      queryRewriteJailbreak: false,
      queryRewriteMaxTokens: 8192,
      queryRewriteContextChars: QUERY_REWRITE_CONTEXT_DEFAULT,
      recall: {
        injectionDepth: DEFAULT_RECALL_INJECTION_DEPTH,
        rerankCandidates: 20,
        embeddingThreshold: 0.8,
        rerankThreshold: 0.9,
        fullTextCount: 2,
        finalRecallCount: 5,
        minAiFloors: 30,
        keywordRoute: true,
        presentBoost: true,
        stickyTurns: 0,
      },
    },
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: true,
    summarizeOnReplyEnd: false,
    summaryOnlyMode: false,
    injection: { sceneFocus: true, lifeDetails: true, protagonist: true, npcs: true, npcAffinity: true, items: true, scenes: true, secrets: true, injuryReminder: true, knowledge: false },
    keepRecent: 3,
    excludedChars: [],
    excludedWorldNames: [],
    // 空起步:内置默认规则(DEFAULT_WI_PATTERNS)由 hydrateSettings「播种」发放,只发一次。
    // 这样老用户(已存过空数组)也能补到默认,且用户删空后不会被反复塞回。
    excludedWorldInfoPatterns: [],
    wiPatternsSeeded: false,
    renderWorldInfoTemplates: true,
    leafBatchThreshold: 12,
    leafKeepRecent: 3,
    resummaryThreshold: 6,
    higherResummaryThreshold: 3,
    recentResolvedPlansCount: 5,
    summaryMaxRetries: 1,
    mainApiMaxTokens: MAIN_API_MAX_TOKENS_DEFAULT,
    mainApiPrefill: true,
    npcEnrichAuto: true,
    summaryMaxChars: SUMMARY_MAX_CHARS_DEFAULT,
    batchMaxChars: 30000,
    batchMaxFloors: 10,
    batchFullRecent: 20,
    customStripTags: [],
    varsGlobalTemplate: { json: {}, meaning: '', rule: '' },
    varsTemplateByChar: {},
  };
}

/** 把任意来源的原始对象并入默认值,容错缺字段/类型不符。 */
function normalize(raw: unknown): ApiSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const merged = { ...d, ...(raw as Partial<ApiSettings>) };
  // prompts 是嵌套对象,展开合并不会补全缺字段,单独兜底(老数据没有 prompts 键时回退默认)
  merged.prompts = { ...d.prompts, ...((raw as Partial<ApiSettings>).prompts ?? {}) };
  merged.prompts.timeTag = normalizeSavedTimeTag(merged.prompts.timeTag);
  // 自定义提示词的基准版本:只留已知键的非空字符串;旧数据没有这个字段就是空对象(未记录)
  const rawBases = (raw as Partial<ApiSettings>).promptBases;
  merged.promptBases = {};
  if (rawBases && typeof rawBases === 'object') {
    for (const key of Object.keys(d.prompts) as Array<keyof CustomPrompts>) {
      const base = (rawBases as Record<string, unknown>)[key];
      if (typeof base === 'string' && base.trim()) merged.promptBases[key] = base;
    }
  }
  const savedMode = (raw as Partial<ApiSettings>).taskContextMode;
  merged.taskContextMode = savedMode === 'default' || savedMode === 'custom' || savedMode === 'disabled'
    ? savedMode : (typeof merged.prompts.jailbreak === 'string' && merged.prompts.jailbreak.trim() ? 'custom' : 'default');
  const budget = (raw as Partial<ApiSettings>).memoryBudgetTokens;
  merged.memoryBudgetTokens = normalizeMemoryBudgetTokens(budget);
  merged.memoryBudgetMigrated = (raw as Partial<ApiSettings>).memoryBudgetMigrated === true;
  // 总开关与几项模式开关:布尔,手改坏或类型不符时回退默认,不能把非空字符串当成「开」
  const rb = raw as Partial<ApiSettings>;
  merged.enabled = typeof rb.enabled === 'boolean' ? rb.enabled : d.enabled;
  merged.autoSummaryEnabled = typeof rb.autoSummaryEnabled === 'boolean' ? rb.autoSummaryEnabled : d.autoSummaryEnabled;
  merged.summaryOnlyMode = typeof rb.summaryOnlyMode === 'boolean' ? rb.summaryOnlyMode : d.summaryOnlyMode;
  // 保留窗口与总结阈值:输入框清空时会存成空串,按空串计算会隐藏全部已摘要楼层或停掉总结,这里回退默认;
  // 总结阈值 1 与 0 一样不会总结,统一存成 0(界面写「填 0 关闭」)
  merged.keepRecent = normalizeKeepRecent(rb.keepRecent);
  merged.leafBatchThreshold = normalizeSummaryThreshold(rb.leafBatchThreshold, d.leafBatchThreshold);
  merged.resummaryThreshold = normalizeSummaryThreshold(rb.resummaryThreshold, d.resummaryThreshold);
  // 跟随主 API 时的最大回复与预填充:旧数据没有这两项时按默认(32000、保留预填充)
  merged.mainApiMaxTokens = normalizeMainApiMaxTokens(rb.mainApiMaxTokens);
  merged.mainApiPrefill = typeof rb.mainApiPrefill === 'boolean' ? rb.mainApiPrefill : d.mainApiPrefill;
  // ui 同为嵌套对象,逐字段兜底(老数据没有 ui 键时回退默认,值非字符串时丢弃)
  const ru = ((raw as Partial<ApiSettings>).ui ?? {}) as Partial<UiPrefs>;
  merged.ui = {
    theme: typeof ru.theme === 'string' ? ru.theme : d.ui.theme,
    navPosition: typeof ru.navPosition === 'string' ? ru.navPosition : d.ui.navPosition,
    navTapClose: typeof ru.navTapClose === 'boolean' ? ru.navTapClose : d.ui.navTapClose,
    showTopBar: typeof ru.showTopBar === 'boolean' ? ru.showTopBar : d.ui.showTopBar,
    showQuickReply: typeof ru.showQuickReply === 'boolean' ? ru.showQuickReply : d.ui.showQuickReply,
    showRecallQuickReply: typeof ru.showRecallQuickReply === 'boolean' ? ru.showRecallQuickReply : d.ui.showRecallQuickReply,
    showFloorPanel: typeof ru.showFloorPanel === 'boolean' ? ru.showFloorPanel : d.ui.showFloorPanel,
    showOrb: typeof ru.showOrb === 'boolean' ? ru.showOrb : d.ui.showOrb,
    orbImage: typeof ru.orbImage === 'string' ? ru.orbImage : d.ui.orbImage,
    orbShape: typeof ru.orbShape === 'string' ? ru.orbShape : d.ui.orbShape,
    // 透明度:钳到 20–100,缺失/非法回退默认(太低会看不见,设 20 下限)
    orbOpacity:
      typeof ru.orbOpacity === 'number' && Number.isFinite(ru.orbOpacity)
        ? Math.min(100, Math.max(20, Math.round(ru.orbOpacity)))
        : d.ui.orbOpacity,
    // 尺寸:钳到 32–80,缺失/非法回退默认
    orbSize:
      typeof ru.orbSize === 'number' && Number.isFinite(ru.orbSize)
        ? Math.min(80, Math.max(32, Math.round(ru.orbSize)))
        : d.ui.orbSize,
  };
  // excludedChars 必须是字符串数组,旧值类型不符时回退空数组
  merged.excludedChars = Array.isArray(merged.excludedChars)
    ? merged.excludedChars.filter((x): x is string => typeof x === 'string')
    : [];
  // 排除世界书/条目名规则:字符串数组,去空,旧数据缺失/非法回退空数组
  merged.excludedWorldNames = Array.isArray(merged.excludedWorldNames)
    ? merged.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  merged.excludedWorldInfoPatterns = Array.isArray(merged.excludedWorldInfoPatterns)
    ? merged.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  // 播种标记:布尔,缺失(老数据无此键)回退 false,让 hydrateSettings 首次补发默认规则
  merged.wiPatternsSeeded = typeof merged.wiPatternsSeeded === 'boolean' ? merged.wiPatternsSeeded : false;
  // 渲染世界书模板:布尔,缺失(老数据无此键)回退 true(默认开,让动态世界书条目拿到成品)
  merged.renderWorldInfoTemplates =
    typeof merged.renderWorldInfoTemplates === 'boolean' ? merged.renderWorldInfoTemplates : true;
  // 注入设置:嵌套对象,逐字段兜底(老数据没有 injection 键时全回退 true = 老行为不变)
  const ri = ((raw as Partial<ApiSettings>).injection ?? {}) as Partial<InjectionSections>;
  merged.injection = {
    sceneFocus: typeof ri.sceneFocus === 'boolean' ? ri.sceneFocus : true,
    lifeDetails: typeof ri.lifeDetails === 'boolean' ? ri.lifeDetails : true,
    protagonist: typeof ri.protagonist === 'boolean' ? ri.protagonist : true,
    npcs: typeof ri.npcs === 'boolean' ? ri.npcs : true,
    npcAffinity: typeof ri.npcAffinity === 'boolean' ? ri.npcAffinity : true,
    items: typeof ri.items === 'boolean' ? ri.items : true,
    scenes: typeof ri.scenes === 'boolean' ? ri.scenes : true,
    secrets: typeof ri.secrets === 'boolean' ? ri.secrets : true,
    injuryReminder: typeof ri.injuryReminder === 'boolean' ? ri.injuryReminder : true,
    knowledge: ri.knowledge === true,
  };
  // vector 同为嵌套对象(且内含子对象),逐层兜底,老数据缺字段时回退默认。
  // 注:旧结构曾有 vector.channels + {channel,model};扁平化后弃用,逐角色按 url/key/model 兜底,
  // 老数据缺这些字段会回退空串(等于「未配置」,用户重填一次即可)。
  const rv = ((raw as Partial<ApiSettings>).vector ?? {}) as Partial<VectorSettings>;
  merged.vector = {
    ...d.vector,
    ...rv,
    embedding: normalizeVectorEndpoint(rv.embedding, d.vector.embedding),
    rerank: normalizeVectorEndpoint(rv.rerank, d.vector.rerank),
    queryRewrite: normalizeVectorEndpoint(rv.queryRewrite, d.vector.queryRewrite),
    recall: { ...d.vector.recall, ...(rv.recall ?? {}) },
  };
  merged.vector.enabled = typeof rv.enabled === 'boolean' ? rv.enabled : d.vector.enabled;
  // 召回注入深度:非负整数;老配置缺失、非法或输入框暂时为空时回退 D0。
  merged.vector.recall.injectionDepth = normalizeRecallInjectionDepth(merged.vector.recall.injectionDepth);
  // 候选数、两个阈值、全文数、最终条数、召回起始 AI 楼数(0=不限制):空串或越界时回退默认,
  // 否则空串参与比较会按 0 计算(最终条数为空时一段都不注入,阈值为空时全部放行)
  normalizeRecallParams(merged.vector.recall);
  // 关键词召回、在场角色加权:布尔,老数据缺失时按默认(开);保留轮数:0–5 的整数,缺失/非法回退 0
  merged.vector.recall.keywordRoute =
    typeof merged.vector.recall.keywordRoute === 'boolean' ? merged.vector.recall.keywordRoute : d.vector.recall.keywordRoute;
  merged.vector.recall.presentBoost =
    typeof merged.vector.recall.presentBoost === 'boolean' ? merged.vector.recall.presentBoost : d.vector.recall.presentBoost;
  merged.vector.recall.stickyTurns = normalizeStickyTurns(merged.vector.recall.stickyTurns);
  // 查询重写附加任务说明开关:布尔,缺失(老数据无此键)回退 false(默认不注入)
  merged.vector.queryRewriteJailbreak =
    typeof merged.vector.queryRewriteJailbreak === 'boolean' ? merged.vector.queryRewriteJailbreak : false;
  // 查询重写最大输出 token:正整数,下限 256(太小会截断 INTENT/Q),缺失/非法回退默认 8192
  merged.vector.queryRewriteMaxTokens =
    Number.isFinite(merged.vector.queryRewriteMaxTokens) && merged.vector.queryRewriteMaxTokens >= 256
      ? Math.floor(merged.vector.queryRewriteMaxTokens)
      : 8192;
  // 查询重写附带上下文上限:0 = 不限制,其余不小于 2000;老数据没有此键时用默认 16000(只压很长的上下文)
  merged.vector.queryRewriteContextChars = normalizeQueryRewriteContextChars(merged.vector.queryRewriteContextChars);
  // 副 API 渠道:逐个补全新加的字段(老数据没有 timeoutSec/stream/excludeParams),并校验类型
  merged.channels = (Array.isArray(merged.channels) ? merged.channels : []).map(normalizeChannel);
  // 字数档位:仅两个合法值,旧数据缺失/非法回退详细(= 老用户行为不变)
  merged.verbosity = merged.verbosity === 'concise' ? 'concise' : 'detailed';
  // 每楼摘要字数要求:旧数据没有这个字段时按原档位推导(精简 150,其余 300),升级后篇幅不变
  merged.summaryMaxChars = normalizeSummaryMaxChars((raw as Partial<ApiSettings>).summaryMaxChars, merged.verbosity);
  // 叶子层保留条数:非负整数,缺失/非法回退默认 3(0=旧行为攒够即全压)
  merged.leafKeepRecent =
    Number.isFinite(merged.leafKeepRecent) && merged.leafKeepRecent >= 0
      ? Math.floor(merged.leafKeepRecent)
      : 3;
  // 高层总结阈值:老配置没有该字段时补 3,避免 L2 继续按 7 条堆积成长文本;1 与 0 一样不会总结,存成 0
  merged.higherResummaryThreshold = normalizeSummaryThreshold(rb.higherResummaryThreshold, 3);
  // 近期已完成计划条数:非负整数,缺失/非法回退默认 5(计划/悬念各取 N;0=不附带)
  merged.recentResolvedPlansCount =
    Number.isFinite(merged.recentResolvedPlansCount) && merged.recentResolvedPlansCount >= 0
      ? Math.floor(merged.recentResolvedPlansCount)
      : 5;
  // 重试次数:非负整数,旧数据缺失/非法回退默认 1
  merged.summaryMaxRetries =
    Number.isFinite(merged.summaryMaxRetries) && merged.summaryMaxRetries >= 0
      ? Math.floor(merged.summaryMaxRetries)
      : 1;
  // 回看原文补全角色档案:布尔,旧数据没有这个键(或值非法)时按开启处理
  merged.npcEnrichAuto = typeof merged.npcEnrichAuto === 'boolean' ? merged.npcEnrichAuto : true;
  // 回复结束后立即摘要:布尔,缺失(老数据无此键)或类型不符时回退 false(默认在发送下一条时摘要)
  merged.summarizeOnReplyEnd = typeof merged.summarizeOnReplyEnd === 'boolean' ? merged.summarizeOnReplyEnd : false;
  // 批量补摘参数:正整数,缺失/非法回退默认值(下限 1,避免 0 导致永不切块/死循环)
  merged.batchMaxChars =
    Number.isFinite(merged.batchMaxChars) && merged.batchMaxChars >= 500
      ? Math.floor(merged.batchMaxChars)
      : 30000;
  merged.batchMaxFloors = normalizeBatchMaxFloors(merged.batchMaxFloors);
  merged.batchFullRecent = normalizeBatchFullRecent(merged.batchFullRecent);
  // 自定义清洗标签:容错用户连尖括号/斜杠一起填进来(<snow> / </snow>),只留合法标签名字符;
  // 去空、去重,缺失/非数组回退空数组。
  merged.customStripTags = Array.isArray(merged.customStripTags)
    ? Array.from(
      new Set(
        merged.customStripTags
          .filter((x): x is string => typeof x === 'string')
          .map(sanitizeTagName)
          .filter(Boolean),
      ),
    )
    : [];
  // 变量模板:全局深规整;角色按 avatar 键逐份规整(丢弃空模板的键,保持存储干净)
  merged.varsGlobalTemplate = normalizeTemplate((raw as Partial<ApiSettings>).varsGlobalTemplate);
  const rawByChar = (raw as Partial<ApiSettings>).varsTemplateByChar;
  const byChar: Record<string, VarTemplate> = {};
  if (rawByChar && typeof rawByChar === 'object') {
    for (const [k, v] of Object.entries(rawByChar)) {
      const tpl = normalizeTemplate(v);
      if (Object.keys(tpl.json).length || tpl.meaning.trim() || tpl.rule.trim()) byChar[k] = tpl; // 非空才留
    }
  }
  merged.varsTemplateByChar = byChar;
  return merged;
}

/**
 * 把用户输入规整成可安全拼进正则的标签名。
 * 用黑名单(而非白名单)剔除会破坏标签语法/正则的危险字符:尖括号、斜杠、空白、正则元字符;
 * 中文及其它 unicode 字母一律保留(用户可能写 <雪><状态栏> 这类中文标签)。
 */
export function sanitizeTagName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^<\/?/, '') // 开头的 < 或 </
    .replace(/>$/, '') // 结尾的 >
    .trim()
    .replace(/[<>/\\\s.*+?^${}()|[\]]/g, ''); // 剔除尖括号/斜杠/空白/正则元字符,中文等保留
}

/** 补全单个向量端点的字段并校验类型(缺失/类型不符回退空串)。 */
function normalizeVectorEndpoint(
  e: Partial<VectorEndpoint> | undefined,
  def: Pick<VectorEndpoint, 'timeoutSec' | 'retries'>,
): VectorEndpoint {
  const o = e ?? {};
  return {
    url: typeof o.url === 'string' ? o.url : '',
    key: typeof o.key === 'string' ? o.key : '',
    model: typeof o.model === 'string' ? o.model : '',
    // 超时/重试老数据可能缺:各角色默认值不同(embedding 10s / rerank 20s / query 90s),
    // 必须按传入的角色默认回退,不能统一回退一个值。
    timeoutSec:
      typeof o.timeoutSec === 'number' && Number.isFinite(o.timeoutSec) && o.timeoutSec > 0
        ? o.timeoutSec
        : def.timeoutSec,
    retries:
      typeof o.retries === 'number' && Number.isFinite(o.retries) && o.retries >= 0
        ? Math.floor(o.retries)
        : def.retries,
  };
}

/** 补全单个渠道的缺失字段(timeoutSec/stream/excludeParams 是后加的),并校验类型。 */
function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : `ch_${Date.now()}_${++chanSeq}`,
    name: typeof c.name === 'string' ? c.name : '新渠道',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    // 温度、最大输出、超时:非有限数(含输入框清空后存下的空串)回退默认,不把空串发给服务商
    temperature: normalizeChannelTemperature(c.temperature),
    maxTokens: normalizeChannelMaxTokens(c.maxTokens),
    timeoutSec: normalizeChannelTimeoutSec(c.timeoutSec),
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    // 流式与预填充默认都关(很多 OpenAI 兼容接口不接受末尾的 assistant 预填充);已保存的选择照旧
    prefill: typeof c.prefill === 'boolean' ? c.prefill : false,
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string')
      : [],
    // 后加字段:老渠道无此键 → 空串(auto,不发参数),行为与加字段前完全一致
    reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
  };
}

// import 阶段 ST 往往尚未就绪,先以默认值建 reactive;真实值由 hydrateSettings 灌入。
export const apiSettings = reactive<ApiSettings>(defaults());

// 守门标志:hydrate 完成前不回写,避免「默认值」覆盖服务器上已存的设置。
let ready = false;
let sharedChannelsFingerprint = '';
let sharedChannelsRevision = 0;
let sharedChannelsListenerBound = false;
let sharedExcludesFingerprint = '';
let sharedExcludesRevision = 0;
let sharedExcludesListenerBound = false;

// hydrate 完成后要通知的订阅者(如 ui.ts:settings 就绪后才能拿到同步过来的主题/导航位置)。
// 若订阅时已就绪则立刻回调,避免错过时序。
const readyCbs: Array<() => void> = [];
export function onSettingsReady(cb: () => void): void {
  if (ready) cb();
  else readyCbs.push(cb);
}

function applyInto(target: ApiSettings, src: ApiSettings): void {
  target.enabled = src.enabled;
  target.ui = src.ui;
  target.prompts = src.prompts;
  target.promptBases = src.promptBases;
  target.taskContextMode = src.taskContextMode;
  target.memoryBudgetTokens = src.memoryBudgetTokens;
  target.memoryBudgetMigrated = src.memoryBudgetMigrated;
  target.verbosity = src.verbosity;
  target.vector = src.vector;
  target.channels = src.channels;
  target.assignments = src.assignments;
  target.autoSummaryEnabled = src.autoSummaryEnabled;
  target.summarizeOnReplyEnd = src.summarizeOnReplyEnd;
  target.summaryOnlyMode = src.summaryOnlyMode;
  target.injection = src.injection;
  target.keepRecent = src.keepRecent;
  target.excludedChars = src.excludedChars;
  target.excludedWorldNames = src.excludedWorldNames;
  target.excludedWorldInfoPatterns = src.excludedWorldInfoPatterns;
  target.wiPatternsSeeded = src.wiPatternsSeeded;
  target.renderWorldInfoTemplates = src.renderWorldInfoTemplates;
  target.leafBatchThreshold = src.leafBatchThreshold;
  target.leafKeepRecent = src.leafKeepRecent;
  target.resummaryThreshold = src.resummaryThreshold;
  target.higherResummaryThreshold = src.higherResummaryThreshold;
  target.recentResolvedPlansCount = src.recentResolvedPlansCount;
  target.summaryMaxRetries = src.summaryMaxRetries;
  target.mainApiMaxTokens = src.mainApiMaxTokens;
  target.mainApiPrefill = src.mainApiPrefill;
  target.npcEnrichAuto = src.npcEnrichAuto;
  target.summaryMaxChars = src.summaryMaxChars;
  target.batchMaxChars = src.batchMaxChars;
  target.batchMaxFloors = src.batchMaxFloors;
  target.batchFullRecent = src.batchFullRecent;
  target.customStripTags = src.customStripTags;
  target.varsGlobalTemplate = src.varsGlobalTemplate;
  target.varsTemplateByChar = src.varsTemplateByChar;
}

function channelFingerprint(channels: ApiChannel[]): string {
  return JSON.stringify(channels);
}

function readSharedChannels(raw: unknown): SharedChannelsStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedChannelsStore>;
  if (!Array.isArray(store.channels)) return null;
  return {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    channels: store.channels.map(normalizeChannel),
  };
}

function writeSharedChannels(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedChannelsRevision += 1;
  const store: SharedChannelsStore = {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision: sharedChannelsRevision,
    channels: JSON.parse(JSON.stringify(apiSettings.channels)) as ApiChannel[],
  };
  ctx.extensionSettings[SHARED_CHANNELS_KEY] = store;
  sharedChannelsFingerprint = channelFingerprint(store.channels);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_CHANNELS_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Book' },
      }),
    );
  }
}

function applySharedChannels(store: SharedChannelsStore): void {
  const fingerprint = channelFingerprint(store.channels);
  sharedChannelsRevision = Math.max(sharedChannelsRevision, store.revision);
  if (fingerprint === sharedChannelsFingerprint) return;
  apiSettings.channels = store.channels;
  sharedChannelsFingerprint = fingerprint;

  const ids = new Set(apiSettings.channels.map(channel => channel.id));
  if (apiSettings.assignments.summary && !ids.has(apiSettings.assignments.summary)) {
    apiSettings.assignments.summary = '';
  }
  if (apiSettings.assignments.resummary && !ids.has(apiSettings.assignments.resummary)) {
    apiSettings.assignments.resummary = '';
  }
}

function bindSharedChannelsListener(): void {
  if (sharedChannelsListenerBound) return;
  sharedChannelsListenerBound = true;
  window.addEventListener(SHARED_CHANNELS_EVENT, () => {
    const ctx = getContext();
    const store = readSharedChannels(ctx?.extensionSettings?.[SHARED_CHANNELS_KEY]);
    if (store) applySharedChannels(store);
  });
}

function hydrateSharedChannels(legacyChannels: ApiChannel[]): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedChannels(ctx.extensionSettings[SHARED_CHANNELS_KEY]);
  if (stored) {
    applySharedChannels(stored);
  } else {
    apiSettings.channels = legacyChannels.map(normalizeChannel);
    sharedChannelsFingerprint = channelFingerprint(apiSettings.channels);
    writeSharedChannels(false);
  }
  bindSharedChannelsListener();
}

/* ============ 排除设置共享存储(与柏宝绘共用,协议与渠道完全同构) ============ */

function excludesFingerprint(ex: Pick<ApiSettings, 'excludedChars' | 'excludedWorldNames' | 'excludedWorldInfoPatterns' | 'customStripTags'>): string {
  return JSON.stringify([
    ex.excludedChars,
    ex.excludedWorldNames,
    ex.excludedWorldInfoPatterns,
    ex.customStripTags,
  ]);
}

/** 判断名单里除内置默认条目名规则(mvu)外,是否还有任何用户数据。 */
function excludesHasUserData(ex: Pick<ApiSettings, 'excludedChars' | 'excludedWorldNames' | 'excludedWorldInfoPatterns' | 'customStripTags'>): boolean {
  const patterns = ex.excludedWorldInfoPatterns.filter(p => !DEFAULT_WI_PATTERNS.includes(p));
  return (
    ex.excludedChars.length > 0 ||
    ex.excludedWorldNames.length > 0 ||
    patterns.length > 0 ||
    ex.customStripTags.length > 0
  );
}

/** 从共享存储原样读出四名单,逐名单按本地 normalize 同口径清洗(缺字段/类型不符回退空数组)。 */
function readSharedExcludes(raw: unknown): SharedExcludesStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedExcludesStore>;
  if (!Array.isArray(store.excludedChars)) return null;
  return {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    excludedChars: store.excludedChars.filter((x): x is string => typeof x === 'string'),
    excludedWorldNames: Array.isArray(store.excludedWorldNames)
      ? store.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    excludedWorldInfoPatterns: Array.isArray(store.excludedWorldInfoPatterns)
      ? store.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    customStripTags: Array.isArray(store.customStripTags)
      ? Array.from(
        new Set(
          store.customStripTags
            .filter((x): x is string => typeof x === 'string')
            .map(sanitizeTagName)
            .filter(Boolean),
        ),
      )
      : [],
  };
}

function writeSharedExcludes(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedExcludesRevision += 1;
  const store: SharedExcludesStore = {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision: sharedExcludesRevision,
    excludedChars: JSON.parse(JSON.stringify(apiSettings.excludedChars)) as string[],
    excludedWorldNames: JSON.parse(JSON.stringify(apiSettings.excludedWorldNames)) as string[],
    excludedWorldInfoPatterns: JSON.parse(JSON.stringify(apiSettings.excludedWorldInfoPatterns)) as string[],
    customStripTags: JSON.parse(JSON.stringify(apiSettings.customStripTags)) as string[],
  };
  ctx.extensionSettings[SHARED_EXCLUDES_KEY] = store;
  sharedExcludesFingerprint = excludesFingerprint(store);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_EXCLUDES_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Book' },
      }),
    );
  }
}

function applySharedExcludes(store: SharedExcludesStore): void {
  const fingerprint = excludesFingerprint(store);
  sharedExcludesRevision = Math.max(sharedExcludesRevision, store.revision);
  if (fingerprint === sharedExcludesFingerprint) return;
  apiSettings.excludedChars = store.excludedChars;
  apiSettings.excludedWorldNames = store.excludedWorldNames;
  apiSettings.excludedWorldInfoPatterns = store.excludedWorldInfoPatterns;
  apiSettings.customStripTags = store.customStripTags;
  sharedExcludesFingerprint = fingerprint;
}

function bindSharedExcludesListener(): void {
  if (sharedExcludesListenerBound) return;
  sharedExcludesListenerBound = true;
  window.addEventListener(SHARED_EXCLUDES_EVENT, () => {
    const ctx = getContext();
    const store = readSharedExcludes(ctx?.extensionSettings?.[SHARED_EXCLUDES_KEY]);
    if (store) applySharedExcludes(store);
  });
}

/**
 * 排除设置共享存储接管:存在则以共享为准覆盖本插件镜像;
 * 不存在则以本插件当前名单(老用户已配置 + 已播种的默认规则)为种子写入。
 * 播种只在「无存储」时发生,天然满足「只发一次、删了不补回」,无需额外标记。
 *
 * 自愈守卫:共享存储存在但完全没有用户数据(疑似早期版本的「空种子」遗留——
 * 没有数据的插件曾经也会创建共享存储,导致双方互相同步成空),
 * 而本插件名单里还有用户数据时 → 不领养空 store,以本插件为准回写共享存储并广播,
 * 把真实数据修复回去。注意:用户在任一端有意清空名单后,store 里的清空结果
 * 会与本地一致(fingerprint 相同),不会误判。
 */
function hydrateSharedExcludes(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedExcludes(ctx.extensionSettings[SHARED_EXCLUDES_KEY]);
  if (stored) {
    if (!excludesHasUserData(stored) && excludesHasUserData(apiSettings)) {
      writeSharedExcludes(true);
    } else {
      applySharedExcludes(stored);
    }
  } else {
    sharedExcludesFingerprint = excludesFingerprint(apiSettings);
    writeSharedExcludes(false);
  }
  bindSharedExcludesListener();
}

/** 写回 extension_settings 并防抖落盘到服务器(跨设备同步的关键)。 */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
  const fingerprint = channelFingerprint(apiSettings.channels);
  if (fingerprint !== sharedChannelsFingerprint) writeSharedChannels();
  // 排除名单有改动 → 同步写共享存储并广播(指纹比对防回环)
  const exFingerprint = excludesFingerprint(apiSettings);
  if (exFingerprint !== sharedExcludesFingerprint) writeSharedExcludes();
  ctx.saveSettingsDebounced?.();
}

/**
 * ST 就绪后调用:从 extension_settings 载入真实设置;
 * 若那里还没有、但 localStorage 有旧值,则迁移过去(老用户不丢配置),迁移后清掉旧键。
 * 完成后放行 watch 回写。可安全重复调用(只在首次真正 hydrate)。
 */
export function hydrateSettings(): void {
  if (ready) return;
  const ctx = getContext();
  if (!ctx?.extensionSettings) return; // ST 未就绪,稍后重试

  const stored = ctx.extensionSettings[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    applyInto(apiSettings, normalize(stored));
    const savedPrompts = (stored as Partial<ApiSettings>).prompts;
    if (savedPrompts && savedPrompts.timeTag !== apiSettings.prompts.timeTag) {
      // 只更新被识别出的旧默认时间提示词，不覆盖其它已存设置。
      savedPrompts.timeTag = apiSettings.prompts.timeTag;
      ctx.saveSettingsDebounced?.();
    }
    // 老用户:server 已有 api 设置但还没同步过界面偏好 → 把旧 localStorage 的主题/导航迁进来并落盘一次
    if (!('ui' in (stored as object))) {
      migrateLegacyUiPrefs(apiSettings);
      ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
      ctx.saveSettingsDebounced?.();
    }
    try {
      localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  } else {
    // 迁移:extension_settings 里没有 → 尝试搬运旧 localStorage
    let migrated: ApiSettings | null = null;
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) migrated = normalize(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    if (migrated) applyInto(apiSettings, migrated);
    // 界面偏好同样从旧 localStorage 迁入(新装用户没有此键则维持默认)
    migrateLegacyUiPrefs(apiSettings);
    // 把当前值(迁移来的或默认)写进 extension_settings,确立同步源
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  hydrateSharedChannels(apiSettings.channels);

  // 播种内置默认条目名规则:仅当从未发放过(老用户/新用户首次)才补进列表,并置标记 + 落盘。
  // 只发一次——用户之后删空也不会被反复塞回。追加而非覆盖,不动用户已有的自定义规则。
  if (!apiSettings.wiPatternsSeeded) {
    for (const pat of DEFAULT_WI_PATTERNS) {
      if (!apiSettings.excludedWorldInfoPatterns.includes(pat)) apiSettings.excludedWorldInfoPatterns.push(pat);
    }
    apiSettings.wiPatternsSeeded = true;
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
  }

  // 注入预算改为默认不限制:按原默认值保存的 6000 改成 0。只做一次,之后用户自己填的值不再改动。
  if (!apiSettings.memoryBudgetMigrated) {
    if (apiSettings.memoryBudgetTokens === LEGACY_MEMORY_BUDGET_DEFAULT) apiSettings.memoryBudgetTokens = 0;
    apiSettings.memoryBudgetMigrated = true;
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
  }

  // 排除名单共享存储接管(在播种之后:老用户名单/新播种规则作为种子写入)
  hydrateSharedExcludes();

  ready = true;
  for (const cb of readyCbs.splice(0)) {
    try {
      cb();
    } catch {
      /* 订阅者自身异常不阻断后续 */
    }
  }
}

watch(
  apiSettings,
  () => {
    if (!ready) return; // hydrate 前不回写,防止默认值覆盖服务器设置
    persist();
  },
  { deep: true },
);

/**
 * 导入设置备份:按与载入时相同的规则整理(补默认值、校验类型)后整体替换当前设置。
 * 落盘、共享渠道与共享排除名单的同步和广播由上面的 watch 完成(与手动修改设置相同)。
 * 密钥合并、渠道按 id 合并等由调用方(settingsBackup.ts)先做好。
 */
export function replaceApiSettings(raw: unknown): void {
  if (!ready) throw new Error('设置还没有载入完成，请稍后再试。');
  applyInto(apiSettings, normalize(raw));
}

/** 按载入时的规则整理一份设置但不应用(导入前对比用)。 */
export function normalizeApiSettings(raw: unknown): ApiSettings {
  return normalize(raw);
}

let chanSeq = 0;
export function newChannel(): ApiChannel {
  chanSeq += 1;
  return {
    id: `ch_${Date.now()}_${chanSeq}`,
    name: '新渠道',
    url: '',
    key: '',
    model: '',
    temperature: 1.0,
    maxTokens: 65535,
    timeoutSec: 180,
    stream: false,
    prefill: false,
    excludeParams: [],
    reasoningEffort: '',
  };
}

/** 当前单角色聊天的角色名;群聊或未进入聊天时返回 null(群聊不参与排除)。 */
export function currentCharName(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊:多角色,不按单名排除
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  return ch?.name ?? null;
}

/**
 * 当前角色的稳定键:avatar 文件名(唯一,重名卡也不冲突);取不到回退角色名。
 * 用于角色层变量定义的存储键(varsByChar[key])。群聊 / 未进入聊天返回 null(角色层此时不适用)。
 */
export function currentCharKey(): string | null {
  const ctx = getContext();
  if (!ctx || ctx.groupId) return null; // 群聊无单一角色
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)] as { avatar?: string; name?: string } | undefined;
  return ch?.avatar || ch?.name || null;
}

/**
 * 当前聊天是否被排除(该角色名在排除名单里)。被排除则记忆系统所有功能停用。
 * 按「名字」匹配:同名的重名卡会被一并排除——符合用户「这批重名卡一起排除」的诉求。
 */
export function isCurrentChatExcluded(): boolean {
  if (!apiSettings.excludedChars.length) return false;
  const name = currentCharName();
  return name !== null && apiSettings.excludedChars.includes(name);
}

/** 引擎是否在当前聊天生效:总开关开着且当前角色未被排除。各功能闸门统一走它。 */
export function engineActiveHere(): boolean {
  return apiSettings.enabled && !isCurrentChatExcluded();
}

export function getChannelForTask(task: TaskType): ApiChannel | null {
  const id = apiSettings.assignments[task];
  if (!id) return null;
  return apiSettings.channels.find(c => c.id === id) ?? null;
}

/**
 * 解析某个向量角色实际使用的端点(url/key/model)。
 * 三个角色的**模型各自独立**(embedding/rerank/query 模型本就不同),从不复用;
 * 能复用的只有**地址与密钥**:rerank/queryRewrite 的 url/key 各自留空时,分别回落到 embedding 的。
 */
export function resolveVectorModel(role: 'embedding' | 'rerank' | 'queryRewrite'): VectorEndpoint {
  const v = apiSettings.vector;
  const base = v.embedding;
  if (role === 'embedding') return { ...base };
  const cfg = v[role];
  const url = cfg.url.trim() || base.url; // 地址留空 → 复用 embedding 地址
  return {
    url,
    // 密钥留空 → 复用 embedding 密钥,但只限同一服务器:另填了别家地址却没填密钥时不把 embedding 的密钥发过去
    key: cfg.key.trim() || (sameOrigin(url, base.url) ? base.key : ''),
    model: cfg.model, // 模型始终独立,不回落
    timeoutSec: cfg.timeoutSec, // 超时/重试始终独立,不回落(各角色默认本就不同)
    retries: cfg.retries,
  };
}

/** 两个地址是否属于同一服务器(协议、主机、端口都相同);任一无法解析时按不同处理。 */
function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a.trim()).origin === new URL(b.trim()).origin; } catch { return false; }
}
