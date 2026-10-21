<script setup lang="ts">
/**
 * 角色页：统计行，随后依次为主角、主要角色、NPC（按在场、同区域、不在场分组，带检索与筛选），页尾为生活小档案、信息差。
 * 角色卡见 NpcCard，添加/编辑表单见 NpcFormDialog，从原文补全档案见 NpcEnrichDialog；区块各自的状态与弹窗在对应组件中。
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
import { applyManualEnrichment, npcEnrichState, previewManualEnrichment, type ManualEnrichResult } from '@/memory/npcEnrich';
import { derivedMeta, memory } from '@/memory/store';
import type { MemNpc } from '@/memory/types';
import { getContext } from '@/st/context';
import { computed, nextTick, ref } from 'vue';
import LifeDetailsSection from './LifeDetailsSection.vue';
import NpcCard from './NpcCard.vue';
import NpcEnrichDialog from './NpcEnrichDialog.vue';
import NpcFormDialog from './NpcFormDialog.vue';
import NpcSectionHead from './NpcSectionHead.vue';
import NpcTierHead from './NpcTierHead.vue';
import ProtagonistCard from './ProtagonistCard.vue';
import SecretsSection from './SecretsSection.vue';
import { emptyNpcDraft, type NpcDraft } from './npcView';

// 角色是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);
const protagonistName = computed(() => {
  void derivedMeta.rev;
  return getContext()?.name1?.trim() || '主角';
});
const openSecretCount = computed(() => memory.secrets.filter(s => s.status === 'open').length);
const summaryOnly = computed(() => apiSettings.summaryOnlyMode);

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与场景/摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// 三类人物分开:主角(ProtagonistCard)、主要角色(important)、NPC。NPC 的在场分档与注入端(inject.ts)
// 共用同一权威 classifyNpcPresence —— 读 location + locationPath,确保「界面显示的分组 = AI 收到的分组」。
const sortByCreated = (a: MemNpc, b: MemNpc) => a.createdAt - b.createdAt;

// 单趟分桶:每个 NPC 只判一次在场,避免三个 computed 各判一遍。
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
const npcCount = computed(() => memory.npcs.length - mains.value.length);

// 检索与分组按钮只筛选 NPC 一块;主角与主要角色始终显示。权威在场判定和注入分组不变。
const npcQuery = ref('');
const npcFilter = ref<'all' | 'present' | 'nearby' | 'absent'>('all');
const npcFilters = computed(() => [
  { key: 'all' as const, label: '全部', count: npcCount.value },
  { key: 'present' as const, label: '在场', count: buckets.value.present.length },
  { key: 'nearby' as const, label: '同区域', count: buckets.value.nearby.length },
  { key: 'absent' as const, label: '不在场 / 未确认', count: buckets.value.absent.length },
]);
const visibleGroups = computed(() => {
  const query = npcQuery.value.trim().toLocaleLowerCase();
  const filterGroup = (key: 'present' | 'nearby' | 'absent', list: MemNpc[]) =>
    npcFilter.value !== 'all' && npcFilter.value !== key ? [] : list.filter(n =>
      !query || [n.name, ...(n.formerNames ?? []), n.title, n.relation, n.location, n.lastKnownLocation?.place, n.personality, n.desc, n.outfit, n.condition]
        .some(value => value?.toLocaleLowerCase().includes(query)),
    );
  return { present: filterGroup('present', buckets.value.present), nearby: filterGroup('nearby', buckets.value.nearby), absent: filterGroup('absent', buckets.value.absent) };
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

/* —— 从原文补全档案:检索全部楼层,结果确认后写入最新一条摘要 —— */
const enrichDialog = ref<{ name: string; result: ManualEnrichResult | null } | null>(null);
async function startEnrich(npc: MemNpc) {
  if (npcEnrichState.running || !hasLeaf.value) return;
  enrichDialog.value = { name: npc.name, result: null };
  const result = await previewManualEnrichment(npc.name);
  // 检索过原文但没有可补内容:记下,之后不再为这个角色自动请求(档案本身不改)
  if (result.status === 'empty' && result.excerpts > 0) applyManualEnrichment(result.name, {});
  if (enrichDialog.value?.name === npc.name) enrichDialog.value = { name: npc.name, result };
}
function applyEnrich() {
  const d = enrichDialog.value;
  if (d?.result?.status === 'ok') applyManualEnrichment(d.result.name, d.result.fields);
  enrichDialog.value = null;
}
function closeEnrich() {
  enrichDialog.value = null;
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
    <PageHeader icon="npcs" title="角色" description="主角、主要角色和 NPC 的身份、外貌与近况，以及生活档案和信息差。">
      <template #actions>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf"
          :title="hasLeaf ? '手动添加角色' : '需先有摘要才能手动添加'" @click="openComposer"><Icon name="plus" />添加角色</button>
      </template>
    </PageHeader>
    <SummaryOnlyNotice subject="主角档案、角色名册与角色状态" />
    <StatRow
      label="人物档案概览"
      :items="[
        { value: mains.length, label: '位主要角色' },
        { value: npcCount, label: '位 NPC' },
        { value: memory.lifeDetails.length, label: '条生活细节' },
        { value: openSecretCount, label: '条信息差' },
      ]"
      :note="hasLeaf ? undefined : '生成摘要后可手动补录'"
    />

    <!-- 一、主角:只记录用户操控的角色本人 -->
    <ProtagonistCard :name="protagonistName" :has-leaf="hasLeaf" />

    <!-- 二、主要角色:不论在场与否都单列,档案与当前状态随正文发送 -->
    <section class="bbs-npc-tier" aria-labelledby="bbs-tier-main">
      <NpcTierHead title="主要角色" heading-id="bbs-tier-main" :meta="mains.length ? `${mains.length} 位` : undefined" :local-only="summaryOnly"
        :hint="summaryOnly ? '除主角外的主要登场角色；仅在棱镜宝书中记录，不发送给主对话 AI。' : '除主角外的主要登场角色，档案与当前状态始终随正文发送。'" />
      <div v-if="mains.length" class="bbs-npc-list">
        <NpcCard v-for="n in mains" :key="n.id" :npc="n" tier="main" :can-enrich="hasLeaf"
          :enriching="npcEnrichState.running === n.name" :enrich-busy="!!npcEnrichState.running"
          @toggle-important="toggleImportant(n)" @edit="openEdit(n)" @remove="askRemove(n)" @enrich="startEnrich(n)" />
      </div>
      <EmptyState v-else compact icon="star" title="暂无主要角色" text="同伴、反复出场或推动主线的人物会被标为主要角色，也可在 NPC 卡片上点星标设定。" />
    </section>

    <!-- 三、NPC:其余登场的人,按在场、同区域、不在场分组 -->
    <section class="bbs-npc-tier" aria-labelledby="bbs-tier-npc">
      <NpcTierHead title="NPC" heading-id="bbs-tier-npc" :meta="npcCount ? `显示 ${visibleNpcCount} / ${npcCount} 位` : undefined"
        hint="其余登场的人；没有名字的以职业加字母记录，如「酒保A」。" />
      <div v-if="npcCount" class="bbs-filterbar">
        <label class="bbs-search"><Icon name="search" /><input v-model="npcQuery" class="bbs-input" type="search" aria-label="搜索 NPC" placeholder="搜索姓名、身份、外貌或状态" /></label>
        <div class="bbs-filter-tabs" role="group" aria-label="按在场分组筛选 NPC">
          <button v-for="filter in npcFilters" :key="filter.key" type="button" class="bbs-filter-tab"
            :aria-pressed="npcFilter === filter.key" @click="npcFilter = filter.key">{{ filter.label }}<span>{{ filter.count }}</span></button>
        </div>
      </div>
      <div v-if="visibleNpcCount" class="bbs-npc-groups">
        <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
        <div v-if="visibleGroups.present.length" class="bbs-npc-group">
          <NpcSectionHead tag="在场" tag-tone="present" :local-only="summaryOnly"
            :hint="summaryOnly ? '按在场状态完整记录，不发送给主对话 AI' : '完整信息随剧情发送'" />
          <div class="bbs-npc-list">
            <NpcCard v-for="n in visibleGroups.present" :key="n.id" :npc="n" tier="present" :can-enrich="hasLeaf"
              :enriching="npcEnrichState.running === n.name" :enrich-busy="!!npcEnrichState.running"
              @toggle-important="toggleImportant(n)" @toggle-follow="toggleFollow(n)" @edit="openEdit(n)" @remove="askRemove(n)" @enrich="startEnrich(n)" />
          </div>
        </div>

        <!-- 同区域:在附近但未必照面。发名字、身份、性格给 AI -->
        <div v-if="visibleGroups.nearby.length" class="bbs-npc-group">
          <NpcSectionHead tag="同区域" tag-tone="nearby" :local-only="summaryOnly"
            :hint="summaryOnly ? '按同区域分档记录，不发送给主对话 AI' : '位于附近，发送名字、身份与性格'" />
          <div class="bbs-npc-list">
            <NpcCard v-for="n in visibleGroups.nearby" :key="n.id" :npc="n" tier="nearby" :can-enrich="hasLeaf"
              :enriching="npcEnrichState.running === n.name" :enrich-busy="!!npcEnrichState.running"
              @toggle-important="toggleImportant(n)" @toggle-follow="toggleFollow(n)" @edit="openEdit(n)" @remove="askRemove(n)" @enrich="startEnrich(n)" />
          </div>
        </div>

        <!-- 不在场:有名字的只发一行简要信息,无名角色不发;这里压暗显示 -->
        <div v-if="visibleGroups.absent.length" class="bbs-npc-group">
          <NpcSectionHead tag="不在场 / 位置未确认" :local-only="summaryOnly"
            :hint="summaryOnly ? '保留名册分档，不发送给主对话 AI' : '有名字的发送一行简要信息，未具名的不发送'" />
          <div class="bbs-npc-list">
            <NpcCard v-for="n in visibleGroups.absent" :key="n.id" :npc="n" tier="absent" :can-enrich="hasLeaf"
              :enriching="npcEnrichState.running === n.name" :enrich-busy="!!npcEnrichState.running"
              @toggle-important="toggleImportant(n)" @toggle-follow="toggleFollow(n)" @edit="openEdit(n)" @remove="askRemove(n)" @enrich="startEnrich(n)" />
          </div>
        </div>
      </div>
      <EmptyState v-else-if="npcCount" icon="search" title="没有匹配的 NPC" text="请调整关键词或分组；主角与主要角色不受筛选影响。">
        <button class="bbs-btn" type="button" @click="npcQuery = ''; npcFilter = 'all'">查看全部 NPC</button>
      </EmptyState>
      <EmptyState v-else compact icon="npcs" title="暂无 NPC" :text="'登场并说话、行动或被具体描写的人会在摘要时记入这里。' + (hasLeaf ? '也可手动添加。' : '生成第一条摘要后可手动添加。')">
        <button v-if="hasLeaf" class="bbs-btn bbs-btn-sm" type="button" @click="openComposer"><Icon name="plus" />添加角色</button>
      </EmptyState>
    </section>

    <!-- 生活小档案与信息差排在名册之后 -->
    <div class="bbs-npc-after-roster">
      <LifeDetailsSection :protagonist-name="protagonistName" :has-leaf="hasLeaf" />
      <SecretsSection />
    </div>

    <NpcFormDialog ref="composerDialog" mode="add" :open="composerOpen" :draft="draft" :protagonist-name="protagonistName"
      @save="addNpc" @close="closeComposer" />
    <NpcFormDialog mode="edit" :open="!!editing" :draft="editing" :protagonist-name="protagonistName"
      @save="saveEdit" @close="cancelEdit" />
    <NpcEnrichDialog :open="!!enrichDialog" :name="enrichDialog?.name ?? ''" :result="enrichDialog?.result ?? null"
      @apply="applyEnrich" @close="closeEnrich" />

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

/* 主角、主要角色、NPC 三块各自成段,块间距大于块内分组间距。 */
.bbs-npc-tier { display: flex; flex-direction: column; gap: 14px; min-width: 0; margin-bottom: 30px; }
.bbs-npc-tier .bbs-filterbar { margin: 0; }
.bbs-npc-tier .bbs-filter-tabs { flex-basis: 100%; }
.bbs-npc-groups { display: flex; flex-direction: column; gap: 28px; }
.bbs-npc-group { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bbs-npc-after-roster { display: flex; flex-direction: column; margin-top: 6px; padding-top: 20px; border-top: 1px solid var(--bbs-line); }
.bbs-npc-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 12px; }
</style>
