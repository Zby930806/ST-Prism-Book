<script setup lang="ts">
/**
 * 本楼的状态变动:按类目分区,每条一行(徽标 + 主文本 + 副文本);点一条就地展开编辑表单(DeltaTagEditor)。
 * 从 FloorPanel.vue 拆出,行为不变。番外楼只读。
 */
import { inject } from 'vue';
import FloorSection from './FloorSection.vue';
import DeltaTagEditor from './DeltaTagEditor.vue';
import { DELTA_OP_LABEL, type DeltaTagGroup } from '@/memory/deltaTags';
import { LEAF_EDIT } from './useLeafEdit';

defineProps<{ groups: DeltaTagGroup[]; omit: boolean }>();

const leafEdit = inject(LEAF_EDIT);
if (!leafEdit) throw new Error('DeltaGroups 需要在 FloorPanel 内使用');
const { editKey, editTag } = leafEdit;
</script>

<template>
  <div class="bbs-fp-groups">
    <template v-for="g in groups" :key="g.title">
      <FloorSection v-if="g.tags.length" :icon="g.icon" :title="g.title">
        <div class="bbs-fp-flow">
          <template v-for="tag in g.tags" :key="tag.key">
            <DeltaTagEditor v-if="editKey === tag.key" :tag="tag" />
            <!-- 只读态:徽标钉左上 + 主文本一行 + 副文本(细节)另起淡色一行 -->
            <button
              v-else
              class="bbs-fp-tagline is-btn"
              :class="'op-' + tag.op"
              type="button"
              :disabled="omit"
              :title="omit ? '' : '编辑此条变动'"
              @click="editTag(tag)"
            >
              <span class="bbs-op-badge bbs-fp-op" :class="`is-${tag.op}`">{{ DELTA_OP_LABEL[tag.op] }}</span>
              <span class="bbs-fp-tagbody">
                <span class="bbs-fp-tagmain">{{ tag.text }}</span>
                <span v-if="tag.sub" class="bbs-fp-tagsub">{{ tag.sub }}</span>
              </span>
            </button>
          </template>
        </div>
      </FloorSection>
    </template>
  </div>
</template>

<style scoped>
/* 各类目是「标题 + 分隔线」的分区(FloorSection),不再套卡片;分区之间留白区分 */
.bbs-fp-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
}
/* 变动条纵向堆叠(每条独占一行):账册式条目——一行一条、左对齐、内容自然换行。 */
.bbs-fp-flow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* 变动条(只读=按钮,可点编辑):徽标钉左上,右侧主/副文本左对齐。
   直接坐落在 bg 外层卡上,用抬起面(surface)——与摘要正文块同一层;色彩只落在左侧徽标,条目本体素净。 */
.bbs-fp-tagline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 7px 10px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-line);
  background: var(--bbs-surface);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  text-align: left;
}
.bbs-fp-tagline.is-btn {
  cursor: pointer;
  transition:
    border-color var(--bbs-dur) var(--bbs-ease),
    box-shadow var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-tagline.is-btn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  box-shadow: 0 0 0 2px var(--bbs-accent-soft);
}
.bbs-fp-tagline:disabled {
  cursor: default;
}
/* op 徽标:外观在 base.css 的 .bbs-op-badge(与重新生成对比共用),这里只管与右侧文字的对齐 */
.bbs-fp-op {
  margin-top: 1px;
}
/* 主/副文本:纵向堆叠,主文本正常色、副文本淡色小字 */
.bbs-fp-tagbody {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bbs-fp-tagmain {
  font-size: var(--bbs-fs-sm);
  line-height: 1.45;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-fp-tagsub {
  font-size: var(--bbs-fs-meta);
  line-height: 1.5;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 手机与触屏:条目加高到 40px 以上,便于点按 */
@media (max-width: 640px), (pointer: coarse) {
  .bbs-fp-tagline {
    padding-top: 10px;
    padding-bottom: 10px;
  }
}
</style>
