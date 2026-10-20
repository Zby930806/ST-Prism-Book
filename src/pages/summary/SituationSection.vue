<script setup lang="ts">
/**
 * 「当前局势与计划」折叠行：眼下局势卡、当前时间地点、计划与悬念（各自可折叠、分页），
 * 以及局势卡编辑、添加计划/悬念、编辑计划/悬念三个弹窗。
 * 手动改动都追加到最新一条有效摘要（叶子）的 delta，重放后生效；没有摘要时禁止手动添加。
 */
import FoldSection from '@/components/FoldSection.vue';
import IconButton from '@/components/IconButton.vue';
import ModalShell from '@/components/ModalShell.vue';
import SegmentedControl from '@/components/SegmentedControl.vue';
import { appendOpToLatestLeaf, editPlan } from '@/memory/apply';
import { refreshInjection } from '@/memory/inject';
import { derivedMeta, memory } from '@/memory/store';
import { weekdayLabel } from '@/memory/timeRel';
import type { SceneFocus } from '@/memory/types';
import { computed, nextTick, ref } from 'vue';
import ReaderRow from './ReaderRow.vue';
import SummaryPager from './SummaryPager.vue';
import { useSummaryPage } from './pageCtx';
import { arrayPage, SUMMARY_PAGE_SIZE } from './view';

const KIND_OPTIONS: { value: 'plan' | 'suspense'; label: string }[] = [
  { value: 'plan', label: '计划' },
  { value: 'suspense', label: '悬念' },
];

const page = useSummaryPage();
const { editingBlocked, allowMemoryEdit, hasLeaf, isTouch } = page;

/* ============ 计划 / 悬念 ============
 * 计划=角色的打算，悬念=未解的谜团；两区平级，各自折叠、各自计数。 */
const newKind = ref<'plan' | 'suspense'>('plan');
const newContent = ref('');
const newTargetTime = ref(''); // 手动添加计划时的可选目标时间（故事内时间）
// 手动添加是低频操作：用弹窗承载，平时只露一个小「+」按钮，不占版面。
const composerOpen = ref(false);
const contentInput = ref<HTMLTextAreaElement | null>(null);
// 从对应区的「+」进入：预选好类型省一步（弹窗内仍可切换）。
function openComposer(kind: 'plan' | 'suspense') {
  if (!allowMemoryEdit()) return;
  if (!hasLeaf.value) return;
  newKind.value = kind;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = true;
  // 仅在非触屏自动聚焦：移动端自动聚焦会立刻弹出输入法，挡住弹窗。
  if (!isTouch) void nextTick(() => contentInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
// 计划/悬念只展示「进行中」。点删除即移除。
const openPlans = computed(() => memory.plans.filter(p => p.status === 'open'));
// 按类型拆两栏：非 suspense 归计划（含旧数据 kind 缺省的情况），suspense 归悬念。
const plansOnly = computed(() => openPlans.value.filter(p => p.kind !== 'suspense'));
const suspenses = computed(() => openPlans.value.filter(p => p.kind === 'suspense'));

/* —— 折叠 ——
 * 两区攒多了都会把下方摘要顶远，故各自可折叠。标题行兼作折叠开关。
 * 折叠态是本机视图偏好，走 localStorage、不进 apiSettings。 */
const PLAN_COLLAPSE_KEY = 'bbs.ui.planCollapsed.v1';
const SUSPENSE_COLLAPSE_KEY = 'bbs.ui.suspenseCollapsed.v1';
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
const plansCollapsed = ref(loadCollapsed(PLAN_COLLAPSE_KEY));
const suspenseCollapsed = ref(loadCollapsed(SUSPENSE_COLLAPSE_KEY));
function toggleFold(kind: 'plan' | 'suspense') {
  if (kind === 'plan') {
    plansCollapsed.value = !plansCollapsed.value;
    persistCollapsed(PLAN_COLLAPSE_KEY, plansCollapsed.value);
  } else {
    suspenseCollapsed.value = !suspenseCollapsed.value;
    persistCollapsed(SUSPENSE_COLLAPSE_KEY, suspenseCollapsed.value);
  }
}
// 计划、悬念各自可折叠（展开状态各存一份）；没有条目时 FoldSection 显示「暂无」与说明，不可折叠。
const plansShown = computed(() => !plansCollapsed.value);
const suspenseShown = computed(() => !suspenseCollapsed.value);

// 两区渲染配置：结构同构、仅类型/文案/计数不同，用配置驱动一套模板避免两处漂移。
const planPages = ref({ plan: 1, suspense: 1 });
const foldGroups = computed(() => [
  {
    kind: 'plan' as const, title: '计划', items: plansOnly.value,
    shown: plansShown.value,
    empty: '角色明确的打算会在摘要时自动记录，也可手动添加。',
  },
  {
    kind: 'suspense' as const, title: '悬念', items: suspenses.value,
    shown: suspenseShown.value,
    empty: '故事中尚未解开的谜团会记录在这里。',
  },
]);

// 叶子 id → 创建楼层。计划 id 形如 `plan:${叶子id}#${序号}`，由此反查创建该计划/悬念时所在楼层。
const leafFloor = computed(() => {
  const m = new Map<string, number>();
  for (const l of derivedMeta.leaves) m.set(l.id, l.msgIndex);
  return m;
});
function planFloor(planId: string): number | undefined {
  const leafId = planId.replace(/^plan:/, '').replace(/#\d+$/, '');
  return leafFloor.value.get(leafId);
}

function addPlan() {
  if (!allowMemoryEdit()) return;
  const content = newContent.value.trim();
  if (!content) return;
  // 创建时间用当前已知故事时间（没有就留空）；目标时间仅计划可填，用户填了才带上
  const createdTime = memory.state.time?.trim() || undefined;
  const targetTime = newKind.value === 'plan' ? newTargetTime.value.trim() || undefined : undefined;
  if (!appendOpToLatestLeaf({ plans: { add: [{ kind: newKind.value, content, createdTime, targetTime }] } })) return;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = false;
}
function removePlan(id: string) {
  if (!allowMemoryEdit()) return;
  appendOpToLatestLeaf({ plans: { remove: [id] } });
}

/* —— 编辑计划/悬念（弹窗） —— */
const editingPlan = ref<{ id: string; kind: 'plan' | 'suspense'; content: string; createdTime: string; targetTime: string } | null>(null);
function openPlanEdit(p: { id: string; kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }) {
  if (!allowMemoryEdit()) return;
  editingPlan.value = {
    id: p.id,
    kind: p.kind,
    content: p.content,
    createdTime: p.createdTime ?? '',
    targetTime: p.targetTime ?? '',
  };
}
function cancelPlanEdit() {
  editingPlan.value = null;
}
function savePlanEdit() {
  if (!allowMemoryEdit()) return;
  const e = editingPlan.value;
  if (!e || !e.content.trim()) return;
  editPlan(e.id, {
    content: e.content,
    createdTime: e.createdTime,
    // 目标时间仅计划有意义；悬念保持空
    targetTime: e.kind === 'plan' ? e.targetTime : '',
  });
  refreshInjection();
  editingPlan.value = null;
}

/* —— 眼下局势卡（编辑弹窗）——
 * 覆盖型单对象：手动编辑=整卡替换；清空=写 null（场面落幕）。 */
const focus = computed(() => memory.state.sceneFocus);
const editingFocus = ref<{ situation: string; participants: string; tension: string; pendingBeat: string } | null>(null);
function openFocusEdit() {
  if (!allowMemoryEdit()) return;
  const f = focus.value;
  editingFocus.value = {
    situation: f?.situation ?? '',
    participants: (f?.participants ?? []).join('、'),
    tension: f?.tension ?? '',
    pendingBeat: f?.pendingBeat ?? '',
  };
}
function cancelFocusEdit() {
  editingFocus.value = null;
}
function saveFocusEdit() {
  if (!allowMemoryEdit()) return;
  const e = editingFocus.value;
  if (!e || !e.situation.trim()) return;
  const participants = e.participants.split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
  const card: SceneFocus = { situation: e.situation.trim(), participants };
  if (e.tension.trim()) card.tension = e.tension.trim();
  if (e.pendingBeat.trim()) card.pendingBeat = e.pendingBeat.trim();
  if (!appendOpToLatestLeaf({ sceneFocus: card })) return;
  refreshInjection();
  editingFocus.value = null;
}
function clearFocus() {
  if (!allowMemoryEdit()) return;
  if (!appendOpToLatestLeaf({ sceneFocus: null })) return;
  refreshInjection();
}

// 折叠行的说明：先给数量，再给局势一句话。
const contextLine = computed(() => {
  const counts = `计划 ${plansOnly.value.length} · 悬念 ${suspenses.value.length}`;
  return `${counts} · ${focus.value?.situation || '暂无局势卡'}`;
});

// 当前时间：优先读正文标签实时算出的「故事内最新时间」（不受最新楼是否已摘影响）；取不到再回退派生的 state.time。
const currentTime = computed(() => derivedMeta.latestStoryTime || memory.state.time);
/** 当前时间的周几（仅标准公历带年份才有）；展示用 */
const currentWeekday = computed(() => weekdayLabel(currentTime.value));

page.onCloseEditors(() => {
  closeComposer();
  cancelPlanEdit();
  cancelFocusEdit();
});
page.onReset(() => {
  planPages.value = { plan: 1, suspense: 1 };
});
</script>

<template>
  <ReaderRow icon="plans" title="当前局势与计划" :line="contextLine">
    <!-- ===== 眼下局势卡:当前场面快照(覆盖型;省略=不动,清空=落幕) ===== -->
    <div class="bbs-fold-section">
      <div class="bbs-section-head">
        <h2 class="bbs-title bbs-title-sub">眼下局势</h2>
        <!-- 无卡时:铅笔留在区块头;有卡时:编辑/清空收进卡头操作区 -->
        <span v-if="!focus" class="bbs-focus-acts">
          <IconButton icon="edit" :disabled="!hasLeaf" :label="hasLeaf ? '手动写局势卡' : '有摘要后才能手动写'" @click="openFocusEdit" />
        </span>
      </div>
      <article v-if="focus" class="bbs-focus">
        <div class="bbs-focus-head">
          <span class="bbs-focus-names" :class="{ 'is-empty': !focus.participants.length }">
            {{ focus.participants.length ? focus.participants.join('、') : '眼下局势' }}
          </span>
          <span v-if="focus.updatedTime" class="bbs-focus-time">记于 {{ focus.updatedTime }}</span>
          <span class="bbs-focus-acts">
            <IconButton icon="edit" :disabled="!hasLeaf" :label="hasLeaf ? '修改局势卡' : '有摘要后才能修改'" @click="openFocusEdit" />
            <IconButton icon="close" tone="danger" :disabled="!hasLeaf" label="清空局势卡（场面结束）" @click="clearFocus" />
          </span>
        </div>
        <p class="bbs-focus-situation">{{ focus.situation }}</p>
        <dl v-if="focus.currentFocus || focus.tension || focus.pendingBeat" class="bbs-focus-fields">
          <div v-if="focus.currentFocus" class="bbs-focus-field">
            <!-- currentFocus 已废弃:仅旧数据仍带值时才展示,不再提示记录 -->
            <dt>焦点</dt>
            <dd>{{ focus.currentFocus }}</dd>
          </div>
          <div v-if="focus.tension" class="bbs-focus-field f-tension">
            <dt>张力</dt>
            <dd>{{ focus.tension }}</dd>
          </div>
          <div v-if="focus.pendingBeat" class="bbs-focus-field f-next">
            <dt>将至</dt>
            <dd>{{ focus.pendingBeat }}</dd>
          </div>
        </dl>
      </article>
      <p v-else class="bbs-plan-empty">{{ hasLeaf ? '暂无局势卡。场面有实质变化时摘要会自动更新；也可点击右侧铅笔手动填写。' : '生成第一条摘要后可手动填写局势卡，之后场面变化也会在摘要时自动记录。' }}</p>
    </div>

    <!-- 当前状态 -->
    <div v-if="currentTime || memory.state.location" class="bbs-state">
      <div v-if="currentTime" class="bbs-state-item">
        <span class="bbs-state-key">时间</span>
        <span class="bbs-state-val">{{ currentTime }}<template v-if="currentWeekday"> ({{ currentWeekday }})</template></span>
      </div>
      <div v-if="memory.state.location" class="bbs-state-item">
        <span class="bbs-state-key">地点</span>
        <span class="bbs-state-val">{{ memory.state.location }}</span>
      </div>
    </div>

    <!-- 局势卡编辑弹窗 -->
    <ModalShell v-if="!editingBlocked" :open="!!editingFocus" title="眼下局势卡" aria-label="编辑局势卡" @close="cancelFocusEdit">
      <template v-if="editingFocus">
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">局面（一句话）</span>
          <textarea v-model="editingFocus.situation" class="bbs-input bbs-modal-textarea" rows="2" placeholder="如「午后在家，她情绪有点低落」「潜行中，刚被巡逻队发现」"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">在场的人（用顿号分隔）</span>
          <input v-model="editingFocus.participants" class="bbs-input" type="text" placeholder="如：主角、阿黛尔" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">互动张力（可选，只写明确且持续的）</span>
          <input v-model="editingFocus.tension" class="bbs-input" type="text" placeholder="如：冷战、尴尬" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">即将发生（可选，只写正文里约好的事）</span>
          <input v-model="editingFocus.pendingBeat" class="bbs-input" type="text" placeholder="正文里明确预告或约定的事" />
        </label>
      </template>
      <template #footer>
        <button class="bbs-btn" type="button" @click="cancelFocusEdit">取消</button>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingFocus?.situation.trim()" @click="saveFocusEdit">保存</button>
      </template>
    </ModalShell>

    <!-- ===== 计划 / 悬念 ===== -->
    <section class="bbs-planning" aria-label="进行中的计划与悬念">
      <div class="bbs-planning-grid">
        <FoldSection
          v-for="g in foldGroups"
          :key="g.kind"
          class="bbs-fold-section"
          :title="g.title"
          :count="g.items.length"
          :open="g.shown"
          :empty-hint="g.empty + (hasLeaf ? '' : '生成第一条摘要后可手动添加。')"
          hint-below
          @update:open="toggleFold(g.kind)"
        >
          <template #title><h2 class="bbs-title bbs-title-sub">{{ g.title }}</h2></template>
          <template #actions>
            <IconButton icon="plus" :disabled="!hasLeaf" :label="hasLeaf ? `手动添加${g.title}` : '有摘要后才能手动添加'" @click="openComposer(g.kind)" />
          </template>
          <div class="bbs-plan-group">
            <div v-for="p in arrayPage(g.items, planPages[g.kind]).items" :key="p.id" class="bbs-plan">
              <div class="bbs-plan-head">
                <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? '悬念' : '计划' }}</span>
                <span v-if="planFloor(p.id) !== undefined" class="bbs-plan-floor">#{{ planFloor(p.id) }}</span>
                <span class="bbs-plan-acts">
                  <IconButton icon="edit" :label="`编辑${g.title}`" @click="openPlanEdit(p)" />
                  <IconButton icon="trash" tone="danger" :label="`删除${g.title}`" @click="removePlan(p.id)" />
                </span>
              </div>
              <p class="bbs-plan-content">{{ p.content }}</p>
              <!-- 故事内时间:立于(创建时间)/ 目标(目标时间),任一存在才显示 -->
              <div v-if="p.createdTime || p.targetTime" class="bbs-plan-times">
                <span v-if="p.createdTime" class="bbs-plan-time">立于 {{ p.createdTime }}</span>
                <span v-if="p.targetTime" class="bbs-plan-time bbs-plan-time-target">目标 {{ p.targetTime }}</span>
              </div>
            </div>
          </div>
          <SummaryPager :page="arrayPage(g.items, planPages[g.kind]).page" :total="g.items.length" :size="SUMMARY_PAGE_SIZE" :label="g.title" @update:page="planPages[g.kind] = $event" />
        </FoldSection>
      </div>

    </section>
  </ReaderRow>

  <!-- ===== 添加计划 / 悬念弹窗 ===== -->
  <ModalShell v-if="!editingBlocked" :open="composerOpen" title="添加计划 / 悬念" aria-label="添加计划或悬念" @close="closeComposer">
    <div class="bbs-modal-field">
      <span class="bbs-modal-label">类型</span>
      <SegmentedControl v-model="newKind" :options="KIND_OPTIONS" label="类型" block />
    </div>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">内容</span>
      <textarea
        ref="contentInput"
        v-model="newContent"
        class="bbs-input bbs-modal-textarea"
        rows="3"
        placeholder="写下这条计划或悬念…"
        @keydown.enter.exact.prevent="addPlan"
      ></textarea>
    </label>
    <!-- 目标时间仅「计划」可填,可选;悬念一般无目标时间故不显示 -->
    <label v-if="newKind === 'plan'" class="bbs-modal-field">
      <span class="bbs-modal-label">目标时间（可选）</span>
      <input
        v-model="newTargetTime"
        class="bbs-input"
        type="text"
        placeholder="如：放学后、1988/10/1，可模糊或留空"
      />
    </label>
    <template #footer>
      <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newContent.trim()" @click="addPlan">添加</button>
    </template>
  </ModalShell>

  <!-- ===== 编辑计划 / 悬念弹窗 ===== -->
  <ModalShell v-if="!editingBlocked" :open="!!editingPlan" :title="editingPlan?.kind === 'suspense' ? '编辑悬念' : '编辑计划'" aria-label="编辑计划或悬念" @close="cancelPlanEdit">
    <template v-if="editingPlan">
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">内容</span>
        <textarea v-model="editingPlan.content" class="bbs-input bbs-modal-textarea" rows="3"></textarea>
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">创建时间（可选）</span>
        <input v-model="editingPlan.createdTime" class="bbs-input" type="text" placeholder="故事内时间，如 1988/9/29" />
      </label>
      <label v-if="editingPlan.kind === 'plan'" class="bbs-modal-field">
        <span class="bbs-modal-label">目标时间（可选）</span>
        <input v-model="editingPlan.targetTime" class="bbs-input" type="text" placeholder="如：放学后、1988/10/1，可模糊或留空" />
      </label>
    </template>
    <template #footer>
      <button class="bbs-btn" type="button" @click="cancelPlanEdit">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingPlan?.content.trim()" @click="savePlanEdit">保存</button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 行内小节标题（眼下局势、计划、悬念）：16px，比折叠行标题低一档；字体、字距与标题行在 base.css。
   计划、悬念的折叠行（标题按钮、条目数、箭头、收展）用共享组件 FoldSection。 */
.bbs-title-sub { font-size:16px; }


.bbs-planning { margin-top:22px; }
.bbs-planning-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
.bbs-plan-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 卡片竖排:标签行在上(类型药丸 + 右侧操作键),内容占满整宽在下 */
.bbs-plan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 0;
  border-radius: 10px;
  background: var(--bbs-surface);
}
.bbs-plan-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 类型标签:小药丸,用颜色区分计划/悬念 */
.bbs-plan-kind {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
}
.bbs-plan-kind.plan {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-plan-kind.suspense {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* 楼层号:创建该计划/悬念时所在楼层 */
.bbs-plan-floor {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
/* 动作组(编辑/删除,共享图标按钮)推到最右;桌面悬停或聚焦该卡才浮现 */
.bbs-plan-acts {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.bbs-plan:hover .bbs-plan-acts,
.bbs-plan:focus-within .bbs-plan-acts {
  opacity: 1;
}
.bbs-plan-content {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* 计划时间:立于/目标 两枚小标签,目标用强调色区分 */
.bbs-plan-times {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
.bbs-plan-time {
  font-size: 11px;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
}
.bbs-plan-time-target {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-plan-empty {
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--bbs-ink-muted);
}

/* —— 当前时间、地点 —— */
.bbs-state {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-top: 12px;
  padding: 12px 0;
}
.bbs-state-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0; /* 允许本项在 wrap 容器内收缩,收缩额度由下面两个子项分配 */
}
.bbs-state-key {
  font-size: 11px;
  color: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 8px;
  /* 药丸不参与收缩:长地名的超出宽度全由右侧值消化 */
  flex: none;
  white-space: nowrap;
}
.bbs-state-val {
  font-size: 13px;
  color: var(--bbs-ink);
  min-width: 0;
  word-break: break-word;
}

/* —— 眼下局势卡:左色条 + 头行(在场者+记时+操作区)+ 主文 + 分类标签字段表 —— */
.bbs-focus-acts {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
}
.bbs-focus {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 14px 16px;
  border: 0;
  border-left: 2px solid var(--bbs-accent);
  border-radius: 10px;
  background: var(--bbs-surface);
  overflow: hidden; /* 让左色条贴着圆角边缘 */
}
.bbs-focus::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
.bbs-focus-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.bbs-focus-names {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  min-width: 0;
  word-break: break-word;
}
.bbs-focus-names.is-empty {
  font-weight: 400;
  color: var(--bbs-ink-muted);
}
.bbs-focus-time {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
@media (hover: hover) {
  .bbs-focus .bbs-focus-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-focus:hover .bbs-focus-acts,
  .bbs-focus-acts:focus-within {
    opacity: 1;
  }
}
.bbs-focus-situation {
  margin: 0;
  font-size: 14px;
  line-height: 1.9;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-focus-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-focus-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-focus-field dt {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  padding: 1px 0;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
  /* 默认中性(旧数据焦点行沿用),具体类别下方各自染色 */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-focus-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 张力:暖色标签 */
.bbs-focus-field.f-tension dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-focus-field.f-tension dd {
  color: var(--bbs-ink);
}
/* 将至:强调色标签——正文明确预告的下一拍 */
.bbs-focus-field.f-next dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-focus-field.f-next dd {
  color: var(--bbs-ink);
}

/* 弹窗里的多行输入 */
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}

/* 触屏:计划、悬念的动作键常显 */
@media (hover: none) {
  .bbs-plan-acts {
    opacity: 1;
  }
}
/* 减弱动效:折叠箭头与收展瞬切 */
@media (max-width: 640px) {
  /* 时间/地点:窄屏堆叠成两行,长地点不把行挤乱 */
  .bbs-state { flex-direction: column; gap: 8px; }
  .bbs-planning-grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .bbs-focus-time { flex-basis: 100%; order: 3; }
}
</style>
