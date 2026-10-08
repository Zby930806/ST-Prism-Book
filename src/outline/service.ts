import { reactive, watch } from 'vue';
import { requestCompletion } from '@/api/client';
import { engineActiveHere } from '@/api/settings';
import { getContext } from '@/st/context';
import { buildOutlineContext } from './context';
import { parseOutlineReply } from './protocol';
import { outlineSettings, resolveOutlineChannel } from './settings';
import { loadOutline, outlineState, outlineWriteIssue, outlineSourceCurrent, outlineStorageCurrent, commitGeneratedOutline } from './store';
import { captureOutlineSource, outlineInputUnchanged, sameOutlineChat } from './source';
import { renderOutlineGuidance } from './injection';
import { OUTLINE_LIMITS } from './limits';
import { addRefinementContext, buildDiscussionContext, discussionReply, type DiscussionTarget, type OutlineRefinement } from './discussionContext';
import { discussionState, loadOutlineDiscussion, discussionWriteIssue, appendDiscussionTurn } from './discussionStore';

export const OUTLINE_INJECT_KEY = 'prism_book_outline_current';
export const outlineRun = reactive({ busy: false, draft: '', error: '', status: '' });
let controller: AbortController | undefined;
let runId = 0;
let generationBusy = false;
let stillCurrent: (() => boolean) | undefined;
let unbind: (() => void) | undefined;
export const discussionRun = reactive({ busy: false, error: '', status: '' });
let discussionController: AbortController | undefined;
let discussionRunId = 0;
let discussionCurrent: (() => boolean) | undefined;

export function cancelOutlineDiscussion(): void {
  ++discussionRunId; discussionController?.abort(); discussionController = undefined; discussionCurrent = undefined;
  discussionRun.busy = false; discussionRun.status = '已取消等待，已保存讨论和大纲保持不变。';
}
/** 参考明确选择的版本，绝不默认把新草稿当成正在使用的规划。 */
export function captureOutlineRefinement(target: DiscussionTarget): OutlineRefinement {
  if (!['draft', 'active', 'none'].includes(target)) throw new Error('讨论参考类型无效，请重新选择。');
  const issue = outlineWriteIssue() || discussionWriteIssue();
  if (issue) throw new Error(issue);
  const record = target === 'draft' ? outlineState.draft : target === 'active' ? outlineState.active : null;
  if (target !== 'none' && !record) throw new Error('所选参考大纲已不存在，请重新选择。');
  return {
    reference: record ? JSON.parse(JSON.stringify(record.content)) : null,
    referenceLabel: target === 'draft' ? '已保存草稿' : target === 'active' ? '已确认规划' : '无参考大纲',
    messages: discussionState.messages.map(m => ({ ...m })),
  };
}
export async function sendOutlineDiscussion(question: string, target: DiscussionTarget): Promise<boolean> {
  if (discussionRun.busy || outlineRun.busy) return false;
  discussionRun.error = ''; discussionRun.status = '';
  let own = 0, phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  try {
    if (!engineActiveHere()) throw new Error('请先启用当前角色的棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再讨论大纲。');
    if (!question.trim() || question.length > 4000) throw new Error('讨论问题须为1～4000字符。');
    if (discussionState.messages.length >= 24) throw new Error('已达到12轮讨论上限，请先清空讨论再开始新一轮；大纲不会清除。');
    if (discussionState.messages.reduce((n, m) => n + m.content.length, 0) + question.length >= 48000)
      throw new Error('讨论记录已接近48000字符上限，请先清空讨论或缩短问题。');
    const ctx = getContext(); if (!ctx?.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const reference = captureOutlineRefinement(target);
    const channel = resolveOutlineChannel(), source = captureOutlineSource(ctx);
    const revision = outlineState.revision, discussionRevision = discussionState.revision;
    const input = buildDiscussionContext(ctx, question, reference);
    const ctrl = new AbortController(); discussionController = ctrl; own = ++discussionRunId;
    discussionRun.busy = true; discussionRun.status = '正在与规划模型讨论…不会修改或启用大纲。';
    const current = () => own === discussionRunId && !ctrl.signal.aborted && outlineInputUnchanged(source, true)
      && outlineState.revision === revision && outlineStorageCurrent() && discussionState.revision === discussionRevision && engineActiveHere();
    discussionCurrent = current;
    phase = 'request';
    const raw = await requestCompletion(channel, input, { signal: ctrl.signal });
    if (!current()) {
      if (own === discussionRunId) discussionRun.status = '聊天、正文或大纲已变化，旧讨论回复未采用。';
      return false;
    }
    phase = 'parse'; const answer = discussionReply(raw);
    phase = 'save'; await appendDiscussionTurn(question.trim(), answer, discussionRevision, source);
    if (own !== discussionRunId || !sameOutlineChat(source)) return false;
    discussionRun.status = '讨论已保存；大纲未变。需要采纳时，请生成修订草稿并单独确认加入计划。';
    return true;
  } catch (error) {
    if (own && own !== discussionRunId) return false;
    discussionRun.error = phase === 'request' ? '讨论未完成，请检查规划 API 或稍后重试；未自动重试，原记录不变。'
      : error instanceof Error ? error.message.slice(0, 250) : '讨论未完成，请重试。';
    discussionRun.status = '';
    return false;
  } finally {
    if (!own || own === discussionRunId) { discussionRun.busy = false; discussionController = undefined; discussionCurrent = undefined; }
  }
}

export function cancelOutline(): void {
  ++runId; controller?.abort(); controller = undefined; stillCurrent = undefined;
  outlineRun.busy = false; outlineRun.draft = ''; outlineRun.status = '已取消生成，现有草稿和启用大纲保持不变。';
}
export function buildOutlineInjection(): string {
  if (!engineActiveHere() || outlineState.saving || !outlineStorageCurrent()) return '';
  const active = outlineState.active;
  if (!active?.enabled || !outlineSourceCurrent(active)) return '';
  try { return renderOutlineGuidance(active); }
  catch { outlineRun.status = '当前章过长，未注入正文；请精简并重新确认大纲。'; return ''; }
}
export function refreshOutlineInjection(): void {
  getContext()?.setExtensionPrompt?.(OUTLINE_INJECT_KEY, buildOutlineInjection(), 1, 0, false, 0);
}
export async function generateOutline(brief: string, chapterCount = 6, refinement?: OutlineRefinement): Promise<void> {
  if (outlineRun.busy || discussionRun.busy || discussionState.saving) return;
  outlineRun.error = ''; outlineRun.status = ''; outlineRun.draft = '';
  let own = 0;
  let phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  try {
    if (!engineActiveHere()) throw new Error('请先启用当前角色的棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再生成大纲。');
    if (!brief.trim() || brief.length > 8000) throw new Error('请填写1～8000字的创作要求。');
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 12) throw new Error('大纲阶段数须为1～12。');
    const ctx = getContext(); if (!ctx?.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const issue = outlineWriteIssue(); if (issue) throw new Error(issue);
    const channel = resolveOutlineChannel();
    const source = captureOutlineSource(ctx), revision = outlineState.revision;
    const discussionRevision = discussionState.revision;
    const baseInput = buildOutlineContext(ctx, brief.trim(), chapterCount);
    const input = refinement ? addRefinementContext(baseInput, refinement) : baseInput;
    const ctrl = new AbortController(); controller = ctrl; own = ++runId;
    outlineRun.busy = true;
    outlineRun.status = outlineSettings.apiMode === 'notes' ? '正在使用札记 API 生成独立大纲草稿…' : '正在使用大纲专用 API 生成草稿…';
    const current = () => own === runId && !ctrl.signal.aborted && outlineInputUnchanged(source, true) &&
      outlineState.revision === revision && engineActiveHere()
      && (!refinement || (discussionState.revision === discussionRevision && !discussionWriteIssue()));
    stillCurrent = current;
    phase = 'request';
    const reply = await requestCompletion(channel, input, {
      signal: ctrl.signal, onDelta: text => { if (current()) outlineRun.draft = text.slice(0, OUTLINE_LIMITS.reply); },
    });
    if (!current()) {
      if (own === runId) outlineRun.status = '正文、聊天或大纲已变化，旧生成结果未采用。';
      return;
    }
    phase = 'parse';
    const content = parseOutlineReply(reply);
    if (content.chapters.length !== chapterCount) throw new Error(`返回的大纲阶段数不符：要求${chapterCount}个，实际${content.chapters.length}个；请重新生成，旧大纲未替换。`);
    phase = 'save';
    await commitGeneratedOutline({ id: crypto.randomUUID(), createdAt: Date.now(), sourceFloor: source.floor,
      sourceHash: source.hash, brief: brief.trim(), content }, revision);
    if (own === runId && sameOutlineChat(source)) outlineRun.status = '草稿已保存。请编辑核对并确认启用；当前正文指引尚未替换。';
  } catch (error) {
    if (own && own !== runId) return;
    const message = error instanceof Error ? error.message : '';
    outlineRun.error = phase !== 'request' ? message.slice(0, 250)
      : /超时/.test(message) ? '大纲生成超时，请检查接口或调整超时后重试；没有自动重复请求。'
      : '大纲生成未完成，请检查所选 API 地址、模型和密钥；现有大纲未替换。';
    outlineRun.status = '';
  } finally {
    if (!own || own === runId) { outlineRun.busy = false; outlineRun.draft = ''; controller = undefined; stillCurrent = undefined; }
  }
}
export function bindOutlineLifecycle(): void {
  if (unbind) return;
  const ctx = getContext(); if (!ctx) return;
  loadOutline(); loadOutlineDiscussion(); refreshOutlineInjection();
  let observed = captureOutlineSource(ctx);
  const handlers: Array<[string, (...args: any[]) => void]> = [];
  const on = (name: string, fn: (...args: any[]) => void) => {
    const event = ctx.eventTypes[name]; if (event) { ctx.eventSource.on(event, fn); handlers.push([event, fn]); }
  };
  on('CHAT_CHANGED', () => {
    cancelOutline(); cancelOutlineDiscussion(); generationBusy = false; loadOutline(); loadOutlineDiscussion();
    const now = getContext(); if (now) observed = captureOutlineSource(now);
    outlineRun.status = ''; outlineRun.error = ''; discussionRun.status = ''; discussionRun.error = ''; refreshOutlineInjection();
  });
  on('GENERATION_STARTED', (type: unknown, _options: unknown, dryRun?: boolean) => {
    if (dryRun || type === 'quiet' || type === 'impersonate') return;
    if (outlineRun.busy) cancelOutline();
    if (discussionRun.busy) cancelOutlineDiscussion();
    generationBusy = true; refreshOutlineInjection();
  });
  on('GENERATION_ENDED', () => { generationBusy = false; refreshOutlineInjection(); });
  on('GENERATION_STOPPED', () => { generationBusy = false; });
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT']) on(event, () => {
    if (outlineRun.busy && stillCurrent && !stillCurrent()) cancelOutline();
    if (discussionRun.busy && discussionCurrent && !discussionCurrent()) cancelOutlineDiscussion();
    // revision驱动UI重算来源状态；普通追加正文不改已确认大纲的前缀指纹。
    // 摘要附加托管标记、隐藏已摘要楼层不属于正文修改，不打断生成。
    if (!outlineInputUnchanged(observed, true)) {
      outlineState.revision++;
      const now = getContext(); if (now) observed = captureOutlineSource(now);
    }
    refreshOutlineInjection();
  });
  const stop = watch(() => [outlineState.revision, outlineState.saving, engineActiveHere()], () => {
    if (!engineActiveHere() && outlineRun.busy) cancelOutline();
    if (discussionRun.busy && discussionCurrent && !discussionCurrent()) cancelOutlineDiscussion();
    refreshOutlineInjection();
  }, { flush: 'sync' });
  unbind = () => {
    cancelOutline(); cancelOutlineDiscussion(); stop(); generationBusy = false;
    for (const [event, fn] of handlers) ctx.eventSource.off?.(event, fn);
    ctx.setExtensionPrompt?.(OUTLINE_INJECT_KEY, '', 1, 0, false, 0);
  };
  window.addEventListener('pagehide', unbindOutlineLifecycle, { once: true });
}
export function unbindOutlineLifecycle(): void {
  unbind?.(); unbind = undefined;
  window.removeEventListener('pagehide', unbindOutlineLifecycle);
}
