<script setup lang="ts">
/**
 * 摘要森林的一个节点(递归)。默认视图用:一张卡片 + 底部展开条,
 * 展开时下方 grid(0fr↔1fr)容器平滑撑开,内部递归渲染子节点 + 组尾收起条。
 * 高度过渡与 Collapsible.vue / 悬念簿同款——内容常驻 DOM,不脱流,故无闪烁。
 */
import Icon from '@/components/Icon.vue';
import { computed, inject } from 'vue';
import type { ViewNode } from '@/memory/inject';
import { SUMMARY_CTX, type SummaryCtx } from './ctx';

const props = defineProps<{ node: ViewNode; depth: number }>();

const ctx = inject(SUMMARY_CTX) as SummaryCtx;

const row = computed(() => ctx.toRow(props.node, ctx.byId.value));
const children = computed<ViewNode[]>(() => {
  if (props.node.kind !== 'comp') return [];
  const map = ctx.byId.value;
  const list = props.node.childIds.map(cid => map.get(cid)).filter((c): c is ViewNode => !!c);
  // 子节点按覆盖楼层倒序(新楼在上),与根列表同序
  return list.sort((a, b) => ctx.nodeFloors(b, map)[1] - ctx.nodeFloors(a, map)[1]);
});
const expandable = computed(() => children.value.length > 0);
const isExpanded = computed(() => ctx.expanded.value.has(props.node.id));
const isChild = computed(() => props.depth > 0);
</script>

<template>
  <div class="bbs-node">
    <article
      class="bbs-summary-card"
      :class="{ 'is-deep': row.level > 0, 'is-child': isChild, 'is-expanded': isExpanded && expandable }"
    >
      <div class="bbs-summary-main">
        <header class="bbs-summary-meta">
          <template v-if="row.kind === 'comp'">
            <span class="bbs-summary-badge">{{ ctx.levelLabel(row.level, row.imported) }}</span>
            <span class="bbs-summary-loc">{{ ctx.floorLabel(row) }}</span>
            <span v-if="ctx.rowRelative(row)" class="bbs-summary-rel">({{ ctx.rowRelative(row) }})</span>
            <span v-if="ctx.rowTime(row)" class="bbs-summary-time">{{ ctx.rowTime(row) }}</span>
          </template>
          <template v-else>
            <span v-if="ctx.rowRelative(row)" class="bbs-summary-rel">{{ ctx.rowRelative(row) }}</span>
            <span class="bbs-summary-loc">{{ ctx.floorLabel(row) }}</span>
            <span v-if="ctx.rowTime(row)" class="bbs-summary-dateline">{{ ctx.rowTime(row) }}</span>
          </template>
          <!-- 操作键:编辑对任何层级开放(结构安全:不改 id、不断链;叶子改完向量索引自动重 embed,
               总结不进向量库、只影响上下文注入);删除仅根行——删深层叶子会级联删整条祖先总结链 -->
          <span class="bbs-summary-acts">
            <button class="bbs-summary-act" type="button" :title="row.imported ? '编辑导入历史' : row.kind === 'comp' ? '编辑总结' : '编辑摘要'" @click="ctx.openEdit(row)">
              <Icon name="edit" />
            </button>
            <button v-if="!isChild" class="bbs-summary-act bbs-summary-del" type="button" :title="row.imported ? '删除导入历史' : row.kind === 'comp' ? '删除总结(下层会展开)' : '删除摘要'" @click="ctx.onDelete(row)">
              <Icon name="trash" />
            </button>
          </span>
        </header>
        <p class="bbs-summary-text">{{ row.text }}</p>
        <!-- 展开开关:卡片底部整条,标注「展开/收起下层 N 条」;展开态翻转文案 + 卡片描边点亮 -->
        <button
          v-if="expandable"
          class="bbs-expand-bar"
          type="button"
          :aria-expanded="isExpanded"
          @click="ctx.toggleExpand(node.id)"
        >
          <Icon name="chevron" class="bbs-expand-caret" :class="{ 'is-collapsed': !isExpanded }" />
          {{ isExpanded ? '收起下层' : `展开下层 ${children.length} 条` }}
        </button>
      </div>
    </article>

    <!-- 下层:grid 0fr↔1fr 高度过渡(内容常驻、不脱流,无闪烁);缩进一档标示归属 -->
    <div v-if="expandable" class="bbs-node-children" :class="{ 'is-open': isExpanded }">
      <div class="bbs-node-children-inner">
        <div class="bbs-node-children-body">
          <SummaryNode v-for="c in children" :key="`${c.kind}:${c.id}`" :node="c" :depth="depth + 1" />
          <!-- 组尾收起条:滚到展开内容末尾也能就地收回,不必翻回顶部 -->
          <button class="bbs-collapse-footer" type="button" title="收起下层摘要" @click="ctx.toggleExpand(node.id)">
            <Icon name="chevron" class="bbs-collapse-caret" />
            收起下层 {{ children.length }} 条
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 块级(非 flex):grid 子项高度须由 grid-template-rows 决定;若父级是 flex,
   flex 布局会接管子项高度、把 fr 过渡抹成瞬切——这正是「展开无动画」的根因。
   对照 Collapsible.vue / 悬念簿 .bbs-fold-wrap,其父级都是普通块级。 */
.bbs-node {
  display: block;
}
/* 下层容器:grid 高度过渡,同 Collapsible.vue */
.bbs-node-children {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-node-children.is-open {
  grid-template-rows: 1fr;
}
.bbs-node-children-inner {
  min-height: 0;
  overflow: hidden;
}
/* 子行:上间距 + 左缩进 + 竖线标归属;各子节点之间也留间距 */
.bbs-node-children-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
  margin-left: 18px;
  padding-left: 14px;
  border-left: 1px solid var(--bbs-line);
  /* 与高度撑开同步:内容整体淡入 + 轻微下滑,比单纯拉高更有「滑出来」的观感。
     收起时反向淡出上移。过渡驱动源是父级 .is-open。 */
  opacity: 0;
  transform: translateY(-8px);
  transition: opacity var(--bbs-dur) var(--bbs-ease), transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-node-children.is-open .bbs-node-children-body {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .bbs-node-children,
  .bbs-node-children-body {
    transition: none;
  }
}
</style>
