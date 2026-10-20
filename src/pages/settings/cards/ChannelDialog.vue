<script setup lang="ts">
/**
 * 渠道编辑弹窗：v-model 全改在草稿副本上，点「完成」才写回 apiSettings（避免每敲一字就触发存盘）。
 * 弹窗开关以草稿为准：草稿存在 = 弹窗打开。由卡片调用 openNew / openExisting 打开。
 */
import BbsSelect from '@/components/BbsSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import ModalShell from '@/components/ModalShell.vue';
import { fetchModels, testChannel } from '@/api/client';
import { describeFailure } from '@/api/errors';
import { apiSettings, newChannel, type ApiChannel } from '@/api/settings';
import { computed, ref } from 'vue';
import ModelCombo from '../ModelCombo.vue';
import { TONE_CLASS, type Notice } from '../notice';

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

// editingId:正在编辑的「已有渠道」id;新建时为 null。仅用于「完成」时定位写回目标。
const editingId = ref<string | null>(null);
// 编辑用「草稿副本」:弹窗开关也以它为准。
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

function openNew() {
  showKey.value = false;
  editingId.value = null; // null = 新建,完成时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 apiSettings
}
function openExisting(id: string) {
  const src = apiSettings.channels.find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
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
    const list = apiSettings.channels;
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
  const list = apiSettings.channels;
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:使用该渠道的摘要/总结改回跟随主 API
  if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
  if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
}

const testing = ref<Record<string, Notice>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = { tone: 'busy', text: '正在测试…' };
  const r = await testChannel(ch);
  testing.value[ch.id] = { tone: !r.ok ? 'error' : r.warning ? 'warn' : 'ok', text: r.message, detail: r.detail };
}

// 各渠道拉取到的模型列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  delete testing.value[ch.id];
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    testing.value[ch.id] = list.length
      ? { tone: 'ok', text: `已获取 ${list.length} 个模型，可在「模型」输入框中选择。` }
      : { tone: 'warn', text: '接口未返回模型列表，可直接填写模型名。' };
  } catch (e) {
    const view = describeFailure(e, '请检查 API 地址、网络或超时设置后重试');
    testing.value[ch.id] = { tone: 'error', text: `拉取模型列表失败：${view.message}`, detail: view.detail };
  } finally {
    loadingModels.value[ch.id] = false;
  }
}
// 已拉取到的当前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});

defineExpose({ openNew, openExisting });
</script>

<template>
  <ModalShell
    :open="!!editingChannel"
    :title="editingId ? '编辑渠道' : '添加渠道'"
    close-label="关闭渠道编辑窗口"
    class="prism-settings-modal"
    @close="closeChannel"
  >
    <template v-if="editingChannel">

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
          <IconButton :icon="showKey ? 'eye-off' : 'eye'" label="显示密钥" :pressed="showKey" @click="showKey = !showKey" />
        </div>
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">模型</span>
        <div class="bbs-model-row">
          <!-- 可搜索 combobox:已拉取到模型列表时,聚焦弹出过滤菜单;没列表时就是普通输入框 -->
          <ModelCombo v-model="editingChannel.model" :options="modelList" placeholder="模型名，如 gpt-4o-mini" />
          <IconButton
            icon="refresh"
            :label="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型列表'"
            :disabled="loadingModels[editingChannel.id]"
            @click="pullModels(editingChannel)"
          />
        </div>
      </label>
      <div class="bbs-channel-row">
        <label class="bbs-mini-field">
          <span>温度</span>
          <input v-model.number="editingChannel.temperature" class="bbs-input" type="number" step="0.1" min="0" max="2" />
        </label>
        <label class="bbs-mini-field">
          <span>最大输出（tokens）</span>
          <input v-model.number="editingChannel.maxTokens" class="bbs-input" type="number" step="256" min="256" />
        </label>
        <label class="bbs-mini-field">
          <span>超时（秒）</span>
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
      <span class="bbs-field-hint">不确定思考强度时选 auto，DeepSeek 系列推荐 max。最大输出包含思考过程，摘要经常被截断时调大。</span>
      <label class="bbs-switch-row">
        <span class="bbs-modal-label">流式传输</span>
        <input v-model="editingChannel.stream" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
      </label>
      <label class="bbs-switch-row">
        <span class="bbs-modal-label">发送预填充</span>
        <input v-model="editingChannel.prefill" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
      </label>
      <span class="bbs-field-hint">两项默认关闭。流式传输：接口支持时可启用，出错时便于查看服务商返回的原始信息。发送预填充：接口支持时（如 Claude）可启用，摘要格式更稳定；报错提及 prefill 时关闭。</span>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">排除参数</span>
        <input
          v-model="excludeParamsText"
          class="bbs-input"
          type="text"
          placeholder="用逗号分隔，如 temperature, max_tokens"
        />
        <span class="bbs-field-hint">发送请求前从中删除这些参数，用于不接受某些参数的接口。留空则不删除。</span>
      </label>
      <div v-if="testing[editingChannel.id]" class="bbs-callout bbs-channel-test" :class="TONE_CLASS[testing[editingChannel.id].tone]" role="status">
        <p>{{ testing[editingChannel.id].text }}</p>
        <details v-if="testing[editingChannel.id].detail"><summary>技术细节</summary><p>{{ testing[editingChannel.id].detail }}</p></details>
      </div>

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
        确定删除渠道「{{ editingChannel.name || '未命名渠道' }}」？删除后无法恢复，使用该渠道的任务将改为「跟随主 API」。
      </ConfirmDialog>
    </template>

    <template #footer>
      <template v-if="editingChannel">
        <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触。新建的渠道还没保存,不显示删除。
             测试:PC 显「测试渠道」,移动端只显「测试」(短版,省版面) -->
        <button v-if="editingId" class="bbs-btn bbs-btn-danger" type="button" @click="askRemoveChannel">
          <Icon name="trash" /> 删除
        </button>
        <span class="bbs-modal-foot-spacer"></span>
        <button class="bbs-btn" type="button" title="测试渠道" @click="doTest(editingChannel)">
          <Icon name="plug" /> <span class="bbs-btn-label-full">测试渠道</span><span class="bbs-btn-label-short">测试</span>
        </button>
        <button class="bbs-btn bbs-btn-primary" type="button" @click="confirmChannel">完成</button>
      </template>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 测试按钮文字:默认(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.bbs-btn-label-short {
  display: none;
}
/* 渠道参数四项(只在渠道弹窗里):空间够就一行排开,不够自动换行。 */
.bbs-channel-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 110px), 1fr));
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
  margin: 4px 0 0;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  /* 渠道弹窗底部:测试按钮窄屏只显短版「测试」,PC 显完整「测试渠道」 */
  .bbs-btn-label-full {
    display: none;
  }
  .bbs-btn-label-short {
    display: inline;
  }
}
</style>
