<script setup lang="ts">
/**
 * 排除角色：名单中的角色名（含重名卡）的单角色聊天里，记忆系统所有功能都不生效；群聊不按名单排除。
 * 按「名字」排除，所以同名卡是一批一起排除。角色名只在弹窗打开时取并去重，关闭后不再持有。
 */
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings } from '@/api/settings';
import { getContext } from '@/st/context';
import { computed, ref } from 'vue';
import NamePickerDialog from '../NamePickerDialog.vue';

const pickerOpen = ref(false);

// 弹窗打开时一次性算出去重后的角色名(按名排序),关闭后不再持有,避免常驻大列表。
const charNames = computed<string[]>(() => {
  if (!pickerOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

function toggleExcluded(name: string) {
  const list = apiSettings.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="排除角色" :open="false">
    <p class="bbs-field-hint">名单中的角色（含同名角色卡）在聊天中不使用棱镜宝书：不摘要、不注入、不拦截，也不再隐藏新的楼层。群聊不受排除名单影响。适用于工具类、不需要记忆的角色。</p>
    <p class="bbs-field-hint">加入名单前已由棱镜宝书隐藏的旧楼层仍保持隐藏，正文模型看不到它们的原文和摘要；打开这个角色的聊天后，可在设置页顶部恢复显示。</p>
    <div class="bbs-channel-bar">
      <span class="bbs-field-label">
        已排除 {{ apiSettings.excludedChars.length }} 个
      </span>
      <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="pickerOpen = true">
        <Icon name="edit" /> 编辑名单
      </button>
    </div>
    <ul v-if="apiSettings.excludedChars.length" class="bbs-exclude-chips">
      <li v-for="name in apiSettings.excludedChars" :key="name" class="bbs-exclude-chip">
        <span class="bbs-exclude-chip-name">{{ name }}</span>
        <button class="bbs-exclude-chip-x" type="button" title="移出名单" :aria-label="`将「${name}」移出名单`" @click="toggleExcluded(name)">
          <Icon name="close" />
        </button>
      </li>
    </ul>
    <p v-else class="bbs-field-hint">名单为空，所有角色均使用棱镜宝书。</p>

    <NamePickerDialog
      :open="pickerOpen"
      title="排除角色"
      dialog-label="编辑排除名单"
      close-label="关闭角色排除名单"
      placeholder="搜索角色名…"
      :names="charNames"
      :selected="apiSettings.excludedChars"
      count-unit="个角色"
      noun="角色"
      empty-text="未读取到角色列表，请先在酒馆中加载角色。"
      @close="pickerOpen = false"
      @toggle="toggleExcluded"
    />
  </Collapsible>
</template>
