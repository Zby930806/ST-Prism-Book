import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_VERSION } from '@/version';

vi.mock('@/st/context', () => ({ getContext: vi.fn() }));
vi.mock('@/st/toast', () => ({ toast: vi.fn() }));

const HEADERS = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' };
const REPO_URL = 'https://github.com/Zby930806/ST-Prism-Book.git';
const GITEE_URL = 'https://gitee.com/ljbs1106/ST-Prism-Book';
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
const NEW_RELEASE = { 'manifest.json': JSON.stringify({ version: '99.0.0' }), 'README.md': README };
/** 酒馆的 git fetch 连不上 GitHub 时返回的报错 */
const FETCH_ERROR = `Server Error: fatal: unable to access '${REPO_URL}/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server`;

interface Routes {
  discover?: unknown;
  discoverStatus?: number;
  version?: unknown;
  versionStatus?: number;
  /** 检查接口返回的文字(酒馆的报错);填了时按 versionStatus(默认 500)返回这段文字 */
  versionText?: string;
  /** 检查接口请求失败(超时或连不上)时抛出的错误 */
  versionThrows?: Error;
  update?: unknown;
  updateStatus?: number;
  deleteStatus?: number;
  installStatus?: number;
  /** GitHub 上的文件；为 null 时模拟连不上 GitHub */
  raw?: Record<string, string> | null;
  /** 码云接口能读到的文件；不填或为 null 时模拟连不上 */
  gitee?: Record<string, string> | null;
  /** jsDelivr 上的文件；不填或为 null 时模拟连不上 */
  jsdelivr?: Record<string, string> | null;
  /** 本机扩展目录里的 README；不填时读不到 */
  localReadme?: string;
}

const fileName = (url: string) => url.replace(/\?.*$/, '').split('/').pop() ?? '';
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
/** 模拟一个文件来源:files 为 null 时连不上,没有这个文件时 404。 */
function serve(files: Record<string, string> | null | undefined, url: string): Response {
  if (!files) throw new TypeError('Failed to fetch');
  const body = files[fileName(url)];
  return body === undefined ? new Response('', { status: 404 }) : new Response(body);
}
/** 码云接口:文件内容按 base64 放在 JSON 里。 */
function serveGitee(files: Record<string, string> | null | undefined, url: string): Response {
  if (!files) throw new TypeError('Failed to fetch');
  const body = files[fileName(url)];
  if (body === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify({ type: 'file', encoding: 'base64', name: fileName(url), content: base64(body) }));
}

/** 按地址模拟酒馆的扩展接口、GitHub、码云与 jsDelivr 上的文件和本机 README,返回 fetch 的 mock 以便检查请求。 */
function stubFetch(routes: Routes) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === '/api/extensions/discover') return json(routes.discover ?? [{ type: 'local', name: 'third-party/ST-Prism-Book' }], routes.discoverStatus ?? 200);
    if (url === '/api/extensions/version') {
      if (routes.versionThrows) throw routes.versionThrows;
      if (routes.versionText !== undefined) return new Response(routes.versionText, { status: routes.versionStatus ?? 500 });
      return json(routes.version ?? {}, routes.versionStatus ?? 200);
    }
    if (url === '/api/extensions/update') return json(routes.update ?? {}, routes.updateStatus ?? 200);
    if (url === '/api/extensions/delete') return new Response('deleted', { status: routes.deleteStatus ?? 200 });
    if (url === '/api/extensions/install') return json({ version: '99.0.0' }, routes.installStatus ?? 200);
    if (url.startsWith('https://raw.githubusercontent.com/')) return serve(routes.raw === undefined ? {} : routes.raw, url);
    if (url.startsWith('https://gitee.com/api/v5/repos/')) return serveGitee(routes.gitee, url);
    if (/^https:\/\/(cdn|fastly)\.jsdelivr\.net\/gh\//.test(url)) return serve(routes.jsdelivr, url);
    if (!url.startsWith('https://') && fileName(url) === 'README.md') return serve(routes.localReadme === undefined ? {} : { 'README.md': routes.localReadme }, url);
    throw new Error('unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** 请求过的地址(去掉查询参数) */
const urls = (fetch: ReturnType<typeof stubFetch>) => fetch.mock.calls.map(([url]) => url.replace(/\?.*$/, ''));
const external = (fetch: ReturnType<typeof stubFetch>) => urls(fetch).filter(url => url.startsWith('https://'));
const bodyOf = (fetch: ReturnType<typeof stubFetch>, url: string) => JSON.parse(String(fetch.mock.calls.find(([u]) => u === url)![1]!.body));

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

  it('从安装来源的地址认出 GitHub 和码云上的仓库，以及是不是本扩展的线路', async () => {
    const { lineOf, repoOf } = await load();
    for (const url of [REPO_URL, 'https://github.com/Zby930806/ST-Prism-Book', 'https://github.com/Zby930806/ST-Prism-Book/', 'git@github.com:Zby930806/ST-Prism-Book.git']) {
      expect(repoOf(url)).toEqual({ host: 'github', repo: 'Zby930806/ST-Prism-Book' });
    }
    for (const url of [GITEE_URL, GITEE_URL + '.git', 'git@gitee.com:ljbs1106/ST-Prism-Book.git']) {
      expect(repoOf(url)).toEqual({ host: 'gitee', repo: 'ljbs1106/ST-Prism-Book' });
    }
    expect(repoOf('D:/git/ST-Prism-Book')).toBeNull();
    expect(repoOf('https://notgithub.com/a/b')).toBeNull();
    expect(lineOf(repoOf(REPO_URL))).toBe('github');
    expect(lineOf(repoOf('https://github.com/zby930806/st-prism-book'))).toBe('github');
    expect(lineOf(repoOf(GITEE_URL))).toBe('gitee');
    expect(lineOf(repoOf('https://github.com/someone/ST-Prism-Book'))).toBe('');
    expect(lineOf(repoOf('https://gitee.com/someone/ST-Prism-Book'))).toBe('');
    expect(lineOf(null)).toBe('');
  });

  it('从酒馆的报错（git 的输出）里认出安装来源', async () => {
    const { repoInError } = await load();
    expect(repoInError(FETCH_ERROR)).toEqual({ host: 'github', repo: 'Zby930806/ST-Prism-Book' });
    expect(repoInError(`fatal: repository ${GITEE_URL}.git/: not found`)).toEqual({ host: 'gitee', repo: 'ljbs1106/ST-Prism-Book' });
    expect(repoInError('Server Error: block timeout reached')).toBeNull();
    expect(repoInError('see https://git-scm.com/docs and https://github.com/someone/Fork.git')).toEqual({ host: 'github', repo: 'someone/Fork' });
  });

  it('码云接口返回的 base64 文件解码成文本（含中文）', async () => {
    const { decodeGiteeFile } = await load();
    expect(decodeGiteeFile(JSON.stringify({ encoding: 'base64', content: base64(README) }))).toBe(README);
    expect(decodeGiteeFile('{"message":"Not Found"}')).toBe('');
    expect(decodeGiteeFile('不是 JSON')).toBe('');
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
    const fetch = stubFetch({ version: behind, raw: NEW_RELEASE });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0', checking: false, line: 'github', sourceUnreachable: false });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(updateState.changelogUrl).toBe('https://github.com/Zby930806/ST-Prism-Book/blob/main/CHANGELOG.md');
    const versionCall = fetch.mock.calls.find(([url]) => url === '/api/extensions/version')!;
    expect(versionCall[1]).toMatchObject({ method: 'POST', headers: HEADERS });
    expect(bodyOf(fetch, '/api/extensions/version')).toEqual({ extensionName: 'ST-Prism-Book', global: false });
    // GitHub 读到了就不再走备用线路
    expect(external(fetch).sort()).toEqual([
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/README.md',
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/manifest.json',
    ]);
    expect(updateState.notesLoading).toBe(false);
  });

  it('GitHub 连不上时先读码云，读到了就不再走 jsDelivr', async () => {
    const fetch = stubFetch({ version: behind, raw: null, gitee: NEW_RELEASE });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0' });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(external(fetch).filter(url => url.endsWith('README.md'))).toEqual([
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/README.md',
      'https://gitee.com/api/v5/repos/ljbs1106/ST-Prism-Book/contents/README.md',
    ]);
    expect(fetch.mock.calls.find(([url]) => url.includes('gitee.com') && url.includes('README.md'))![0]).toContain('?ref=main&t=');
  });

  it('GitHub 和码云都连不上时改走 jsDelivr 读版本号和更新说明', async () => {
    const fetch = stubFetch({ version: behind, raw: null, gitee: null, jsdelivr: NEW_RELEASE });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0' });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(external(fetch).filter(url => url.endsWith('README.md'))).toEqual([
      'https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/README.md',
      'https://gitee.com/api/v5/repos/ljbs1106/ST-Prism-Book/contents/README.md',
      'https://cdn.jsdelivr.net/gh/Zby930806/ST-Prism-Book@main/README.md',
    ]);
  });

  it('安装来源是码云镜像时，先从码云读版本号和更新说明，更新记录也链到码云', async () => {
    const fetch = stubFetch({ version: { ...behind, remoteUrl: GITEE_URL }, raw: null, gitee: NEW_RELEASE });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0', line: 'gitee', sourceUnreachable: false });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(updateState.changelogUrl).toBe('https://gitee.com/ljbs1106/ST-Prism-Book/blob/main/CHANGELOG.md');
    expect(external(fetch).every(url => url.startsWith('https://gitee.com/api/v5/repos/ljbs1106/ST-Prism-Book/contents/'))).toBe(true);
  });

  it('安装来源是别人的仓库时只读那个仓库，不读本扩展的码云镜像', async () => {
    const fetch = stubFetch({ version: { ...behind, remoteUrl: 'https://github.com/someone/ST-Prism-Book' }, raw: null, jsdelivr: null });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState.line).toBe('');
    expect(external(fetch).filter(url => url.endsWith('README.md'))).toEqual([
      'https://raw.githubusercontent.com/someone/ST-Prism-Book/main/README.md',
      'https://cdn.jsdelivr.net/gh/someone/ST-Prism-Book@main/README.md',
      'https://fastly.jsdelivr.net/gh/someone/ST-Prism-Book@main/README.md',
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
    expect(bodyOf(fetch, '/api/extensions/version')).toEqual({ extensionName: 'ST-Prism-Book', global: true });
  });

  it('各条线路都连不上时仍提示有新版本，只是没有版本号和更新说明', async () => {
    const fetch = stubFetch({ version: behind, raw: null, gitee: null, jsdelivr: null });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '', notes: [], notesLoading: false });
    expect(updateState.changelogUrl).toContain('github.com/Zby930806/ST-Prism-Book');
    expect(fetch.mock.calls.filter(([url]) => url.includes('README.md')).map(([url]) => new URL(url).host)).toEqual([
      'raw.githubusercontent.com', 'gitee.com', 'cdn.jsdelivr.net', 'fastly.jsdelivr.net',
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
    expect(external(fetch)).toEqual([]);
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
    // 刷新页面(重新载入插件):沿用上次的结论和线路
    const second = await load();
    expect(await second.checkForUpdate()).toBe('up-to-date');
    expect(count()).toBe(1);
    expect(second.updateState).toMatchObject({ available: false, line: 'github', sourceUnreachable: false });
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

describe('酒馆连不上安装来源时从另一条线路查', () => {
  it('git fetch 连不上 GitHub：浏览器先从码云读版本号，有新版本时提示改从码云安装', async () => {
    const fetch = stubFetch({ versionText: FETCH_ERROR, raw: null, gitee: NEW_RELEASE });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ available: true, latest: '99.0.0', line: 'github', sourceUnreachable: true, unsupportedReason: '' });
    expect(updateState.notes.map(n => n.version)).toEqual(['99.0.0', '98.1.0']);
    expect(updateState.changelogUrl).toBe('https://gitee.com/ljbs1106/ST-Prism-Book/blob/main/CHANGELOG.md');
    // 码云排在最前,读到了就不再试 GitHub
    expect(external(fetch).every(url => url.startsWith('https://gitee.com/'))).toBe(true);
    expect(storage.has('bbs.update.lastCheck')).toBe(false);
  });

  it('码云上不比当前新时为已是最新，连同「酒馆连不上」一起记下，3 小时内刷新页面沿用', async () => {
    stubFetch({ versionText: FETCH_ERROR, gitee: { 'manifest.json': JSON.stringify({ version: PLUGIN_VERSION }), 'README.md': README } });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('up-to-date');
    expect(updateState).toMatchObject({ available: false, line: 'github', sourceUnreachable: true });
    const fetch = stubFetch({});
    const again = await load();
    expect(await again.checkForUpdate()).toBe('up-to-date');
    expect(again.updateState).toMatchObject({ line: 'github', sourceUnreachable: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('请求超时或连不上时同样改从码云查；报错里认不出安装来源时按 GitHub 算，线路记为认不出', async () => {
    for (const routes of [{ versionThrows: new DOMException('aborted', 'AbortError') }, { versionText: 'Server Error: block timeout reached' }, { versionText: 'Bad Gateway', versionStatus: 502 }]) {
      const fetch = stubFetch({ ...routes, gitee: NEW_RELEASE });
      const { checkForUpdate, updateState } = await load();
      expect(await checkForUpdate()).toBe('available');
      expect(updateState).toMatchObject({ line: '', sourceUnreachable: true, latest: '99.0.0' });
      expect(external(fetch)[0]).toMatch(/^https:\/\/gitee\.com\//);
    }
  });

  it('安装来源是码云而酒馆连不上码云时，改从 GitHub 查', async () => {
    const fetch = stubFetch({ versionText: `fatal: unable to access '${GITEE_URL}.git/': Could not resolve host: gitee.com`, raw: NEW_RELEASE });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('available');
    expect(updateState).toMatchObject({ line: 'gitee', sourceUnreachable: true });
    expect(external(fetch)[0]).toMatch(/^https:\/\/raw\.githubusercontent\.com\/Zby930806\/ST-Prism-Book\//);
    expect(updateState.changelogUrl).toBe('https://github.com/Zby930806/ST-Prism-Book/blob/main/CHANGELOG.md');
  });

  it('另一条线路也读不到版本号时算没查成', async () => {
    stubFetch({ versionText: FETCH_ERROR, raw: null, gitee: null, jsdelivr: null });
    const { checkForUpdate, updateState } = await load();
    expect(await checkForUpdate()).toBe('failed');
    expect(updateState).toMatchObject({ available: false, sourceUnreachable: false });
  });

  it.each([
    ['安装来源是别人的仓库', { versionText: "fatal: unable to access 'https://github.com/someone/Fork.git/': Couldn't connect to server" }],
    ['安装来源是原版柏宝书', { versionText: "fatal: unable to access 'https://github.com/baibai-git/ST-BaiBai-Book.git/': Couldn't connect to server" }],
    ['酒馆拒绝请求（登录过期等）', { versionStatus: 403 }],
  ] as const)('%s时不替它查，算没查成', async (_name, routes) => {
    const fetch = stubFetch({ ...routes, gitee: NEW_RELEASE, raw: NEW_RELEASE });
    const { checkForUpdate } = await load();
    expect(await checkForUpdate()).toBe('failed');
    expect(external(fetch)).toEqual([]);
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
    expect(bodyOf(fetch, '/api/extensions/update')).toEqual({ extensionName: 'ST-Prism-Book', global: false });
    expect(storage.get('bbs.update.from')).toBe(PLUGIN_VERSION);
    expect(storage.has('bbs.update.switchedTo')).toBe(false);
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
    [500, '可能是服务器连不上安装来源，或扩展目录里的文件被改动过'],
  ])('更新接口返回 %i 时说明原因，不刷新', async (status, reason) => {
    stubFetch({ updateStatus: status });
    const { performUpdate, updateState } = await load();
    await expect(performUpdate()).rejects.toThrow(reason);
    expect(updateState.error).toContain(reason);
    expect(updateState).toMatchObject({ updating: false, offerSwitch: false });
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('从 GitHub 安装的拉取失败时，提示可以改从码云安装', async () => {
    stubFetch({ version: behind, raw: {}, updateStatus: 500 });
    const { checkForUpdate, performUpdate, updateState } = await load();
    await checkForUpdate();
    await expect(performUpdate()).rejects.toThrow('可能是服务器连不上 GitHub');
    expect(updateState.error).toContain('「改从码云安装」');
    expect(updateState.offerSwitch).toBe(true);
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

describe('改用另一条线路', () => {
  const SAME_VERSION = { 'manifest.json': JSON.stringify({ version: PLUGIN_VERSION }) };

  it('先确认浏览器读得到码云，再请酒馆删除安装目录、从码云重新安装，成功后自动刷新', async () => {
    vi.useFakeTimers();
    storage.set('bbs.update.lastCheck', JSON.stringify({ at: Date.now(), result: 'up-to-date', reason: '', line: 'github', unreachable: true, version: PLUGIN_VERSION }));
    const fetch = stubFetch({ gitee: NEW_RELEASE });
    const { switchLine, updateState, RELOAD_DELAY_MS } = await load();
    await switchLine('gitee');
    const order = urls(fetch).filter(url => !url.endsWith('/discover'));
    expect(order).toEqual([
      'https://gitee.com/api/v5/repos/ljbs1106/ST-Prism-Book/contents/manifest.json',
      '/api/extensions/delete',
      '/api/extensions/install',
    ]);
    expect(bodyOf(fetch, '/api/extensions/delete')).toEqual({ extensionName: 'ST-Prism-Book', global: false });
    expect(bodyOf(fetch, '/api/extensions/install')).toEqual({ url: GITEE_URL, global: false });
    expect(storage.get('bbs.update.from')).toBe(PLUGIN_VERSION);
    expect(storage.get('bbs.update.switchedTo')).toBe('gitee');
    // 上次检查记下的线路作废
    expect(storage.has('bbs.update.lastCheck')).toBe(false);
    expect(updateState).toMatchObject({ updating: true, error: '', reinstallPending: false, switchTarget: 'gitee' });
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('改用 GitHub 时读 GitHub 上的文件确认；装在共用目录时按 global 删除和安装', async () => {
    vi.useFakeTimers();
    const fetch = stubFetch({ discover: [{ type: 'global', name: 'third-party/ST-Prism-Book' }], raw: SAME_VERSION });
    const { switchLine } = await load();
    await switchLine('github');
    expect(external(fetch)).toEqual(['https://raw.githubusercontent.com/Zby930806/ST-Prism-Book/main/manifest.json']);
    expect(bodyOf(fetch, '/api/extensions/delete')).toEqual({ extensionName: 'ST-Prism-Book', global: true });
    expect(bodyOf(fetch, '/api/extensions/install')).toEqual({ url: 'https://github.com/Zby930806/ST-Prism-Book', global: true });
  });

  it.each([
    ['浏览器读不到码云', { gitee: null }, '连不上码云'],
    ['码云上的版本比当前旧', { gitee: { 'manifest.json': JSON.stringify({ version: '0.0.1' }) } }, '码云上还是旧版本 v0.0.1'],
    ['只有管理员能改共用目录', { gitee: SAME_VERSION, deleteStatus: 403 }, '只有管理员账号能改用线路'],
    ['酒馆没能删除安装目录', { gitee: SAME_VERSION, deleteStatus: 500 }, '酒馆没能删除现有的安装目录（HTTP 500）'],
  ] as const)('%s时不改动现有的安装，说明原因', async (_name, routes, reason) => {
    const fetch = stubFetch(routes);
    const { switchLine, updateState } = await load();
    await expect(switchLine('gitee')).rejects.toThrow(reason);
    expect(updateState).toMatchObject({ updating: false, reinstallPending: false });
    expect(updateState.error).toContain(reason);
    expect(urls(fetch)).not.toContain('/api/extensions/install');
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('删除后没装上时记下，窗口不能关；再试时不再删除，可以换一条线路装', async () => {
    vi.useFakeTimers();
    let fetch = stubFetch({ gitee: SAME_VERSION, installStatus: 500 });
    const { closeSwitchDialog, openSwitchDialog, switchLine, updateState, RELOAD_DELAY_MS } = await load();
    openSwitchDialog('gitee');
    await expect(switchLine('gitee')).rejects.toThrow('旧版本已删除，但酒馆没能从码云下载新版本');
    expect(updateState.error).toContain(GITEE_URL);
    expect(updateState).toMatchObject({ reinstallPending: true, updating: false, switchDialogOpen: true });
    closeSwitchDialog();
    expect(updateState.switchDialogOpen).toBe(true);
    fetch = stubFetch({});
    await switchLine('github');
    expect(urls(fetch).filter(url => !url.endsWith('/discover'))).toEqual(['/api/extensions/install']);
    expect(bodyOf(fetch, '/api/extensions/install')).toEqual({ url: 'https://github.com/Zby930806/ST-Prism-Book', global: false });
    expect(updateState).toMatchObject({ reinstallPending: false, error: '' });
    expect(storage.get('bbs.update.switchedTo')).toBe('github');
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('刷新后提示已改用的线路；版本变了再列出更新内容，版本没变不再说「已更新」', async () => {
    storage.set('bbs.update.from', '98.0.0');
    storage.set('bbs.update.switchedTo', 'gitee');
    stubFetch({ localReadme: README });
    let loaded = await load();
    await loaded.announceUpdated();
    expect(loaded.toast).toHaveBeenCalledWith('已改用码云线路，之后从码云检查和安装更新。', 'success');
    expect(loaded.updateState.updatedDialogOpen).toBe(true);
    expect(storage.has('bbs.update.switchedTo')).toBe(false);
    storage.set('bbs.update.from', PLUGIN_VERSION);
    storage.set('bbs.update.switchedTo', 'github');
    loaded = await load();
    await loaded.announceUpdated();
    expect(loaded.toast.mock.calls).toEqual([['已改用 GitHub 线路，之后从 GitHub 检查和安装更新。', 'success']]);
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

  it('「改用线路」窗口：默认改用当前线路以外的那条，打开时关掉更新窗口', async () => {
    const { closeSwitchDialog, openSwitchDialog, openUpdateDialog, updateState } = await load();
    openUpdateDialog();
    openSwitchDialog();
    expect(updateState).toMatchObject({ dialogOpen: false, switchDialogOpen: true, switchTarget: 'gitee' });
    closeSwitchDialog();
    expect(updateState.switchDialogOpen).toBe(false);
    updateState.line = 'gitee';
    openSwitchDialog();
    expect(updateState.switchTarget).toBe('github');
    updateState.updating = true;
    closeSwitchDialog();
    expect(updateState.switchDialogOpen).toBe(true);
  });

  it('「更新完成」窗口可以关闭', async () => {
    const { closeUpdatedDialog, updateState } = await load();
    updateState.updatedDialogOpen = true;
    closeUpdatedDialog();
    expect(updateState.updatedDialogOpen).toBe(false);
  });
});
