<script setup lang="ts">
/**
 * 向量记忆的一个端点（Embedding / Rerank / Query 重写）：直接填地址、密钥、模型，模型可一键拉取。
 * 卡片自身可折叠（点标题栏），默认收起只露标题；副标显示当前模型，收起也看得出配没配。
 * Rerank/Query 的地址、密钥留空时整体复用 Embedding；模型三者各自填写，从不复用。
 */
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import { fetchModels } from '@/api/client';
import { describeFailure } from '@/api/errors';
import { apiSettings, resolveVectorModel } from '@/api/settings';
import { ref, useId } from 'vue';
import ModelCombo from '../ModelCombo.vue';
import { TONE_CLASS, type Notice } from '../notice';
import SettingRow from '../SettingRow.vue';

/** 端点角色：embedding / rerank / queryRewrite */
type VectorRole = Parameters<typeof resolveVectorModel>[0];

const props = defineProps<{ role: VectorRole; label: string }>();

const showKey = ref(false);
const open = ref(false);
const models = ref<string[]>([]);
const loadingModels = ref(false);
const modelMsg = ref<Notice | null>(null);
const bodyId = useId();

async function pullModels() {
  const role = props.role;
  // 解析回落后的地址/密钥:rerank/query 留空时自动用 Embedding 的去拉(模型仍写回本角色)
  const ep = resolveVectorModel(role);
  if (!ep.url.trim()) {
    modelMsg.value = {
      tone: 'warn',
      text: role === 'embedding'
        ? '未填写 API 地址，无法拉取模型列表。请先在上方「API 地址」中填写。'
        : '未填写 API 地址，无法拉取模型列表。请填写本项的「API 地址」，或先填写 Embedding 的地址（本项留空时沿用）。',
    };
    return;
  }
  loadingModels.value = true;
  modelMsg.value = null;
  try {
    const list = await fetchModels({ url: ep.url, key: ep.key, timeoutSec: ep.timeoutSec });
    models.value = list;
    if (list.length && !apiSettings.vector[role].model) apiSettings.vector[role].model = list[0];
    modelMsg.value = list.length
      ? { tone: 'ok', text: `已获取 ${list.length} 个模型，可在模型输入框中选择。` }
      : { tone: 'warn', text: '接口未返回模型列表，可直接填写模型名。' };
  } catch (e) {
    modelMsg.value = { tone: 'error', text: `拉取模型列表失败：${describeFailure(e, '请检查 API 地址、网络或超时设置后重试').message}` };
  } finally {
    loadingModels.value = false;
  }
}
</script>

<template>
  <div
    class="bbs-vec-ep"
    :class="{ 'is-disabled': !apiSettings.vector.enabled, 'is-collapsed': !open }"
  >
    <button
      type="button"
      class="bbs-vec-head bbs-vec-toggle"
      :aria-expanded="open"
      :aria-controls="bodyId"
      @click="open = !open"
    >
      <span class="prism-endpoint-heading">
        <span class="bbs-field-label">{{ label }}</span>
        <span class="prism-endpoint-model">{{ apiSettings.vector[role].model || '未填写模型' }}</span>
      </span>
      <Icon name="chevron" class="bbs-vec-chevron" />
    </button>

    <div :id="bodyId" class="bbs-vec-ep-outer" :inert="!open" :aria-hidden="!open">
      <div class="bbs-vec-ep-inner">
        <div class="bbs-vec-ep-body">
          <p v-if="role !== 'embedding'" class="bbs-field-hint">地址和密钥留空时使用 Embedding 的设置；模型需单独填写。</p>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">API 地址</span>
            <input
              v-model="apiSettings.vector[role].url"
              class="bbs-input"
              :placeholder="role === 'embedding' ? '如 https://api.openai.com/v1' : '留空 = 复用 Embedding 的地址'"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">API 密钥</span>
            <div class="bbs-model-row">
              <input
                v-model="apiSettings.vector[role].key"
                class="bbs-input"
                :type="showKey ? 'text' : 'password'"
                :placeholder="role === 'embedding' ? 'API 密钥' : '留空 = 复用 Embedding 的密钥'"
                :disabled="!apiSettings.vector.enabled"
              />
              <IconButton
                :icon="showKey ? 'eye-off' : 'eye'"
                label="显示密钥"
                :pressed="showKey"
                @click="showKey = !showKey"
              />
            </div>
          </label>

          <!-- 模型:三个角色各自独立(embedding/rerank/query 模型本就不同),都要单独选,从不复用。
               拉取走「该角色的地址/密钥」,留空则自动用 Embedding 的地址/密钥去拉。 -->
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">模型</span>
            <div class="bbs-model-row">
              <ModelCombo
                v-model="apiSettings.vector[role].model"
                :options="models"
                placeholder="模型名，或点击右侧按钮拉取列表"
                :disabled="!apiSettings.vector.enabled"
              />
              <IconButton
                icon="refresh"
                :label="loadingModels ? '拉取中…' : '拉取模型列表'"
                :disabled="!apiSettings.vector.enabled || loadingModels"
                @click="pullModels"
              />
            </div>
          </label>
          <p v-if="modelMsg" class="bbs-callout prism-inline-notice" :class="TONE_CLASS[modelMsg.tone]" role="status">{{ modelMsg.text }}</p>

          <!-- 超时/重试(+ Query 重写的最大 token):各角色独立(默认 embedding 10s / rerank 20s / query 90s),不随地址复用回落。
               grid auto-fit:空间够就一行排开,不够自动换行。 -->
          <div class="bbs-vec-io">
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">超时（秒）</span>
              <input
                v-model.number="apiSettings.vector[role].timeoutSec"
                class="bbs-input bbs-num-sm"
                type="number"
                min="1"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">失败重试次数</span>
              <input
                v-model.number="apiSettings.vector[role].retries"
                class="bbs-input bbs-num-sm"
                type="number"
                min="0"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label v-if="role === 'queryRewrite'" class="bbs-vec-io-item">
              <span class="bbs-modal-label">最大输出（tokens）</span>
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
          <SettingRow
            v-if="role === 'queryRewrite'"
            label="附加任务说明"
            hint="沿用「提示词」中的任务说明模式；任务说明禁用或自定义内容为空时不附加。检索重写的输出较短，无需设置较大的输出上限。"
          >
            <input
              v-model="apiSettings.vector.queryRewriteJailbreak"
              type="checkbox"
              role="switch"
              class="bbs-checkbox bbs-switch"
              :disabled="!apiSettings.vector.enabled"
            />
          </SettingRow>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 向量端点卡片(Embedding/Rerank/Query 各一块,扁平填地址/密钥/模型) */
.bbs-vec-ep {
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--bbs-line);
  border-radius: 14px;
  background: var(--bbs-surface-2);
}
/* 关闭向量记忆时端点卡片不降透明度(文字对比度不够),只把标题改为次要色。 */
.bbs-vec-ep.is-disabled .prism-endpoint-heading {
  color: var(--bbs-ink-muted);
}
/* 端点卡片折叠头:整条标题栏可点;收起时去掉下间距,卡片只剩一行标题。 */
.bbs-vec-toggle {
  width: 100%;
  min-height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
/* 焦点框由页面统一的 focus-visible 规则绘制,这里只给圆角。 */
.bbs-vec-toggle:focus-visible {
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
/* 端点表单：字段之间留出间距，标签不贴着上一个输入框。 */
.bbs-vec-ep-body > .bbs-modal-field + .bbs-modal-field {
  margin-top: 12px;
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
/* 向量端点的超时/重试:短输入并排,label 在上、输入框在下,与上方模型行留出间距;
   每列至少 100px,空间不够时自动折行。 */
.bbs-vec-io {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 100px), 1fr));
  gap: 14px;
  margin-top: 12px;
}
.bbs-vec-io-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.bbs-num-sm {
  width: 100%;
  text-align: left;
}
/* 破限开关紧跟在超时/token 那栏之后:多留一点上间距,与上一栏拉开(只命中此处,不动通用 switch-row) */
.bbs-vec-io + :deep(.bbs-switch-row) {
  margin-top: 6px;
}
.prism-endpoint-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.prism-endpoint-model { color: var(--bbs-ink-muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
@container prism-settings (max-width: 520px) {
  .bbs-vec-ep { padding: 12px; }
}
</style>
