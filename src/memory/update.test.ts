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
  version?: unknown;
  versionStatus?: number;
  update?: unknown;
  updateStatus?: number;
  /** GitHub 上的文件；为 null 时模拟连不上 GitHub */
  raw?: Record<string, string> | null;
}

/** 按地址模拟酒馆的扩展接口与 GitHub 上的文件,返回 fetch 的 mock 以便检查请求。 */
function stubFetch(routes: Routes) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === '/api/extensions/discover') return json(routes.discover ?? [{ type: 'local', name: 'third-party/ST-Prism-Book' }]);
    if (url === '/api/extensions/version') return json(routes.version ?? {}, routes.versionStatus ?? 200);
    if (url === '/api/extensions/update') return json(routes.update ?? {}, routes.updateStatus ?? 200);
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      if (routes.raw === null) throw new TypeError('Failed to fetch');
      const file = url.replace(/\?.*$/, '').split('/').pop() ?? '';
      const body = routes.raw?.[file];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }
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
  });

  it('装在所有用户共用的目录时按 global 检查', async () => {
    const fetch = stubFetch({ discover: [{ type: 'global', name: 'third-party/ST-Prism-Book' }], version: behind, raw: {} });
    const { checkForUpdate } = await load();
    await checkForUpdate();
    const versionCall = fetch.mock.calls.find(([url]) => url === '/api/extensions/version')!;
    expect(JSON.parse(String(versionCall[1]!.body))).toEqual({ extensionName: 'ST-Prism-Book', global: true });
  });

  it('浏览器连不上 GitHub 时仍提示有新版本，只是没有版本号和更新说明', async () => {
    stubFetch({ version: behind, raw: null });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '', notes: [] });
    expect(updateState.changelogUrl).toContain('github.com/Zby930806/ST-Prism-Book');
  });

  it.each([
    ['已是最新', { version: { ...behind, isUpToDate: true } }, 'up-to-date'],
    ['手动复制安装（不是 git 仓库）', { version: { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' } }, 'unsupported'],
    ['安装来源是原版柏宝书', { version: { ...behind, remoteUrl: 'https://github.com/baibai-git/ST-BaiBai-Book' } }, 'unsupported'],
    ['酒馆的扩展列表里找不到', { discover: [{ type: 'local', name: 'third-party/Other' }] }, 'unsupported'],
  ] as const)('%s：不提示更新', async (_name, routes, expected) => {
    const fetch = stubFetch({ ...routes, raw: {} });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe(expected);
    expect(updateState.available).toBe(false);
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

  it('刷新后提示一次更新结果', async () => {
    storage.set('bbs.update.from', '0.0.1');
    const first = await load();
    first.announceUpdated();
    expect(first.toast).toHaveBeenCalledWith(`棱镜宝书已更新到 v${PLUGIN_VERSION}。`, 'success');
    expect(storage.has('bbs.update.from')).toBe(false);
    const second = await load();
    second.announceUpdated();
    expect(second.toast).not.toHaveBeenCalled();
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
});
