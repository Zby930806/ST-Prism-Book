<script setup lang="ts">
/* 注入设置：生成正文时注入的记忆，预算总量及包含的状态。 */
import Collapsible from '@/components/Collapsible.vue';
import { apiSettings } from '@/api/settings';
import { fitTimeTagPrompt } from '@/memory/budget';
import { timeTagPrompt } from '@/memory/timeTag';
import { computed } from 'vue';
import SettingRow from '../SettingRow.vue';

/** 时间标签提示词超出预算中分配给它的份额（启用自动摘要时才发送，才需要提醒）。 */
const timeTagOverBudget = computed(() => apiSettings.autoSummaryEnabled && !fitTimeTagPrompt(timeTagPrompt()));
</script>

<template>
  <!-- 卡片默认收起；只有时间标签提示词超出预算时自动展开，免得警告藏在收起的卡片里 -->
  <Collapsible class="prism-settings-card" title="注入设置" :open="timeTagOverBudget">
    <p class="prism-card-intro">生成正文时注入的记忆：预算总量及包含的状态。</p>
    <p v-if="timeTagOverBudget" class="bbs-callout is-warning">时间标签提示词超出预算中分配给它的份额，目前整段未发送。请调高预算，或缩短自定义的时间标签提示词。</p>
    <SettingRow
      kind="num"
      label="记忆注入预算"
      hint="默认 6000；填 0 不限制，其他值最少按 2000 计算。超出时整条省略，不删除存档。"
      details="按 UTF-8 字节粗略估算，与模型实际 token 数不完全一致。历史、状态、时间指令、召回分别占 45%、35%、5%、15%，未用完的份额不挪给其他部分；时间指令过长时整段不发送。预算不包括聊天正文、角色卡和其他插件。修改预算后，上次的向量召回结果会清空，下次生成时重新计算。"
    >
      <input v-model.number="apiSettings.memoryBudgetTokens" class="bbs-input bbs-num" type="number" min="0" max="50000" step="500" />
    </SettingRow>
    <p class="bbs-field-hint">以下开关选择注入正文的状态，<strong>只影响正文模型看到的内容</strong>：摘要请求始终包含全部状态并照常记录，关闭某项不会造成重复记录。时间地点、计划悬念和自定义变量始终发送，不在此处开关。</p>

    <SettingRow
      label="仅注入剧情摘要"
      hint="适用于自带变量系统的角色卡。启用后，物品、角色、场景、计划和变量不再注入正文，以下各项开关随之失效。"
      details="这些内容照常分析、保存并在棱镜宝书中显示；之后的楼层不再写入物品和变量的变动旁注。已有楼层中的旁注不会清理；场景页的「前往」不受影响。"
    >
      <input v-model="apiSettings.summaryOnlyMode" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </SettingRow>

    <hr class="bbs-rule" />

    <SettingRow label="眼下局势" hint="互动局势卡：当前局面、在场人物、互动张力和即将发生的事，用于衔接当前场面。">
      <input v-model="apiSettings.injection.sceneFocus" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>

    <SettingRow label="生活档案" hint="主角和主要角色的生活档案。档案始终记录（可在角色页管理），此处关闭后不再注入正文，重新开启即恢复。">
      <input v-model="apiSettings.injection.lifeDetails" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>

    <SettingRow label="主角信息" hint="主角当前的性别、年龄、身份、外貌、着装和状态。不依赖场景信息。">
      <input v-model="apiSettings.injection.protagonist" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>

    <SettingRow label="场景信息">
      <input v-model="apiSettings.injection.scenes" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
      <template #hint>当前地点及其上级地点（详细），以及其他已知地点（仅名称）。<strong>NPC 名册和物品信息依赖场景判断在场与可及范围，关闭此项后二者也不发送。</strong></template>
    </SettingRow>

    <SettingRow label="NPC 名册" hint="主要角色发送档案与当前状态；NPC 在场的发送完整信息，同一区域的从简，不在场的只发送有名字者的名字和身份。需开启场景信息。">
      <input v-model="apiSettings.injection.npcs" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow label="角色好感估计" hint="NPC 名册中的五档好感（内心好感、外在态度和说明）。好感始终记录并在角色页显示；关闭后名册照常发送，但不附带好感。适用于自带好感系统的角色卡。">
      <input v-model="apiSettings.injection.npcAffinity" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.npcs" />
    </SettingRow>

    <SettingRow label="物品信息" hint="随身和可及的物品发送完整信息，存放在别处的只发送名字和数量。需开启场景信息。">
      <input v-model="apiSettings.injection.items" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow label="信息差" hint="提醒在场的角色哪些事不知情，避免其说出或依据自己不知道的事行动。信息差始终记录，可在角色页查看；需要打开 NPC 名册。">
      <input v-model="apiSettings.injection.secrets" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode || !apiSettings.injection.npcs || !apiSettings.injection.scenes" />
    </SettingRow>

    <SettingRow
      label="伤势进展提醒"
      hint="主角、主要角色及在场、同区域角色的伤情记录超过一天未更新时，提醒正文模型按伤势轻重写出恢复进展；没有故事时间时按回复楼层数计算。伤情记录更新后重新计时。"
      details="只提醒随正文发送的角色：主角需开启「主角信息」，其他角色需开启「NPC 名册」。超过七天或三十天时提醒措辞加重。提醒只影响正文模型看到的内容，伤情记录本身仍以正文为准更新。"
    >
      <input v-model="apiSettings.injection.injuryReminder" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" :disabled="apiSettings.summaryOnlyMode" />
    </SettingRow>
  </Collapsible>
</template>
