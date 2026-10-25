<script setup lang="ts">
/**
 * 规划讨论的消息列表：用户消息靠右；讨论角色（默认 Qiheng，可换成自定义角色）的回复靠左，带头像和名字，按空行拆成一条条气泡，像连发的消息。
 * 说话人旁显示时间（prism.15 之前的记录没有时间）。发送后先显示待回复的问题和「正在输入」，回复保存后由讨论记录替换。
 * 新消息出现时滚到底部。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import IconButton from '@/components/IconButton.vue';
import type { DiscussionMessage } from '@/outline/discussionStore';
import { discussionFullTime, discussionTimeLabel, splitReplyBubbles } from '@/outline/discussionView';
import { activeDiscussionPersona } from '@/outline/persona';
import { copyText } from '@/st/clipboard';
import { toast } from '@/st/toast';
import DiscussionText from './DiscussionText.vue';
import PersonaAvatar from './PersonaAvatar.vue';

const props = defineProps<{
  messages: DiscussionMessage[];
  /** 已发送、等待回复的问题及发送时间 */
  pending: { text: string; at: number } | null;
  busy: boolean;
  /** 等待中显示的状态 */
  busyText: string;
  /** 列表末尾的一行说明（保存、取消、清空的结果） */
  note: string;
}>();

const isoTime = (at: number) => new Date(at).toISOString();
const persona = computed(() => activeDiscussionPersona());
const scroller = ref<HTMLElement | null>(null);
function scrollToEnd() {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}
onMounted(() => nextTick(scrollToEnd));
watch(() => [props.messages.length, props.pending, props.busy, props.note], () => nextTick(scrollToEnd));

const copied = ref(-1);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(index: number, text: string) {
  if (await copyText(text)) {
    copied.value = index;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = -1; }, 1600);
  } else toast('复制失败：浏览器不允许访问剪贴板，请选中文字后手动复制。', 'warning');
}
</script>

<template>
  <div ref="scroller" class="dm" role="log" aria-label="讨论记录" tabindex="0">
    <div v-if="!messages.length && !pending" class="dm-empty">
      <PersonaAvatar class="dm-empty-portrait" :size="112" portrait />
      <p v-if="persona.custom" class="dm-empty-name">{{ persona.name }}</p>
      <div v-if="persona.greeting.length" class="dm-empty-greeting" :aria-label="persona.name + '：' + persona.greeting.join('，')">
        <p v-for="line in persona.greeting" :key="line" class="dm-bubble dm-greeting-line" aria-hidden="true">{{ line }}</p>
      </div>
      <p class="dm-empty-text">可以就人物动机、节奏或走向提问。讨论不修改规划，也不注入正文。</p>
    </div>
    <ol v-else class="dm-list">
      <li v-for="(message, index) in messages" :key="index" class="dm-msg" :class="message.role === 'user' ? 'is-user' : 'is-model'">
        <template v-if="message.role === 'user'">
          <p class="dm-who">你<time v-if="message.at" class="dm-time" :datetime="isoTime(message.at)" :title="discussionFullTime(message.at)">{{ discussionTimeLabel(message.at) }}</time></p>
          <div class="dm-bubble"><p class="dm-plain">{{ message.content }}</p></div>
        </template>
        <template v-else>
          <PersonaAvatar class="dm-avatar" :size="34" />
          <div class="dm-body">
            <p class="dm-who">{{ persona.name }}<time v-if="message.at" class="dm-time" :datetime="isoTime(message.at)" :title="discussionFullTime(message.at)">{{ discussionTimeLabel(message.at) }}</time></p>
            <div class="dm-stack">
              <div v-for="(part, k) in splitReplyBubbles(message.content)" :key="k" class="dm-bubble"><DiscussionText :text="part" /></div>
            </div>
            <div class="dm-tools">
              <IconButton size="sm" :icon="copied === index ? 'check' : 'copy'" :active="copied === index"
                :label="copied === index ? '已复制' : `复制第 ${index / 2 + 1} 轮回复`" title="复制" @click="copy(index, message.content)" />
            </div>
          </div>
        </template>
      </li>
      <li v-if="pending" class="dm-msg is-user is-pending">
        <p class="dm-who">你<time class="dm-time" :datetime="isoTime(pending.at)" :title="discussionFullTime(pending.at)">{{ discussionTimeLabel(pending.at) }}</time></p>
        <div class="dm-bubble"><p class="dm-plain">{{ pending.text }}</p></div>
      </li>
      <li v-if="busy" class="dm-msg is-model is-typing">
        <PersonaAvatar class="dm-avatar" :size="34" />
        <div class="dm-body">
          <p class="dm-who">{{ persona.name }}</p>
          <div class="dm-bubble">
            <span class="dm-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="dm-typing-text">{{ busyText || '正在输入…' }}</span>
          </div>
        </div>
      </li>
    </ol>
    <p v-if="note && !busy" class="dm-note">{{ note }}</p>
  </div>
</template>

<style scoped>
.dm { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px 16px 12px; background: var(--bbs-bg); }
.dm:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: -2px; }
.dm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 100%; padding: 24px 12px; text-align: center; }
.dm-empty-portrait { width: 112px; height: 112px; border-radius: 28px; object-fit: cover; box-shadow: 0 0 0 1px var(--bbs-line); }
.dm-empty-name { margin: 0; font: 600 16px/1.4 var(--bbs-font-reading); letter-spacing: .04em; color: var(--bbs-ink); }
.dm-empty-greeting { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.dm-greeting-line { margin: 0; border: 1px solid var(--bbs-line); background: var(--bbs-surface); color: var(--bbs-ink); }
.dm-empty-text { max-width: 30em; margin: 4px 0 0; font-size: 13px; line-height: 1.7; color: var(--bbs-ink-muted); text-wrap: balance; }
.dm-list { display: flex; flex-direction: column; gap: 16px; margin: 0; padding: 0; list-style: none; }
.dm-msg { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: min(88%, 640px); }
.dm-msg.is-user { align-self: flex-end; align-items: flex-end; max-width: min(82%, 560px); }
.dm-msg.is-model { flex-direction: row; align-items: flex-start; gap: 10px; max-width: min(92%, 680px); }
.dm-avatar { flex: 0 0 auto; width: 34px; height: 34px; margin-top: 2px; border-radius: 50%; object-fit: cover; box-shadow: 0 0 0 1px var(--bbs-line); }
.dm-body { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.dm-who { margin: 0 4px 4px; font-size: 12px; line-height: 1.4; color: var(--bbs-ink-muted); }
.is-model .dm-who { font-weight: 600; color: var(--bbs-ink); }
.dm-time { margin-left: 6px; font-weight: 400; color: var(--bbs-ink-muted); font-variant-numeric: tabular-nums; }
.dm-stack { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; max-width: 100%; }
.dm-bubble { min-width: 0; max-width: 100%; padding: 9px 14px; border-radius: 16px; font-size: 14px; line-height: 1.75; overflow-wrap: anywhere; }
.is-user .dm-bubble { border-top-right-radius: 4px; background: var(--bbs-accent-soft); color: var(--bbs-ink); }
.is-model .dm-bubble { border: 1px solid var(--bbs-line); background: var(--bbs-surface); color: var(--bbs-ink); }
.is-model .dm-stack .dm-bubble:first-child, .is-typing .dm-bubble { border-top-left-radius: 4px; }
.is-pending .dm-bubble { opacity: .8; }
.dm-plain { margin: 0; white-space: pre-wrap; }
.dm-tools { display: flex; gap: 4px; margin: 2px 0 0; color: var(--bbs-ink-muted); }
.is-typing .dm-bubble { display: inline-flex; align-items: center; gap: 10px; color: var(--bbs-ink-muted); font-size: 13px; }
.dm-dots { display: inline-flex; gap: 4px; }
.dm-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--bbs-accent); opacity: .35; animation: dm-blink 1.2s infinite ease-in-out; }
.dm-dots i:nth-child(2) { animation-delay: .2s; }
.dm-dots i:nth-child(3) { animation-delay: .4s; }
@keyframes dm-blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
.dm-note { margin: 14px auto 0; max-width: 32em; font-size: 12px; line-height: 1.6; text-align: center; color: var(--bbs-ink-muted); }
@media (max-width: 640px) {
  .dm { padding: 14px 12px 10px; }
  .dm-msg { max-width: 92%; }
  .dm-msg.is-user { max-width: 86%; }
  .dm-msg.is-model { max-width: 100%; gap: 8px; }
  .dm-avatar { width: 30px; height: 30px; }
}
@media (prefers-reduced-motion: reduce) {
  .dm-dots i { animation: none; opacity: .7; }
}
</style>
