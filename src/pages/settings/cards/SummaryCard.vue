<script setup lang="ts">
/* 摘要设置：摘要篇幅、全文保留范围、总结合并频率和失败重试次数。 */
import BbsSelect from '@/components/BbsSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import {
  apiSettings,
  normalizeSummaryMaxChars,
  SUMMARY_MAX_CHARS_MAX,
  SUMMARY_MAX_CHARS_MIN,
  type Verbosity,
} from '@/api/settings';
import SettingRow from '../SettingRow.vue';

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'detailed', label: '详细' },
  { value: 'concise', label: '精简' },
];

/** 摘要字数输完(失焦/回车)再规整:清空或填了范围外的数,回到有效值,输入过程中不打断。 */
function onSummaryMaxCharsChange() {
  apiSettings.summaryMaxChars = normalizeSummaryMaxChars(apiSettings.summaryMaxChars, apiSettings.verbosity);
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="摘要设置" :open="false">
    <p class="prism-card-intro">摘要篇幅、全文保留范围、总结合并频率和失败重试次数。</p>
    <SettingRow label="启用自动摘要" hint="启用后自动摘要并隐藏旧楼层，同时启用正文时间标签（剧情时间的锚点）和积压拦截（有楼层漏摘时拦截发送并提示补摘）。">
      <input v-model="apiSettings.autoSummaryEnabled" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="摘要字数"
      :hint="`写入摘要提示词，要求每楼摘要不超过该字数（含标点）。默认 300，可填 ${SUMMARY_MAX_CHARS_MIN}–${SUMMARY_MAX_CHARS_MAX}。`"
      details="信息较少时会更短。只约束模型生成，不限制保存：模型超出或手动改长均照常保存。仅对内置摘要提示词生效。"
    >
      <input v-model.number="apiSettings.summaryMaxChars" class="bbs-input bbs-num" type="number" :min="SUMMARY_MAX_CHARS_MIN" :max="SUMMARY_MAX_CHARS_MAX" @change="onSummaryMaxCharsChange" />
    </SettingRow>
    <SettingRow
      kind="num"
      as="div"
      label="字数档位"
      hint="调整总结和二次总结的篇幅，仅影响内置提示词。"
      details="详细：总结 300–500 字，二次总结约为输入的 40%–50%；精简：总结 150–300 字，二次总结约为 30%–40%。每楼摘要的字数由上方「摘要字数」决定。"
    >
      <BbsSelect v-model="apiSettings.verbosity" :options="VERBOSITY_OPTIONS" class="bbs-select-narrow" aria-label="字数档位" />
    </SettingRow>
    <SettingRow kind="num" label="保留最近 AI 消息数" hint="最近若干条 AI 回复保留全文发送；更早的楼层自动隐藏，改为发送摘要。">
      <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <SettingRow kind="num" label="每次总结几条摘要" hint="摘要达到该数量时合并为一条总结（不计用户楼层）。填 0 关闭自动总结。">
      <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="总结时保留摘要数"
      hint="总结时保留最新的若干条摘要不合并，使总结后仍保留近期细节。默认 3。"
      details="例如每次总结 12 条、此处填 3：摘要达到 15 条时合并最旧的 12 条，保留最新 3 条。填 0 时达到数量后全部合并（旧版做法）。"
    >
      <input v-model.number="apiSettings.leafKeepRecent" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <SettingRow kind="num" label="二次总结" hint="L1 总结达到该数量时合并为一条 L2。填 0 关闭，默认 6。">
      <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <SettingRow kind="num" label="高层总结" hint="L2 及更高层的总结达到该数量时再向上合并一层。层级越高内容越长，建议填较小的值。填 0 关闭，默认 3。">
      <input v-model.number="apiSettings.higherResummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <SettingRow
      kind="num"
      label="附带近期已完成计划"
      hint="在状态中附上最近了结的计划和悬念，避免模型把已了结的事项当作未完成而继续推进或重复记录。默认 5，填 0 不附带。"
      details="正文和摘要请求都会附带。计划、悬念各取最近若干条（填 5 即各最多 5 条）。"
    >
      <input v-model.number="apiSettings.recentResolvedPlansCount" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <SettingRow kind="num" label="失败重试次数" hint="摘要或总结失败（报错或返回内容无法解析）时的最多重试次数。密钥错误、额度不足、输出被截断等重试无效的错误不重试。填 0 不重试，默认 1。">
      <input v-model.number="apiSettings.summaryMaxRetries" class="bbs-input bbs-num" type="number" min="0" />
    </SettingRow>
    <p class="bbs-field-hint">批量补摘按楼层顺序逐楼进行，每楼的人物、物品、计划保存后才处理下一楼；遇到失败即停止，取消在当前楼层完成后生效。</p>
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
