<script setup lang="ts">
/**
 * 角色卡外壳：名字、性别/年龄小标签、右侧操作（actions 插槽）、字段表。名册角色卡（NpcCard）与主角卡共用。
 * 名字与小标签在左侧一块内换行，操作键始终与名字同一行靠右（手机上也不单独占一行）。
 * 字段标签一律用次要色；只有值需要提示时着色（如「跟主角在一起」）。
 * fields 为 null 时不显示字段表，改为显示 hint（若有）。
 */
import { computed } from 'vue';
import type { CardChip, CardField } from './npcView';

const props = defineProps<{
  name: string;
  chips?: CardChip[];
  fields: CardField[] | null;
  hint?: string;
  variant: 'protagonist' | 'main' | 'present' | 'nearby' | 'absent';
  /** 在场且随行：左缘用强调色 */
  follow?: boolean;
}>();

const cardClass = computed(() => {
  switch (props.variant) {
    case 'protagonist': return 'bbs-protagonist';
    case 'main': return 'is-present is-main';
    case 'present': return props.follow ? 'is-present is-follow' : 'is-present';
    case 'nearby': return 'is-nearby';
    default: return 'is-absent';
  }
});
</script>

<template>
  <article class="bbs-npc" :class="cardClass">
    <div class="bbs-npc-body">
      <div class="bbs-npc-head">
        <div class="bbs-npc-id">
          <span class="bbs-npc-name" :title="name">{{ name }}</span>
          <span v-if="chips?.length" class="bbs-npc-chips"><span v-for="(chip, i) in chips" :key="i" class="bbs-npc-gender" :title="chip.title">{{ chip.text }}</span></span>
        </div>
        <span class="bbs-npc-acts"><slot name="actions" /></span>
      </div>
      <dl v-if="fields" class="bbs-npc-fields">
        <div v-for="f in fields" :key="f.key" class="bbs-npc-field" :class="f.cls">
          <dt :title="f.labelTitle">{{ f.label }}</dt>
          <dd :class="f.ddClass">{{ f.value }}</dd>
        </div>
      </dl>
      <p v-else-if="hint" class="bbs-npc-mainhint">{{ hint }}</p>
      <div v-if="$slots.footer" class="bbs-npc-foot"><slot name="footer" /></div>
    </div>
  </article>
</template>

<style scoped>
.bbs-npc { position: relative; min-width: 0; padding: 17px 18px; border: 1px solid var(--bbs-line); border-radius: 15px; background: var(--bbs-surface); box-shadow: var(--bbs-card-shadow); }
.bbs-npc.is-present, .bbs-npc.is-nearby { border-left: 3px solid var(--bbs-line-strong); }
.bbs-npc.is-main, .bbs-npc.is-follow { border-left: 3px solid var(--bbs-accent); }
.bbs-protagonist { border-left: 3px solid var(--bbs-warning); }
.bbs-npc.is-absent { background: transparent; box-shadow: none; border-style: dashed; }
.bbs-npc-body { min-width: 0; }
/* 名字一块可换行，操作键不换行、贴右；名字只有一行时与按钮垂直居中。 */
.bbs-npc-head { display: flex; align-items: flex-start; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--bbs-line); margin-bottom: 12px; }
.bbs-npc-id { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-items: center; gap: 4px 9px; min-width: 0; min-height: var(--bbs-icon-btn); }
.bbs-npc-name { font-size: 16px; font-weight: 650; min-width: 0; max-width: 100%; overflow-wrap: anywhere; line-height: 1.5; }
.bbs-npc-chips { display: inline-flex; flex-wrap: wrap; gap: 4px 6px; min-width: 0; }
.bbs-npc-gender { padding: 2px 6px; border-radius: 5px; background: var(--bbs-surface-2); color: var(--bbs-ink-muted); font-size: 11px; max-width: 100%; overflow-wrap: anywhere; }
.bbs-npc-acts { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; flex-shrink: 0; }
.bbs-npc-fields { display: flex; flex-direction: column; gap: 10px; margin: 0; }
.bbs-npc-field { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.bbs-npc-field dt { font-size: 11px; font-weight: 500; line-height: 1.7; color: var(--bbs-ink-muted); }
.bbs-npc-field dd { min-width: 0; margin: 0; font-size: 13px; line-height: 1.75; color: var(--bbs-ink-soft); overflow-wrap: anywhere; white-space: pre-wrap; }
.bbs-npc-field.f-title dd, .bbs-npc-field.f-rel dd { color: var(--bbs-ink); }
.bbs-npc-field.f-loc dd.is-follow { color: var(--bbs-accent); }
.bbs-npc-field.f-loc dd.is-nowhere { color: var(--bbs-ink-muted); font-style: italic; }
.bbs-npc-mainhint { margin: 4px 0; color: var(--bbs-ink-muted); font-size: 12px; line-height: 1.8; }
/* 卡片底部一行（如「档案缺：外貌 · 从原文补全」）：与字段表之间留一条细线。 */
.bbs-npc-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--bbs-line); }
@media (max-width: 640px) {
  .bbs-npc { padding: 14px; }
  .bbs-npc-field { grid-template-columns: 54px minmax(0, 1fr); gap: 8px; }
}
</style>
