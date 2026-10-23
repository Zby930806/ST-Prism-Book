<script setup lang="ts">
/* 摘要设置：摘要时机、摘要篇幅、全文保留范围、总结合并频率、失败重试次数、跟随主 API 时的请求参数和回看原文补全角色档案。 */
import BbsSelect from '@/components/BbsSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import { mainApiTokenState } from '@/api/client';
import {
  apiSettings,
  MAIN_API_FALLBACK_TOKENS,
  MAIN_API_MAX_TOKENS_MAX,
  MAIN_API_MAX_TOKENS_MIN,
  normalizeKeepRecent,
  normalizeMainApiMaxTokens,
  normalizeNonNegativeInt,
  normalizeSummaryMaxChars,
  normalizeSummaryThreshold,
  SUMMARY_MAX_CHARS_MAX,
  SUMMARY_MAX_CHARS_MIN,
  type Verbosity,
} from '@/api/settings';
import { resummaryWordsRange } from '@/memory/prompts';
import { computed } from 'vue';
import SettingRow from '../SettingRow.vue';

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'detailed', label: '详细' },
  { value: 'concise', label: '精简' },
];

/* 数字输入框输完（失焦或回车）再规整：清空或填了范围外的数时回到有效值，输入过程中不打断。
   与载入设置时的规整相同（settings.ts）；总结阈值填 1 与 0 一样不会总结，统一改成 0。 */
function onSummaryMaxCharsChange() {
  apiSettings.summaryMaxChars = normalizeSummaryMaxChars(apiSettings.summaryMaxChars, apiSettings.verbosity);
}
const commit = {
  keepRecent: () => { apiSettings.keepRecent = normalizeKeepRecent(apiSettings.keepRecent); },
  leafBatchThreshold: () => { apiSettings.leafBatchThreshold = normalizeSummaryThreshold(apiSettings.leafBatchThreshold, 12); },
  leafKeepRecent: () => { apiSettings.leafKeepRecent = normalizeNonNegativeInt(apiSettings.leafKeepRecent, 3); },
  resummaryThreshold: () => { apiSettings.resummaryThreshold = normalizeSummaryThreshold(apiSettings.resummaryThreshold, 6); },
  higherResummaryThreshold: () => { apiSettings.higherResummaryThreshold = normalizeSummaryThreshold(apiSettings.higherResummaryThreshold, 3); },
  recentResolvedPlansCount: () => { apiSettings.recentResolvedPlansCount = normalizeNonNegativeInt(apiSettings.recentResolvedPlansCount, 5); },
  summaryMaxRetries: () => { apiSettings.summaryMaxRetries = normalizeNonNegativeInt(apiSettings.summaryMaxRetries, 1); },
  mainApiMaxTokens: () => { apiSettings.mainApiMaxTokens = normalizeMainApiMaxTokens(apiSettings.mainApiMaxTokens); },
};

/**
 * 当前总结（L1）的目标字数，直接取内置总结提示词用的值（prompts.ts 的 resummaryWordsRange）：
 * 摘要字数高于 300 时按同一比例放大，最多 3 倍；不超过 300 时不变（两档同一基准，精简档始终是详细档的一半）。
 */
const resummaryRange = computed(() => {
  const { min, max } = resummaryWordsRange();
  return `${min}–${max}`;
});
</script>

<template>
  <Collapsible class="prism-settings-card" title="摘要设置" :open="false">
    <p class="prism-card-intro">摘要时机、摘要篇幅、全文保留范围、总结合并频率、失败重试次数、跟随主 API 时的请求参数和角色档案补全。</p>
    <SettingRow label="启用自动摘要" hint="启用后自动摘要并隐藏旧楼层，同时启用正文时间标签（剧情时间的锚点）和积压拦截（有楼层漏摘时拦截发送并提示补摘）。">
      <input v-model="apiSettings.autoSummaryEnabled" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </SettingRow>
    <SettingRow
      label="回复结束后立即摘要"
      hint="默认在发送下一条消息时才为上一条回复写摘要。打开后，AI 回复生成结束就开始写摘要。需开启「启用自动摘要」。"
      details="之后重抽或翻页生成新回复时，已写的摘要作废，新回复结束后重写，每次多用一个请求。续写这条回复时，续写结束后按新内容重写；编辑这条回复时，发送下一条消息时按新内容重写。摘要在后台进行，不影响继续聊天。"
    >
      <input v-model="apiSettings.summarizeOnReplyEnd" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="!apiSettings.autoSummaryEnabled" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="摘要字数"
      :hint="`写入摘要提示词，要求每楼摘要不超过该字数（含标点）。默认 300，可填 ${SUMMARY_MAX_CHARS_MIN}–${SUMMARY_MAX_CHARS_MAX}。`"
      details="信息较少时会更短。只约束模型生成，不限制保存：模型超出或手动改长均照常保存。仅对内置摘要提示词生效。高于 300 时，总结（L1）的字数随之按比例放大，最多 3 倍，见「字数档位」。"
    >
      <input v-model.number="apiSettings.summaryMaxChars" class="bbs-input bbs-num" type="number" :min="SUMMARY_MAX_CHARS_MIN" :max="SUMMARY_MAX_CHARS_MAX" @change="onSummaryMaxCharsChange" />
    </SettingRow>
    <SettingRow
      kind="num"
      as="div"
      label="字数档位"
      :hint="`调整总结和二次总结的篇幅，仅影响内置提示词。当前总结（L1）为 ${resummaryRange} 字。`"
      details="详细：总结 300–500 字，二次总结约为输入的 40%–50%；精简：总结 150–300 字，二次总结约为 30%–40%。「摘要字数」高于 300 时，两档的总结字数都按同一比例放大，最多 3 倍，例如摘要字数 600 时，详细档总结为 600–1000 字、精简档为 300–600 字；信息较少时可更短。已生成的总结不会重写。每楼摘要的字数由上方「摘要字数」决定。"
    >
      <BbsSelect v-model="apiSettings.verbosity" :options="VERBOSITY_OPTIONS" class="bbs-select-narrow" aria-label="字数档位" />
    </SettingRow>
    <SettingRow kind="num" label="保留最近 AI 消息数" hint="最近若干条 AI 回复保留全文发送；更早的楼层自动隐藏，改为发送摘要。默认 3。">
      <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" @change="commit.keepRecent" />
    </SettingRow>
    <SettingRow kind="num" label="每次总结几条摘要" hint="摘要达到该数量时合并为一条总结（不计用户楼层）。填 0 关闭自动总结，默认 12。">
      <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" @change="commit.leafBatchThreshold" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="总结时保留摘要数"
      hint="总结时保留最新的若干条摘要不合并。默认 3。"
      details="例如每次总结 12 条、此处填 3：摘要达到 15 条时合并最旧的 12 条，保留最新 3 条。保留的摘要包含仍在「保留最近 AI 消息数」范围内、以全文发送的楼层，默认设置下总结当轮注入的近期摘要可能一条都没有；之后这些楼层依次移出全文范围，改为以摘要注入。填 0 时达到数量后全部合并（旧版做法）。"
    >
      <input v-model.number="apiSettings.leafKeepRecent" class="bbs-input bbs-num" type="number" min="0" @change="commit.leafKeepRecent" />
    </SettingRow>
    <SettingRow kind="num" label="二次总结" hint="L1 总结达到该数量时合并为一条 L2。填 0 关闭，默认 6。">
      <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" @change="commit.resummaryThreshold" />
    </SettingRow>
    <SettingRow kind="num" label="高层总结" hint="L2 及更高层的总结达到该数量时再向上合并一层。层级越高内容越长，建议填较小的值。填 0 关闭，默认 3。">
      <input v-model.number="apiSettings.higherResummaryThreshold" class="bbs-input bbs-num" type="number" min="0" @change="commit.higherResummaryThreshold" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="附带近期已完成计划"
      hint="在状态中附上最近了结的计划和悬念，避免模型把已了结的事项当作未完成而继续推进或重复记录。默认 5，填 0 不附带。"
      details="正文和摘要请求都会附带。计划、悬念各取最近若干条（填 5 即各最多 5 条）。"
    >
      <input v-model.number="apiSettings.recentResolvedPlansCount" class="bbs-input bbs-num" type="number" min="0" @change="commit.recentResolvedPlansCount" />
    </SettingRow>
    <SettingRow kind="num" label="失败重试次数" hint="摘要或总结失败（报错或返回内容无法解析）时的最多重试次数。密钥错误、额度不足、输出被截断等重试无效的错误不重试。最后一次尝试中不合格的单项更新只去掉该项，摘要和其余内容照常保存。填 0 不重试，默认 1。">
      <input v-model.number="apiSettings.summaryMaxRetries" class="bbs-input bbs-num" type="number" min="0" @change="commit.summaryMaxRetries" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="跟随主 API 时的最大回复"
      :hint="`摘要或总结没有指派副 API 渠道时，请求期间把酒馆主 API 的最大回复临时设为这个值（tokens）。默认 32000，可填 ${MAIN_API_MAX_TOKENS_MIN}–${MAIN_API_MAX_TOKENS_MAX}，不能超过模型的单次输出上限。`"
      :details="`酒馆会把这个值原样作为 max_tokens 发给服务商，超过模型上限时请求会被拒绝；部分模型的单次输出上限只有 8192、16384 或 32000。设置值大于 ${MAIN_API_FALLBACK_TOKENS} 时，首次请求失败后改用 ${MAIN_API_FALLBACK_TOKENS} 重试一次，成功后本次会话内沿用 ${MAIN_API_FALLBACK_TOKENS}，修改此项后恢复按设置值请求。思考型模型的思考过程也计入输出，设得过小时摘要会被截断。不影响酒馆主 API 自己的回复长度设置。`"
    >
      <input v-model.number="apiSettings.mainApiMaxTokens" class="bbs-input bbs-num" type="number" :min="MAIN_API_MAX_TOKENS_MIN" :max="MAIN_API_MAX_TOKENS_MAX" step="1024" @change="commit.mainApiMaxTokens" />
    </SettingRow>
    <p v-if="mainApiTokenState.fallback" class="bbs-callout is-warning" role="status">
      跟随主 API 的请求在最大回复为 {{ apiSettings.mainApiMaxTokens }} 时失败，改用 {{ mainApiTokenState.fallback }} 后成功，本次会话之后的请求都使用 {{ mainApiTokenState.fallback }}。修改上面的数值后恢复按设置值请求。
    </p>
    <SettingRow
      label="跟随主 API 时发送预填充"
      hint="摘要或总结没有指派副 API 渠道时，请求末尾附带一条 assistant 预填充消息，引导模型先写核对过程。默认开启；主 API 的接口报错提及 prefill 或要求最后一条为用户消息时关闭。"
    >
      <input v-model="apiSettings.mainApiPrefill" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </SettingRow>
    <SettingRow
      label="回看原文补全角色档案"
      hint="摘要时，新登场或被提到的角色缺外貌、身份或性别，从之前的楼层查找原文补全，每次补全多发送一个请求。关闭后不再自动补全，已补全的内容保留；角色卡上的「从原文补全」照常可用。"
      details="只检索该角色首次记录之前最近 40 个回复楼层（含已隐藏的楼层，不含番外楼），没有找到原文时不发送请求。每个角色自动补全一次，失败最多再试一次，失败不影响摘要。请求使用摘要任务的 API。"
    >
      <input v-model="apiSettings.npcEnrichAuto" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </SettingRow>
    <p class="bbs-field-hint">批量补摘按楼层顺序逐楼进行，每楼的人物、物品、计划保存后才处理下一楼；遇到失败即停止（较早楼层合并摘要的一组没写全时，先保存写好的楼层，其余拆小重试），取消在当前楼层完成后生效。</p>
  </Collapsible>
</template>

<style scoped>
/* 短选项下拉(如字数档位):贴合文字的窄宽,和右侧数字框对齐,不再撑满半行。
   带父级压过组件根的 width:100%——两者同特异度时靠样式表先后决定胜负,那取决于打包顺序,不可靠 */
.bbs-num-row .bbs-select-narrow {
  width: auto;
  min-width: 65px;
  max-width: 150px;
}
.bbs-select-narrow :deep(.bbs-select-trigger) {
  font-size: 12px;
}
</style>
