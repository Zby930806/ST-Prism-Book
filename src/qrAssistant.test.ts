import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerQrAssistantButton, unregisterQrAssistantButton } from './qrAssistant';

// QR助手每次重建菜单都重读 window.qrAssistantExtensionApi;这里只核对我们写进去的登记项。
afterEach(() => { vi.unstubAllGlobals(); });

describe('登记进 QR助手的菜单', () => {
  it('没有数组时先建好；同一按钮只登记一次，文字变了就改写', () => {
    vi.stubGlobal('window', {});
    registerQrAssistantButton('bbs-qr-recall', '召回');
    registerQrAssistantButton('bbs-qr-recall', '召回 3');
    registerQrAssistantButton('bbs-qr-button', '棱镜宝书');
    expect(window.qrAssistantExtensionApi).toEqual([
      { dom_id: 'bbs-qr-recall', group_name: '棱镜宝书', button_name: '召回 3' },
      { dom_id: 'bbs-qr-button', group_name: '棱镜宝书', button_name: '棱镜宝书' },
    ]);
  });

  it('不动其他插件的登记项；撤下按钮时只取消自己的', () => {
    const other = { dom_id: 'zero-preset-btn', group_name: '预设管理' };
    vi.stubGlobal('window', { qrAssistantExtensionApi: [other] });
    registerQrAssistantButton('bbs-qr-recall', '召回');
    unregisterQrAssistantButton('bbs-qr-recall');
    unregisterQrAssistantButton('bbs-qr-button');
    expect(window.qrAssistantExtensionApi).toEqual([other]);
  });

  it('全局变量被别的插件占成非数组时不覆盖、不报错', () => {
    vi.stubGlobal('window', { qrAssistantExtensionApi: 'not-a-list' });
    expect(() => registerQrAssistantButton('bbs-qr-recall', '召回')).not.toThrow();
    expect(() => unregisterQrAssistantButton('bbs-qr-recall')).not.toThrow();
    expect(window.qrAssistantExtensionApi).toBe('not-a-list');
  });
});
