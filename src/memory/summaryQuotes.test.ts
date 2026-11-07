import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';

// 这些测试只核对发给模型的规则,不代表模型的文风验收(实测记录见 CHANGELOG 1.4.12)。
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = {
  user: '主角', char: '角色', time: '', location: '', protagonist: {}, sceneFocus: null, lifeDetails: [], items: [], itemLog: [],
  scenes: [], npcs: [], openPlans: [], resolvedPlans: [], history: '', content: '正文。', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
beforeEach(() => Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' }));
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));

describe('摘要保留重要对话的原话', () => {
  it('单楼摘要和合并摘要要求用「」照抄承诺、表白、拒绝等原话，写明谁对谁说，限制句数', () => {
    for (const system of [p.buildSummaryPrompt(args).system, p.buildBatchSummaryPrompt(args).system]) {
      expect(system).toContain('重要对话留原话');
      expect(system).toContain('用「」照抄说话人的原话并写明谁对谁说');
      expect(system).toContain('不改写成「表示…」「表达了…」');
      expect(system).toContain('不改字、不把几句话拼成一句、不替人物补话');
      expect(system).toContain('一楼一般引一两句,最多三句');
      expect(system).toContain('玩笑、拌嘴、寒暄、日常问答、叮嘱和只有语气的话不引用');
      expect(system).toContain('先留承诺、约定、条件、保密要求和威胁');
    }
    expect(p.buildSummaryThinking('主角').checklist).toContain('重要对话是否用「」留下了原话');
    expect(p.BATCH_SUMMARY_THINKING_CHECKLIST).toContain('重要对话用「」留下了原话');
  });

  it('关系线里的承诺和拒绝也先留原话，放不下才转述', () => {
    expect(p.RULE_RELATION_MOMENTUM).toContain('用「」保留短原话,篇幅放不下时才用等义转述');
    expect(p.RULE_RELATION_MOMENTUM).not.toContain('保留短原话或等义转述');
  });
});

describe('总结和二次总结写实，不写空话', () => {
  it('内置总结、二次总结各带一份写实规则，排在输出要求之前', () => {
    for (const level of [1, 2]) {
      for (const contentBoundary of [true, false]) {
        const { system } = p.buildResummaryPrompt({ ...args, level }, { contentBoundary });
        expect(system.split(p.RULE_CONCRETE_SUMMARY)).toHaveLength(2);
        expect(system.indexOf(p.RULE_CONCRETE_SUMMARY)).toBeLessThan(system.indexOf('═══ 【输出要求】 ═══'));
        expect(system.indexOf(p.RULE_SUMMARY_COMPOSITION)).toBeLessThan(system.indexOf(p.RULE_CONCRETE_SUMMARY));
      }
    }
    for (const phrase of ['每句至少落下一件具体的事', '句子照常写完整,不堆分号凑信息', '感情悄然升温', '为后续埋下伏笔', '双方就此进行了沟通',
      '输入里「」中的话是摘要特意留下的原话', '先把事件写清,篇幅还够时再沿用其中最关键的一两句', '字数上限在 300 字以内时最多两句,更长时最多三四句',
      '篇幅紧时先删细节和修饰、合并同类事件,不要把几件事并成一句笼统的话带过', '示例只演示写法,不是剧情资料']) {
      expect(p.RULE_CONCRETE_SUMMARY).toContain(phrase);
    }
    // 不回到以前「信息密度极高」那种写法(会写成电报)
    expect(p.RULE_CONCRETE_SUMMARY).not.toMatch(/信息密度极高|语言冷峻|厚实段落/);
    // 单楼摘要不带这一段
    expect(p.buildSummaryPrompt(args).system).not.toContain('【写实，不写空话】');
  });

  it('核查清单逐句查空话、照抄仍有效的原话；自定义模板只多这一条核查，不加写实规则', () => {
    expect(p.RESUMMARY_THINKING_CHECKLIST).toContain('逐句查空话');
    expect(p.RESUMMARY_THINKING_CHECKLIST).toContain('事件写清后篇幅还够，才照抄输入「」中仍有效的承诺、条件和表态，整段最多三四句');
    expect(p.RESUMMARY_THINKING_CHECKLIST.length).toBeLessThan(1300);
    expect(p.buildResummaryPrompt({ ...args, level: 1 }).checklist).toContain('逐句查空话');
    apiSettings.prompts.resummary = 'CUSTOM {{content}}';
    const custom = p.buildResummaryPrompt({ ...args, level: 1 });
    expect(custom.system + custom.user).not.toContain('【写实，不写空话】');
    expect(custom.checklist).toContain('逐句查空话');
  });

  it('总结的参考字数不是下限，不为凑字数写空话；字数上限里算上原话', () => {
    expect(p.buildResummaryPrompt({ ...args, level: 1 }).system).toContain('字为参考范围,信息少可更短,不为凑下限保留过程或写空话');
    expect(p.buildResummaryPrompt({ ...args, level: 1 }).checklist).toContain('（含标点，原话也算在内）');
    expect(p.buildResummaryPrompt({ ...args, level: 2 }).checklist).toContain('写超时先删低价值细节、重复过程和次要的原话');
  });
});
