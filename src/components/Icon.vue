<script setup lang="ts">
import { computed } from 'vue';

/**
 * 内联 SVG 图标 —— 不依赖字体库,天然跨 shadow DOM。
 * 统一 24×24 视框、描边风格(currentColor + stroke),
 * 通过 CSS color / font-size(1em=当前字号)继承尺寸与颜色。
 * 新增图标:往 PATHS 里加一条 name -> 内部 <path>/<circle> 标记。
 */
const props = defineProps<{ name: string; size?: number | string }>();

// 仅放路径数据,统一的 svg 外壳在模板里。stroke 风格。
const PATHS: Record<string, string> = {
  // 摘要:文档 + 文本行
  summary:
    '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h6M9 9h2"/>',
  // 角色:人像
  characters: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
  // NPC 名册(导航):双人像,区别于单人 characters
  npcs:
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.6a3 3 0 0 1 0 4.8"/><path d="M17 14.8c2.3.5 3.9 2.3 3.9 4.7"/>',
  // 随行:图钉(标记/取消同伴)
  pin: '<path d="M12 2.5 9 5.5l1 1L7 13l-3 .5 3.5 3.5L11 14l6.5-3 1 1 3-3-6.5-6.5z"/><path d="M5 19l3.2-3.2"/>',
  // 主要角色:五角星(描边=未标记,可点亮)
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9z"/>',
  // 场景:山 + 日
  scenes:
    '<circle cx="8" cy="8" r="2"/><path d="M3.5 19.5 9 12l4 5"/><path d="M11.5 19.5 16 13.5l4.5 6"/><path d="M3.5 19.5h17"/>',
  // 物品:立方体
  items:
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8"/><path d="M12 12.5V20.5"/>',
  // 双子札记:并排书签，与既有书签品牌统一描边。
  notes: '<path d="M5 4.5h6v15L8 17l-3 2.5z"/><path d="M14 4.5h5v15L16.5 17 14 19.5z"/>',
  // 世界书:书本封面上一个地球(经纬线),区别于摘要的文档和札记的书签
  worldbook:
    '<path d="M5.5 4.5h12a1 1 0 0 1 1 1v14h-12a1 1 0 0 1-1-1z"/><path d="M5.5 17.5a1 1 0 0 1 1-1h12"/><circle cx="12" cy="10.25" r="3.4"/><path d="M8.6 10.25h6.8M12 6.85c-1.3 1.8-1.3 5 0 6.8M12 6.85c1.3 1.8 1.3 5 0 6.8"/>',
  // 设置:滑块
  settings:
    '<path d="M5 8h9M18 8h1"/><path d="M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  // 变量:花括号 { } —— 自定义 JSON 变量,区别于设置的滑块
  vars:
    '<path d="M9 4.5c-2 0-2 2.4-2 4 0 1.8-.8 2.9-2.5 3 1.7.1 2.5 1.2 2.5 3 0 1.6 0 4 2 4"/><path d="M15 4.5c2 0 2 2.4 2 4 0 1.8.8 2.9 2.5 3-1.7.1-2.5 1.2-2.5 3 0 1.6 0 4-2 4"/>',
  // 导出/分享:箭头向上出托盘
  upload: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // 导入:箭头向下入托盘
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // 复制:重叠文档
  copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/>',
  // 书签(品牌标)
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  // 月亮
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
  // 太阳
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  // 关闭
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // 对勾:确认/保存
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  // 新增/加号
  plus: '<path d="M12 5v14M5 12h14"/>',
  // 显示(睁眼)
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  // 隐藏(闭眼/划线)
  'eye-off':
    '<path d="M4 4l16 16"/><path d="M9.6 5.8A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.8 15.8 0 0 1-3.3 3.9"/><path d="M6.3 8.1A15.9 15.9 0 0 0 2.5 12S6 18.5 12 18.5a8.5 8.5 0 0 0 3.2-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  // 向下箭头(折叠指示)
  chevron: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  // 前往地点:带长箭杆的向右箭头,区别于折叠用 chevron
  navigate: '<path d="M4 12h15"/><path d="m14 7 5 5-5 5"/>',
  // 搜索:放大镜
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  // 多选:勾选清单(左侧对勾 + 右侧行,一眼看出「勾选多条」)
  checklist: '<path d="M3.5 6.5 5 8l2.5-2.5M3.5 12.5 5 14l2.5-2.5M3.5 18.5 5 20l2.5-2.5"/><path d="M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5"/>',
  // 闪电:立即/瞬时(立即总结)。原始 y 范围偏满(顶天立地显高),
  // 以中心 y=12 略压到 ~4.0~20.0,视觉高度向放大镜/清单看齐(压太狠会显矮,取中)。
  bolt: '<path d="M13 4 5 13h6l-1 7 8-9h-6z"/>',
  // 计划/悬念:旗标
  plans: '<path d="M6 21V4M6 4.5h11l-2.5 3.5L17 11.5H6"/>',
  // 连接/测试
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z M12 16v5"/>',
  // 刷新/拉取
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16M20 20v-4h-4"/>',
  // 删除/垃圾桶:桶身略收窄(7~17),减轻视觉分量,与铅笔平衡
  trash: '<path d="M5 7.5h14M10 7.5V6h4v1.5M7 7.5l.8 11h8.4l.8-11"/>',
  // 编辑/铅笔:斜跨 4.5~19.5,墨迹比原来铺满,视觉分量与垃圾桶相当(否则铅笔显小一号)
  edit: '<path d="M4.5 19.5h4L19 9 15 5 4.5 15.5z"/><path d="M13 7 17 11"/>',
  // 闪耀/梦幻(粉彩主题)
  sparkles:
    '<path d="M12 4c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z"/><path d="M18.5 14c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z"/>',
  // 时钟:故事时间(楼层面板时间、重新摘要对比弹窗)
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  // 地点:定位针(楼层面板地点)
  location: '<path d="M12 20.5s-6.5-5.4-6.5-10.6a6.5 6.5 0 0 1 13 0c0 5.2-6.5 10.6-6.5 10.6z"/><circle cx="12" cy="10" r="2.3"/>',
  // 返回:向左的箭头(规划讨论标题栏)
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  // 发送:纸飞机(规划讨论输入栏)
  send: '<path d="M20.5 3.5 10.2 13.8"/><path d="M20.5 3.5 14 20.5l-3.8-6.7-6.7-3.8z"/>',
  // 停止:圆角方块(中止等待中的请求)
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  // 更多:横向三点(更多操作菜单)
  more: '<circle cx="5.5" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18.5" cy="12" r="1.1"/>',
  // 放大 / 还原窗口:斜向外、斜向内的双箭头
  maximize: '<path d="M14 4.5h5.5V10"/><path d="M10 19.5H4.5V14"/><path d="m19.5 4.5-6 6"/><path d="m4.5 19.5 6-6"/>',
  minimize: '<path d="M14 5.5V10h4.5"/><path d="M10 18.5V14H5.5"/><path d="m14 10 5.5-5.5"/><path d="M10 14l-5.5 5.5"/>',
  // 说明:圆圈 + i
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8v.2"/>',
  // 减号(数量步进器)
  minus: '<path d="M5 12h14"/>',
  // 右上箭头:打开下一步(生成草稿)
  'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
  // 随行同伴:人像 + 向右箭头(角色卡「随行」开关)
  follow: '<circle cx="8.5" cy="7.5" r="3"/><path d="M3.5 19.5c0-3.1 2.2-5.3 5-5.3s5 2.2 5 5.3"/><path d="M15 12h6"/><path d="M18.5 9.5 21 12l-2.5 2.5"/>',
  // 沉降:收纳盒(生活小档案「沉降」开关)
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 12.5h4"/>',
};

const inner = computed(() => PATHS[props.name] ?? '');
const dim = computed(() => (props.size ? (typeof props.size === 'number' ? `${props.size}px` : props.size) : '1em'));
</script>

<template>
  <svg
    class="bbs-icon"
    :style="{ width: dim, height: dim }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.bbs-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.15em;
}
</style>
