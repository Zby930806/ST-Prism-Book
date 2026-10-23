<script setup lang="ts">
/**
 * 添加 / 编辑角色的表单弹窗。draft 由页面持有，表单直接编辑其字段；保存与关闭由页面处理。
 * 添加模式：名字、性别、年龄输入框按 Enter 即添加；页面可调用 focusName() 让名字框获得焦点。
 */
import BbsSelect from '@/components/BbsSelect.vue';
import ModalShell from '@/components/ModalShell.vue';
import { NPC_AFFINITY_FIELDS } from '@/memory/npcRelations';
import { ref } from 'vue';
import type { NpcDraft } from './npcView';
import { blockSent } from './sendScope';

const props = defineProps<{
  open: boolean;
  mode: 'add' | 'edit';
  draft: NpcDraft | null;
  protagonistName: string;
}>();
const emit = defineEmits<{ (e: 'save'): void; (e: 'close'): void }>();

const nameInput = ref<HTMLInputElement | null>(null);
function onEnter(e: KeyboardEvent) {
  if (props.mode !== 'add') return;
  // 取消这次 Enter 的默认动作：添加后弹窗关闭、焦点回到「添加角色」按钮，否则同一次 Enter 会把弹窗再次打开。
  e.preventDefault();
  emit('save');
}
defineExpose({ focusName: () => nameInput.value?.focus() });
</script>

<template>
  <ModalShell :open="open" :title="mode === 'add' ? '添加角色' : '编辑角色'" @close="emit('close')">
    <template v-if="draft">
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">名字</span>
        <input ref="nameInput" v-model="draft.name" class="bbs-input" type="text" placeholder="角色名；没有名字可写职业加字母，如酒保A" @keydown.enter="onEnter" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">性别</span>
        <input v-model="draft.gender" class="bbs-input" type="text" placeholder="如：男、女" @keydown.enter="onEnter" />
      </label>
      <label class="bbs-modal-field">
        <span class="bbs-modal-label">{{ mode === 'add' ? '年龄（记录当时的值，随剧情时间自动推算）' : '年龄（记录当时的值，随剧情时间自动推算；不改则保留原锚点）' }}</span>
        <input v-model="draft.age" class="bbs-input" type="text" placeholder="如：25、二十出头" @keydown.enter="onEnter" />
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
          {{ blockSent('npcs') ? '主要角色（除主角外的主要登场角色，档案与当前状态随正文发送）' : '主要角色（除主角外的主要登场角色，仅在棱镜宝书内单独列出）' }}
        </span>
      </label>
      <label class="bbs-modal-field bbs-modal-check">
        <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
        <span class="bbs-modal-label">随行同伴（跟随主角移动，始终在场）</span>
      </label>
      <label v-if="!draft.follow" class="bbs-modal-field">
        <span class="bbs-modal-label">所在地点（留空=所在不明，不再视为在场）</span>
        <textarea v-model="draft.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如：归雁客栈、王宫；留空=所在不明"></textarea>
      </label>
    </template>
    <template #footer>
      <button class="bbs-btn" type="button" @click="emit('close')">取消</button>
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!draft?.name.trim()" @click="emit('save')">{{ mode === 'add' ? '添加' : '保存' }}</button>
    </template>
  </ModalShell>
</template>
