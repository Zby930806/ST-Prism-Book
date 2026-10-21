<script setup lang="ts">
/**
 * 设置页：页头、总开关、分组目录与各分组。每张设置卡片在 cards/ 下单独成文件；
 * 多个卡片共用的样式在 settings.css，最先导入，排在各卡片的 scoped 样式之前。
 * 卡片默认收起；「注入设置」在时间标签提示词超出预算时自动展开（见 InjectionCard）。
 */
import './settings.css';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import { apiSettings } from '@/api/settings';
import { INTERNAL_UPDATE_NOTICE, performUpdate, updateState } from '@/memory/update';
import { toast } from '@/st/toast';
import { ref, useId } from 'vue';
import ApiChannelsCard from './cards/ApiChannelsCard.vue';
import OtherApiCard from './cards/OtherApiCard.vue';
import BasicCard from './cards/BasicCard.vue';
import SummaryCard from './cards/SummaryCard.vue';
import InjectionCard from './cards/InjectionCard.vue';
import VectorCard from './cards/VectorCard.vue';
import RecallDebugCard from './cards/RecallDebugCard.vue';
import PromptsCard from './cards/PromptsCard.vue';
import ExcludeCharsCard from './cards/ExcludeCharsCard.vue';
import ExcludeWorldCard from './cards/ExcludeWorldCard.vue';
import StripTagsCard from './cards/StripTagsCard.vue';
import CarryoverCard from './cards/CarryoverCard.vue';
import MigrateCard from './cards/MigrateCard.vue';
import DataApiCard from './cards/DataApiCard.vue';
import SettingsBackupCard from './cards/SettingsBackupCard.vue';

/* 总开关：读屏名称固定为功能名，开关状态由 aria-checked 表达，说明文字作为描述。 */
const masterDescId = useId();

/* —— 检测更新:版本区块 + 确认弹窗 —— */
const updateConfirmOpen = ref(false);
// 插件不触发远程更新检查，更新由酒馆的「管理扩展」完成。
function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}
async function confirmUpdate() {
  updateConfirmOpen.value = false;
  try {
    await performUpdate();
    // performUpdate 成功后会自动刷新页面;走到这里通常是已触发刷新倒计时
    toast('更新成功，正在刷新页面…', 'success');
  } catch (e) {
    toast(`更新失败：${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/* 设置目录：只在页内跳转，不改配置。 */
const settingsRoot = ref<HTMLElement | null>(null);
const SETTINGS_GROUPS = [
  { id: 'common', label: '常用设置', icon: 'settings', hint: 'API · 摘要 · 外观' },
  { id: 'memory', label: '记忆与召回', icon: 'summary', hint: '注入 · 向量记忆' },
  { id: 'prompts', label: '提示词', icon: 'edit', hint: '编辑 · 恢复默认' },
  { id: 'advanced', label: '高级过滤', icon: 'vars', hint: '排除 · 内容清洗' },
  { id: 'data', label: '数据与迁移', icon: 'upload', hint: '新对话 · 旧版迁移 · 设置备份' },
] as const;
function goToSettingsGroup(id: string) {
  // 限定在本页根节点内，兼容 ST 的 Shadow DOM，不修改宿主页面 hash。
  const heading = settingsRoot.value?.querySelector<HTMLElement>('#prism-settings-' + id);
  if (!heading) return;
  heading.scrollIntoView({ block: 'start', behavior: 'auto' });
  heading.focus({ preventScroll: true });
}
</script>

<template>
  <section ref="settingsRoot" class="bbs-page prism-settings">
    <PageHeader
      icon="settings"
      title="设置"
      description="摘要所用的 API、记录范围、注入正文的内容和界面外观。"
    >
      <template #actions>
        <div class="bbs-ver-row">
          <span class="bbs-ver" :title="INTERNAL_UPDATE_NOTICE">v{{ updateState.current || '—' }}</span>
          <button
            v-if="updateState.available"
            class="bbs-btn bbs-btn-primary bbs-btn-sm"
            type="button"
            :disabled="updateState.updating"
            :title="'更新到 v' + updateState.latest"
            @click="openUpdateConfirm"
          >{{ updateState.updating ? '更新中…' : '更新' }}</button>
        </div>
      </template>
    </PageHeader>

    <div class="prism-overview">
      <div class="bbs-master" :class="{ 'is-off': !apiSettings.enabled }">
        <div class="bbs-master-text">
          <h3 class="bbs-master-title">{{ apiSettings.enabled ? '棱镜宝书已启用' : '棱镜宝书已停用' }}</h3>
          <p :id="masterDescId" class="prism-master-description">{{ apiSettings.enabled ? '摘要、总结、隐藏旧楼层和记忆注入均按以下设置进行。' : '不摘要、不注入，也不隐藏旧楼层。已有记忆保留，设置仍可修改。' }}</p>
        </div>
        <!-- 总开关：与其他设置项同一种开关；外层 label 提供 44px 点按区域 -->
        <label class="prism-master-control" :title="apiSettings.enabled ? '停用棱镜宝书记忆引擎' : '启用棱镜宝书记忆引擎'">
          <input
            v-model="apiSettings.enabled"
            type="checkbox"
            role="switch"
            class="bbs-switch"
            aria-label="棱镜宝书记忆引擎"
            :aria-describedby="masterDescId"
          />
        </label>
      </div>
    </div>

    <div class="prism-settings-layout">
      <nav class="prism-settings-nav" aria-label="设置分组目录">
        <button v-for="group in SETTINGS_GROUPS" :key="group.id" type="button" :aria-controls="'prism-settings-' + group.id" @click="goToSettingsGroup(group.id)">
          <Icon :name="group.icon" />
          <span><strong>{{ group.label }}</strong><small>{{ group.hint }}</small></span>
          <Icon name="chevron" class="prism-nav-arrow" />
        </button>
      </nav>
      <div class="bbs-sections">
        <section class="prism-settings-group prism-group-common" aria-labelledby="prism-settings-common">
          <header class="prism-group-head">
            <h2 id="prism-settings-common" tabindex="-1">常用设置</h2>
            <p>摘要、札记与规划使用的 API，摘要与总结的节奏，以及界面外观。</p>
          </header>
          <div class="prism-group-cards">
            <ApiChannelsCard />
            <OtherApiCard />
            <BasicCard />
            <SummaryCard />
          </div>
        </section>

        <section class="prism-settings-group prism-group-memory" aria-labelledby="prism-settings-memory">
          <header class="prism-group-head">
            <h2 id="prism-settings-memory" tabindex="-1">记忆与召回</h2>
            <p>生成正文时注入的记忆，从旧剧情中检索相关内容的方式，以及上一次召回的过程。</p>
          </header>
          <div class="prism-group-cards">
            <InjectionCard />
            <VectorCard />
            <RecallDebugCard />
          </div>
        </section>

        <section class="prism-settings-group prism-group-prompts" aria-labelledby="prism-settings-prompts">
          <header class="prism-group-head">
            <h2 id="prism-settings-prompts" tabindex="-1">提示词</h2>
            <p>摘要、总结和时间标签使用的提示词，可逐项修改或恢复默认。</p>
          </header>
          <div class="prism-group-cards">
            <PromptsCard />
          </div>
        </section>

        <section class="prism-settings-group prism-group-advanced" aria-labelledby="prism-settings-advanced">
          <header class="prism-group-head">
            <h2 id="prism-settings-advanced" tabindex="-1">高级过滤</h2>
            <p>摘要时跳过的角色、世界书条目和格式标签。</p>
          </header>
          <div class="prism-group-cards">
            <ExcludeCharsCard />
            <ExcludeWorldCard />
            <StripTagsCard />
          </div>
        </section>

        <section class="prism-settings-group prism-group-data" aria-labelledby="prism-settings-data">
          <header class="prism-group-head">
            <h2 id="prism-settings-data" tabindex="-1">数据与迁移</h2>
            <p>带记忆创建新对话、从 Horae 迁移、将记忆提供给其他插件，以及导出、导入设置。</p>
          </header>
          <div class="prism-group-cards">
            <CarryoverCard />
            <MigrateCard />
            <DataApiCard />
            <SettingsBackupCard />
          </div>
        </section>
      </div>
    </div>
    <p class="prism-settings-footnote">{{ INTERNAL_UPDATE_NOTICE }} 原作：柏柏（ST-BaiBai-Book）。</p>

    <!-- ===== 更新确认弹窗 ===== -->
    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="发现新版本"
      confirm-text="更新并刷新"
      busy-text="更新中…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      当前版本 v{{ updateState.current || '—' }}，最新版本 v{{ updateState.latest }}。<br />
      是否立即更新？更新完成后将自动刷新页面。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* 页面级样式：页头、总开关、目录、分组，以及卡片外壳（Collapsible 根节点由子卡片渲染，
   但作为子组件根节点会带上本页的 data-v 属性，这里的 .prism-settings-card 规则照常生效）。
   卡片内部的部件见 settings.css 与各卡片自己的样式。 */

/* 设置页根节点：容器断点按插件实际可用宽度生效，而非宿主浏览器宽度。 */
.prism-settings {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-bottom: 24px;
  color: var(--bbs-ink);
  container: prism-settings / inline-size;
}
.bbs-sections {
  display: flex;
  flex-direction: column;
  gap: 36px;
  min-width: 0;
}

.bbs-ver-row {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
/* 版本仅展示真实版本号，不暗示可点击。 */
.bbs-ver {
  display: inline-flex;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* —— 总开关主控卡:左缘强调色表示启用,停用时退为中性色 —— */
.bbs-master {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 0;
  padding: 16px 20px;
  border: 1px solid var(--bbs-line);
  border-left: 3px solid var(--bbs-accent);
  border-radius: 14px;
  background: var(--bbs-surface);
}
.bbs-master.is-off {
  border-left-color: var(--bbs-line-strong);
}
.bbs-master-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bbs-master-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.5;
  color: var(--bbs-ink);
}
.bbs-master.is-off .bbs-master-title {
  color: var(--bbs-ink-soft);
}

/* ================= 棱镜宝书 · 设置工作台 =================
 * 只使用共享语义色；五种主题的 ID、选项与设置值均由原状态源提供。
 */
.prism-settings :deep(.prism-page-header) {
  flex-wrap: wrap;
}
.prism-overview {
  margin-bottom: 24px;
}
.prism-master-description {
  color: var(--bbs-ink-soft);
  margin: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
/* 总开关的点按区域：开关本身 38×22，外层 label 撑到 44×44 */
.prism-master-control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}
.prism-settings-layout { display: grid; gap: 24px; min-width: 0; }
.prism-settings-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: start;
  align-items: stretch;
  min-width: 0;
}
.prism-settings-nav button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.prism-settings-nav button:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.prism-settings-nav button > span { min-width: 0; }
.prism-settings-nav strong { display: block; font-size: 12.5px; font-weight: 600; }
/* 目录项的说明与箭头当前不显示（窗口最宽 1060px，侧栏目录不会出现）。 */
.prism-settings-nav small { display: none; font-size: 11px; margin-top: 2px; color: var(--bbs-ink-muted); }
.prism-nav-arrow { display: none; }
.prism-settings-group { min-width: 0; }
.prism-group-head {
  margin-bottom: 14px;
  min-width: 0;
}
.prism-group-head h2 {
  color: var(--bbs-ink);
  font: 600 19px/1.5 var(--bbs-font-reading);
  letter-spacing: .04em;
  margin: 0 0 2px;
  scroll-margin-block-start: 24px;
}
.prism-group-head p {
  color: var(--bbs-ink-muted);
  font-size: 12.5px;
  line-height: 1.75;
  margin: 0;
}
.prism-group-cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
.prism-settings-card {
  min-width: 0;
  border-radius: 16px;
  box-shadow: var(--bbs-card-shadow, var(--bbs-shadow));
}
.prism-settings-card :deep(.bbs-collapsible-head) {
  min-height: 52px;
  gap: 12px;
  padding: 16px 20px;
  font-size: 14px;
}
.prism-settings-card :deep(.bbs-collapsible-title) { min-width: 0; overflow-wrap: anywhere; }
.prism-settings-card :deep(.bbs-collapsible-body) { padding: 20px; }
.prism-settings-card :deep(.bbs-collapsible) { box-shadow: none; }
.prism-settings-card.is-open,
.prism-settings-card :deep(.bbs-collapsible.is-open) { overflow: visible; }
.prism-settings :deep(.bbs-collapsible.is-open > .bbs-collapsible-outer > .bbs-collapsible-inner) { overflow: visible; }
.prism-settings :deep(.bbs-collapsible:not(.is-open) > .bbs-collapsible-outer) {
  visibility: hidden;
}
/* 卡片里的说明文字与输入框（由子卡片渲染）：用 :deep 下探到整页。 */
.prism-settings :deep(.bbs-field-hint) { font-size: 12.5px; line-height: 1.8; overflow-wrap: anywhere; }
.prism-settings :deep(.bbs-input) { min-width: 0; max-width: 100%; }
.prism-settings-footnote { color: var(--bbs-ink-muted); font-size: 11px; line-height: 1.8; border-top: 1px solid var(--bbs-line); padding-top: 18px; margin: 28px 0 0; }
.prism-settings :is(button, input, select, textarea):focus-visible,
.prism-group-head h2:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}
@container prism-settings (max-width: 520px) {
  .prism-overview { margin-bottom: 20px; }
  .bbs-master { padding: 14px 16px; gap: 12px; }
  .bbs-master-title { font-size: 15px; }
  .prism-settings-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .prism-settings-nav button { padding: 8px 10px; }
  .prism-group-head h2 { font-size: 17px; }
  .prism-settings-card :deep(.bbs-collapsible-head) { padding: 14px; }
  .prism-settings-card :deep(.bbs-collapsible-body) { padding: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .prism-settings *, .prism-settings :deep(*) { transition: none !important; }
}
</style>
