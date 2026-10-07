<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import ModalMask from '@/components/ModalMask.vue';
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

// 物品/计划是从叶子摘要重放出来的派生数据,手动操作写入「最新一条有效叶子」。
// 没有任何有效叶子时无处挂载,禁止手动添加。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

function addItem() {
  const name = newName.value.trim();
  if (!name) return;
  if (!appendOpToLatestLeaf({ items: { add: [{ name }] } })) return;
  newName.value = '';
}

function removeItem(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  appendOpToLatestLeaf({ items: { remove: [it.name] } });
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
  <section class="bbs-page">
    <PageHeader icon="items" title="物品" eyebrow="故事行囊" description="随身所携，异地所藏。让每件物品都有迹可循。" />
    <SummaryOnlyNotice subject="物品清单与变动" />

    <div class="bbs-ledger-meta" aria-label="物品概览">
      <span><strong>{{ memory.items.length }}</strong>种物品</span>
      <span><strong>{{ carriedCount }}</strong>随身</span>
      <span><strong>{{ memory.items.length - carriedCount }}</strong>存放</span>
      <span class="bbs-ledger-note">{{ hasLeaf ? '手动变动写入最新有效摘要' : '先生成摘要，再手动补录' }}</span>
    </div>

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
      <div class="bbs-filter-tabs" aria-label="按携带状态筛选">
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
            <button class="bbs-item-act" type="button" title="编辑" :aria-label="'编辑物品：' + it.name" @click="openEdit(it.id)"><Icon name="edit" /></button>
            <button class="bbs-item-act bbs-item-del" type="button" title="删除" :aria-label="'删除物品：' + it.name" @click="removeItem(it.id)"><Icon name="trash" /></button>
          </span>
        </div>
        <div class="bbs-item-detail">
          <span class="bbs-item-status" :class="{ stored: it.carried === false }">{{ it.carried === false ? '存放' : '随身' }}</span>
          <span v-if="it.carried === false" class="bbs-item-loc"><Icon name="scenes" />{{ it.location || '未注明地点' }}</span>
        </div>
        <p v-if="it.desc" class="bbs-item-desc">{{ it.desc }}</p>
      </article>
    </div>
    <div v-else-if="memory.items.length" class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="search" /></span>
      <h3>没有找到匹配的物品</h3><p>换个关键词，或查看全部携带状态。</p>
      <button class="bbs-btn" type="button" @click="search = ''; carryFilter = 'all'">清除筛选</button>
    </div>
    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="items" /></span>
      <h3>行囊待书写</h3>
      <p>摘要会自动登记剧情中的物品。{{ hasLeaf ? '也可以在上方补录，再编辑数量、描述与存放地点。' : '生成第一条有效摘要后，即可手动补录。' }}</p>
    </div>

    <!-- 编辑弹窗:Teleport 出滚动容器,见 ModalMask -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑物品">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑物品</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
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
          <span class="bbs-modal-label">随身携带(取消勾选可指定存放地)</span>
        </label>
        <label v-if="!editing.carried" class="bbs-modal-field">
          <span class="bbs-modal-label">存放地点</span>
          <input v-model="editing.location" class="bbs-input" type="text" placeholder="如:武器库、家中" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">描述</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="可选"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>

/* 页面本身保持文档流，滚动交给书页容器；不把工具栏与说明再套成卡片。 */
.bbs-page { display: flex; flex-direction: column; height: auto; min-width: 0; min-height: 100%; color: var(--bbs-ink); }
.bbs-page, .bbs-page * { box-sizing: border-box; }
.bbs-page .bbs-input { min-width: 0; max-width: 100%; }
.bbs-page button { font-family: inherit; }
.bbs-page button:focus-visible, .bbs-page input:focus-visible, .bbs-page textarea:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 3px; }
.bbs-page button:disabled { cursor: not-allowed; }
.bbs-page .bbs-btn { min-height: 38px; gap: 6px; white-space: normal; }
.bbs-ledger-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin: 18px 0; padding: 0 0 14px; border-bottom: 1px solid var(--bbs-line); font-size: 12px; line-height: 1.6; color: var(--bbs-ink-muted); }
.bbs-ledger-meta strong { margin-right: 4px; font-size: 19px; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--bbs-ink); }
.bbs-ledger-note { margin-left: auto; color: var(--bbs-accent); }
.bbs-search { display: flex; align-items: center; gap: 9px; flex: 1 1 200px; min-width: 0; color: var(--bbs-ink-muted); }
.bbs-search > .bbs-input { flex: 1; width: 100%; }
.bbs-filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 18px; }
.bbs-filter-tabs { display: flex; flex-wrap: wrap; gap: 4px; }
.bbs-filter-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 11px; border: 1px solid var(--bbs-line); border-radius: 9px; background: var(--bbs-surface); color: var(--bbs-ink-soft); font-size: 12px; cursor: pointer; }
.bbs-filter-tab[aria-pressed='true'] { background: var(--bbs-accent-soft); border-color: var(--bbs-accent); color: var(--bbs-accent); }
.bbs-filter-tab span { font-variant-numeric: tabular-nums; font-size: 11px; }
.bbs-item-act { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 36px; height: 36px; padding: 0; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--bbs-ink-soft); cursor: pointer; font-size: 15px; }
.bbs-item-act:hover:not(:disabled) { background: var(--bbs-surface-2); border-color: var(--bbs-line); color: var(--bbs-accent); }
.bbs-item-del:hover:not(:disabled) { background: var(--bbs-danger-soft); color: var(--bbs-danger); border-color: var(--bbs-danger); }
.bbs-empty { display: flex; flex: none; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 230px; padding: 34px 16px; margin: 12px 0; text-align: center; background: transparent; }
.bbs-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 54px; height: 54px; border-radius: 18px; background: var(--bbs-accent-soft); color: var(--bbs-accent); font-size: 25px; }
.bbs-empty h3 { margin: 5px 0 0; color: var(--bbs-ink); font-size: 16px; font-weight: 650; }
.bbs-empty p { max-width: 360px; margin: 0; color: var(--bbs-ink-muted); font-size: 13px; line-height: 1.8; }
.bbs-empty .bbs-btn { margin-top: 6px; }
.bbs-modal { min-width: 0; overflow-wrap: anywhere; }
.bbs-modal-head, .bbs-modal-foot { flex-wrap: wrap; }
.bbs-modal-textarea { resize: vertical; min-height: 80px; font-family: inherit; }
.bbs-modal-check { flex-direction: row; align-items: center; gap: 9px; cursor: pointer; }
.bbs-modal-check input { flex-shrink: 0; }
@media (max-width: 480px) {
  .bbs-ledger-meta { gap: 6px 14px; margin: 16px 0; }
  .bbs-ledger-note { flex-basis: 100%; margin-left: 0; }
  .bbs-search { flex-basis: 100%; }
  .bbs-filterbar { gap: 10px; }
  .bbs-item-act { width: 40px; height: 40px; }
  .bbs-page .bbs-btn { min-height: 42px; }
  .bbs-filter-tab { min-height: 40px; }
  .bbs-empty { min-height: 210px; padding: 26px 10px; }
}

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
