import type { ChatMsg } from '@/api/client';
import type { STContext } from '@/st/context';
import { cleanBody } from '@/memory/timeTag';
import { memory, memoryWriteIssue } from '@/memory/store';
import { selectHistoryNodesBefore, renderHistoryNodes } from '@/memory/inject';
import { OUTLINE_PROMPT } from './prompt';

const TRUNCATED = '\n[资料按预算截断，未展示部分不可臆造]';
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return TRUNCATED.slice(0, budget);
  return text.slice(0, budget - TRUNCATED.length) + TRUNCATED;
}

/** 只读输入；不调用摘要/札记/独立注入服务，不创建或回写任何记忆。 */
export function buildOutlineContext(ctx: STContext, brief: string, chapterCount: number): ChatMsg[] {
  if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 12) throw new Error('大纲规划阶段数量须为 1 到 12 的整数。');
  if (typeof brief !== 'string' || !brief.trim()) throw new Error('请填写本次大纲需求。');
  const recent = ctx.chat.map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.extra?.bbs_internal_notice && !m.extra?.bbs_omit && (!m.is_system || m.extra?.bbs_hidden))
    .slice(-8);

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
  const card = typeof character?.description === 'string' ? character.description : '';
  return [
    { role: 'system', content: OUTLINE_PROMPT },
    { role: 'user', content: '[角色卡；设定不等于已发生剧情]\n' + clip(card, 3000) },
    { role: 'user', content: memoryText },
    { role: 'user', content: recentHeading + rows.join('\n\n') },
    { role: 'user', content: `[本次最新用户 input；优先于旧创作方向]\n${brief.trim()}\n\n结合既有剧情与 L1/L2 压缩历史，严格输出 ${chapterCount} 个规划阶段（chapters 数组长度必须为 ${chapterCount}）。每阶段包含 goal 阶段目标、beats 剧情要点、approach 发展方式、exitCriteria 推进条件，不写固定章节小作文。只按规定 JSON 输出；这是未来创作规划，不是已发生事件，不更新任何状态或角色真实承诺。` },
  ];
}
