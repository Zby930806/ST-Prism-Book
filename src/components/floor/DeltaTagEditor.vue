<script setup lang="ts">
/**
 * 一条变动的就地编辑表单(从 FloorPanel.vue 拆出,行为不变)。
 * 可编辑类(物品、角色、新增计划、变量、移除类的名称)给字段行;不可编辑类(场景、计划的了结/重启/删除)只读回显,
 * 底部可删除此条或取消。草稿、保存与删除都在 useLeafEdit 里,通过 inject 取得。
 */
import { inject } from 'vue';
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import type { DeltaTag } from '@/memory/deltaTags';
import { LEAF_EDIT } from './useLeafEdit';

defineProps<{ tag: DeltaTag }>();

const leafEdit = inject(LEAF_EDIT);
if (!leafEdit) throw new Error('DeltaTagEditor 需要在 FloorPanel 内使用');
const { edit, setFocus, onTextInput, onFieldKeydown, editingVarOp, npcEditFields, npcAffinityEditFields, cancelEdit, saveTag, deleteTag } = leafEdit;
</script>

<template>
  <!-- 统一表单式(带字段标签 + 底部规整按钮) -->
  <div class="bbs-fp-editform">
    <template v-if="tag.editable && tag.key.startsWith('item:') && tag.bucket !== 'remove'">
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">名称</span>
        <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="名称" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">数量</span>
        <input v-model="edit.qty" class="bbs-input bbs-fp-nfield bbs-fp-nfield-num" type="number" placeholder="留空则不计数" />
      </label>
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">描述</span>
        <textarea v-model="edit.desc" rows="1" class="bbs-input bbs-fp-nfield" placeholder="可选" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
    </template>
    <template v-else-if="tag.editable && tag.key.startsWith('npc:') && tag.bucket !== 'remove'">
      <!-- 名称恒有(匹配键);其余只渲染本轮实际改动过的字段,不误导「无此数据」 -->
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">名称</span>
        <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="名称" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
      <div v-for="f in npcAffinityEditFields" :key="f.key" class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">{{ f.label }}</span>
        <BbsSelect v-model="edit[f.key]" :options="f.options" :aria-label="f.label" class="bbs-fp-nselect" />
      </div>
      <label v-for="f in npcEditFields" :key="f.draft" class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">{{ f.label }}</span>
        <textarea v-model="edit[f.draft]" rows="1" class="bbs-input bbs-fp-nfield" :placeholder="f.label" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
    </template>
    <template v-else-if="tag.editable && tag.key.startsWith('plan:add:')">
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">内容</span>
        <textarea :ref="setFocus" v-model="edit.content" rows="1" class="bbs-input bbs-fp-nfield" placeholder="内容" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
    </template>
    <template v-else-if="tag.key.startsWith('var:')">
      <!-- 变量命令:按类型显示字段。路径恒有;set/assign 有「值」;add 有「增量」;assign/remove 有「键」 -->
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">路径</span>
        <textarea :ref="setFocus" v-model="edit.varPath" rows="1" class="bbs-input bbs-fp-nfield" placeholder="如 好感度 或 势力.魔法议会.声望" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
      <label v-if="editingVarOp?.op === 'assign' || editingVarOp?.op === 'remove'" class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">键</span>
        <textarea v-model="edit.varKey" rows="1" class="bbs-input bbs-fp-nfield" placeholder="对象键 / 数组下标" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
      <label v-if="editingVarOp?.op === 'add'" class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">增量</span>
        <input v-model="edit.varDelta" class="bbs-input bbs-fp-nfield bbs-fp-nfield-num" type="number" placeholder="可负，如 -10" />
      </label>
      <label v-if="editingVarOp?.op === 'set' || editingVarOp?.op === 'assign'" class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">值</span>
        <textarea v-model="edit.varValue" rows="1" class="bbs-input bbs-fp-nfield" placeholder="文本直接填写；数字、true、JSON 按原样保存" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
    </template>
    <template v-else-if="tag.editable && tag.bucket === 'remove'">
      <label class="bbs-fp-nrow">
        <span class="bbs-fp-nlabel">名称</span>
        <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="名称" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
      </label>
    </template>
    <!-- 不可编辑标签:只读回显要删除的内容(带副文本,如变量的值/增量) -->
    <p v-else class="bbs-fp-editreadonly">{{ tag.sub ? `${tag.text} · ${tag.sub}` : tag.text }}</p>
    <div class="bbs-fp-editfoot">
      <button class="bbs-fp-editdel" type="button" title="删除此条变动" @click="deleteTag(tag)"><Icon name="trash" />删除</button>
      <span class="bbs-fp-editfoot-spacer"></span>
      <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">取消</button>
      <button v-if="tag.editable" class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveTag(tag)">保存</button>
    </div>
  </div>
</template>

<style scoped src="./editForm.css"></style>
