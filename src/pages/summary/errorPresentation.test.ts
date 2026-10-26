import { describe, expect, it } from 'vitest';
import { summaryErrorPresentation } from './errorPresentation';
describe('摘要失败的阅读说明', () => {
  it('显示具体楼层、未保存保护与局部重试方法，保留完整技术原因', () => {
    const raw = '楼层 #206 摘要未保存（该楼已有记录保持不变）。赵宪.conditionPatch.add[0].evidence 与本轮正文不匹配';
    const view = summaryErrorPresentation(raw);
    expect(view.title).toContain('#206'); expect(view.title).toContain('引用与正文不一致');
    expect(view.title).not.toContain('conditionPatch');
    expect(view.help).toContain('已有记录保持不变'); expect(view.help).toContain('无需全部重新摘要');
    expect(view.details).toBe(raw);
  });
  it('区分漏证据与其他格式错误', () => {
    expect(summaryErrorPresentation('甲.conditionPatch.add[0].evidence 缺失').title).toContain('证据字段格式不完整');
    expect(summaryErrorPresentation('甲.conditionPatch.add 必须是数组').title).toContain('更新格式不符合要求');
  });
  it.each(['接口不可用', '取消操作', '', 'summary 超过字数上限'])('其他错误保持原文 %s', raw => {
    expect(summaryErrorPresentation(raw)).toEqual({ title: raw, help: '', details: '', detailsLabel: '' });
  });
  it.each([
    ['楼层 #3 摘要未保存（该楼已有记录保持不变）。摘要结果必须是根对象，且包含非空字符串 summary。', '没有按要求输出摘要 JSON'],
    ['楼层 #3 摘要未保存（该楼已有记录保持不变）。角色定位引文与本楼正文不匹配。\n定位诊断：npcs.update[0]', '角色位置的引用与本楼正文不一致'],
    ['楼层 #3 摘要未保存（该楼已有记录保持不变）。items.add.qty 必须是明确的有限正数', '物品数量写得不明确'],
    ['楼层 #3 摘要未保存（该楼已有记录保持不变）。必须填写 stateChanges 数组', '状态清单与实际写出的更新不一致'],
    ['楼层 #3 摘要未保存（该楼已有记录保持不变）。状态更新含无效条目：plans.update[0]编号 p5 不存在（当前可用 p1–p3）。', '编号不存在'],
    ['楼层 #3 摘要未保存（该楼已有记录保持不变）。lifeDetails.add 每条都必须写明所属人物 subject', '生活档案没有写明所属人物'],
  ])('校验失败翻译成可读原因并保留原文：%s', (raw, reason) => {
    const view = summaryErrorPresentation(raw);
    expect(view.title).toContain('第 #3 楼');
    expect(view.title).toContain(reason);
    expect(view.help).toContain('已有记录保持不变');
    expect(view.details).toBe(raw);
  });
  it('API 失败使用分行说明；说明与当前错误不一致时不展示过期细节', () => {
    const failure = { message: '楼层 #5 摘要未完成：回复被截断。请调大…', title: '楼层 #5 摘要未完成：回复被截断', hint: '请调大「最大 token」。', detail: 'finish_reason=length' };
    expect(summaryErrorPresentation(failure.message, failure)).toEqual({ title: failure.title, help: failure.hint, details: failure.detail, detailsLabel: '技术细节' });
    expect(summaryErrorPresentation('另一条错误', failure)).toEqual({ title: '另一条错误', help: '', details: '', detailsLabel: '' });
  });
  it.each([
    ['漏掉了楼层 #23；材料中的每个楼层都要写一条。', '漏写了其中的楼层'],
    ['楼层 #7 写了不止一条；每层只写一条。', '写了不止一条'],
    ['floors 中出现了材料以外的楼层「99」；只为材料中的楼层各写一条。', '楼层号与材料不符'],
    ['结果的根键 floors 必须是数组。', '没有按要求输出各层摘要的 JSON'],
    ['漏掉了楼层 #23（或摘要为空），同时出现了材料以外的楼层「24」，楼层编号可能整体错位，这一组没有保存。', '可能整体错位'],
  ])('合并摘要未通过校验时说明是哪组楼层、原因和改法：%s', (reason, text) => {
    const raw = '楼层 #1–#23 合并摘要未保存（这些楼层仍待摘要）。' + reason;
    const view = summaryErrorPresentation(raw);
    expect(view.title).toContain('楼层 #1–#23 的合并摘要没有保存');
    expect(view.title).toContain(text);
    expect(view.help).toContain('仍待摘要');
    expect(view.help).toContain('每次合并的楼层数');
    expect(view.details).toBe(raw);
  });
});
