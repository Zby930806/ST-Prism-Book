<script setup lang="ts">
/** 模型回复的排版：标题、段落、列表、引用、代码块。解析见 outline/discussionView.ts，不使用 v-html。 */
import { computed } from 'vue';
import { parseDiscussionText } from '@/outline/discussionView';
import DiscussionInline from './DiscussionInline.vue';

const props = defineProps<{ text: string }>();
const blocks = computed(() => parseDiscussionText(props.text));
</script>

<template>
  <div class="dt">
    <template v-for="(block, index) in blocks" :key="index">
      <p v-if="block.kind === 'h'" class="dt-heading"><DiscussionInline :parts="block.parts" /></p>
      <p v-else-if="block.kind === 'p'"><template v-for="(line, row) in block.lines" :key="row"><br v-if="row" /><DiscussionInline :parts="line" /></template></p>
      <ul v-else-if="block.kind === 'list'" class="dt-list">
        <li v-for="(item, row) in block.items" :key="row" :class="'dt-depth-' + item.depth">
          <span class="dt-marker" :class="{ 'is-number': item.marker !== '•' }" :aria-hidden="item.marker === '•' ? 'true' : undefined">{{ item.marker }}</span>
          <span class="dt-item"><DiscussionInline :parts="item.parts" /></span>
        </li>
      </ul>
      <blockquote v-else-if="block.kind === 'quote'"><template v-for="(line, row) in block.lines" :key="row"><br v-if="row" /><DiscussionInline :parts="line" /></template></blockquote>
      <pre v-else-if="block.kind === 'code'" class="dt-pre">{{ block.text }}</pre>
      <hr v-else />
    </template>
  </div>
</template>

<style scoped>
.dt { min-width: 0; overflow-wrap: anywhere; }
.dt > * { margin: 0; }
.dt > * + * { margin-top: 8px; }
.dt-heading { font-weight: 650; color: var(--bbs-ink); }
.dt-list { padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.dt-list li { display: flex; gap: 8px; min-width: 0; }
.dt-depth-1 { padding-left: 18px; }
.dt-depth-2 { padding-left: 36px; }
.dt-marker { flex: 0 0 auto; min-width: 10px; color: var(--bbs-accent); font-weight: 650; }
.dt-marker.is-number { min-width: 18px; font-variant-numeric: tabular-nums; }
.dt-item { flex: 1 1 auto; min-width: 0; }
blockquote { padding: 2px 0 2px 12px; border-left: 2px solid var(--bbs-line-strong); color: var(--bbs-ink-soft); }
.dt-pre { padding: 8px 10px; border-radius: var(--bbs-radius-sm); background: var(--bbs-surface-2); font: 12px/1.6 var(--bbs-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
hr { height: 0; border: 0; border-top: 1px solid var(--bbs-line); }
</style>
