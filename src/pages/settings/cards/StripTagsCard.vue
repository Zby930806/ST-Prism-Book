<script setup lang="ts">
/* 自定义清洗标签：用户填标签名（如 snow），清洗正文时把 <snow>…</snow> 整块删掉。 */
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings, sanitizeTagName } from '@/api/settings';
import { ref } from 'vue';

const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!apiSettings.customStripTags.includes(tag)) apiSettings.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = apiSettings.customStripTags.indexOf(tag);
  if (idx >= 0) apiSettings.customStripTags.splice(idx, 1);
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="自定义清洗标签" :open="false">
    <p class="bbs-field-hint">正文中混有其他插件或世界书生成的格式块时（如状态栏 <code>&lt;snow&gt;…&lt;/snow&gt;</code>），在此填写标签名（只填 <code>snow</code>，不带尖括号），摘要、建立索引和召回时会删除整块及其内容。修改对召回立即生效（索引中存储原文，召回时再清洗），无需重建索引。</p>
    <div class="bbs-striptag-bar">
      <input
        v-model="stripTagDraft"
        class="bbs-input"
        type="text"
        placeholder="标签名，如 snow"
        aria-label="要清洗的标签名"
        @keydown.enter.prevent="addStripTag"
      />
      <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addStripTag">
        <Icon name="plus" /> 添加
      </button>
    </div>
    <ul v-if="apiSettings.customStripTags.length" class="bbs-exclude-chips">
      <li v-for="tag in apiSettings.customStripTags" :key="tag" class="bbs-exclude-chip">
        <span class="bbs-exclude-chip-name">&lt;{{ tag }}&gt;</span>
        <button class="bbs-exclude-chip-x" type="button" title="移除" :aria-label="`移除标签 <${tag}>`" @click="removeStripTag(tag)">
          <Icon name="close" />
        </button>
      </li>
    </ul>
    <p v-else class="bbs-field-hint">暂无自定义标签，仅执行内置清洗（思维链、注释、物品旁注等）。</p>
  </Collapsible>
</template>
