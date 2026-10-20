<script setup lang="ts">
/* 从旧版 Horae 迁移：将当前聊天中 Horae 的摘要、物品和计划转为棱镜宝书记忆。 */
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { computeMigrationPlan, runHoraeMigration, type MigrationPlan } from '@/memory/migrate';
import { computed, ref } from 'vue';
import { readableError } from '../notice';

const migrating = ref(false);
const migrateMsg = ref('');
const migrateConfirmOpen = ref(false);
// 迁移计划:展开面板时实时算(纯读当前 chat 的 horae_meta,不缓存)
const migratePlan = computed<MigrationPlan>(() => computeMigrationPlan());
// 确认文案随「是否覆盖」变化
const migrateConfirmText = computed(() =>
  migratePlan.value.willOverwrite
    ? '当前聊天已有棱镜宝书数据，迁移会覆盖现有摘要，并在各楼写入数据。是否继续？'
    : '将当前聊天中 Horae 的旧数据转换为棱镜宝书记忆。是否继续？',
);
async function runMigrate() {
  migrateConfirmOpen.value = false;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const ok = await runHoraeMigration();
    migrateMsg.value = ok ? '迁移完成。' : '迁移未完成，原因见弹出的提示。';
  } catch (e) {
    migrateMsg.value = `迁移失败：${readableError(e, '请稍后重试')}`;
  } finally {
    migrating.value = false;
  }
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="从旧版 Horae 迁移" :open="false">
    <p class="bbs-field-hint">
      将当前聊天中旧版 Horae 的摘要、物品和计划迁移过来。每个聊天需分别执行一次，Horae 的原数据不会改动。
    </p>
    <div v-if="migratePlan" class="bbs-field-hint">
      <template v-if="migratePlan.hasData">
        找到：可建摘要 {{ migratePlan.leafFloors }} 层，旧总结 {{ migratePlan.summaryCount }} 条，物品 {{ migratePlan.itemCount }} 个，计划悬念 {{ migratePlan.planCount }} 条。<strong v-if="migratePlan.willOverwrite">当前聊天已有棱镜宝书数据，迁移会将其覆盖。</strong>
      </template>
      <template v-else>当前聊天中没有 Horae 旧数据（请先打开含旧数据的聊天）。</template>
    </div>
    <button
      class="bbs-btn bbs-btn-sm bbs-btn-primary"
      type="button"
      :disabled="migrating || !migratePlan?.hasData"
      @click="migrateConfirmOpen = true"
    >
      {{ migrating ? '迁移中…' : '迁移当前聊天的 Horae 数据' }}
    </button>
    <p v-if="migrateMsg" class="bbs-field-hint">{{ migrateMsg }}</p>

    <ConfirmDialog
      v-model:open="migrateConfirmOpen"
      title="从旧版 Horae 迁移"
      confirm-text="开始迁移"
      @confirm="runMigrate"
    >
      {{ migrateConfirmText }}
    </ConfirmDialog>
  </Collapsible>
</template>
