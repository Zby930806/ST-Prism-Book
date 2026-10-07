import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkForUpdate, performUpdate, updateState, INTERNAL_UPDATE_NOTICE } from './update';
const read = (file: string) => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
afterEach(() => { vi.unstubAllGlobals(); updateState.latest = ''; updateState.available = false; updateState.checking = false; });
describe('棱镜宝书内部发行约束', () => {
  it.each([false, true])('更新检查 force=%s 不发起请求', async force => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await checkForUpdate(force); expect(fetch).not.toHaveBeenCalled();
  });
  it('更新检查清除过期的可升级状态', async () => {
    updateState.latest = '9.9.9'; updateState.available = true; updateState.checking = true;
    await checkForUpdate();
    expect(updateState.latest).toBe(''); expect(updateState.available).toBe(false); expect(updateState.checking).toBe(false);
  });
  it('不能调用旧一键更新入口', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(performUpdate()).rejects.toThrow(INTERNAL_UPDATE_NOTICE);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('发布标识一致且不自动跟随上游更新', () => {
    const pkg = JSON.parse(read('package.json')); const manifest = JSON.parse(read('manifest.json'));
    expect(pkg.name).toBe('st-prism-book'); expect(pkg.private).toBe(true);
    expect(manifest.display_name).toBe('棱镜宝书'); expect(manifest.version).toBe(pkg.version);
    expect(manifest.js).toBe('dist/index.js?ver=' + pkg.version); expect(manifest.auto_update).toBe(false);
    expect(manifest.homePage).toBeUndefined(); expect(manifest.generate_interceptor).toBe('bbs_generateInterceptor');
  });
  it('旧记忆、设置、页面和标签标识保持兼容', () => {
    expect(read('src/memory/types.ts')).toContain("MEMORY_KEY = 'baibai_book'");
    expect(read('src/api/settings.ts')).toContain("SETTINGS_KEY = 'baibai_book'");
    expect(read('src/state/ui.ts')).toContain("bbs.ui.page.v1");
    for (const tag of ['bbs_start', 'bbs_end', 'bbs_items', 'bbs_vars']) expect(read('src/memory/timeTag.ts')).toContain(tag);
  });
  it('旧公共API和事件保持兼容', () => {
    const register = read('src/public/register.ts');
    for (const value of ['st-baibai-book:ready', 'st-baibai-book:changed', '.STBaiBaiBook = api']) expect(register).toContain(value);
    expect(read('src/index.ts')).toContain('bbs_generateInterceptor');
  });
  it('设置页标识内部版本并保留原作出处', () => {
    const settings = read('src/pages/settings/index.vue');
    expect(settings).toContain('内部版'); expect(settings).toContain('INTERNAL_UPDATE_NOTICE');
    expect(settings).not.toContain('checkForUpdate');
    expect(read('NOTICE.md')).toContain('https://github.com/baibai-git/ST-BaiBai-Book');
    expect(read('NOTICE.md')).toContain('不重新许可第三方代码');
  });
});
