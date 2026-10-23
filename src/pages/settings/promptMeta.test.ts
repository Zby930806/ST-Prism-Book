import { describe, expect, it } from 'vitest';
import { taskContextModeAfterSave } from './promptMeta';

describe('保存任务说明后的模式', () => {
  it('原来禁用的保持禁用：查看后点「完成」不会悄悄重新启用', () => {
    expect(taskContextModeAfterSave('disabled', true)).toBe('disabled');
    expect(taskContextModeAfterSave('disabled', false)).toBe('disabled');
  });
  it('原来是内置或自定义的按内容切换', () => {
    expect(taskContextModeAfterSave('default', false)).toBe('custom');
    expect(taskContextModeAfterSave('custom', true)).toBe('default');
    expect(taskContextModeAfterSave('custom', false)).toBe('custom');
  });
});
