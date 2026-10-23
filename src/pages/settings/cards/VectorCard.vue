<script setup lang="ts">
/* 向量记忆：从旧剧情中检索相关片段注入正文。三个端点、召回参数与索引维护；上一次召回的过程见「召回调试」卡片。 */
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings, type resolveVectorModel } from '@/api/settings';
import { clearVectorIndex, forgetRejectedLeaves, rebuildVectorIndex, syncVectorIndex, type VectorSyncResult } from '@/memory/vector';
import { indexModelIssue } from '@/memory/vector/indexModel';
import { normalizeRecallInjectionDepth } from '@/memory/vector/depth';
import { normalizeRecallCount, normalizeRecallStickyTurns, normalizeRecallThreshold, RECALL_PARAM_DEFAULTS } from '@/memory/vector/params';
import { currentChatScope, currentVectorDb } from '@/memory/vector/scope';
import { resetVectorStoreProbe, vectorBackendKind } from '@/memory/vector/store';
import { onMounted, ref, watch } from 'vue';
import { readableError, TONE_CLASS, type Notice } from '../notice';
import SettingRow from '../SettingRow.vue';
import VectorEndpoint from './VectorEndpoint.vue';

/* —— 向量记忆:三个模型角色,embedding 为基准,后两者留空复用它 —— */
const VECTOR_ROLES: { key: Parameters<typeof resolveVectorModel>[0]; label: string }[] = [
  { key: 'embedding', label: 'Embedding（向量化，必填）' },
  { key: 'rerank', label: 'Rerank（重排，可选）' },
  { key: 'queryRewrite', label: 'Query 重写（必填）' },
];

/* —— 召回参数:输入框清空或越界时,失焦(或回车)后回填合法值,与召回读取时的规整规则相同 —— */
type RecallNumberKey = 'injectionDepth' | 'rerankCandidates' | 'embeddingThreshold' | 'rerankThreshold' | 'fullTextCount' | 'finalRecallCount' | 'minAiFloors' | 'stickyTurns';
function onRecallNumberChange(key: RecallNumberKey): void {
  const recall = apiSettings.vector.recall;
  const d = RECALL_PARAM_DEFAULTS;
  const v: unknown = recall[key];
  switch (key) {
    case 'injectionDepth': recall.injectionDepth = normalizeRecallInjectionDepth(v); break;
    case 'rerankCandidates': recall.rerankCandidates = normalizeRecallCount(v, d.rerankCandidates, 1); break;
    case 'embeddingThreshold': recall.embeddingThreshold = normalizeRecallThreshold(v, d.embeddingThreshold); break;
    case 'rerankThreshold': recall.rerankThreshold = normalizeRecallThreshold(v, d.rerankThreshold); break;
    case 'fullTextCount': recall.fullTextCount = normalizeRecallCount(v, d.fullTextCount); break;
    case 'finalRecallCount': recall.finalRecallCount = normalizeRecallCount(v, d.finalRecallCount); break;
    case 'minAiFloors': recall.minAiFloors = normalizeRecallCount(v, d.minAiFloors); break;
    case 'stickyTurns': recall.stickyTurns = normalizeRecallStickyTurns(v); break;
  }
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

/* —— 换了 Embedding 模型:当前聊天的索引是用别的模型建立的,提示清空并重建 —— */
const modelWarning = ref('');
function refreshModelWarning(): void {
  const database = currentVectorDb();
  const scope = currentChatScope();
  modelWarning.value = database && scope ? indexModelIssue(database, scope, apiSettings.vector.embedding.model) : '';
}
onMounted(() => {
  void refreshVecBackend();
  refreshModelWarning();
});
watch(() => apiSettings.vector.embedding.model, refreshModelWarning);

/* —— 索引维护:补齐 / 清空并重建 / 清空当前聊天索引 —— */
const vecIndexing = ref(false);
const vecIndexMsg = ref<Notice | null>(null);

/** 把一次同步的结果写成提示:不能索引写原因,失败写原因与已写入的条数,成功写做了什么。 */
function describeSync(result: VectorSyncResult, prefix = ''): Notice {
  if (result.skipped) return { tone: 'warn', text: `${prefix}没有补齐索引：${result.skipped}` };
  const parts = [
    result.embedded > 0 ? `写入 ${result.embedded} 条向量` : '',
    result.payloadUpdated > 0 ? `更新 ${result.payloadUpdated} 条原文或时间` : '',
  ].filter(Boolean);
  const failed = result.failedLeaves ?? [];
  const failedText = failed.length
    ? `另有 ${failed.length} 条摘要被 Embedding 接口拒收，已跳过（${failed.slice(0, 5).map(f => `#${f.floor}`).join('、')}${failed.length > 5 ? ' 等' : ''}）：${failed[0].reason}`
    : '';
  if (result.error) {
    const done = parts.length ? `已${parts.join('，')}，下次会从剩下的继续。` : '';
    return { tone: 'error', text: `${prefix}补齐索引没有完成：${result.error}${done}${failedText}` };
  }
  const main = parts.length ? `${prefix}已${parts.join('，')}。` : `${prefix}索引已是最新：当前聊天的摘要都已建立索引。`;
  return { tone: failed.length ? 'warn' : 'ok', text: main + failedText };
}

async function doRebuildIndex() {
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = null;
  resetVectorStoreProbe(); // 重测后端,确保索引落到当前真实可用的 store
  forgetRejectedLeaves(); // 手动补齐时,之前被接口拒收的摘要再试一次
  try {
    vecIndexMsg.value = describeSync(await syncVectorIndex());
  } catch (e) {
    vecIndexMsg.value = { tone: 'error', text: `补齐索引失败：${readableError(e, '请检查本卡片中 Embedding 的地址、密钥和模型后重试')}` };
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
    refreshModelWarning();
  }
}

// 清空并重建:换了 Embedding 模型后旧向量不可比,删掉当前聊天的索引后立即用当前模型重新生成。
const rebuildConfirmOpen = ref(false);
async function doClearAndRebuild() {
  rebuildConfirmOpen.value = false;
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = null;
  try {
    const { deleted, result } = await rebuildVectorIndex();
    vecIndexMsg.value = describeSync(result, `已清空 ${deleted} 条旧索引。`);
  } catch (e) {
    vecIndexMsg.value = { tone: 'error', text: `清空并重建失败：${readableError(e, '请稍后重试')}` };
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
    refreshModelWarning();
  }
}

// 清空当前聊天向量索引:破坏性操作,先弹确认框,确认后才清空。
const vecClearing = ref(false);
const clearConfirmOpen = ref(false);
async function doClearIndex() {
  clearConfirmOpen.value = false;
  if (vecClearing.value) return;
  vecClearing.value = true;
  vecIndexMsg.value = null;
  try {
    const n = await clearVectorIndex();
    vecIndexMsg.value = { tone: 'ok', text: `已清空当前聊天的向量索引（${n} 条）。下次召回前（或下一条摘要写入后）会自动重新建立，也可以点「补齐当前聊天索引」立即重建。` };
  } catch (e) {
    vecIndexMsg.value = { tone: 'error', text: `清空索引失败：${readableError(e, '请稍后重试')}` };
  } finally {
    vecClearing.value = false;
    void refreshVecBackend();
    refreshModelWarning();
  }
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="向量记忆" :open="false">
    <p class="prism-card-intro">从旧剧情中检索与当前剧情相关的片段，注入正文。Embedding 和 Query 重写为必填。Rerank 模型已预填，地址和密钥留空时沿用 Embedding；服务商不支持重排时请清空 Rerank 模型。没有重排时按 embedding 相似度排序，只发送摘要，不发送原文。</p>
    <label class="bbs-switch-row bbs-vec-enable">
      <span class="bbs-field-label">启用向量记忆</span>
      <input v-model="apiSettings.vector.enabled" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>

    <hr class="bbs-rule bbs-vec-enable-rule" />

    <!-- 三个端点:Embedding 必填;Rerank/Query 地址留空 = 整体复用 Embedding。 -->
    <VectorEndpoint v-for="role in VECTOR_ROLES" :key="role.key" :role="role.key" :label="role.label" />

    <hr class="bbs-rule" />

    <!-- 召回参数:机制说明 + 进阶旋钮整体折叠,默认收起,不淹没上方端点配置。 -->
    <Collapsible title="召回参数" :open="false">
      <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
        <p class="bbs-field-hint">
          先按 embedding 相似度从全部索引中选出得分最高的若干条（开启关键词召回时，名字匹配的本聊天摘要也作为候选），交给 rerank 打分后分两档：rerank 得分达到阈值的发送原文（含这一段里主角的发言和 AI 回复），超出「召回全文数」的改发摘要；其余 embedding 相似度达到阈值的发送摘要。两档合计不超过「最终召回条数」。没有重排时只按 embedding 相似度发送摘要。「记忆注入预算」为 0（默认，不限制）时召回内容不截断，已在历史摘要中原样发送的楼层不再按摘要召回；填写预算后召回占其中 15%（含固定说明文字）：原文放不下时改发这一段的摘要，摘要也放不下时不注入。
        </p>

        <p class="bbs-field-hint">生成前先用「Query 重写」模型将当前剧情改写为若干条检索语句，分别检索。<strong>此步骤为必需：未配置 Query 重写模型或重写失败时，本轮不召回。</strong>召回在正文生成前进行，等待期间可以点酒馆的停止键取消；Query 重写超时后不再重试（服务商出错或限流时按「失败重试次数」重试）。整次召回超过三个端点「超时 ×（重试次数 + 1）」之和仍未完成时放弃本轮召回。</p>

        <SettingRow kind="num" label="召回注入深度" hint="召回内容在聊天中的插入位置。0 表示紧邻最新一条用户消息，数字越大位置越靠前。">
          <input
            v-model.number="apiSettings.vector.recall.injectionDepth"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            step="1"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('injectionDepth')"
          />
        </SettingRow>

        <SettingRow kind="num" label="Rerank 候选数" hint="按 embedding 相似度取前若干条交给 rerank。数量越多越准确，也越慢。">
          <input
            v-model.number="apiSettings.vector.recall.rerankCandidates"
            class="bbs-input bbs-num"
            type="number"
            min="1"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('rerankCandidates')"
          />
        </SettingRow>

        <SettingRow kind="num" label="Embedding 阈值" hint="摘要档的门槛：没有达到 rerank 阈值（或本轮没有重排）的段落，embedding 相似度不低于该值时发送摘要（0–1）。阈值取决于 embedding 模型：默认值按 Qwen3 系列设定，换用其他模型后，参考「召回调试」中的分数调整。">
          <input
            v-model.number="apiSettings.vector.recall.embeddingThreshold"
            class="bbs-input bbs-num"
            type="number"
            step="0.01"
            min="0"
            max="1"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('embeddingThreshold')"
          />
        </SettingRow>

        <SettingRow kind="num" label="Rerank 阈值" hint="rerank 得分不低于该值的段落发送原文，超出「召回全文数」的改发摘要；低于该值的按 embedding 阈值决定是否发送摘要（0–1）。没有重排时不发送原文。">
          <input
            v-model.number="apiSettings.vector.recall.rerankThreshold"
            class="bbs-input bbs-num"
            type="number"
            step="0.01"
            min="0"
            max="1"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('rerankThreshold')"
          />
        </SettingRow>

        <SettingRow kind="num" label="召回全文数" hint="最多发送原文的条数；其余达到 rerank 阈值的段落改为发送摘要。">
          <input
            v-model.number="apiSettings.vector.recall.fullTextCount"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('fullTextCount')"
          />
        </SettingRow>

        <SettingRow kind="num" label="最终召回条数" hint="召回总数上限（原文和摘要合计）；原文不足时用摘要补充，未达上限也可。">
          <input
            v-model.number="apiSettings.vector.recall.finalRecallCount"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('finalRecallCount')"
          />
        </SettingRow>

        <SettingRow kind="num" label="开始召回的 AI 楼数" hint="AI 回复少于该数量时不召回（0 表示不限制）。剧情初期旧记忆较少，跳过可节省额度和时间。所有楼层仍在全文发送范围内时也会自动跳过；「带数据创建新对话」带来的旧档不受此限制，始终召回。">
          <input
            v-model.number="apiSettings.vector.recall.minAiFloors"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('minAiFloors')"
          />
        </SettingRow>

        <SettingRow label="关键词召回" hint="用名册、物品和地点的名字在本聊天摘要中精确匹配，作为一路候选与向量检索结果合并，减少自造人名、地名的漏召回。仅限本聊天，不含旧档。只由名字匹配到、相似度不够的段落：已重排时 rerank 得分达到阈值的一半即可按摘要发送；没有重排时每轮最多收 2 条。">
          <input v-model="apiSettings.vector.recall.keywordRoute" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="!apiSettings.vector.enabled" />
        </SettingRow>

        <SettingRow label="在场角色加权" hint="候选摘要涉及当前在场角色时排序靠前。只影响排序，不改变阈值。">
          <input v-model="apiSettings.vector.recall.presentBoost" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="!apiSettings.vector.enabled" />
        </SettingRow>

        <SettingRow kind="num" label="召回保留轮数" hint="上一轮注入的段落在之后的若干轮内，有空位时以摘要形式保留，减少召回内容逐轮变动。0 为关闭，最多 5。">
          <input
            v-model.number="apiSettings.vector.recall.stickyTurns"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            max="5"
            :disabled="!apiSettings.vector.enabled"
            @change="onRecallNumberChange('stickyTurns')"
          />
        </SettingRow>
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
          {{ vecBackend === 'backend' ? '柏宝库' : '本地' }}
        </span>
      </div>
      <p class="bbs-field-hint">每条摘要生成后自动加入索引；已有的摘要也会在召回前自动补入，长聊天第一次补齐时，那一次生成要多等一会儿，也可以点「补齐当前聊天索引」提前补齐。更换 Embedding 模型后旧向量不可比，需要「清空并重建」。清空只删除当前聊天的索引，不影响「带数据创建新对话」带来的旧档（旧档无法重建）。</p>
      <p v-if="vecBackend === 'local'" class="bbs-field-hint">
        本地模式：索引存储在浏览器中，只能在当前聊天召回，不跨聊天、不跨设备。安装柏宝库后端后可使用完整功能。
      </p>
      <p v-if="modelWarning" class="bbs-callout prism-inline-notice is-warning" role="status">{{ modelWarning }}</p>
      <div class="bbs-vec-index-actions">
        <button
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
          @click="doRebuildIndex"
        >
          {{ vecIndexing ? '索引中…' : '补齐当前聊天索引' }}
        </button>
        <button
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
          @click="rebuildConfirmOpen = true"
        >
          清空并重建
        </button>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-danger"
          type="button"
          :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
          @click="clearConfirmOpen = true"
        >
          <Icon name="trash" />
          {{ vecClearing ? '清空中…' : '清空当前聊天索引' }}
        </button>
      </div>
      <p v-if="vecIndexMsg" class="bbs-callout prism-inline-notice" :class="TONE_CLASS[vecIndexMsg.tone]" role="status">{{ vecIndexMsg.text }}</p>
    </div>

    <ConfirmDialog
      v-model:open="rebuildConfirmOpen"
      title="清空并重建当前聊天索引"
      confirm-text="清空并重建"
      tone="danger"
      @confirm="doClearAndRebuild"
    >
      删除当前聊天的向量索引，随即用当前的 Embedding 模型重新生成全部向量；「带数据创建新对话」带来的旧档不受影响。长聊天需要一些时间，期间生成回复时召回会先用已建好的部分，其余在后台继续补齐。
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="clearConfirmOpen"
      title="清空当前聊天索引"
      confirm-text="清空"
      confirm-icon="trash"
      tone="danger"
      @confirm="doClearIndex"
    >
      删除当前聊天的向量索引，「带数据创建新对话」带来的旧档不受影响。清空后会自动重建：下次召回前（或下一条摘要写入后）重新生成全部向量，长聊天的这一次生成要多等一会儿。
    </ConfirmDialog>
  </Collapsible>
</template>

<style scoped>
/* 「启用向量记忆」是折叠区里独一行开关,不再额外加上 padding,贴合标题节奏 */
.bbs-vec-enable {
  padding-top: 0;
}
/* 紧跟开关行的分割线收掉上边距:开关行自带 8px 下 padding 已够,避免整块显得空旷 */
.bbs-vec-enable-rule {
  margin-top: 0;
}
/* 关闭向量记忆时：输入框与开关各自显示停用状态（settings.css），这里只把「索引维护」标题改为次要色；
   不降整体透明度，保证说明文字的对比度。 */
.bbs-vec-recall.is-disabled .bbs-vec-head .bbs-field-label {
  color: var(--bbs-ink-muted);
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
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border: 1px solid var(--bbs-line);
}
/* 索引维护:重建/清空按钮并排,窄屏自动换行 */
.bbs-vec-index-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
@container prism-settings (max-width: 520px) {
  .bbs-vec-index-actions .bbs-btn { width: 100%; justify-content: center; white-space: normal; }
}
</style>
