import type { OutlineActive } from './types';
import { OUTLINE_LIMITS } from './limits';

/** 纯文本独立注入，不包含后续章节，也不产出任何记忆更新指令。 */
export function renderOutlineGuidance(active: OutlineActive): string {
  const chapter = active.content.chapters[active.currentChapter];
  if (!active.enabled || !chapter) return '';
  const text = '[用户已确认的戏外大纲：未来创作指引，不是已发生事实]\n' +
    '围绕当前阶段自然发展，不要求每轮完成节点，不在一轮写完所有节点，不提前执行后续阶段。用户本轮明确要求与已发生事实优先；若大纲与它们冲突，遵从用户并保持事实连续性，不强行圆回大纲。不得替用户角色决定行动或新增承诺。' +
    '角色的活人感优先于节点完成：依据角色既有性格、动机、当下情绪、关系与实际知情范围反应，不让所有角色全知、讨好主角或自动配合。角色可以有自己的关注、迟疑、拒绝、误解和改变主意，但须有情境依据，不凭空添加秘密或创伤。' +
    '情绪与关系有惯性，不为剧情需要突然坦白、亲近、原谅或翻脸；保留合乎人物的日常互动、沉默和暂时没有结果的交流。不要用统一口癖、小动作、强制争吵或堆砌心理描写伪装活人感。' +
    '规划提供可能性而非人物表演脚本：不要照抄规划中的动机说明当台词，不直接揭露未知内心。若预定节点违背人物合理反应，允许延后、调整或不兑现，不硬拉回主线；保留原正文文风，不套用计划清单的表达。' +
    '章节节点是可调整的计划，不表示已经发生；角色不知道这份大纲。与札记已确认安排冲突时，不同时强行实现两套方案，必要时向用户核对。' +
    '正文只写故事，不复述大纲清单、不输出大纲/札记/物品变动协议；摘要仅记录真正发生在正文中的事件。不得自行宣告本章完成或推进章节。\n' +
    `大纲：${active.content.title}\n总体方向：${active.content.premise}\n` +
    `持续约束：\n${active.content.constraints.map(t => '- ' + t).join('\n') || '无额外约束'}\n` +
    `当前第 ${active.currentChapter + 1} / ${active.content.chapters.length} 阶段：${chapter.title}\n` +
    `阶段目标：${chapter.goal}\n发展方式：${chapter.approach}\n剧情要点（尚未发生）：\n${chapter.beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n` +
    `推进条件（由用户核对进度）：${chapter.exitCriteria}\n[戏外大纲结束]`;
  if (text.length > OUTLINE_LIMITS.injection) throw new Error('当前阶段与全局约束超过' + OUTLINE_LIMITS.injection + '字符注入上限，请精简后再启用；不会截断或丢弃约束。');
  return text;
}
