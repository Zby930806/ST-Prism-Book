<script setup lang="ts">
import BrandMark from '@/components/BrandMark.vue';
import { openBook, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { beyondSlop } from './orbGesture';

/**
 * 悬浮球 —— 棱镜宝书伸进宿主页面的「书签坠」。
 *
 * 形态:竖向缎带 + 底部燕尾缺口(clip-path),呼应品牌的 bookmark 图标;自定义图片也被
 * 切成同一书签轮廓,任意图都收进统一形状(这是与「又一个圆 fab」拉开差距的签名手法)。
 *
 * 行为(按用户要求):自由拖动 —— 拖到屏幕中间就停在中间;拖到接近左/右边缘才吸附贴边。
 * 贴边时半隐于边缘(只露一窄条),hover/聚焦/触摸才整条滑出;停在中间则常显。
 * 点按与拖动:按下后移动不超过容差(鼠标 6px、触屏 10px,见 orbGesture.ts)算点按,悬浮球不动;
 * 系统手势打断(pointercancel)不算点按,拖到一半被打断时回到原位。
 * 自定义图标加载失败(图片被删、从别的酒馆导入了设置)时改显示默认的小狐狸。
 *
 * 位置存本机 localStorage(纯视觉态、各设备屏幕尺寸不同,同步反而会跑到屏幕外)。
 * 开关与自定义图标(ui.orbImage,服务器路径)跨设备同步,由设置承载。
 */

// 尺寸随形状 + 用户基准尺寸(ui.orbSize):书签按 0.78 宽高比(竖长方),圆/方等边正方。
// 拖动/吸附计算与内联尺寸都读它。
const orbW = computed(() => (ui.orbShape === 'bookmark' ? Math.round(ui.orbSize * 0.78) : ui.orbSize));
const orbH = computed(() => ui.orbSize);
const SNAP_ZONE = 56; // 松手时距左/右边缘 ≤ 此值即吸附贴边
const POS_KEY = 'bbs.orb.pos.v1';

type Dock = 'left' | 'right' | 'none';
interface OrbPos {
  dock: Dock;
  /** 贴边时无意义;free 时为左上角 x(px) */
  x: number;
  /** 左上角 y(px),三种状态都用 */
  y: number;
}

function loadPos(): OrbPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrbPos>;
      if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
        return { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
      }
    }
  } catch {
    /* ignore */
  }
  // 默认:右侧贴边、纵向居中偏下
  return { dock: 'right', x: 0, y: Math.round(window.innerHeight * 0.6) };
}

const pos = reactive<OrbPos>(loadPos());
const dragging = ref(false);
const awake = ref(false); // hover/聚焦/拖动 → 贴边态整条滑出
let activePointer: number | null = null;
let pointerType = 'mouse';
let startX = 0;
let startY = 0;
let dragMoved = false; // 位移已超过点按容差,进入拖动
let startPos: OrbPos | null = null; // 按下时的位置,拖到一半被系统手势打断时还原

// 状态栏与底部手势条的高度(安全区)。页面画到系统栏下面时,悬浮球不停在被盖住、点不到的位置。
// 只在挂载和窗口尺寸变化时量一次,拖动时直接用。
const safe = { top: 0, bottom: 0 };
function measureSafeArea(): void {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  safe.top = parseFloat(cs.paddingTop) || 0;
  safe.bottom = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
}

// 进入视口后把坐标夹进可视范围(换了更小的屏幕/旋转后不至于跑出去);上沿至少留 4% 或状态栏高度
function clampToViewport(): void {
  const minY = Math.max(safe.top, Math.round(window.innerHeight * 0.04));
  const maxY = Math.max(minY, window.innerHeight - orbH.value - safe.bottom);
  pos.y = Math.min(Math.max(minY, pos.y), maxY);
  if (pos.dock === 'none') {
    const maxX = Math.max(0, window.innerWidth - orbW.value);
    pos.x = Math.min(Math.max(0, pos.x), maxX);
  }
}

function savePos(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// —— 定位样式:贴边用 left/right 锚定 + translateX 控制隐/现;free 用绝对 x/y ——
const orbStyle = computed(() => {
  const base: Record<string, string> = {
    top: `${pos.y}px`,
    width: `${orbW.value}px`,
    height: `${orbH.value}px`,
    // 静止不透明度走 CSS 变量,唤起/拖动态由类覆盖回全显
    '--orb-rest-opacity': String(Math.min(100, Math.max(20, ui.orbOpacity)) / 100),
    // 图标字号随基准尺寸缩放(原 48 球 ≈ 22px),保持图标与球体比例协调
    '--orb-icon-size': `${Math.round(ui.orbSize * 0.46)}px`,
  };
  if (pos.dock === 'left') {
    base.left = '0px';
    // 静止半隐(露 ~40%);拖动/唤起时整条滑出
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(-58%)';
  } else if (pos.dock === 'right') {
    base.right = '0px';
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(58%)';
  } else {
    base.left = `${pos.x}px`;
    base.transform = 'translateX(0)';
  }
  return base;
});

const orbImage = computed(() => ui.orbImage.trim());
// 自定义图标加载失败时改显示小狐狸;换了图标再试
const imageFailed = ref(false);
watch(orbImage, () => { imageFailed.value = false; });
const showImage = computed(() => !!orbImage.value && !imageFailed.value);
// 小狐狸在不同形状里的大小：书签按宽度，圆和方按边长留出边距，免得耳朵被裁掉。
const foxSize = computed(() => Math.round(ui.orbShape === 'bookmark' ? orbW.value * 0.86 : ui.orbSize * (ui.orbShape === 'circle' ? 0.7 : 0.76)));

// —— 拖动 ——
function onDown(e: PointerEvent) {
  activePointer = e.pointerId;
  pointerType = e.pointerType || 'mouse';
  dragging.value = true;
  dragMoved = false;
  startPos = { ...pos };
  startX = e.clientX;
  startY = e.clientY;
  // 记录手指相对左上角的抓取点,拖动时保持
  grabDX = e.clientX - currentLeft();
  grabDY = e.clientY - pos.y;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

let grabDX = 0;
let grabDY = 0;

/** 当前左上角的实际 x(贴边态由 right/translate 折算成绝对像素,供拖动起步用) */
function currentLeft(): number {
  if (pos.dock === 'right') return window.innerWidth - orbW.value;
  if (pos.dock === 'left') return 0;
  return pos.x;
}

function onMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  if (!dragMoved) {
    // 点按时手指的轻微抖动不挪动悬浮球,也不让它离开贴边;超过容差才开始拖动
    if (!beyondSlop(e.clientX - startX, e.clientY - startY, pointerType)) return;
    dragMoved = true;
  }
  // 拖动中一律切 free 跟手(整条可见)
  pos.dock = 'none';
  pos.x = e.clientX - grabDX;
  pos.y = e.clientY - grabDY;
  clampToViewport();
}

function onUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;

  if (!dragMoved) {
    // 视为点按 → 打开棱镜宝书(位置与贴边状态都没动过)
    openBook();
    return;
  }

  // 松手吸附判定:靠近左/右边缘才贴边,否则停在原地(中间)
  const left = pos.x;
  const right = window.innerWidth - (pos.x + orbW.value);
  if (left <= SNAP_ZONE) pos.dock = 'left';
  else if (right <= SNAP_ZONE) pos.dock = 'right';
  else pos.dock = 'none';
  clampToViewport();
  savePos();
}

/** 系统手势接管(如安卓返回手势)时浏览器发 pointercancel:不算点按,拖到一半的回到原位。 */
function onCancel(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragMoved && startPos) {
    Object.assign(pos, startPos);
    clampToViewport();
  }
  dragMoved = false;
}

// —— 键盘可达 ——
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openBook();
  }
}

const onResize = () => {
  measureSafeArea();
  clampToViewport();
  savePos();
};
onMounted(() => {
  measureSafeArea();
  clampToViewport();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div
    class="bbs-orb"
    :class="[`shape-${ui.orbShape}`, { 'is-dragging': dragging, 'has-image': showImage }]"
    :style="orbStyle"
    role="button"
    tabindex="0"
    aria-label="打开棱镜宝书"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onCancel"
    @pointerenter="awake = true"
    @pointerleave="awake = false"
    @focus="awake = true"
    @blur="awake = false"
    @keydown="onKey"
  >
    <img v-if="showImage" :src="orbImage" class="bbs-orb-img" alt="" draggable="false" @error="imageFailed = true" />
    <BrandMark v-else :size="foxSize" class="bbs-orb-brand" />
  </div>
</template>

<style scoped>
.bbs-orb {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* 由公共令牌提供轻阴影；触屏和窄屏直接关闭滤镜。 */
  filter: var(--bbs-orb-shadow);
  opacity: var(--orb-rest-opacity, 0.62);
  transition:
    transform var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}

/* —— 形状 —— */
/* 书签:缎带轮廓 + 底部燕尾缺口。clip-path 天然裁切自定义图。 */
.bbs-orb.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
}
/* 圆 / 方:border-radius + overflow 裁切自定义图 */
.bbs-orb.shape-circle {
  border-radius: 999px;
  overflow: hidden;
}
.bbs-orb.shape-square {
  border-radius: 12px;
  overflow: hidden;
}

/* 唤起(hover/聚焦/拖动)或停在中间(free) → 全显 */
.bbs-orb:hover,
.bbs-orb:focus-visible,
.bbs-orb.is-dragging {
  opacity: 1;
}
.bbs-orb:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: -3px;
  color: var(--bbs-accent);
}
.bbs-orb:active {
  cursor: grabbing;
}

.bbs-orb-icon {
  font-size: var(--orb-icon-size, 22px);
  pointer-events: none;
}
/* 书签:图标上移,避开底部燕尾缺口(圆/方无缺口,居中即可) */
.bbs-orb.shape-bookmark .bbs-orb-icon {
  margin-bottom: 6px;
}

.bbs-orb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bbs-orb {
    transition: none;
  }
}
.bbs-orb-brand{pointer-events:none}.bbs-orb.shape-bookmark .bbs-orb-brand{margin-bottom:calc(var(--orb-icon-size, 22px) * .5)}
</style>
