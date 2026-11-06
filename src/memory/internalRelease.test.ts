import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { INTERNAL_UPDATE_NOTICE } from './update';
const read = (file: string) => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
describe('棱镜宝书内部发行约束', () => {
  it('插件内更新只从安装来源拉取，不访问原版柏宝书的更新源（检查与更新的行为见 update.test.ts）', () => {
    const source = read('src/memory/update.ts');
    expect(source).not.toContain('raw.githubusercontent.com/baibai-git');
    expect(source).toContain('/api/extensions/update');
    expect(INTERNAL_UPDATE_NOTICE).toContain('不会装上原版柏宝书的更新');
  });
  it('发布标识一致；酒馆从本仓库提示和更新（auto_update），插件自身不访问上游', () => {
    const pkg = JSON.parse(read('package.json')); const manifest = JSON.parse(read('manifest.json'));
    expect(pkg.name).toBe('st-prism-book'); expect(pkg.private).toBe(true);
    expect(manifest.display_name).toBe('棱镜宝书'); expect(manifest.version).toBe(pkg.version);
    expect(manifest.js).toBe('dist/index.js?ver=' + pkg.version); expect(manifest.auto_update).toBe(true);
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
  it('设置页显示版本和更新方式并保留原作出处', () => {
    const settings = read('src/pages/settings/index.vue');
    expect(settings).not.toContain('内部版'); expect(settings).toContain('INTERNAL_UPDATE_NOTICE');
    expect(INTERNAL_UPDATE_NOTICE).toContain('管理扩展'); expect(INTERNAL_UPDATE_NOTICE).toContain('自动刷新酒馆');
    expect(settings).toContain('checkForUpdate(true)'); expect(settings).toContain('openUpdateDialog');
    expect(read('src/App.vue')).toContain('<UpdateDialog />');
    expect(read('NOTICE.md')).toContain('https://github.com/baibai-git/ST-BaiBai-Book');
    expect(read('NOTICE.md')).toContain('不重新许可第三方代码');
  });
});
