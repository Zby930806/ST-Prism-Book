<script setup lang="ts">
/* 副 API：摘要和总结分别指定渠道；渠道列表只读展示，编辑/新建都在弹窗里进行，避免一长列表平铺误触。 */
import BbsSelect from '@/components/BbsSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings } from '@/api/settings';
import { computed, ref } from 'vue';
import ChannelDialog from './ChannelDialog.vue';

/** 任务指派下拉:空串 = 跟随主 API,其余为副渠道 id(未命名渠道给个占位名,免空白选项) */
const channelOptions = computed(() => [
  { value: '', label: '跟随主 API' },
  ...apiSettings.channels.map(c => ({ value: c.id, label: c.name || '未命名渠道' })),
]);

const dialog = ref<InstanceType<typeof ChannelDialog> | null>(null);
</script>

<template>
  <Collapsible class="prism-settings-card" title="副 API" :open="false">
    <p class="prism-card-intro">摘要和总结可分别指定渠道；选择「跟随主 API」时使用酒馆当前连接的 API，请求期间的最大回复和预填充在「摘要设置」中调整。点击渠道可修改或测试。</p>
    <!-- 任务指派 -->
    <div class="bbs-field bbs-assign">
      <div class="bbs-assign-row">
        <span class="bbs-field-label">摘要使用</span>
        <BbsSelect v-model="apiSettings.assignments.summary" :options="channelOptions" class="bbs-assign-select" aria-label="摘要使用的渠道" />
      </div>
      <div class="bbs-assign-row">
        <span class="bbs-field-label">总结使用</span>
        <BbsSelect v-model="apiSettings.assignments.resummary" :options="channelOptions" class="bbs-assign-select" aria-label="总结使用的渠道" />
      </div>
    </div>
    <p class="bbs-field-hint">推荐 DeepSeek 或豆包；不推荐 Gemini（安全过滤较严）。</p>

    <hr class="bbs-rule" />

    <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表单平铺 -->
    <div class="bbs-channel-bar">
      <span class="bbs-field-label">渠道</span>
      <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="dialog?.openNew()">
        <Icon name="plus" /> 添加渠道
      </button>
    </div>

    <ul v-if="apiSettings.channels.length" class="bbs-channel-list">
      <li v-for="ch in apiSettings.channels" :key="ch.id" class="bbs-channel-item">
        <button class="bbs-channel-open" type="button" :title="'编辑渠道：' + (ch.name || '未命名渠道')" @click="dialog?.openExisting(ch.id)">
          <span class="bbs-channel-item-name">{{ ch.name || '未命名渠道' }}</span>
          <span class="bbs-channel-item-model" :title="ch.model || '未设模型'">{{ ch.model || '未设模型' }}</span>
          <Icon name="edit" class="prism-channel-edit" />
        </button>
      </li>
    </ul>
    <p v-else class="bbs-field-hint">暂无渠道。点击「添加渠道」添加摘要和总结使用的 API。</p>

    <ChannelDialog ref="dialog" />
  </Collapsible>
</template>

<style scoped>
/* 任务指派 */
.bbs-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbs-assign-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 20px;
}
/* 指派下拉:与标签同行,宽度不足时换到下一行;小一号字与其它设置行一致。
   带上父级选择器是为了压过 BbsSelect 根节点自带的 width:100%——两者同特异度时靠
   样式表先后决定胜负,那取决于打包顺序,不可靠 */
.bbs-assign-row .bbs-assign-select {
  flex: 1 1 190px;
  min-width: 0;
  max-width: 100%;
}
.bbs-assign-select :deep(.bbs-select-trigger) {
  font-size: 12px;
}

/* 渠道:紧凑只读列表,每渠道一行,点行进弹窗编辑 */
.bbs-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左名字右模型 */
.bbs-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  padding: 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-channel-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
/* 渠道名:完整显示,允许换行,占据剩余空间 */
.bbs-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要信息,过长则截断,不挤占名字 */
.bbs-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 48%;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (max-width: 640px) {
  .bbs-channel-item-name {
    font-size: 13px;
  }
  .bbs-channel-item-model {
    font-size: 11px;
  }
}
.prism-channel-edit { flex: 0 0 auto; color: var(--bbs-accent); font-size: 15px; }
.bbs-channel-list + .bbs-field-hint { margin-top: 12px; }
@container prism-settings (max-width: 520px) {
  .bbs-assign-row { align-items: stretch; flex-direction: column; }
  .bbs-assign-row .bbs-assign-select { flex: initial; width: 100%; }
  .bbs-channel-open { flex-wrap: wrap; gap: 6px; }
  .bbs-channel-item-name { flex-basis: calc(100% - 22px); }
  .bbs-channel-item-model { order: 3; flex-basis: 100%; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
}
</style>
