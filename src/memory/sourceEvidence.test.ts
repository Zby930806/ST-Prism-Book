import { describe, expect, it, vi } from 'vitest';
import { finalizeDelta } from './apply';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';
import { renderSourceHints, type SourceExcerpt } from './sourceHints';
import type { SummaryDelta } from './types';

// 固定的虚构消息；不读取聊天。每个合法引句都明确包含同一主体小A。
const oldCondition = '右手腕仍有伤，不能负重';
const quote = '小A在厨房休养，右手腕仍有伤，至少还需休养四五天。';
const rawMessage = '小A在**厨房休养**，\n右手腕仍有伤，**至少还需休养四五天**。';
const unrelatedMessage = '小B在庭院浇花。';

// 复现 renderMessages 的逐行编号与真实来源提示，不导入依赖宿主聊天的 engine。
function renderMaterial(messages: readonly string[]) {
  const sources: SourceExcerpt[] = [];
  const content = messages.map((message, i) => {
    const body = message.split(/\r?\n/).filter(line => line.trim()).map((line, p) => {
      const excerpt = { source: `[M${i + 1}-P${p + 1}]`, text: line };
      sources.push(excerpt);
      return `${excerpt.source} ${excerpt.text}`;
    }).join('\n');
    return `【角色·叙述者】\n${body}`;
  }).join('\n\n');
  return content + renderSourceHints(sources);
}

const material = renderMaterial([rawMessage]);
type EvidenceKind = 'conditionPatch.add' | 'conditionPatch.replace' | 'locationEvidence';
function fields(kind: EvidenceKind, evidence: string) {
  if (kind === 'locationEvidence') return { location: '厨房', locationEvidence: evidence };
  if (kind === 'conditionPatch.replace') return {
    conditionPatch: { replace: [{ id: 'c1', text: '右手腕仍有伤、至少还需休养四五天', evidence }] },
  };
  return { conditionPatch: { add: [{ text: '至少还需休养四五天', evidence }] } };
}

function request(update: object, sourceContent: string, sourceTexts?: readonly string[]) {
  const previous = { protagonist: {}, npcs: [{ name: '小A', condition: oldCondition }] };
  const finalize = vi.fn((delta: SummaryDelta) => finalizeDelta(delta, []));
  const run = () => parseSummaryResponse(JSON.stringify({
    summary: '小A在厨房休养，手腕仍有伤。', stateChanges: ['npcs'], npcs: { update: [{ name: '小A', ...update }] },
  }), {
    requireStateChanges: true,
    sourceContent,
    // 只从正式入口传数组，不能在 conditionContext 重复传入以掩盖透传失败。
    ...(sourceTexts === undefined ? {} : { sourceTexts }),
    conditionContext: { ...previous, content: sourceContent, strict: true },
    finalize,
  });
  return { run, previous, finalize };
}

function expectAccepted(kind: EvidenceKind, evidence: string, sourceContent: string, sourceTexts?: readonly string[]) {
  const { run, previous, finalize } = request(fields(kind, evidence), sourceContent, sourceTexts);
  const result = run();
  const npc = result.npcs?.update?.[0];
  if (kind === 'locationEvidence') expect(npc).toMatchObject({ name: '小A', location: '厨房' });
  else expect(npc?.condition).toBe(kind === 'conditionPatch.add'
    ? oldCondition + '；至少还需休养四五天'
    : '右手腕仍有伤、至少还需休养四五天，不能负重');
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(previous.npcs[0].condition).toBe(oldCondition);
  expect(JSON.stringify(result)).not.toMatch(/conditionPatch|locationEvidence|"evidence"/);
  return result;
}

function expectRejected(kind: EvidenceKind, evidence: string, sourceContent: string, sourceTexts?: readonly string[]) {
  const { run, previous, finalize } = request(fields(kind, evidence), sourceContent, sourceTexts);
  expect(run).toThrow(SummaryResponseError);
  expect(finalize).not.toHaveBeenCalled();
  expect(previous.npcs[0].condition).toBe(oldCondition);
}

describe.each<EvidenceKind>(['conditionPatch.add', 'conditionPatch.replace', 'locationEvidence'])(
  '正式解析入口的 %s 原消息证据边界', kind => {
    it('跨原消息内换行及加粗的完整引句通过，编号材料本身不能匹配', () => {
      expect(material).toContain('[M1-P1] 小A在**厨房休养**，\n[M1-P2] 右手腕仍有伤');
      expect(material).not.toContain(quote);
      expectRejected(kind, quote, material);
      expectAccepted(kind, quote, material, [rawMessage]);
    });

    it('逐条查找原消息，第二条中的跨行引句也可通过', () => {
      const messages = [unrelatedMessage, rawMessage] as const;
      expectAccepted(kind, quote, renderMaterial(messages), messages);
    });

    it('提供原消息时不依赖 sourceContent 中是否保留正文', () => {
      expectAccepted(kind, quote, '【仅供模型使用的程序提示】', [rawMessage]);
    });

    it.each([
      ['带程序编号的正文', '[M1-P1] 小A在**厨房休养**，'],
      ['被编号打断的跨行正文', '[M1-P1] 小A在**厨房休养**，\n[M1-P2] 右手腕仍有伤，**至少还需休养四五天**。'],
      ['程序来源索引', '[M1-P2]'],
      ['程序来源提示', '不能据索引替代完整原文，也不因被标注而整段收入摘要。'],
    ])('仅出现在加工材料中的%s不能成为证据', (_label, evidence) => {
      expect(material).toContain(evidence);
      expect(rawMessage).not.toContain(evidence);
      expectRejected(kind, evidence, material, [rawMessage]);
    });

    it.each([
      ['普通原文片段', ['小A在厨房休养，', '右手腕仍有伤，至少还需休养四五天。']],
      ['带加粗的原文片段', ['小A在**厨房休养**，', '右手腕仍有伤，**至少还需休养四五天**。']],
      ['强调定界符跨消息', ['小A在**厨房休养，', '右手腕仍有伤，至少还需休养四五天**。']],
    ])('不同消息的%s不得拼接，即使 sourceContent 含完整引句', (_label, messages) => {
      // 单条消息内的同样换行合法；仅将同一正文拆成多条消息就必须拒绝。
      expectAccepted(kind, quote, quote, [messages.join('\n')]);
      expectRejected(kind, quote, quote, messages);
    });

    it('sourceTexts 空数组不回退到含合法引句的 sourceContent', () => {
      expectRejected(kind, quote, quote, []);
    });

    it('只有空白原消息也不回退到 sourceContent', () => {
      expectRejected(kind, quote, quote, ['', ' \r\n\t ']);
    });

    it('sourceTexts 有内容但不匹配时不回退到 sourceContent', () => {
      expectRejected(kind, quote, quote, [unrelatedMessage]);
    });

    it.each([
      ['精确原文', quote],
      ['跨行加粗原文', rawMessage],
    ])('未提供 sourceTexts 的旧调用仍兼容%s', (_label, sourceContent) => {
      expectAccepted(kind, quote, sourceContent);
    });
  },
);

describe('位置和伤情共享原消息来源规则', () => {
  const locationQuote = '小A在厨房休养。';
  const conditionQuote = '小A的右手腕仍有伤，至少还需休养四五天。';
  const messages = ['小A在**厨房\n休养**。', '小A的右手腕仍有伤，\n**至少还需休养四五天**。'] as const;

  it('同一响应的两种证据可分别来自不同的完整原消息', () => {
    const { run, finalize, previous } = request({
      ...fields('locationEvidence', locationQuote), ...fields('conditionPatch.add', conditionQuote),
    }, renderMaterial(messages), messages);
    const result = run();
    expect(result.npcs?.update?.[0]).toMatchObject({
      name: '小A', location: '厨房', condition: oldCondition + '；至少还需休养四五天',
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(previous.npcs[0].condition).toBe(oldCondition);
    expect(JSON.stringify(result)).not.toMatch(/conditionPatch|locationEvidence|"evidence"/);
  });

  it.each(['locationEvidence', 'conditionPatch.add'] as const)('%s 借用加工材料时整份响应拒绝，另一类合法也不能绕过', invalidKind => {
    const programOnly = '[M1-P1]';
    const { run, finalize, previous } = request({
      ...fields('locationEvidence', invalidKind === 'locationEvidence' ? programOnly : locationQuote),
      ...fields('conditionPatch.add', invalidKind === 'conditionPatch.add' ? programOnly : conditionQuote),
    }, renderMaterial(messages), messages);
    expect(run).toThrow(SummaryResponseError);
    expect(finalize).not.toHaveBeenCalled();
    expect(previous.npcs[0].condition).toBe(oldCondition);
  });
});
