<script setup lang="ts">
/* 基本设置：主题、导航、入口按钮、楼层面板与屏幕悬浮球。 */
import BrandMark from '@/components/BrandMark.vue';
import Collapsible from '@/components/Collapsible.vue';
import SegmentedControl from '@/components/SegmentedControl.vue';
import { ui, THEMES, ORB_SHAPES, type NavPosition } from '@/state/ui';
import { uploadOrbImage } from '@/st/upload';
import { toast } from '@/st/toast';
import { ref, useId, watch } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

/* —— 悬浮球自定义图标:选图 → 压缩上传到 ST 服务器 → 存路径串(跨设备同步) —— */
const orbFileInput = ref<HTMLInputElement | null>(null);
const orbUploading = ref(false);
// 预览图加载失败(图片已被删除或路径来自别的酒馆)时显示默认小狐狸,并提示重新上传
const orbPreviewFailed = ref(false);
watch(() => ui.orbImage, () => { orbPreviewFailed.value = false; });
function pickOrbImage() {
  orbFileInput.value?.click();
}
async function onOrbFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 复位,允许重复选同一文件
  if (!file) return;
  orbUploading.value = true;
  try {
    ui.orbImage = await uploadOrbImage(file);
    toast('悬浮球图标已更新', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : '上传失败', 'error');
  } finally {
    orbUploading.value = false;
  }
}
function resetOrbImage() {
  ui.orbImage = '';
}

// 读屏：滑块用可见标签命名（分段选择由 SegmentedControl 的 label 命名）
const ids = { opacity: useId(), size: useId() };
const themeOptions = THEMES.map(t => ({ value: t.value, label: t.label, icon: t.icon }));
</script>

<template>
  <Collapsible class="prism-settings-card" title="基本设置" :open="false">
    <div class="bbs-field">
      <div class="bbs-field-head">
        <span class="bbs-field-label">主题</span>
      </div>
      <SegmentedControl v-model="ui.theme" :options="themeOptions" label="主题" />
    </div>

    <div class="bbs-field">
      <div class="bbs-field-head">
        <span class="bbs-field-label">导航位置</span>
      </div>
      <SegmentedControl v-model="ui.navPosition" :options="navOptions" label="导航位置" />
    </div>

    <label class="bbs-switch-row">
      <span class="bbs-field-label">点当前页导航关闭窗口（手机）</span>
      <input v-model="ui.navTapClose" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">手机端再次点击当前页的导航按钮时关闭窗口；容易误触时可关闭此项。</p>

    <label class="bbs-switch-row">
      <span class="bbs-field-label">在酒馆顶栏显示按钮</span>
      <input v-model="ui.showTopBar" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">在酒馆顶栏（用户设定按钮左侧）显示棱镜宝书按钮。左下角魔杖菜单中的入口仍保留。</p>

    <label class="bbs-switch-row">
      <span class="bbs-field-label">在聊天框上方显示按钮</span>
      <input v-model="ui.showQuickReply" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">在输入框上方的快捷回复栏显示「棱镜宝书」按钮，样式跟随酒馆主题。</p>

    <label class="bbs-switch-row">
      <span class="bbs-field-label">在快捷回复栏显示召回</span>
      <input v-model="ui.showRecallQuickReply" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">启用向量记忆时，在快捷回复栏显示「召回」按钮，标注上次召回的段数；点击可查看召回内容和注入方式（全文或摘要）。未启用向量记忆时不显示。</p>

    <label class="bbs-switch-row">
      <span class="bbs-field-label">启用楼层面板</span>
      <input v-model="ui.showFloorPanel" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
    </label>
    <p class="bbs-field-hint">在每条 AI 回复下方显示楼层面板，可查看和编辑本楼摘要及数据变动，或将本楼标记为「番外」（不摘要、不总结、不注入）。启用向量记忆时，面板同时记录并显示生成本楼前的召回内容；启用前生成的楼层没有召回记录。</p>

    <!-- 屏幕悬浮球:配置项多,收进可收缩小分组 -->
    <Collapsible title="屏幕悬浮球" :open="false">
      <label class="bbs-switch-row">
        <span class="bbs-field-label">显示屏幕悬浮球</span>
        <input v-model="ui.showOrb" type="checkbox" role="switch" class="bbs-checkbox bbs-switch" />
      </label>
      <p class="bbs-field-hint">在屏幕上显示可拖动的悬浮球，点击打开棱镜宝书。拖到屏幕中间时停在原处，靠近左右边缘时自动贴边。</p>

      <!-- 形状:仅开启时可配 -->
      <div v-if="ui.showOrb" class="bbs-field">
        <div class="bbs-field-head">
          <span class="bbs-field-label">形状</span>
        </div>
        <SegmentedControl v-model="ui.orbShape" :options="ORB_SHAPES" label="悬浮球形状" />
      </div>

      <!-- 静止透明度:仅开启时可配 -->
      <div v-if="ui.showOrb" class="bbs-field">
        <div class="bbs-field-head">
          <span :id="ids.opacity" class="bbs-field-label">静止透明度</span>
          <span class="bbs-field-value">{{ ui.orbOpacity }}%</span>
        </div>
        <input v-model.number="ui.orbOpacity" type="range" min="20" max="100" step="1" class="bbs-range" :aria-labelledby="ids.opacity" :aria-valuetext="ui.orbOpacity + '%'" />
        <p class="bbs-field-hint">悬浮球静止时的不透明度；鼠标悬停或拖动时完全显示。</p>
      </div>

      <!-- 大小:仅开启时可配 -->
      <div v-if="ui.showOrb" class="bbs-field">
        <div class="bbs-field-head">
          <span :id="ids.size" class="bbs-field-label">大小</span>
          <span class="bbs-field-value">{{ ui.orbSize }}px</span>
        </div>
        <input v-model.number="ui.orbSize" type="range" min="32" max="80" step="1" class="bbs-range" :aria-labelledby="ids.size" :aria-valuetext="ui.orbSize + 'px'" />
      </div>

      <!-- 图标:仅开启时可配 -->
      <div v-if="ui.showOrb" class="bbs-orb-config">
        <div class="bbs-orb-preview" :class="[`shape-${ui.orbShape}`, { 'has-image': !!ui.orbImage && !orbPreviewFailed }]">
          <img v-if="ui.orbImage && !orbPreviewFailed" :src="ui.orbImage" alt="悬浮球图标预览" @error="orbPreviewFailed = true" />
          <BrandMark v-else :size="ui.orbShape === 'bookmark' ? 30 : 32" class="bbs-orb-preview-mark" />
        </div>
        <div class="bbs-orb-config-actions">
          <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="orbUploading" @click="pickOrbImage">
            {{ orbUploading ? '上传中…' : ui.orbImage ? '更换图标' : '上传图标' }}
          </button>
          <button v-if="ui.orbImage" type="button" class="bbs-btn bbs-btn-sm" @click="resetOrbImage">恢复默认</button>
        </div>
        <input ref="orbFileInput" type="file" accept="image/*" hidden @change="onOrbFileChange" />
      </div>
      <p v-if="ui.showOrb && ui.orbImage && orbPreviewFailed" class="bbs-callout is-warning" role="status">自定义图标加载失败（图片可能已被删除，或设置来自另一个酒馆），悬浮球改用默认的小狐狸。可重新上传图标，或点击「恢复默认」。</p>
      <p v-if="ui.showOrb" class="bbs-field-hint">支持普通图片和 GIF 动图（保留动画，不超过 2MB）。图标上传到酒馆服务器，可跨设备使用；未上传时使用默认的小狐狸图标。</p>
    </Collapsible>
  </Collapsible>
</template>

<style scoped>
/* 字段右上角的数值(如透明度百分比) */
.bbs-field-value {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--bbs-accent);
}

/* 滑块:用主题色,跨浏览器统一外观。元素高 24px 作为点按区域，4px 轨道居中绘制；滑块 18px。 */
.bbs-range {
  display: block;
  width: 100%;
  height: 24px;
  margin: 2px 0 8px;
  background: transparent;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.bbs-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  box-shadow: inset 0 0 0 1px var(--bbs-line);
}
.bbs-range::-moz-range-track {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  box-shadow: inset 0 0 0 1px var(--bbs-line);
}
.bbs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
}
.bbs-range::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
}
@media (max-width: 640px), (pointer: coarse) {
  .bbs-range { height: 32px; }
  .bbs-range::-webkit-slider-thumb { width: 22px; height: 22px; margin-top: -9px; }
  .bbs-range::-moz-range-thumb { width: 22px; height: 22px; }
}
.bbs-range:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}

/* 悬浮球图标配置:预览方块 + 操作按钮 */
.bbs-orb-config {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.bbs-orb-preview {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 22px;
  overflow: hidden;
}
.bbs-orb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 预览随所选形状变化,让用户直观看到效果 */
.bbs-orb-preview.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  border-color: transparent;
}
.bbs-orb-preview.shape-bookmark .bbs-orb-preview-mark {
  margin-bottom: 8px;
}
.bbs-orb-preview.shape-circle {
  border-radius: 999px;
}
.bbs-orb-preview.shape-square {
  border-radius: 12px;
}
.bbs-orb-config-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
