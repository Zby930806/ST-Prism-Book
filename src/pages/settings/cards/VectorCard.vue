<script setup lang="ts">
/* 向量记忆：从旧剧情中检索相关片段注入正文。三个端点、召回参数与索引维护；上一次召回的过程见「召回调试」卡片。 */
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings, type resolveVectorModel } from '@/api/settings';
import { clearVectorIndex, syncVectorIndex } from '@/memory/vector';
import { resetVectorStoreProbe, vectorBackendKind } from '@/memory/vector/store';
import { onMounted, ref } from 'vue';
import { readableError } from '../notice';
import SettingRow from '../SettingRow.vue';
import VectorEndpoint from './VectorEndpoint.vue';

/* —— 向量记忆:三个模型角色,embedding 为基准,后两者留空复用它 —— */
const VECTOR_ROLES: { key: Parameters<typeof resolveVectorModel>[0]; label: string }[] = [
  { key: 'embedding', label: 'Embedding（向量化，必填）' },
  { key: 'rerank', label: 'Rerank（重排，可不填）' },
  { key: 'queryRewrite', label: 'Query 重写（必填）' },
];

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

/* —— 索引维护:手动重建当前聊天向量索引 —— */
const vecIndexing = ref(false);
const vecIndexMsg = ref('');
const vecIndexError = ref(false);
async function doRebuildIndex() {
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = '';
  vecIndexError.value = false;
  resetVectorStoreProbe(); // 重测后端,确保索引落到当前真实可用的 store
  try {
    const result = await syncVectorIndex();
    const parts = [
      result.embedded > 0 ? `重新生成 ${result.embedded} 条向量` : '',
      result.payloadUpdated > 0 ? `更新 ${result.payloadUpdated} 条全文/时间` : '',
    ].filter(Boolean);
    vecIndexMsg.value = parts.length ? `已${parts.join('，')}。` : '索引已是最新。';
  } catch (e) {
    vecIndexError.value = true;
    vecIndexMsg.value = `重建索引失败：${readableError(e, '请检查本卡片中 Embedding 的地址、密钥和模型后重试')}`;
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
  }
}

// 清空当前聊天向量索引:破坏性操作,先弹确认框,确认后才清空。
const vecClearing = ref(false);
const clearConfirmOpen = ref(false);
async function doClearIndex() {
  clearConfirmOpen.value = false;
  if (vecClearing.value) return;
  vecClearing.value = true;
  vecIndexMsg.value = '';
  vecIndexError.value = false;
  try {
    const n = await clearVectorIndex();
    vecIndexMsg.value = `已清空当前聊天的向量索引（${n} 条）。需要时点击「重建当前聊天向量索引」重新索引。`;
  } catch (e) {
    vecIndexError.value = true;
    vecIndexMsg.value = `清空索引失败：${readableError(e, '请稍后重试')}`;
  } finally {
    vecClearing.value = false;
    void refreshVecBackend();
  }
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="向量记忆" :open="false">
    <p class="prism-card-intro">从旧剧情中检索与当前剧情相关的片段，注入正文。Embedding 和 Query 重写为必填；Rerank 可不填，不填时按相似度排序。</p>
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
          先按 embedding 相似度从全部索引中选出得分最高的若干条（开启关键词召回时，名字匹配的本聊天摘要也作为候选），交给 rerank 打分，再分为两档：得分高的发送原文，稍低但达到 embedding 阈值的发送摘要。两档合计不超过「最终召回条数」。召回内容占「记忆注入预算」的 15%（默认约 600 字）：原文放不下时改发这一段的摘要，摘要也放不下时不注入。
        </p>

        <p class="bbs-field-hint">生成前先用「Query 重写」模型将当前剧情改写为若干条检索语句，分别检索。<strong>此步骤为必需：未配置 Query 重写模型或重写失败时，本轮不召回。</strong>每轮增加一次小模型请求，延迟略有增加。</p>

        <SettingRow kind="num" label="召回注入深度" hint="召回内容在聊天中的插入位置。0 表示紧邻最新一条用户消息，数字越大位置越靠前。">
          <input
            v-model.number="apiSettings.vector.recall.injectionDepth"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            step="1"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow kind="num" label="Rerank 候选数" hint="按 embedding 相似度取前若干条交给 rerank。数量越多越准确，也越慢。">
          <input
            v-model.number="apiSettings.vector.recall.rerankCandidates"
            class="bbs-input bbs-num"
            type="number"
            min="1"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow kind="num" label="Embedding 阈值" hint="摘要档的门槛：embedding 相似度低于该值时不召回（0–1）。">
          <input
            v-model.number="apiSettings.vector.recall.embeddingThreshold"
            class="bbs-input bbs-num"
            type="number"
            step="0.01"
            min="0"
            max="1"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow kind="num" label="Rerank 阈值" hint="rerank 得分不低于该值时发送原文；低于该值但达到 embedding 阈值时发送摘要（0–1）。">
          <input
            v-model.number="apiSettings.vector.recall.rerankThreshold"
            class="bbs-input bbs-num"
            type="number"
            step="0.01"
            min="0"
            max="1"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow kind="num" label="召回全文数" hint="最多发送原文的条数；超出部分即使达到 rerank 阈值也改为发送摘要。">
          <input
            v-model.number="apiSettings.vector.recall.fullTextCount"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow kind="num" label="最终召回条数" hint="召回总数上限（原文和摘要合计）；原文不足时用摘要补充，未达上限也可。">
          <input
            v-model.number="apiSettings.vector.recall.finalRecallCount"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow kind="num" label="开始召回的 AI 楼数" hint="AI 回复少于该数量时不召回（0 表示不限制）。剧情初期旧记忆较少，跳过可节省额度和时间。所有楼层仍在全文发送范围内时也会自动跳过；「带数据创建新对话」带来的旧档不受此限制，始终召回。">
          <input
            v-model.number="apiSettings.vector.recall.minAiFloors"
            class="bbs-input bbs-num"
            type="number"
            min="0"
            :disabled="!apiSettings.vector.enabled"
          />
        </SettingRow>

        <SettingRow label="关键词召回" hint="用名册、物品和地点的名字在本聊天摘要中精确匹配，作为一路候选与向量检索结果合并，减少自造人名、地名的漏召回。仅限本聊天，不含旧档。">
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
      <p class="bbs-field-hint">每条摘要生成后自动加入索引；中途开启向量记忆时，可手动将当前聊天已有的摘要补入索引。清空只删除当前聊天的索引，不影响「带数据创建新对话」带来的旧档。</p>
      <p v-if="vecBackend === 'local'" class="bbs-field-hint">
        本地模式：索引存储在浏览器中，只能在当前聊天召回，不跨聊天、不跨设备。安装柏宝库后端后可使用完整功能。
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
          @click="clearConfirmOpen = true"
        >
          <Icon name="trash" />
          {{ vecClearing ? '清空中…' : '清空当前聊天索引' }}
        </button>
      </div>
      <p v-if="vecIndexMsg" class="bbs-callout prism-inline-notice" :class="vecIndexError ? 'is-danger' : 'is-success'" role="status">{{ vecIndexMsg }}</p>
    </div>

    <ConfirmDialog
      v-model:open="clearConfirmOpen"
      title="清空当前聊天索引"
      confirm-text="清空"
      confirm-icon="trash"
      tone="danger"
      @confirm="doClearIndex"
    >
      删除当前聊天的向量索引，「带数据创建新对话」带来的旧档不受影响。清空后召回不到本聊天的内容，点击「重建当前聊天向量索引」可重新建立。
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
