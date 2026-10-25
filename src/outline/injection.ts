import type { OutlineActive, OutlineContent, OutlinePace } from './types';
import { OUTLINE_LIMITS } from './limits';

/** 推进节奏的写法：放在开头的规则里一次，剧情要点的标题里再提醒一次（离要点最近，模型最容易照做）。 */
const PACE_RULE: Record<OutlinePace, string> = {
  slow: '本阶段要经过多轮回复逐步展开：每轮最多推进一个剧情要点，也可以一个都不推进，先把当前场景的互动写充分，回复停在需要用户回应的地方；',
  normal: '本阶段要经过多轮回复逐步展开：每轮最多推进一到两个剧情要点，不在一轮写完所有要点，回复停在需要用户回应的地方；',
  fast: '每轮可以推进多个剧情要点，但不在一轮写完整个阶段；',
};
const PACE_BEATS: Record<OutlinePace, string> = {
  slow: '尚未发生；按顺序分多轮展开，每轮最多推进一个',
  normal: '尚未发生；按顺序分多轮展开，每轮最多推进一到两个',
  fast: '尚未发生；按顺序展开',
};
const PACES = Object.keys(PACE_RULE) as OutlinePace[];

/** 某一阶段注入正文的完整文字（不检查长度）。纯文本独立注入，不包含后续阶段，也不产出任何记忆更新指令。 */
export function outlineGuidanceText(active: OutlineActive, pace: OutlinePace = 'normal'): string {
  const chapter = active.content.chapters[active.currentChapter];
  if (!active.enabled || !chapter) return '';
  return '[用户已确认的创作规划：未来创作指引，不是已发生事实]\n' +
    `围绕当前阶段自然发展，${PACE_RULE[pace]}不要求每轮完成节点，不提前执行后续阶段。用户本轮明确要求与已发生事实优先；若规划与它们冲突，遵从用户并保持事实连续性，不强行圆回规划。不得替用户角色决定行动或新增承诺。\n` +
    '角色的活人感优先于节点完成：依据角色既有性格、动机、当下情绪、关系与实际知情范围反应，不让所有角色全知、讨好主角或自动配合。角色可以有自己的关注、迟疑、拒绝、误解和改变主意，但须有情境依据，不凭空添加秘密或创伤。情绪与关系有惯性，不为剧情需要突然坦白、亲近、原谅或翻脸；保留合乎人物的日常互动、沉默和暂时没有结果的交流。不要用统一口癖、小动作、强制争吵或堆砌心理描写伪装活人感。\n' +
    '规划提供可能性而非人物表演脚本：不要照抄规划中的动机说明当台词，不直接揭露未知内心。若预定节点违背人物合理反应，允许延后、调整或不兑现，不硬拉回主线；保留原正文文风，不套用计划清单的表达。剧情要点是可调整的计划，不表示已经发生；角色不知道这份规划。与札记已确认安排冲突时，暂缓冲突的部分，不同时强行实现两套方案；以用户本轮明确要求和已发生的事实为准；不在正文中向用户提问，也不插入戏外说明。\n' +
    '正文只写故事，不复述规划清单、不输出规划/札记/物品变动协议；摘要仅记录真正发生在正文中的事件。不得自行宣告本阶段完成或推进阶段：阶段由用户切换，或由插件的推进条件检查判定后切换。\n' +
    `规划：${active.content.title}\n总体方向：${active.content.premise}\n` +
    `持续约束：\n${active.content.constraints.map(t => '- ' + t).join('\n') || '无额外约束'}\n` +
    `当前第 ${active.currentChapter + 1} / ${active.content.chapters.length} 阶段：${chapter.title}\n` +
    `阶段目标：${chapter.goal}\n发展方式：${chapter.approach}\n剧情要点（${PACE_BEATS[pace]}）：\n${chapter.beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n` +
    `推进条件（由用户或推进条件检查核对）：${chapter.exitCriteria}\n[创作规划结束]`;
}

/** 注入文字在各种推进节奏下最长的长度：检查上限时按最长的算，切换节奏后不会超出。 */
export function outlineGuidanceLength(active: OutlineActive): number {
  return Math.max(...PACES.map(pace => outlineGuidanceText(active, pace).length));
}

/** 当前阶段注入正文的文字；超过注入上限时报错，不截断或丢弃约束。 */
export function renderOutlineGuidance(active: OutlineActive, pace: OutlinePace = 'normal'): string {
  const text = outlineGuidanceText(active, pace);
  if (outlineGuidanceLength(active) > OUTLINE_LIMITS.injection) throw new Error('当前阶段与全局约束超过' + OUTLINE_LIMITS.injection + '字符注入上限，请精简后再启用；不会截断或丢弃约束。');
  return text;
}

/** 各阶段连同整体约束和固定说明注入正文时超出注入上限的阶段（over 为多出的字数）。 */
export function outlineStageOverflows(content: OutlineContent): Array<{ index: number; length: number; over: number }> {
  return content.chapters.map((_, index) => {
    const length = outlineGuidanceLength({ id: '', createdAt: 0, sourceFloor: 0, sourceHash: '', brief: '', content, enabled: true, currentChapter: index });
    return { index, length, over: length - OUTLINE_LIMITS.injection };
  }).filter(stage => stage.over > 0);
}

/** 超限说明：指出第几阶段、多出多少字。 */
export function outlineOverflowMessage(overflow: Array<{ index: number; over: number }>): string {
  const parts = overflow.map(stage => `第 ${stage.index + 1} 阶段多 ${stage.over} 字`).join('，');
  return `${parts}：每个阶段连同整体约束注入正文时不能超过 ${OUTLINE_LIMITS.injection} 字。草稿可以先保存，请精简这些阶段或整体约束后再加入计划。`;
}
