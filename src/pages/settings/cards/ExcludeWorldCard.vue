<script setup lang="ts">
/**
 * 排除世界书内容：逐楼摘要和生成创作规划时不带这些整本世界书的条目，或按条目名过滤；另含「渲染世界书模板」开关。
 * 总结、二次总结和较早楼层合并摘要不读世界书，不受这里影响。
 * 世界书名从 ST 的 getWorldInfoNames()（全部已加载的世界书文件）取，只在弹窗打开时取。
 * 输入条目名规则时预览它在当前聊天使用的世界书中命中哪些条目（见 wiPatternPreview.ts）。
 */
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings } from '@/api/settings';
import { getContext } from '@/st/context';
import { computed, onUnmounted, ref, watch } from 'vue';
import NamePickerDialog from '../NamePickerDialog.vue';
import { describeWiPatternPreview, loadBoundEntryNames, type BoundEntryNames } from '../wiPatternPreview';

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
   规则当正则(不区分大小写),普通名字即包含匹配;编译失败按字面包含匹配。 —— */
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

/* —— 命中预览:输入停顿后,在当前聊天使用的世界书中找出会被这条规则排除的条目。
   世界书只在第一次预览时读取一次(卡片关闭前沿用),整本排除名单在预览时按当时的值去掉。 —— */
const preview = ref<{ text: string; warn: boolean } | null>(null);
let loaded: Promise<BoundEntryNames> | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewSeq = 0;
async function runPreview(pattern: string) {
  const seq = ++previewSeq;
  if (!loaded) {
    preview.value = { text: '正在读取当前聊天使用的世界书…', warn: false };
    loaded = loadBoundEntryNames().catch(() => ({ books: [], entries: [], failed: [] }));
  }
  const data = await loaded;
  if (seq === previewSeq) preview.value = describeWiPatternPreview(pattern, data);
}
watch(wiPatternDraft, value => {
  clearTimeout(previewTimer);
  const pattern = value.trim();
  if (!pattern) {
    previewSeq++;
    preview.value = null;
    return;
  }
  previewTimer = setTimeout(() => void runPreview(pattern), 300);
});
onUnmounted(() => clearTimeout(previewTimer));
</script>

<template>
  <Collapsible class="prism-settings-card" title="排除世界书内容" :open="false">
    <p class="bbs-field-hint">
      逐楼摘要和生成创作规划时会激活世界书作为参考（总结、二次总结和较早楼层合并摘要不读世界书）。可在此排除与剧情记忆无关的条目（如全局挂载的知识书、规则说明），以节省 token、减少干扰。只影响这两项，不改动正文使用的世界书。
    </p>

    <!-- 渲染世界书模板:配合「提示词模板(ST-Prompt-Template)」等插件 -->
    <label class="bbs-switch-row">
      <span class="bbs-field-label">渲染世界书模板</span>
      <input v-model="apiSettings.renderWorldInfoTemplates" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">
      逐楼摘要和生成创作规划前展开世界书条目中的宏并执行提示词模板（EJS）代码，使用渲染后的内容。条目中含修改变量的代码时，每次逐楼摘要和生成规划都会额外执行一次，此时可关闭。
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
    <p v-else class="bbs-field-hint">未排除任何世界书，激活的条目均作为逐楼摘要和规划的参考。</p>

    <hr class="bbs-rule" />

    <!-- 按条目名过滤:复刻清洗标签的输入框 + chips -->
    <div class="bbs-field-head">
      <span class="bbs-field-label">按条目名过滤</span>
    </div>
    <p class="bbs-field-hint">填写条目的备注名（comment），按<strong>包含</strong>匹配，不区分大小写：填 <code>附加</code> 可匹配「附加设定」。规则按正则解析，<code>[ ] ( ) . * + ? ^ $ | \</code> 有特殊含义，按原样匹配请在前面加 <code>\</code>，如条目名带方括号时写 <code>\[NPC\]</code>；<code>^规则</code> 表示以「规则」开头。输入时预览当前聊天使用的世界书中会命中的条目。只对未整本排除的世界书生效。默认包含一条 <code>\[mvu[\s\S]*?\]</code>，用于过滤 MVU 变量框架的机制条目，不需要时可删除。</p>
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
    <p v-if="preview" class="prism-wi-preview" :class="preview.warn ? 'bbs-callout is-warning' : 'bbs-field-hint'" role="status">{{ preview.text }}</p>
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

<style scoped>
/* 规则命中预览:紧跟在输入框下方,长条目名可换行 */
.prism-wi-preview {
  margin: 8px 0 0;
  overflow-wrap: anywhere;
}
</style>
