import type { ChatMsg } from '@/api/client';
import type { STContext } from '@/st/context';
import { cleanBody } from '@/memory/timeTag';
import { memory, memoryWriteIssue } from '@/memory/store';
import { selectHistoryNodesBefore } from '@/memory/inject';
import { fitHistoryNodes, fitNewestLines, memoryBudgetLimited, memoryStateDigest } from '@/notes/memoryDigest';
import { OUTLINE_PROMPT } from './prompt';
import { outlineRecentIndices } from './sources';

const TRUNCATED = '\n[资料按预算截断，未展示部分不可臆造]';
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return TRUNCATED.slice(0, budget);
  return text.slice(0, budget - TRUNCATED.length) + TRUNCATED;
}

/**
 * 规划请求各部分的字数上限（按 JS 字符计）。
 * 摘要与总结、当前状态、札记安排只在「设置 → 注入设置」的记忆注入预算填写了数值时才按这里的上限读取，预算为 0（默认）时不限制；
 * 最近正文、角色卡和世界书始终按这里的上限读取（角色卡和世界书的上限较宽，避免撑爆规划 API 的上下文）。
 */
export const OUTLINE_CONTEXT_LIMITS = Object.freeze({
  history: 7800,
  state: 4200,
  arrangements: 1500,
  recent: 24000,
  recentFloor: 6000,
  card: 12000,
  worldInfo: 20000,
});

/** 规划阶段数:具体数字要求严格等于;'auto'(一键生成)由模型在 3～6 个之间按剧情决定。 */
export type OutlineChapterCount = number | 'auto';

/** 一键生成时代替「创作要求」的说明;不针对具体角色或题材。 */
export const AUTO_OUTLINE_REQUEST = '用户没有填写创作要求，请自行规划后续发展：依据角色卡、世界书、已有剧情和当前局势，延续未了结的计划与悬念，运用世界书中已有的设定、势力和人物关系，节奏由近及远、逐步推进；角色卡和世界书是设定，不是已发生的剧情；不替用户角色决定行动或承诺。';

/** 规划生成的附加资料:世界书条目(常驻 + 最近正文触发)与札记中仍生效的已确认安排(每行一条，按确认先后排列),都可为空。 */
export interface OutlineExtras {
  worldInfo?: string;
  arrangements?: string;
}

/** 最近正文：从最新往前放入，每层最多 recentFloor 字；返回实际放进去的最早一层，历史摘要从它之前选取。 */
function recentRows(ctx: STContext, indices: number[], heading: string): { text: string; first: number | undefined } {
  const L = OUTLINE_CONTEXT_LIMITS;
  const rows: string[] = [];
  let first: number | undefined;
  let budget = L.recent - heading.length;
  for (const i of [...indices].reverse()) {
    if (budget <= 0) break;
    const m = ctx.chat[i];
    // cleanBody 内部调用 clampToTimeTags，剥离 think/aftertalk 和非正文标签。
    const body = cleanBody(m.mes);
    if (!body) { first = i; continue; }
    const head = `第${i}楼 ${m.is_user ? '用户' : '正文'}：\n`;
    const separator = rows.length ? 2 : 0;
    if (budget <= head.length + separator) break;
    const row = head + clip(body, Math.min(L.recentFloor, budget - head.length - separator));
    budget -= row.length + separator;
    rows.unshift(row);
    first = i;
  }
  return { text: heading + rows.join('\n\n'), first };
}

/** 只读输入；不调用摘要/札记/独立注入服务，不创建或回写任何记忆。 */
export function buildOutlineContext(ctx: STContext, brief: string, chapterCount: OutlineChapterCount, extras: OutlineExtras = {}): ChatMsg[] {
  const L = OUTLINE_CONTEXT_LIMITS;
  const auto = chapterCount === 'auto';
  if (!auto && (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 12)) throw new Error('大纲规划阶段数量须为 1 到 12 的整数。');
  if (!auto && (typeof brief !== 'string' || !brief.trim())) throw new Error('请填写本次大纲需求。');
  const recent = recentRows(ctx, outlineRecentIndices(ctx), '[最近正文与用户原话，按楼层排序；不含札记提案]\n');
  const limited = memoryBudgetLimited();

  let memoryText = '[宝书记忆处于保护状态，本次未读取摘要、总结和状态]';
  if (!memoryWriteIssue()) {
    // 逐楼摘要（L0）与总结都带上：没放进最近正文的楼层由它们覆盖；按时间顺序排列。
    const historyHeading = '[已有的摘要和总结，按时间顺序]\n';
    const nodes = selectHistoryNodesBefore(memory.summaries, ctx.chat, recent.first ?? ctx.chat.length);
    const history = fitHistoryNodes(nodes, limited ? L.history - historyHeading.length : Infinity).text;
    const stateHeading = '\n[当前状态，按重要程度排列；计划和悬念不代表已发生的事]\n';
    const state = memoryStateDigest({ userName: ctx.name1, extended: true }, limited ? L.state - stateHeading.length : Infinity);
    memoryText = historyHeading + (history || '（暂无）') + stateHeading + (state || '（暂无）');
  }

  const id = ctx.characterId;
  const character = !ctx.groupId && id !== undefined && id !== '' ? ctx.characters?.[Number(id)] : undefined;
  // 描述放在最前,性格、情景有内容时再附上。
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const card = [text(character?.description), text(character?.personality) && `【性格】\n${text(character?.personality)}`, text(character?.scenario) && `【情景】\n${text(character?.scenario)}`]
    .filter(Boolean).join('\n\n');
  const worldInfo = extras.worldInfo?.trim() ?? '';
  // 安排按确认先后排列；限字数时保留最新的，注明较早的省略了几条。
  const arrangementLines = (extras.arrangements ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const arrangementHeading = '[双子札记中用户已确认的安排；是写作方向，尚未发生]\n';
  const arrangements = fitNewestLines(arrangementLines, limited ? L.arrangements : Infinity, '安排').text;
  const count = auto
    ? '输出 3～6 个规划阶段，数量按剧情需要决定'
    : `严格输出 ${chapterCount} 个规划阶段（chapters 数组长度必须为 ${chapterCount}）`;
  const request = auto ? `[一键生成：用户没有填写创作要求]\n${AUTO_OUTLINE_REQUEST}` : `[本次最新用户 input；优先于旧创作方向]\n${brief.trim()}`;
  return [
    { role: 'system', content: OUTLINE_PROMPT },
    { role: 'user', content: '[角色卡；设定不等于已发生剧情]\n' + clip(card, L.card) },
    ...(worldInfo ? [{ role: 'user' as const, content: '[世界书：当前启用的设定条目（常驻条目与最近正文触发的条目）；设定不等于已发生剧情]\n' + clip(worldInfo, L.worldInfo) }] : []),
    { role: 'user', content: memoryText },
    ...(arrangements ? [{ role: 'user' as const, content: arrangementHeading + arrangements }] : []),
    { role: 'user', content: recent.text },
    { role: 'user', content: `${request}\n\n结合既有剧情与已有的摘要和总结，${count}。每阶段包含 goal 阶段目标、beats 剧情要点、approach 发展方式、exitCriteria 推进条件，不写固定章节小作文。只按规定 JSON 输出；这是未来创作规划，不是已发生事件，不更新任何状态或角色真实承诺。` },
  ];
}
