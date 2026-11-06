/**
 * 检查与安装更新(做法同酒馆助手):
 * - 检查:请酒馆服务器对本扩展的安装目录执行 git fetch(/api/extensions/version),落后于安装来源时为「有新版本」。
 *   与酒馆「管理扩展」走同一条路,浏览器连不上 GitHub 也能查;新版本号和更新说明另由浏览器读取
 *   (GitHub 原始文件、码云接口、jsDelivr 依次尝试),都读不到只提示有新版本。
 * - 酒馆查不成(git fetch 失败或超时,国内连 GitHub 常见)时,改由浏览器读另一条线路上的版本号;
 *   有新版本时提示改从那条线路重新安装。
 * - 提示:设置导航亮角标、设置页显示「更新」;打开宝书时弹出更新窗口,每次打开酒馆最多自动弹一次。
 * - 安装:确认后调用酒馆的扩展更新接口(/api/extensions/update,即 git pull),成功后自动刷新酒馆;
 *   刷新后从本机新装好的 README 读出这次的更新内容弹出来,不依赖外网。
 * - 线路:本扩展在 GitHub 和码云(国内镜像)各有一份,内容相同。改用另一条线路时,先请酒馆删除安装目录,
 *   再从另一条线路的地址重新安装(/api/extensions/install,即 git clone),之后检查和更新都走那条线路。
 * 安装来源是原版柏宝书仓库时不提示、不更新,以免把本扩展换成原版;不是用仓库地址安装的(手动复制)无法在插件内更新。
 */
import { reactive } from 'vue';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { PLUGIN_VERSION, versionedAssetUrl } from '@/version';

export const INTERNAL_UPDATE_NOTICE = '有新版本时，设置页显示「更新」，打开宝书会弹出更新窗口，更新完成后自动刷新酒馆；也可以在酒馆的「管理扩展」里更新。只从本扩展的安装来源（GitHub 或国内的码云镜像）更新，不会装上原版柏宝书的更新。';

/** 更新线路:本扩展的 GitHub 仓库和码云镜像,内容相同,每次发布同时推送。 */
export type UpdateLine = 'github' | 'gitee';
const OFFICIAL_REPOS: Record<UpdateLine, string> = { github: 'Zby930806/ST-Prism-Book', gitee: 'ljbs1106/ST-Prism-Book' };
export const LINE_LABEL: Record<UpdateLine, string> = { github: 'GitHub', gitee: '码云' };
/** 各线路的安装地址,即酒馆「安装扩展」里填的地址。 */
export const LINE_URL: Record<UpdateLine, string> = {
  github: `https://github.com/${OFFICIAL_REPOS.github}`,
  gitee: `https://gitee.com/${OFFICIAL_REPOS.gitee}`,
};

export function otherLine(line: UpdateLine): UpdateLine {
  return line === 'github' ? 'gitee' : 'github';
}

/** 中文与英文、数字相邻处加空格(插件里的文字都这样写):线路名有中文也有英文,拼进句子后统一处理。 */
export function spaced(text: string): string {
  return text.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');
}

/** 更新说明里的一个版本:README 中「## X.Y.Z 的改动」一节,按段落和列表项分行。 */
export interface UpdateNote {
  version: string;
  lines: Array<{ bullet: boolean; text: string }>;
}

export const updateState = reactive({
  current: PLUGIN_VERSION,
  /** 新版本号;读不到时为空 */
  latest: '',
  /** 安装来源有新的提交,可以更新 */
  available: false,
  checking: false,
  /** 正在更新或改用另一条线路,或已完成、等待刷新 */
  updating: false,
  /** 比当前版本新的更新说明,新的在前 */
  notes: [] as UpdateNote[],
  /** 正在读取更新说明 */
  notesLoading: false,
  /** 在网页上查看完整更新记录的地址;安装来源不是 GitHub 或码云时为空 */
  changelogUrl: '',
  /** 更新窗口是否打开 */
  dialogOpen: false,
  /** 上次更新或改用线路失败的原因,显示在窗口里 */
  error: '',
  /** 刚在宝书里更新完:更新前的版本号和这次的更新内容(读本机 README),显示「更新完成」窗口 */
  updatedFrom: '',
  updatedNotes: [] as UpdateNote[],
  updatedDialogOpen: false,
  /** 不能在插件内更新的原因:manual 手动复制安装(不是 git 仓库)、upstream 安装来源是原版柏宝书、missing 酒馆的扩展列表里找不到 */
  unsupportedReason: '' as '' | 'manual' | 'upstream' | 'missing',
  /** 安装来源是本扩展的哪条线路;其他仓库或认不出时为空 */
  line: '' as UpdateLine | '',
  /** 上次检查时酒馆连不上安装来源,结论是浏览器从另一条线路读到的;这时有新版本只能改从那条线路安装 */
  sourceUnreachable: false,
  /** 酒馆拉取新版本失败(服务器连不上安装来源,或目录里的文件被改动过),可以改从另一条线路安装 */
  offerSwitch: false,
  /** 「改用另一条线路」窗口是否打开,和要改用的线路 */
  switchDialogOpen: false,
  switchTarget: 'gitee' as UpdateLine,
  /** 改用线路时旧的安装目录已删除、新线路还没装上:装好之前不能关闭窗口 */
  reinstallPending: false,
});

/** available 有新版本;up-to-date 已是最新;unsupported 不能在插件内更新(原因见 unsupportedReason);failed 这次没查成(网络等),保留上次结论。 */
export type UpdateCheckResult = 'available' | 'up-to-date' | 'unsupported' | 'failed';

/** 原版柏宝书的仓库:安装来源是它时不提示、不更新。 */
const UPSTREAM_REPO = /baibai-git\/ST-BaiBai-Book/i;
/** 更新成功后等这么久再刷新,让用户看到提示。 */
export const RELOAD_DELAY_MS = 1500;
/** 插件内更新前记下的版本号,刷新后据此提示一次更新结果。 */
const UPDATED_FROM_KEY = 'bbs.update.from';
/** 改用另一条线路时记下新线路,刷新后提示一次。 */
const SWITCHED_TO_KEY = 'bbs.update.switchedTo';
/** 自动弹出的更新说明最多列几个版本。 */
const NOTES_LIMIT = 5;
/** 上次自动检查的时间和结果:已是最新或不能更新时,这段时间内刷新页面不再让酒馆去查(手动「检查更新」不受限)。 */
const LAST_CHECK_KEY = 'bbs.update.lastCheck';
export const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60_000;

/** a 是否比 b 新:按点分段比较数字(1.4.10 比 1.4.9 新),段内数字后的后缀不计,缺段按 0。 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 去掉 Markdown 的加粗、代码、链接和图片标记,只留文字。 */
function plainText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** 从 README 取出比 current 新的各版本「## X.Y.Z 的改动」,新的在前,最多 limit 个。 */
export function parseUpdateNotes(readme: string, current: string, limit = NOTES_LIMIT): UpdateNote[] {
  const notes: UpdateNote[] = [];
  let note: UpdateNote | null = null;
  for (const raw of readme.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^##\s/.test(raw)) {
      const version = /^##\s+(\d+(?:\.\d+)+(?:-[\w.]+)?)\s*的改动/.exec(raw)?.[1];
      note = version && isNewerVersion(version, current) ? { version, lines: [] } : null;
      if (note) notes.push(note);
      continue;
    }
    const line = raw.trim();
    if (!note || !line) continue;
    const bullet = /^[-*]\s+/.test(line);
    const text = plainText(bullet ? line.replace(/^[-*]\s+/, '') : line);
    if (text) note.lines.push({ bullet, text });
  }
  return notes.slice(0, limit);
}

/** 仓库所在的网站和「owner/repo」。 */
export interface RepoRef {
  host: UpdateLine;
  repo: string;
}

/** 安装来源是 GitHub 或码云上的仓库时返回所在网站和「owner/repo」;其他来源(本地路径等)返回 null。 */
export function repoOf(remoteUrl: string): RepoRef | null {
  const m = /\b(github\.com|gitee\.com)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  if (!m) return null;
  return { host: m[1]?.toLowerCase() === 'gitee.com' ? 'gitee' : 'github', repo: `${m[2]}/${m[3]}` };
}

/** 仓库是本扩展的哪条线路;其他仓库返回空串。 */
export function lineOf(source: RepoRef | null): UpdateLine | '' {
  return source && source.repo.toLowerCase() === OFFICIAL_REPOS[source.host].toLowerCase() ? source.host : '';
}

/** 酒馆检查失败时的报错(git 的输出)里提到的仓库;认不出时返回 null。 */
export function repoInError(text: string): RepoRef | null {
  for (const [url] of text.matchAll(/(?:https?:\/\/|git@)[^\s'"]+/gi)) {
    const source = repoOf(url.replace(/[),.:;]+$/, ''));
    if (source) return source;
  }
  return null;
}

/** 本扩展在 third-party 下的目录名:从脚本地址解析,取不到时用仓库名。 */
export function extensionFolderName(url: string = import.meta.url): string {
  try {
    const path = new URL(url).pathname;
    const marker = '/third-party/';
    const at = path.indexOf(marker);
    if (at >= 0) {
      const folder = decodeURIComponent(path.slice(at + marker.length).split('/')[0] ?? '');
      if (folder) return folder;
    }
  } catch {
    /* 解析失败时回退 */
  }
  return 'ST-Prism-Book';
}

function requestHeaders(): Record<string, string> {
  return getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetchWithTimeout(url, { method: 'POST', headers: requestHeaders(), body: JSON.stringify(body) }, timeoutMs);
}

interface Install {
  name: string;
  /** 装在所有用户共用的目录(而不是当前用户目录),酒馆的扩展接口要传 global */
  global: boolean;
}

/** 本扩展的安装位置;酒馆的扩展列表里找不到时返回 null。请求失败时抛错。 */
async function findInstall(): Promise<Install | null> {
  const name = extensionFolderName();
  const resp = await fetchWithTimeout('/api/extensions/discover', { method: 'GET', headers: requestHeaders(), cache: 'no-store' }, 15_000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const list = (await resp.json()) as Array<{ name?: string; type?: string }>;
  const hit = Array.isArray(list) ? list.find(x => x?.name === `third-party/${name}`) : undefined;
  if (hit?.type !== 'local' && hit?.type !== 'global') return null;
  return { name, global: hit.type === 'global' };
}

/** 读一个文本文件;失败、超时时返回空串(只用于展示,不影响能否更新)。bust 为 true 时加时间戳,不用浏览器缓存。 */
async function fetchText(url: string, bust = true): Promise<string> {
  try {
    const target = bust ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
    const resp = await fetchWithTimeout(target, { method: 'GET', cache: 'no-store' }, 6_000);
    return resp.ok ? await resp.text() : '';
  } catch {
    return '';
  }
}

/** 读新版本号和更新说明的一处来源:码云接口返回 JSON(文件内容为 base64),其余直接返回文件。 */
interface ReleaseSource {
  url: (file: string) => string;
  gitee: boolean;
}

/** 分支名放进网址路径:各段分别转义,保留斜杠。 */
function pathRef(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function githubSources(repo: string, branch: string): ReleaseSource[] {
  const ref = pathRef(branch);
  return [
    `https://raw.githubusercontent.com/${repo}/${ref}/`,
    `https://cdn.jsdelivr.net/gh/${repo}@${ref}/`,
    `https://fastly.jsdelivr.net/gh/${repo}@${ref}/`,
  ].map(base => ({ url: (file: string) => base + file, gitee: false }));
}

function giteeSource(repo: string, branch: string): ReleaseSource {
  // 码云的原始文件地址不允许网页跨域读取,接口可以(匿名每小时 60 次)
  return { url: file => `https://gitee.com/api/v5/repos/${repo}/contents/${file}?ref=${encodeURIComponent(branch)}`, gitee: true };
}

/**
 * 读新版本号和更新说明的线路,依次尝试。安装来源是本扩展的仓库时,先读 first 指定的线路(默认是安装来源所在的网站),
 * 再读另一条;码云排在 jsDelivr 前:国内能访问,读到的是仓库里的最新文件。
 * jsDelivr 对分支最多缓存 12 小时,发布后要清缓存(见 docs/INTERNAL-RELEASE.md);读到的旧内容只会少列几条说明。
 */
export function releaseSources(source: RepoRef, branch: string, first: UpdateLine = source.host): ReleaseSource[] {
  if (!lineOf(source)) return source.host === 'gitee' ? [giteeSource(source.repo, branch)] : githubSources(source.repo, branch);
  const github = githubSources(OFFICIAL_REPOS.github, branch);
  const gitee = giteeSource(OFFICIAL_REPOS.gitee, branch);
  return first === 'gitee' ? [gitee, ...github] : [...github.slice(0, 1), gitee, ...github.slice(1)];
}

/** 码云接口返回的文件(base64)解码成文本;格式不对时返回空串。 */
export function decodeGiteeFile(json: string): string {
  try {
    const data = JSON.parse(json) as { content?: unknown; encoding?: unknown };
    if (data.encoding !== 'base64' || typeof data.content !== 'string') return '';
    return new TextDecoder().decode(Uint8Array.from(atob(data.content), c => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

async function readFile(source: ReleaseSource, file: string): Promise<string> {
  const text = await fetchText(source.url(file));
  return source.gitee && text ? decodeGiteeFile(text) : text;
}

function manifestVersion(text: string): string {
  try {
    return String((JSON.parse(text) as { version?: unknown }).version ?? '').trim();
  } catch {
    return '';
  }
}

interface Release {
  version: string;
  readme: string;
}

/** 依次从各来源读 manifest.json 的版本号和 README,第一处读到任一个的为准;都读不到时返回 null。 */
async function readRelease(sources: ReleaseSource[]): Promise<Release | null> {
  for (const source of sources) {
    const [readme, manifest] = await Promise.all([readFile(source, 'README.md'), readFile(source, 'manifest.json')]);
    const version = manifestVersion(manifest);
    if (readme || version) return { version, readme };
  }
  return null;
}

/** 读到的新版本号和更新说明写进 updateState;缓存里的旧 manifest 版本号不比当前新时不显示。 */
function applyRelease(release: Release | null): void {
  updateState.notes = release ? parseUpdateNotes(release.readme, PLUGIN_VERSION) : [];
  updateState.latest = release && isNewerVersion(release.version, PLUGIN_VERSION) ? release.version : '';
}

function changelogUrlOf(source: RepoRef, branch: string): string {
  const site = source.host === 'gitee' ? 'gitee.com' : 'github.com';
  return `https://${site}/${source.repo}/blob/${pathRef(branch)}/CHANGELOG.md`;
}

function noUpdate(result: UpdateCheckResult, reason: typeof updateState.unsupportedReason = ''): UpdateCheckResult {
  updateState.available = false;
  updateState.latest = '';
  updateState.notes = [];
  updateState.unsupportedReason = reason;
  return result;
}

/**
 * 酒馆没查成(git fetch 失败或超时)时,由浏览器读另一条线路上的版本号。安装来源是本扩展的仓库、或报错里认不出时
 * (按 GitHub 算,多数是从 GitHub 安装的)才查;其他仓库没有另一条线路,算没查成。
 */
async function checkViaMirror(errorText: string): Promise<UpdateCheckResult> {
  const source = repoInError(errorText);
  const line = source ? lineOf(source) : 'github';
  if (!line) return 'failed';
  const target = otherLine(line);
  const release = await readRelease(releaseSources({ host: line, repo: OFFICIAL_REPOS[line] }, 'main', target));
  if (!release?.version) return 'failed';
  updateState.line = source ? line : '';
  updateState.sourceUnreachable = true;
  if (!isNewerVersion(release.version, PLUGIN_VERSION)) return noUpdate('up-to-date');
  updateState.available = true;
  updateState.unsupportedReason = '';
  updateState.changelogUrl = changelogUrlOf({ host: target, repo: OFFICIAL_REPOS[target] }, 'main');
  applyRelease(release);
  return 'available';
}

async function runCheck(): Promise<UpdateCheckResult> {
  updateState.checking = true;
  updateState.offerSwitch = false;
  try {
    const install = await findInstall();
    if (!install) return noUpdate('unsupported', 'missing');
    let resp: Response | null;
    try {
      resp = await postJson('/api/extensions/version', { extensionName: install.name, global: install.global }, 60_000);
    } catch {
      resp = null;
    }
    // 酒馆执行 git fetch 失败(返回 500 和 git 的报错)、超时或前置代理等不及:多半是服务器连不上安装来源
    if (!resp || resp.status >= 500) return await checkViaMirror(resp ? await resp.text().catch(() => '') : '');
    if (!resp.ok) return 'failed';
    const info = (await resp.json()) as { currentBranchName?: string; currentCommitHash?: string; isUpToDate?: boolean; remoteUrl?: string };
    const remote = String(info.remoteUrl ?? '');
    // 不是 git 仓库(手动复制安装)时酒馆返回空的提交号和地址;来源是原版柏宝书时不更新
    if (!info.currentCommitHash || !remote) return noUpdate('unsupported', 'manual');
    if (UPSTREAM_REPO.test(remote)) return noUpdate('unsupported', 'upstream');
    const source = repoOf(remote);
    updateState.line = lineOf(source);
    updateState.sourceUnreachable = false;
    if (info.isUpToDate !== false) return noUpdate('up-to-date');
    updateState.available = true;
    updateState.unsupportedReason = '';
    const branch = String(info.currentBranchName || 'main');
    updateState.changelogUrl = source ? changelogUrlOf(source, branch) : '';
    if (source) {
      updateState.notesLoading = true;
      try {
        applyRelease(await readRelease(releaseSources(source, branch)));
      } finally {
        updateState.notesLoading = false;
      }
    }
    return 'available';
  } catch {
    return 'failed';
  } finally {
    updateState.checking = false;
  }
}

let pendingCheck: Promise<UpdateCheckResult> | null = null;
let lastCheck: UpdateCheckResult | null = null;

/** 上次自动检查的记录;同一版本、在间隔内、结论是「已是最新」或「不能更新」时可以沿用(连同线路)。 */
function recentCheck(): UpdateCheckResult | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_CHECK_KEY) ?? 'null') as {
      at?: unknown; result?: unknown; version?: unknown; reason?: unknown; line?: unknown; unreachable?: unknown;
    } | null;
    if (!saved || saved.version !== PLUGIN_VERSION || typeof saved.at !== 'number') return null;
    if (Date.now() - saved.at < 0 || Date.now() - saved.at >= UPDATE_CHECK_INTERVAL_MS) return null;
    const reason = saved.reason === 'manual' || saved.reason === 'upstream' || saved.reason === 'missing' ? saved.reason : null;
    if (saved.result !== 'up-to-date' && !(saved.result === 'unsupported' && reason)) return null;
    updateState.line = saved.line === 'github' || saved.line === 'gitee' ? saved.line : '';
    updateState.sourceUnreachable = saved.unreachable === true;
    return saved.result === 'up-to-date' ? noUpdate('up-to-date') : noUpdate('unsupported', reason ?? '');
  } catch {
    return null;
  }
}

function rememberCheck(result: UpdateCheckResult): void {
  try {
    // 有新版本或没查成时不记:下次刷新还要查,才能弹出更新窗口、或在网络恢复后查到
    if (result === 'up-to-date' || result === 'unsupported') {
      const { unsupportedReason: reason, line, sourceUnreachable: unreachable } = updateState;
      localStorage.setItem(LAST_CHECK_KEY, JSON.stringify({ at: Date.now(), result, reason, line, unreachable, version: PLUGIN_VERSION }));
    } else {
      localStorage.removeItem(LAST_CHECK_KEY);
    }
  } catch {
    /* 只影响下次是否重查 */
  }
}

/**
 * 检查更新,结果写进 updateState。一次会话只查一次(刷新页面后重查),force=true 时重新查(设置页的「检查更新」)。
 * 自动检查时,上次查过「已是最新」或「不能更新」且不到 3 小时就沿用,不再让酒馆去查:
 * 每查一次都要酒馆对安装目录 git fetch,网络不好时频繁刷新页面会让好几次查询挂在后台,还会让之后的更新失败。
 * 查询失败不清除上次的结论,也不打扰用户。
 */
export function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  if (pendingCheck) return pendingCheck;
  if (lastCheck && !force) return Promise.resolve(lastCheck);
  const cached = force ? null : recentCheck();
  if (cached) {
    lastCheck = cached;
    return Promise.resolve(cached);
  }
  pendingCheck = runCheck()
    .then(result => {
      rememberCheck(result);
      return (lastCheck = result);
    })
    .finally(() => { pendingCheck = null; });
  return pendingCheck;
}

/** 更新失败时给用户看的原因。 */
function updateFailure(status: number): string {
  if (status === 403) return '本扩展装在所有用户共用的目录里，只有管理员账号能更新。';
  if (status === 404) return '没有找到本扩展的安装目录，可以在酒馆的「管理扩展」里更新或重新安装。';
  const { line } = updateState;
  if (line) return spaced(`酒馆没能拉取新版本：可能是服务器连不上${LINE_LABEL[line]}，或扩展目录里的文件被改动过。可以点「改从${LINE_LABEL[otherLine(line)]}安装」重新安装，或稍后再试。`);
  return '酒馆没能拉取新版本：可能是服务器连不上安装来源，或扩展目录里的文件被改动过。可以稍后再试，或在酒馆的「管理扩展」里更新；仍然失败时，删除后重新安装。';
}

/** 本扩展的安装位置;取不到酒馆的扩展列表或列表里没有时抛错,说明原因。 */
async function requireInstall(): Promise<Install> {
  let install: Install | null;
  try {
    install = await findInstall();
  } catch {
    // 酒馆的扩展列表都没取到:多半是服务器连不上或登录已过期,不是安装目录不在
    throw new Error('没能向酒馆确认安装位置：可能是酒馆服务器连不上，或登录已过期。请刷新页面后再试。');
  }
  if (!install) throw new Error(updateFailure(404));
  return install;
}

/** 刷新后要提示的内容记下来,过 RELOAD_DELAY_MS 刷新酒馆。 */
function reloadAfter(switchedTo?: UpdateLine): void {
  try {
    localStorage.setItem(UPDATED_FROM_KEY, PLUGIN_VERSION);
    if (switchedTo) {
      localStorage.setItem(SWITCHED_TO_KEY, switchedTo);
      // 上次检查记下的线路已经不对了
      localStorage.removeItem(LAST_CHECK_KEY);
    }
  } catch {
    /* 只影响刷新后的提示 */
  }
  setTimeout(() => location.reload(), RELOAD_DELAY_MS);
}

/**
 * 更新到安装来源的最新版本:调用酒馆的扩展更新接口,成功后过 RELOAD_DELAY_MS 自动刷新酒馆。
 * 返回 updated(已更新,即将刷新)或 up-to-date(已是最新,不刷新);失败时抛错,原因同时写进 updateState.error。
 */
export async function performUpdate(): Promise<'updated' | 'up-to-date'> {
  if (updateState.updating) throw new Error('正在更新，请稍候。');
  updateState.updating = true;
  updateState.error = '';
  updateState.offerSwitch = false;
  let reloading = false;
  try {
    const install = await requireInstall();
    let resp: Response;
    try {
      resp = await postJson('/api/extensions/update', { extensionName: install.name, global: install.global }, 120_000);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('更新请求超时：酒馆可能还在后台下载新版本，稍等一会儿刷新页面，看看版本号有没有变。');
      throw new Error('连不上酒馆服务器，请确认酒馆还在运行后再试。');
    }
    if (!resp.ok) {
      // 拉取失败(连不上安装来源或文件被改动过)时,改从另一条线路重新安装多半能装上
      updateState.offerSwitch = resp.status >= 500 && updateState.line !== '';
      throw new Error(updateFailure(resp.status));
    }
    const data = (await resp.json().catch(() => ({}))) as { isUpToDate?: boolean };
    updateState.available = false;
    if (data.isUpToDate === true) return 'up-to-date';
    reloading = true;
    reloadAfter();
    return 'updated';
  } catch (e) {
    updateState.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    if (!reloading) updateState.updating = false;
  }
}

/** 改用线路时已删除、还没装上的那份安装;再次改用时不再删除,直接安装。 */
let removedInstall: Install | null = null;

/** 浏览器从这条线路本身(GitHub 原始文件或码云接口,不含 jsDelivr)读到的版本号;读不到时为空串。 */
async function lineVersion(line: UpdateLine): Promise<string> {
  const [first] = releaseSources({ host: line, repo: OFFICIAL_REPOS[line] }, 'main');
  return first ? manifestVersion(await readFile(first, 'manifest.json')) : '';
}

/** 刷新页面前没装好时怎么办。 */
function manualInstallHint(target: UpdateLine): string {
  return `刷新页面前没装好的话，需要在酒馆的「扩展」→「安装扩展」里填 ${LINE_URL[target]} 重新安装；设置、聊天和记忆都保存在酒馆里，不受影响。`;
}

async function removeInstall(install: Install, target: UpdateLine): Promise<void> {
  let resp: Response;
  try {
    resp = await postJson('/api/extensions/delete', { extensionName: install.name, global: install.global }, 60_000);
  } catch {
    throw new Error('连不上酒馆服务器，没有改动现有的安装。请确认酒馆还在运行后再试。');
  }
  if (resp.status === 403) throw new Error('本扩展装在所有用户共用的目录里，只有管理员账号能改用线路。');
  if (!resp.ok) throw new Error(`酒馆没能删除现有的安装目录（HTTP ${resp.status}）。可以稍后再试，或在酒馆的「管理扩展」里删除棱镜宝书后，用「安装扩展」填 ${LINE_URL[target]} 重新安装。`);
}

async function installFrom(target: UpdateLine, install: Install): Promise<void> {
  const label = LINE_LABEL[target];
  let resp: Response;
  try {
    // 酒馆的安装接口(git clone)本身不限时
    resp = await postJson('/api/extensions/install', { url: LINE_URL[target], global: install.global }, 300_000);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(spaced(`安装请求超时：酒馆可能还在从${label}下载。稍等一会儿刷新页面；刷新后没有棱镜宝书时，在酒馆的「扩展」→「安装扩展」里填 ${LINE_URL[target]} 重新安装。`));
    throw new Error(`连不上酒馆服务器：旧版本已删除，新版本还没装上。请确认酒馆还在运行后点「重新安装」。${manualInstallHint(target)}`);
  }
  if (resp.ok) return;
  if (resp.status === 409) throw new Error(`酒馆的扩展目录里已经有同名文件夹，可能刚才已经装好了。请刷新页面，看看版本号；没有棱镜宝书时，在「管理扩展」里查看后，用 ${LINE_URL[target]} 重新安装。`);
  throw new Error(spaced(`旧版本已删除，但酒馆没能从${label}下载新版本（多半是服务器连不上${label}）。可以点「重新安装」再试，或改从${LINE_LABEL[otherLine(target)]}安装。`) + manualInstallHint(target));
}

/**
 * 改用另一条线路:浏览器先确认读得到那条线路上的版本号、且不比当前旧,再请酒馆删除安装目录,从那条线路的地址重新安装,
 * 成功后过 RELOAD_DELAY_MS 自动刷新酒馆。删除后没装上时记下(updateState.reinstallPending),再调用时直接安装(可以换线路)。
 * 失败时抛错,原因同时写进 updateState.error。
 */
export async function switchLine(target: UpdateLine): Promise<void> {
  if (updateState.updating) throw new Error('正在更新，请稍候。');
  updateState.updating = true;
  updateState.error = '';
  updateState.switchTarget = target;
  let reloading = false;
  try {
    let install = removedInstall;
    if (!install) {
      install = await requireInstall();
      const label = LINE_LABEL[target];
      // 浏览器都读不到时,酒馆多半也连不上;先不动现有的安装
      const version = await lineVersion(target);
      if (!version) throw new Error(spaced(`连不上${label}（浏览器没读到${label}上的版本信息），没有改动现有的安装。请检查网络后再试。`));
      if (isNewerVersion(PLUGIN_VERSION, version)) throw new Error(spaced(`${label}上还是旧版本 v${version}（当前 v${PLUGIN_VERSION}），没有改动现有的安装，以免装回旧版本。请过一阵再试。`));
      await removeInstall(install, target);
      removedInstall = install;
      updateState.reinstallPending = true;
    }
    await installFrom(target, install);
    removedInstall = null;
    updateState.reinstallPending = false;
    reloading = true;
    reloadAfter(target);
  } catch (e) {
    updateState.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    if (!reloading) updateState.updating = false;
  }
}

/** 本机 README 的地址:扩展目录下的文件由酒馆直接提供,加上版本号免得浏览器拿到旧缓存。 */
function localReadmeUrl(): string {
  return versionedAssetUrl('../README.md', import.meta.url);
}

/**
 * 插件内更新或改用线路并自动刷新后调用(启动时):从本机新装好的 README 读出比旧版本新的「X.Y.Z 的改动」,
 * 弹出「更新完成」窗口;没有新内容或读不到时只提示一句。改用了线路时另提示一句。读的是本机文件,不依赖外网。
 */
export async function announceUpdated(): Promise<void> {
  let from: string | null;
  let switchedTo: string | null;
  try {
    from = localStorage.getItem(UPDATED_FROM_KEY);
    switchedTo = localStorage.getItem(SWITCHED_TO_KEY);
    if (from !== null) localStorage.removeItem(UPDATED_FROM_KEY);
    if (switchedTo !== null) localStorage.removeItem(SWITCHED_TO_KEY);
  } catch {
    return;
  }
  const line = switchedTo === 'github' || switchedTo === 'gitee' ? switchedTo : null;
  if (line) toast(spaced(`已改用${LINE_LABEL[line]}线路，之后从${LINE_LABEL[line]}检查和安装更新。`), 'success');
  if (from === null) return;
  const notes = from !== PLUGIN_VERSION ? parseUpdateNotes(await fetchText(localReadmeUrl(), false), from) : [];
  if (notes.length) {
    updateState.updatedFrom = from;
    updateState.updatedNotes = notes;
    updateState.updatedDialogOpen = true;
    return;
  }
  if (from !== PLUGIN_VERSION) toast(`棱镜宝书已更新到 v${PLUGIN_VERSION}。`, 'success');
  else if (!line) toast('棱镜宝书已更新。', 'success');
}

export function closeUpdatedDialog(): void {
  updateState.updatedDialogOpen = false;
}

let autoShown = false;

/** 打开宝书时调用:有新版本就弹出更新窗口。每次打开酒馆最多自动弹一次,点「以后再说」后这次不再弹。 */
export function showUpdateDialogOnce(): void {
  if (autoShown || !updateState.available) return;
  autoShown = true;
  openUpdateDialog();
}

export function openUpdateDialog(): void {
  updateState.error = '';
  updateState.offerSwitch = false;
  updateState.dialogOpen = true;
}

/** 关闭更新窗口;更新进行中时不关。 */
export function closeUpdateDialog(): void {
  if (!updateState.updating) updateState.dialogOpen = false;
}

/** 默认改用的线路:当前线路以外的那条;认不出安装来源时按从 GitHub 安装算,改用码云。 */
export function defaultSwitchTarget(): UpdateLine {
  return otherLine(updateState.line || 'github');
}

/** 打开「改用另一条线路」窗口(关掉更新窗口);旧安装已删除、还没装上时沿用上次的线路。 */
export function openSwitchDialog(target: UpdateLine = defaultSwitchTarget()): void {
  if (updateState.updating) return;
  if (!updateState.reinstallPending) {
    updateState.switchTarget = target;
    updateState.error = '';
  }
  updateState.dialogOpen = false;
  updateState.switchDialogOpen = true;
}

/** 关闭「改用另一条线路」窗口;正在安装,或旧安装已删除、还没装上时不关。 */
export function closeSwitchDialog(): void {
  if (!updateState.updating && !updateState.reinstallPending) updateState.switchDialogOpen = false;
}
