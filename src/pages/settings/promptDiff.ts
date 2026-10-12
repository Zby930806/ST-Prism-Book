/**
 * 提示词按行对比:设置页「内置已更新」时列出内置改了什么(或你的版本和现在的内置有哪些不同)。
 * 纯函数,不依赖界面;提示词只有几百行,用最长公共子序列逐行比较就够快。
 */

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** 折叠后的显示行:相同的长段换成一行「中间相同 N 行」。 */
export type DiffRow = DiffLine | { type: 'skip'; count: number };

const splitLines = (text: string) => text.replace(/\r\n/g, '\n').split('\n');

/** 逐行比较,before 里有、after 里没有的记 del,反之记 add,两边都有的记 same。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** 只留改动和前后 context 行,其余相同的连续行折叠;没有改动时返回空数组。 */
export function diffHunks(lines: DiffLine[], context = 1): DiffRow[] {
  if (!lines.some(l => l.type !== 'same')) return [];
  const keep = lines.map(l => l.type !== 'same');
  lines.forEach((l, idx) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) rows.push({ type: 'skip', count: skipped });
      skipped = 0;
      rows.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped) rows.push({ type: 'skip', count: skipped });
  return rows;
}

/** 增删了多少行,给差异标题用。 */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}
