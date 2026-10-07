/**
 * SillyTavern getContext() 的薄封装 + 类型。
 * 整个扩展只通过这里接触宿主,稳定且单点。
 * 运行时 getContext 挂在 window.SillyTavern 上(ST 的稳定扩展 API)。
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  /** ST 当前消息的所有 swipe 正文。单页 AI 回复通常也有 swipes[0]。 */
  swipes?: string[];
  send_date?: string;
  /** 当前显示的 swipe 页码(多页 AI 回复时)。单页/无 swipe 时可能为 undefined,按 0 处理 */
  swipe_id?: number;
  /** 消息私有数据。棱镜宝书在这里存隐藏、叶子摘要、番外与内部提示楼标记。 */
  extra?: Record<string, unknown> & {
    bbs_leaf?: import('@/memory/types').LeafExtra;
    bbs_hidden?: boolean;
    bbs_omit?: boolean;
    bbs_internal_notice?: 'backlog';
  };
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STEventTypes {
  USER_MESSAGE_RENDERED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  MESSAGE_SWIPED: string;
  CHAT_CHANGED: string;
  [k: string]: string;
}

/** 角色卡(只用到极少字段;avatar 是稳定唯一键,name 可能重名) */
export interface STCharacter {
  name: string;
  avatar: string;
  [k: string]: unknown;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  /** 已加载的全部角色卡 */
  characters?: STCharacter[];
  /** 当前角色在 characters 中的索引(字符串/数字);群聊时为空 */
  characterId?: string | number;
  /** 当前群组 id;非群聊为空 */
  groupId?: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveMetadata: () => Promise<void>;
  saveChat: () => Promise<void>;
  /** 扩展全局设置对象(= extension_settings,写进服务器 settings.json,跨设备同步)。ST 稳定 API。 */
  extensionSettings?: Record<string, unknown>;
  /** 防抖保存全局设置(连同 extensionSettings 落盘到服务器)。ST 稳定 API。 */
  saveSettingsDebounced?: () => void;
  reloadCurrentChat: () => Promise<void>;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
  /** 注入扩展提示(key, value, position, depth, scan, role, filter)。ST 稳定 API。 */
  setExtensionPrompt?: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: unknown,
  ) => void;
  /** 执行斜杠命令(如 /hide 0-3)。ST 稳定 API。 */
  executeSlashCommandsWithOptions?: (command: string, options?: Record<string, unknown>) => Promise<unknown>;
  /**
   * 连接管理:用「当前选中的连接档」发请求(跟随主 API)。来源 extensions/shared.js。
   * sendRequest(profileId, messages, maxTokens, custom, overridePayload):
   *   custom.includePreset=false → 不套补全预设(只用该档的 API 信息);
   *   custom.includeInstruct=false → 文本补全档也跳过 instruct 模板;
   *   overridePayload 可塞 temperature 等采样参数(因为不走预设)。
   *   extractData=true(默认)时返回 { content } 取文本。
   */
  ConnectionManagerRequestService?: {
    sendRequest: (
      profileId: string,
      prompt: Array<{ role: string; content: string }> | string,
      maxTokens: number,
      custom?: {
        stream?: boolean;
        signal?: AbortSignal | null;
        extractData?: boolean;
        includePreset?: boolean;
        includeInstruct?: boolean;
      },
      overridePayload?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  /**
   * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次性补全。来源 script.js,ST 稳定 API。
   * prompt 传消息数组时只发这些消息、不带聊天历史/角色卡;api 缺省=main_api(用户当前主 API)。
   * 内部走 sendOpenAIRequest('quiet', …),quiet 强制非流式,返回清洗后的整段文本。
   */
  generateRaw?: (params: {
    prompt: Array<{ role: string; content: string }> | string;
    api?: string | null;
    systemPrompt?: string;
    responseLength?: number | null;
    prefill?: string;
    jsonSchema?: unknown;
  }) => Promise<string>;
  /** 展开 {{char}}/{{user}} 等宏。摘要带角色卡描述时,字段里可能含宏,需用它还原。ST 稳定 API。 */
  substituteParams?: (content: string) => string;
  /**
   * 按文本激活世界书条目(关键词触发 + constant 常驻)。ST 稳定 API(world-info.js)。
   * chat 为待扫描文本数组(由旧到新);isDryRun=true 仅扫描不触发副作用事件。
   */
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, unknown>,
  ) => Promise<{
    worldInfoBefore?: string;
    worldInfoAfter?: string;
    worldInfoString?: string;
    /** @深度条目:{depth, role, entries: string[]}。很多蓝灯条目在这里 */
    worldInfoDepth?: Array<{ depth?: number; role?: number; entries?: string[] }>;
    /** 作者注前/后条目(content 字符串数组) */
    anBefore?: string[];
    anAfter?: string[];
  }>;
  /** 全部已加载的世界书文件名(全局 + 角色绑定)。ST 稳定 API,用于「整本排除」下拉。 */
  getWorldInfoNames?: () => string[];
  /** 主上下文最大 token(给 getWorldInfoPrompt 的预算参数) */
  maxContext?: number;
  // 兼容旧式命名
  event_types?: STEventTypes;
  [k: string]: any;
}

interface STGlobal {
  getContext: () => STContext;
}

declare global {
  interface Window {
    SillyTavern?: STGlobal;
  }
}

/** 取得 ST 上下文;未就绪时返回 null。 */
export function getContext(): STContext | null {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * 把文本追加到 ST 主输入框，不触发发送。
 * 派发 input 事件以同步 ST 的输入框高度、发送按钮和草稿相关状态。
 */
export function appendChatInput(text: string): boolean {
  try {
    const value = text.trim();
    const textarea = document.querySelector<HTMLTextAreaElement>('#send_textarea');
    if (!value || !textarea) return false;

    const existing = textarea.value;
    const separator = !existing
      ? ''
      : existing.endsWith('\n\n')
        ? ''
        : existing.endsWith('\n')
          ? '\n'
          : '\n\n';
    textarea.value = `${existing}${separator}${value}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    requestAnimationFrame(() => {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 更新消息正文时同步当前 swipe。
 *
 * ST 的保存格式里 `mes` 和 `swipes[swipe_id]` 都会存在；只改 `mes` 会造成当前页
 * 文本与 swipe 备份分裂。所有插件内部正文写回都走这里。
 */
export function setMessageText(message: STMessage | undefined, text: string): void {
  if (!message) return;
  message.mes = text;
  if (!Array.isArray(message.swipes)) return;
  const idx = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  if (idx >= 0 && idx < message.swipes.length) message.swipes[idx] = text;
}

/**
 * 取 ST 的 doNewChat(getContext 未暴露,从 /script.js 动态取)。
 * 用于「带数据创建新对话」:doNewChat({deleteCurrentChat:false}) 在当前角色下新建一个空聊天并切入。
 * 取不到(旧版/路径变动)时返回 null,调用方据此降级报错。
 */
export async function getDoNewChat(): Promise<((opts?: { deleteCurrentChat?: boolean }) => Promise<void>) | null> {
  try {
    // 变量持有路径,避免 Vite/vue-tsc 把 /script.js 当本地模块解析
    const scriptPath = '/script.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ scriptPath);
    const fn = mod.doNewChat;
    return typeof fn === 'function' ? (fn as (opts?: { deleteCurrentChat?: boolean }) => Promise<void>) : null;
  } catch {
    return null;
  }
}

/** 一条已激活的世界书条目(checkWorldInfo 返回的条目对象;只取过滤/排序/拼接用到的字段)。 */
export interface WorldInfoEntry {
  /** 所属世界书文件名(整本排除按它匹配) */
  world?: string;
  /** 条目备注/标题(条目名过滤按它匹配) */
  comment?: string;
  /** 条目正文 */
  content?: string;
  /** 插入顺序(Order)。ST 拼提示词时同位置条目按它升序排列;缺省视为 100(ST 新建条目默认值) */
  order?: number;
  /** 插入位置:0 角色前 / 1 角色后 / 2 作者注前 / 3 作者注后 / 4 @深度 / 5 EM上 / 6 EM下 / 7 出口;缺省视为 0 */
  position?: number;
  /** @深度条目的深度值(仅 position=4 时参与排序;ST 默认 4) */
  depth?: number;
  [k: string]: unknown;
}

/** checkWorldInfo 的返回结构(只声明我们要用的字段)。 */
interface CheckWorldInfoResult {
  /** 全部激活条目(已完成扫描/递归/预算,是最终该进提示词的集合) */
  allActivatedEntries?: Set<WorldInfoEntry> | Map<string, WorldInfoEntry>;
  [k: string]: unknown;
}

type CheckWorldInfoFn = (
  chat: string[],
  maxContext: number,
  isDryRun: boolean,
  globalScanData?: Record<string, unknown>,
) => Promise<CheckWorldInfoResult>;

/**
 * 取 ST 的 checkWorldInfo(getContext 未暴露,从 /scripts/world-info.js 动态取)。
 * 与 getWorldInfoPrompt 不同:它返回**条目对象集合**(带 world/comment/content),
 * 才能按世界书名 / 条目名过滤——而 getWorldInfoPrompt 只吐拼好的字符串,元信息全丢。
 * 取不到(旧版/路径变动)时返回 null,调用方据此降级回 getWorldInfoPrompt(不过滤)。
 */
export async function getCheckWorldInfo(): Promise<CheckWorldInfoFn | null> {
  try {
    // 变量持有路径,避免 Vite/vue-tsc 把它当本地模块解析
    const wiPath = '/scripts/world-info.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ wiPath);
    const fn = mod.checkWorldInfo;
    return typeof fn === 'function' ? (fn as CheckWorldInfoFn) : null;
  } catch {
    return null;
  }
}

/**
 * ST-Prompt-Template(提示词模板插件)挂在 globalThis 的执行器接口(见其 exports.ts)。
 * 我们只用到 prepareContext + evalTemplate:前者备好含变量/世界书上下文的 env,
 * 后者对含 <% %> 的文本跑 EJS。用于让副 API 读到的世界书拿到「执行后」的成品,而非原文。
 * 只声明用到的两个方法;插件未安装时 globalThis.EjsTemplate 为 undefined,调用方据此降级。
 */
export interface EjsTemplateApi {
  prepareContext: (context?: Record<string, unknown>, end?: number) => Promise<Record<string, unknown>>;
  evalTemplate: (
    code: string,
    context?: Record<string, unknown> | null,
    options?: Record<string, unknown>,
  ) => Promise<string | null>;
}

/** 取 ST-Prompt-Template 暴露的模板执行器;未安装/接口不完整时返回 null(调用方降级为不执行 EJS)。 */
export function getEjsTemplate(): EjsTemplateApi | null {
  const api = (globalThis as { EjsTemplate?: Partial<EjsTemplateApi> }).EjsTemplate;
  if (api && typeof api.prepareContext === 'function' && typeof api.evalTemplate === 'function') {
    return api as EjsTemplateApi;
  }
  return null;
}
