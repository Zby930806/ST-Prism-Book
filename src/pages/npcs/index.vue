<script setup lang="ts">
import { apiSettings } from '@/api/settings';
import Icon from '@/components/Icon.vue';
import PageHeader from '@/components/PageHeader.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import { fmtLifeDetail, lifeDetailSubject } from '@/memory/lifeDetails';
import { NPC_AFFINITY_FIELDS, affinityLevelFromInput, fmtNpcAffinity } from '@/memory/npcRelations';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { classifyNpcPresence, editNpc, removeNpc, setNpcFollow, setNpcImportant, setProtagonist, upsertNpc, addLifeDetail, removeLifeDetail, updateLifeDetail } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import { ageDisplay } from '@/memory/timeRel';
import type { MemLifeDetail, MemNpc } from '@/memory/types';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, nextTick, ref } from 'vue';

// NPC 是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);
const protagonistName = computed(() => {
  void derivedMeta.rev;
  return getContext()?.name1?.trim() || '主角';
});
const protagonistHasData = computed(() => Object.values(memory.protagonist).some(value => !!value?.trim()));
const protagonistHasDetails = computed(() => [
  memory.protagonist.age,
  memory.protagonist.identity,
  memory.protagonist.appearance,
  memory.protagonist.outfit,
  memory.protagonist.condition,
].some(value => !!value?.trim()));

/** 名册里的位置。发给模型的写法见 npcLocationLabel，这里换成好读的说法，规则相同：旧位置不当成现在的位置。 */
function npcPlaceText(n: MemNpc): string {
  if (n.follow) return '跟主角在一起';
  if (n.location && !n.locationStale) return n.location;
  const last = n.lastKnownLocation;
  const place = last?.place || n.location;
  return place ? `现在不确定；最后一次在${place}${last?.time ? `（${last.time}）` : ''}` : '现在不确定';
}
// 年龄显示:按锚点+当前故事时间推算(与注入端同一函数,界面显示 = AI 收到的)
function shownAge(age?: string, ageTime?: string): string {
  return ageDisplay(age, ageTime, memory.state.time);
}
// 年龄悬浮提示:显示原始锚点,帮用户理解「约26岁」是怎么来的
function ageTitle(age?: string, ageTime?: string): string {
  if (!age?.trim()) return '';
  return ageTime?.trim() ? `记录于 ${ageTime.trim()}:${age.trim()}(随剧情时间自动推算)` : `年龄:${age.trim()}`;
}
const protagonistAge = computed(() => shownAge(memory.protagonist.age, memory.protagonist.ageTime));

interface ProtagonistDraft {
  gender: string;
  age: string;
  identity: string;
  appearance: string;
  outfit: string;
  condition: string;
}
const protagonistEditing = ref<ProtagonistDraft | null>(null);

function openProtagonistEdit() {
  if (!hasLeaf.value) return;
  protagonistEditing.value = {
    gender: memory.protagonist.gender ?? '',
    age: memory.protagonist.age ?? '',
    identity: memory.protagonist.identity ?? '',
    appearance: memory.protagonist.appearance ?? '',
    outfit: memory.protagonist.outfit ?? '',
    condition: memory.protagonist.condition ?? '',
  };
}
function cancelProtagonistEdit() {
  protagonistEditing.value = null;
}
function saveProtagonistEdit() {
  const draft = protagonistEditing.value;
  if (!draft) return;
  // 年龄没改时带上旧锚点,防止重放把锚点刷成「此刻」(等于错误冻龄);真改了才留给重放盖新锚点
  const ageTime = draft.age.trim() && draft.age.trim() === memory.protagonist.age ? memory.protagonist.ageTime : undefined;
  if (setProtagonist({ ...draft, ageTime })) protagonistEditing.value = null;
}

/* —— 生活小档案(三投放层:置顶常驻 / 时效相关浮现 / 沉降仅触发)—— */
const lifeGroups = computed(() => {
  const pinned: MemLifeDetail[] = [];
  const active: MemLifeDetail[] = [];
  const archive: MemLifeDetail[] = [];
  for (const d of memory.lifeDetails) {
    (d.tier === 'pinned' ? pinned : d.tier === 'archive' ? archive : active).push(d);
  }
  return { pinned, active, archive };
});
/* 列表顺序 = 置顶 → 时效/长期 → 沉降;层级差异交给卡片样式表达(置顶金条/沉降虚线),不再挂分组标题 */
const lifeList = computed(() => [...lifeGroups.value.pinned, ...lifeGroups.value.active, ...lifeGroups.value.archive]);

/* —— 生活小档案折叠:与摘要页计划/悬念同款。折叠态是本机视图偏好,走 localStorage、不进 apiSettings —— */
const LIFE_COLLAPSE_KEY = 'bbs.ui.lifeCollapsed.v1';
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const lifeCollapsed = ref(loadCollapsed(LIFE_COLLAPSE_KEY));
// 无条目即无可折叠:不显示箭头,也强制展开(避免删空后卡在收拢的空态)
const lifeFoldable = computed(() => memory.lifeDetails.length > 0);
const lifeShown = computed(() => !lifeCollapsed.value || !lifeFoldable.value);
function toggleLifeFold() {
  lifeCollapsed.value = !lifeCollapsed.value;
  persistCollapsed(LIFE_COLLAPSE_KEY, lifeCollapsed.value);
}

const LIFE_PIN_CAP = 5;
function toggleDetailPin(d: MemLifeDetail) {
  if (d.tier === 'pinned') {
    updateLifeDetail(d.id, { tier: 'active' });
    return;
  }
  if (lifeGroups.value.pinned.length >= LIFE_PIN_CAP) {
    toast(`置顶最多 ${LIFE_PIN_CAP} 条，先取消一条再置顶。`, 'warning');
    return;
  }
  updateLifeDetail(d.id, { tier: 'pinned' });
}
function toggleDetailArchive(d: MemLifeDetail) {
  updateLifeDetail(d.id, { tier: d.tier === 'archive' ? 'active' : 'archive' });
}
function removeDetail(d: MemLifeDetail) {
  removeLifeDetail(d.id);
}

/* 生活细节 添加/编辑弹窗 */
const detailEditing = ref<{ id: string | null; subject: string; text: string; topics: string; anchors: string; until: string } | null>(null);
const detailSubjectOptions = computed(() => [
  { value: 'user', label: `主角 · ${protagonistName.value}` },
  // 保留已删除/改名角色的历史归属选项,打开编辑不能悄悄改成 user。
  ...[...new Set([...memory.npcs.map(n => n.name), ...memory.lifeDetails.map(lifeDetailSubject)])]
    .filter(name => name !== 'user').map(name => ({ value: name, label: name })),
]);
function openDetailComposer() {
  detailEditing.value = { id: null, subject: 'user', text: '', topics: '', anchors: '', until: '' };
}
function openDetailEdit(d: MemLifeDetail) {
  detailEditing.value = { id: d.id, subject: lifeDetailSubject(d), text: d.text, topics: d.topics.join('/'), anchors: d.anchors.join('/'), until: d.until ?? '' };
}
function cancelDetailEdit() {
  detailEditing.value = null;
}
function saveDetailEdit() {
  const e = detailEditing.value;
  if (!e || !e.text.trim()) return;
  const topics = e.topics.split(/[\/、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
  const anchors = e.anchors.split(/[\/、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  const until = e.until.trim();
  const ok = e.id
    ? updateLifeDetail(e.id, { subject: e.subject, text: e.text.trim(), topics, anchors, until })
    : addLifeDetail({ subject: e.subject, text: e.text.trim(), topics, anchors, until: until || undefined });
  if (ok) detailEditing.value = null;
}

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
const nameInput = ref<HTMLInputElement | null>(null);
interface NpcDraft {
  name: string;
  gender: string;
  age: string;
  relation: string;
  affinityInner: string;
  affinityOuter: string;
  affinityNote: string;
  ties: string;
  title: string;
  personality: string;
  desc: string;
  outfit: string;
  condition: string;
  important: boolean;
  follow: boolean;
  location: string;
}
function emptyDraft(): NpcDraft {
  return { name: '', gender: '', age: '', relation: '', affinityInner: '', affinityOuter: '', affinityNote: '', ties: '', title: '', personality: '', desc: '', outfit: '', condition: '', important: false, follow: false, location: memory.state.location || '' };
}
const draft = ref<NpcDraft>(emptyDraft());

function openComposer() {
  if (!hasLeaf.value) return;
  draft.value = emptyDraft();
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
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
  <section class="bbs-page">
    <PageHeader icon="npcs" title="角色" description="主角和出场过的角色：身份、关系、近况和生活档案。">
      <template #actions>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf"
          :title="hasLeaf ? '手动添加角色' : '需先有摘要才能手动添加'" @click="openComposer"><Icon name="plus" />添加角色</button>
      </template>
    </PageHeader>
    <SummaryOnlyNotice subject="主角档案、NPC 名册与角色状态" />
    <div class="bbs-ledger-meta" aria-label="人物档案概览">
      <span><strong>{{ memory.npcs.length }}</strong>位 NPC</span>
      <span><strong>{{ mains.length }}</strong>主要角色</span>
      <span><strong>{{ memory.lifeDetails.length }}</strong>条生活细节</span>
      <span v-if="!hasLeaf" class="bbs-ledger-note">有了摘要才能手动补录</span>
    </div>

    <!-- ===== 生活小档案:主角与主要角色的偏好/习惯/近期状态(三投放层)。置于主角卡之上且可折叠,不打断下方角色卡流 ===== -->
    <div class="bbs-protagonist-section bbs-life-section">
      <div class="bbs-npc-grouphead">
        <button
          class="bbs-fold-head"
          type="button"
          :class="{ 'is-static': !lifeFoldable }"
          :disabled="!lifeFoldable"
          :aria-expanded="lifeShown"
          :title="lifeFoldable ? (lifeShown ? '收起生活小档案' : '展开生活小档案') : ''"
          @click="toggleLifeFold"
        >
          <Icon v-if="lifeFoldable" name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': !lifeShown }" />
          <h2 class="bbs-life-title" title="置顶条常驻发送；时效/长期条按相关性浮现；沉降条仅关键词触发">生活小档案</h2>
          <span v-if="lifeFoldable" class="bbs-fold-count">{{ memory.lifeDetails.length }}</span>
        </button>
        <span v-if="apiSettings.summaryOnlyMode" class="bbs-npc-grouphint is-local-only">仅供棱镜宝书记录，不发送给主对话 AI</span>
        <button
          class="bbs-add-mini"
          type="button"
          :disabled="!hasLeaf"
          aria-label="添加生活细节"
          :title="hasLeaf ? '手动添加生活细节' : '需先有摘要才能手动添加'"
          @click="openDetailComposer"
        >
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height;reduced-motion 下瞬切(见样式) -->
      <div class="bbs-fold-wrap" :class="{ 'is-collapsed': !lifeShown }" :inert="!lifeShown">
        <div class="bbs-fold-inner">
          <div v-if="lifeList.length" class="bbs-life-group">
            <article v-for="d in lifeList" :key="d.id" class="bbs-life" :class="`is-${d.tier}`">
              <div class="bbs-life-main">
                <p class="bbs-life-text">{{ fmtLifeDetail(d, protagonistName) }}</p>
                <div v-if="d.topics.length || d.until" class="bbs-life-meta">
                  <span v-if="d.topics.length" class="bbs-life-tag">{{ d.topics.join(' / ') }}</span>
                  <span v-if="d.until" class="bbs-life-until">至 {{ d.until }}</span>
                </div>
              </div>
              <span class="bbs-npc-acts">
                <button
                  class="bbs-item-act"
                  :class="{ active: d.tier === 'pinned' }"
                  type="button"
                  :title="d.tier === 'pinned' ? '取消置顶' : '置顶（常驻发送，最多5条）'"
                  @click="toggleDetailPin(d)"
                >
                  <Icon name="pin" />
                </button>
                <button
                  class="bbs-item-act"
                  type="button"
                  :title="d.tier === 'archive' ? '恢复为时效层' : '沉降（仅相关时浮现）'"
                  @click="toggleDetailArchive(d)"
                >
                  <Icon :name="d.tier === 'archive' ? 'upload' : 'download'" />
                </button>
                <button class="bbs-item-act" type="button" title="编辑" @click="openDetailEdit(d)"><Icon name="edit" /></button>
                <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="removeDetail(d)"><Icon name="trash" /></button>
              </span>
            </article>
          </div>
          <p v-if="!memory.lifeDetails.length" class="bbs-npc-mainhint">还没有生活细节。摘要会记下主角和主要角色明确说过、或正文写到的偏好、习惯和近况，每条注明是谁的；也可以手动添加或改归属。</p>
        </div>
      </div>
    </div>

    <div class="bbs-protagonist-section">
      <div class="bbs-npc-grouphead">
        <span class="bbs-npc-grouptag is-protagonist"><Icon name="characters" />主角</span>
        <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
          {{ apiSettings.summaryOnlyMode ? '仅供棱镜宝书记录，不发送给主对话 AI' : '始终完整发送，与 NPC 名册分开记录' }}
        </span>
      </div>
      <article class="bbs-npc bbs-protagonist">
        <div class="bbs-npc-body">
          <div class="bbs-npc-head">
            <span class="bbs-npc-name" :title="protagonistName">{{ protagonistName }}</span>
            <span v-if="memory.protagonist.gender" class="bbs-npc-gender">{{ memory.protagonist.gender }}</span>
            <span v-if="protagonistAge" class="bbs-npc-gender" :title="ageTitle(memory.protagonist.age, memory.protagonist.ageTime)">{{ protagonistAge }}</span>
            <span class="bbs-npc-acts">
              <button
                class="bbs-item-act"
                type="button"
                :disabled="!hasLeaf"
                :title="hasLeaf ? '编辑主角当前档案' : '需先有摘要才能编辑'"
                @click="openProtagonistEdit"
              >
                <Icon name="edit" />
              </button>
            </span>
          </div>
          <dl v-if="protagonistHasDetails" class="bbs-npc-fields">
            <div v-if="memory.protagonist.identity" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ memory.protagonist.identity }}</dd></div>
            <div v-if="memory.protagonist.appearance" class="bbs-npc-field f-desc"><dt>外貌</dt><dd>{{ memory.protagonist.appearance }}</dd></div>
            <div v-if="memory.protagonist.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ memory.protagonist.outfit }}</dd></div>
            <div v-if="memory.protagonist.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ memory.protagonist.condition }}</dd></div>
          </dl>
          <p v-else-if="!protagonistHasData" class="bbs-npc-mainhint">还没有主角的状态记录，之后的摘要会根据剧情补上。</p>
        </div>
      </article>
    </div>

    <div v-if="memory.npcs.length" class="bbs-roster-tools">
      <div class="bbs-roster-heading"><h2>NPC 名册</h2><span role="status">显示 {{ visibleNpcCount }} / {{ memory.npcs.length }} 位</span></div>
      <div class="bbs-filterbar">
        <label class="bbs-search"><Icon name="search" /><input v-model="npcQuery" class="bbs-input" type="search" aria-label="搜索角色档案" placeholder="搜索姓名、身份、关系或状态" /></label>
        <div class="bbs-filter-tabs" aria-label="按角色分组筛选">
          <button v-for="filter in npcFilters" :key="filter.key" type="button" class="bbs-filter-tab"
            :aria-pressed="npcFilter === filter.key" @click="npcFilter = filter.key">{{ filter.label }}<span>{{ filter.count }}</span></button>
        </div>
      </div>
    </div>
    <div v-if="visibleNpcCount" class="bbs-npc-groups">
      <!-- 主要角色:核心主演,永远全量发送。这里突出「即时状态面板」(着装/状态/所在),弱化身份档案 -->
      <div v-if="visibleGroups.mains.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-main"><Icon name="star" />主要角色</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍会重点维护状态，但不发送给主对话 AI' : '始终随剧情发送，重点维护当前状态' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in visibleGroups.mains" :key="n.id" class="bbs-npc is-present is-main">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button class="bbs-item-act bbs-npc-star active" type="button" title="主要角色 · 点击取消" @click="toggleImportant(n)"><Icon name="star" /></button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.relation || fmtNpcAffinity(n) || n.outfit || n.condition || n.follow || n.location || n.lastKnownLocation" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>关系</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="对主角的内心好感与外在态度估计">好感</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div v-if="n.follow || n.location" class="bbs-npc-field f-loc">
                  <dt>位置</dt>
                  <dd :class="{ 'is-follow': n.follow }">{{ npcPlaceText(n) }}</dd>
                </div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ n.condition }}</dd></div>
              </dl>
              <p v-else class="bbs-npc-mainhint">还没有状态记录，可以点编辑补上着装、状态和位置。</p>
            </div>
          </article>
        </div>
      </div>

      <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
      <div v-if="visibleGroups.present.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-present">在场</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍按在场状态完整记录，但不发送给主对话 AI' : '完整信息随剧情发送' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in visibleGroups.present" :key="n.id" class="bbs-npc is-present" :class="{ 'is-follow': n.follow }">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色（仅调整棱镜宝书内的角色分组）' : '标记为主要角色（始终全量发送、追踪状态）'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    :class="{ active: n.follow }"
                    type="button"
                    :title="n.follow ? '随行中 · 点击取消（留在当前地点）' : '标记为随行同伴'"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.relation || fmtNpcAffinity(n) || n.ties || n.personality || n.desc || n.outfit || n.condition || n.follow || n.location || n.lastKnownLocation" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>关系</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="对主角的内心好感与外在态度估计">好感</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div v-if="n.follow || n.location" class="bbs-npc-field f-loc">
                  <dt>位置</dt>
                  <dd :class="{ 'is-follow': n.follow }">{{ npcPlaceText(n) }}</dd>
                </div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>性格</dt><dd>{{ n.personality }}</dd></div>
                <div v-if="n.desc" class="bbs-npc-field f-desc"><dt>外貌</dt><dd>{{ n.desc }}</dd></div>
                <div v-if="n.ties" class="bbs-npc-field f-ties"><dt>人际</dt><dd>{{ n.ties }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- 同区域:在附近但未必照面。发名+身份+性格给 AI,这里也只展示这三样 -->
      <div v-if="visibleGroups.nearby.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-nearby">同区域</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍按同区域分档记录，但不发送给主对话 AI' : '在附近，发送名字、身份与性格' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in visibleGroups.nearby" :key="n.id" class="bbs-npc is-nearby">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色（仅调整棱镜宝书内的角色分组）' : '标记为主要角色（始终全量发送、追踪状态）'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴（将随主角在场）"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.relation || fmtNpcAffinity(n) || n.personality || n.location || n.lastKnownLocation" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>关系</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="对主角的内心好感与外在态度估计">好感</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div v-if="n.location || n.lastKnownLocation" class="bbs-npc-field f-loc"><dt>位置</dt><dd>{{ npcPlaceText(n) }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>性格</dt><dd>{{ n.personality }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- 不在场:只发名+身份给 AI,这里也压暗、收起细节 -->
      <div v-if="visibleGroups.absent.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag">不在场 / 位置未确认</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍保留名册分档，但不发送给主对话 AI' : '仅发送简要名册与已有好感档位，省 token' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in visibleGroups.absent" :key="n.id" class="bbs-npc is-absent">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色（仅调整棱镜宝书内的角色分组）' : '标记为主要角色（始终全量发送、追踪状态）'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴（将随主角在场）"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>关系</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="对主角的内心好感与外在态度估计">好感</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div class="bbs-npc-field f-loc">
                  <dt>位置</dt>
                  <dd :class="{ 'is-nowhere': !n.location || n.locationStale }">{{ npcPlaceText(n) }}</dd>
                </div>
              </dl>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else-if="memory.npcs.length" class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="search" /></span>
      <h3>没有匹配的角色</h3><p>调整关键词或分组；主角档案与生活细节不受筛选影响。</p>
      <button class="bbs-btn" type="button" @click="npcQuery = ''; npcFilter = 'all'">查看全部角色</button>
    </div>
    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="npcs" /></span>
      <h3>还没有角色</h3><p>摘要会记下和主角有交集的人。{{ hasLeaf ? '也可以手动添加。' : '有了第一条摘要后就能手动添加。' }}</p>
      <button v-if="hasLeaf" class="bbs-btn" type="button" @click="openComposer"><Icon name="plus" />添加第一位角色</button>
    </div>

    <ModalMask :open="!!protagonistEditing" @close="cancelProtagonistEdit">
      <div v-if="protagonistEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑主角档案">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑主角档案</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelProtagonistEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="protagonistEditing.gender" class="bbs-input" type="text" placeholder="如：男、女" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">年龄（记录当时的值，随剧情时间自动推算）</span>
          <input v-model="protagonistEditing.age" class="bbs-input" type="text" placeholder="如：25、二十出头" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前身份 / 职业 / 种族 / 公开地位</span>
          <textarea v-model="protagonistEditing.identity" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">稳定外貌 / 身体特征</span>
          <textarea v-model="protagonistEditing.appearance" class="bbs-input bbs-modal-textarea" rows="2" placeholder="如：黑色短发、左眉有疤"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装</span>
          <textarea v-model="protagonistEditing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前身体状态 / 健康</span>
          <textarea v-model="protagonistEditing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="无异常时留空"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelProtagonistEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveProtagonistEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 生活细节 添加/编辑弹窗 -->
    <ModalMask :open="!!detailEditing" @close="cancelDetailEdit">
      <div v-if="detailEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="生活细节">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">{{ detailEditing.id ? '编辑生活细节' : '添加生活细节' }}</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelDetailEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">所属人物</span>
          <BbsSelect v-model="detailEditing.subject" :options="detailSubjectOptions" aria-label="生活细节所属人物" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">细节内容（此人明说过/正文揭示的偏好、习惯或近期状态）</span>
          <textarea v-model="detailEditing.text" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：认为煎饼果子不加脆饼就没有灵魂（姓名由所属人物自动显示）"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">主题标签（可选，1-3 个，斜杠分隔）</span>
          <input v-model="detailEditing.topics" class="bbs-input" type="text" placeholder="如 饮食/作息/工作" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">关键词（可选，触发匹配用，斜杠分隔）</span>
          <input v-model="detailEditing.anchors" class="bbs-input" type="text" placeholder="如 香菜/项目/死线" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">时效（可选，故事内到期时间；长期偏好留空）</span>
          <input v-model="detailEditing.until" class="bbs-input" type="text" placeholder="如 1988/10/1；留空=长期稳定" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelDetailEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!detailEditing.text.trim()" @click="saveDetailEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 添加弹窗:position:fixed 内联(不用 Teleport,见 base.css 说明) -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="添加角色">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">添加角色</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input ref="nameInput" v-model="draft.name" class="bbs-input" type="text" placeholder="角色名" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="draft.gender" class="bbs-input" type="text" placeholder="如：男、女" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">年龄（记录当时的值，随剧情时间自动推算）</span>
          <input v-model="draft.age" class="bbs-input" type="text" placeholder="如：25、二十出头" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份（职业 / 与主角的关系）</span>
          <textarea v-model="draft.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：归雁客栈掌柜、青梅竹马"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与主角的关系（称谓在前 + 一句态度）</span>
          <textarea v-model="draft.relation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：主角的师姐，明面冷淡暗中维护"></textarea>
        </label>
        <div v-for="f in NPC_AFFINITY_FIELDS" :key="f.key" class="bbs-modal-field">
          <span class="bbs-modal-label">{{ f.label }}（对 {{ protagonistName }}）</span>
          <BbsSelect v-model="draft[f.key]" :options="f.options" :aria-label="f.label" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">好感说明（定性估计，不是本轮心情；未知不等于中性）</span>
          <textarea v-model="draft.affinityNote" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：内心在意，但习惯以冷淡掩饰；没有新依据时保持不变"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与其他角色的关系（仅血缘 / 婚姻 / 宿敌等长期关系）</span>
          <textarea v-model="draft.ties" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：阿黛尔之父；与镇长有旧怨"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <textarea v-model="draft.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：沉默寡言、护短"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述（固定特征：发色 / 身材 / 疤痕，勿写穿着）</span>
          <textarea v-model="draft.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装（会随剧情变化）</span>
          <textarea v-model="draft.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：红斗篷、佩长剑"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前状态（受伤 / 疲惫等，无则留空）</span>
          <textarea v-model="draft.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? '主要角色（核心主演，仅在棱镜宝书内重点追踪状态）' : '主要角色（核心主演，始终全量发送、重点追踪状态）' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴（跟随主角移动，永远在场）</span>
        </label>
        <label v-if="!draft.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点（留空=所在不明，不再视为在场）</span>
          <textarea v-model="draft.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：归雁客栈、王宫；留空=所在不明"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!draft.name.trim()" @click="addNpc">添加</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 编辑弹窗 -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑角色</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="角色名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="editing.gender" class="bbs-input" type="text" placeholder="如：男、女" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">年龄（记录当时的值，随剧情时间自动推算；不改则保留原锚点）</span>
          <input v-model="editing.age" class="bbs-input" type="text" placeholder="如：25、二十出头" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份（职业 / 与主角的关系）</span>
          <textarea v-model="editing.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：归雁客栈掌柜、青梅竹马"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与主角的关系（称谓在前 + 一句态度）</span>
          <textarea v-model="editing.relation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：主角的师姐，明面冷淡暗中维护"></textarea>
        </label>
        <div v-for="f in NPC_AFFINITY_FIELDS" :key="f.key" class="bbs-modal-field">
          <span class="bbs-modal-label">{{ f.label }}（对 {{ protagonistName }}）</span>
          <BbsSelect v-model="editing[f.key]" :options="f.options" :aria-label="f.label" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">好感说明（定性估计，不是本轮心情；未知不等于中性）</span>
          <textarea v-model="editing.affinityNote" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：内心在意，但习惯以冷淡掩饰；没有新依据时保持不变"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与其他角色的关系（仅血缘 / 婚姻 / 宿敌等长期关系）</span>
          <textarea v-model="editing.ties" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：阿黛尔之父；与镇长有旧怨"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <textarea v-model="editing.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：沉默寡言、护短"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述（固定特征：发色 / 身材 / 疤痕，勿写穿着）</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装（会随剧情变化）</span>
          <textarea v-model="editing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：红斗篷、佩长剑"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前状态（受伤 / 疲惫等，无则留空）</span>
          <textarea v-model="editing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? '主要角色（核心主演，仅在棱镜宝书内重点追踪状态）' : '主要角色（核心主演，始终全量发送、重点追踪状态）' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴（跟随主角移动，永远在场）</span>
        </label>
        <label v-if="!editing.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点（留空=所在不明，不再视为在场）</span>
          <textarea v-model="editing.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：归雁客栈、王宫；留空=所在不明"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

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
      删除「{{ removing?.name }}」？删除会记在最新一条摘要上，删掉那一楼就能恢复。
    </ConfirmDialog>
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
.bbs-filter-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 11px; border: 1px solid var(--bbs-line); border-radius: 9px; background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-size: 12px; cursor: pointer; }
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

.bbs-protagonist-section { display: flex; flex-direction: column; gap: 12px; margin-bottom: 26px; min-width: 0; }
.bbs-life-section { padding-bottom: 20px; border-bottom: 1px solid var(--bbs-line); }
.bbs-npc-groups { display: flex; flex-direction: column; gap: 28px; }
.bbs-npc-group { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bbs-npc-grouphead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.bbs-npc-grouptag { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 7px; background: var(--bbs-surface-2); font-size: 12px; font-weight: 650; color: var(--bbs-ink-soft); }
.bbs-npc-grouptag.is-present, .bbs-npc-grouptag.is-main { background: var(--bbs-accent-soft); color: var(--bbs-accent); }
.bbs-npc-grouptag.is-protagonist { background: var(--bbs-warning-soft); color: var(--bbs-warning); }
.bbs-npc-grouptag.is-nearby { background: transparent; border: 1px solid var(--bbs-line-strong); }
.bbs-npc-grouphint { flex: 1 1 150px; color: var(--bbs-ink-muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.bbs-npc-grouphint.is-local-only { color: var(--bbs-warning); }
.bbs-npc-grouphead .bbs-add-mini { flex-shrink: 0; margin-left: auto; min-width: 36px; min-height: 36px; }
.bbs-roster-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.bbs-roster-heading h2 { font-size: 16px; margin: 0; font-weight: 650; }
.bbs-roster-heading > span { font-size: 11px; color: var(--bbs-ink-muted); }
.bbs-roster-tools .bbs-filter-tabs { flex-basis: 100%; }
.bbs-npc-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 12px; }
.bbs-npc { position: relative; min-width: 0; padding: 17px 18px; border: 1px solid var(--bbs-line); border-radius: 15px; background: var(--bbs-surface); box-shadow: var(--bbs-card-shadow); }
.bbs-npc.is-present, .bbs-npc.is-nearby { border-left: 3px solid var(--bbs-line-strong); }
.bbs-npc.is-main, .bbs-npc.is-follow { border-left: 3px solid var(--bbs-accent); }
.bbs-protagonist { border-left: 3px solid var(--bbs-warning); }
.bbs-npc.is-absent { background: transparent; box-shadow: none; border-style: dashed; }
.bbs-npc-body { min-width: 0; }
.bbs-npc-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 9px; padding-bottom: 10px; border-bottom: 1px solid var(--bbs-line); margin-bottom: 12px; }
.bbs-npc-name { font-size: 16px; font-weight: 650; min-width: 0; max-width: 100%; overflow-wrap: anywhere; line-height: 1.5; }
.bbs-npc-gender { padding: 2px 6px; border-radius: 5px; background: var(--bbs-surface-2); color: var(--bbs-ink-muted); font-size: 11px; max-width: 100%; overflow-wrap: anywhere; }
.bbs-npc-acts { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 2px; margin-left: auto; flex-shrink: 0; }
.bbs-npc-fields { display: flex; flex-direction: column; gap: 10px; margin: 0; }
.bbs-npc-field { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.bbs-npc-field dt { font-size: 11px; font-weight: 500; line-height: 1.7; color: var(--bbs-ink-muted); }
.bbs-npc-field dd { min-width: 0; margin: 0; font-size: 13px; line-height: 1.75; color: var(--bbs-ink-soft); overflow-wrap: anywhere; white-space: pre-wrap; }
.bbs-npc-field.f-title dd, .bbs-npc-field.f-rel dd { color: var(--bbs-ink); }
.bbs-npc-field.f-cond dt { color: var(--bbs-danger); }
.bbs-npc-field.f-outfit dt { color: var(--bbs-warning); }
.bbs-npc-field.f-loc dt, .bbs-npc-field.f-loc dd.is-follow { color: var(--bbs-accent); }
.bbs-npc-field.f-loc dd.is-nowhere { color: var(--bbs-ink-muted); font-style: italic; }
.bbs-npc-mainhint { margin: 4px 0; color: var(--bbs-ink-muted); font-size: 12px; line-height: 1.8; }
.bbs-item-act.active { color: var(--bbs-accent); background: var(--bbs-accent-soft); }
.bbs-npc-star.active { color: var(--bbs-warning); background: var(--bbs-warning-soft); }
.bbs-modal-autogrow { resize: none; min-height: 0; max-height: 140px; overflow-y: auto; }
.bbs-life-title { margin: 0; font-size: 14px; font-weight: 650; color: var(--bbs-ink); }
.bbs-fold-head { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; min-height: 36px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
.bbs-fold-head.is-static { cursor: default; opacity: 1; }
.bbs-fold-caret { flex-shrink: 0; color: var(--bbs-ink-muted); transition: transform .2s ease; }
.bbs-fold-caret.is-collapsed { transform: rotate(-90deg); }
.bbs-fold-count { border-radius: 6px; padding: 2px 8px; background: var(--bbs-warning-soft); color: var(--bbs-warning); font-size: 11px; font-variant-numeric: tabular-nums; }
.bbs-fold-wrap { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .24s ease; }
.bbs-fold-wrap.is-collapsed { grid-template-rows: 0fr; }
.bbs-fold-inner { min-height: 0; overflow: hidden; }
.bbs-life-group { display: flex; flex-direction: column; }
.bbs-life { display: flex; align-items: flex-start; gap: 12px; padding: 13px 0 13px 12px; border-bottom: 1px solid var(--bbs-line); border-left: 2px solid var(--bbs-line); }
.bbs-life:last-child { border-bottom: 0; }
.bbs-life.is-pinned { border-left-color: var(--bbs-warning); }
.bbs-life.is-archive { border-left-style: dashed; }
.bbs-life-main { flex: 1; min-width: 0; }
.bbs-life-text { margin: 0; font-size: 13px; line-height: 1.8; color: var(--bbs-ink); overflow-wrap: anywhere; }
.bbs-life.is-archive .bbs-life-text { color: var(--bbs-ink-muted); }
.bbs-life-meta { display: flex; flex-wrap: wrap; gap: 5px 9px; margin-top: 6px; }
.bbs-life-tag, .bbs-life-until { max-width: 100%; font-size: 11px; line-height: 1.6; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-life-until { color: var(--bbs-warning); }
@media (max-width: 640px) {
  .bbs-npc { padding: 14px; }
  .bbs-npc-head .bbs-npc-acts { flex-basis: 100%; margin-top: 2px; }
  .bbs-life { flex-direction: column; gap: 6px; }
  .bbs-life .bbs-npc-acts { align-self: flex-end; }
  .bbs-npc-field { grid-template-columns: 54px minmax(0, 1fr); gap: 8px; }
}
@media (max-width: 480px) { .bbs-npc-grouphead .bbs-add-mini { min-width: 40px; min-height: 40px; } }
@media (prefers-reduced-motion: reduce) { .bbs-fold-caret, .bbs-fold-wrap { transition: none; } }
</style>
