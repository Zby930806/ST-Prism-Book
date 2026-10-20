<script setup lang="ts">
/**
 * 主角档案：分组标签行、主角卡（身份、外貌、着装、状态）与编辑弹窗。
 * 主角与 NPC 名册分开记录；编辑写入最新一条有效摘要，没有摘要时编辑键禁用。
 */
import { apiSettings } from '@/api/settings';
import IconButton from '@/components/IconButton.vue';
import ModalShell from '@/components/ModalShell.vue';
import { setProtagonist } from '@/memory/apply';
import { memory } from '@/memory/store';
import { computed, ref } from 'vue';
import NpcCardBase from './NpcCardBase.vue';
import NpcSectionHead from './NpcSectionHead.vue';
import { personChips, type CardField } from './npcView';

const props = defineProps<{ name: string; hasLeaf: boolean }>();

const hasData = computed(() => Object.values(memory.protagonist).some(value => !!value?.trim()));
const hasDetails = computed(() => [
  memory.protagonist.age,
  memory.protagonist.identity,
  memory.protagonist.appearance,
  memory.protagonist.outfit,
  memory.protagonist.condition,
].some(value => !!value?.trim()));
const chips = computed(() => personChips(memory.protagonist.gender, memory.protagonist.age, memory.protagonist.ageTime));
const fields = computed<CardField[] | null>(() => {
  if (!hasDetails.value) return null;
  const p = memory.protagonist;
  const out: CardField[] = [];
  if (p.identity) out.push({ key: 'identity', label: '身份', value: p.identity, cls: 'f-title' });
  if (p.appearance) out.push({ key: 'appearance', label: '外貌', value: p.appearance, cls: 'f-desc' });
  if (p.outfit) out.push({ key: 'outfit', label: '着装', value: p.outfit, cls: 'f-outfit' });
  if (p.condition) out.push({ key: 'condition', label: '状态', value: p.condition, cls: 'f-cond' });
  return out;
});

interface ProtagonistDraft {
  gender: string;
  age: string;
  identity: string;
  appearance: string;
  outfit: string;
  condition: string;
}
const editing = ref<ProtagonistDraft | null>(null);

function openEdit() {
  if (!props.hasLeaf) return;
  editing.value = {
    gender: memory.protagonist.gender ?? '',
    age: memory.protagonist.age ?? '',
    identity: memory.protagonist.identity ?? '',
    appearance: memory.protagonist.appearance ?? '',
    outfit: memory.protagonist.outfit ?? '',
    condition: memory.protagonist.condition ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const draft = editing.value;
  if (!draft) return;
  // 年龄没改时带上旧锚点,防止重放把锚点刷成「此刻」(等于错误冻龄);真改了才留给重放盖新锚点
  const ageTime = draft.age.trim() && draft.age.trim() === memory.protagonist.age ? memory.protagonist.ageTime : undefined;
  if (setProtagonist({ ...draft, ageTime })) editing.value = null;
}
</script>

<template>
  <div class="bbs-protagonist-section">
    <NpcSectionHead
      tag="主角"
      tag-icon="characters"
      tag-tone="protagonist"
      :hint="apiSettings.summaryOnlyMode ? '仅供棱镜宝书记录，不发送给主对话 AI' : '始终完整发送，与 NPC 名册分开记录'"
      :local-only="apiSettings.summaryOnlyMode"
    />
    <NpcCardBase
      variant="protagonist"
      :name="name"
      :chips="chips"
      :fields="fields"
      :hint="hasData ? undefined : '暂无状态记录，摘要将根据剧情补充。'"
    >
      <template #actions>
        <IconButton
          icon="edit"
          label="编辑主角档案"
          :title="hasLeaf ? '编辑主角当前档案' : '需先有摘要才能编辑'"
          :disabled="!hasLeaf"
          @click="openEdit"
        />
      </template>
    </NpcCardBase>
  </div>

  <ModalShell :open="!!editing" title="编辑主角档案" @close="cancelEdit">
    <template v-if="editing">
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">性别</span>
        <input v-model="editing.gender" class="bbs-input" type="text" placeholder="如：男、女" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">年龄（记录当时的值，随剧情时间自动推算）</span>
        <input v-model="editing.age" class="bbs-input" type="text" placeholder="如：25、二十出头" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">当前身份 / 职业 / 种族 / 公开地位</span>
        <textarea v-model="editing.identity" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">稳定外貌 / 身体特征</span>
        <textarea v-model="editing.appearance" class="bbs-input bbs-modal-textarea" rows="2" placeholder="如：黑色短发、左眉有疤"></textarea>
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">当前着装</span>
        <textarea v-model="editing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">当前身体状态 / 健康</span>
        <textarea v-model="editing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="无异常时留空"></textarea>
      </label>
    </template>
    <template #footer>
      <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="saveEdit">保存</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.bbs-protagonist-section { display: flex; flex-direction: column; gap: 12px; margin-bottom: 26px; min-width: 0; }
</style>
