import type { OutlineActive } from './types';

/** 纯文本独立注入，不包含后续章节，也不产出任何记忆更新指令。 */
export function renderOutlineGuidance(active: OutlineActive): string {
  const chapter = active.content.chapters[active.currentChapter];
  if (!active.enabled || !chapter) return '';
  const text = '[用户已确认的戏外大纲：未来创作指引，不是已发生事实]\n' +
    '只按当前章节逐步推进，每次续写推进适量情节，不在一轮写完所有节点，不跳到后续章节。用户本轮明确要求与已发生事实优先；若大纲与它们冲突，遵从用户并保持事实连续性，不强行圆回大纲。不得替用户角色决定行动或新增承诺。' +
    '章节节点是可调整的计划，不表示已经发生；角色不知道这份大纲。与札记已确认安排冲突时，不同时强行实现两套方案，必要时向用户核对。' +
    '正文只写故事，不复述大纲清单、不输出大纲/札记/物品变动协议；摘要仅记录真正发生在正文中的事件。不得自行宣告本章完成或推进章节。\n' +
    `大纲：${active.content.title}\n总体方向：${active.content.premise}\n` +
    `持续约束：\n${active.content.constraints.map(t => '- ' + t).join('\n') || '无额外约束'}\n` +
    `当前第 ${active.currentChapter + 1} / ${active.content.chapters.length} 阶段：${chapter.title}\n` +
    `阶段目标：${chapter.goal}\n发展方式：${chapter.approach}\n剧情要点（尚未发生）：\n${chapter.beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n` +
    `推进条件（由用户核对进度）：${chapter.exitCriteria}\n[戏外大纲结束]`;
  if (text.length > 12000) throw new Error('本章与全局约束超过12000字注入上限，请精简大纲后再启用。');
  return text;
}
