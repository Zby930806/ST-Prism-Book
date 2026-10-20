<script setup lang="ts">
import EmptyState from '@/components/EmptyState.vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import PageHeader from '@/components/PageHeader.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalShell from '@/components/ModalShell.vue';
import StatRow from '@/components/StatRow.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { buildSceneLocationIndex, editSceneDesc, findCurrentSceneId, removeScene, reparentScene, resolveSceneLocationId, sceneId, upsertScene } from '@/memory/apply';
import { buildTravelDraft } from '@/memory/inject';
import { derivedMeta, memory } from '@/memory/store';
import { closeBook } from '@/state/ui';
import { appendChatInput, getContext } from '@/st/context';
import { toast } from '@/st/toast';
import type { MemItem, MemScene } from '@/memory/types';
import { computed, nextTick, ref, watch } from 'vue';

// 场景是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* —— 折叠状态:纯本机 UI 态,按聊天分桶存 localStorage(切走再回保持) —— */
const COLLAPSE_KEY = 'bbs.scenes.collapsed.v1';
function chatKey(): string {
  return getContext()?.getCurrentChatId?.() || '_';
}
function loadCollapsed(): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    return new Set<string>(Array.isArray(all[chatKey()]) ? all[chatKey()] : []);
  } catch {
    return new Set();
  }
}
// 折叠的节点 id 集合(响应式);默认全展开
const collapsed = ref<Set<string>>(loadCollapsed());
function persistCollapsed() {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    all[chatKey()] = [...collapsed.value];
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时静默 */
  }
}
function toggleCollapse(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next; // 换引用触发响应式
  persistCollapsed();
}

/* —— 把扁平 scenes 按 parentId 组装成嵌套树,深度优先展平成带 depth 的可渲染行 —— */
interface SceneRow {
  node: MemScene;
  depth: number;
  /** 该行是否在「当前所在」的祖先脉络上(根→当前地点) */
  onCurrentPath: boolean;
  /** 是否就是当前所在地点本身 */
  isCurrent: boolean;
  /** 同级里是否最后一个(画引导线收尾用) */
  lastChild: boolean;
  /** 是否有子节点(决定是否显示折叠箭头) */
  hasChildren: boolean;
  /** 当前是否处于折叠态(子树已收起) */
  isCollapsed: boolean;
}

// 当前所在节点:与注入端共用 apply.findCurrentSceneId(优先权威 locationPath,否则收紧模糊匹配)。
// 单一来源,保证场景页高亮 = 提示词里「当前所在」链,不再分叉。
const currentId = computed(() =>
  findCurrentSceneId(memory.scenes, memory.state.location || '', memory.state.locationPath),
);

// 仅调整本机树视图，不改地点数据或当前位置。
const currentScene = computed(() => memory.scenes.find(scene => scene.id === currentId.value));
function setAllCollapsed(value: boolean) {
  collapsed.value = value ? new Set(memory.scenes.map(scene => scene.parentId).filter(Boolean)) : new Set();
  persistCollapsed();
}

// 当前所在的祖先脉络(含自身)id 集合
const currentChain = computed(() => {
  const ids = new Set<string>();
  const byId = new Map(memory.scenes.map(s => [s.id, s]));
  let cur = byId.get(currentId.value);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    ids.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return ids;
});

// 所在地点变化时,自动展开新脉络一次(避免「我在哪」被折叠藏起);但只在 currentId 真的
// 变了时触发,之后用户仍能手动折叠该脉络——这正是和旧「强制展开」的关键区别。
watch(
  () => currentId.value,
  () => {
    const next = new Set(collapsed.value);
    let changed = false;
    for (const cid of currentChain.value) {
      if (next.delete(cid)) changed = true;
    }
    if (changed) {
      collapsed.value = next;
      persistCollapsed();
    }
  },
);

const rows = computed<SceneRow[]>(() => {
  const byParent = new Map<string, MemScene[]>();
  for (const s of memory.scenes) {
    const arr = byParent.get(s.parentId) ?? [];
    arr.push(s);
    byParent.set(s.parentId, arr);
  }
  for (const arr of byParent.values()) {
    // 同级:当前脉络上的排前(让活动主干稳定靠上),再按创建序
    arr.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }
  const out: SceneRow[] = [];
  const walk = (parentId: string, depth: number) => {
    const children = byParent.get(parentId) ?? [];
    children.forEach((node, i) => {
      const kids = byParent.get(node.id) ?? [];
      // onCurrentPath 仅用于主干线高亮;折叠完全由用户的 collapsed 决定(不再强制展开,
      // 否则「所在」脉络上的行点了收不起来)。脉络变化时由 watch 自动展开一次,见下方。
      const onCurrentPath = currentChain.value.has(node.id);
      const isCollapsed = kids.length > 0 && collapsed.value.has(node.id);
      out.push({
        node,
        depth,
        onCurrentPath,
        isCurrent: node.id === currentId.value,
        lastChild: i === children.length - 1,
        hasChildren: kids.length > 0,
        isCollapsed,
      });
      if (!isCollapsed) walk(node.id, depth + 1); // 折叠则跳过整段子树
    });
  };
  walk('', 0); // 根 = parentId 为空
  return out;
});

// 存放在某地点的物品:先解析到唯一 sceneId,避免子地点误挂到所有祖先/旁支。
const sceneItems = computed(() => {
  const index = buildSceneLocationIndex(memory.scenes);
  const out = new Map<string, MemItem[]>();
  for (const item of memory.items) {
    if (item.carried !== false || !item.location) continue;
    const sceneId = resolveSceneLocationId(memory.scenes, item.location, index);
    if (!sceneId) continue;
    const arr = out.get(sceneId) ?? [];
    arr.push(item);
    out.set(sceneId, arr);
  }
  return out;
});

function itemsAt(node: MemScene) {
  return sceneItems.value.get(node.id) ?? [];
}

// 折叠时展示的后代地点数(整段子树,id 前缀匹配)
function childCount(node: MemScene): string {
  const prefix = `${node.id}/`;
  const n = memory.scenes.filter(s => s.id.startsWith(prefix)).length;
  return n ? `+${n}` : '';
}

/** 上级地点下拉选项:全部节点按完整路径排序(父先于子),depth 决定缩进前缀。不受折叠影响。 */
const sceneOptions = computed(() =>
  [...memory.scenes]
    .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')))
    .map(s => ({ id: s.id, name: s.name, depth: s.path.length - 1 })),
);

/** 转成 BbsSelect 选项:层级仍用全角空格缩进(自绘菜单里同样保留前导空白,不像 HTML 会折叠) */
function parentOptions(list: { id: string; name: string; depth: number }[]) {
  return [
    { value: '', label: '（顶级地点）' },
    ...list.map(o => ({ value: o.id, label: '　'.repeat(o.depth) + o.name })),
  ];
}

/* —— 新增地点(弹窗):选上级(已有路径 / 顶级)+ 填新名 + 描述 —— */
const composerOpen = ref(false);
const newParentId = ref(''); // 选中的上级 id;'' = 顶级
const newName = ref('');
const newDesc = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

function openComposer() {
  if (!hasLeaf.value) return;
  newParentId.value = currentId.value || ''; // 默认挂在当前所在地点下,顺手
  newName.value = '';
  newDesc.value = '';
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addScene() {
  const name = newName.value.trim();
  // 描述必填:写不出描述的地点不记(与 AI 同规则)
  if (!name || !newDesc.value.trim()) return;
  const parent = memory.scenes.find(s => s.id === newParentId.value);
  const path = parent ? [...parent.path, name] : [name];
  if (memory.scenes.some(s => s.id === sceneId(path))) {
    toast(`地点「${path.join(' › ')}」已经存在，请直接编辑原地点。`, 'warning');
    return;
  }
  if (!upsertScene(path, newDesc.value)) {
    toast('无法保存地点，请确认当前聊天已有有效摘要。', 'error');
    return;
  }
  composerOpen.value = false;
}
// 名字框按 Enter 添加。取消这次 Enter 的默认动作：添加后弹窗关闭、焦点回到「添加地点」按钮，否则同一次 Enter 会把弹窗再次打开。
function onNameEnter(e: KeyboardEvent) {
  e.preventDefault();
  addScene();
}

/* —— 编辑弹窗:改本级名 + 上级(下拉选)+ 描述 —— */
interface SceneEditing {
  id: string; // 原始节点 id
  path: string[]; // 原始完整路径
  name: string;
  parentId: string; // 选中的上级 id;'' = 顶级
  desc: string;
}
const editing = ref<SceneEditing | null>(null);

function openEdit(node: MemScene) {
  editing.value = {
    id: node.id,
    path: node.path,
    name: node.name,
    parentId: node.parentId,
    desc: node.desc ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}

/** 编辑态下的可选上级:排除节点自身及其后代(否则会把节点变成自己的祖先,成环)。 */
const editParentOptions = computed(() => {
  const e = editing.value;
  if (!e) return sceneOptions.value;
  const selfPrefix = `${e.id}/`;
  return sceneOptions.value.filter(o => o.id !== e.id && !o.id.startsWith(selfPrefix));
});

function saveEdit() {
  const e = editing.value;
  const name = e?.name.trim();
  if (!e || !name || !e.desc.trim()) return; // 描述必填
  const parent = memory.scenes.find(s => s.id === e.parentId);
  const newPath = parent ? [...parent.path, name] : [name];
  const pathChanged = sceneId(newPath) !== sceneId(e.path);

  let saved = false;
  if (pathChanged) {
    if (memory.scenes.some(s => s.id === sceneId(newPath))) {
      toast(`地点「${newPath.join(' › ')}」已经存在，不能覆盖或合并。`, 'warning');
      return;
    }
    // 换父 / 改名 / 插层:一条 reparent 原子完成,连子树平移 + 顺带写新名描述
    saved = reparentScene(e.path, newPath, { [name]: e.desc.trim() });
  } else {
    saved = editSceneDesc(e.path, e.desc);
  }
  if (!saved) {
    toast('无法保存地点，请确认当前聊天已有有效摘要。', 'error');
    return;
  }
  editing.value = null;
}

/* —— 删除确认(连带子级)—— */
const removing = ref<MemScene | null>(null);
function askRemove(node: MemScene) {
  removing.value = node;
}
function confirmRemove() {
  if (removing.value) removeScene(removing.value.path);
  removing.value = null;
}
const removeChildCount = computed(() => {
  const n = removing.value;
  if (!n) return 0;
  const prefix = `${n.id}/`;
  return memory.scenes.filter(s => s.id.startsWith(prefix)).length;
});

/* —— 前往地点:只生成草稿,不提前修改派生状态 —— */
const traveling = ref<MemScene | null>(null);
function askTravel(node: MemScene) {
  traveling.value = node;
}
function confirmTravel() {
  const target = traveling.value;
  if (!target) return;
  if (!appendChatInput(buildTravelDraft(target))) {
    toast('无法写入酒馆输入框。', 'error');
    return;
  }
  traveling.value = null;
  closeBook();
  toast('前往地点草稿已填入输入框', 'success');
}
</script>

<template>
  <section class="bbs-page bbs-ledger">
    <PageHeader icon="scenes" title="场景" description="故事中出现过的地点，按上下级排列；标有「所在」的为当前位置。">
      <template #actions>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf"
          :title="hasLeaf ? '手动添加地点' : '需先有摘要才能手动添加'" @click="openComposer"><Icon name="plus" />添加地点</button>
      </template>
    </PageHeader>
    <SummaryOnlyNotice subject="地点、场景层级与当前位置" />
    <div class="bbs-current-location">
      <span class="bbs-current-icon"><Icon name="scenes" /></span>
      <div><span class="bbs-current-label">当前所在</span><p>{{ currentScene ? currentScene.path.join(' › ') : memory.state.location || '尚未记录当前位置' }}</p></div>
    </div>
    <StatRow
      label="地点概览"
      :items="[{ value: memory.scenes.length, label: '个地点' }]"
      :note="rows.length < memory.scenes.length ? '展示 ' + rows.length + ' 个' : undefined"
    >
      <template v-if="memory.scenes.length" #aside>
        <button class="bbs-btn bbs-btn-sm" type="button" @click="setAllCollapsed(false)">全部展开</button>
        <button class="bbs-btn bbs-btn-sm" type="button" @click="setAllCollapsed(true)">收起层级</button>
      </template>
    </StatRow>
    <p v-if="!hasLeaf" class="bbs-scene-hint">生成第一条摘要后可手动添加地点。</p>

    <TransitionGroup v-if="rows.length" tag="div" name="scene" class="bbs-scene-tree">
      <div
        v-for="r in rows"
        :key="r.node.id"
        class="bbs-scene-row"
        :class="{ 'is-current': r.isCurrent, 'on-path': r.onCurrentPath }"
        :style="{ '--depth': r.depth }"
      >
        <!-- 最多四条引导轨，避免极深层级挤出窄屏；完整路径始终在内容区呈现。 -->
        <span v-for="d in Math.min(r.depth, 4)" :key="d" class="bbs-scene-rail" :class="{ active: r.onCurrentPath && d <= r.depth }"></span>

        <!-- 有子节点的整张卡片可点折叠(含描述/物品区);叶子卡不可点。操作按钮 @click.stop 不触发 -->
        <div
          class="bbs-scene-card"
          :class="{ clickable: r.hasChildren }"
          @click="r.hasChildren && toggleCollapse(r.node.id)"
        >
          <div class="bbs-scene-head">
            <button
              v-if="r.hasChildren"
              class="bbs-scene-toggle"
              :class="{ collapsed: r.isCollapsed }"
              type="button"
              :aria-expanded="!r.isCollapsed"
              :aria-label="(r.isCollapsed ? '展开下属地点：' : '收起下属地点：') + r.node.name"
              :title="r.isCollapsed ? '展开下属地点' : '收起下属地点'"
              @click.stop="toggleCollapse(r.node.id)"
            ><Icon name="chevron" /></button>
            <span class="bbs-scene-name">{{ r.node.name }}</span>
            <span v-if="r.isCurrent" class="bbs-scene-here"><Icon name="scenes" />所在</span>
            <span v-else-if="r.isCollapsed" class="bbs-scene-count">{{ childCount(r.node) }}</span>

          </div>
          <p v-if="r.depth" class="bbs-scene-path">{{ r.node.path.join(' › ') }}</p>
          <p v-if="r.node.desc" class="bbs-scene-desc">{{ r.node.desc }}</p>
          <div v-if="itemsAt(r.node).length" class="bbs-scene-items">
            <span v-for="it in itemsAt(r.node)" :key="it.id" class="bbs-scene-chip">
              <Icon name="items" />{{ it.name }}<i v-if="typeof it.qty === 'number'">×{{ it.qty }}</i>
            </span>
          </div>
          <div class="bbs-scene-acts">
            <button v-if="!r.isCurrent" class="bbs-btn bbs-btn-sm" type="button" :aria-label="'前往：' + r.node.name" @click.stop="askTravel(r.node)"><Icon name="navigate" />前往</button>
            <IconButton icon="edit" :label="'编辑地点：' + r.node.name" title="编辑" @click.stop="openEdit(r.node)" />
            <IconButton icon="trash" tone="danger" :label="'删除地点：' + r.node.name" title="删除" @click.stop="askRemove(r.node)" />
          </div>
        </div>
      </div>
    </TransitionGroup>

    <EmptyState v-else icon="scenes" title="暂无地点" :text="'摘要记录到访过的地点，并按上下级整理。' + (hasLeaf ? '也可手动添加。' : '生成第一条摘要后可手动添加。')">
      <button v-if="hasLeaf" class="bbs-btn" type="button" @click="openComposer"><Icon name="plus" />添加第一处地点</button>
    </EmptyState>

    <!-- 添加弹窗:选上级(已有地点 / 顶级)+ 填新名 + 描述 -->
    <ModalShell :open="composerOpen" title="添加地点" @close="closeComposer">
      <div class="bbs-modal-field">
        <span class="bbs-modal-label">上级地点（从已有地点中选择，或设为顶级）</span>
        <BbsSelect v-model="newParentId" :options="parentOptions(sceneOptions)" aria-label="上级地点" />
      </div>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">名称</span>
        <input ref="nameInput" v-model="newName" class="bbs-input" type="text" placeholder="新地点名" @keydown.enter="onNameEnter" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">描述（必填）</span>
        <textarea v-model="newDesc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="地点的性质与特征"></textarea>
      </label>
      <template #footer>
        <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newName.trim() || !newDesc.trim()" @click="addScene">添加</button>
      </template>
    </ModalShell>

    <!-- 编辑弹窗:Teleport 出滚动容器,见 ModalMask -->
    <ModalShell :open="!!editing" title="编辑地点" @close="cancelEdit">
      <template v-if="editing">
        <p class="bbs-scene-crumb">{{ editing.path.join(' › ') }}</p>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名称</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="地点名" />
        </label>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">上级地点（修改后下属地点一并移动）</span>
          <BbsSelect v-model="editing.parentId" :options="parentOptions(editParentOptions)" aria-label="上级地点" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">描述（必填）</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="地点的性质与特征"></textarea>
        </label>
      </template>
      <template #footer>
        <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
        <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing?.name.trim() || !editing?.desc.trim()" @click="saveEdit">保存</button>
      </template>
    </ModalShell>

    <ConfirmDialog
      :open="!!traveling"
      title="前往地点"
      confirm-text="填入输入框"
      confirm-icon="navigate"
      @update:open="v => { if (!v) traveling = null; }"
      @confirm="confirmTravel"
      @cancel="traveling = null"
    >
      前往「{{ traveling?.path.join(' › ') }}」？在输入框中填入前往该地点的草稿，不自动发送，不修改记忆；输入框已有内容时追加在其后。
    </ConfirmDialog>

    <ConfirmDialog
      :open="!!removing"
      title="删除地点"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      删除「{{ removing?.name }}」<template v-if="removeChildCount">及其下属的 {{ removeChildCount }} 个地点</template>？删除操作记录在最新一条摘要上，删除该楼层可恢复。
    </ConfirmDialog>
  </section>
</template>

<style scoped>

/* 页面外壳（统计行、搜索、筛选、图标按钮、空状态）在 base.css 的 .bbs-ledger 中统一定义。 */

.bbs-current-location { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding: 16px 0 16px 14px; border-left: 3px solid var(--bbs-accent); }
.bbs-current-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 36px; height: 36px; border-radius: 12px; background: var(--bbs-accent-soft); color: var(--bbs-accent); font-size: 19px; }
.bbs-current-location > div { min-width: 0; }
.bbs-current-label { font-size: 11px; letter-spacing: .06em; color: var(--bbs-ink-muted); }
.bbs-current-location p { margin: 5px 0 0; font-size: 15px; font-weight: 600; line-height: 1.7; overflow-wrap: anywhere; }
.bbs-scene-hint { margin: 0 0 12px; font-size: 12px; line-height: 1.7; color: var(--bbs-ink-muted); }
.bbs-scene-tree { display: flex; flex-direction: column; gap: 12px; position: relative; min-width: 0; }
.bbs-scene-row { display: flex; align-items: stretch; min-width: 0; }
.bbs-scene-rail { flex: 0 0 16px; position: relative; }
.bbs-scene-rail::before { content: ''; position: absolute; left: 6px; top: -12px; bottom: -12px; width: 1px; background: var(--bbs-line); }
.bbs-scene-rail.active::before { background: var(--bbs-accent); }
.bbs-scene-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; align-content: start; flex: 1 1 auto; min-width: 0; padding: 16px; border: 1px solid var(--bbs-line); border-radius: 14px; background: var(--bbs-surface); box-shadow: var(--bbs-card-shadow); }
.bbs-scene-card.clickable { cursor: pointer; }
.bbs-scene-card.clickable:hover { border-color: var(--bbs-line-strong); }
.bbs-scene-row.is-current .bbs-scene-card { border-color: var(--bbs-accent); background: var(--bbs-accent-soft); }
.bbs-scene-card > * { grid-column: 1 / -1; }
.bbs-scene-card > .bbs-scene-head { grid-column: 1; }
.bbs-scene-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.bbs-scene-toggle { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 var(--bbs-icon-btn); height: var(--bbs-icon-btn); padding: 0; border: 1px solid var(--bbs-line); border-radius: 8px; background: var(--bbs-surface); color: var(--bbs-accent); cursor: pointer; transition: transform .16s ease; }
.bbs-scene-toggle.collapsed { transform: rotate(-90deg); }
.bbs-scene-name { flex: 1; min-width: 0; font-size: 15px; line-height: 1.6; font-weight: 650; overflow-wrap: anywhere; }
.bbs-scene-count { flex-shrink: 0; font-size: 11px; color: var(--bbs-ink-muted); padding: 3px 7px; border-radius: 6px; background: var(--bbs-surface-2); }
.bbs-scene-here { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 6px; background: var(--bbs-accent); color: var(--bbs-accent-ink); font-size: 11px; }
.bbs-scene-path, .bbs-scene-crumb { margin: 7px 0 0; font-size: 11px; line-height: 1.7; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
.bbs-scene-desc { margin: 10px 0 0; font-size: 13px; line-height: 1.85; color: var(--bbs-ink-soft); overflow-wrap: anywhere; white-space: pre-wrap; }
.bbs-scene-items { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.bbs-scene-chip { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; max-width: 100%; padding: 4px 8px; border-radius: 7px; background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-size: 11px; overflow-wrap: anywhere; }
.bbs-scene-chip i { font-style: normal; color: var(--bbs-accent); }
.bbs-scene-card > .bbs-scene-acts { grid-column: 2; grid-row: 1; }
.bbs-scene-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px; }
.scene-enter-active, .scene-leave-active { transition: opacity .16s ease, transform .16s ease; }
.scene-enter-from, .scene-leave-to { opacity: 0; transform: translateY(-6px); }
.scene-leave-active { position: absolute; width: 100%; }
.scene-move { transition: transform .16s ease; }
@media (max-width: 480px) {
  .bbs-current-location { padding-left: 10px; gap: 9px; }
  .bbs-scene-rail { flex-basis: 8px; }
  .bbs-scene-rail::before { left: 2px; }
  .bbs-scene-card { padding: 12px 10px; }
  /* 窄屏动作键放在卡片末尾、靠右，不再与名字抢一行。 */
  .bbs-scene-card > .bbs-scene-acts { grid-column: 1 / -1; grid-row: auto; margin-top: 8px; }
}
@media (prefers-reduced-motion: reduce) { .scene-enter-active, .scene-leave-active, .scene-move, .bbs-scene-toggle { transition: none; } }
</style>
