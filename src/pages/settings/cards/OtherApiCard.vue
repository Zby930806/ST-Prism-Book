<script setup lang="ts">
/**
 * 札记与规划 API（提案 P3）：双子札记、创作规划和世界书各用独立的 API，设置项分别在札记页、摘要页和世界书页。
 * 本卡片只读显示三者的配置状态，并提供跳转按钮：切到对应页面后展开并滚动到 API 设置（openPageSection，接收端由各页面处理）。
 * 不修改札记、规划和世界书的设置。
 */
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { notesSettings } from '@/notes/settings';
import { outlineSettings } from '@/outline/settings';
import { worldbookSettings } from '@/worldbook/settings';
import { openPageSection } from '@/state/pageFocus';
import { computed } from 'vue';

type ApiState = { ready: boolean; text: string };
const channelState = (c: { url: string; model: string }): ApiState =>
  c.url.trim() && c.model.trim()
    ? { ready: true, text: c.model.trim() }
    : { ready: false, text: c.url.trim() ? '未填写模型名' : '未填写 API 地址' };

const notesApi = computed<ApiState>(() => channelState(notesSettings.channel));
const outlineApi = computed<ApiState & { mode: string }>(() =>
  outlineSettings.apiMode === 'independent'
    ? { ...channelState(outlineSettings.channel), mode: '规划专用 API' }
    : { ...notesApi.value, mode: '使用札记的 API' },
);
const worldbookApi = computed<ApiState & { mode: string }>(() =>
  worldbookSettings.apiMode === 'independent'
    ? { ...channelState(worldbookSettings.channel), mode: '世界书专用 API' }
    : { ...notesApi.value, mode: '使用札记的 API' },
);

/** 札记页展开并滚动到「独立 API 设置」；摘要页展开「创作规划 › 修改或重新生成规划 › 规划 API 设置」并滚动过去；世界书页展开底部「API 设置」。 */
function goToNotesApi() {
  openPageSection('notes', 'notes-api');
}
function goToOutlineApi() {
  openPageSection('summary', 'outline-api');
}
function goToWorldbookApi() {
  openPageSection('worldbook', 'worldbook-api');
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="札记与规划 API" :open="false">
    <p class="prism-card-intro">双子札记、创作规划和世界书使用各自的 API，不借用摘要或正文的 API。此处显示配置状态，修改请前往对应页面。</p>
    <ul class="prism-api-list">
      <li class="prism-api-row">
        <div class="prism-api-text">
          <span class="bbs-field-label">双子札记</span>
          <span class="prism-api-meta">
            <span class="prism-api-state" :class="notesApi.ready ? 'is-ready' : 'is-missing'">{{ notesApi.ready ? '已设置' : '未设置' }}</span>
            <span class="prism-api-model">{{ notesApi.text }}</span>
            <span v-if="!notesSettings.enabled" class="prism-api-model">· 札记功能未开启</span>
          </span>
        </div>
        <button class="bbs-btn bbs-btn-sm" type="button" @click="goToNotesApi">
          <Icon name="notes" /> 前往札记设置
        </button>
      </li>
      <li class="prism-api-row">
        <div class="prism-api-text">
          <span class="bbs-field-label">创作规划</span>
          <span class="prism-api-meta">
            <span class="prism-api-state" :class="outlineApi.ready ? 'is-ready' : 'is-missing'">{{ outlineApi.ready ? '已设置' : '未设置' }}</span>
            <span class="prism-api-model">{{ outlineApi.mode }} · {{ outlineApi.text }}</span>
          </span>
        </div>
        <button class="bbs-btn bbs-btn-sm" type="button" @click="goToOutlineApi">
          <Icon name="plans" /> 前往规划设置
        </button>
      </li>
      <li class="prism-api-row">
        <div class="prism-api-text">
          <span class="bbs-field-label">世界书</span>
          <span class="prism-api-meta">
            <span class="prism-api-state" :class="worldbookApi.ready ? 'is-ready' : 'is-missing'">{{ worldbookApi.ready ? '已设置' : '未设置' }}</span>
            <span class="prism-api-model">{{ worldbookApi.mode }} · {{ worldbookApi.text }}</span>
          </span>
        </div>
        <button class="bbs-btn bbs-btn-sm" type="button" @click="goToWorldbookApi">
          <Icon name="worldbook" /> 前往世界书设置
        </button>
      </li>
    </ul>
    <p class="bbs-field-hint">札记 API 位于札记页底部「独立 API 设置」；规划 API 位于摘要页「创作规划 › 修改或重新生成规划 › 规划 API 设置」；世界书 API 位于世界书页底部「API 设置」。规划和世界书默认使用札记的 API。</p>
  </Collapsible>
</template>

<style scoped>
.prism-api-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.prism-api-row:first-child {
  padding-top: 0;
}
.prism-api-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--bbs-line);
}
.prism-api-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 220px;
  min-width: 0;
}
.prism-api-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.prism-api-state {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}
.prism-api-state.is-ready {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.prism-api-state.is-missing {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
.prism-api-model {
  min-width: 0;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.prism-api-list + .bbs-field-hint {
  margin-top: 12px;
}
</style>
