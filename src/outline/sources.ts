import { getContext, type STContext } from '@/st/context';
import { activeDecisions } from '@/notes/store';
import { notesSettings } from '@/notes/settings';

/** 资料段的选取范围:最近若干条正文触发世界书,常驻条目始终在内。 */
export const OUTLINE_RECENT_FLOORS = 8;

/** 参与规划的最近楼层(跳过插件提示楼、番外楼和原生系统楼;被隐藏的旧楼照常算)。 */
export function outlineRecentIndices(ctx: STContext): number[] {
  return ctx.chat.map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.extra?.bbs_internal_notice && !m.extra?.bbs_omit && (!m.is_system || m.extra?.bbs_hidden))
    .slice(-OUTLINE_RECENT_FLOORS)
    .map(({ i }) => i);
}

/**
 * 当前启用的世界书条目:常驻条目 + 最近正文触发的条目,与摘要读取世界书的口径相同
 * (遵守「排除世界书内容」设置,展开宏)。读取失败时返回空串,规划照常生成,只是少了世界书资料。
 */
export async function outlineWorldInfo(ctx = getContext()): Promise<string> {
  if (!ctx?.chat) return '';
  try {
    const { fetchWorldInfo } = await import('@/memory/engine');
    return (await fetchWorldInfo(ctx.chat, outlineRecentIndices(ctx), ctx.name1, ctx.name2)).trim();
  } catch (error) {
    console.warn('[棱镜宝书] 规划读取世界书失败(本次不带世界书资料)', error);
    return '';
  }
}

/** 札记中已确认、仍在生效的安排(待兑现、进行中),作为用户认可的写作方向交给规划参考;札记关闭时不带。 */
export function outlineArrangements(): string {
  try {
    if (!notesSettings.enabled) return '';
    return activeDecisions().map(d => `- ${d.text.replace(/\s+/g, ' ').trim()}`).filter(line => line.length > 2).join('\n');
  } catch {
    return '';
  }
}
