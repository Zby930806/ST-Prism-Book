import { reactive, watch } from 'vue';
import { requestCompletion } from '@/api/client';
import { ApiError, apiFailure, describeFailure, looksLikeUnfinishedJson, partialReply } from '@/api/errors';
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
export const outlineRun = reactive({ busy: false, draft: '', error: '', errorDetail: '', status: '' });
let controller: AbortController | undefined;
let runId = 0;
let generationBusy = false;
let stillCurrent: (() => boolean) | undefined;
let unbind: (() => void) | undefined;
export const discussionRun = reactive({ busy: false, error: '', errorDetail: '', status: '' });
let discussionController: AbortController | undefined;
let discussionRunId = 0;
let discussionCurrent: (() => boolean) | undefined;

/** 出错时告诉用户该去哪里改：复用札记时改札记的 API，专用模式改规划 API。 */
function outlineSettingsPath(): string {
  return outlineSettings.apiMode === 'notes' ? '札记 → 独立 API 设置（大纲目前复用札记的 API）' : '计划 → 规划 API 设置';
}

/** ApiError 已是分类后的说明，可以展示；其它请求异常可能带上游原文，只给通用说明。 */
function requestFailure(error: unknown, fallback: string, tail: string): { error: string; detail: string } {
  const view = describeFailure(error, fallback, outlineSettingsPath());
  const extra = error instanceof ApiError && error.kind === 'truncated' && tail.includes('大纲') ? '也可以减少规划阶段数。' : '';
  return { error: view.message + extra + tail, detail: view.detail };
}

export function cancelOutlineDiscussion(): void {
  ++discussionRunId; discussionController?.abort(); discussionController = undefined; discussionCurrent = undefined;
  discussionRun.busy = false; discussionRun.status = '已取消，讨论记录和大纲都没有变动。';
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
/** 讨论回复写到一半被截断时仍可保存，末尾标明，长度不超过存储上限。 */
function cutDiscussionReply(partial: string, error: ApiError): string {
  const note = error.kind === 'truncated' ? '\n\n（回复在这里被截断：输出达到了长度上限。）' : '\n\n（回复在这里被中断，没有写完。）';
  const answer = discussionReply(partial.slice(0, 100000));
  return answer.slice(0, 8000 - note.length) + note;
}
export async function sendOutlineDiscussion(question: string, target: DiscussionTarget): Promise<boolean> {
  if (discussionRun.busy || outlineRun.busy) return false;
  discussionRun.error = ''; discussionRun.errorDetail = ''; discussionRun.status = '';
  let own = 0, phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  try {
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再讨论大纲。');
    if (!question.trim() || question.length > 4000) throw new Error('讨论问题须为1～4000字符。');
    if (discussionState.messages.length >= 24) throw new Error('讨论已经满12轮，请先清空讨论再继续；大纲不会被清除。');
    if (discussionState.messages.reduce((n, m) => n + m.content.length, 0) + question.length >= 48000)
      throw new Error('讨论记录快到48000字的上限了，请先清空讨论或缩短问题。');
    const ctx = getContext(); if (!ctx?.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const reference = captureOutlineRefinement(target);
    const channel = resolveOutlineChannel(), source = captureOutlineSource(ctx);
    const revision = outlineState.revision, discussionRevision = discussionState.revision;
    const input = buildDiscussionContext(ctx, question, reference);
    const ctrl = new AbortController(); discussionController = ctrl; own = ++discussionRunId;
    discussionRun.busy = true; discussionRun.status = '正在等待规划模型回复…';
    const current = () => own === discussionRunId && !ctrl.signal.aborted && outlineInputUnchanged(source, true)
      && outlineState.revision === revision && outlineStorageCurrent() && discussionState.revision === discussionRevision && engineActiveHere();
    discussionCurrent = current;
    phase = 'request';
    let answer: string | undefined;
    try {
      const raw = await requestCompletion(channel, input, { signal: ctrl.signal });
      if (!current()) {
        if (own === discussionRunId) discussionRun.status = '聊天、正文或大纲已经变化，这条回复没有采用。';
        return false;
      }
      phase = 'parse'; answer = discussionReply(raw);
    } catch (error) {
      const partial = partialReply(error);
      if (!partial || !current()) throw error;
      // 只剩思考、没有可见回答时,按原来的截断错误说明。
      try { answer = cutDiscussionReply(partial, error as ApiError); } catch { throw error; }
      phase = 'parse';
    }
    phase = 'save'; await appendDiscussionTurn(question.trim(), answer, discussionRevision, source);
    if (own !== discussionRunId || !sameOutlineChat(source)) return false;
    discussionRun.status = '已保存这一轮讨论，大纲没有改动。想采纳的话，点「按讨论生成草稿」再确认加入计划。';
    return true;
  } catch (error) {
    if (own && own !== discussionRunId) return false;
    if (phase === 'request') {
      const failure = requestFailure(error, '讨论没有完成，请检查规划 API 后重试', '原有讨论没有变化。');
      discussionRun.error = failure.error; discussionRun.errorDetail = failure.detail;
    } else discussionRun.error = error instanceof Error ? error.message.slice(0, 250) : '讨论没有完成，请重试。';
    discussionRun.status = '';
    return false;
  } finally {
    if (!own || own === discussionRunId) { discussionRun.busy = false; discussionController = undefined; discussionCurrent = undefined; }
  }
}

export function cancelOutline(): void {
  ++runId; controller?.abort(); controller = undefined; stillCurrent = undefined;
  outlineRun.busy = false; outlineRun.draft = ''; outlineRun.status = '已取消生成，现有草稿和规划都没有变动。';
}
export function buildOutlineInjection(): string {
  if (!engineActiveHere() || outlineState.saving || !outlineStorageCurrent()) return '';
  const active = outlineState.active;
  if (!active?.enabled || !outlineSourceCurrent(active)) return '';
  try { return renderOutlineGuidance(active); }
  catch { outlineRun.status = '当前阶段太长，没有发给正文；请精简后重新确认。'; return ''; }
}
export function refreshOutlineInjection(): void {
  getContext()?.setExtensionPrompt?.(OUTLINE_INJECT_KEY, buildOutlineInjection(), 1, 0, false, 0);
}
export async function generateOutline(brief: string, chapterCount = 6, refinement?: OutlineRefinement): Promise<void> {
  if (outlineRun.busy || discussionRun.busy || discussionState.saving) return;
  outlineRun.error = ''; outlineRun.errorDetail = ''; outlineRun.status = ''; outlineRun.draft = '';
  let own = 0;
  let phase: 'preflight' | 'request' | 'parse' | 'save' = 'preflight';
  try {
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
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
    outlineRun.status = outlineSettings.apiMode === 'notes' ? '正在用札记的 API 生成大纲草稿…' : '正在用规划专用 API 生成大纲草稿…';
    const current = () => own === runId && !ctrl.signal.aborted && outlineInputUnchanged(source, true) &&
      outlineState.revision === revision && engineActiveHere()
      && (!refinement || (discussionState.revision === discussionRevision && !discussionWriteIssue()));
    stillCurrent = current;
    phase = 'request';
    // 大纲协议只接受完整的单个 JSON;截断的回复一律按截断说明,不拿半截内容拼凑。
    const reply = await requestCompletion(channel, input, {
      signal: ctrl.signal, onDelta: text => { if (current()) outlineRun.draft = text.slice(0, OUTLINE_LIMITS.reply); },
    });
    if (!current()) {
      if (own === runId) outlineRun.status = '正文、聊天或大纲已经变化，这次生成的结果没有采用。';
      return;
    }
    // 拿不到结束原因的服务商:JSON 写到一半就结束,按截断处理,而不是笼统的格式错误。
    if (looksLikeUnfinishedJson(reply)) {
      throw apiFailure('truncated', '大纲回复不完整（JSON 写到一半就结束了），多半是输出达到了长度上限', '请调大该 API 的「最大输出」。');
    }
    phase = 'parse';
    const content = parseOutlineReply(reply);
    if (content.chapters.length !== chapterCount) throw new Error(`模型给的阶段数不对：要求${chapterCount}个，实际${content.chapters.length}个。请重新生成，现有大纲没有被替换。`);
    phase = 'save';
    await commitGeneratedOutline({ id: crypto.randomUUID(), createdAt: Date.now(), sourceFloor: source.floor,
      sourceHash: source.hash, brief: brief.trim(), content }, revision);
    if (own === runId && sameOutlineChat(source)) outlineRun.status = '草稿已保存。核对修改后确认加入计划才会生效，现在正文用的规划没有变。';
  } catch (error) {
    if (own && own !== runId) return;
    if (phase === 'request' || error instanceof ApiError) {
      const failure = requestFailure(error, '大纲生成没有完成，请检查所选规划 API 后重试', '现有大纲没有被替换。');
      outlineRun.error = failure.error; outlineRun.errorDetail = failure.detail;
    } else outlineRun.error = (error instanceof Error ? error.message : '').slice(0, 250);
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
    outlineRun.status = ''; outlineRun.error = ''; outlineRun.errorDetail = ''; discussionRun.status = ''; discussionRun.error = ''; discussionRun.errorDetail = ''; refreshOutlineInjection();
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
