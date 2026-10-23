<script setup lang="ts">
/* 注入设置：生成正文时注入的记忆，预算总量及包含的状态。份额的分配见 memory/budget.ts 的 budgetLayout。 */
import Collapsible from '@/components/Collapsible.vue';
import { apiSettings, normalizeMemoryBudgetTokens } from '@/api/settings';
import { fitTimeTagPrompt } from '@/memory/budget';
import { timeTagPrompt } from '@/memory/timeTag';
import { computed } from 'vue';
import SettingRow from '../SettingRow.vue';

/** 时间标签提示词超出预算中留给它的上限（启用自动摘要时才发送，才需要提醒）。内置版本总能放下，只有过长的自定义版本会超出。 */
const timeTagOverBudget = computed(() => apiSettings.autoSummaryEnabled && !fitTimeTagPrompt(timeTagPrompt()));
/** 预算输完（失焦或回车）再规整：清空按 0（不限制），其他值钳到 2000–50000。 */
function onBudgetChange() {
  apiSettings.memoryBudgetTokens = normalizeMemoryBudgetTokens(apiSettings.memoryBudgetTokens);
}
</script>

<template>
  <!-- 卡片默认收起；只有时间标签提示词超出预算时自动展开，免得警告藏在收起的卡片里 -->
  <Collapsible class="prism-settings-card" title="注入设置" :open="timeTagOverBudget">
    <p class="prism-card-intro">生成正文时注入的记忆：预算总量及包含的状态。</p>
    <p v-if="timeTagOverBudget" class="bbs-callout is-warning">自定义的时间标签提示词超过了预算中留给它的上限（内置版本的长度与预算的 5% 中较大者），目前整段未发送。请缩短自定义内容，或将预算填 0（不限制）。</p>
    <SettingRow
      kind="num"
      label="记忆注入预算"
      hint="默认 0，即不限制。需要控制注入量时填写数值，最少按 2000 计算；超出时整条省略，不删除存档。"
      details="填写数值后才生效。按 UTF-8 字节粗略估算，与模型实际 token 数不完全一致。先按实际长度预留时间标签指令（开启自动摘要时）和只读账本说明（发给正文模型的消息里有物品或变量旁注时），其余按历史 45%、状态 40%、召回 15% 分配；向量记忆关闭或本聊天这次不召回时，召回的份额并入历史。历史放不下时，先保留覆盖故事开头的最高层总结（不超过历史份额的约三分之一），其余从新到旧连续保留，并注明省略了哪段时间。内置时间标签指令总能放下；自定义的时间标签提示词超过上限时整段不发送。预算不包括聊天正文、角色卡和其他插件。填写预算后，双子札记注入的已确认安排最多 16000 字（进行中的优先、待兑现的新的优先），创作规划和规划讨论读取的摘要和总结（约 7800 字）、状态（约 4200 字）、札记安排（约 1500 字）也按各自上限读取；为 0 时这些都不限制。修改预算后，上次的向量召回结果会清空，下次生成时重新计算。"
    >
      <input v-model.number="apiSettings.memoryBudgetTokens" class="bbs-input bbs-num" type="number" min="0" max="50000" step="500" @change="onBudgetChange" />
    </SettingRow>
    <p class="bbs-field-hint">以下开关选择注入正文的状态，<strong>只影响正文模型看到的内容</strong>：摘要请求始终包含全部状态并照常记录，关闭某项不会造成重复记录。时间地点、计划悬念和自定义变量不受下列开关控制（开启「仅注入剧情摘要」时同样不发送）。</p>

    <SettingRow
      label="仅注入剧情摘要"
      hint="适用于自带变量系统的角色卡。启用后，当前状态（时间地点、局势、主角、角色、物品、场景、计划、变量、生活档案、信息差和伤势提醒）不再注入正文，以下各项开关随之失效。"
      details="这些内容照常分析、保存并在棱镜宝书中显示；之后的楼层不再写入物品和变量的变动旁注。已有楼层中的旁注不会清理；场景页的「前往」不受影响。"
    >
      <input v-model="apiSettings.summaryOnlyMode" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </SettingRow>

    <hr class="bbs-rule" />

    <SettingRow label="眼下局势" hint="互动局势卡：当前局面、在场人物、互动张力和即将发生的事，用于衔接当前场面。">
      <input v-model="apiSettings.injection.sceneFocus" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>

    <SettingRow label="生活档案" hint="主角和主要角色的生活档案：置顶条目（最多 5 条）始终发送，其余条目每轮补到合计 6 条（置顶多时至少再发 3 条），关键词出现在最近正文中的优先。档案始终记录（可在角色页管理），此处关闭后不再注入正文，重新开启即恢复。">
      <input v-model="apiSettings.injection.lifeDetails" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>

    <SettingRow label="主角信息" hint="主角当前的性别、年龄、身份、外貌、着装和状态。不依赖场景信息。">
      <input v-model="apiSettings.injection.protagonist" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>

    <SettingRow label="场景信息">
      <input v-model="apiSettings.injection.scenes" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
      <template #hint>当前地点及其上级地点（详细），以及其他已知地点（仅名称）。<strong>NPC 名册、物品信息和信息差依赖场景判断在场与可及范围，关闭此项后三者也不发送。</strong></template>
    </SettingRow>

    <SettingRow label="NPC 名册" hint="主要角色发送档案与当前状态；NPC 在场的发送完整信息，同一区域的从简；位置已过期、但最后确认在主角所在处或附近的单独列出；其余不在场的只发送有名字者的一行简要信息：最近正文提到名字的一律发送并排在最前，其余按最近出场补足到 24 人。需开启场景信息。">
      <input v-model="apiSettings.injection.npcs" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow label="角色好感估计" hint="NPC 名册中的五档好感（内心好感、外在态度和说明）。好感始终记录并在角色页显示；关闭后名册照常发送，但不附带好感。适用于自带好感系统的角色卡。需开启 NPC 名册和场景信息。">
      <input v-model="apiSettings.injection.npcAffinity" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.npcs || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow label="物品信息" hint="随身和可及的物品发送完整信息，存放在别处的只发送名字和数量。需开启场景信息。">
      <input v-model="apiSettings.injection.items" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow label="信息差" hint="提醒在场的角色哪些事不知情，避免其说出或依据自己不知道的事行动。每次最多 12 条，不知情者里有在场角色的优先，其余按记录从新到旧。信息差始终记录，可在角色页查看；需开启 NPC 名册和场景信息。">
      <input v-model="apiSettings.injection.secrets" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.npcs || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow
      label="伤势进展提醒"
      hint="主角、主要角色及在场、同区域角色的伤情记录超过一天未更新时，提醒正文模型在写到伤处或相关行动时按轻重写出进展，与本轮无关时不必提及；没有故事时间时按回复楼层数计算。伤情记录更新后重新计时。"
      details="只提醒随正文发送的角色：主角需开启「主角信息」，其他角色需开启「NPC 名册」。按故事时间超过七天时，提醒轻伤多半已好转或痊愈、重伤仍在恢复，按伤情轻重体现；超过三十天时，提醒除长期伤病或后遗症外应已痊愈。没有故事时间时按回复楼层数判断，只发一级中性提醒，不会因楼层增加而加重。提醒只影响正文模型看到的内容，伤情记录本身仍以正文为准更新。"
    >
      <input v-model="apiSettings.injection.injuryReminder" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>
  </Collapsible>
</template>
