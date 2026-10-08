import { describe, expect, it } from 'vitest';
import { summaryErrorPresentation } from './errorPresentation';
describe('摘要失败的阅读说明', () => {
  it('显示具体楼层、未保存保护与局部重试方法，保留完整技术原因', () => {
    const raw = '楼层 #206 摘要未保存（该楼已有记录保持不变）。赵宪.conditionPatch.add[0].evidence 与本轮正文不匹配';
    const view = summaryErrorPresentation(raw);
    expect(view.title).toContain('#206'); expect(view.title).toContain('引用与正文不一致');
    expect(view.title).not.toContain('conditionPatch');
    expect(view.help).toContain('已有记录保持不变'); expect(view.help).toContain('无需重建整个聊天');
    expect(view.details).toBe(raw);
  });
  it('区分漏证据与其他格式错误', () => {
    expect(summaryErrorPresentation('甲.conditionPatch.add[0].evidence 缺失').title).toContain('证据字段格式不完整');
    expect(summaryErrorPresentation('甲.conditionPatch.add 必须是数组').title).toContain('更新格式不符合要求');
  });
  it.each(['接口不可用', '取消操作', '', 'summary 超过字数上限'])('其他错误保持原文 %s', raw => {
    expect(summaryErrorPresentation(raw)).toEqual({ title: raw, help: '', details: '' });
  });
});
