<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageHeader from '@/components/PageHeader.vue';
import ModalShell from '@/components/ModalShell.vue';
import StatRow from '@/components/StatRow.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { appendOpToLatestLeaf, editItem } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import { computed, ref } from 'vue';

const newName = ref('');
// 仅本页视图筛选，不参与记忆写入或注入。
const search = ref('');
const carryFilter = ref<'all' | 'carried' | 'stored'>('all');
const carriedCount = computed(() => memory.items.filter(it => it.carried !== false).length);
const visibleItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return memory.items.filter(it =>
    (carryFilter.value === 'all' || (carryFilter.value === 'carried' ? it.carried !== false : it.carried === false)) &&
    (!query || [it.name, it.desc, it.location].some(value => value?.toLocaleLowerCase().includes(query))),
  );
});

// 物品/计划是从叶子摘要重放出来的派生数据,手动操作单独保存在「最新一条有效叶子」上
// (重新摘要或重抽后仍然保留)。没有任何有效叶子时无处挂载,禁止手动添加。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

function addItem() {
  const name = newName.value.trim();
  if (!name) return;
  if (!appendOpToLatestLeaf({ items: { add: [{ name }] } })) return;
  newName.value = '';
}

const removing = ref<{ id: string; name: string } | null>(null);
function removeItem(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  removing.value = { id: it.id, name: it.name };
}
function confirmRemove() {
  const name = removing.value?.name;
  removing.value = null;
  if (name) appendOpToLatestLeaf({ items: { remove: [name] } });
}

/* —— 编辑弹窗:改名/数量/描述。数量留空=维持(update 无法清空,清空数量请删后重建) —— */
interface ItemEditing {
  oldName: string;
  name: string;
  qty: string; // 文本承载,空=不改数量
  desc: string;
  carried: boolean; // 是否随身
  location: string; // 非随身时的存放地
}
const editing = ref<ItemEditing | null>(null);

function openEdit(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  editing.value = {
    oldName: it.name,
    name: it.name,
    qty: typeof it.qty === 'number' ? String(it.qty) : '',
    desc: it.desc ?? '',
    carried: it.carried !== false, // 省略/true 视作随身
    location: it.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  // qty 用 String() 兜底:type="number" 的 v-model 会把值转成 number(Vue 对 number input 的默认行为),
  // 直接 .trim() 会因「number 无 trim」抛错 → saveEdit 中断、弹窗不关(表现为点保存没反应)。
  const qtyStr = String(e.qty).trim();
  const qty = qtyStr === '' ? undefined : Number(qtyStr);
  // 随身 → 清空存放地;非随身 → 用填写的地点
  editItem(e.oldName, {
    name: e.name,
    qty: qty !== undefined && Number.isFinite(qty) ? qty : undefined,
    desc: e.desc,
    carried: e.carried,
    location: e.carried ? '' : e.location,
  });
  editing.value = null;
}
</script>

<template>
  <section class="bbs-page bbs-ledger">
    <PageHeader icon="items" title="物品" description="摘要时记录的物品，分为随身携带和存放在别处两类，可手动补录和修改。" />
    <SummaryOnlyNotice subject="物品清单与变动" />

    <StatRow
      label="物品概览"
      :items="[
        { value: memory.items.length, label: '种物品' },
        { value: carriedCount, label: '随身' },
        { value: memory.items.length - carriedCount, label: '存放' },
      ]"
      :note="hasLeaf ? '手动修改单独保存，重新摘要或重抽后仍然保留' : '生成摘要后可手动补录'"
    />

    <div class="bbs-additem">
      <label class="bbs-additem-field">
        <span>补录一件物品</span>
        <input v-model="newName" class="bbs-input" type="text"
          :placeholder="hasLeaf ? '输入物品名称…' : '需先有摘要才能手动添加'"
          :disabled="!hasLeaf" @keydown.enter="addItem" />
      </label>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf || !newName.trim()" @click="addItem"><Icon name="plus" />添加</button>
    </div>

    <div v-if="memory.items.length" class="bbs-filterbar">
      <label class="bbs-search"><Icon name="search" /><input v-model="search" class="bbs-input" type="search" aria-label="搜索物品名称、描述或存放地" placeholder="搜索物品、描述或存放地" /></label>
      <div class="bbs-filter-tabs" role="group" aria-label="按携带状态筛选">
        <button type="button" class="bbs-filter-tab" :aria-pressed="carryFilter === 'all'" @click="carryFilter = 'all'">全部</button>
        <button type="button" class="bbs-filter-tab" :aria-pressed="carryFilter === 'carried'" @click="carryFilter = 'carried'">随身</button>
        <button type="button" class="bbs-filter-tab" :aria-pressed="carryFilter === 'stored'" @click="carryFilter = 'stored'">存放</button>
      </div>
      <span class="bbs-results" role="status">显示 {{ visibleItems.length }} / {{ memory.items.length }} 种</span>
    </div>

    <div v-if="visibleItems.length" class="bbs-item-list">
      <article v-for="it in visibleItems" :key="it.id" class="bbs-item">
        <div class="bbs-item-head">
          <span class="bbs-item-symbol"><Icon :name="it.carried === false ? 'scenes' : 'items'" /></span>
          <div class="bbs-item-main">
            <span class="bbs-item-name" :title="it.name">{{ it.name }}</span>
            <span v-if="typeof it.qty === 'number'" class="bbs-item-qty">×{{ it.qty }}</span>
          </div>
          <span class="bbs-item-acts">
            <IconButton icon="edit" :label="'编辑物品：' + it.name" title="编辑" @click="openEdit(it.id)" />
            <IconButton icon="trash" tone="danger" :label="'删除物品：' + it.name" title="删除" @click="removeItem(it.id)" />
          </span>
        </div>
        <div class="bbs-item-detail">
          <span class="bbs-item-status" :class="{ stored: it.carried === false }">{{ it.carried === false ? '存放' : '随身' }}</span>
          <span v-if="it.carried === false" class="bbs-item-loc"><Icon name="scenes" />{{ it.location || '未注明地点' }}</span>
        </div>
        <p v-if="it.desc" class="bbs-item-desc">{{ it.desc }}</p>
      </article>
    </div>
    <EmptyState v-else-if="memory.items.length" icon="search" title="没有找到匹配的物品" text="请更换关键词，或切换到「全部」。">
      <button class="bbs-btn" type="button" @click="search = ''; carryFilter = 'all'">清除筛选</button>
    </EmptyState>
    <EmptyState v-else icon="items" title="暂无物品" :text="'摘要会自动记录剧情中出现的物品。' + (hasLeaf ? '也可在上方手动补录。' : '生成第一条摘要后可手动补录。')" />

    <!-- 编辑弹窗:Teleport 出滚动容器,见 ModalMask -->
    <ModalShell :open="!!editing" title="编辑物品" @close="cancelEdit">
      <template v-if="editing">
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名称</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="物品名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">数量（留空则维持原值）</span>
          <input v-model="editing.qty" class="bbs-input" type="number" min="0" placeholder="留空不修改已有数量" />
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.carried" type="checkbox" />
          <span class="bbs-modal-label">随身携带（取消勾选可指定存放地）</span>
        </label>
        <label v-if="!editing.carried" class="bbs-modal-field">
          <span class="bbs-modal-label">存放地点</span>
          <input v-model="editing.location" class="bbs-input" type="text" placeholder="如：武器库、家中" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">描述</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="可选"></textarea>
        </label>
      </template>
      <template #footer>
        <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing?.name.trim()" @click="saveEdit">保存</button>
      </template>
    </ModalShell>
    <ConfirmDialog
      :open="!!removing"
      title="删除物品"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      删除「{{ removing?.name }}」？这项修改单独保存，重新摘要或重抽后仍然保留。
    </ConfirmDialog>
  </section>
</template>

<style scoped>

/* 页面外壳（统计行、搜索、筛选、图标按钮、空状态）在 base.css 的 .bbs-ledger 中统一定义。 */

.bbs-additem { display: flex; align-items: flex-end; gap: 10px; margin-bottom: 24px; }
.bbs-additem-field { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 8px; }
.bbs-additem-field > span { font-size: 12px; font-weight: 600; color: var(--bbs-ink-soft); }
.bbs-additem-field .bbs-input { width: 100%; }
.bbs-additem > .bbs-btn { flex-shrink: 0; }
.bbs-results { font-size: 11px; color: var(--bbs-ink-muted); flex-basis: 100%; }
.bbs-item-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 310px), 1fr)); gap: 12px; }
.bbs-item { min-width: 0; padding: 16px; border: 1px solid var(--bbs-line); border-radius: 15px; background: var(--bbs-surface); box-shadow: var(--bbs-card-shadow); }
.bbs-item:hover { border-color: var(--bbs-line-strong); }
.bbs-item-head { display: flex; align-items: flex-start; gap: 10px; }
.bbs-item-symbol { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 34px; height: 34px; border-radius: 11px; background: var(--bbs-accent-soft); color: var(--bbs-accent); font-size: 18px; }
.bbs-item-main { display: flex; align-items: baseline; flex: 1; flex-wrap: wrap; gap: 5px 8px; min-width: 0; padding-top: 5px; }
.bbs-item-name { min-width: 0; font-size: 15px; font-weight: 650; line-height: 1.6; overflow-wrap: anywhere; }
.bbs-item-qty { flex-shrink: 0; padding: 1px 7px; border-radius: 6px; background: var(--bbs-surface-2); font-size: 12px; color: var(--bbs-accent); font-variant-numeric: tabular-nums; }
.bbs-item-acts { display: inline-flex; flex-shrink: 0; gap: 2px; }
.bbs-item-detail { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-top: 12px; font-size: 11px; }
.bbs-item-status { padding: 3px 8px; border-radius: 6px; background: var(--bbs-accent-soft); color: var(--bbs-accent); }
.bbs-item-status.stored { background: var(--bbs-warning-soft); color: var(--bbs-warning); }
.bbs-item-loc { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; overflow-wrap: anywhere; color: var(--bbs-ink-muted); }
.bbs-item-desc { margin: 12px 0 0; padding-top: 12px; border-top: 1px solid var(--bbs-line); font-size: 13px; line-height: 1.8; color: var(--bbs-ink-soft); overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 480px) { .bbs-item { padding: 13px; } .bbs-item-symbol { display: none; } .bbs-item-head { gap: 5px; } }
</style>
