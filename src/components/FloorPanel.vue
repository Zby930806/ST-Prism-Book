<script setup lang="ts">
/**
 * 楼内摘要面板(挂在每条 AI 楼的 shadow 内,由 floorPanel.ts 逐楼挂载)。
 *
 * 形态:一张与摘要页同源的卡片(.bbs-summary-card 语言),外壳见 floor/FloorCardShell.vue。
 *   - 卡片头(锚点):楼号 + 时间 + 召回/不一致标签,次行摘要预览;展开后预览与时间不再重复(下方有正文和可编辑的时间)。
 *     右端展开箭头,右侧是番外键(点一下标为番外 / 取消)和单楼摘要键(没有摘要时「生成」,已有时「重新生成」)。
 *   - 卡片体(抽屉):时间/地点、摘要正文、状态变动(floor/DeltaGroups)、记录冲突(floor/FloorConflicts)、
 *     召回(floor/FloorRecall);页脚是带文字的生成/重新生成摘要、删除摘要。
 *     本楼没有记录地点变化时,地点一栏显示之前最近一次记录的地点(浅色),点击可为本楼单独设置。
 *
 * 编辑:**逐条就地编辑**。点摘要正文 / 时间 / 地点 / 某条变动,就地展开该单元的输入框,
 *   保存即写、取消即收,其余保持只读。同一时刻只有一个单元在编辑;状态与读写在 floor/useLeafEdit.ts。
 *
 * 数据:chat 非 reactive。leaf 返回浅拷贝(新引用)+ 追踪 sig.tick / derivedMeta.rev,
 *   任何来源(ST 事件、主界面摘要、楼内编辑)的变化都能刷新。
 */
import { computed, provide, ref, shallowRef, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import RegenerateCompare from '@/components/RegenerateCompare.vue';
import FloorCardShell from '@/components/floor/FloorCardShell.vue';
import DeltaGroups from '@/components/floor/DeltaGroups.vue';
import FloorConflicts from '@/components/floor/FloorConflicts.vue';
import FloorDropped from '@/components/floor/FloorDropped.vue';
import FloorRecall from '@/components/floor/FloorRecall.vue';
import { LEAF_EDIT, useLeafEdit } from '@/components/floor/useLeafEdit';
import { getContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { getLeaf, leafValid, deleteLeafAt } from '@/memory/apply';
import { legacyLeafFrozen } from '@/memory/compatibility';
import { deltaTagGroups, type DeltaTagGroup } from '@/memory/deltaTags';
import { applyFloorPreview, discardFloorPreview, engineState, floorBackfillState, floorCoveredByImport, previewRegenerateFloor, setFloorOmit, summarizeFloor, type FloorPreview } from '@/memory/engine';
import { legacyMigrationSeedFloor } from '@/memory/migrate';
import { derivedMeta } from '@/memory/store';
import { leafDropped } from '@/memory/summaryResponse';
import { readFloorRecall } from '@/memory/vector/floorRecall';
import { floorRecallView } from '@/memory/vector/recallView';
import { ui } from '@/state/ui';
import type { LeafExtra, StoredDelta } from '@/memory/types';

const props = defineProps<{ floor: number; sig: { tick: number } }>();

// —— 读当前楼消息/叶子。两个刷新源都追踪:
//   · sig.tick:注入宿主的 ST 事件(渲染/翻页/切聊天)
//   · derivedMeta.rev:任何 recomputeDerived(主界面摘要、楼内编辑、引擎自动摘要)
const msg = computed<STMessage | undefined>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return getContext()?.chat?.[props.floor];
});
// ⚠️ msg 返回 chat[floor] 同一对象引用(原地改标记/叶子,引用不变),Vue computed 靠 === 判定
// 会认为 msg「没变」而不向下游传播。故 omit/valid/leaf 都必须**各自**直接追踪 rev/tick,
// 不能只靠 msg —— 否则番外标记切换后 omit 不刷新(番外按钮状态不变,是这个 bug 的根因)。
const omit = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return !!msg.value?.extra?.bbs_omit;
});
// leaf 还额外返回浅拷贝(新引用),让依赖 leaf 的下游(d/*Tags/preview)也强制重算。
const leaf = computed<LeafExtra | null>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const l = getLeaf(msg.value);
  return l ? { ...l } : null;
});
const valid = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return leafValid(msg.value);
});
const d = computed<StoredDelta | null>(() => leaf.value?.delta ?? null);

// 由导入的旧总结覆盖的楼层没有逐楼摘要,也不单独摘要(补摘列表同样排除它们)
const importCovered = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return !valid.value && floorCoveredByImport(props.floor);
});
// 旧摘要没有记录分页、当前又不在第一页:不能确定归属,这一页不摘要、不注入,翻回第一页即恢复
const frozen = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const m = msg.value;
  return !!m && legacyLeafFrozen(m.extra?.bbs_leaf, m);
});
// 生成本楼摘要时没写入的更新(最后一次尝试中不符合要求而去掉的项)
const dropped = computed(() => (omit.value || !valid.value ? [] : leafDropped(leaf.value)));
// 早先版本迁移时把 Horae 的最终状态写在这一楼的摘要里:重新摘要会替换它们
const migrationSeed = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const chat = getContext()?.chat;
  return !!chat && valid.value && legacyMigrationSeedFloor(chat) === props.floor;
});

// 生成本楼前的召回记录(启用楼层面板之后生成的回复才有;记录写入在 floorRecall.ts)
const recall = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return floorRecallView(readFloorRecall(msg.value));
});
// 卡片头的小标签:召回到内容或召回失败时显示,其余情况不占位
const recallChip = computed(() => {
  const r = recall.value;
  if (r?.phase === 'done' && r.items.length) return { text: `召回 ${r.items.length}`, failed: false };
  if (r?.phase === 'failed') return { text: '召回失败', failed: true };
  return null;
});

// 正文与记录不一致(摘要时标出,记录保持原样);番外楼不显示
const conflicts = computed(() => (omit.value || !valid.value ? [] : (leaf.value?.conflicts ?? [])));
const openConflicts = computed(() => conflicts.value.filter(c => !c.status || c.status === 'open').length);

const expanded = ref(false);
// 抽屉 id：每楼面板在各自的 shadow 内，楼号即可保证唯一
const drawerId = `bbs-fp-drawer-${props.floor}`;
const busy = ref(false);
const regenerateConfirmOpen = ref(false);
// 重新摘要先对比:新结果放在这里等用户选,选之前不写入
// shallowRef:预览对象要原样交回 engine(按对象找回请求上下文),不能被包成响应式代理
const comparePreview = shallowRef<FloorPreview | null>(null);
const applyingPreview = ref(false);

const summarizingHere = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  return floorBackfillState.running
    && floorBackfillState.floor === props.floor
    && floorBackfillState.chatId === chatId;
});
const summaryActionDisabled = computed(() => busy.value || engineState.running || omit.value || importCovered.value || frozen.value || !!comparePreview.value);
const summaryActionTitle = computed(() => {
  if (omit.value) return '番外楼不参与摘要，请先取消番外';
  if (importCovered.value) return `楼层 #${props.floor} 已由导入的旧总结覆盖，不单独摘要`;
  if (frozen.value) return `楼层 #${props.floor} 的旧摘要没有记录分页，这一页不摘要`;
  if (summarizingHere.value) return `正在生成楼层 #${props.floor} 的摘要`;
  return valid.value ? `重新生成楼层 #${props.floor} 的摘要` : `生成楼层 #${props.floor} 的摘要`;
});
// 单楼摘要的图标与按钮文字:没有摘要时「生成」(摘要图标),已有摘要时「重新生成」(刷新图标)
const summaryIcon = computed(() => (valid.value ? 'refresh' : 'summary'));
const summaryActionText = computed(() => {
  if (summarizingHere.value) return '生成中…';
  return valid.value ? '重新生成摘要' : '生成摘要';
});

const previewText = computed(() => {
  if (omit.value) return '不计入记忆';
  if (valid.value && leaf.value?.text) return leaf.value.text;
  if (importCovered.value) return '已由导入的旧总结覆盖';
  if (frozen.value) return '旧摘要未记录分页，这一页不摘要';
  return valid.value ? '（无摘要正文）' : '待摘要';
});
const previewMuted = computed(() => omit.value || !(valid.value && leaf.value?.text));

const timeLabel = computed(() => {
  const l = leaf.value;
  if (!l) return '';
  const s = l.timeStart?.trim();
  const e = l.timeEnd?.trim();
  if (s && e && s !== e) return `${s} → ${e}`;
  return s || e || l.timeLabel?.trim() || '';
});

/* ============ 变动分组 ============ */
// 标签的构建逻辑和重新摘要的对比弹窗共用,见 memory/deltaTags。计划标签要反查别楼的计划内容,所以另外追踪 derivedMeta.rev。
const groups = computed<DeltaTagGroup[]>(() => {
  void derivedMeta.rev;
  return deltaTagGroups(d.value, props.floor);
});
const hasTags = computed(() => groups.value.some(g => g.tags.length > 0));
const hasAnyDelta = computed(() => hasTags.value || !!d.value?.location);

/* ============ 地点 ============ */
// 地点只在变化时记录。本楼没记录时,往前找最近一次记录的地点作为当前地点显示(跳过番外楼和失效摘要)。
function deltaLocation(delta: StoredDelta | null | undefined): string {
  const text = typeof delta?.location === 'string' ? delta.location.trim() : '';
  if (text) return text;
  const path = Array.isArray(delta?.locationPath) ? delta.locationPath.filter(p => typeof p === 'string' && p.trim()) : [];
  return path.join(' / ');
}
const ownLocation = computed(() => deltaLocation(d.value));
const inheritedLocation = computed<{ text: string; floor: number } | null>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  if (ownLocation.value) return null;
  const chat = getContext()?.chat;
  if (!chat) return null;
  for (let i = props.floor - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.extra?.bbs_omit) continue;
    const text = deltaLocation(getLeaf(m)?.delta);
    if (text && leafValid(m)) return { text, floor: i };
  }
  return null;
});

/* ============ 就地编辑(状态与读写见 floor/useLeafEdit.ts,子组件 inject 取用) ============ */
const leafEdit = useLeafEdit({ floor: props.floor, leaf, omit, d });
provide(LEAF_EDIT, leafEdit);
const { editKey, edit, setFocus, onTextInput, onFieldKeydown, cancelEdit, editText, saveText, editTime, saveTime, editLoc, saveLoc } = leafEdit;
// 编辑沿用来的地点时,以它为起点修改
function editLocation() {
  editLoc();
  if (!ownLocation.value && inheritedLocation.value) edit.location = inheritedLocation.value.text;
}

/* —— 整楼操作 —— */
// 删除摘要走行内两步确认(面板嵌在 #chat 滚动容器 + 每楼独立 shadow,行内比 Teleport 弹窗更稳、更贴合紧凑面板)
const confirmingDelete = ref(false);
function askDelete() {
  if (busy.value) return;
  confirmingDelete.value = true;
}
function cancelDelete() {
  confirmingDelete.value = false;
}
async function removeLeaf() {
  if (busy.value) return;
  busy.value = true;
  try {
    deleteLeafAt(props.floor);
    editKey.value = null;
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}
// 收起抽屉 / 切换番外时,复位删除确认态;摘要失效时关闭重摘确认。
watch([expanded, omit, leaf], () => {
  if (!expanded.value || omit.value || !leaf.value) confirmingDelete.value = false;
  if (omit.value || !valid.value) regenerateConfirmOpen.value = false;
});
async function toggleOmit() {
  if (busy.value || engineState.running) return;
  busy.value = true;
  try {
    await setFloorOmit(props.floor, !omit.value);
  } finally {
    busy.value = false;
  }
}

function requestSummary() {
  if (summaryActionDisabled.value) return;
  if (valid.value && leaf.value) {
    regenerateConfirmOpen.value = true;
    return;
  }
  void generateMissingSummary();
}

async function generateMissingSummary() {
  if (summaryActionDisabled.value) return;
  // 按这一次的结果提示:没有执行时(例如有别的摘要在进行)不把之前留下的错误当成这次的
  const result = await summarizeFloor(props.floor);
  if (result === 'failed') {
    toast(engineState.lastError || `楼层 #${props.floor} 的摘要没有生成`, 'error');
    return;
  }
  if (result === 'done') toast(`楼层 #${props.floor} 摘要已生成`, 'success');
}

// 先生成新结果、不写入;生成好了打开对比,用户选「用新的」才替换
async function confirmRegenerate() {
  if (summaryActionDisabled.value) return;
  const preview = await previewRegenerateFloor(props.floor);
  regenerateConfirmOpen.value = false;
  if (preview) {
    comparePreview.value = preview;
    return;
  }
  toast(engineState.lastError || `楼层 #${props.floor} 重新摘要失败`, 'error');
}
async function useNewSummary() {
  const preview = comparePreview.value;
  if (!preview || applyingPreview.value) return;
  applyingPreview.value = true;
  try {
    const ok = await applyFloorPreview(preview);
    comparePreview.value = null;
    if (ok) toast(`楼层 #${props.floor} 已替换为新摘要`, 'success');
    else toast(engineState.lastError || `楼层 #${props.floor} 未替换`, 'error');
  } finally {
    applyingPreview.value = false;
  }
}
function keepCurrentSummary() {
  const preview = comparePreview.value;
  if (!preview || applyingPreview.value) return;
  discardFloorPreview(preview);
  comparePreview.value = null;
}

</script>

<template>
  <div class="bbs-root bbs-fp" :data-theme="ui.theme">
    <FloorCardShell v-model:expanded="expanded" :drawer-id="drawerId" caret :class="{ 'is-omit': omit }">
      <!-- 卡片头 = 锚点。首行「楼号 + 时间 + 标签」,次行摘要预览;展开后正文与可编辑的时间就在下方,两者都不再重复 -->
      <template #head>
        <span class="bbs-fp-head-top">
          <span class="bbs-fp-floor" :class="{ 'is-pending': !omit && !valid, 'is-omit': omit }">#{{ floor }}</span>
          <span v-if="timeLabel && !expanded" class="bbs-fp-head-time"><Icon name="clock" class="bbs-fp-head-icon" />{{ timeLabel }}</span>
          <span v-if="recallChip" class="bbs-fp-head-recall" :class="{ 'is-failed': recallChip.failed }" :title="recall?.statusText">{{ recallChip.text }}</span>
          <span v-if="openConflicts" class="bbs-fp-head-recall is-warn" title="本楼正文与已有记录不一致，展开查看">不一致 {{ openConflicts }}</span>
        </span>
        <span v-if="!expanded" class="bbs-fp-preview" :class="{ 'is-muted': previewMuted }">{{ previewText }}</span>
      </template>
      <template #actions>
        <IconButton
          class="bbs-fp-omitbtn"
          icon="sparkles"
          size="sm"
          label="标为番外"
          :pressed="omit"
          :title="omit ? '取消番外（恢复参与记忆）' : '标为番外（此楼不参与摘要、总结和注入）'"
          :disabled="busy || engineState.running"
          @click.stop="toggleOmit"
        />
        <IconButton
          class="bbs-fp-summarybtn"
          size="sm"
          :label="summaryActionTitle"
          :disabled="summaryActionDisabled"
          @click.stop="requestSummary"
        >
          <span v-if="summarizingHere" class="bbs-fp-spinner"></span>
          <Icon v-else :name="summaryIcon" />
        </IconButton>
      </template>

      <p v-if="omit" class="bbs-fp-note">此楼已标为番外，以下数据不参与记忆；取消番外即恢复。</p>
      <p v-else-if="importCovered" class="bbs-fp-note">此楼已由导入的旧总结覆盖，不单独摘要。需要逐楼摘要时，先在摘要页删除导入的旧总结。</p>
      <p v-else-if="frozen" class="bbs-fp-note">此楼的旧摘要没有记录分页，不能确定属于当前哪一页。这一页不摘要、不注入，也不覆盖旧摘要；翻回第一页即恢复。</p>

      <template v-if="leaf && !frozen">
        <!-- 时间 / 地点(可点编辑) -->
        <div class="bbs-fp-chips">
          <!-- 时间 -->
          <div v-if="editKey === 'time'" class="bbs-fp-editform">
            <label class="bbs-fp-nrow">
              <span class="bbs-fp-nlabel">起始</span>
              <textarea :ref="setFocus" v-model="edit.timeStart" rows="1" class="bbs-input bbs-fp-nfield" placeholder="如 1988/9/29 21:00" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
            </label>
            <label class="bbs-fp-nrow">
              <span class="bbs-fp-nlabel">结束</span>
              <textarea v-model="edit.timeEnd" rows="1" class="bbs-input bbs-fp-nfield" placeholder="留空则与起始相同" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
            </label>
            <div class="bbs-fp-editfoot">
              <span class="bbs-fp-editfoot-spacer"></span>
              <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">取消</button>
              <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveTime">保存</button>
            </div>
          </div>
          <button v-else-if="!omit" class="bbs-fp-chip is-btn" type="button" :aria-label="timeLabel ? `编辑时间：${timeLabel}` : undefined" @click="editTime">
            <Icon name="clock" class="bbs-fp-chip-icon" />{{ timeLabel || '设置时间' }}
          </button>
          <span v-else-if="timeLabel" class="bbs-fp-chip"><Icon name="clock" class="bbs-fp-chip-icon" />{{ timeLabel }}</span>

          <!-- 地点 -->
          <div v-if="editKey === 'loc'" class="bbs-fp-editform">
            <label class="bbs-fp-nrow">
              <span class="bbs-fp-nlabel">地点</span>
              <textarea :ref="setFocus" v-model="edit.location" rows="1" class="bbs-input bbs-fp-nfield" placeholder="当前地点" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
            </label>
            <div class="bbs-fp-editfoot">
              <span class="bbs-fp-editfoot-spacer"></span>
              <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">取消</button>
              <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveLoc">保存</button>
            </div>
          </div>
          <button
            v-else-if="!omit"
            class="bbs-fp-chip is-btn"
            :class="{ 'is-inherited': !ownLocation && inheritedLocation }"
            type="button"
            :title="!ownLocation && inheritedLocation ? `沿用 #${inheritedLocation.floor} 记录的地点，点击为本楼单独设置` : undefined"
            :aria-label="ownLocation ? `编辑地点：${ownLocation}` : inheritedLocation ? `设置地点，当前沿用 #${inheritedLocation.floor} 的地点：${inheritedLocation.text}` : undefined"
            @click="editLocation"
          >
            <Icon name="location" class="bbs-fp-chip-icon" />{{ ownLocation || inheritedLocation?.text || '设置地点' }}
          </button>
          <span v-else-if="ownLocation" class="bbs-fp-chip"><Icon name="location" class="bbs-fp-chip-icon" />{{ ownLocation }}</span>
        </div>

        <!-- 摘要正文:可编辑时整块是一个按钮(鼠标点按、键盘 Enter/空格都能进入编辑) -->
        <template v-if="editKey === 'text'">
          <div class="bbs-fp-texteditor">
            <textarea :ref="setFocus" v-model="edit.text" class="bbs-input bbs-fp-textarea" rows="3" aria-label="摘要正文" @input="onTextInput"></textarea>
            <div class="bbs-fp-editrow-actions">
              <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
              <button class="bbs-btn bbs-btn-primary" type="button" @click="saveText">保存</button>
            </div>
          </div>
        </template>
        <button
          v-else-if="!omit"
          class="bbs-summary-text bbs-fp-text is-btn"
          :class="{ 'is-muted': !leaf.text }"
          type="button"
          title="编辑摘要正文"
          @click="editText"
        >{{ leaf.text || '（无摘要正文，点击补写）' }}</button>
        <p v-else class="bbs-summary-text bbs-fp-text" :class="{ 'is-muted': !leaf.text }">{{ leaf.text || '（无摘要正文）' }}</p>
        <p v-if="leaf.lite && !omit && !hasAnyDelta" class="bbs-fp-note">此楼摘要在批量补摘时与相邻楼层合并生成，只有摘要和时间，未记录状态变动。</p>

        <!-- 变动分组:点一条就地编辑(可编辑类)或展开删除 -->
        <DeltaGroups v-if="hasTags" :groups="groups" :omit="omit" />
      </template>

      <p v-else-if="!importCovered && !frozen" class="bbs-summary-text bbs-fp-text is-muted">此楼尚无摘要。</p>

      <!-- 生成本楼摘要时没写入的更新:最后一次尝试中不符合要求而去掉,原记录保持不变 -->
      <FloorDropped v-if="dropped.length" :dropped="dropped" />

      <!-- 正文与记录不一致:摘要时标出,记录保持原样;可提醒正文模型或忽略 -->
      <FloorConflicts v-if="conflicts.length" :floor="floor" :conflicts="conflicts" />

      <!-- 生成本楼前的召回 -->
      <FloorRecall v-if="recall" :recall="recall" />

      <!-- 页脚:生成 / 重新生成摘要;删除摘要(行内两步确认:每楼是独立的 shadow,没有弹窗宿主,行内确认更可靠) -->
      <div v-if="!omit && !importCovered && !frozen" class="bbs-fp-footer">
        <div class="bbs-fp-footer-actions">
          <template v-if="confirmingDelete">
            <span class="bbs-fp-confirm-text">删除此楼摘要？</span>
            <button class="bbs-btn bbs-btn-sm bbs-fp-confirm-cancel" type="button" :disabled="busy" @click="cancelDelete">取消</button>
            <button class="bbs-fp-confirm-ok" type="button" :disabled="busy" @click="removeLeaf">
              <Icon name="trash" />删除
            </button>
          </template>
          <template v-else>
            <button class="bbs-btn bbs-btn-sm bbs-fp-regen" type="button" :disabled="summaryActionDisabled" @click="requestSummary">
              <span v-if="summarizingHere" class="bbs-fp-spinner"></span><Icon v-else :name="summaryIcon" />{{ summaryActionText }}
            </button>
            <button v-if="leaf" class="bbs-fp-delleaf" type="button" title="删除此楼摘要" :disabled="busy" @click="askDelete">
              <Icon name="trash" />删除摘要
            </button>
          </template>
        </div>
      </div>
    </FloorCardShell>

    <ConfirmDialog
      v-model:open="regenerateConfirmOpen"
      :title="`重新摘要楼层 #${floor}`"
      confirmText="生成新摘要"
      confirmIcon="refresh"
      :busy="summarizingHere"
      busyText="生成中…"
      @confirm="confirmRegenerate"
    >
      先生成新摘要并与现有摘要并排对比；选择「用新的」时替换，选择「保留现在的」时不修改。生成需请求一次 AI。
      <template v-if="migrationSeed">这一楼的摘要带有从 Horae 迁移来的物品、计划等最终状态（早先版本迁移时写在摘要里），换成新摘要后这些状态会被替换，需要时可在物品、计划页手动补回。</template>
    </ConfirmDialog>
    <RegenerateCompare :preview="comparePreview" :busy="applyingPreview" @keep="keepCurrentSummary" @replace="useNewSummary" />
  </div>
</template>

<style scoped src="./floor/editForm.css"></style>
<style scoped>
.bbs-fp {
  margin: 6px 0 2px;
}
/* 番外:虚线边框 + 左侧中性竖线表示「不计入记忆」。不降整体透明度,文字对比度不受影响 */
.bbs-fp-card.is-omit {
  border-style: dashed;
  border-left: 3px solid var(--bbs-ink-muted);
}

/* 卡片头首行:楼号 + 时间 + 小标签 */
.bbs-fp-head-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bbs-fp-head-time {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
.bbs-fp-head-icon {
  margin-right: 4px;
}
/* 头部小标签(召回、不一致):时间之后的小描边签,空间不够时时间先省略 */
.bbs-fp-head-recall {
  flex: 0 0 auto;
  padding: 0 7px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-pill);
  font-size: var(--bbs-fs-badge);
  line-height: 18px;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
}
.bbs-fp-head-recall.is-failed {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
}
.bbs-fp-head-recall.is-warn {
  color: var(--bbs-warning);
  border-color: var(--bbs-warning);
}
/* 楼号做成药丸,与主界面摘要卡的 #楼层 标签同款——面板一眼就与主界面同源 */
.bbs-fp-floor {
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-accent);
  background: var(--bbs-accent-soft);
  font-family: var(--bbs-font-mono);
  font-size: var(--bbs-fs-badge);
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
/* 待摘/番外:退成中性描边,不抢强调色 */
.bbs-fp-floor.is-pending,
.bbs-fp-floor.is-omit {
  color: var(--bbs-ink-muted);
  border-color: var(--bbs-line);
  background: var(--bbs-surface-2);
}
.bbs-fp-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--bbs-fs-sm);
  color: var(--bbs-ink-soft);
}
.bbs-fp-preview.is-muted {
  color: var(--bbs-ink-muted);
  font-style: italic;
}
/* 单楼摘要键生成中的旋转环(放在 IconButton 的插槽里) */
.bbs-fp-spinner {
  width: 13px;
  height: 13px;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: bbs-fp-spin 0.7s linear infinite;
}
@keyframes bbs-fp-spin {
  to { transform: rotate(360deg); }
}

.bbs-fp-note {
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
  font-size: var(--bbs-fs-meta);
  line-height: 1.6;
  text-wrap: pretty;
}

/* 时间/地点 */
.bbs-fp-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.bbs-fp-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  min-height: 26px;
  padding: 3px 11px;
  border-radius: var(--bbs-radius-pill);
  border: 1px solid transparent;
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: var(--bbs-fs-meta);
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  overflow-wrap: anywhere;
}
.bbs-fp-chip-icon {
  flex: 0 0 auto;
  font-size: 13px;
}
.bbs-fp-chip.is-btn {
  min-height: var(--bbs-control-h-sm);
  cursor: pointer;
  transition: border-color var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-chip.is-btn:hover {
  border-color: var(--bbs-accent);
}
/* 沿用之前记录的地点:浅底、次要色,与本楼记录的地点区分 */
.bbs-fp-chip.is-inherited {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
}

/* 正文:只读块与编辑 textarea 共用同一盒模型(消除切换跳动)。
   关键——两者 font-size / line-height / padding / border 必须完全一致,只差背景/可编辑。 */
.bbs-fp-text,
.bbs-fp-textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 9px 11px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  line-height: 1.75;
  letter-spacing: 0.02em;
  color: var(--bbs-ink);
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
}
/* 只读态:抬起面(surface)像一枚静置的字段浮在 bg 外层卡上,悬停点亮强调边提示「可编辑」 */
.bbs-fp-text {
  background: var(--bbs-surface);
}
.bbs-fp-text.is-muted {
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-fp-text.is-btn {
  cursor: text;
  transition: border-color var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-text.is-btn:hover {
  border-color: var(--bbs-accent);
}

/* 正文编辑器:textarea 盒模型已与只读块统一(见上「正文」块),这里只加可拉伸 + 去掉底距(编辑器容器管间距) */
.bbs-fp-texteditor {
  margin-bottom: 10px;
}
.bbs-fp-textarea {
  resize: vertical;
  margin: 0;
  /* autosize 用 JS 按 scrollHeight 设高;隐藏滚动条避免拉高瞬间闪现,给个下限防空文本过扁 */
  min-height: 64px;
  overflow: hidden;
}
.bbs-fp-editrow-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

/* 页脚:生成 / 重新生成摘要与删除摘要 */
.bbs-fp-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--bbs-line);
}
.bbs-fp-footer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 删除入口:平时只是一枚安静的图标+字,靠右不抢眼;hover 才浮现危险色 */
.bbs-fp-delleaf {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: var(--bbs-control-h-sm);
  padding: 5px 10px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: var(--bbs-fs-meta);
  cursor: pointer;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-delleaf:hover:not(:disabled) {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-fp-delleaf:disabled {
  opacity: 0.55;
}
/* 两步确认:提示文字 + 取消(通用小按钮)+ 删除(危险色实心,文字色随主题) */
.bbs-fp-confirm-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--bbs-fs-meta);
  color: var(--bbs-ink-soft);
}
.bbs-fp-confirm-cancel {
  flex: 0 0 auto;
}
.bbs-fp-confirm-ok {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: var(--bbs-control-h-sm);
  padding: 5px 12px;
  border: 1px solid var(--bbs-danger);
  border-radius: 9px;
  background: var(--bbs-danger);
  /* 危险色上的文字色随主题:夜间危险色较浅,用深色字 */
  color: var(--bbs-danger-ink);
  font-size: var(--bbs-fs-meta);
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-confirm-ok:hover:not(:disabled) {
  opacity: 0.9;
}
.bbs-fp-confirm-ok:disabled {
  opacity: 0.55;
}

/* 手机与触屏:可点的标签和页脚按钮加高到 40px */
@media (max-width: 640px), (pointer: coarse) {
  .bbs-fp-chip.is-btn,
  .bbs-fp-delleaf,
  .bbs-fp-confirm-ok {
    min-height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bbs-fp-spinner {
    animation-duration: 1.4s;
  }
}
</style>
