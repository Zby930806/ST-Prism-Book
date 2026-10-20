<script setup lang="ts">
/**
 * 排除世界书内容：摘要和总结时不带这些整本世界书的条目，或按条目名过滤；另含「渲染世界书模板」开关。
 * 世界书名从 ST 的 getWorldInfoNames()（全部已加载的世界书文件）取，只在弹窗打开时取。
 */
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings } from '@/api/settings';
import { getContext } from '@/st/context';
import { computed, ref } from 'vue';
import NamePickerDialog from '../NamePickerDialog.vue';

const pickerOpen = ref(false);

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
  if (!pickerOpen.value) return [];
  const getNames = getContext()?.getWorldInfoNames;
  const names = getNames ? getNames() : readWorldNamesFromDom();
  const seen = new Set<string>();
  for (const n of names) {
    const t = n?.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

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
</script>

<template>
  <Collapsible class="prism-settings-card" title="排除世界书内容" :open="false">
    <p class="bbs-field-hint">
      摘要和总结时会激活世界书作为参考。可在此排除与剧情记忆无关的条目（如全局挂载的知识书、规则说明），以节省 token、减少干扰。只影响摘要和总结，不改动正文使用的世界书。
    </p>

    <!-- 渲染世界书模板:配合「提示词模板(ST-Prompt-Template)」等插件 -->
    <label class="bbs-switch-row">
      <span class="bbs-field-label">渲染世界书模板</span>
      <input v-model="apiSettings.renderWorldInfoTemplates" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">
      摘要前展开世界书条目中的宏并执行提示词模板（EJS）代码，使摘要使用渲染后的内容。条目中含修改变量的代码时，每次摘要会额外执行一次，此时可关闭。
    </p>

    <hr class="bbs-rule" />

    <!-- 整本排除:与排除角色同款的搜索+勾选弹窗 -->
    <div class="bbs-channel-bar">
      <span class="bbs-field-label">整本排除 · 已选 {{ apiSettings.excludedWorldNames.length }} 本</span>
      <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="pickerOpen = true">
        <Icon name="edit" /> 编辑名单
      </button>
    </div>
    <ul v-if="apiSettings.excludedWorldNames.length" class="bbs-exclude-chips">
      <li v-for="name in apiSettings.excludedWorldNames" :key="name" class="bbs-exclude-chip">
        <span class="bbs-exclude-chip-name">{{ name }}</span>
        <button class="bbs-exclude-chip-x" type="button" title="移出名单" :aria-label="`将「${name}」移出名单`" @click="toggleWorldExcluded(name)">
          <Icon name="close" />
        </button>
      </li>
    </ul>
    <p v-else class="bbs-field-hint">未排除任何世界书，激活的条目均作为摘要参考。</p>

    <hr class="bbs-rule" />

    <!-- 按条目名过滤:复刻清洗标签的输入框 + chips -->
    <div class="bbs-field-head">
      <span class="bbs-field-label">按条目名过滤</span>
    </div>
    <p class="bbs-field-hint">填写条目的备注名（comment），按<strong>包含</strong>匹配，不区分大小写：填 <code>附加</code> 可匹配「附加设定」。也可填写正则，<code>^规则</code> 表示以「规则」开头。只对未整本排除的世界书生效。默认包含一条 <code>\[mvu[\s\S]*?\]</code>，用于过滤 MVU 变量框架的机制条目，不需要时可删除。</p>
    <div class="bbs-striptag-bar">
      <input
        v-model="wiPatternDraft"
        class="bbs-input"
        type="text"
        placeholder="条目名或正则，如：附加、^规则"
        aria-label="要排除的条目名或正则"
        @keydown.enter.prevent="addWiPattern"
      />
      <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addWiPattern">
        <Icon name="plus" /> 添加
      </button>
    </div>
    <ul v-if="apiSettings.excludedWorldInfoPatterns.length" class="bbs-exclude-chips">
      <li v-for="pat in apiSettings.excludedWorldInfoPatterns" :key="pat" class="bbs-exclude-chip">
        <span class="bbs-exclude-chip-name">{{ pat }}</span>
        <button class="bbs-exclude-chip-x" type="button" title="移除" :aria-label="`移除规则「${pat}」`" @click="removeWiPattern(pat)">
          <Icon name="close" />
        </button>
      </li>
    </ul>
    <p v-else class="bbs-field-hint">暂无规则。</p>

    <NamePickerDialog
      :open="pickerOpen"
      title="整本排除世界书"
      dialog-label="编辑排除世界书名单"
      close-label="关闭世界书排除名单"
      placeholder="搜索世界书名…"
      :names="worldNames"
      :selected="apiSettings.excludedWorldNames"
      count-unit="本"
      noun="世界书"
      empty-text="未读取到世界书，请先在酒馆中加载世界书。"
      @close="pickerOpen = false"
      @toggle="toggleWorldExcluded"
    />
  </Collapsible>
</template>
