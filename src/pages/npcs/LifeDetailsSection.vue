<script setup lang="ts">
/**
 * 生活小档案：主角与主要角色的偏好、习惯、近况。三个投放层：置顶常驻、时效/长期按相关性浮现、沉降仅关键词触发。
 * 列表顺序为置顶 → 时效/长期 → 沉降，层级差异由条目样式表达（置顶左缘警告色、沉降虚线）。
 * 置顶、沉降是开关按钮（aria-pressed），名称固定，按下样式表示已开启。
 * 折叠状态是本机视图偏好，存 localStorage（bbs.ui.lifeCollapsed.v1），默认展开。
 */
import { apiSettings } from '@/api/settings';
import BbsSelect from '@/components/BbsSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import IconButton from '@/components/IconButton.vue';
import ModalShell from '@/components/ModalShell.vue';
import { addLifeDetail, removeLifeDetail, updateLifeDetail } from '@/memory/apply';
import { fmtLifeDetail, lifeDetailSubject } from '@/memory/lifeDetails';
import { memory } from '@/memory/store';
import type { MemLifeDetail } from '@/memory/types';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';
import NpcEntry from './NpcEntry.vue';
import NpcFoldSection from './NpcFoldSection.vue';
import { labelSnippet, loadCollapsed, persistCollapsed } from './npcView';

const props = defineProps<{ protagonistName: string; hasLeaf: boolean }>();

const lifeGroups = computed(() => {
  const pinned: MemLifeDetail[] = [];
  const active: MemLifeDetail[] = [];
  const archive: MemLifeDetail[] = [];
  for (const d of memory.lifeDetails) {
    (d.tier === 'pinned' ? pinned : d.tier === 'archive' ? archive : active).push(d);
  }
  return { pinned, active, archive };
});
const lifeList = computed(() => [...lifeGroups.value.pinned, ...lifeGroups.value.active, ...lifeGroups.value.archive]);

const COLLAPSE_KEY = 'bbs.ui.lifeCollapsed.v1';
const collapsed = ref(loadCollapsed(COLLAPSE_KEY, false));
// 无条目即无可折叠:不显示箭头,也强制展开(避免删空后卡在收拢的空态)
const foldable = computed(() => memory.lifeDetails.length > 0);
function toggleFold() {
  collapsed.value = !collapsed.value;
  persistCollapsed(COLLAPSE_KEY, collapsed.value);
}

const PIN_CAP = 5;
function togglePin(d: MemLifeDetail) {
  if (d.tier === 'pinned') {
    updateLifeDetail(d.id, { tier: 'active' });
    return;
  }
  if (lifeGroups.value.pinned.length >= PIN_CAP) {
    toast(`置顶最多 ${PIN_CAP} 条，请先取消一条。`, 'warning');
    return;
  }
  updateLifeDetail(d.id, { tier: 'pinned' });
}
function toggleArchive(d: MemLifeDetail) {
  updateLifeDetail(d.id, { tier: d.tier === 'archive' ? 'active' : 'archive' });
}
const removing = ref<MemLifeDetail | null>(null);
function remove(d: MemLifeDetail) {
  removing.value = d;
}
function confirmRemove() {
  if (removing.value) removeLifeDetail(removing.value.id);
  removing.value = null;
}

/* 添加/编辑弹窗 */
const editing = ref<{ id: string | null; subject: string; text: string; topics: string; anchors: string; until: string } | null>(null);
const subjectOptions = computed(() => [
  { value: 'user', label: `主角 · ${props.protagonistName}` },
  // 保留已删除/改名角色的历史归属选项,打开编辑不能悄悄改成 user。
  ...[...new Set([...memory.npcs.map(n => n.name), ...memory.lifeDetails.map(lifeDetailSubject)])]
    .filter(name => name !== 'user').map(name => ({ value: name, label: name })),
]);
function openComposer() {
  editing.value = { id: null, subject: 'user', text: '', topics: '', anchors: '', until: '' };
}
function openEdit(d: MemLifeDetail) {
  editing.value = { id: d.id, subject: lifeDetailSubject(d), text: d.text, topics: d.topics.join('/'), anchors: d.anchors.join('/'), until: d.until ?? '' };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.text.trim()) return;
  const topics = e.topics.split(/[\/、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
  const anchors = e.anchors.split(/[\/、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  const until = e.until.trim();
  const ok = e.id
    ? updateLifeDetail(e.id, { subject: e.subject, text: e.text.trim(), topics, anchors, until })
    : addLifeDetail({ subject: e.subject, text: e.text.trim(), topics, anchors, until: until || undefined });
  if (ok) editing.value = null;
}
</script>

<template>
  <NpcFoldSection
    title="生活小档案"
    :count="memory.lifeDetails.length"
    :foldable="foldable"
    :collapsed="collapsed"
    :warning="apiSettings.summaryOnlyMode ? '仅供棱镜宝书记录，不发送给主对话 AI' : undefined"
    empty-hint="摘要记录主角与主要角色明确提到的偏好、习惯和近况。"
    :note="apiSettings.summaryOnlyMode ? undefined : '置顶条目始终发送；时效与长期条目按相关性发送；沉降条目仅在出现关键词时发送。'"
    @toggle="toggleFold"
  >
    <template #actions>
      <IconButton
        icon="plus"
        class="bbs-life-add"
        label="添加生活细节"
        :title="hasLeaf ? '添加生活细节' : '需先有摘要才能手动添加'"
        :disabled="!hasLeaf"
        @click="openComposer"
      />
    </template>
    <div class="bbs-life-group">
      <NpcEntry
        v-for="d in lifeList"
        :key="d.id"
        :text="fmtLifeDetail(d, protagonistName)"
        :tag="d.topics.length ? d.topics.join(' / ') : undefined"
        :until="d.until"
        :variant="d.tier"
      >
        <template #actions>
          <IconButton
            icon="pin"
            :pressed="d.tier === 'pinned'"
            :label="'置顶：' + labelSnippet(d.text)"
            :title="d.tier === 'pinned' ? '取消置顶' : '置顶（始终发送，最多 5 条）'"
            @click="togglePin(d)"
          />
          <IconButton
            icon="archive"
            :pressed="d.tier === 'archive'"
            :label="'沉降：' + labelSnippet(d.text)"
            :title="d.tier === 'archive' ? '取消沉降' : '沉降（仅在出现关键词时发送）'"
            @click="toggleArchive(d)"
          />
          <IconButton icon="edit" :label="'编辑生活细节：' + labelSnippet(d.text)" title="编辑" @click="openEdit(d)" />
          <IconButton icon="trash" tone="danger" :label="'删除生活细节：' + labelSnippet(d.text)" title="删除" @click="remove(d)" />
        </template>
      </NpcEntry>
    </div>
  </NpcFoldSection>

  <ConfirmDialog
    :open="!!removing"
    title="删除生活细节"
    tone="danger"
    confirm-text="删除"
    confirm-icon="trash"
    @update:open="v => { if (!v) removing = null; }"
    @confirm="confirmRemove"
    @cancel="removing = null"
  >
    删除「{{ removing ? labelSnippet(removing.text, 24) : '' }}」？删除操作记录在最新一条摘要上，删除该楼层可恢复。
  </ConfirmDialog>

  <ModalShell :open="!!editing" :title="editing?.id ? '编辑生活细节' : '添加生活细节'" @close="cancelEdit">
    <template v-if="editing">
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">所属人物</span>
        <BbsSelect v-model="editing.subject" :options="subjectOptions" aria-label="生活细节所属人物" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">细节内容（此人明确说过或正文揭示的偏好、习惯、近期状态）</span>
        <textarea v-model="editing.text" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：认为煎饼果子不加脆饼就没有灵魂（姓名由所属人物自动显示）"></textarea>
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">主题标签（可选，1-3 个，斜杠分隔）</span>
        <input v-model="editing.topics" class="bbs-input" type="text" placeholder="如 饮食/作息/工作" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">关键词（可选，用于触发匹配，斜杠分隔）</span>
        <input v-model="editing.anchors" class="bbs-input" type="text" placeholder="如 香菜/项目/死线" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">时效（可选，故事内到期时间；长期偏好留空）</span>
        <input v-model="editing.until" class="bbs-input" type="text" placeholder="如 1988/10/1；留空为长期" />
      </label>
    </template>
    <template #footer>
      <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing?.text.trim()" @click="saveEdit">保存</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.bbs-life-add { margin-left: auto; }
.bbs-life-group { display: flex; flex-direction: column; }
</style>
