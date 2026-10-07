<script setup lang="ts">
import { npcLocationLabel } from '@/memory/npcLocation';
import { apiSettings } from '@/api/settings';
import Icon from '@/components/Icon.vue';
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
    toast(`置顶最多 ${LIFE_PIN_CAP} 条,先取消一条再置顶`, 'warning');
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
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">角色</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? '手动添加角色' : '需先有摘要才能手动添加'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>
    <SummaryOnlyNotice subject="主角档案、NPC 名册与角色状态" />

    <hr class="bbs-rule" />

    <!-- ===== 生活小档案:主角与主要角色的偏好/习惯/近期状态(三投放层)。置于主角卡之上且可折叠,不打断下方角色卡流 ===== -->
    <div class="bbs-protagonist-section">
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
          <h2 class="bbs-life-title" title="置顶条常驻发送;时效/长期条按相关性浮现;沉降条仅关键词触发">生活小档案</h2>
          <span v-if="lifeFoldable" class="bbs-fold-count">{{ memory.lifeDetails.length }}</span>
        </button>
        <span v-if="apiSettings.summaryOnlyMode" class="bbs-npc-grouphint is-local-only">仅供棱镜宝书记录,不发送给主对话 AI</span>
        <button
          class="bbs-add-mini"
          type="button"
          :disabled="!hasLeaf"
          :title="hasLeaf ? '手动添加生活细节' : '需先有摘要才能手动添加'"
          @click="openDetailComposer"
        >
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height;reduced-motion 下瞬切(见样式) -->
      <div class="bbs-fold-wrap" :class="{ 'is-collapsed': !lifeShown }">
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
                  :title="d.tier === 'pinned' ? '取消置顶' : '置顶(常驻发送,最多5条)'"
                  @click="toggleDetailPin(d)"
                >
                  <Icon name="pin" />
                </button>
                <button
                  class="bbs-item-act"
                  type="button"
                  :title="d.tier === 'archive' ? '恢复为时效层' : '沉降(仅相关时浮现)'"
                  @click="toggleDetailArchive(d)"
                >
                  <Icon :name="d.tier === 'archive' ? 'upload' : 'download'" />
                </button>
                <button class="bbs-item-act" type="button" title="编辑" @click="openDetailEdit(d)"><Icon name="edit" /></button>
                <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="removeDetail(d)"><Icon name="trash" /></button>
              </span>
            </article>
          </div>
          <p v-if="!memory.lifeDetails.length" class="bbs-npc-mainhint">尚无生活细节。摘要会记录主角及主要角色明确说过/正文揭示的偏好、习惯和近况,每条标明所属人物;也可手动添加或纠正归属。</p>
        </div>
      </div>
    </div>

    <div class="bbs-protagonist-section">
      <div class="bbs-npc-grouphead">
        <span class="bbs-npc-grouptag is-protagonist"><Icon name="characters" />主角</span>
        <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
          {{ apiSettings.summaryOnlyMode ? '仅供棱镜宝书记录，不发送给主对话 AI' : '始终完整发送,与 NPC 名册分开记录' }}
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
          <p v-else-if="!protagonistHasData" class="bbs-npc-mainhint">尚无主角状态记录。后续摘要会从剧情中的明确事实逐步补充。</p>
        </div>
      </article>
    </div>

    <div v-if="memory.npcs.length" class="bbs-npc-groups">
      <!-- 主要角色:核心主演,永远全量发送。这里突出「即时状态面板」(着装/状态/所在),弱化身份档案 -->
      <div v-if="mains.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-main"><Icon name="star" />主要角色</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍会重点维护状态，但不发送给主对话 AI' : '始终随剧情发送,重点维护当前状态' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in mains" :key="n.id" class="bbs-npc is-present is-main">
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
                  <dt>定位证据</dt>
                  <dd :class="{ 'is-follow': n.follow }">{{ npcLocationLabel(n) }}</dd>
                </div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ n.condition }}</dd></div>
              </dl>
              <p v-else class="bbs-npc-mainhint">尚无状态记录 —— 编辑可补充当前着装 / 状态 / 所在。</p>
            </div>
          </article>
        </div>
      </div>

      <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
      <div v-if="present.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-present">在场</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍按在场状态完整记录，但不发送给主对话 AI' : '完整信息随剧情发送' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in present" :key="n.id" class="bbs-npc is-present" :class="{ 'is-follow': n.follow }">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色(仅调整棱镜宝书内的角色分组)' : '标记为主要角色(始终全量发送、追踪状态)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    :class="{ active: n.follow }"
                    type="button"
                    :title="n.follow ? '随行中 · 点击取消(留在当前地点)' : '标记为随行同伴'"
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
                  <dt>定位证据</dt>
                  <dd :class="{ 'is-follow': n.follow }">{{ npcLocationLabel(n) }}</dd>
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
      <div v-if="nearby.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-nearby">同区域</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍按同区域分档记录，但不发送给主对话 AI' : '在附近,发送名字、身份与性格' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in nearby" :key="n.id" class="bbs-npc is-nearby">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色(仅调整棱镜宝书内的角色分组)' : '标记为主要角色(始终全量发送、追踪状态)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴(将随主角在场)"
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
                <div v-if="n.location || n.lastKnownLocation" class="bbs-npc-field f-loc"><dt>定位证据</dt><dd>{{ npcLocationLabel(n) }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>性格</dt><dd>{{ n.personality }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- 不在场:只发名+身份给 AI,这里也压暗、收起细节 -->
      <div v-if="absent.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag">不在场 / 位置未确认</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍保留名册分档，但不发送给主对话 AI' : '仅发送简要名册与已有好感档位,省 token' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in absent" :key="n.id" class="bbs-npc is-absent">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色(仅调整棱镜宝书内的角色分组)' : '标记为主要角色(始终全量发送、追踪状态)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴(将随主角在场)"
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
                  <dt>定位证据</dt>
                  <dd :class="{ 'is-nowhere': !n.location || n.locationStale }">{{ npcLocationLabel(n) }}</dd>
                </div>
              </dl>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="npcs" /></span>
      <p>还没有登场的 NPC。摘要时会记下与主角有交集的人物,也可点右上角「+」手动添加。</p>
    </div>

    <ModalMask :open="!!protagonistEditing" @close="cancelProtagonistEdit">
      <div v-if="protagonistEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑主角档案">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑主角档案</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelProtagonistEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="protagonistEditing.gender" class="bbs-input" type="text" placeholder="如:男、女" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">年龄(记录当时的值,随剧情时间自动推算)</span>
          <input v-model="protagonistEditing.age" class="bbs-input" type="text" placeholder="如:25、二十出头" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前身份 / 职业 / 种族 / 公开地位</span>
          <textarea v-model="protagonistEditing.identity" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">稳定外貌 / 身体特征</span>
          <textarea v-model="protagonistEditing.appearance" class="bbs-input bbs-modal-textarea" rows="2" placeholder="如:黑色短发、左眉有疤"></textarea>
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
          <span class="bbs-modal-label">细节内容(此人明说过/正文揭示的偏好、习惯或近期状态)</span>
          <textarea v-model="detailEditing.text" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:认为煎饼果子不加脆饼就没有灵魂(姓名由所属人物自动显示)"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">主题标签(可选,1-3 个,斜杠分隔)</span>
          <input v-model="detailEditing.topics" class="bbs-input" type="text" placeholder="如 饮食/作息/工作" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">关键词(可选,触发匹配用,斜杠分隔)</span>
          <input v-model="detailEditing.anchors" class="bbs-input" type="text" placeholder="如 香菜/项目/死线" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">时效(可选,故事内到期时间;长期偏好留空)</span>
          <input v-model="detailEditing.until" class="bbs-input" type="text" placeholder="如 1988/10/1;留空=长期稳定" />
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
          <input v-model="draft.gender" class="bbs-input" type="text" placeholder="如:男、女" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">年龄(记录当时的值,随剧情时间自动推算)</span>
          <input v-model="draft.age" class="bbs-input" type="text" placeholder="如:25、二十出头" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份(职业 / 与主角的关系)</span>
          <textarea v-model="draft.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈掌柜、青梅竹马"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与主角的关系(称谓在前 + 一句态度)</span>
          <textarea v-model="draft.relation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:主角的师姐,明面冷淡暗中维护"></textarea>
        </label>
        <div v-for="f in NPC_AFFINITY_FIELDS" :key="f.key" class="bbs-modal-field">
          <span class="bbs-modal-label">{{ f.label }}(对 {{ protagonistName }})</span>
          <BbsSelect v-model="draft[f.key]" :options="f.options" :aria-label="f.label" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">好感说明(定性估计,不是本轮心情;未知不等于中性)</span>
          <textarea v-model="draft.affinityNote" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:内心在意,但习惯以冷淡掩饰;没有新依据时保持不变"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与其他角色的关系(仅血缘 / 婚姻 / 宿敌等长期关系)</span>
          <textarea v-model="draft.ties" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:阿黛尔之父;与镇长有旧怨"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <textarea v-model="draft.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:沉默寡言、护短"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述(固定特征:发色 / 身材 / 疤痕,勿写穿着)</span>
          <textarea v-model="draft.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装(会随剧情变化)</span>
          <textarea v-model="draft.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:红斗篷、佩长剑"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前状态(受伤 / 疲惫等,无则留空)</span>
          <textarea v-model="draft.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? '主要角色(核心主演,仅在棱镜宝书内重点追踪状态)' : '主要角色(核心主演,始终全量发送、重点追踪状态)' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴(跟随主角移动,永远在场)</span>
        </label>
        <label v-if="!draft.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点(留空=所在不明,不再视为在场)</span>
          <textarea v-model="draft.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈、王宫;留空=所在不明"></textarea>
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
          <input v-model="editing.gender" class="bbs-input" type="text" placeholder="如:男、女" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">年龄(记录当时的值,随剧情时间自动推算;不改则保留原锚点)</span>
          <input v-model="editing.age" class="bbs-input" type="text" placeholder="如:25、二十出头" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份(职业 / 与主角的关系)</span>
          <textarea v-model="editing.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈掌柜、青梅竹马"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与主角的关系(称谓在前 + 一句态度)</span>
          <textarea v-model="editing.relation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:主角的师姐,明面冷淡暗中维护"></textarea>
        </label>
        <div v-for="f in NPC_AFFINITY_FIELDS" :key="f.key" class="bbs-modal-field">
          <span class="bbs-modal-label">{{ f.label }}(对 {{ protagonistName }})</span>
          <BbsSelect v-model="editing[f.key]" :options="f.options" :aria-label="f.label" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">好感说明(定性估计,不是本轮心情;未知不等于中性)</span>
          <textarea v-model="editing.affinityNote" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:内心在意,但习惯以冷淡掩饰;没有新依据时保持不变"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">与其他角色的关系(仅血缘 / 婚姻 / 宿敌等长期关系)</span>
          <textarea v-model="editing.ties" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:阿黛尔之父;与镇长有旧怨"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <textarea v-model="editing.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:沉默寡言、护短"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述(固定特征:发色 / 身材 / 疤痕,勿写穿着)</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装(会随剧情变化)</span>
          <textarea v-model="editing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:红斗篷、佩长剑"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前状态(受伤 / 疲惫等,无则留空)</span>
          <textarea v-model="editing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? '主要角色(核心主演,仅在棱镜宝书内重点追踪状态)' : '主要角色(核心主演,始终全量发送、重点追踪状态)' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴(跟随主角移动,永远在场)</span>
        </label>
        <label v-if="!editing.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点(留空=所在不明,不再视为在场)</span>
          <textarea v-model="editing.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈、王宫;留空=所在不明"></textarea>
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
      删除「{{ removing?.name }}」。此操作写入最新摘要,删除楼层可回退。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.bbs-npc-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.bbs-protagonist-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 18px;
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 分组头:在场/不在场是这页的信息骨架(= AI 实际收到的分档),用细标签 + 一句说明点明取舍 */
.bbs-npc-grouphead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.bbs-npc-grouptag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouptag.is-present {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
/* 同区域:描边空心 pill —— 介于「在场(实心强调)」与「不在场(实心灰底)」之间 */
.bbs-npc-grouptag.is-nearby {
  background: transparent;
  border: 1px solid var(--bbs-line-strong);
  padding: 1px 8px; /* 补偿 1px 边框,保持与实心标签等高 */
}
/* 主要角色分组标签:同强调底色 + 星标,与置顶组的「核心」地位呼应 */
.bbs-npc-grouptag.is-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-npc-grouptag.is-protagonist {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-grouphint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouphint.is-local-only {
  color: var(--bbs-warning);
  font-weight: 600;
}

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* —— 角色卡:与物品/场景同款的安静卡片。在场/随行只用「左侧一道色条」表态,
      不再用大圆球——保持列表整体的克制,把强调留给那道竖条。 —— */
.bbs-npc {
  position: relative;
  display: flex;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden; /* 让左色条贴着圆角边缘 */
}
/* 在场:左缘一道青瓷色条 */
.bbs-npc.is-present::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
.bbs-protagonist::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-warning);
  opacity: 0.65;
}
/* 同区域:左色条更细更淡 —— 在「在场(3px@0.5)」与「不在场(无条)」之间的一档 */
.bbs-npc.is-nearby::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--bbs-accent);
  opacity: 0.28;
}
/* 随行:色条加粗加实,作同伴的最高标识 */
.bbs-npc.is-follow::before {
  width: 3px;
  opacity: 1;
}
/* 主要角色:整条左色条加粗实色,卡片更醒目,呼应「核心主演」地位 */
.bbs-npc.is-main::before {
  width: 4px;
  opacity: 1;
}
.bbs-npc.is-main {
  border-color: var(--bbs-line-strong);
}
/* 不在场:整行压暗 + 虚线框,与「只发名+身份」的弱化呼应 */
.bbs-npc.is-absent {
  background: transparent;
  border-style: dashed;
}
.bbs-npc.is-absent .bbs-npc-name {
  color: var(--bbs-ink-soft);
}

.bbs-npc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 头行:名字 + 性别/年龄 + 操作区。只放定长内容——所在地、身份这类变长文本一律下沉到
   下方字段表,否则它们会吃光行宽、把名字挤成一两个字。 */
.bbs-npc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbs-npc-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  /* 允许收缩 + 单行省略:长名字截断显示(title 悬浮见全名),
     不把右侧操作钮顶出卡片——卡有 overflow:hidden,溢出即被裁掉点不到 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 性别小标签:紧凑灰色括注,跟在名字后面 */
.bbs-npc-gender {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  flex: 0 0 auto;
  white-space: nowrap;
}
.bbs-npc-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

/* —— 字段表:身份/性格/外貌统一成「彩色类别标签 + 内容」的对齐行。
      标签同宽左对齐成一条竖列,用语义色区分类别,内容统一字号——治「三行同灰、层次乱」。 —— */
.bbs-npc-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-npc-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-npc-field dt {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  padding: 1px 0;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
  /* 默认中性,具体类别在下方各自染色 */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 身份:强调金标签——这是最关键的一类身份信息 */
.bbs-npc-field.f-title dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-title dd {
  color: var(--bbs-ink);
}
/* 着装:暖色标签——即时层核心,与「会变的当前状态」呼应,内容也加重 */
.bbs-npc-field.f-outfit dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-field.f-outfit dd {
  color: var(--bbs-ink);
}
/* 状态/健康:警示色标签——受伤/异常一眼可辨 */
.bbs-npc-field.f-cond dt {
  background: var(--bbs-danger-soft);
  color: var(--bbs-danger);
}
/* 性格:中性偏暖(沿用默认中性,与档案层弱化一致) */
.bbs-npc-field.f-trait dt {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
/* 与主角的关系:强调色标签——关系是「他是谁的谁」,与身份同级重要 */
.bbs-npc-field.f-rel dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-rel dd {
  color: var(--bbs-ink);
}
/* 人际(与其他角色):中性标签(档案层次要细节) */
/* 外貌:中性标签(沿用默认),作次要细节 */
/* 所在:青瓷描边——位置是「他现在在哪」,属即时层,但比着装/状态弱一档,故只染字不填底 */
.bbs-npc-field.f-loc dt {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--bbs-accent) 35%, transparent);
  color: var(--bbs-accent);
  /* 描边占 2px,减内距让这枚标签与其他填底标签仍同宽同高 */
  padding: 0;
}
/* 随行中:所在内容点亮强调色,替代原头行那枚「随行」标 */
.bbs-npc-field.f-loc dd.is-follow {
  color: var(--bbs-accent);
}
/* 所在不明:虚化斜体,与「不在场」组的压暗基调一致 */
.bbs-npc-field.f-loc dd.is-nowhere {
  font-style: italic;
  opacity: 0.7;
}

/* 主要角色无状态时的占位提示:引导补录当前状态,避免空卡 */
.bbs-npc-mainhint {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--bbs-ink-muted);
}

/* PC(支持 hover)上操作按钮默认隐藏,悬停整卡才浮现;触屏常驻(与物品页一致) */
@media (hover: hover) {
  .bbs-npc-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-npc:hover .bbs-npc-acts,
  .bbs-npc-acts:focus-within {
    opacity: 1;
  }
}

/* 行内操作按钮:复刻 items 页(scoped 不继承,重声明同款) */
.bbs-item-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 14px;
}
.bbs-item-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-item-del:hover {
  color: var(--bbs-danger);
}
/* 随行开关:激活态点亮强调色,把「这是同伴」表达在按钮本身 */
.bbs-npc-pin.active {
  color: var(--bbs-accent);
}
.bbs-npc-pin.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* 主要角色星标:激活态点亮(实心感由强调色填充表达) */
.bbs-npc-star.active {
  color: var(--bbs-accent);
}
.bbs-npc-star.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* 主要角色卡的操作区常驻(置顶组无需 hover 才显,星标本身就是状态指示) */
.bbs-npc.is-main .bbs-npc-acts {
  opacity: 1;
}
.bbs-protagonist .bbs-npc-acts {
  opacity: 1;
}

.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
/* 自适应高度:默认贴合一行,内容多才长高(v-autosize 量 scrollHeight 写回);
   min-height 归零、resize 交给指令,封顶后滚动。 */
.bbs-modal-autogrow {
  resize: none;
  min-height: 0;
  max-height: 140px;
  overflow-y: auto;
}
.bbs-modal-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.bbs-modal-check input {
  flex-shrink: 0;
}
.bbs-empty {
  flex: 1;
}

/* —— 生活小档案 —— */
/* 区块标题:与摘要页区块标题同款的普通小标题字,不用药丸题签 */
.bbs-life-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-npc-grouphead .bbs-add-mini {
  margin-left: auto;
}
/* —— 折叠头/容器:与摘要页计划/悬念折叠同款。标题行整体可点:左箭头 + 题签 + 金色计数标 —— */
.bbs-fold-head {
  flex: 0 0 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
/* 无可折叠(零条目)时退化为普通标题:不是按钮观感、光标默认 */
.bbs-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右;hover 整行才点亮强调色 */
.bbs-fold-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbs-fold-head:hover:not(.is-static) .bbs-fold-caret,
.bbs-fold-head:focus-visible .bbs-fold-caret {
  color: var(--bbs-accent);
}
/* 计数标:金底描边小药丸,始终显示;收拢时尤其有用——点明藏了多少条 */
.bbs-fold-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 9px;
  font-variant-numeric: tabular-nums;
}
/* —— 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height —— */
.bbs-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
}
.bbs-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
/* min-height:0 + overflow:hidden 才能让 0fr 真正压到零高 */
.bbs-fold-inner {
  min-height: 0;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .bbs-fold-caret,
  .bbs-fold-wrap {
    transition: none;
  }
}

.bbs-life-group {
  margin-top: 8px;
}
/* 一条细节:与 NPC 卡同族的卡片容器(主题描边/圆角/纸面) */
.bbs-life {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  margin-bottom: 6px;
  overflow: hidden; /* 让置顶色条贴着圆角边缘 */
}
/* 置顶:左缘一道金色条,呼应角色卡「在场」、点明「常驻发送」 */
.bbs-life.is-pinned::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
/* 沉降:虚线框 + 压暗,呼应角色卡「不在场」的弱化 */
.bbs-life.is-archive {
  background: transparent;
  border-style: dashed;
}
.bbs-life.is-archive .bbs-life-text {
  color: var(--bbs-ink-soft);
}
.bbs-life-main {
  flex: 1;
  min-width: 0;
}
.bbs-life-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-life-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
/* 主题/时效小签:与计划卡时间签同款的描边小标签 */
.bbs-life-tag,
.bbs-life-until {
  font-size: 10.5px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-line);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-life-until {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: color-mix(in srgb, var(--bbs-accent) 40%, transparent);
}
.bbs-life .bbs-npc-acts {
  flex-shrink: 0;
}
.bbs-item-act.active {
  color: var(--bbs-accent);
}

/* ============ 窄屏:生活细节卡的重排 ============ */
@media (max-width: 640px) {
  /* 生活小档案:主题/时效标签与操作钮同占顶行,正文整行排在下方。
     main 改 display:contents,让文本/标签直接参与卡片 flex 排序,无需改模板结构 */
  .bbs-life {
    flex-wrap: wrap;
  }
  .bbs-life-main {
    display: contents;
  }
  .bbs-life-meta {
    order: 1;
    flex: 1 1 auto;
    min-width: 0;
    margin-top: 0;
    align-self: center;
  }
  .bbs-life .bbs-npc-acts {
    order: 2;
    flex-shrink: 0;
    margin-left: auto;
  }
  .bbs-life-text {
    order: 3;
    flex-basis: 100%;
  }
}
</style>
