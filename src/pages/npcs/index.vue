<script setup lang="ts">
/**
 * 角色页：统计行、主角档案、NPC 名册（检索与分组筛选），页尾为生活小档案、信息差。
 * 名册角色卡见 NpcCard，添加/编辑表单见 NpcFormDialog；区块各自的状态与弹窗在对应组件中。
 */
import { apiSettings } from '@/api/settings';
import EmptyState from '@/components/EmptyState.vue';
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import { affinityLevelFromInput } from '@/memory/npcRelations';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StatRow from '@/components/StatRow.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { classifyNpcPresence, editNpc, removeNpc, setNpcFollow, setNpcImportant, upsertNpc } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { MemNpc } from '@/memory/types';
import { getContext } from '@/st/context';
import { computed, nextTick, ref } from 'vue';
import LifeDetailsSection from './LifeDetailsSection.vue';
import NpcCard from './NpcCard.vue';
import NpcFormDialog from './NpcFormDialog.vue';
import NpcSectionHead from './NpcSectionHead.vue';
import ProtagonistCard from './ProtagonistCard.vue';
import SecretsSection from './SecretsSection.vue';
import { emptyNpcDraft, type NpcDraft } from './npcView';

// NPC 是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);
const protagonistName = computed(() => {
  void derivedMeta.rev;
  return getContext()?.name1?.trim() || '主角';
});
const openSecretCount = computed(() => memory.secrets.filter(s => s.status === 'open').length);

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与场景/摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// 在场分档:与注入端(inject.ts)共用同一权威 classifyNpcPresence —— 读 location + locationPath,
// 杜绝两套逻辑漂移,确保「界面显示的 = AI 收到的」。四档:
//   主要角色(置顶,不论在场)/ 在场(全量)/ 同区域(名+身份+性格)/ 不在场(名+身份)。
const sortByCreated = (a: MemNpc, b: MemNpc) => a.createdAt - b.createdAt;

// 单趟分桶:每个非主要角色只判一次在场,避免三个 computed 各判一遍。
const buckets = computed(() => {
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  const absent: MemNpc[] = [];
  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  for (const n of memory.npcs) {
    if (n.important) continue; // 主要角色单列,不进在场判定
    const p = classifyNpcPresence(n, memory.scenes, here, locPath);
    (p === 'present' ? present : p === 'nearby' ? nearby : absent).push(n);
  }
  present.sort(sortByCreated);
  nearby.sort(sortByCreated);
  absent.sort(sortByCreated);
  return { present, nearby, absent };
});
const mains = computed(() => memory.npcs.filter(n => n.important).sort(sortByCreated));
const present = computed(() => buckets.value.present);
const nearby = computed(() => buckets.value.nearby);
const absent = computed(() => buckets.value.absent);

// 检索与分组按钮只筛选名册视图；权威在场判定和注入分组不变。
const npcQuery = ref('');
const npcFilter = ref<'all' | 'mains' | 'present' | 'nearby' | 'absent'>('all');
const npcFilters = computed(() => [
  { key: 'all' as const, label: '全部', count: memory.npcs.length },
  { key: 'mains' as const, label: '主要', count: mains.value.length },
  { key: 'present' as const, label: '在场', count: present.value.length },
  { key: 'nearby' as const, label: '同区域', count: nearby.value.length },
  { key: 'absent' as const, label: '不在场 / 未确认', count: absent.value.length },
]);
const visibleGroups = computed(() => {
  const query = npcQuery.value.trim().toLocaleLowerCase();
  const filterGroup = (key: 'mains' | 'present' | 'nearby' | 'absent', list: MemNpc[]) =>
    npcFilter.value !== 'all' && npcFilter.value !== key ? [] : list.filter(n =>
      !query || [n.name, n.title, n.relation, n.location, n.lastKnownLocation?.place, n.personality, n.desc, n.outfit, n.condition]
        .some(value => value?.toLocaleLowerCase().includes(query)),
    );
  return { mains: filterGroup('mains', mains.value), present: filterGroup('present', present.value),
    nearby: filterGroup('nearby', nearby.value), absent: filterGroup('absent', absent.value) };
});
const visibleNpcCount = computed(() => Object.values(visibleGroups.value).reduce((sum, list) => sum + list.length, 0));

/* —— 随行一键开关:随行→取消(留在当前地点);非随行→标记随行 —— */
function toggleFollow(npc: MemNpc) {
  if (npc.follow === true) {
    // 取消随行:留在当前所在地(无则留空,成为无位置的游离 NPC)
    setNpcFollow(npc.name, false, memory.state.location || '');
  } else {
    setNpcFollow(npc.name, true);
  }
}

/* —— 主要角色一键升/降 —— */
function toggleImportant(npc: MemNpc) {
  setNpcImportant(npc.name, !npc.important);
}

function askRemove(npc: MemNpc) {
  removing.value = npc;
}

/* —— 新增弹窗 —— */
const composerOpen = ref(false);
const composerDialog = ref<InstanceType<typeof NpcFormDialog> | null>(null);
const draft = ref<NpcDraft>(emptyNpcDraft(memory.state.location || ''));

function openComposer() {
  if (!hasLeaf.value) return;
  draft.value = emptyNpcDraft(memory.state.location || '');
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => composerDialog.value?.focusName());
}
function closeComposer() {
  composerOpen.value = false;
}
function addNpc() {
  const d = draft.value;
  if (!d.name.trim()) return;
  const ok = upsertNpc({
    name: d.name,
    gender: d.gender,
    age: d.age,
    relation: d.relation,
    affinityInner: affinityLevelFromInput(d.affinityInner),
    affinityOuter: affinityLevelFromInput(d.affinityOuter),
    affinityNote: d.affinityNote,
    ties: d.ties,
    title: d.title,
    personality: d.personality,
    desc: d.desc,
    outfit: d.outfit,
    condition: d.condition,
    important: d.important,
    follow: d.follow,
    location: d.follow ? '' : d.location,
  });
  if (!ok) return;
  composerOpen.value = false;
}

/* —— 编辑弹窗 —— */
interface NpcEditing extends NpcDraft {
  oldName: string;
}
const editing = ref<NpcEditing | null>(null);

function openEdit(npc: MemNpc) {
  editing.value = {
    oldName: npc.name,
    name: npc.name,
    gender: npc.gender ?? '',
    age: npc.age ?? '',
    relation: npc.relation ?? '',
    affinityInner: npc.affinityInner == null ? '' : String(npc.affinityInner),
    affinityOuter: npc.affinityOuter == null ? '' : String(npc.affinityOuter),
    affinityNote: npc.affinityNote ?? '',
    ties: npc.ties ?? '',
    title: npc.title ?? '',
    personality: npc.personality ?? '',
    desc: npc.desc ?? '',
    outfit: npc.outfit ?? '',
    condition: npc.condition ?? '',
    important: npc.important === true,
    follow: npc.follow === true,
    location: npc.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  editNpc(e.oldName, {
    name: e.name,
    gender: e.gender,
    age: e.age,
    relation: e.relation,
    affinityInner: affinityLevelFromInput(e.affinityInner),
    affinityOuter: affinityLevelFromInput(e.affinityOuter),
    affinityNote: e.affinityNote,
    ties: e.ties,
    title: e.title,
    personality: e.personality,
    desc: e.desc,
    outfit: e.outfit,
    condition: e.condition,
    important: e.important,
    follow: e.follow,
    location: e.follow ? '' : e.location,
  });
  editing.value = null;
}

/* —— 删除确认 —— */
const removing = ref<MemNpc | null>(null);
function confirmRemove() {
  if (removing.value) removeNpc(removing.value.name);
  removing.value = null;
}
</script>

<template>
  <section class="bbs-page bbs-ledger">
    <PageHeader icon="npcs" title="角色" description="主角和出场过的角色：身份、关系、近况、生活档案和信息差。">
      <template #actions>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf"
          :title="hasLeaf ? '手动添加角色' : '需先有摘要才能手动添加'" @click="openComposer"><Icon name="plus" />添加角色</button>
      </template>
    </PageHeader>
    <SummaryOnlyNotice subject="主角档案、NPC 名册与角色状态" />
    <StatRow
      label="人物档案概览"
      :items="[
        { value: memory.npcs.length, label: '位 NPC' },
        { value: mains.length, label: '主要角色' },
        { value: memory.lifeDetails.length, label: '条生活细节' },
        { value: openSecretCount, label: '条信息差' },
      ]"
      :note="hasLeaf ? undefined : '生成摘要后可手动补录'"
    />

    <ProtagonistCard :name="protagonistName" :has-leaf="hasLeaf" />

    <div v-if="memory.npcs.length" class="bbs-roster-tools">
      <div class="bbs-roster-heading"><h2>NPC 名册</h2><span role="status">显示 {{ visibleNpcCount }} / {{ memory.npcs.length }} 位</span></div>
      <div class="bbs-filterbar">
        <label class="bbs-search"><Icon name="search" /><input v-model="npcQuery" class="bbs-input" type="search" aria-label="搜索角色档案" placeholder="搜索姓名、身份、关系或状态" /></label>
        <div class="bbs-filter-tabs" role="group" aria-label="按角色分组筛选">
          <button v-for="filter in npcFilters" :key="filter.key" type="button" class="bbs-filter-tab"
            :aria-pressed="npcFilter === filter.key" @click="npcFilter = filter.key">{{ filter.label }}<span>{{ filter.count }}</span></button>
        </div>
      </div>
    </div>
    <div v-if="visibleNpcCount" class="bbs-npc-groups">
      <!-- 主要角色:核心主演,永远全量发送。这里突出「即时状态面板」(着装/状态/所在),弱化身份档案 -->
      <div v-if="visibleGroups.mains.length" class="bbs-npc-group">
        <NpcSectionHead tag="主要角色" tag-icon="star" tag-tone="main" :local-only="apiSettings.summaryOnlyMode"
          :hint="apiSettings.summaryOnlyMode ? '重点维护当前状态，不发送给主对话 AI' : '始终随剧情发送，重点维护当前状态'" />
        <div class="bbs-npc-list">
          <NpcCard v-for="n in visibleGroups.mains" :key="n.id" :npc="n" tier="main"
            @toggle-important="toggleImportant(n)" @edit="openEdit(n)" @remove="askRemove(n)" />
        </div>
      </div>

      <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
      <div v-if="visibleGroups.present.length" class="bbs-npc-group">
        <NpcSectionHead tag="在场" tag-tone="present" :local-only="apiSettings.summaryOnlyMode"
          :hint="apiSettings.summaryOnlyMode ? '按在场状态完整记录，不发送给主对话 AI' : '完整信息随剧情发送'" />
        <div class="bbs-npc-list">
          <NpcCard v-for="n in visibleGroups.present" :key="n.id" :npc="n" tier="present"
            @toggle-important="toggleImportant(n)" @toggle-follow="toggleFollow(n)" @edit="openEdit(n)" @remove="askRemove(n)" />
        </div>
      </div>

      <!-- 同区域:在附近但未必照面。发名+身份+性格给 AI,这里也只展示这三样 -->
      <div v-if="visibleGroups.nearby.length" class="bbs-npc-group">
        <NpcSectionHead tag="同区域" tag-tone="nearby" :local-only="apiSettings.summaryOnlyMode"
          :hint="apiSettings.summaryOnlyMode ? '按同区域分档记录，不发送给主对话 AI' : '位于附近，发送名字、身份与性格'" />
        <div class="bbs-npc-list">
          <NpcCard v-for="n in visibleGroups.nearby" :key="n.id" :npc="n" tier="nearby"
            @toggle-important="toggleImportant(n)" @toggle-follow="toggleFollow(n)" @edit="openEdit(n)" @remove="askRemove(n)" />
        </div>
      </div>

      <!-- 不在场:只发名+身份给 AI,这里也压暗、收起细节 -->
      <div v-if="visibleGroups.absent.length" class="bbs-npc-group">
        <NpcSectionHead tag="不在场 / 位置未确认" :local-only="apiSettings.summaryOnlyMode"
          :hint="apiSettings.summaryOnlyMode ? '保留名册分档，不发送给主对话 AI' : '仅发送简要名册与已有好感档位'" />
        <div class="bbs-npc-list">
          <NpcCard v-for="n in visibleGroups.absent" :key="n.id" :npc="n" tier="absent"
            @toggle-important="toggleImportant(n)" @toggle-follow="toggleFollow(n)" @edit="openEdit(n)" @remove="askRemove(n)" />
        </div>
      </div>
    </div>

    <EmptyState v-else-if="memory.npcs.length" icon="search" title="没有匹配的角色" text="请调整关键词或分组；主角档案与生活细节不受筛选影响。">
      <button class="bbs-btn" type="button" @click="npcQuery = ''; npcFilter = 'all'">查看全部角色</button>
    </EmptyState>
    <EmptyState v-else icon="npcs" title="暂无角色" :text="'摘要记录与主角有交集的人物。' + (hasLeaf ? '也可手动添加。' : '生成第一条摘要后可手动添加。')">
      <button v-if="hasLeaf" class="bbs-btn" type="button" @click="openComposer"><Icon name="plus" />添加第一位角色</button>
    </EmptyState>

    <!-- 生活小档案与信息差排在名册之后：主角卡与角色卡连成一片，两个列表区块在页尾 -->
    <div class="bbs-npc-after-roster">
      <LifeDetailsSection :protagonist-name="protagonistName" :has-leaf="hasLeaf" />
      <SecretsSection />
    </div>

    <NpcFormDialog ref="composerDialog" mode="add" :open="composerOpen" :draft="draft" :protagonist-name="protagonistName"
      @save="addNpc" @close="closeComposer" />
    <NpcFormDialog mode="edit" :open="!!editing" :draft="editing" :protagonist-name="protagonistName"
      @save="saveEdit" @close="cancelEdit" />

    <ConfirmDialog
      :open="!!removing"
      title="删除角色"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      删除「{{ removing?.name }}」？删除操作记录在最新一条摘要上，删除该楼层可恢复。
    </ConfirmDialog>
  </section>
</template>

<style scoped>

/* 页面外壳（统计行、搜索、筛选、图标按钮、空状态）在 base.css 的 .bbs-ledger 中统一定义。
   角色卡、区块标题行、折叠区块、条目行的样式在各自组件里。 */

.bbs-npc-groups { display: flex; flex-direction: column; gap: 28px; }
.bbs-npc-group { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bbs-roster-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.bbs-roster-heading h2 { font-size: 16px; margin: 0; font-weight: 650; }
.bbs-roster-heading > span { font-size: 11px; color: var(--bbs-ink-muted); }
.bbs-roster-tools .bbs-filter-tabs { flex-basis: 100%; }
.bbs-npc-after-roster { display: flex; flex-direction: column; margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--bbs-line); }
.bbs-npc-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 12px; }
</style>
