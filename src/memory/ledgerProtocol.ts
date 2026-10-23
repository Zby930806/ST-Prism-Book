import type { STMessage } from '@/st/context';

/** 独立于时间模板和状态显示开关;来源属性只是说明,不是结算凭证。 */
export const LEDGER_PROTOCOL = "【棱镜宝书旁注读取与正文分工】\n历史消息尾部的 <bbs_items> / <bbs_vars>（含带属性或旧版无属性标签）是插件写回的结算旁注，不是角色台词或正文输出模板。读取其中的已结算变化，以理解物品和变量状态；快照已包含的变化不要再累加，历史记录不覆盖较新的状态。\n你的任务是续写故事：新的获得、交付、消耗只在自然正文中描写，由摘要与插件负责记账。不要复制、续写或另造物品/变量变动清单，不输出上述旁注标签，也不要把旁注改写成正文中的账单。此分工不取消另行要求的时间标签或正常剧情中的盘点。";

export const LEDGER_ATTRIBUTES = 'source="baibai-book" status="settled" readonly="true"';

/** 旁注标签的开头:带属性的新写法和无属性的旧写法都认。 */
const LEDGER_TAG = /<bbs_(?:items|vars)\b/i;

/**
 * 发给正文模型的消息里是否带有物品/变量旁注:只看未隐藏的当前页(隐藏楼 is_system 不发给正文模型)。
 * 有旁注才需要注入只读账本协议;取不到聊天时按需要处理,维持原来的行为。
 */
export function chatShowsLedgerTags(chat: readonly STMessage[] | null | undefined): boolean {
  if (!chat) return true;
  return chat.some(m => !!m && m.is_system !== true && typeof m.mes === 'string' && LEDGER_TAG.test(m.mes));
}
