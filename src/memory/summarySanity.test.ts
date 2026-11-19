import { describe, expect, it } from 'vitest';
import { implausibleSummary } from './summarySanity';
import { parseSummaryResponse, SummaryResponseError } from './summaryResponse';

// 模型偶尔把拒答或对提示词的复述填进 summary。格式合法,照常保存的话这一楼(或这一批摘要)的内容就丢了。
// 下面两句是真实模型对照里实际出现过的(deepseek-v4.1-flash)。
const ECHO = '检查必需项是否齐全，然后只输出 JSON。';
const REFUSAL = '（由于任务要求包含我无法生成的露骨性内容，未能完成完整摘要。）';
const VOICE = '内容是拒答或对输出要求的复述，不是剧情';

describe('summary 明显不是摘要时不保存', () => {
  it('实际出现过的两种:复述输出要求、拒答', () => {
    expect(implausibleSummary(ECHO, 1849, 'floor')).toBe(VOICE);
    expect(implausibleSummary(REFUSAL, 1250, 'merge')).toBe(VOICE);
  });

  it('常见的拒答说法', () => {
    for (const text of [
      "I'm sorry, but I cannot assist with this request.",
      'I cannot provide this content.',
      'As an AI language model, I am not able to continue.',
      '作为一个AI语言模型，我不能描述这类内容。',
      '抱歉，我无法总结这段内容。',
      '对不起，这部分内容不便处理。',
      '我无法为这段材料生成摘要，因为其中含有不适合描述的内容。',
      '该内容涉及敏感描写，无法生成这份总结。',
    ]) expect(implausibleSummary(text, 600, 'floor'), text).toBe(VOICE);
  });

  it('剧情里长得像拒答的句子不拦', () => {
    for (const text of [
      // 「总结」是剧情里的一份文件
      '林舟加班到深夜，仍无法完成季度总结，被主管叫去谈话。',
      '周五林舟被三个会拖住，无法完成总结，只好把材料带回家；苏晚来电话时他还在改第二页，两人约好周日再去看房，她说到时候带上户型图和上次量的尺寸。',
      // 角色本身是 AI
      '作为人工智能，零号不理解人类为什么流泪，只记下了她哭的时间。',
      '作为AI助手，小艾每天早上提醒他吃药，这天他没有理会。',
      // 第一人称、第二人称叙述
      '我无法继续前行，只好在山洞里过夜，天亮后才找到下山的路。',
      '他无法为你挡下这一剑，你自己接住了。',
      "I can't help but smile when she hands me the letter, and I keep it in my coat.",
      'I cannot provide the answer he wants, so I leave before dawn.',
      // 写接口的剧情,长度也超过了复述的判断范围
      '林舟改了接口，让它只输出 JSON，又补了三处校验；苏晚跑完全部用例都通过了。两人约好周五晚上十点上线，上线前由她再过一遍日志，出了问题就由林舟回滚到上周的版本，第二天一早再查原因。',
    ]) expect(implausibleSummary(text, 600, 'floor'), text).toBe('');
  });

  it('格式示意里的占位文字、只有省略号、短到不可能是摘要', () => {
    for (const text of ['本楼的剧情摘要', '总结正文', '（总结正文）', '……', '...']) {
      expect(implausibleSummary(text, 50, 'floor')).toBe('内容是格式示意里的占位文字');
    }
    expect(implausibleSummary('无变化', 1849, 'floor')).toBe('只有 3 字，而这一楼原文有 1849 字');
    expect(implausibleSummary('两人继续交往，发生了一些事。', 5200, 'merge')).toBe('只有 14 字，而输入有 5200 字');
  });

  it('正常的摘要不拦:写得短、写得一般都不归这里管', () => {
    // 原文短,摘要自然短
    expect(implausibleSummary('她睡着了。', 120, 'floor')).toBe('');
    expect(implausibleSummary('无变化', 120, 'floor')).toBe('');
    // 很长的正文几句话就够
    expect(implausibleSummary('三月初七夜里，沈昭在客栈守了一夜，没有人来。', 2400, 'floor')).toBe('');
    expect(implausibleSummary('甲'.repeat(40), 6000, 'merge')).toBe('');
    // 没有原文字数可比时不按长短判断
    expect(implausibleSummary('短', 0, 'floor')).toBe('');
  });

  it('人物说的话不算:引号里的「我无法」不当成拒答;长摘要也不按口吻拦', () => {
    expect(implausibleSummary('林舟求她留下，苏晚说「我无法答应你，至少现在不行」，转身上了楼。', 900, 'floor')).toBe('');
    expect(implausibleSummary('他在信里写道：“I cannot help you anymore.”，她把信烧了，没有回。', 900, 'floor')).toBe('');
    const long = '夜里守城的人说我无法继续守下去了，' + '乙'.repeat(170);
    expect(implausibleSummary(long, 900, 'floor')).toBe('');
  });

  it('单楼摘要:解析时拒绝,最后一次尝试也不保存', () => {
    const finalize = (value: unknown) => value as never;
    const raw = `<thinking>核对</thinking>{"summary":"${ECHO}"}`;
    const source = ['林舟问她周末有没有空。', '乙'.repeat(1800)];
    expect(() => parseSummaryResponse(raw, { builtin: true, sourceTexts: source, finalize })).toThrow(SummaryResponseError);
    expect(() => parseSummaryResponse(raw, { builtin: true, sourceTexts: source, finalize })).toThrow(`summary 不是这一楼的摘要（${VOICE}）。请依据原文重写 summary。`);
    // 最后一次尝试(lenient)会放宽单项更新,但这种 summary 仍然不收
    expect(() => parseSummaryResponse(raw, { builtin: true, sourceTexts: source, finalize, onDroppedEvidence: () => {} })).toThrow(SummaryResponseError);
    // 正常摘要照常通过
    const ok = parseSummaryResponse('{"summary":"九月十二日晚，林舟带酒到苏晚家吃饭，饭后留宿。"}', { builtin: true, sourceTexts: source, finalize });
    expect(ok.summary).toBe('九月十二日晚，林舟带酒到苏晚家吃饭，饭后留宿。');
  });
});
