<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closeBook, ui } from '@/state/ui';
import { updateState } from '@/memory/update';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();

// 设置页有可用更新时,在「设置」导航项上亮一个红点角标(提示用户进设置页更新)。
function showUpdateDot(id: string): boolean {
  return id === 'settings' && updateState.available;
}

// 移动端:再点一下当前页的导航按钮即关闭整窗(省得去够右上角的 ×);非当前页正常切页。
// 受 ui.navTapClose 开关控制(默认开,怕误触的用户可在设置里关)。
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closeBook();
    return;
  }
  ui.activePage = id;
}
</script>

<template>
  <nav aria-label="宝书功能导航" class="bbs-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbs-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="bbs-nav-icon-wrap">
        <Icon :name="p.id" class="bbs-nav-icon" />
        <!-- 有可用更新:设置项亮红点角标 -->
        <span v-if="showUpdateDot(p.id)" class="bbs-nav-dot" aria-label="有可用更新"></span>
      </span>
      <!-- 所有导航位置保留中文标签；窄屏采用上下图文，避免仅凭图标辨识 -->
      <span class="bbs-nav-label">{{ p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bbs-nav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;flex:0 0 auto;padding:10px 24px;background:var(--bbs-surface)}
.bbs-nav.is-top{border-bottom:1px solid var(--bbs-line)}
.bbs-nav-item{display:flex;align-items:center;justify-content:center;gap:8px;position:relative;min-width:0;min-height:42px;padding:9px 8px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--bbs-ink-soft);cursor:pointer;transition:background .16s,color .16s;font:500 13px/1.4 var(--bbs-font-sans)}
.bbs-nav-item:hover{background:var(--bbs-surface-2);color:var(--bbs-ink)}
.bbs-nav-item.is-active{background:var(--bbs-accent-soft);color:var(--bbs-accent);border-color:color-mix(in srgb,var(--bbs-accent) 25%,transparent);font-weight:650}
.bbs-nav-icon{font-size:18px}.bbs-nav-icon-wrap{position:relative;display:inline-flex}
.bbs-nav-dot{position:absolute;top:-3px;right:-4px;width:6px;height:6px;border-radius:50%;background:var(--bbs-danger);box-shadow:0 0 0 2px var(--bbs-surface)}
.bbs-nav-item:focus-visible{outline:2px solid var(--bbs-accent);outline-offset:2px}
.bbs-nav.is-bottom{border-top:1px solid var(--bbs-line);padding-bottom:max(8px,env(safe-area-inset-bottom))}
.bbs-nav.is-narrow{gap:2px;padding:6px 8px}
.bbs-nav.is-narrow.is-bottom{padding-bottom:max(7px,env(safe-area-inset-bottom))}
.bbs-nav.is-narrow .bbs-nav-item{flex-direction:column;gap:3px;min-height:48px;padding:5px 2px;border-radius:9px;font-size:10px}
.bbs-nav.is-narrow .bbs-nav-icon{font-size:20px}
</style>
