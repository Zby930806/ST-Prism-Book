/** 世界书建议的长度与数量上限：协议校验、编辑弹窗和提示词共用。字符数按 JS string.length 计。 */
export const WB_LIMITS = Object.freeze({
  /** 单次回复最多采用的动作数。 */
  actions: 12,
  title: 60,
  /** 每个条目的关键词数、单个关键词长度。 */
  keys: 8,
  key: 40,
  /** 新条目内容：提示词建议的上限与代码拒收的上限。 */
  createHint: 600,
  create: 1500,
  /** 追加内容。 */
  appendHint: 300,
  append: 1000,
  /** 替换：原文片段与替换后的文字。 */
  find: 1000,
  replace: 1500,
  /** 整段改写后的内容。 */
  rewrite: 3000,
  reason: 300,
  floors: 10,
  /** 模型回复与其中 JSON 的长度上限。 */
  reply: 120000,
  json: 80000,
  /** 目标书索引的字数上限，以及每条索引里内容开头的字数。 */
  index: 10000,
  indexOpening: 60,
  /** 相关条目全文中单条的上限。 */
  entryFull: 2000,
  /** 参考书中单条内容的上限。 */
  refEntry: 400,
  /** 单层正文的上限（超出部分截断并注明）。 */
  floorText: 8000,
  /** 角色卡描述的上限。 */
  card: 2000,
  /** 每个聊天最多保存的建议批次与写入记录。 */
  batches: 20,
  applied: 100,
});
