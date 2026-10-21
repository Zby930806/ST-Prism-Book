import type { ChatMsg } from '@/api/client';
import type { STContext } from '@/st/context';
import { cleanBody } from '@/memory/timeTag';
import { memory, memoryWriteIssue } from '@/memory/store';
import { selectHistoryNodesBefore, renderHistoryNodes } from '@/memory/inject';
import { OUTLINE_PROMPT } from './prompt';
import { outlineRecentIndices } from './sources';

const TRUNCATED = '\n[资料按预算截断，未展示部分不可臆造]';
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return TRUNCATED.slice(0, budget);
  return text.slice(0, budget - TRUNCATED.length) + TRUNCATED;
}

/** 规划阶段数:具体数字要求严格等于;'auto'(一键生成)由模型在 3～6 个之间按剧情决定。 */
export type OutlineChapterCount = number | 'auto';

/** 一键生成时代替「创作要求」的说明;不针对具体角色或题材。 */
export const AUTO_OUTLINE_REQUEST = '用户没有填写创作要求，请自行规划后续发展：依据角色卡、世界书、已有剧情和当前局势，延续未了结的计划与悬念，运用世界书中已有的设定、势力和人物关系，节奏由近及远、逐步推进；角色卡和世界书是设定，不是已发生的剧情；不替用户角色决定行动或承诺。';

/** 规划生成的附加资料:世界书条目(常驻 + 最近正文触发)与札记中仍生效的已确认安排,都可为空。 */
export interface OutlineExtras {
  worldInfo?: string;
  arrangements?: string;
}

/** 只读输入；不调用摘要/札记/独立注入服务，不创建或回写任何记忆。 */
export function buildOutlineContext(ctx: STContext, brief: string, chapterCount: OutlineChapterCount, extras: OutlineExtras = {}): ChatMsg[] {
  const auto = chapterCount === 'auto';
  if (!auto && (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 12)) throw new Error('大纲规划阶段数量须为 1 到 12 的整数。');
  if (!auto && (typeof brief !== 'string' || !brief.trim())) throw new Error('请填写本次大纲需求。');
  const recentIdx = outlineRecentIndices(ctx);
  const recent = recentIdx.map(i => ({ m: ctx.chat[i], i }));

  let memoryText = '[宝书记忆处于保护状态，本次未读取历史压缩层及状态]';
  if (!memoryWriteIssue()) {
    const nodes = selectHistoryNodesBefore(memory.summaries, ctx.chat, recent[0]?.i ?? ctx.chat.length);
    const selected: string[] = [];
    const historyHeading = '[已有历史压缩层；可能省略远期节点]\n';
    let budget = 7800 - historyHeading.length;
    // 只用已有压缩层，不把 L0 叶子或原始旧正文混入；保留完整节点及时间顺序。
    for (const node of [...nodes].reverse()) {
      if (node.kind !== 'comp' || node.level < 1) continue;
      const text = renderHistoryNodes([node]);
      const cost = text.length + (selected.length ? 2 : 0);
      if (text && cost <= budget) { selected.unshift(text); budget -= cost; }
    }
    const stateHeading = '\n[现有状态；计划字段不代表已发生事实]\n';
    const state = JSON.stringify({
      state: memory.state, protagonist: memory.protagonist, npcs: memory.npcs,
      items: memory.items, scenes: memory.scenes, plans: memory.plans,
      lifeDetails: memory.lifeDetails, vars: memory.vars,
    });
    memoryText = historyHeading + selected.join('\n\n') + stateHeading + clip(state, 4200 - stateHeading.length);
  }

  const rows: string[] = [];
  const recentHeading = '[最近正文与用户原话，按楼层排序；不含札记提案]\n';
  let recentBudget = 24000 - recentHeading.length;
  for (const { m, i } of [...recent].reverse()) {
    if (recentBudget <= 0) break;
    // cleanBody 内部调用 clampToTimeTags，剥离 think/aftertalk 和非正文标签。
    const body = cleanBody(m.mes);
    if (!body) continue;
    const heading = `第${i}楼 ${m.is_user ? '用户' : '正文'}：\n`;
    const separator = rows.length ? 2 : 0;
    if (recentBudget <= heading.length + separator) break;
    const row = heading + clip(body, Math.min(6000, recentBudget - heading.length - separator));
    recentBudget -= row.length + separator;
    rows.unshift(row);
  }
  const id = ctx.characterId;
  const character = !ctx.groupId && id !== undefined && id !== '' ? ctx.characters?.[Number(id)] : undefined;
  // 描述放在最前,性格、情景有内容时再附上。
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const card = [text(character?.description), text(character?.personality) && `【性格】\n${text(character?.personality)}`, text(character?.scenario) && `【情景】\n${text(character?.scenario)}`]
    .filter(Boolean).join('\n\n');
  const worldInfo = extras.worldInfo?.trim() ?? '';
  const arrangements = extras.arrangements?.trim() ?? '';
  const count = auto
    ? '输出 3～6 个规划阶段，数量按剧情需要决定'
    : `严格输出 ${chapterCount} 个规划阶段（chapters 数组长度必须为 ${chapterCount}）`;
  const request = auto ? `[一键生成：用户没有填写创作要求]\n${AUTO_OUTLINE_REQUEST}` : `[本次最新用户 input；优先于旧创作方向]\n${brief.trim()}`;
  return [
    { role: 'system', content: OUTLINE_PROMPT },
    { role: 'user', content: '[角色卡；设定不等于已发生剧情]\n' + clip(card, 3000) },
    ...(worldInfo ? [{ role: 'user' as const, content: '[世界书：当前启用的设定条目（常驻条目与最近正文触发的条目）；设定不等于已发生剧情]\n' + clip(worldInfo, 6000) }] : []),
    { role: 'user', content: memoryText },
    ...(arrangements ? [{ role: 'user' as const, content: '[双子札记中用户已确认的安排；是写作方向，尚未发生]\n' + clip(arrangements, 1500) }] : []),
    { role: 'user', content: recentHeading + rows.join('\n\n') },
    { role: 'user', content: `${request}\n\n结合既有剧情与 L1/L2 压缩历史，${count}。每阶段包含 goal 阶段目标、beats 剧情要点、approach 发展方式、exitCriteria 推进条件，不写固定章节小作文。只按规定 JSON 输出；这是未来创作规划，不是已发生事件，不更新任何状态或角色真实承诺。` },
  ];
}
