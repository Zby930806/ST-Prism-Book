<script setup lang="ts">
/**
 * 恢复显示本插件隐藏的楼层（设置页总开关下方）。
 * 只在棱镜宝书于当前聊天停用（总开关关闭，或当前角色在排除名单里）、且有本插件隐藏的楼层时显示。
 * 插件生效时不显示：引擎会按保留窗口重新隐藏，恢复也留不住。
 */
import { apiSettings, engineActiveHere } from '@/api/settings';
import { derivedMeta } from '@/memory/store';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';
import { pluginHiddenFloors, restorePluginHiddenFloors } from './restoreHidden';

const refresh = ref(0);
const busy = ref(false);
// 聊天不是响应式数据:借派生记忆的版本号(切换聊天、楼层变化时自增)和开关重新计算
const hiddenCount = computed(() => {
  void refresh.value;
  void derivedMeta.rev;
  void apiSettings.enabled;
  void apiSettings.excludedChars.length;
  if (engineActiveHere()) return 0;
  return pluginHiddenFloors(getContext()?.chat ?? []).length;
});

async function restore() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await restorePluginHiddenFloors();
    toast(result.restored ? `已恢复显示 ${result.restored} 层楼。重新启用棱镜宝书后，下次摘要时旧楼层会再按保留窗口隐藏。` : '当前聊天没有棱镜宝书隐藏的楼层。', 'success');
  } catch (e) {
    toast(`恢复显示没有完成：${e instanceof Error ? e.message : String(e)}。可在聊天中用 /unhide 手动恢复。`, 'error');
  } finally {
    busy.value = false;
    refresh.value++;
  }
}
</script>

<template>
  <div v-if="hiddenCount" class="bbs-callout is-warning prism-restore-hidden" role="status">
    <p>当前聊天有 {{ hiddenCount }} 层由棱镜宝书隐藏的旧楼层。停用期间，正文模型看不到这些楼层的原文，也收不到它们的摘要。</p>
    <button class="bbs-btn bbs-btn-sm" type="button" :disabled="busy" @click="restore">{{ busy ? '正在恢复…' : '恢复显示这些楼层' }}</button>
  </div>
</template>

<style scoped>
.prism-restore-hidden {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin: 12px 0 0;
}
.prism-restore-hidden p {
  flex: 1 1 260px;
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
