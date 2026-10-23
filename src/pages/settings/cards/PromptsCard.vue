<script setup lang="ts">
/* 自定义提示词：列表（摘要/总结/二次总结/任务说明/时间标签），点开在弹窗里编辑。 */
import BbsSelect from '@/components/BbsSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { apiSettings, type ApiSettings } from '@/api/settings';
import { ref } from 'vue';
import { isCustom, promptSync, PROMPT_METAS } from '../promptMeta';
import PromptDialog from './PromptDialog.vue';
import SettingRow from '../SettingRow.vue';

const TASK_MODE_OPTIONS: { value: ApiSettings['taskContextMode']; label: string }[] = [
  { value: 'default', label: '内置中性说明' },
  { value: 'custom', label: '自定义（可留空）' },
  { value: 'disabled', label: '禁用' },
];

const dialog = ref<InstanceType<typeof PromptDialog> | null>(null);
</script>

<template>
  <Collapsible class="prism-settings-card" title="自定义提示词" :open="false">
    <p class="prism-card-intro">点击一项打开编辑，可插入宏或恢复默认。修改过的提示词不随内置版本更新；内置版本更新后，此处标有「内置已更新」，打开可查看内置的改动。</p>
    <p class="bbs-field-hint">摘要和总结使用的模型名里含 deepseek（不区分大小写，带平台前缀或后缀的也算，如 deepseek-ai/DeepSeek-V3、deepseek-r1:14b）时，发送时省略内置规则开头的「内容边界」，沿用原来的提示词；其他模型照常发送。跟随主 API 时看酒馆当前选中的模型。中转站把 DeepSeek 改成不含 deepseek 的别名时识别不了。自己模板里写的内容边界不会被去掉。检索改写不加内容边界。</p>
    <SettingRow kind="num" as="div" label="任务说明模式" hint="已有的自定义内容会保留。模式为内置或自定义时，保存与内置不同的任务说明自动切换为「自定义」，恢复默认后保存即使用内置说明；模式为「禁用」时，保存只修改内容，不会启用。「禁用」只是不发送这段说明，输出格式要求照常发送。">
      <BbsSelect v-model="apiSettings.taskContextMode" :options="TASK_MODE_OPTIONS" class="prism-task-mode" aria-label="任务说明模式" />
    </SettingRow>
    <ul class="bbs-prompt-list">
      <li v-for="m in PROMPT_METAS" :key="m.key" class="bbs-prompt-item">
        <button class="bbs-prompt-open" type="button" @click="dialog?.open(m)">
          <span class="bbs-prompt-name">{{ m.label }}</span>
          <span class="bbs-prompt-state" :class="{ 'is-custom': isCustom(m.key), 'is-outdated': promptSync(m) === 'outdated' }">
            {{ m.key === 'jailbreak' && apiSettings.taskContextMode === 'disabled' ? '已禁用' : promptSync(m) === 'outdated' ? '内置已更新' : isCustom(m.key) ? '已自定义' : '默认' }}
          </span>
          <Icon name="edit" class="bbs-prompt-edit" />
        </button>
      </li>
    </ul>

    <PromptDialog ref="dialog" />
  </Collapsible>
</template>

<style scoped>
/* 任务说明模式下拉：按选项文字定宽，与其他设置行的控件同在右侧。带父级压过 BbsSelect 根节点的 width:100% */
.bbs-num-row .prism-task-mode {
  width: auto;
  min-width: 156px;
  max-width: 100%;
}
.prism-task-mode :deep(.bbs-select-trigger) {
  font-size: 12px;
}

/* —— 自定义提示词列表 —— */
.bbs-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}
.bbs-prompt-item {
  min-width: 0;
}
/* 整行可点进弹窗编辑;布局沿用渠道列表的观感(描边、hover 显强调色) */
.bbs-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  padding: 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-prompt-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
.bbs-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
/* 状态药丸:默认 muted,已自定义转金强调 */
.bbs-prompt-state {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  color: var(--bbs-ink-muted);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
}
.bbs-prompt-state.is-custom {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: transparent;
}
/* 内置在你改过之后更新了:换成提醒色,点开编辑能看差异 */
.bbs-prompt-state.is-outdated {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
.bbs-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbs-ink-muted);
}
.bbs-prompt-open:hover .bbs-prompt-edit {
  color: var(--bbs-accent);
}
@media (max-width: 640px) {
  .bbs-prompt-name {
    font-size: 12px;
  }
}
@container prism-settings (min-width: 760px) {
  .bbs-prompt-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container prism-settings (max-width: 520px) {
  .bbs-prompt-open { padding: 12px; gap: 8px; }
  .bbs-prompt-name { font-size: 13px; }
}
</style>
