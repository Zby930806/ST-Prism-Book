<script setup lang="ts">
import { fitTimeTagPrompt } from '@/memory/budget';
import { timeTagPrompt } from '@/memory/timeTag';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import { apiSettings, newChannel, resolveVectorModel, sanitizeTagName, type ApiChannel, type Verbosity } from '@/api/settings';
import { getContext } from '@/st/context';
import {
  JAILBREAK_PROMPT,
  RESUMMARY2_MACROS,
  RESUMMARY2_PROMPT,
  RESUMMARY_MACROS,
  RESUMMARY_PROMPT,
  SUMMARY_MACROS,
  SUMMARY_PROMPT,
  type PromptMacro,
} from '@/memory/prompts';
import { TIME_TAG_PROMPT } from '@/memory/timeTag';
import { clearVectorIndex, syncVectorIndex } from '@/memory/vector';
import { resetVectorStoreProbe, vectorBackendKind } from '@/memory/vector/store';
import { INTERNAL_UPDATE_NOTICE, performUpdate, updateState } from '@/memory/update';
import { recallDebug } from '@/memory/vector/debug';
import { computeCarryoverPlan, createNewChatWithCarryover, type CarryoverPlan } from '@/memory/carryover';
import { computeMigrationPlan, runHoraeMigration, type MigrationPlan } from '@/memory/migrate';
import { ui, THEMES, ORB_SHAPES, type NavPosition } from '@/state/ui';
import { uploadOrbImage } from '@/st/upload';
import { toast } from '@/st/toast';
import { versionedAssetUrl } from '@/version';
import { computed, nextTick, onMounted, ref } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

/**
 * 思考强度候选:各家取值的并集,**不是**某一家的官方列表。
 * auto 是显式选项(值为空串 = 不发送该参数),不是「留空」。
 * 取值不做校验,原样发给端点(见 ApiChannel.reasoningEffort)。
 */
const REASONING_EFFORT_OPTIONS = [
  { value: '', label: 'auto' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'detailed', label: '详细' },
  { value: 'concise', label: '精简' },
];

/** 任务指派下拉:空串 = 跟随主 API,其余为副渠道 id(未命名渠道给个占位名,免空白选项) */
const channelOptions = computed(() => [
  { value: '', label: '跟随主 API' },
  ...apiSettings.channels.map(c => ({ value: c.id, label: c.name || '未命名渠道' })),
]);

/* —— 悬浮球自定义图标:选图 → 压缩上传到 ST 服务器 → 存路径串(跨设备同步) —— */
const orbFileInput = ref<HTMLInputElement | null>(null);
const orbUploading = ref(false);
function pickOrbImage() {
  orbFileInput.value?.click();
}
async function onOrbFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 复位,允许重复选同一文件
  if (!file) return;
  orbUploading.value = true;
  try {
    ui.orbImage = await uploadOrbImage(file);
    toast('悬浮球图标已更新', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : '上传失败', 'error');
  } finally {
    orbUploading.value = false;
  }
}
function resetOrbImage() {
  ui.orbImage = '';
}

/* —— 渠道:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表平铺误触。
   两套独立渠道:'api'=副 API(摘要/总结),'vector'=向量记忆。弹窗按 scope 操作对应列表。 —— */
type ChannelScope = 'api' | 'vector';
// editingId:正在编辑的「已有渠道」id;新建时为 null。仅用于「完成」时定位写回目标。
const editingId = ref<string | null>(null);
const editingScope = ref<ChannelScope>('api');
// 当前 scope 对应的渠道数组(增删/查找都走它)。向量已改扁平端点,只剩副 API 用渠道。
function channelsOf(_scope: ChannelScope): ApiChannel[] {
  return apiSettings.channels;
}
// 编辑用「草稿副本」:v-model 全改在草稿上,只有点「完成」才写回 apiSettings(避免每敲一字就触发存盘)。
// 弹窗开关也以它为准:草稿存在 = 弹窗打开。
const editingChannel = ref<ApiChannel | null>(null);
// 深拷贝渠道(纯数据,JSON 即可),切断与 apiSettings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 密钥默认隐藏;每次打开/关闭弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

// 排除参数:内部存 string[],编辑时用逗号分隔的单行文本承载,读/写两向转换。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel(scope: ChannelScope = 'api') {
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = null; // null = 新建,完成时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 apiSettings
}
function openChannel(id: string, scope: ChannelScope = 'api') {
  const src = channelsOf(scope).find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 编辑草稿副本,不动真身
}
/** 取消(× / 点遮罩):丢弃草稿,不写回 apiSettings(无论新建还是编辑,改动都作废)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** 完成:把草稿写回 apiSettings —— 新建则 push,编辑则按 id 覆盖。此时才触发存盘。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    draft.timeoutSec =
      Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0
        ? Math.floor(draft.timeoutSec)
        : 180;
    const list = channelsOf(editingScope.value);
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 编辑期间原渠道被删等异常 → 兜底为新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// 删除渠道前的二次确认:点删除先开确认弹窗,确认后才真正删。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // 删除针对「已有渠道」(editingId);新建草稿尚未入库,等同直接丢弃草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const scope = editingScope.value;
  const list = channelsOf(scope);
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:副 API 清两类摘要指派(向量已改扁平端点,不再走渠道系统)
  if (scope === 'api') {
    if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
    if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
  }
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = '测试中…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各渠道拉取到的模型列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = '未返回任何模型';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— 模型可搜索下拉(combobox):输入框既是当前值也是过滤词,聚焦弹出过滤列表 —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // 聚焦后用户输入的过滤词;失焦时清空
// 已拉取到的当前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// 过滤:有 query 按子串(大小写不敏感)过滤;为空则显示全部。性能上限 200 条,避免超长列表卡顿。
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// 失焦延迟关闭,让 option 的 mousedown/click 先生效
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}

/* —— 自定义提示词:列表(摘要/总结/破限/时间标签),点开在弹窗里编辑大文本 —— */
type PromptKey = 'summary' | 'resummary' | 'resummary2' | 'jailbreak' | 'timeTag';
interface PromptMeta {
  key: PromptKey;
  label: string;
  hint: string;
  builtin: string;
  macros: PromptMacro[];
}
const PROMPT_METAS: PromptMeta[] = [
  {
    key: 'summary',
    label: '摘要提示词',
    hint: '把单楼对话整理成结构化记忆(摘要正文 + 时间/地点/物品/计划)。',
    builtin: SUMMARY_PROMPT,
    macros: SUMMARY_MACROS,
  },
  {
    key: 'resummary',
    label: '总结提示词',
    hint: '把多条楼层摘要压成一条 L1 总结(普通总结,固定 300-500 字)。',
    builtin: RESUMMARY_PROMPT,
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'resummary2',
    label: '二次总结提示词',
    hint: '把多条总结再压一层(L1+ → 更上层)。动态字数区间:详细为输入的 40%–50%,精简为 30%–40%。',
    builtin: RESUMMARY2_PROMPT,
    macros: RESUMMARY2_MACROS,
  },
  {
    key: 'jailbreak',
    label: '任务说明(旧破限)' ,
    hint: '作为置顶 system 指明整理任务与资料边界。模式可选默认、自定义、禁用;自定义留空即不发送。',
    builtin: JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'timeTag',
    label: '固定提示词(时间标签)',
    hint: '注入主对话,要求 AI 每条正文前后输出时间标签,作为剧情时间锚点(摘要与新剧情据此对齐,不再错乱)。需开启下方「正文时间标签」开关。留空用内置默认。',
    builtin: TIME_TAG_PROMPT,
    macros: [],
  },
];

// 正在编辑的提示词;draft 是草稿,点「完成」才写回 apiSettings(取消则丢弃)。
const editingPrompt = ref<PromptMeta | null>(null);
const promptDraft = ref('');
const promptArea = ref<HTMLTextAreaElement | null>(null);

// 该任务是否已自定义(非空即视为已覆盖内置)
function isCustom(key: PromptKey): boolean {
  return key === 'jailbreak' ? apiSettings.taskContextMode === 'custom' : apiSettings.prompts[key].trim().length > 0;
}

function openPrompt(meta: PromptMeta) {
  editingPrompt.value = meta;
  // 已自定义→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  promptDraft.value = meta.key === 'jailbreak' && apiSettings.taskContextMode === 'custom'
    ? apiSettings.prompts[meta.key] : apiSettings.prompts[meta.key].trim() || meta.builtin;
}
function closePrompt() {
  editingPrompt.value = null;
  promptDraft.value = '';
}
function savePrompt() {
  const meta = editingPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「默认」
  const v = promptDraft.value.trim();
  apiSettings.prompts[meta.key] = v === meta.builtin.trim() ? '' : promptDraft.value;
  if (meta.key === 'jailbreak') apiSettings.taskContextMode = v === meta.builtin.trim() ? 'default' : 'custom';
  closePrompt();
}
// 「恢复默认」:把草稿重置回内置模板(保存后即回落内置)
function resetPrompt() {
  if (editingPrompt.value) promptDraft.value = editingPrompt.value.builtin;
}

/* —— 向量记忆:三个模型角色,embedding 为基准,后两者留空复用它 —— */
type VectorRole = 'embedding' | 'rerank' | 'queryRewrite';
interface VectorRoleMeta {
  key: VectorRole;
  label: string;
}
const VECTOR_ROLES: VectorRoleMeta[] = [
  { key: 'embedding', label: 'Embedding(向量化,必填)' },
  { key: 'rerank', label: 'Rerank(重排)' },
  { key: 'queryRewrite', label: 'Query 重写' },
];

/* —— 向量端点:每角色直接填 地址/密钥/模型;模型可一键拉取(combobox)。 —— */
const vecShowKey = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
// 三个端点卡片各自折叠,默认全收起,只露标题,需要时再展开。
const vecEpOpen = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModels = ref<Record<VectorRole, string[]>>({ embedding: [], rerank: [], queryRewrite: [] });
const vecLoadingModels = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModelMsg = ref<Record<VectorRole, string>>({ embedding: '', rerank: '', queryRewrite: '' });
// combobox:当前展开的角色(null=都收起)+ 过滤词
const vecModelMenuOpen = ref<VectorRole | null>(null);
const vecModelQuery = ref('');

async function pullVecModels(role: VectorRole) {
  // 解析回落后的地址/密钥:rerank/query 留空时自动用 Embedding 的去拉(模型仍写回本角色)
  const ep = resolveVectorModel(role);
  if (!ep.url.trim()) {
    vecModelMsg.value[role] = role === 'embedding' ? '请先填 Embedding 地址' : '请先填本角色或 Embedding 的地址';
    return;
  }
  vecLoadingModels.value[role] = true;
  vecModelMsg.value[role] = '';
  try {
    const list = await fetchModels({ url: ep.url, key: ep.key, timeoutSec: ep.timeoutSec });
    vecModels.value[role] = list;
    if (list.length && !apiSettings.vector[role].model) apiSettings.vector[role].model = list[0];
    if (!list.length) vecModelMsg.value[role] = '未返回任何模型';
  } catch (e) {
    vecModelMsg.value[role] = e instanceof Error ? e.message : String(e);
  } finally {
    vecLoadingModels.value[role] = false;
  }
}
function filteredVecModels(role: VectorRole): string[] {
  const q = vecModelQuery.value.trim().toLowerCase();
  const list = vecModels.value[role] ?? [];
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
}
function openVecModelMenu(role: VectorRole) {
  vecModelQuery.value = '';
  vecModelMenuOpen.value = role;
}
function pickVecModel(role: VectorRole, m: string) {
  apiSettings.vector[role].model = m;
  vecModelMenuOpen.value = null;
  vecModelQuery.value = '';
}
function closeVecModelMenuSoon() {
  setTimeout(() => {
    vecModelMenuOpen.value = null;
    vecModelQuery.value = '';
  }, 150);
}

/* —— 向量后端类型:'backend' 柏宝库后端 / 'local' 本地降级;探测一次,展示当前在用哪个。 —— */
const vecBackend = ref<'backend' | 'local' | 'unknown'>('unknown');
async function refreshVecBackend(): Promise<void> {
  try {
    vecBackend.value = await vectorBackendKind();
  } catch {
    vecBackend.value = 'unknown';
  }
}
onMounted(refreshVecBackend);

/* —— 检测更新:版本区块 + 确认弹窗 —— */
const updateConfirmOpen = ref(false);
// 内部版不触发远程更新检查。
function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}
async function confirmUpdate() {
  updateConfirmOpen.value = false;
  const toastr = (globalThis as Record<string, any>).toastr;
  try {
    await performUpdate();
    // performUpdate 成功后会自动刷新页面;走到这里通常是已触发刷新倒计时
    toastr?.success?.('更新成功,正在刷新页面…', '棱镜宝书');
  } catch (e) {
    toastr?.error?.(`更新失败:${e instanceof Error ? e.message : String(e)}`, '棱镜宝书');
  }
}

/* —— 索引维护:手动重建当前聊天向量索引 —— */
const vecIndexing = ref(false);
const vecIndexMsg = ref('');
async function doRebuildIndex() {
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = '';
  resetVectorStoreProbe(); // 重测后端,确保索引落到当前真实可用的 store
  try {
    const result = await syncVectorIndex();
    const parts = [
      result.embedded > 0 ? `重新生成 ${result.embedded} 条向量` : '',
      result.payloadUpdated > 0 ? `更新 ${result.payloadUpdated} 条全文/时间` : '',
    ].filter(Boolean);
    vecIndexMsg.value = parts.length ? `已${parts.join('，')}。` : '没有需要更新的索引(已是最新)。';
  } catch (e) {
    vecIndexMsg.value = `索引失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
  }
}

// 清空当前聊天向量索引:破坏性操作,点一次先要二次确认,再点才真清。
const vecClearing = ref(false);
const vecClearConfirm = ref(false);
async function doClearIndex() {
  if (vecClearing.value) return;
  if (!vecClearConfirm.value) {
    vecClearConfirm.value = true;
    return;
  }
  vecClearConfirm.value = false;
  vecClearing.value = true;
  vecIndexMsg.value = '';
  try {
    const n = await clearVectorIndex();
    vecIndexMsg.value = `已清空当前聊天向量索引(删除 ${n} 条)。可点「重建」从头索引。`;
  } catch (e) {
    vecIndexMsg.value = `清空失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecClearing.value = false;
    void refreshVecBackend();
  }
}

/* —— 带数据创建新对话 —— */
const carrying = ref(false);
const carryMsg = ref('');
const carryConfirmOpen = ref(false);
// 携带计划:展开面板时实时算(纯读 chat,不缓存,避免切聊天后过期)
const carryPlan = computed<CarryoverPlan>(() => computeCarryoverPlan());
async function runCarryover() {
  carryConfirmOpen.value = false;
  carrying.value = true;
  carryMsg.value = '';
  try {
    const ok = await createNewChatWithCarryover();
    carryMsg.value = ok ? '已创建新对话。' : '创建未完成(详见提示)。';
  } catch (e) {
    carryMsg.value = `创建失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    carrying.value = false;
  }
}

/* —— 从旧版 Horae 迁移 —— */
const migrating = ref(false);
const migrateMsg = ref('');
const migrateConfirmOpen = ref(false);
// 迁移计划:展开面板时实时算(纯读当前 chat 的 horae_meta,不缓存)
const migratePlan = computed<MigrationPlan>(() => computeMigrationPlan());
// 确认文案随「是否覆盖」变化
const migrateConfirmText = computed(() =>
  migratePlan.value.willOverwrite
    ? '当前聊天已有棱镜宝书数据,迁移会覆盖现有摘要并在各楼写入数据。继续吗?'
    : '将把当前聊天里的 Horae 旧数据迁移成棱镜宝书记忆。继续吗?',
);
async function runMigrate() {
  migrateConfirmOpen.value = false;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const ok = await runHoraeMigration();
    migrateMsg.value = ok ? '迁移完成。' : '迁移未完成(详见提示)。';
  } catch (e) {
    migrateMsg.value = `迁移失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    migrating.value = false;
  }
}

/* —— 排除角色:勾选的角色名(含重名卡)的聊天里,记忆系统所有功能都不生效。
   按「名字」排除,所以同名卡是一批一起排除。列表很长时易卡,故:① 仅在弹窗打开时取/去重角色名;
   ② 带搜索框过滤;③ 用 v-show + 子串匹配,渲染量随搜索收敛。 —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// 弹窗打开时一次性算出去重后的角色名(按名排序),关闭后不再持有,避免常驻大列表。
const charNames = computed<string[]>(() => {
  if (!excludeOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

// 过滤:空搜索显示全部;否则大小写不敏感子串匹配
const filteredCharNames = computed<string[]>(() => {
  const q = excludeSearch.value.trim().toLowerCase();
  if (!q) return charNames.value;
  return charNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExclude() {
  excludeSearch.value = '';
  excludeOpen.value = true;
}
function closeExclude() {
  excludeOpen.value = false;
}
function isExcluded(name: string): boolean {
  return apiSettings.excludedChars.includes(name);
}
function toggleExcluded(name: string) {
  const list = apiSettings.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书:摘要/总结时不带这些整本世界书的条目。复刻排除角色的搜索+勾选弹窗;
   世界书名从 ST 的 getWorldInfoNames()(全部已加载的世界书文件)取。 —— */
const excludeWorldOpen = ref(false);
const excludeWorldSearch = ref('');

// 旧版 ST(如 1.13.5)的 getContext() 没有 getWorldInfoNames,退而从主页面世界书
// 下拉框 #world_editor_select 读选项文本(value="" 是占位项,跳过)。
function readWorldNamesFromDom(): string[] {
  const opts = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
  const out: string[] = [];
  for (const o of opts) {
    if (o.value !== '' && o.textContent) out.push(o.textContent);
  }
  return out;
}

// 弹窗打开时一次性取世界书名(去重去空、按名排序);关闭后不持有。
const worldNames = computed<string[]>(() => {
  if (!excludeWorldOpen.value) return [];
  const getNames = getContext()?.getWorldInfoNames;
  const names = getNames ? getNames() : readWorldNamesFromDom();
  const seen = new Set<string>();
  for (const n of names) {
    const t = n?.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

const filteredWorldNames = computed<string[]>(() => {
  const q = excludeWorldSearch.value.trim().toLowerCase();
  if (!q) return worldNames.value;
  return worldNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExcludeWorld() {
  excludeWorldSearch.value = '';
  excludeWorldOpen.value = true;
}
function closeExcludeWorld() {
  excludeWorldOpen.value = false;
}
function isWorldExcluded(name: string): boolean {
  return apiSettings.excludedWorldNames.includes(name);
}
function toggleWorldExcluded(name: string) {
  const list = apiSettings.excludedWorldNames;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书条目:按条目名(comment)过滤,复刻清洗标签的输入框+chips。
   规则当正则,普通名字即包含匹配;编译失败降级子串。 —— */
const wiPatternDraft = ref('');
function addWiPattern() {
  const pat = wiPatternDraft.value.trim();
  if (!pat) {
    wiPatternDraft.value = '';
    return;
  }
  if (!apiSettings.excludedWorldInfoPatterns.includes(pat)) apiSettings.excludedWorldInfoPatterns.push(pat);
  wiPatternDraft.value = '';
}
function removeWiPattern(pat: string) {
  const idx = apiSettings.excludedWorldInfoPatterns.indexOf(pat);
  if (idx >= 0) apiSettings.excludedWorldInfoPatterns.splice(idx, 1);
}

/* —— 自定义清洗标签:用户填标签名(如 snow),清洗正文时把 <snow>…</snow> 整块删掉 —— */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!apiSettings.customStripTags.includes(tag)) apiSettings.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = apiSettings.customStripTags.indexOf(tag);
  if (idx >= 0) apiSettings.customStripTags.splice(idx, 1);
}

// 点宏标签 → 插入到文本框光标处(无焦点则追加到末尾)
function insertMacro(token: string) {
  const el = promptArea.value;
  if (!el) {
    promptDraft.value += token;
    return;
  }
  const start = el.selectionStart ?? promptDraft.value.length;
  const end = el.selectionEnd ?? start;
  promptDraft.value = promptDraft.value.slice(0, start) + token + promptDraft.value.slice(end);
  // 等 v-model 回填后把光标移到插入内容之后
  void nextTick(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

/* —— 上次召回详情(调试面板):纯只读展示 recallDebug,reactive 自动刷新 —— */
function fmtRecallTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 来源 Q 标签:后端回传 -1(旧后端未支持)时显示占位符
function qLabel(queryIndex: number): string {
  return queryIndex >= 0 ? `Q${queryIndex + 1}` : '—';
}
const TIER_LABEL: Record<'full' | 'brief' | 'drop', string> = { full: '全文', brief: '摘要', drop: '丢弃' };
// 状态语气:决定横幅左侧圆点的配色(成功/警示/失败/进行中)
const recallStatusKind = computed<'ok' | 'warn' | 'fail' | 'pending'>(() => {
  const s = recallDebug.status;
  if (s.includes('失败')) return 'fail';
  if (s.includes('进行中')) return 'pending';
  if (s.includes('未召回') || s.includes('未注入')) return 'warn';
  return 'ok';
});
// 分数(0~1)→ 进度条宽度百分比;负分(如未知)按 0 处理
function scorePct(score: number): number {
  return Math.max(0, Math.min(1, score)) * 100;
}

/* —— 获取数据:宏速查 + 公共接口文档导出 —— */
const DATA_MACROS = [
  {
    token: '{{bbsInjectedHistory}}',
    title: '正常注入历史',
    desc: '与棱镜宝书正常注入一致,自动跳过滑动窗口内仍发送全文的摘要。',
  },
  {
    token: '{{bbsHistory}}',
    title: '全部压缩历史',
    desc: '返回当前聊天全部有效摘要与总结,包括滑动窗口内已有摘要的楼层。',
  },
  {
    token: '{{bbsVars}}',
    title: '全部变量',
    desc: '返回当前自定义变量树的紧凑 JSON。',
  },
  {
    token: '{{bbsVar::路径}}',
    title: '单个变量',
    desc: '按路径读取变量,例如 {{bbsVar::关系.爱丽丝.好感度}}。需要新版宏引擎。',
  },
] as const;

async function copyDataMacro(token: string) {
  try {
    await navigator.clipboard.writeText(token);
    toast(`已复制 ${token}`, 'success');
  } catch {
    toast('复制失败,请手动选择宏文本', 'error');
  }
}

function exportPublicApiDocument() {
  const anchor = document.createElement('a');
  anchor.href = versionedAssetUrl('../PUBLIC_API.md', import.meta.url);
  anchor.download = 'ST-Prism-Book-PUBLIC_API.md';
  anchor.click();
  toast('公共接口文档已导出', 'success');
}

/* 页面导航与概览只读取现有状态，不写入配置，也不发起连接测试。 */
const settingsRoot = ref<HTMLElement | null>(null);
const SETTINGS_GROUPS = [
  { id: 'common', label: '常用设置', icon: 'settings', hint: 'API · 摘要 · 外观' },
  { id: 'memory', label: '记忆与召回', icon: 'summary', hint: '注入 · 向量记忆' },
  { id: 'prompts', label: '提示词', icon: 'edit', hint: '编辑 · 恢复默认' },
  { id: 'advanced', label: '高级过滤', icon: 'vars', hint: '排除 · 内容清洗' },
  { id: 'data', label: '数据与迁移', icon: 'upload', hint: '新对话 · 旧版迁移' },
] as const;
function goToSettingsGroup(id: string) {
  // 限定在本页根节点内，兼容 ST 的 Shadow DOM，不修改宿主页面 hash。
  const heading = settingsRoot.value?.querySelector<HTMLElement>('#prism-settings-' + id);
  if (!heading) return;
  heading.scrollIntoView({ block: 'start', behavior: 'auto' });
  heading.focus({ preventScroll: true });
}
function assignedChannelName(id: string): string {
  if (!id) return '跟随主 API';
  return apiSettings.channels.find(channel => channel.id === id)?.name ||
    (apiSettings.channels.some(channel => channel.id === id) ? '未命名渠道' : '渠道不存在，请重新指派');
}
const currentThemeLabel = computed(() => THEMES.find(theme => theme.value === ui.theme)?.label || ui.theme);
const customPromptCount = computed(() => PROMPT_METAS.filter(meta => isCustom(meta.key)).length);

</script>

<template>
  <section ref="settingsRoot" class="bbs-page prism-settings">
    <PageHeader
      icon="settings"
      title="设置"
      eyebrow="棱镜宝书 · 配置中心"
      description="让记忆按你的方式运转。管理模型、摘要与召回，再按需调整高级选项。"
    >
      <template #actions>
        <div class="bbs-ver-row">
          <span class="bbs-ver" :title="INTERNAL_UPDATE_NOTICE">v{{ updateState.current || '—' }} · 内部版</span>
          <button
            v-if="updateState.available"
            class="bbs-btn bbs-btn-primary bbs-btn-sm"
            type="button"
            :disabled="updateState.updating"
            :title="'更新到 v' + updateState.latest"
            @click="openUpdateConfirm"
          >{{ updateState.updating ? '更新中…' : '更新' }}</button>
        </div>
      </template>
    </PageHeader>

    <div class="prism-overview" aria-label="当前配置概览">
      <div class="bbs-master" :class="{ 'is-off': !apiSettings.enabled }">
        <span class="prism-engine-icon" aria-hidden="true"><Icon name="sparkles" /></span>
        <div class="bbs-master-text">
          <span class="prism-eyebrow">记忆引擎</span>
          <h3 class="bbs-master-title">{{ apiSettings.enabled ? '已启用，让故事继续被记住' : '已停用，已有记忆仍然保留' }}</h3>
          <p class="prism-master-description">{{ apiSettings.enabled ? '按下方配置执行注入、摘要、总结与旧楼隐藏。' : '暂停注入、摘要、总结与旧楼隐藏；可继续编辑配置。' }}</p>
        </div>
        <div class="prism-master-control">
          <span class="prism-state" :class="{ 'is-muted': !apiSettings.enabled }">{{ apiSettings.enabled ? '已启用' : '已停用' }}</span>
          <button
            type="button"
            role="switch"
            class="bbs-toggle"
            :class="{ 'is-on': apiSettings.enabled }"
            :aria-checked="apiSettings.enabled"
            :aria-label="apiSettings.enabled ? '停用棱镜宝书记忆引擎' : '启用棱镜宝书记忆引擎'"
            :title="apiSettings.enabled ? '停用棱镜宝书记忆引擎' : '启用棱镜宝书记忆引擎'"
            @click="apiSettings.enabled = !apiSettings.enabled"
          ><span class="bbs-toggle-knob"></span></button>
        </div>
      </div>
      <details class="prism-config-details">
        <summary>配置概览 <span>查看渠道、自动摘要与召回状态</span></summary>
      <dl class="prism-status-grid">
        <div class="prism-status-item">
          <dt><Icon name="plug" /> 任务渠道</dt>
          <dd><strong>{{ apiSettings.channels.length }} 个副 API 渠道</strong><span>摘要：{{ assignedChannelName(apiSettings.assignments.summary) }}<br />总结：{{ assignedChannelName(apiSettings.assignments.resummary) }}</span></dd>
        </div>
        <div class="prism-status-item">
          <dt><Icon name="summary" /> 自动摘要</dt>
          <dd><strong>{{ !apiSettings.enabled ? '随引擎暂停' : apiSettings.autoSummaryEnabled ? '已开启' : '未开启' }}</strong><span>配置{{ apiSettings.autoSummaryEnabled ? '开启' : '关闭' }} · 保留最近 {{ apiSettings.keepRecent }} 条 AI 全文</span></dd>
        </div>
        <div class="prism-status-item">
          <dt><Icon name="vars" /> 向量记忆</dt>
          <dd><strong>{{ !apiSettings.enabled ? '随引擎暂停' : apiSettings.vector.enabled ? '已开启' : '未开启' }}</strong><span>配置{{ apiSettings.vector.enabled ? '开启' : '关闭' }} · {{ apiSettings.vector.embedding.model || '尚未填写向量模型' }}</span></dd>
        </div>
        <div class="prism-status-item">
          <dt><Icon name="sun" /> 界面与模板</dt>
          <dd><strong>{{ currentThemeLabel }}主题</strong><span>{{ customPromptCount }} 项自定义提示词 · {{ apiSettings.summaryOnlyMode ? '仅注入剧情摘要' : '按配置注入状态' }}</span></dd>
        </div>
      </dl>
      <p class="prism-overview-note">以上为当前配置，不代表 API 连接测试结果。普通设置直接修改；渠道与提示词在编辑窗口点「完成」后写回。</p>
      </details>
    </div>

    <div class="prism-settings-layout">
      <nav class="prism-settings-nav" aria-label="设置分组目录">
        <span class="prism-nav-label">设置目录</span>
        <button v-for="group in SETTINGS_GROUPS" :key="group.id" type="button" :aria-controls="'prism-settings-' + group.id" @click="goToSettingsGroup(group.id)">
          <Icon :name="group.icon" />
          <span><strong>{{ group.label }}</strong><small>{{ group.hint }}</small></span>
          <Icon name="chevron" class="prism-nav-arrow" />
        </button>
      </nav>
      <div class="bbs-sections">
        <section class="prism-settings-group prism-group-common" aria-labelledby="prism-settings-common">
          <header class="prism-group-head">
            <span class="prism-group-number" aria-hidden="true">01</span>
            <div><h2 id="prism-settings-common" tabindex="-1">常用设置</h2><p>先选择摘要与总结使用的渠道，再调整记忆节奏和界面偏好。</p></div>
            <span class="prism-group-tag">日常配置</span>
          </header>
          <div class="prism-group-cards">
      <Collapsible class="prism-settings-card" title="副 API" :open="true">
        <p class="prism-card-intro">为摘要、总结分别指派渠道；选择「跟随主 API」时沿用酒馆主 API。添加后可随时点击渠道编辑或测试。</p>
        <!-- 任务指派 -->
        <div class="bbs-field bbs-assign">
          <div class="bbs-assign-row">
            <span class="bbs-field-label">摘要使用</span>
            <BbsSelect v-model="apiSettings.assignments.summary" :options="channelOptions" class="bbs-assign-select" aria-label="摘要使用的渠道" />
          </div>
          <div class="bbs-assign-row">
            <span class="bbs-field-label">总结使用</span>
            <BbsSelect v-model="apiSettings.assignments.resummary" :options="channelOptions" class="bbs-assign-select" aria-label="总结使用的渠道" />
          </div>
        </div>
        <p class="bbs-field-hint">推荐使用DeepSeek或豆包，不推荐Gemini，甲太厚</p>

        <hr class="bbs-rule" />

        <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表单平铺 -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">渠道</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addChannel('api')">
            <Icon name="plus" /> 添加渠道
          </button>
        </div>

        <ul v-if="apiSettings.channels.length" class="bbs-channel-list">
          <li v-for="ch in apiSettings.channels" :key="ch.id" class="bbs-channel-item">
            <button class="bbs-channel-open" type="button" :title="'编辑渠道：' + (ch.name || '未命名渠道')" @click="openChannel(ch.id)">
              <span class="bbs-channel-item-name">{{ ch.name || '未命名渠道' }}</span>
              <span class="bbs-channel-item-model" :title="ch.model || '未设模型'">{{ ch.model || '未设模型' }}</span>
              <Icon name="edit" class="prism-channel-edit" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">还没有渠道。点「添加渠道」配置摘要/总结要用的 API。</p>
      </Collapsible>

      <Collapsible class="prism-settings-card" title="基本设置" :open="true">
        <p class="prism-card-intro">主题、导航与入口偏好。全部沿用现有设置，按自己的阅读习惯调整。</p>
        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">主题</span>
          </div>
          <div class="bbs-segmented bbs-segmented-wrap">
            <button
              v-for="t in THEMES"
              :key="t.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.theme === t.value }"
              :aria-pressed="ui.theme === t.value"
              @click="ui.theme = t.value"
            >
              <Icon :name="t.icon" />
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">导航位置</span>
          </div>
          <div class="bbs-segmented">
            <button
              v-for="n in navOptions"
              :key="n.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.navPosition === n.value }"
              :aria-pressed="ui.navPosition === n.value"
              @click="ui.navPosition = n.value"
            >
              {{ n.label }}
            </button>
          </div>
        </div>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">移动端点当前页导航关窗</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">移动端再点一下当前所在页的导航按钮即可关闭整个窗口,省得去够右上角的 ×。怕误触可关。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">在 ST 顶栏显示按钮</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">在酒馆顶部导航栏(用户设定管理左侧)加一个快速打开棱镜宝书的按钮,免去每次点左下角魔杖。左下角魔杖入口照旧保留。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">在聊天框上方显示按钮</span>
          <input v-model="ui.showQuickReply" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">在输入框上方(与快速回复同位)加一个「棱镜宝书」按钮,跟随酒馆主题美化。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">启用楼层界面</span>
          <input v-model="ui.showFloorPanel" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">在每条 AI 楼层下方加一个界面:查看该楼摘要与数据变动,并可一键标记「番外」。标为番外的楼层被记忆系统彻底忽略(不摘要、不总结、不注入),适合小剧场/番外篇;取消番外即恢复。</p>

        <!-- 屏幕悬浮球:配置项多,收进可收缩小分组 -->
        <Collapsible title="屏幕悬浮球" :open="false">
          <label class="bbs-switch-row">
            <span class="bbs-field-label">显示屏幕悬浮球</span>
            <input v-model="ui.showOrb" type="checkbox" class="bbs-checkbox" />
          </label>
          <p class="bbs-field-hint">在屏幕边缘挂一枚可拖动的悬浮球,点击即开棱镜宝书。拖到中间可常驻悬浮,拖近左右边缘则吸附贴边。</p>

          <!-- 形状:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">形状</span>
            </div>
            <div class="bbs-segmented">
              <button
                v-for="s in ORB_SHAPES"
                :key="s.value"
                type="button"
                class="bbs-seg"
                :class="{ 'is-on': ui.orbShape === s.value }"
                :aria-pressed="ui.orbShape === s.value"
                @click="ui.orbShape = s.value"
              >
                {{ s.label }}
              </button>
            </div>
          </div>

          <!-- 静止透明度:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">静止透明度</span>
              <span class="bbs-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input v-model.number="ui.orbOpacity" type="range" min="20" max="100" step="1" class="bbs-range" />
            <p class="bbs-field-hint">悬浮球静止时的不透明度;鼠标悬停 / 拖动时一律全显。</p>
          </div>

          <!-- 大小:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">大小</span>
              <span class="bbs-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input v-model.number="ui.orbSize" type="range" min="32" max="80" step="1" class="bbs-range" />
          </div>

          <!-- 图标:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-orb-config">
            <div class="bbs-orb-preview" :class="[`shape-${ui.orbShape}`, { 'has-image': !!ui.orbImage }]">
              <img v-if="ui.orbImage" :src="ui.orbImage" alt="悬浮球图标预览" />
              <Icon v-else name="bookmark" />
            </div>
            <div class="bbs-orb-config-actions">
              <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="orbUploading" @click="pickOrbImage">
                {{ orbUploading ? '上传中…' : ui.orbImage ? '更换图标' : '上传图标' }}
              </button>
              <button v-if="ui.orbImage" type="button" class="bbs-btn bbs-btn-sm" @click="resetOrbImage">恢复默认</button>
            </div>
            <input ref="orbFileInput" type="file" accept="image/*" hidden @change="onOrbFileChange" />
          </div>
          <p v-if="ui.showOrb" class="bbs-field-hint">支持静态图与 GIF 动图(GIF 保留动画,≤2MB)。图标上传到酒馆服务器、跨设备同步;留空则用默认书签图标。</p>
        </Collapsible>
      </Collapsible>

      <Collapsible class="prism-settings-card prism-card-wide" title="摘要设置" :open="true">
        <p class="prism-card-intro">控制全文保留、分层压缩与失败重试。下方参数沿用现有含义，不因界面改版改变。</p>
        <label class="bbs-switch-row">
          <span class="bbs-field-label">启用自动摘要</span>
          <input v-model="apiSettings.autoSummaryEnabled" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">开启后自动摘要并隐藏旧楼,同时启用正文时间标签(剧情时间锚点)与积压拦截(漏摘时拦截发送、提示补摘)。</p>
        <div class="bbs-num-row">
          <span class="bbs-field-label">字数档位</span>
          <BbsSelect v-model="apiSettings.verbosity" :options="VERBOSITY_OPTIONS" class="bbs-select-narrow" aria-label="字数档位" />
        </div>
        <p class="bbs-field-hint">一键调节摘要/总结/二次总结的目标字数。详细=信息全(摘要150-300、总结300-500字)；精简=省token(摘要80-150、总结150-300字)。仅影响内置提示词,自定义模板不受影响。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">保留最近 AI 消息数</span>
          <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">保留多少条 AI 消息发送全文,超出部分自动隐藏并发送摘要。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">每次总结 AI 消息数</span>
          <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">每次总结多少条摘要,不计算 user 楼层,0 为关闭自动总结。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">总结时保留摘要数</span>
          <input v-model.number="apiSettings.leafKeepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">总结时在末尾保留这么多条摘要不压缩,让隐藏区始终留一截细节、避免总结后信息断崖。例:每次总结 12、这里填 3,则攒够 15 条才总结,压最旧 12 条,留最新 3 条摘要。0 为攒够即全压(旧行为),默认 3。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">二次总结</span>
          <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">L1 总结达到多少条后压成一条 L2,0 为关闭。默认 7。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">高层总结</span>
          <input v-model.number="apiSettings.higherResummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">L2 及以上总结达到多少条后再压一层。高层正文更长,建议使用较小阈值；0 为关闭,默认 3。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">附带近期已完成计划</span>
          <input v-model.number="apiSettings.recentResolvedPlansCount" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">在状态快照里附带「已完成的计划/悬念」,提醒 AI 别把刚了结的事又当未完成去推进或重复记录;主模型注入与摘要副API同时附带。计划、悬念各取最近这么多条(如填 5 = 最多计划 5 + 悬念 5)。0 为不附带,默认 5。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">失败重试次数</span>
          <input v-model.number="apiSettings.summaryMaxRetries" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">摘要/总结请求失败(报错或返回内容无法解析)时最多额外重试几次,0 为不重试。默认 1。</p>
        <p class="bbs-field-hint">批量补摘按楼序逐楼生成完整记忆，每楼保存人物、物品与计划后再处理下一楼；失败时停止，可在当前楼完成后取消。内置摘要上限：详细 300、精简 150 字符（含标点）；超长会进入上述有限重试，失败保留旧摘要。</p>
      </Collapsible>
          </div>
        </section>

        <section class="prism-settings-group prism-group-memory" aria-labelledby="prism-settings-memory">
          <header class="prism-group-head">
            <span class="prism-group-number" aria-hidden="true">02</span>
            <div><h2 id="prism-settings-memory" tabindex="-1">记忆与召回</h2><p>决定主模型能看到什么，以及如何从旧记忆中找回相关线索。</p></div>
            <span class="prism-group-tag">按需开启</span>
          </header>
          <div class="prism-group-cards">
      <Collapsible class="prism-settings-card" title="注入设置" :open="true">
        <p class="prism-card-intro">管理主对话的记忆预算、时间标签和状态内容；开关依赖关系保持不变。</p>
        <p v-if="apiSettings.autoSummaryEnabled && !fitTimeTagPrompt(timeTagPrompt())" class="bbs-field-hint">⚠ 当前时间指令超过预算份额,已整块停用。请提高预算或缩短自定义时间指令。</p>
        <label class="bbs-switch-row"><span class="bbs-field-label">记忆注入估算预算</span><input v-model.number="apiSettings.memoryBudgetTokens" class="bbs-input" type="number" min="0" max="50000" step="500" /></label>
        <p class="bbs-field-hint">默认 6000,0 为不限;非零最少按 2000 计算。按 UTF-8 字节估算,不等于真实模型 token。历史/状态/时间指令/召回分别占 45%/35%/5%/15%,未用份额不挪用。超额只省略完整条目,不删除存档;过长时间指令整块停用。预算不含聊天正文、角色卡及其他插件。旧向量召回槽在修改预算后清空,下次生成重算。</p>
        <p class="bbs-field-hint">选择哪些状态块注入主对话(生成正文的请求)。这些开关<strong>只影响主模型看到的内容</strong>:副 API 摘要始终能看到全量状态、照常记录,关闭某项不会导致重复记录。时间/地点、计划/悬念与自定义变量保持常驻,不在此处开关。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">仅注入剧情摘要</span>
          <input v-model="apiSettings.summaryOnlyMode" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">兼容角色卡自带的变量系统。开启后仍会分析、保存并在棱镜宝书内展示物品、角色、场景、计划和变量,但不再把当前状态注入主模型(下方各块开关也随之不生效),也不再向后续楼层正文写入物品/变量变动旁注。已有楼层中的旁注不会主动清理;场景页的「前往」功能不受影响。</p>

        <hr class="bbs-rule" />

        <label class="bbs-switch-row">
          <span class="bbs-field-label">眼下局势</span>
          <input v-model="apiSettings.injection.sceneFocus" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">当前互动局势卡:局面、在场人、当前焦点、互动张力与即将发生之事,衔接当下场面。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">生活档案</span>
          <input v-model="apiSettings.injection.lifeDetails" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">控制主角及主要角色生活档案的注入。记录始终开启(AI 照常积累档案,可在角色页管理);关闭后只是不再发给主模型,重开即可恢复注入。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">主角信息</span>
          <input v-model="apiSettings.injection.protagonist" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">主角当前状态:性别、年龄、身份、外貌、着装、状态。自包含,不依赖场景信息。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">场景信息</span>
          <input v-model="apiSettings.injection.scenes" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode" />
        </label>
        <p class="bbs-field-hint">当前地点与祖先链(详细)+ 其他已知地点(仅名称)。<strong>NPC 名册与物品信息的在场/可达判定都依赖场景树,关闭此项后这两项也随之不注入。</strong></p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">NPC 名册</span>
          <input v-model="apiSettings.injection.npcs" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
        </label>
        <p class="bbs-field-hint">在场角色全量、同区域从简、不在场仅名与身份;依赖场景信息。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">角色好感估计</span>
          <input v-model="apiSettings.injection.npcAffinity" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.npcs" />
        </label>
        <p class="bbs-field-hint">NPC 名册里的五档好感估计(内心好感/外在态度/说明)。记录与角色页展示始终开启;关闭后名册照发、只是不附带好感——适合角色卡自带好感系统、不想两套并行的场合。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">物品信息</span>
          <input v-model="apiSettings.injection.items" type="checkbox" class="bbs-checkbox" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
        </label>
        <p class="bbs-field-hint">随身/可达物品发全量,他处寄存仅名与数量;依赖场景信息。</p>
      </Collapsible>

      <Collapsible class="prism-settings-card" title="向量记忆" :open="true">
        <p class="prism-card-intro">启用后配置三个模型角色。端点标题下显示已填模型；连接情况以实际操作结果为准。</p>
        <label class="bbs-switch-row bbs-vec-enable">
          <span class="bbs-field-label">启用向量记忆</span>
          <input v-model="apiSettings.vector.enabled" type="checkbox" class="bbs-checkbox" />
        </label>

        <hr class="bbs-rule bbs-vec-enable-rule" />

        <!-- 三个端点:Embedding 必填;Rerank/Query 地址留空 = 整体复用 Embedding。
             卡片自身可折叠(点标题栏),无额外外框;副标显当前模型,收起也看得出配没配。 -->
        <div
          v-for="role in VECTOR_ROLES"
          :key="role.key"
          class="bbs-vec-ep"
          :class="{ 'is-disabled': !apiSettings.vector.enabled, 'is-collapsed': !vecEpOpen[role.key] }"
        >
          <button
            type="button"
            class="bbs-vec-head bbs-vec-toggle"
            :aria-expanded="vecEpOpen[role.key]"
            @click="vecEpOpen[role.key] = !vecEpOpen[role.key]"
          >
            <span class="prism-endpoint-heading">
              <span class="bbs-field-label">{{ role.label }}</span>
              <span class="prism-endpoint-model">{{ apiSettings.vector[role.key].model || '尚未填写模型' }}</span>
            </span>
            <Icon name="chevron" class="bbs-vec-chevron" />
          </button>

          <div class="bbs-vec-ep-outer" :inert="!vecEpOpen[role.key]" :aria-hidden="!vecEpOpen[role.key]">
            <div class="bbs-vec-ep-inner">
          <div class="bbs-vec-ep-body">
          <p v-if="role.key !== 'embedding'" class="bbs-field-hint">地址 / 密钥留空即复用 Embedding;模型仍需各自填写。</p>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">API 地址</span>
            <input
              v-model="apiSettings.vector[role.key].url"
              class="bbs-input"
              :placeholder="role.key === 'embedding' ? '如 https://api.openai.com/v1' : '留空 = 复用 Embedding 的地址'"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">API 密钥</span>
            <div class="bbs-model-row">
              <input
                v-model="apiSettings.vector[role.key].key"
                class="bbs-input"
                :type="vecShowKey[role.key] ? 'text' : 'password'"
                :placeholder="role.key === 'embedding' ? 'API 密钥' : '留空 = 复用 Embedding 的密钥'"
                :disabled="!apiSettings.vector.enabled"
              />
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecShowKey[role.key] ? '隐藏密钥' : '显示密钥'" :aria-label="vecShowKey[role.key] ? '隐藏密钥' : '显示密钥'"
                @click="vecShowKey[role.key] = !vecShowKey[role.key]"
              >
                <Icon :name="vecShowKey[role.key] ? 'eye-off' : 'eye'" />
              </button>
            </div>
          </label>

          <!-- 模型:三个角色各自独立(embedding/rerank/query 模型本就不同),都要单独选,从不复用。
               拉取走「该角色的地址/密钥」,留空则自动用 Embedding 的地址/密钥去拉。 -->
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">模型</span>
            <div class="bbs-model-row">
              <div class="bbs-combo">
                <input
                  v-model="apiSettings.vector[role.key].model"
                  class="bbs-input"
                  :placeholder="(vecModels[role.key]?.length) ? '搜索或输入模型名…' : '模型名,或点右侧拉取'"
                  :disabled="!apiSettings.vector.enabled"
                  @focus="openVecModelMenu(role.key)"
                  @input="vecModelQuery = apiSettings.vector[role.key].model; vecModelMenuOpen = role.key"
                  @blur="closeVecModelMenuSoon"
                />
                <span
                  v-if="vecModels[role.key]?.length"
                  class="bbs-combo-caret"
                  :class="{ 'is-open': vecModelMenuOpen === role.key }"
                  aria-hidden="true"
                />
                <ul v-if="vecModelMenuOpen === role.key && vecModels[role.key]?.length" class="bbs-combo-menu">
                  <li v-if="!filteredVecModels(role.key).length" class="bbs-combo-empty">无匹配模型</li>
                  <li
                    v-for="m in filteredVecModels(role.key)"
                    :key="m"
                    class="bbs-combo-item"
                    :class="{ 'is-active': m === apiSettings.vector[role.key].model }"
                    @mousedown.prevent="pickVecModel(role.key, m)"
                  >
                    {{ m }}
                  </li>
                </ul>
              </div>
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecLoadingModels[role.key] ? '拉取中…' : '拉取模型'" :aria-label="vecLoadingModels[role.key] ? '拉取中…' : '拉取模型'"
                :disabled="!apiSettings.vector.enabled || vecLoadingModels[role.key]"
                @click="pullVecModels(role.key)"
              >
                <Icon name="refresh" />
              </button>
            </div>
          </label>
          <p v-if="vecModelMsg[role.key]" class="bbs-field-hint">{{ vecModelMsg[role.key] }}</p>

          <!-- 超时/重试(+ Query 重写的最大 token):各角色独立(默认 embedding 10s / rerank 20s / query 90s),不随地址复用回落。
               grid auto-fit:空间够就一行排开,不够自动换行。 -->
          <div class="bbs-vec-io">
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">超时(秒)</span>
              <input
                v-model.number="apiSettings.vector[role.key].timeoutSec"
                class="bbs-input bbs-num-sm"
                type="number"
                min="1"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">失败重试次数</span>
              <input
                v-model.number="apiSettings.vector[role.key].retries"
                class="bbs-input bbs-num-sm"
                type="number"
                min="0"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label v-if="role.key === 'queryRewrite'" class="bbs-vec-io-item">
              <span class="bbs-modal-label">最大输出 token</span>
              <input
                v-model.number="apiSettings.vector.queryRewriteMaxTokens"
                class="bbs-input bbs-num-sm"
                type="number"
                min="256"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
          </div>

          <!-- 破限:仅 Query 重写(三角色里只有它生成文本)。 -->
          <template v-if="role.key === 'queryRewrite'">
            <label class="bbs-switch-row">
              <span class="bbs-field-label">附加任务说明</span>
              <input
                v-model="apiSettings.vector.queryRewriteJailbreak"
                type="checkbox"
                class="bbs-checkbox"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <p class="bbs-field-hint">
              使用「提示词工作台」中的任务说明模式;禁用或自定义空白时不附加。无需为了检索重写把输出上限设成超大值。
            </p>
          </template>
          </div>
            </div>
          </div>
        </div>

        <hr class="bbs-rule" />

        <!-- 召回参数:机制说明 + 进阶旋钮整体折叠,默认收起,不淹没上方端点配置。 -->
        <Collapsible title="召回参数" :open="false">
          <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
            <p class="bbs-field-hint">
              先对全部向量索引算 embedding 相似度,取得分最高的若干条进入 rerank;rerank 打分后分两档:
              得分高的发原文全文,稍低但仍过 embedding 阈值的发摘要;两档合计不超过「最终召回条数」。
            </p>

            <p class="bbs-field-hint">
              生成前用小模型(上方「Query 重写」)把当前剧情重写成多条检索 query,多路召回更全面。
              <strong>查询重写为召回必经步骤,须配好「Query 重写」模型;未配或重写失败则本回合不召回。</strong>
              每回合多一次小模型请求(略增延迟)。
            </p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">召回注入深度</span>
            <input
              v-model.number="apiSettings.vector.recall.injectionDepth"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              step="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">召回内容注入到聊天中的深度。0 = D0,最贴近最新用户输入;数字越大越靠前。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Rerank 候选数</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankCandidates"
              class="bbs-input bbs-num"
              type="number"
              min="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">按 embedding 相似度取前 N 条进入 rerank 精排(越大越准但越慢)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Embedding 阈值</span>
            <input
              v-model.number="apiSettings.vector.recall.embeddingThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">摘要档准入门槛:embedding 相似度低于此的内容连摘要都不召回(0~1)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Rerank 阈值</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">rerank 得分 ≥ 此值的发原文全文,低于此但过 embedding 阈值的退为发摘要(0~1)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">召回全文数</span>
            <input
              v-model.number="apiSettings.vector.recall.fullTextCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">全文档最多取几条发原文(其余即便过 rerank 阈值也退为摘要)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">最终召回条数</span>
            <input
              v-model.number="apiSettings.vector.recall.finalRecallCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">召回总条数上限(全文 + 摘要合计);全文不够用摘要补,补不满也无妨。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">起召 AI 楼数</span>
            <input
              v-model.number="apiSettings.vector.recall.minAiFloors"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">
            当前聊天 AI 消息数少于此值时不触发召回(0=不限制)。早期剧情旧记忆少,跳过可省额度/延迟。
            另:当所有消息都还在滑动窗口内全文发送时也会自动跳过(无窗口外旧楼可召);「带数据建新对话」的旧档不受此限,始终召回。
          </p>
          </div>
        </Collapsible>

        <hr class="bbs-rule" />

        <!-- 索引维护:把当前聊天的叶子摘要补建/对账进向量库 -->
        <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
          <div class="bbs-vec-head">
            <span class="bbs-field-label">索引维护</span>
            <span
              v-if="vecBackend !== 'unknown'"
              class="bbs-vec-backend"
              :class="vecBackend === 'backend' ? 'is-backend' : 'is-local'"
            >
              {{ vecBackend === 'backend' ? '柏宝库' : '前端' }}
            </span>
          </div>
          <p class="bbs-field-hint">
            正常情况下叶子摘要会随生成自动索引;若中途才开启向量记忆,可手动把当前聊天已有的摘要补建进向量库。
            清空只删当前聊天自己的索引,不动「带数据建新对话」继承来的旧档快照。
          </p>
          <p v-if="vecBackend === 'local'" class="bbs-field-hint">
            本地模式:索引存浏览器,仅当前聊天召回,不跨聊天 / 不跨设备。安装柏宝库后端后可恢复完整能力。
          </p>
          <div class="bbs-vec-index-actions">
            <button
              class="bbs-btn bbs-btn-sm"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doRebuildIndex"
            >
              {{ vecIndexing ? '索引中…' : '重建当前聊天向量索引' }}
            </button>
            <button
              class="bbs-btn bbs-btn-sm bbs-btn-danger"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doClearIndex"
              @blur="vecClearConfirm = false"
            >
              <Icon name="trash" />
              {{ vecClearing ? '清空中…' : vecClearConfirm ? '再点确认清空' : '清空当前聊天索引' }}
            </button>
          </div>
          <p v-if="vecIndexMsg" class="bbs-field-hint">{{ vecIndexMsg }}</p>
        </div>

        <hr class="bbs-rule" />

        <!-- 上次召回详情:把上一次召回各阶段的中间结果可视化,便于调参/排障(reactive 自动刷新) -->
        <Collapsible title="上次召回详情" :open="false">
          <p v-if="!recallDebug.at" class="bbs-field-hint">
            尚无召回记录。配好向量渠道后发一条消息触发召回,这里会显示重写 / 检索 / 重排 / 注入各阶段结果。
          </p>
          <div v-else class="bbs-dbg">
            <!-- 状态横幅:左侧圆点按语气配色,右侧时间 -->
            <div class="bbs-dbg-banner" :class="`is-${recallStatusKind}`">
              <span class="bbs-dbg-dot" aria-hidden="true"></span>
              <span class="bbs-dbg-status-text">{{ recallDebug.status }}</span>
              <span class="bbs-dbg-time">{{ fmtRecallTime(recallDebug.at) }}</span>
            </div>

            <!-- 四阶段各自可折叠,默认收起;标题带计数 -->
            <Collapsible :title="`1 · 查询重写 · ${recallDebug.queries.length} Q`" :open="false">
              <p v-if="recallDebug.intent" class="bbs-dbg-intent">
                <span class="bbs-dbg-tag">INTENT</span><span class="bbs-dbg-intent-text">{{ recallDebug.intent }}</span>
              </p>
              <ul v-if="recallDebug.queries.length" class="bbs-dbg-qlist">
                <li v-for="(q, i) in recallDebug.queries" :key="i" class="bbs-dbg-qitem">
                  <span class="bbs-dbg-qno">Q{{ i + 1 }}</span><span class="bbs-dbg-qtext">{{ q }}</span>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">无</p>
            </Collapsible>

            <Collapsible :title="`2 · Embedding 检索 · ${recallDebug.embedding.length} 条`" :open="false">
              <ul v-if="recallDebug.embedding.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.embedding" :key="i" class="bbs-dbg-card">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-src" :title="`来源 ${qLabel(h.queryIndex)}`">{{ qLabel(h.queryIndex) }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === '旧档' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.similarity.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar"><i :style="{ width: scorePct(h.similarity) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">无</p>
            </Collapsible>

            <Collapsible :title="`3 · Rerank 分档 · ${recallDebug.rerank.length} 条`" :open="false">
              <ul v-if="recallDebug.rerank.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.rerank" :key="i" class="bbs-dbg-card" :class="{ 'is-dropped': h.tier === 'drop' }">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-tier" :class="`is-${h.tier}`">{{ TIER_LABEL[h.tier] }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === '旧档' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.rerankScore.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar" :class="`tier-${h.tier}`"><i :style="{ width: scorePct(h.rerankScore) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">无(rerank 未执行或无候选)</p>
            </Collapsible>

            <Collapsible title="4 · 最终注入" :open="false">
              <pre v-if="recallDebug.injectedText" class="bbs-dbg-pre">{{ recallDebug.injectedText }}</pre>
              <p v-else class="bbs-dbg-empty">本回合未注入。</p>
            </Collapsible>
          </div>
        </Collapsible>
      </Collapsible>
          </div>
        </section>

        <section class="prism-settings-group prism-group-prompts" aria-labelledby="prism-settings-prompts">
          <header class="prism-group-head">
            <span class="prism-group-number" aria-hidden="true">03</span>
            <div><h2 id="prism-settings-prompts" tabindex="-1">提示词工作台</h2><p>保留内置模板，也支持逐项定制。恢复默认仅修改草稿，点「完成」后生效。</p></div>
            <span class="prism-group-tag">高级 · 模板</span>
          </header>
          <div class="prism-group-cards">
      <Collapsible class="prism-settings-card" title="自定义提示词" :open="true">
        <p class="prism-card-intro">点击任意模板进入编辑器，可插入宏、取消修改或恢复内置默认。</p>
        <label class="bbs-switch-row"><span class="bbs-field-label">任务说明模式</span>
          <select v-model="apiSettings.taskContextMode" class="bbs-input"><option value="default">内置中性说明</option><option value="custom">自定义(允许空白)</option><option value="disabled">禁用</option></select>
        </label>
        <p class="bbs-field-hint">旧自定义文本会保留。保存自定义任务说明会切换到自定义模式;恢复默认并保存会使用新版中性说明。禁用只关闭附加说明,不关闭必要的输出格式规则。</p>
        <ul class="bbs-prompt-list">
          <li v-for="m in PROMPT_METAS" :key="m.key" class="bbs-prompt-item">
            <button class="bbs-prompt-open" type="button" @click="openPrompt(m)">
              <span class="bbs-prompt-name">{{ m.label }}</span>
              <span class="bbs-prompt-state" :class="{ 'is-custom': isCustom(m.key) }">
                {{ m.key === 'jailbreak' && apiSettings.taskContextMode === 'disabled' ? '已禁用' : isCustom(m.key) ? '已自定义' : '默认' }}
              </span>
              <Icon name="edit" class="bbs-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>
          </div>
        </section>

        <section class="prism-settings-group prism-group-advanced" aria-labelledby="prism-settings-advanced">
          <header class="prism-group-head">
            <span class="prism-group-number" aria-hidden="true">04</span>
            <div><h2 id="prism-settings-advanced" tabindex="-1">高级过滤</h2><p>只在需要时调整排除范围与清洗规则；展开对应分组即可编辑。</p></div>
            <span class="prism-group-tag">高级 · 输入范围</span>
          </header>
          <div class="prism-group-cards">
      <Collapsible class="prism-settings-card" title="排除角色" :open="false">
        <p class="bbs-field-hint">勾选的角色名(含同名的重名卡)所在聊天里,棱镜宝书的所有功能都不生效——不摘要、不隐藏、不注入、不拦截。适合工具性、不需要记忆的角色。</p>
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">
            已排除 {{ apiSettings.excludedChars.length }} 个
          </span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExclude">
            <Icon name="edit" /> 编辑名单
          </button>
        </div>
        <ul v-if="apiSettings.excludedChars.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedChars" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="移出名单" aria-label="移出名单" @click="toggleExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">名单为空,所有角色都启用记忆系统。</p>
      </Collapsible>

      <Collapsible class="prism-settings-card" title="排除世界书内容" :open="false">
        <p class="bbs-field-hint">
          摘要 / 总结时会激活世界书当参考。这里可剔除对剧情记忆无用的条目——如全局挂载的附加知识书、
          规则说明等,既省 token 也避免干扰。仅影响摘要副 API,不改变你主对话里的世界书。
        </p>

        <!-- 渲染世界书模板:配合「提示词模板(ST-Prompt-Template)」等插件 -->
        <label class="bbs-switch-row">
          <span class="bbs-field-label">渲染世界书模板</span>
          <input v-model="apiSettings.renderWorldInfoTemplates" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">
          开启后会兼容提示词模板（ejs）的世界书条目
        </p>

        <hr class="bbs-rule" />

        <!-- 整本排除:复刻排除角色的搜索+勾选弹窗 -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">整本排除 · 已选 {{ apiSettings.excludedWorldNames.length }} 本</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExcludeWorld">
            <Icon name="edit" /> 编辑名单
          </button>
        </div>
        <ul v-if="apiSettings.excludedWorldNames.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedWorldNames" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="移出名单" aria-label="移出名单" @click="toggleWorldExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">未排除任何世界书,全部激活条目都会进摘要参考。</p>

        <hr class="bbs-rule" />

        <!-- 按条目名过滤:复刻清洗标签的输入框 + chips -->
        <div class="bbs-field-head">
          <span class="bbs-field-label">按条目名过滤</span>
        </div>
        <p class="bbs-field-hint">
          填条目备注名(comment)即按<strong>包含</strong>匹配(不分大小写)——如填 <code>附加</code> 可命中「附加设定」。
          也支持正则:<code>^规则</code> 表示以「规则」开头。对上面未整本排除的世界书生效。
          默认预置一条 <code>\[mvu[\s\S]*?\]</code>,过滤变量框架 MVU 的机制条目;不需要可直接删。
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="wiPatternDraft"
            class="bbs-input"
            type="text"
            placeholder="条目名或正则,如 附加 或 ^规则"
            @keydown.enter.prevent="addWiPattern"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addWiPattern">
            <Icon name="plus" /> 添加
          </button>
        </div>
        <ul v-if="apiSettings.excludedWorldInfoPatterns.length" class="bbs-exclude-chips">
          <li v-for="pat in apiSettings.excludedWorldInfoPatterns" :key="pat" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ pat }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="移除" aria-label="移除" @click="removeWiPattern(pat)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">暂无条目名规则。</p>
      </Collapsible>

      <Collapsible class="prism-settings-card" title="自定义清洗标签" :open="false">
        <p class="bbs-field-hint">
          正文里若混入其它插件/世界书写的格式块(如状态栏 <code>&lt;snow&gt;…&lt;/snow&gt;</code>),
          可在此填入标签名(只填 <code>snow</code>,不带尖括号),摘要、向量索引与召回时会把整块连内容一并删掉。
          调整后对**召回**即时生效(向量库存原文、召回再清洗),无需重建索引。
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbs-input"
            type="text"
            placeholder="标签名,如 snow"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> 添加
          </button>
        </div>
        <ul v-if="apiSettings.customStripTags.length" class="bbs-exclude-chips">
          <li v-for="tag in apiSettings.customStripTags" :key="tag" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="bbs-exclude-chip-x" type="button" title="移除" aria-label="移除" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">暂无自定义标签。仅内置清洗(思维链、注释、物品旁注等)生效。</p>
      </Collapsible>
          </div>
        </section>

        <section class="prism-settings-group prism-group-data" aria-labelledby="prism-settings-data">
          <header class="prism-group-head">
            <span class="prism-group-number" aria-hidden="true">05</span>
            <div><h2 id="prism-settings-data" tabindex="-1">数据与迁移</h2><p>延续已有记忆、迁入旧版数据，或将记忆接入其他工具。操作前请阅读说明。</p></div>
            <span class="prism-group-tag">维护工具</span>
          </header>
          <div class="prism-group-cards">
      <Collapsible class="prism-settings-card" title="带数据创建新对话" :open="false">
        <p class="bbs-field-hint">
          把当前聊天的「最近全文窗口 + 合并历史摘要 + 当前状态(时间/地点、场景、物品、角色、计划、变量)」打包,创建一个新对话带过去。
          新对话从一片「种子叶子」重放还原状态,旧剧情作为摘要随行;若开了向量记忆,旧聊天会被快照,
          新对话可向量召回它的内容(逐次累加,分支也自动继承)。
        </p>
        <div v-if="carryPlan" class="bbs-field-hint">
          将携带:AI {{ carryPlan.aiCount }} 条 / 实际消息 {{ carryPlan.carryCount }} 条;旧剧情摘要 {{ carryPlan.recapLen > 0 ? '有' : '无' }}。
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="carrying || !carryPlan?.hasData"
          @click="carryConfirmOpen = true"
        >
          {{ carrying ? '创建中…' : '带数据创建新对话' }}
        </button>
        <p v-if="carryMsg" class="bbs-field-hint">{{ carryMsg }}</p>
      </Collapsible>

      <Collapsible class="prism-settings-card" title="从旧版 Horae 迁移" :open="false">
        <p class="bbs-field-hint">
          把当前聊天里旧版 Horae 的摘要、物品、计划迁移过来。需要迁移的聊天各点一次,不会动 Horae 原数据。
        </p>
        <div v-if="migratePlan" class="bbs-field-hint">
          <template v-if="migratePlan.hasData">
            检测到:可建摘要 {{ migratePlan.leafFloors }} 层 / 旧总结 {{ migratePlan.summaryCount }} 条 /
            物品 {{ migratePlan.itemCount }} / 计划悬念 {{ migratePlan.planCount }}。
            <span v-if="migratePlan.willOverwrite">⚠️ 当前聊天已有本插件数据,迁移将覆盖。</span>
          </template>
          <template v-else>未在当前聊天检测到 Horae 旧数据(请先进入含旧数据的聊天)。</template>
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="migrating || !migratePlan?.hasData"
          @click="migrateConfirmOpen = true"
        >
          {{ migrating ? '迁移中…' : '迁移当前聊天的 Horae 数据' }}
        </button>
        <p v-if="migrateMsg" class="bbs-field-hint">{{ migrateMsg }}</p>
      </Collapsible>

      <Collapsible class="prism-settings-card" title="获取数据" :open="false">
        <p class="bbs-field-hint bbs-data-intro">
          宏可用于提示词、变量说明和支持 ST 宏的其他位置。完整接口、命令和返回结构可导出为插件作者文档。
        </p>

        <div class="bbs-data-macros">
          <div v-for="macro in DATA_MACROS" :key="macro.token" class="bbs-data-macro">
            <div class="bbs-data-macro-main">
              <div class="bbs-data-macro-head">
                <span class="bbs-data-macro-title">{{ macro.title }}</span>
                <code class="bbs-data-token">{{ macro.token }}</code>
              </div>
              <p class="bbs-data-desc">{{ macro.desc }}</p>
            </div>
            <button
              class="bbs-icon-mini bbs-data-copy"
              type="button"
              :title="`复制 ${macro.token}`"
              :aria-label="`复制 ${macro.token}`"
              @click="copyDataMacro(macro.token)"
            >
              <Icon name="copy" />
            </button>
          </div>
        </div>

        <div class="bbs-data-export">
          <div class="bbs-data-export-text">
            <span class="bbs-field-label">公共接口文档</span>
            <p class="bbs-data-desc">下载 PUBLIC_API.md,包含 JavaScript API、斜杠命令、宏、返回结构与使用示例。</p>
          </div>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="exportPublicApiDocument">
            <Icon name="download" />
            导出文档
          </button>
        </div>
      </Collapsible>
          </div>
        </section>
      </div>
    </div>
    <p class="prism-settings-footnote">{{ INTERNAL_UPDATE_NOTICE }} 原作：柏柏；本版为棱镜宝书内部维护版。</p>

    <!-- 带数据创建新对话 / Horae 迁移 的确认弹窗 -->
    <ConfirmDialog
      v-model:open="carryConfirmOpen"
      title="带数据创建新对话"
      confirm-text="创建并切入"
      @confirm="runCarryover"
    >
      将基于当前聊天创建一个带数据的新对话并切入。继续吗?
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="migrateConfirmOpen"
      title="从旧版 Horae 迁移"
      confirm-text="开始迁移"
      @confirm="runMigrate"
    >
      {{ migrateConfirmText }}
    </ConfirmDialog>

    <!-- ===== 渠道编辑弹窗 ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑渠道">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑渠道</span>
          <button class="bbs-icon-mini" type="button" title="关闭渠道编辑窗口" aria-label="关闭渠道编辑窗口" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbs-modal-field">
          <span class="bbs-modal-label">渠道名</span>
          <input v-model="editingChannel.name" class="bbs-input" placeholder="渠道名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">API 地址</span>
          <input v-model="editingChannel.url" class="bbs-input" placeholder="如 https://api.openai.com/v1" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">API 密钥</span>
          <div class="bbs-model-row">
            <input
              v-model="editingChannel.key"
              class="bbs-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="API 密钥"
            />
            <button
              class="bbs-icon-mini"
              type="button"
              :title="showKey ? '隐藏密钥' : '显示密钥'" :aria-label="showKey ? '隐藏密钥' : '显示密钥'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">模型</span>
          <div class="bbs-model-row">
            <!-- 可搜索 combobox:已拉取到模型列表时,聚焦弹出过滤菜单;没列表时就是普通输入框 -->
            <div class="bbs-combo">
              <input
                v-model="editingChannel.model"
                class="bbs-input"
                :placeholder="modelList.length ? '搜索或输入模型名…' : '模型名,如 gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- 自绘下拉三角(纯装饰,pointer-events:none → 点击穿透到输入框照常聚焦展开);仅在有可选模型时显示 -->
              <span v-if="modelList.length" class="bbs-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbs-combo-menu">
                <li v-if="!filteredModels.length" class="bbs-combo-empty">无匹配模型</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbs-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbs-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型'" :aria-label="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbs-channel-row">
          <label class="bbs-mini-field">
            <span>温度</span>
            <input v-model.number="editingChannel.temperature" class="bbs-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbs-mini-field">
            <span>最大 token</span>
            <input v-model.number="editingChannel.maxTokens" class="bbs-input" type="number" step="256" min="256" />
          </label>
          <label class="bbs-mini-field">
            <span>超时(秒)</span>
            <input v-model.number="editingChannel.timeoutSec" class="bbs-input" type="number" step="10" min="1" />
          </label>
          <!-- 思考强度:自绘下拉(跟随主题;原生 select 的弹出层由系统渲染,主题管不到)。
               auto 是显式选项,值为空串 = 不发送该参数 -->
          <div class="bbs-mini-field">
            <span>思考强度</span>
            <BbsSelect
              v-model="editingChannel.reasoningEffort"
              :options="REASONING_EFFORT_OPTIONS"
              aria-label="思考强度"
            />
          </div>
        </div>
        <span class="bbs-field-hint">思考强度不知道的就选 auto，DS 系推荐 max</span>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">流式传输</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbs-checkbox" />
        </label>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">发送预填充</span>
          <input v-model="editingChannel.prefill" type="checkbox" class="bbs-checkbox" />
        </label>
        <span class="bbs-field-hint">默认开。若副 API 报错信息里出现 prefill 字样,关掉它即可。</span>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">排除参数</span>
          <input
            v-model="excludeParamsText"
            class="bbs-input"
            type="text"
            placeholder="逗号分隔,如 temperature, max_tokens"
          />
          <span class="bbs-field-hint">这些参数会在发请求前从请求体里删除,用于规避不接受该参数的兼容端点报错。逗号分隔,留空则不排除。</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbs-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbs-modal-foot">
          <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触。
               删除:始终显示文字;测试:PC 显「测试渠道」,移动端只显「测试」(短版,省版面) -->
          <button class="bbs-btn bbs-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" title="测试渠道" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbs-btn-label-full">测试渠道</span><span class="bbs-btn-label-short">测试</span>
          </button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="confirmChannel">完成</button>
        </footer>

        <!-- 删除渠道二次确认:叠在渠道弹窗之上。置于 v-if="editingChannel" 块内,
             渠道为 null 时整体不渲染——既合语义,也让 editingChannel.name 类型收窄。
             ConfirmDialog 自身 teleport + top-layer,放这儿不影响其渲染层级。 -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除渠道"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          确定删除渠道「{{ editingChannel.name || '未命名渠道' }}」吗?此操作不可撤销,已指派该渠道的任务会被清空。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 提示词编辑弹窗 ===== -->
    <ModalMask :open="!!editingPrompt" @close="closePrompt">
      <div v-if="editingPrompt" class="bbs-modal bbs-modal-wide" role="dialog" aria-modal="true" :aria-label="`编辑${editingPrompt.label}`">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑{{ editingPrompt.label }}</span>
          <button class="bbs-icon-mini" type="button" title="关闭提示词编辑窗口" aria-label="关闭提示词编辑窗口" @click="closePrompt"><Icon name="close" /></button>
        </header>

        <p class="bbs-modal-label">{{ editingPrompt.hint }}</p>
        <p class="prism-editor-note">当前为编辑草稿。恢复默认后仍需点「完成」保存；点「取消」不会更改已保存的提示词。</p>

        <!-- 可用宏:点一下插入到光标处 -->
        <div class="bbs-macro-bar">
          <span class="bbs-macro-tip">点击插入宏:</span>
          <button
            v-for="mac in editingPrompt.macros"
            :key="mac.token"
            class="bbs-macro"
            type="button"
            :title="mac.desc"
            @click="insertMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <textarea
          ref="promptArea"
          v-model="promptDraft"
          class="bbs-input bbs-prompt-area"
          :aria-label="editingPrompt.label + '正文'"
          spellcheck="false"
          rows="16"
        ></textarea>

        <footer class="bbs-modal-foot">
          <button class="bbs-btn bbs-btn-danger" type="button" @click="resetPrompt">
            <Icon name="refresh" /> 恢复默认
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" @click="closePrompt">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="savePrompt">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 排除角色弹窗:搜索 + 勾选列表 ===== -->
    <ModalMask :open="excludeOpen" @close="closeExclude">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑排除名单">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">排除角色</span>
          <button class="bbs-icon-mini" type="button" title="关闭角色排除名单" aria-label="关闭角色排除名单" @click="closeExclude"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeSearch"
          class="bbs-input"
          type="search"
          placeholder="搜索角色名…"
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredCharNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isExcluded(name)"
              @change="toggleExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!charNames.length" class="bbs-field-hint">未读取到角色列表。请先在 ST 里加载角色卡。</p>
          <p v-else-if="!filteredCharNames.length" class="bbs-field-hint">没有匹配「{{ excludeSearch }}」的角色。</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">共 {{ charNames.length }} 个角色 · 已排除 {{ apiSettings.excludedChars.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExclude">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 排除世界书弹窗:搜索 + 勾选列表(复刻排除角色) ===== -->
    <ModalMask :open="excludeWorldOpen" @close="closeExcludeWorld">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑排除世界书名单">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">整本排除世界书</span>
          <button class="bbs-icon-mini" type="button" title="关闭世界书排除名单" aria-label="关闭世界书排除名单" @click="closeExcludeWorld"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeWorldSearch"
          class="bbs-input"
          type="search"
          placeholder="搜索世界书名…"
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredWorldNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isWorldExcluded(name)"
              @change="toggleWorldExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!worldNames.length" class="bbs-field-hint">未读取到世界书。请先在 ST 里加载 / 挂载世界书。</p>
          <p v-else-if="!filteredWorldNames.length" class="bbs-field-hint">没有匹配「{{ excludeWorldSearch }}」的世界书。</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">共 {{ worldNames.length }} 本 · 已排除 {{ apiSettings.excludedWorldNames.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExcludeWorld">完成</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 更新确认弹窗 ===== -->
    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="发现新版本"
      confirm-text="更新并刷新"
      busy-text="更新中…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      当前版本 v{{ updateState.current || '—' }},最新版本 v{{ updateState.latest }}。<br />
      现在更新吗?更新完成后会自动刷新页面生效。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bbs-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 版本仅展示真实版本号，不暗示可点击。 */
.bbs-ver {
  display: inline-flex;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.bbs-field {
  margin-bottom: 18px;
}
.bbs-field:last-child {
  margin-bottom: 0;
}
.bbs-field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.bbs-field-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
/* 字段右上角的数值(如透明度百分比) */
.bbs-field-value {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--bbs-accent);
}

/* 滑块:用主题色,跨浏览器统一外观 */
.bbs-range {
  width: 100%;
  height: 4px;
  margin: 6px 0 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.bbs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
}
.bbs-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
}
.bbs-range:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}
.bbs-field-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}

/* 获取数据:宏速查列表 + 文档导出 */
.bbs-data-intro {
  margin-bottom: 10px;
}
.bbs-data-macros {
  border-top: 1px solid var(--bbs-line);
}
.bbs-data-macro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-data-macro-main {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-data-macro-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.bbs-data-macro-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-data-token {
  max-width: 100%;
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.bbs-data-desc {
  margin: 4px 0 0;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  line-height: 1.55;
}
.bbs-data-copy {
  flex: 0 0 auto;
}
.bbs-data-export {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 16px;
}
.bbs-data-export-text {
  flex: 1 1 auto;
  min-width: 0;
}

.bbs-segmented {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius);
}
/* 主题选项可能较多/标签较长:允许换行,窄屏下不溢出 */
.bbs-segmented-wrap {
  display: flex;
  flex-wrap: wrap;
}
.bbs-seg {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 18px;
  background: transparent;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    color var(--bbs-dur) var(--bbs-ease);
}
.bbs-seg:hover {
  color: var(--bbs-ink);
}
.bbs-seg.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.08);
}

/* 任务指派 */
.bbs-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbs-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* 指派下拉:占右半区(渠道名可能长,给足宽度再截断),小一号字与其它设置行一致。
   带上父级选择器是为了压过 BbsSelect 根节点自带的 width:100%——两者同特异度时靠
   样式表先后决定胜负,那取决于打包顺序,不可靠 */
.bbs-assign-row .bbs-assign-select {
  flex: 0 1 60%;
  min-width: 0;
}
.bbs-assign-select :deep(.bbs-select-trigger) {
  font-size: 12px;
}
/* —— 模型可搜索 combobox —— */
.bbs-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbs-combo .bbs-input {
  width: 100%;
  padding-right: 26px; /* 给右侧自绘三角让位,文字不压到箭头 */
}
/* 自绘下拉三角:与原生 <select> 同款 SVG,贴右侧居中;展开时翻转。装饰元素不拦点击 */
.bbs-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbs-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 过滤菜单:绝对定位贴在输入框下方,限高滚动,长列表不撑爆弹窗 */
.bbs-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  box-shadow: var(--bbs-shadow);
}
.bbs-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12.5px;
  color: var(--bbs-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbs-combo-item:hover {
  background: var(--bbs-surface-2);
}
.bbs-combo-item.is-active {
  color: var(--bbs-accent);
  font-weight: 600;
}
.bbs-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 小一号按钮:用于「添加渠道」等次级操作 */
.bbs-btn-sm {
  padding: 6px 11px;
  font-size: 12px;
}

/* 悬浮球图标配置:预览方块 + 操作按钮 */
.bbs-orb-config {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.bbs-orb-preview {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 22px;
  overflow: hidden;
}
.bbs-orb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 预览随所选形状变化,让用户直观看到效果 */
.bbs-orb-preview.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  border-color: transparent;
}
.bbs-orb-preview.shape-circle {
  border-radius: 999px;
}
.bbs-orb-preview.shape-square {
  border-radius: 12px;
}
.bbs-orb-config-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 测试按钮文字:默认(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.bbs-btn-label-short {
  display: none;
}

/* 渠道:顶部操作条(标签 + 添加按钮) */
.bbs-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 渠道:紧凑只读列表,每渠道一行,点行进弹窗编辑 */
.bbs-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左名字右模型 */
.bbs-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-channel-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
/* 渠道名:完整显示,允许换行,占据剩余空间 */
.bbs-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要信息,过长则截断,不挤占名字 */
.bbs-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 弹窗底部:spacer 把删除键推到最左,与右侧操作分隔 */
.bbs-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-btn-danger:hover {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

.bbs-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbs-model-row .bbs-input {
  flex: 1;
}
.bbs-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.bbs-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbs-icon-mini:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-channel-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.bbs-mini-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
.bbs-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
  word-break: break-all;
}

/* 摘要设置控件 */
.bbs-switch-row,
.bbs-num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
/* 「启用向量记忆」是折叠区里独一行开关,不再额外加上 padding,贴合标题节奏 */
.bbs-vec-enable {
  padding-top: 0;
}
/* 紧跟开关行的分割线收掉上边距:开关行自带 8px 下 padding 已够,避免整块显得空旷 */
.bbs-vec-enable-rule {
  margin-top: 0;
}
.bbs-checkbox {
  /* flex 行里长文本会把固定宽高的复选框挤扁 → 禁止收缩,保持标准方形 */
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  accent-color: var(--bbs-accent);
  cursor: pointer;
}
.bbs-num {
  max-width: 110px;
  text-align: right;
}
/* 向量端点的超时/重试:两个短输入并排,label 在上、窄框在下,与上方模型行留出呼吸间距 */
.bbs-vec-io {
  display: grid;
  /* 列宽贴合内容(而非 1fr 等分撑满),三个框紧凑靠左;auto-fit 保证空间不够时自动折行。
     用 1fr 会把每个 item 拉满整行,item 内的 label 随之被 stretch 撑宽,看着间距很大。 */
  grid-template-columns: repeat(auto-fit, minmax(72px, max-content));
  gap: 14px;
  margin-top: 12px;
}
.bbs-vec-io-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-num-sm {
  width: 72px;
  text-align: left;
}
/* 破限开关紧跟在超时/token 那栏之后:多留一点上间距,与上一栏拉开(只命中此处,不动通用 switch-row) */
.bbs-vec-io + .bbs-switch-row {
  margin-top: 6px;
}
/* 短选项下拉(如字数档位):贴合文字的窄宽,和右侧数字框对齐,不再撑满半行。
   同上,带父级压过组件根的 width:100% */
.bbs-num-row .bbs-select-narrow {
  width: auto;
  min-width: 65px;
  max-width: 150px;
}
.bbs-select-narrow :deep(.bbs-select-trigger) {
  font-size: 12px;
}

/* —— 总开关主控卡 —— */
.bbs-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  box-shadow: var(--bbs-shadow);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-master.is-off .bbs-master-text {
  opacity: 0.7;
}
.bbs-master-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bbs-master-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--bbs-ink);
}

/* —— 通用滑动开关(总开关用,后续别处也可复用) —— */
.bbs-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line-strong);
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on {
  background: var(--bbs-accent);
}
.bbs-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}
.bbs-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on .bbs-toggle-knob {
  transform: translateX(20px);
}

/* —— 向量记忆:每个模型角色一组卡片(渠道 + 模型名两列) —— */
/* 向量端点卡片(Embedding/Rerank/Query 各一块,扁平填地址/密钥/模型) */
.bbs-vec-ep {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-disabled {
  opacity: 0.5;
}
/* 召回参数/索引维护整组在关闭向量记忆时一并置灰 */
.bbs-vec-recall.is-disabled {
  opacity: 0.5;
}
.bbs-vec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
/* 端点卡片折叠头:整条标题栏可点;收起时去掉下间距,卡片只剩一行标题。 */
.bbs-vec-toggle {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.bbs-vec-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 4px;
  border-radius: var(--bbs-radius-sm);
}
/* 折叠头不自带下间距,改由 body 的 padding-top 统一供给,
   这样三块标题到首行内容的距离一致(不受有无提示行影响),收起时随 grid 一并归零。 */
.bbs-vec-toggle.bbs-vec-head {
  margin-bottom: 0;
}
.bbs-vec-ep-body {
  padding-top: 12px;
}
.bbs-vec-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-chevron {
  transform: rotate(-90deg);
}
/* 展开动画:照搬 Collapsible 的 grid 0fr<->1fr,内容自适应高度,无需测量。 */
.bbs-vec-ep-outer {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-outer {
  grid-template-rows: 0fr;
}
/* 展开态放开 overflow,否则会裁掉里面模型 combobox 绝对定位的下拉菜单(拉取模型后「点不开」);
   折叠动画期间仍需 hidden 来平滑揭示——用离散过渡延迟到动画结束(0.28s)才切 visible,收起时立即变回 hidden。
   allow-discrete 不支持的旧浏览器降级为立即切换:展开瞬间内容略溢出(小瑕疵),但下拉可用,不再点不开。 */
.bbs-vec-ep-inner {
  min-height: 0;
  overflow: visible;
  transition: overflow 0s var(--bbs-dur);
  transition-behavior: allow-discrete;
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-inner {
  overflow: hidden;
  transition-delay: 0s;
}
/* 向量后端类型标签:与摘要列表的「总结」标签同款(实心填充、白字),后端=强调色,本地降级=警告色 */
.bbs-vec-backend {
  box-sizing: border-box;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--bbs-radius-sm);
  white-space: nowrap;
}
.bbs-vec-backend.is-backend {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
}
.bbs-vec-backend.is-local {
  color: var(--bbs-accent-ink);
  background: var(--bbs-warning);
  border: 1px solid var(--bbs-warning);
}

/* —— 上次召回详情(调试面板):状态横幅 + 步骤分区 + 分数条卡片 —— */
.bbs-dbg {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 状态横幅:左色点 + 文案 + 时间 */
.bbs-dbg-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  border-left: 3px solid var(--bbs-line-strong);
}
.bbs-dbg-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bbs-ink-muted);
}
.bbs-dbg-banner.is-ok {
  border-left-color: var(--bbs-accent);
}
.bbs-dbg-banner.is-ok .bbs-dbg-dot {
  background: var(--bbs-accent);
}
.bbs-dbg-banner.is-warn {
  border-left-color: var(--bbs-warning);
}
.bbs-dbg-banner.is-warn .bbs-dbg-dot {
  background: var(--bbs-warning);
}
.bbs-dbg-banner.is-fail {
  border-left-color: var(--bbs-danger);
}
.bbs-dbg-banner.is-fail .bbs-dbg-dot {
  background: var(--bbs-danger);
}
.bbs-dbg-banner.is-pending .bbs-dbg-dot {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-status-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}

.bbs-dbg-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 索引维护:重建/清空按钮并排,窄屏自动换行 */
.bbs-vec-index-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

/* 重写:INTENT 高亮 + Q 列表 */
.bbs-dbg-intent {
  display: flex;
  gap: 7px;
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent-soft);
  font-size: 12px;
  line-height: 1.6;
}
.bbs-dbg-intent-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-tag {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-family: var(--bbs-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.bbs-dbg-qlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-dbg-qitem {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--bbs-ink);
}
.bbs-dbg-qno {
  flex: 0 0 auto;
  min-width: 22px;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--bbs-accent);
}
.bbs-dbg-qtext {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

/* 命中卡片列表:固定高度内滑动,长列表不把折叠区撑得很长。 */
.bbs-dbg-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.bbs-dbg-card {
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
.bbs-dbg-card.is-dropped {
  opacity: 0.55;
}
.bbs-dbg-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
/* 来源 Q 徽标 */
.bbs-dbg-src {
  flex: 0 0 auto;
  min-width: 38px; /* 与楼层号标签等宽,单数 Q 也不至于太窄 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
}
/* 来源标记:本聊天楼层号(中性)/ 旧档(描边提示色) */
.bbs-dbg-from {
  flex: 0 0 auto;
  min-width: 38px; /* 楼层号个位数(#5)也不至于太窄,与 Q 标签视觉等宽 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-from.is-bundle {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-color: transparent;
}
.bbs-dbg-when {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-dbg-num {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-ink);
  font-variant-numeric: tabular-nums;
}
/* 分数条:细轨 + 填充;默认强调色,rerank 各档分色 */
.bbs-dbg-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line);
  overflow: hidden;
}
.bbs-dbg-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
.bbs-dbg-bar.tier-brief > i {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-bar.tier-drop > i {
  background: var(--bbs-ink-muted);
}
.bbs-dbg-prev {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
/* 分档徽标:全文(强调实底)/摘要(中性)/丢弃(描边褪色) */
.bbs-dbg-tier {
  flex: 0 0 auto;
  min-width: 32px;
  text-align: center;
  padding: 1px 8px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.bbs-dbg-tier.is-full {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-dbg-tier.is-brief {
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-tier.is-drop {
  color: var(--bbs-ink-muted);
  background: transparent;
  border: 1px solid var(--bbs-line);
}
/* 注入文本框:等宽、限高滚动 */
.bbs-dbg-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink);
}

/* —— 自定义提示词列表 —— */
.bbs-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑;布局沿用渠道列表的观感(描边、hover 显强调色) */
.bbs-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-prompt-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
.bbs-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 状态药丸:默认 muted,已自定义转金强调 */
.bbs-prompt-state {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  color: var(--bbs-ink-muted);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
}
.bbs-prompt-state.is-custom {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: transparent;
}
.bbs-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbs-ink-muted);
}
.bbs-prompt-open:hover .bbs-prompt-edit {
  color: var(--bbs-accent);
}

/* —— 提示词弹窗:更宽 + 大文本框 —— */
.bbs-modal-wide {
  max-width: 680px;
}
/* 宏标签条:可横向裹行,每个宏点击插入 */
.bbs-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbs-macro-tip {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  margin-right: 2px;
}
.bbs-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-macro:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-prompt-area {
  resize: vertical;
  min-height: 240px;
  line-height: 1.6;
  font-family: var(--bbs-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— 自定义清洗标签:输入框 + 添加按钮一行 —— */
.bbs-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.bbs-striptag-bar .bbs-input {
  flex: 1;
  min-width: 0;
}
.bbs-striptag-bar .bbs-btn {
  flex: none;
}

/* —— 排除角色:已排除名字以药丸形式平铺,点 × 移出 —— */
.bbs-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bbs-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
}
.bbs-exclude-chip-name {
  word-break: break-word;
}
.bbs-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.bbs-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}

/* 弹窗内角色勾选列表:固定高度内滚动,长名单不撑爆弹窗 */
.bbs-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.bbs-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
}
.bbs-exclude-row:hover {
  background: var(--bbs-surface-2);
}
.bbs-exclude-row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-exclude-count {
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  /* 渠道参数四连:窄屏一行四个每个只剩几十 px,落成 2×2 */
  .bbs-channel-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .bbs-field-label,
  .bbs-channel-item-name {
    font-size: 13px;
  }
  .bbs-prompt-name {
    font-size: 12px;
  }
  .bbs-field-hint,
  .bbs-channel-item-model {
    font-size: 11px;
  }
  .bbs-seg {
    font-size: 12px;
  }
  /* 渠道弹窗底部:测试按钮窄屏只显短版「测试」,PC 显完整「测试渠道」 */
  .bbs-btn-label-full {
    display: none;
  }
  .bbs-btn-label-short {
    display: inline;
  }
  .bbs-data-export {
    align-items: stretch;
    flex-direction: column;
  }
  .bbs-data-export .bbs-btn {
    justify-content: center;
    width: 100%;
  }
}

/* ================= 棱镜宝书 · 设置工作台 =================
 * 只使用共享语义色；五种主题的 ID、选项与设置值均由原状态源提供。
 * 容器断点按插件实际可用宽度生效，而非宿主浏览器宽度。
 */
.prism-settings {
  min-width: 0;
  container: prism-settings / inline-size;
  color: var(--bbs-ink);
  padding-bottom: 24px;
}
.prism-settings *,
.bbs-modal * {
  box-sizing: border-box;
}
.prism-settings :deep(.prism-page-header) {
  flex-wrap: wrap;
}
.bbs-ver-row {
  flex-wrap: wrap;
  min-width: 0;
}
.prism-overview {
  border: 1px solid var(--bbs-line-strong);
  border-radius: 20px;
  background: var(--bbs-surface);
  box-shadow: var(--bbs-card-shadow, var(--bbs-shadow));
  overflow: hidden;
  margin-bottom: 28px;
}
.prism-overview .bbs-master {
  margin: 0;
  padding: 24px;
  gap: 16px;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: linear-gradient(115deg, var(--bbs-accent-soft), var(--bbs-surface));
}
.prism-engine-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 16px;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
  color: var(--bbs-accent);
  font-size: 25px;
}
.prism-eyebrow {
  color: var(--bbs-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .16em;
}
.bbs-master-title {
  margin: 4px 0 0;
  font-size: 18px;
  line-height: 1.5;
  font-weight: 650;
}
.prism-master-description {
  color: var(--bbs-ink-soft);
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.prism-master-control {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.prism-state {
  color: var(--bbs-accent);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
  padding: 3px 9px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.prism-state.is-muted { color: var(--bbs-ink-muted); }
.bbs-master.is-off .bbs-master-text { opacity: 1; }
.prism-status-grid {
  margin: 0;
  padding: 0 24px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 24px;
}
.prism-status-item {
  min-width: 0;
  padding: 18px 0;
  border-top: 1px solid var(--bbs-line);
}
.prism-status-item dt {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--bbs-ink-muted);
  font-size: 11px;
}
.prism-status-item dt :deep(svg) { color: var(--bbs-accent); }
.prism-status-item dd { margin: 8px 0 0; }
.prism-status-item strong {
  display: block;
  color: var(--bbs-ink);
  font-size: 15px;
  line-height: 1.5;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.prism-status-item dd > span {
  display: block;
  color: var(--bbs-ink-soft);
  font-size: 11px;
  line-height: 1.7;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.prism-overview-note {
  margin: 0;
  padding: 12px 24px;
  border-top: 1px solid var(--bbs-line);
  color: var(--bbs-ink-muted);
  background: var(--bbs-surface-2);
  font-size: 11px;
  line-height: 1.7;
}
.prism-settings-layout { display: grid; gap: 24px; min-width: 0; }
.prism-settings-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: start;
  align-items: stretch;
  min-width: 0;
}
.prism-nav-label {
  flex: 1 0 100%;
  color: var(--bbs-ink-muted);
  font-size: 10px;
  letter-spacing: .12em;
  margin-bottom: 2px;
}
.prism-settings-nav button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: 12px;
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.prism-settings-nav button:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.prism-settings-nav button > span { min-width: 0; }
.prism-settings-nav strong { display: block; font-size: 12px; font-weight: 600; }
.prism-settings-nav small { display: none; font-size: 10px; margin-top: 4px; color: var(--bbs-ink-muted); }
.prism-nav-arrow { display: none; }
.bbs-sections { min-width: 0; gap: 32px; }
.prism-settings-group { min-width: 0; }
.prism-group-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
  min-width: 0;
}
.prism-group-number {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid var(--bbs-line);
  border-radius: 10px;
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font: 600 11px/1 var(--bbs-font-mono);
}
.prism-group-head > div { min-width: 0; flex: 1; }
.prism-group-head h2 {
  color: var(--bbs-ink);
  font-size: 17px;
  line-height: 1.5;
  margin: 1px 0 4px;
  font-weight: 650;
  scroll-margin-block-start: 24px;
}
.prism-group-head p {
  color: var(--bbs-ink-muted);
  font-size: 12px;
  line-height: 1.75;
  margin: 0;
}
.prism-group-tag {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-pill);
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  font-size: 10px;
  line-height: 1.5;
}
.prism-group-data .prism-group-tag {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
.prism-group-cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
.prism-settings-card {
  min-width: 0;
  border-radius: 16px;
  box-shadow: var(--bbs-card-shadow, var(--bbs-shadow));
}
.prism-settings-card :deep(.bbs-collapsible-head) {
  min-height: 52px;
  gap: 12px;
  padding: 16px 20px;
  font-size: 14px;
}
.prism-settings-card :deep(.bbs-collapsible-title) { min-width: 0; overflow-wrap: anywhere; }
.prism-settings-card :deep(.bbs-collapsible-body) { padding: 20px; }
.prism-settings-card :deep(.bbs-collapsible) { box-shadow: none; }
.prism-settings-card.is-open,
.prism-settings-card :deep(.bbs-collapsible.is-open) { overflow: visible; }
.prism-settings :deep(.bbs-collapsible.is-open > .bbs-collapsible-outer > .bbs-collapsible-inner) { overflow: visible; }
.prism-settings :deep(.bbs-collapsible:not(.is-open) > .bbs-collapsible-outer) {
  visibility: hidden;
}
.prism-card-intro {
  margin: 0 0 18px;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--bbs-line);
  color: var(--bbs-ink-soft);
  font-size: 12px;
  line-height: 1.8;
}
.prism-settings .bbs-field-label { line-height: 1.6; overflow-wrap: anywhere; }
.prism-settings .bbs-field-hint { font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.bbs-switch-row,
.bbs-num-row { gap: 20px; min-height: 46px; }
.bbs-switch-row > .bbs-field-label,
.bbs-num-row > .bbs-field-label { min-width: 0; flex: 1 1 auto; }
.bbs-switch-row > .bbs-input:not([type='checkbox']) { flex: 0 1 240px; width: 48%; min-width: 0; }
.bbs-num-row > .bbs-num { flex: 0 0 110px; width: 110px; }
.prism-settings .bbs-input,
.bbs-modal .bbs-input { min-width: 0; max-width: 100%; }
.bbs-input:disabled { cursor: not-allowed; }
.bbs-segmented { max-width: 100%; flex-wrap: wrap; border: 1px solid var(--bbs-line); }
.bbs-seg { flex: 1 1 auto; min-height: 40px; justify-content: center; padding: 8px 12px; }
.bbs-assign-row { flex-wrap: wrap; gap: 10px 20px; }
.bbs-assign-row .bbs-assign-select { flex: 1 1 190px; min-width: 0; max-width: 100%; }
.bbs-channel-bar { flex-wrap: wrap; }
.bbs-channel-open { padding: 14px; min-height: 52px; }
.prism-channel-edit { flex: 0 0 auto; color: var(--bbs-accent); font-size: 15px; }
.bbs-channel-item-model { max-width: 48%; }
.bbs-channel-list + .bbs-field-hint { margin-top: 12px; }
.bbs-prompt-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.bbs-prompt-open { min-height: 58px; padding: 14px; }
.bbs-prompt-item { min-width: 0; }
.bbs-prompt-name { overflow-wrap: anywhere; line-height: 1.6; }
.bbs-prompt-state { white-space: nowrap; }
.bbs-vec-ep { padding: 16px; border-radius: 14px; }
.bbs-vec-ep.is-disabled { opacity: 1; }
.bbs-vec-ep.is-disabled .prism-endpoint-heading { color: var(--bbs-ink-muted); }
.bbs-vec-toggle { min-height: 44px; }
.prism-endpoint-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.prism-endpoint-model { color: var(--bbs-ink-muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.bbs-vec-io { grid-template-columns: repeat(auto-fit, minmax(min(100%, 100px), 1fr)); }
.bbs-vec-io-item { min-width: 0; }
.bbs-vec-io .bbs-num-sm { width: 100%; }
.bbs-vec-index-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bbs-vec-backend.is-local { color: var(--bbs-warning); background: var(--bbs-warning-soft); border-color: var(--bbs-line); }
.bbs-model-row { min-width: 0; }
.bbs-model-row > .bbs-input { width: 0; min-width: 0; }
.bbs-combo { min-width: 0; }
.bbs-icon-mini { width: 40px; height: 40px; }
.bbs-exclude-chip { max-width: 100%; padding: 4px 5px 4px 10px; }
.bbs-exclude-chip-name { min-width: 0; overflow-wrap: anywhere; }
.bbs-exclude-chip-x { flex-shrink: 0; width: 28px; height: 28px; }
.bbs-exclude-chip-x:hover { background: var(--bbs-surface); }
.bbs-striptag-bar { flex-wrap: wrap; }
.bbs-striptag-bar .bbs-input { flex: 1 1 160px; }
.bbs-dbg-banner { flex-wrap: wrap; }
.bbs-dbg-head { flex-wrap: wrap; }
.prism-settings-footnote { color: var(--bbs-ink-muted); font-size: 11px; line-height: 1.8; border-top: 1px solid var(--bbs-line); padding-top: 18px; margin: 28px 0 0; }
.prism-editor-note { margin: 0; padding: 10px 12px; color: var(--bbs-ink-soft); background: var(--bbs-accent-soft); border-radius: 10px; font-size: 12px; line-height: 1.7; }
.bbs-modal { min-width: 0; max-width: min(100%, 520px); }
.bbs-modal-wide { max-width: min(100%, 680px); }
.bbs-modal-head { gap: 12px; }
.bbs-modal-title { min-width: 0; overflow-wrap: anywhere; }
.bbs-modal-foot { flex-wrap: wrap; gap: 8px; }
.bbs-modal .bbs-channel-row { grid-template-columns: repeat(auto-fit, minmax(min(100%, 110px), 1fr)); }
.bbs-prompt-area { width: 100%; }
.bbs-macro { max-width: 100%; overflow-wrap: anywhere; }
.bbs-modal-field > .bbs-modal-label { line-height: 1.6; }
.prism-settings :is(button, input, select, textarea):focus-visible,
.bbs-modal :is(button, input, select, textarea):focus-visible,
.prism-group-head h2:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}
@container prism-settings (min-width: 760px) {
  .prism-status-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .prism-group-common .prism-group-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .prism-card-wide { grid-column: 1 / -1; }
  .bbs-prompt-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container prism-settings (min-width: 1100px) {
  .prism-settings-layout { grid-template-columns: 180px minmax(0, 1fr); gap: 28px; align-items: start; }
  .prism-settings-nav { position: sticky; top: 20px; flex-direction: column; }
  .prism-nav-label { flex-basis: auto; padding-left: 12px; }
  .prism-settings-nav button { padding: 13px 12px; }
  .prism-settings-nav button > span { flex: 1; }
  .prism-settings-nav small { display: block; }
  .prism-nav-arrow { display: block; transform: rotate(-90deg); font-size: 12px; }
}
@container prism-settings (max-width: 520px) {
  .prism-overview { border-radius: 16px; margin-bottom: 20px; }
  .prism-overview .bbs-master { padding: 18px 16px; gap: 10px; }
  .prism-engine-icon { display: none; }
  .bbs-master-title { font-size: 16px; }
  .prism-master-control { gap: 8px; }
  .prism-status-grid { padding: 0 16px; gap: 0 16px; }
  .prism-status-item { padding: 14px 0; }
  .prism-status-item strong { font-size: 14px; }
  .prism-overview-note { padding: 12px 16px; }
  .prism-settings-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .prism-nav-label { grid-column: 1 / -1; }
  .prism-settings-nav button { padding: 10px; }
  .prism-group-head { flex-wrap: wrap; gap: 8px; }
  .prism-group-head > div { flex-basis: calc(100% - 42px); }
  .prism-group-tag { margin-left: 38px; }
  .prism-group-head h2 { font-size: 16px; }
  .prism-settings-card :deep(.bbs-collapsible-head) { padding: 14px; }
  .prism-settings-card :deep(.bbs-collapsible-body) { padding: 14px; }
  .bbs-switch-row,
  .bbs-num-row { gap: 12px; }
  .bbs-switch-row:has(> .bbs-input:not([type='checkbox'])) { align-items: stretch; flex-direction: column; }
  .bbs-switch-row > .bbs-input:not([type='checkbox']) { flex: initial; width: 100%; }
  .bbs-num-row > .bbs-num { width: 88px; flex-basis: 88px; }
  .bbs-assign-row { align-items: stretch; flex-direction: column; }
  .bbs-assign-row .bbs-assign-select { flex: initial; width: 100%; }
  .bbs-vec-ep { padding: 12px; }
  .bbs-prompt-open { padding: 12px; gap: 8px; }
  .bbs-prompt-name { font-size: 13px; }
  .bbs-channel-open { flex-wrap: wrap; gap: 6px; }
  .bbs-channel-item-name { flex-basis: calc(100% - 22px); }
  .bbs-channel-item-model { order: 3; flex-basis: 100%; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .bbs-vec-index-actions .bbs-btn { width: 100%; justify-content: center; white-space: normal; }
}
@media (max-width: 420px) {
  .bbs-modal { padding: 16px; }
  .bbs-modal-head { top: -16px; margin: -16px -16px 0; padding: 16px 16px 12px; }
  .bbs-modal-foot .bbs-modal-foot-spacer { display: none; }
  .bbs-modal-foot .bbs-btn { flex: 1 1 auto; justify-content: center; }
  .bbs-prompt-area { min-height: 220px; font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .prism-settings *, .prism-settings :deep(*), .bbs-modal * { transition: none !important; }
}


.prism-config-details { border-top:1px solid var(--bbs-line); }
.prism-config-details > summary { cursor:pointer; padding:13px 24px; color:var(--bbs-ink-soft); font-size:12px; }
.prism-config-details > summary span { margin-left:10px; color:var(--bbs-ink-muted); }
.prism-config-details > summary:focus-visible { outline:2px solid var(--bbs-accent); outline-offset:-3px; }
@media(max-width:640px){ .prism-config-details > summary { padding:12px 16px; } .prism-config-details > summary span { font-size:11px; } }
</style>
