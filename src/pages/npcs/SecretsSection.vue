<script setup lang="ts">
/**
 * 信息差：谁知道什么。未结案条目可结案或删除，已结案条目可重开或删除。
 * 默认收起，避免打开角色页就看到剧透；折叠状态存 localStorage（bbs.ui.secretsCollapsed.v1）。
 * 在场的不知情角色会在注入时收到提醒；仅本地记录或注入设置关闭信息差时，标题行显示提醒。
 */
import { apiSettings } from '@/api/settings';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import IconButton from '@/components/IconButton.vue';
import { removeSecret, reopenSecret, resolveSecret } from '@/memory/apply';
import { memory } from '@/memory/store';
import type { MemSecret } from '@/memory/types';
import { toast } from '@/st/toast';
import { computed, ref } from 'vue';
import NpcEntry from './NpcEntry.vue';
import NpcFoldSection from './NpcFoldSection.vue';
import { labelSnippet, loadCollapsed, persistCollapsed } from './npcView';

const COLLAPSE_KEY = 'bbs.ui.secretsCollapsed.v1';
const collapsed = ref(loadCollapsed(COLLAPSE_KEY, true));
const foldable = computed(() => memory.secrets.length > 0);
function toggleFold() {
  collapsed.value = !collapsed.value;
  persistCollapsed(COLLAPSE_KEY, collapsed.value);
}
const localOnly = computed(() => apiSettings.summaryOnlyMode || !apiSettings.injection.secrets);
const openSecrets = computed(() => memory.secrets.filter(s => s.status === 'open'));
const resolvedSecrets = computed(() => memory.secrets.filter(s => s.status === 'resolved'));
function secretMeta(s: MemSecret): string {
  const parts: string[] = [];
  if (s.knownBy.length) parts.push(`知情：${s.knownBy.join('、')}`);
  if (s.unaware.length) parts.push(`不知情：${s.unaware.join('、')}`);
  return parts.join(' · ');
}
function closeSecret(s: MemSecret) {
  if (!resolveSecret(s.id)) toast('需先有摘要才能修改信息差。', 'warning');
}
function reopenSecretItem(s: MemSecret) {
  if (!reopenSecret(s.id)) toast('需先有摘要才能修改信息差。', 'warning');
}
const removing = ref<MemSecret | null>(null);
function removeSecretItem(s: MemSecret) {
  removing.value = s;
}
function confirmRemove() {
  const s = removing.value;
  removing.value = null;
  if (s && !removeSecret(s.id)) toast('需先有摘要才能修改信息差。', 'warning');
}
</script>

<template>
  <NpcFoldSection
    title="信息差"
    section-class="bbs-secret-section"
    :count="openSecrets.length"
    :foldable="foldable"
    :collapsed="collapsed"
    :warning="localOnly ? '仅供棱镜宝书记录，不发送给主对话 AI' : undefined"
    empty-hint="摘要记录正文中明确的隐瞒，以及重要事件发生时角色不在场的情况。"
    :note="localOnly ? undefined : '注入正文时提醒在场的不知情角色。'"
    @toggle="toggleFold"
  >
    <div v-if="openSecrets.length" class="bbs-life-group">
      <NpcEntry v-for="s in openSecrets" :key="s.id" :text="s.content" :tag="secretMeta(s) || undefined">
        <template #actions>
          <IconButton icon="check" :label="'结案：' + labelSnippet(s.content)" title="结案（相关角色都已知情）" @click="closeSecret(s)" />
          <IconButton icon="trash" tone="danger" :label="'删除信息差：' + labelSnippet(s.content)" title="删除" @click="removeSecretItem(s)" />
        </template>
      </NpcEntry>
    </div>
    <template v-if="resolvedSecrets.length">
      <p class="bbs-secret-subhead">已结案</p>
      <div class="bbs-life-group">
        <NpcEntry v-for="s in resolvedSecrets" :key="s.id" :text="s.content" :tag="secretMeta(s) || undefined" variant="archive">
          <template #actions>
            <IconButton icon="refresh" :label="'重开：' + labelSnippet(s.content)" title="重开" @click="reopenSecretItem(s)" />
            <IconButton icon="trash" tone="danger" :label="'删除信息差：' + labelSnippet(s.content)" title="删除" @click="removeSecretItem(s)" />
          </template>
        </NpcEntry>
      </div>
    </template>
  </NpcFoldSection>

  <ConfirmDialog
    :open="!!removing"
    title="删除信息差"
    tone="danger"
    confirm-text="删除"
    confirm-icon="trash"
    @update:open="v => { if (!v) removing = null; }"
    @confirm="confirmRemove"
    @cancel="removing = null"
  >
    删除「{{ removing ? labelSnippet(removing.content, 24) : '' }}」？删除操作记录在最新一条摘要上，删除该楼层可恢复。
  </ConfirmDialog>
</template>

<style scoped>
.bbs-life-group { display: flex; flex-direction: column; }
.bbs-secret-subhead { margin: 12px 0 4px; font-size: 12px; font-weight: 600; color: var(--bbs-ink-muted); }
</style>
