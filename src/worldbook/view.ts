/** 世界书页面的显示辅助：改前改后分段、上下文裁剪、时间与楼层的写法。纯函数，便于测试。 */
import { diffSentences, type DiffPart } from './entries';
import type { Suggestion } from './types';

export type { DiffPart };

/**
 * 改前改后两列。追加和替换的位置是确定的，按字标出；改写按句对比。
 * current 为条目当前内容。
 */
export function changeParts(s: Suggestion, current: string): { before: DiffPart[]; after: DiffPart[] } {
  if (s.kind === 'append') {
    const base = current.replace(/\s+$/, '');
    return { before: base ? [{ text: base, type: 'same' }] : [], after: [...(base ? [{ text: base + '\n', type: 'same' as const }] : []), { text: s.content.trim(), type: 'added' }] };
  }
  if (s.kind === 'replace') {
    const at = current.indexOf(s.find);
    if (at < 0) return { before: [{ text: current, type: 'same' }], after: [{ text: current, type: 'same' }] };
    const pre = current.slice(0, at), post = current.slice(at + s.find.length);
    const keep = (t: string): DiffPart[] => t ? [{ text: t, type: 'same' }] : [];
    return {
      before: [...keep(pre), { text: s.find, type: 'removed' }, ...keep(post)],
      after: [...keep(pre), ...(s.content ? [{ text: s.content, type: 'added' as const }] : []), ...keep(post)],
    };
  }
  if (s.kind === 'rewrite') return diffSentences(current, s.content);
  return { before: [{ text: current, type: 'same' }], after: [{ text: current, type: 'same' }] };
}

/** 裁剪未改动的长段落：只保留改动附近 context 个字，其余用省略号代替（展开全文时不裁剪）。 */
export function trimContext(parts: DiffPart[], context = 120): DiffPart[] {
  if (!parts.some(p => p.type !== 'same')) return parts;
  return parts.map((p, i) => {
    if (p.type !== 'same' || p.text.length <= context * 2) return p;
    if (i === 0) return { ...p, text: '…' + p.text.slice(-context) };
    if (i === parts.length - 1) return { ...p, text: p.text.slice(0, context) + '…' };
    return { ...p, text: p.text.slice(0, context) + '……' + p.text.slice(-context) };
  });
}

export function floorsText(floors: number[]): string {
  return floors.length ? '第 ' + floors.join('、') + ' 楼' : '';
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '时间未知'
    : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
