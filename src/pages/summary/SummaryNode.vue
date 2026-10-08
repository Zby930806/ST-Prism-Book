<script setup lang="ts">
/** 单张卡片：父页统一展开并分页，不挂载隐藏后代，不创建递归组件。 */
import Icon from '@/components/Icon.vue';
import { computed, inject } from 'vue';
import type { ViewNode } from '@/memory/inject';
import { SUMMARY_CTX, type SummaryCtx } from './ctx';

const props = defineProps<{ node: ViewNode; depth: number; parentId?: string }>();

const ctx = inject(SUMMARY_CTX) as SummaryCtx;

const row = computed(() => ctx.toRow(props.node, ctx.byId.value));
const childCount = computed(() => ctx.childCount(props.node));
const expandable = computed(() => childCount.value > 0);
const isExpanded = computed(() => ctx.expanded.value.has(props.node.id));
const isChild = computed(() => props.depth > 0);
</script>

<template>
  <div class="bbs-node" :class="{ 'is-nested': depth > 1 }">
    <article
      class="bbs-summary-card"
      :class="{ 'is-deep': row.level > 0, 'is-child': isChild, 'is-expanded': isExpanded && expandable }"
    >
      <div class="bbs-summary-main">
        <p v-if="isChild" class="bbs-node-context"><span>来源摘要 · {{ depth }} 层</span>
          <button v-if="parentId" class="bbs-source-link" type="button" aria-label="返回上层总结" @click="ctx.revealNode(parentId)">↖ 返回上层</button>
          <button v-if="parentId" class="bbs-source-collapse" type="button" aria-label="收起上层" title="收起上层" @click="ctx.toggleExpand(parentId); ctx.revealNode(parentId)"><Icon name="chevron" /></button>
        </p>
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
            <button class="bbs-summary-act" type="button" :title="row.imported ? '编辑导入历史' : row.kind === 'comp' ? '编辑总结' : '编辑摘要'" :aria-label="row.imported ? '编辑导入历史' : row.kind === 'comp' ? '编辑总结' : '编辑摘要'" @click="ctx.openEdit(row)">
              <Icon name="edit" />
            </button>
            <button v-if="!isChild" class="bbs-summary-act bbs-summary-del" type="button" :title="row.imported ? '删除导入历史' : row.kind === 'comp' ? '删除总结(下层会展开)' : '删除摘要'" :aria-label="row.imported ? '删除导入历史' : row.kind === 'comp' ? '删除总结(下层会展开)' : '删除摘要'" @click="ctx.onDelete(row)">
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
          :aria-label="isExpanded ? '收起下层摘要' : `展开下层 ${childCount} 条摘要`"
          :title="isExpanded ? '收起下层摘要' : `展开下层 ${childCount} 条摘要`"
          @click="ctx.toggleExpand(node.id)"
        >
          <Icon name="chevron" class="bbs-expand-caret" :class="{ 'is-collapsed': !isExpanded }" />
          {{ isExpanded ? `收起下层 ${childCount} 条` : `展开下层 ${childCount} 条` }}
        </button>
      </div>
    </article>


  </div>
</template>

<style scoped>
.bbs-node { display:block; min-width:0; }
.bbs-node-context { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:0 0 4px; color:var(--bbs-ink-muted); font-size:10px; line-height:1.6; }
.bbs-node-context > span { flex:1; }
.bbs-source-link,.bbs-source-collapse { display:inline-flex; align-items:center; justify-content:center; min-height:36px; border:0; background:transparent; color:var(--bbs-ink-soft); cursor:pointer; font:400 10px/1.5 var(--bbs-font-sans); padding:4px 6px; border-radius:5px; }
.bbs-source-collapse { min-width:36px; }
.bbs-source-collapse .bbs-icon { transform:rotate(180deg); }
.bbs-source-link:hover,.bbs-source-collapse:hover { color:var(--bbs-accent); background:var(--bbs-accent-soft); }
.bbs-source-link:focus-visible,.bbs-source-collapse:focus-visible { outline:2px solid var(--bbs-accent); }
.bbs-expand-bar { flex-wrap:wrap; }
</style>
