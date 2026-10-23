import { afterEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import { blockLocalNote, blockSent } from './sendScope';

const original = JSON.parse(JSON.stringify({ summaryOnlyMode: apiSettings.summaryOnlyMode, injection: apiSettings.injection }));
afterEach(() => {
  apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(apiSettings.injection, original.injection);
});

describe('角色页的发送说明与注入条件一致', () => {
  it('默认全部发送', () => {
    for (const block of ['protagonist', 'npcs', 'secrets', 'lifeDetails'] as const) {
      expect(blockSent(block)).toBe(true);
      expect(blockLocalNote(block)).toBeUndefined();
    }
  });

  it('关闭场景信息时主要角色、NPC 和信息差都不发送，主角和生活档案不受影响', () => {
    apiSettings.injection.scenes = false;
    expect(blockSent('npcs')).toBe(false);
    expect(blockSent('secrets')).toBe(false);
    expect(blockSent('protagonist')).toBe(true);
    expect(blockSent('lifeDetails')).toBe(true);
    expect(blockLocalNote('npcs')).toBe('注入设置中已关闭，不发送给正文模型');
  });

  it('各自的开关分别生效；仅注入剧情摘要时全部不发送', () => {
    apiSettings.injection.protagonist = false;
    apiSettings.injection.lifeDetails = false;
    apiSettings.injection.secrets = false;
    expect([blockSent('protagonist'), blockSent('lifeDetails'), blockSent('secrets'), blockSent('npcs')]).toEqual([false, false, false, true]);
    Object.assign(apiSettings.injection, original.injection);
    apiSettings.summaryOnlyMode = true;
    expect(blockSent('protagonist')).toBe(false);
    expect(blockLocalNote('lifeDetails')).toBe('仅供棱镜宝书记录，不发送给主对话 AI');
  });
});
