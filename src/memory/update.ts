/**
 * 检查与安装更新(做法同酒馆助手):
 * - 检查:请酒馆服务器对本扩展的安装目录执行 git fetch(/api/extensions/version),落后于安装来源时为「有新版本」。
 *   与酒馆「管理扩展」走同一条路,浏览器连不上 GitHub 也能查;新版本号和更新说明另从 GitHub 读取,
 *   连不上时改走 jsDelivr,都读不到只提示有新版本。
 * - 提示:设置导航亮角标、设置页显示「更新」;打开宝书时弹出更新窗口,每次打开酒馆最多自动弹一次。
 * - 安装:确认后调用酒馆的扩展更新接口(/api/extensions/update,即 git pull),成功后自动刷新酒馆;
 *   刷新后从本机新装好的 README 读出这次的更新内容弹出来,不依赖外网。
 * 安装来源是原版柏宝书仓库时不提示、不更新,以免把本扩展换成原版;不是用仓库地址安装的(手动复制)无法在插件内更新。
 */
import { reactive } from 'vue';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { PLUGIN_VERSION, versionedAssetUrl } from '@/version';

export const INTERNAL_UPDATE_NOTICE = '有新版本时，设置页显示「更新」，打开宝书会弹出更新窗口，更新完成后自动刷新酒馆；也可以在酒馆的「管理扩展」里更新。只从本扩展的安装来源更新，不会装上原版柏宝书的更新。';

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
  /** 正在更新,或更新完成、等待刷新 */
  updating: false,
  /** 比当前版本新的更新说明,新的在前 */
  notes: [] as UpdateNote[],
  /** 正在读取更新说明 */
  notesLoading: false,
  /** 在网页上查看完整更新记录的地址;安装来源不是 GitHub 时为空 */
  changelogUrl: '',
  /** 更新窗口是否打开 */
  dialogOpen: false,
  /** 上次更新失败的原因,显示在更新窗口里 */
  error: '',
  /** 刚在宝书里更新完:更新前的版本号和这次的更新内容(读本机 README),显示「更新完成」窗口 */
  updatedFrom: '',
  updatedNotes: [] as UpdateNote[],
  updatedDialogOpen: false,
  /** 不能在插件内更新的原因:manual 手动复制安装(不是 git 仓库)、upstream 安装来源是原版柏宝书、missing 酒馆的扩展列表里找不到 */
  unsupportedReason: '' as '' | 'manual' | 'upstream' | 'missing',
});

/** available 有新版本;up-to-date 已是最新;unsupported 不能在插件内更新(原因见 unsupportedReason);failed 这次没查成(网络等),保留上次结论。 */
export type UpdateCheckResult = 'available' | 'up-to-date' | 'unsupported' | 'failed';

/** 原版柏宝书的仓库:安装来源是它时不提示、不更新。 */
const UPSTREAM_REPO = /baibai-git\/ST-BaiBai-Book/i;
/** 更新成功后等这么久再刷新,让用户看到提示。 */
export const RELOAD_DELAY_MS = 1500;
/** 插件内更新前记下的版本号,刷新后据此提示一次更新结果。 */
const UPDATED_FROM_KEY = 'bbs.update.from';
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

/** 安装来源是 GitHub 仓库时返回「owner/repo」;其他来源(Gitee、本地路径等)返回 null。 */
export function githubRepoOf(remoteUrl: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
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

interface Install {
  name: string;
  /** 装在所有用户共用的目录(而不是当前用户目录),更新接口要传 global */
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

/**
 * 读新版本号和更新说明的线路,依次尝试:GitHub 原始文件,连不上再走 jsDelivr 的两个入口(国内多数能访问)。
 * jsDelivr 对分支最多缓存 12 小时,发布后要清缓存(见 docs/INTERNAL-RELEASE.md);读到的旧内容只会少列几条说明。
 */
export function releaseFileBases(repo: string, ref: string): string[] {
  return [
    `https://raw.githubusercontent.com/${repo}/${ref}/`,
    `https://cdn.jsdelivr.net/gh/${repo}@${ref}/`,
    `https://fastly.jsdelivr.net/gh/${repo}@${ref}/`,
  ];
}

function manifestVersion(text: string): string {
  try {
    return String((JSON.parse(text) as { version?: unknown }).version ?? '').trim();
  } catch {
    return '';
  }
}

/** 从安装来源的 GitHub 仓库读新版本号和更新说明;不是 GitHub 或各条线路都读不到时留空。 */
async function loadReleaseInfo(remoteUrl: string, branch: string): Promise<void> {
  const repo = githubRepoOf(remoteUrl);
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  updateState.changelogUrl = repo ? `https://github.com/${repo}/blob/${ref}/CHANGELOG.md` : '';
  if (!repo) return;
  updateState.notesLoading = true;
  try {
    for (const base of releaseFileBases(repo, ref)) {
      const [readme, manifest] = await Promise.all([fetchText(base + 'README.md'), fetchText(base + 'manifest.json')]);
      if (!readme) continue;
      updateState.notes = parseUpdateNotes(readme, PLUGIN_VERSION);
      // 缓存里的旧 manifest 版本号不比当前新时不显示
      const latest = manifestVersion(manifest);
      if (latest && isNewerVersion(latest, PLUGIN_VERSION)) updateState.latest = latest;
      return;
    }
  } finally {
    updateState.notesLoading = false;
  }
}

function noUpdate(result: UpdateCheckResult, reason: typeof updateState.unsupportedReason = ''): UpdateCheckResult {
  updateState.available = false;
  updateState.latest = '';
  updateState.notes = [];
  updateState.unsupportedReason = reason;
  return result;
}

async function runCheck(): Promise<UpdateCheckResult> {
  updateState.checking = true;
  try {
    const install = await findInstall();
    if (!install) return noUpdate('unsupported', 'missing');
    const resp = await fetchWithTimeout('/api/extensions/version', {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({ extensionName: install.name, global: install.global }),
    }, 60_000);
    if (!resp.ok) return 'failed';
    const info = (await resp.json()) as { currentBranchName?: string; currentCommitHash?: string; isUpToDate?: boolean; remoteUrl?: string };
    const remote = String(info.remoteUrl ?? '');
    // 不是 git 仓库(手动复制安装)时酒馆返回空的提交号和地址;来源是原版柏宝书时不更新
    if (!info.currentCommitHash || !remote) return noUpdate('unsupported', 'manual');
    if (UPSTREAM_REPO.test(remote)) return noUpdate('unsupported', 'upstream');
    if (info.isUpToDate !== false) return noUpdate('up-to-date');
    updateState.available = true;
    updateState.unsupportedReason = '';
    await loadReleaseInfo(remote, String(info.currentBranchName || 'main'));
    return 'available';
  } catch {
    return 'failed';
  } finally {
    updateState.checking = false;
  }
}

let pendingCheck: Promise<UpdateCheckResult> | null = null;
let lastCheck: UpdateCheckResult | null = null;

/** 上次自动检查的记录;同一版本、在间隔内、结论是「已是最新」或「不能更新」时可以沿用。 */
function recentCheck(): UpdateCheckResult | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_CHECK_KEY) ?? 'null') as { at?: unknown; result?: unknown; version?: unknown; reason?: unknown } | null;
    if (!saved || saved.version !== PLUGIN_VERSION || typeof saved.at !== 'number') return null;
    if (Date.now() - saved.at < 0 || Date.now() - saved.at >= UPDATE_CHECK_INTERVAL_MS) return null;
    if (saved.result === 'up-to-date') return noUpdate('up-to-date');
    if (saved.result === 'unsupported' && (saved.reason === 'manual' || saved.reason === 'upstream' || saved.reason === 'missing')) return noUpdate('unsupported', saved.reason);
    return null;
  } catch {
    return null;
  }
}

function rememberCheck(result: UpdateCheckResult): void {
  try {
    // 有新版本或没查成时不记:下次刷新还要查,才能弹出更新窗口、或在网络恢复后查到
    if (result === 'up-to-date' || result === 'unsupported') {
      localStorage.setItem(LAST_CHECK_KEY, JSON.stringify({ at: Date.now(), result, reason: updateState.unsupportedReason, version: PLUGIN_VERSION }));
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
  return '酒馆没能拉取新版本：可能是服务器连不上 GitHub，或扩展目录里的文件被改动过。可以稍后再试，或在酒馆的「管理扩展」里更新；仍然失败时，删除后重新安装。';
}

/**
 * 更新到安装来源的最新版本:调用酒馆的扩展更新接口,成功后过 RELOAD_DELAY_MS 自动刷新酒馆。
 * 返回 updated(已更新,即将刷新)或 up-to-date(已是最新,不刷新);失败时抛错,原因同时写进 updateState.error。
 */
export async function performUpdate(): Promise<'updated' | 'up-to-date'> {
  if (updateState.updating) throw new Error('正在更新，请稍候。');
  updateState.updating = true;
  updateState.error = '';
  let reloading = false;
  try {
    let install: Install | null;
    try {
      install = await findInstall();
    } catch {
      // 酒馆的扩展列表都没取到:多半是服务器连不上或登录已过期,不是安装目录不在
      throw new Error('没能向酒馆确认安装位置：可能是酒馆服务器连不上，或登录已过期。请刷新页面后再试。');
    }
    if (!install) throw new Error(updateFailure(404));
    let resp: Response;
    try {
      resp = await fetchWithTimeout('/api/extensions/update', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ extensionName: install.name, global: install.global }),
      }, 120_000);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('更新请求超时：酒馆可能还在后台下载新版本，稍等一会儿刷新页面，看看版本号有没有变。');
      throw new Error('连不上酒馆服务器，请确认酒馆还在运行后再试。');
    }
    if (!resp.ok) throw new Error(updateFailure(resp.status));
    const data = (await resp.json().catch(() => ({}))) as { isUpToDate?: boolean };
    updateState.available = false;
    if (data.isUpToDate === true) return 'up-to-date';
    try { localStorage.setItem(UPDATED_FROM_KEY, PLUGIN_VERSION); } catch { /* 只影响刷新后的提示 */ }
    reloading = true;
    setTimeout(() => location.reload(), RELOAD_DELAY_MS);
    return 'updated';
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
 * 插件内更新并自动刷新后调用(启动时):从本机新装好的 README 读出比旧版本新的「X.Y.Z 的改动」,
 * 弹出「更新完成」窗口;没有新内容或读不到时只提示一句。读的是本机文件,不依赖外网。
 */
export async function announceUpdated(): Promise<void> {
  let from: string | null;
  try {
    from = localStorage.getItem(UPDATED_FROM_KEY);
    if (from !== null) localStorage.removeItem(UPDATED_FROM_KEY);
  } catch {
    return;
  }
  if (from === null) return;
  const notes = from !== PLUGIN_VERSION ? parseUpdateNotes(await fetchText(localReadmeUrl(), false), from) : [];
  if (notes.length) {
    updateState.updatedFrom = from;
    updateState.updatedNotes = notes;
    updateState.updatedDialogOpen = true;
    return;
  }
  toast(from !== PLUGIN_VERSION ? `棱镜宝书已更新到 v${PLUGIN_VERSION}。` : '棱镜宝书已更新。', 'success');
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
  updateState.dialogOpen = true;
}

/** 关闭更新窗口;更新进行中时不关。 */
export function closeUpdateDialog(): void {
  if (!updateState.updating) updateState.dialogOpen = false;
}
