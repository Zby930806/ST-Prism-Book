import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_VERSION } from '@/version';

vi.mock('@/st/context', () => ({ getContext: vi.fn() }));
vi.mock('@/st/toast', () => ({ toast: vi.fn() }));

const HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' };
const REPO_URL = 'https://github.com/Zby930806/ST-Prism-Book.git';
const README = `# 棱镜宝书

## 功能

- 摘要

## 99.0.0 的改动

总结字数可以自己设。

- 新增 **总结字数**，见 [使用说明书](docs/使用说明书.md)。
- 二次总结不超过 \`二次总结字数\`。

## 98.1.0 的改动（正式版）

- 修正一处问题。

## ${PLUGIN_VERSION} 的改动

- 当前版本，不应列出。

## 0.0.1 的改动

- 很早的版本。

## 升级

- 不是版本说明。
`;

interface Routes {
  discover?: unknown;
  discoverStatus?: number;
  version?: unknown;
  versionStatus?: number;
  update?: unknown;
  updateStatus?: number;
  /** GitHub 上的文件；为 null 时模拟连不上 GitHub */
  raw?: Record<string, string> | null;
  /** jsDelivr 上的文件；不填或为 null 时模拟连不上 */
  jsdelivr?: Record<string, string> | null;
  /** 本机扩展目录里的 README；不填时读不到 */
  localReadme?: string;
}

const fileName = (url: string) => url.replace(/\?.*$/, '').split('/').pop() ?? '';
/** 模拟一个文件来源:files 为 null 时连不上,没有这个文件时 404。 */
function serve(files: Record<string, string> | null | undefined, url: string): Response {
  if (!files) throw new TypeError('Failed to fetch');
  const body = files[fileName(url)];
  return body === undefined ? new Response('', { status: 404 }) : new Response(body);
}

/** 按地址模拟酒馆的扩展接口、GitHub 与 jsDelivr 上的文件和本机 README,返回 fetch 的 mock 以便检查请求。 */
function stubFetch(routes: Routes) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === '/api/extensions/discover') return json(routes.discover ?? [{ type: 'local', name: 'third-party/ST-Prism-Book' }], routes.discoverStatus ?? 200);
    if (url === '/api/extensions/version') return json(routes.version ?? {}, routes.versionStatus ?? 200);
    if (url === '/api/extensions/update') return json(routes.update ?? {}, routes.updateStatus ?? 200);
    if (url.startsWith('https://raw.githubusercontent.com/')) return serve(routes.raw === undefined ? {} : routes.raw, url);
    if (/^https:\/\/(cdn|fastly)\.jsdelivr\.net\/gh\//.test(url)) return serve(routes.jsdelivr, url);
    if (!url.startsWith('https://') && fileName(url) === 'README.md') return serve(routes.localReadme === undefined ? {} : { 'README.md': routes.localReadme }, url);
    throw new Error('unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const behind = { currentBranchName: 'main', currentCommitHash: 'abc1234', isUpToDate: false, remoteUrl: REPO_URL };
const storage = new Map<string, string>();

/** 每个用例重新载入模块:检查结果、自动弹窗只在一次会话(一次载入)内记忆。 */
async function load() {
  vi.resetModules();
  const context = await import('@/st/context');
  vi.mocked(context.getContext).mockReturnValue({ getRequestHeaders: () => HEADERS } as unknown as import('@/st/context').STContext);
  const toast = vi.mocked((await import('@/st/toast')).toast);
  toast.mockClear();
  return { ...(await import('./update')), toast };
}

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('location', { reload: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('版本号与更新说明', () => {
  it('按数字逐段比较版本号', async () => {
    const { isNewerVersion } = await load();
    expect(isNewerVersion('1.4.10', '1.4.9')).toBe(true);
    expect(isNewerVersion('1.5', '1.4.9')).toBe(true);
    expect(isNewerVersion('1.4.8', '1.4.8')).toBe(false);
    expect(isNewerVersion('1.2.9-prism.18', '1.3.0')).toBe(false);
    expect(isNewerVersion('2.0.0', '10.0.0')).toBe(false);
  });

  it('README 中只取比当前版本新的「X.Y.Z 的改动」，新的在前，去掉 Markdown 标记', async () => {
    const { parseUpdateNotes } = await load();
    const notes = parseUpdateNotes(README, PLUGIN_VERSION);
    expect(notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(notes[0].lines).toEqual([
      { bullet: false, text: '总结字数可以自己设。' },
      { bullet: true, text: '新增 总结字数，见 使用说明书。' },
      { bullet: true, text: '二次总结不超过 二次总结字数。' },
    ]);
    expect(parseUpdateNotes(README, PLUGIN_VERSION, 1).map(n => n.version)).toEqual(['99.0.0']);
    expect(parseUpdateNotes(README, '99.0.0')).toEqual([]);
  });

  it('从安装来源的地址认出 GitHub 仓库', async () => {
    const { githubRepoOf } = await load();
    for (const url of [REPO_URL, 'https://github.com/Zby930806/ST-Prism-Book', 'https://github.com/Zby930806/ST-Prism-Book/', 'git@github.com:Zby930806/ST-Prism-Book.git']) {
      expect(githubRepoOf(url)).toBe('Zby930806/ST-Prism-Book');
    }
    expect(githubRepoOf('https://gitee.com/someone/ST-Prism-Book.git')).toBeNull();
    expect(githubRepoOf('D:/git/ST-Prism-Book')).toBeNull();
  });

  it('从脚本地址取出扩展目录名，取不到时用仓库名', async () => {
    const { extensionFolderName } = await load();
    expect(extensionFolderName('http://127.0.0.1:8000/scripts/extensions/third-party/ST-Prism-Book/dist/index.js?ver=1.4.8')).toBe('ST-Prism-Book');
    expect(extensionFolderName('http://localhost/scripts/extensions/third-party/My%20Book/dist/index.js')).toBe('My Book');
    expect(extensionFolderName('http://localhost/other/index.js')).toBe('ST-Prism-Book');
  });
});

describe('检查更新', () => {
  it('由酒馆对安装目录检查；落后于安装来源时为有新版本，并从 GitHub 读版本号和更新说明', async () => {
    const fetch = stubFetch({ version: behind, raw: { 'manifest.json': JSON.stringify({ version: '99.0.0' }), 'README.md': README } });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0', checking: false });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(updateState.changelogUrl).toBe('https://github.com/Zby930806/ST-Prism-Book/blob/main/CHANGELOG.md');
    const versionCall = fetch.mock.calls.find(([url]) => url === '/api/extensions/version')!;
    expect(versionCall[1]).toMatchObject({ method: 'POST', headers: HEADERS });
    expect(JSON.parse(String(versionCall[1]!.body))).toEqual({ extensionName: 'ST-Prism-Book', global: false });
    expect(fetch.mock.calls.map(([url]) => url.replace(/\?.*$/, ''))).toEqual(expect.arrayContaining([
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/manifest.json',
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/README.md',
    ]));
    // GitHub 读到了就不再走备用线路
    expect(fetch.mock.calls.some(([url]) => url.includes('jsdelivr'))).toBe(false);
    expect(updateState.notesLoading).toBe(false);
  });

  it('GitHub 连不上时改走 jsDelivr 读版本号和更新说明', async () => {
    const fetch = stubFetch({ version: behind, raw: null, jsdelivr: { 'manifest.json': JSON.stringify({ version: '99.0.0' }), 'README.md': README } });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0' });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    const sources = fetch.mock.calls.map(([url]) => url).filter(url => url.endsWith('README.md') || url.includes('README.md?'));
    expect(sources.map(url => url.replace(/\?.*$/, ''))).toEqual([
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/README.md',
      'https://cdn.jsdelivr.net/gh/Zby930806/ST-Prism-Book@main/README.md',
    ]);
  });

  it('jsDelivr 缓存里还是旧版本时，不显示旧的版本号，也不列当前及更早版本的说明', async () => {
    const stale = README.replace(/## 99\.0\.0[\s\S]*?(?=## \d)/, '').replace(/## 98\.1\.0[\s\S]*?(?=## \d)/, '');
    stubFetch({ version: behind, raw: null, jsdelivr: { 'manifest.json': JSON.stringify({ version: PLUGIN_VERSION }), 'README.md': stale } });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '', notes: [] });
  });

  it('装在所有用户共用的目录时按 global 检查', async () => {
    const fetch = stubFetch({ discover: [{ type: 'global', name: 'third-party/ST-Prism-Book' }], version: behind, raw: {} });
    const { checkForUpdate } = await load();
    await checkForUpdate();
    const versionCall = fetch.mock.calls.find(([url]) => url === '/api/extensions/version')!;
    expect(JSON.parse(String(versionCall[1]!.body))).toEqual({ extensionName: 'ST-Prism-Book', global: true });
  });

  it('GitHub 和 jsDelivr 都连不上时仍提示有新版本，只是没有版本号和更新说明', async () => {
    const fetch = stubFetch({ version: behind, raw: null, jsdelivr: null });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '', notes: [], notesLoading: false });
    expect(updateState.changelogUrl).toContain('github.com/Zby930806/ST-Prism-Book');
    expect(fetch.mock.calls.filter(([url]) => url.includes('README.md')).map(([url]) => new URL(url).host)).toEqual([
      'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'fastly.jsdelivr.net',
    ]);
  });

  it.each([
    ['已是最新', { version: { ...behind, isUpToDate: true } }, 'up-to-date', ''],
    ['手动复制安装（不是 git 仓库）', { version: { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' } }, 'unsupported', 'manual'],
    ['安装来源是原版柏宝书', { version: { ...behind, remoteUrl: 'https://github.com/baibai-git/ST-BaiBai-Book' } }, 'unsupported', 'upstream'],
    ['酒馆的扩展列表里找不到', { discover: [{ type: 'local', name: 'third-party/Other' }] }, 'unsupported', 'missing'],
  ] as const)('%s：不提示更新，并记下原因', async (_name, routes, expected, reason) => {
    const fetch = stubFetch({ ...routes, raw: {} });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe(expected);
    expect(updateState.available).toBe(false);
    expect(updateState.unsupportedReason).toBe(reason);
    expect(fetch.mock.calls.some(([url]) => url.startsWith('https://'))).toBe(false);
  });

  it('查询失败时保留上次结论，不打扰用户', async () => {
    stubFetch({ version: behind, raw: {} });
    const { checkForUpdate, updateState } = await load();
    await checkForUpdate();
    stubFetch({ versionStatus: 500 });
    expect(await checkForUpdate(true)).toBe('failed');
    expect(updateState.available).toBe(true);
  });

  it('一次会话只查一次；手动检查时重新查，同时发起的检查共用一次请求', async () => {
    const fetch = stubFetch({ version: { ...behind, isUpToDate: true } });
    const { checkForUpdate } = await load();
    const count = () => fetch.mock.calls.filter(([url]) => url === '/api/extensions/version').length;
    await Promise.all([checkForUpdate(), checkForUpdate(true)]);
    expect(count()).toBe(1);
    await checkForUpdate();
    expect(count()).toBe(1);
    await checkForUpdate(true);
    expect(count()).toBe(2);
  });

  it('查过「已是最新」后 3 小时内刷新页面不再让酒馆去查；过了 3 小时、换了版本或手动检查时照常查', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch({ version: { ...behind, isUpToDate: true } });
    const count = () => fetch.mock.calls.filter(([url]) => url === '/api/extensions/version').length;
    expect(await (await load()).checkForUpdate()).toBe('up-to-date');
    expect(count()).toBe(1);
    // 刷新页面(重新载入插件):沿用上次的结论
    const second = await load();
    expect(await second.checkForUpdate()).toBe('up-to-date');
    expect(count()).toBe(1);
    expect(second.updateState.available).toBe(false);
    // 手动检查不受限
    expect(await second.checkForUpdate(true)).toBe('up-to-date');
    expect(count()).toBe(2);
    const { UPDATE_CHECK_INTERVAL_MS } = second;
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    await (await load()).checkForUpdate();
    expect(count()).toBe(3);
    // 换了版本(例如在「管理扩展」里更新过):记录作废
    storage.set('bbs.update.lastCheck', JSON.stringify({ at: Date.now(), result: 'up-to-date', reason: '', version: '0.0.1' }));
    await (await load()).checkForUpdate();
    expect(count()).toBe(4);
  });

  it('查到有新版本或没查成时不记，下次刷新还要查', async () => {
    let fetch = stubFetch({ version: behind, raw: {} });
    expect(await (await load()).checkForUpdate()).toBe('available');
    expect(storage.has('bbs.update.lastCheck')).toBe(false);
    expect(await (await load()).checkForUpdate()).toBe('available');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/extensions/version')).toHaveLength(2);
    fetch = stubFetch({ versionStatus: 500 });
    expect(await (await load()).checkForUpdate()).toBe('failed');
    expect(storage.has('bbs.update.lastCheck')).toBe(false);
  });

  it('不能更新时连同原因一起沿用', async () => {
    stubFetch({ version: { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' } });
    await (await load()).checkForUpdate();
    const fetch = stubFetch({});
    const again = await load();
    expect(await again.checkForUpdate()).toBe('unsupported');
    expect(again.updateState.unsupportedReason).toBe('manual');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('安装更新', () => {
  it('调用酒馆的扩展更新接口，成功后记下旧版本并自动刷新', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch({ update: { isUpToDate: false, shortCommitHash: 'def5678' } });
    const { performUpdate, updateState, RELOAD_DELAY_MS } = await load();
    updateState.available = true;
    expect(await performUpdate()).toBe('updated');
    const updateCall = fetch.mock.calls.find(([url]) => url === '/api/extensions/update')!;
    expect(updateCall[1]).toMatchObject({ method: 'POST', headers: HEADERS });
    expect(JSON.parse(String(updateCall[1]!.body))).toEqual({ extensionName: 'ST-Prism-Book', global: false });
    expect(storage.get('bbs.update.from')).toBe(PLUGIN_VERSION);
    expect(updateState).toMatchObject({ available: false, updating: true, error: '' });
    expect(location.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('已是最新时不刷新', async () => {
    vi.useFakeTimers();
    stubFetch({ update: { isUpToDate: true } });
    const { performUpdate, updateState } = await load();
    expect(await performUpdate()).toBe('up-to-date');
    vi.runAllTimers();
    expect(location.reload).not.toHaveBeenCalled();
    expect(updateState.updating).toBe(false);
    expect(storage.has('bbs.update.from')).toBe(false);
  });

  it.each([
    [403, '只有管理员账号能更新'],
    [500, '可能是服务器连不上 GitHub，或扩展目录里的文件被改动过'],
  ])('更新接口返回 %i 时说明原因，不刷新', async (status, reason) => {
    stubFetch({ updateStatus: status });
    const { performUpdate, updateState } = await load();
    await expect(performUpdate()).rejects.toThrow(reason);
    expect(updateState.error).toContain(reason);
    expect(updateState.updating).toBe(false);
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('取不到酒馆的扩展列表（服务器连不上或登录过期）时如实说明，不说成找不到安装目录', async () => {
    const fetch = stubFetch({ discoverStatus: 403 });
    const { performUpdate, updateState } = await load();
    await expect(performUpdate()).rejects.toThrow('没能向酒馆确认安装位置');
    expect(updateState.error).not.toContain('没有找到本扩展的安装目录');
    expect(fetch.mock.calls.some(([url]) => url === '/api/extensions/update')).toBe(false);
  });

  it('刷新后从本机 README 列出这次更新的内容（比旧版本新的各节），不依赖外网', async () => {
    storage.set('bbs.update.from', '98.0.0');
    const fetch = stubFetch({ raw: null, jsdelivr: null, localReadme: README });
    const { announceUpdated, toast, updateState } = await load();
    await announceUpdated();
    expect(updateState).toMatchObject({ updatedDialogOpen: true, updatedFrom: '98.0.0' });
    expect(updateState.updatedNotes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(toast).not.toHaveBeenCalled();
    expect(storage.has('bbs.update.from')).toBe(false);
    // 读的是扩展目录里的 README，按版本号取，不加时间戳
    const [url] = fetch.mock.calls.map(([u]) => u);
    expect(url).toMatch(new RegExp(`/README\\.md\\?ver=${PLUGIN_VERSION.replaceAll('.', '\\.')}$`));
    expect(url.startsWith('https://')).toBe(false);
  });

  it.each([
    ['README 里没有比旧版本新的内容', '99.0.0', README, `棱镜宝书已更新到 v${PLUGIN_VERSION}。`],
    ['读不到本机 README', '0.0.1', undefined, `棱镜宝书已更新到 v${PLUGIN_VERSION}。`],
    ['版本号没变（只更新了文档等）', PLUGIN_VERSION, README, '棱镜宝书已更新。'],
  ] as const)('刷新后：%s时只提示一句', async (_name, from, localReadme, message) => {
    storage.set('bbs.update.from', from);
    stubFetch({ localReadme });
    const { announceUpdated, toast, updateState } = await load();
    await announceUpdated();
    expect(toast).toHaveBeenCalledWith(message, 'success');
    expect(updateState.updatedDialogOpen).toBe(false);
  });

  it('没有在宝书里更新过时，刷新后什么也不提示', async () => {
    const fetch = stubFetch({ localReadme: README });
    const { announceUpdated, toast, updateState } = await load();
    await announceUpdated();
    expect(toast).not.toHaveBeenCalled();
    expect(updateState.updatedDialogOpen).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('更新窗口', () => {
  it('有新版本时打开宝书自动弹出一次；关掉后这次不再自动弹，手动打开照常', async () => {
    const { closeUpdateDialog, openUpdateDialog, showUpdateDialogOnce, updateState } = await load();
    showUpdateDialogOnce();
    expect(updateState.dialogOpen).toBe(false);
    updateState.available = true;
    showUpdateDialogOnce();
    expect(updateState.dialogOpen).toBe(true);
    closeUpdateDialog();
    showUpdateDialogOnce();
    expect(updateState.dialogOpen).toBe(false);
    openUpdateDialog();
    expect(updateState.dialogOpen).toBe(true);
  });

  it('更新进行中不能关闭窗口', async () => {
    const { closeUpdateDialog, openUpdateDialog, updateState } = await load();
    openUpdateDialog();
    updateState.updating = true;
    closeUpdateDialog();
    expect(updateState.dialogOpen).toBe(true);
  });

  it('「更新完成」窗口可以关闭', async () => {
    const { closeUpdatedDialog, updateState } = await load();
    updateState.updatedDialogOpen = true;
    closeUpdatedDialog();
    expect(updateState.updatedDialogOpen).toBe(false);
  });
});
