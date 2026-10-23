import { reactive, watch } from 'vue';
import { requestCompletion } from '@/api/client';
import { describeFailure, partialReply, type ApiError } from '@/api/errors';
import { getContext } from '@/st/context';
import { engineActiveHere } from '@/api/settings';
import { notesSettings, validateNotesChannel, settingsIssue } from './settings';
import { loadNotes, notesState, addNote, activeDecisions, notesWriteIssue, sameNoteSource } from './store';
import { sourceHash, sameChat, latestStoryFloor, floorHash } from './source';
import { noteText, parseQuestions, isNoNoteReply } from './protocol';
import { stripThinkBlocks } from '@/memory/timeTag';
import { buildNotesContext } from './context';
import { memoryBudgetLimited } from './memoryDigest';
/**
 * floor:最近一次生成针对的楼层(进行中或刚结束),聊天里的札记卡片据此在对应楼层显示进度和结果;
 * 生成前的检查没通过时为 null。storyBusy:正文正在生成,这期间不能生成札记。
 */
export const notesRun = reactive({ busy:false, draft:'', error:'', errorDetail:'', status:'', floor:null as number|null, storyBusy:false });
export const NOTES_INJECT_KEY = 'prism_book_notes_confirmed';
const NOTES_SETTINGS_PATH = '札记 → 独立 API 设置';
/** 这些是札记自己写的说明,可以原样展示;其余异常可能带上游原文,只给分类后的说明。 */
const OWN_MESSAGES = /札记保存失败|札记返回过长|没有返回可用内容|正文已经变化/;
/** 截断/审核中断的札记仍然保存,但在正文末尾标明,免得被当成完整内容。 */
function cutNotice(error: ApiError): string {
  if (error.kind === 'truncated') return '\n\n（札记在这里被截断：输出达到了长度上限，后面的内容没有写出来。）';
  if (error.kind === 'filtered') return '\n\n（札记在这里被服务商的内容审核截断。）';
  return '\n\n（札记在这里中断：服务商没有写完。）';
}
let controller: AbortController | undefined, runId=0;
let stillCurrent: (()=>boolean) | undefined;
let generationBusy=false, autoAllowed=false, rendered=false, bound=false;
let timer: ReturnType<typeof setTimeout> | undefined;
let dispose: (()=>void) | undefined;
export function cancelNotes(): void {
  // 正文每次开始生成都会调用这里;没有札记在生成时不写「已取消」,免得界面上出现没发生过的取消
  const wasBusy=notesRun.busy;
  runId++; stillCurrent=undefined; controller?.abort(); controller=undefined; notesRun.busy=false; notesRun.draft='';
  if (wasBusy) notesRun.status='已取消，原有札记没有变动。';
}
/** 填写了记忆注入预算时，注入正文的安排清单最多这么多字（只算清单本身）。预算为 0（默认）时不限制。 */
export const NOTES_INJECTION_LIMIT = 16000;
export interface ConfirmedInjectionPlan {
  text: string;
  /** 实际注入的安排条数 */
  injected: number;
  /** 因超出上限没有注入的条数 */
  omitted: number;
  /** 仍要落实的安排总数（待兑现、进行中） */
  total: number;
}
/**
 * 注入正文的已确认安排。顺序：进行中的在前，待兑现的按确认时间从新到旧。
 * 记忆注入预算为 0（默认）时全部注入；填写了预算时清单最多 16000 字，按上面的顺序放入放得下的，其余这一轮不注入（页面显示条数）。
 */
export function confirmedInjectionPlan(): ConfirmedInjectionPlan {
  const none: ConfirmedInjectionPlan = { text: '', injected: 0, omitted: 0, total: 0 };
  if (!notesSettings.enabled || !notesSettings.injectConfirmed || settingsIssue.value || !engineActiveHere()) return none;
  const list=activeDecisions(); if (!list.length) return none;
  const ordered=[...list.filter(d=>d.status==='in_progress'), ...list.filter(d=>d.status==='pending').sort((a,b)=>b.createdAt-a.createdAt)];
  const limit=memoryBudgetLimited() ? NOTES_INJECTION_LIMIT : Infinity;
  const lines: string[]=[]; let used=0, omitted=0;
  for (const d of ordered) {
    const line='['+(d.status==='in_progress'?'进行中':'未动笔')+'] '+d.text;
    const cost=line.length+(lines.length?1:0);
    if (used+cost>limit) { omitted++; continue; }
    lines.push(line); used+=cost;
  }
  if (!lines.length) return { ...none, omitted, total: ordered.length };
  const text='[戏外已确认的后续创作安排，不是已发生的剧情事实]\n仅下列用户已确认安排可逐步落实；按当前节奏每轮推进一小步，不一次写完。角色不知道这份清单。未确认札记提案不可提前兑现；不要模仿输出札记、清单或aftertalk标签。摘要只记录正文真正发生的事件，不把这些安排登记为已完成。\n'+lines.join('\n')+'\n[戏外安排结束]';
  return { text, injected: lines.length, omitted, total: ordered.length };
}
export function buildConfirmedInjection(): string {
  return confirmedInjectionPlan().text;
}
export function refreshNotesInjection(): void {
  getContext()?.setExtensionPrompt?.(NOTES_INJECT_KEY,buildConfirmedInjection(),1,0,false,0);
}
export async function generateNotes(force=false): Promise<void> {
  if (notesRun.busy) return;
  notesRun.error=''; notesRun.errorDetail=''; notesRun.status=''; notesRun.draft=''; notesRun.floor=null;
  let own=0;
  try {
    if (!notesSettings.enabled) throw new Error('请先打开「启用双子札记」。');
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再生成札记。');
    validateNotesChannel();
    const ctx=getContext(); if (!ctx || !ctx.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const storageIssue=notesWriteIssue(); if (storageIssue) throw new Error(storageIssue);
    const floor=latestStoryFloor(ctx); if (floor<0) throw new Error('当前聊天还没有可以写札记的正文。');
    notesRun.floor=floor;
    const hash=sourceHash(ctx,floor), fh=floorHash(ctx.chat[floor]), swipe=ctx.chat[floor].swipe_id??0, allHash=sourceHash(ctx,ctx.chat.length-1), count=ctx.chat.length, chatId=ctx.getCurrentChatId();
    if (!force && notesState.records.some(r=>sameNoteSource(r,{floor,swipe,sourceHash:hash,floorHash:fh}))) { notesRun.status='这段正文已经有札记了；想要另一版请点「重新生成」。'; return; }
    const revision=notesState.revision;
    controller=new AbortController(); const ctrl=controller; own=++runId; notesRun.busy=true; notesRun.status='正在生成札记…';
    const current=()=> own===runId && !ctrl.signal.aborted && sameChat(ctx) && getContext()?.getCurrentChatId()===chatId && ctx.chat.length===count && sourceHash(ctx,count-1)===allHash && notesState.revision===revision && notesSettings.enabled;
    stillCurrent=current;
    let reply: string, cut: ApiError | undefined;
    try {
      reply=await requestCompletion(JSON.parse(JSON.stringify(notesSettings.channel)),buildNotesContext(ctx),{signal:ctrl.signal,onDelta:(text)=>{ if (current()) notesRun.draft=text.slice(0,80000); }});
    } catch (error) {
      // 写到一半被截断的札记仍有价值:保存已写出的部分并明确标注,而不是整份丢弃。
      const partial=stripThinkBlocks(partialReply(error));
      if (!partial.trim() || !current() || !noteText(partial)) throw error;
      reply=partial; cut=error as ApiError;
    }
    if (!current()) { if (own===runId) {notesRun.draft=''; notesRun.status='聊天或正文已经变化，这次的结果没有采用。';} return; }
    const body=noteText(reply); if (!body) throw new Error('札记 API 没有返回可用内容。');
    // 模型认为本轮不需要札记时不保存：保存下来会成为下一次请求里的「上一份札记」，挤掉真正的进度清单和待确认提案。
    if (!cut && isNoNoteReply(body)) {
      if (own===runId && sameChat(ctx)) { notesRun.draft=''; notesRun.status='模型认为本轮无需新增札记，没有保存新的札记；需要时可再次生成。'; }
      return;
    }
    const text=cut ? body+cutNotice(cut) : body;
    await addNote({id:crypto.randomUUID(),createdAt:Date.now(),floor,swipe,sourceHash:hash,floorHash:fh,text,questions:parseQuestions(text)});
    if (own===runId && sameChat(ctx)) {
      notesRun.draft='';
      if (cut) {
        const view=describeFailure(cut,'',NOTES_SETTINGS_PATH);
        notesRun.status='札记已保存，但内容不完整：'+view.message; notesRun.errorDetail=view.detail;
      } else notesRun.status='札记已保存。里面的提案要你确认后才会成为安排。';
      refreshNotesInjection();
    }
  } catch (error) {
    if (own && own!==runId) return;
    const message=error instanceof Error?error.message:'';
    if (!own || OWN_MESSAGES.test(message)) notesRun.error=message;
    else {
      // 不把可能包含API密钥、请求体或上游日志的原始错误展示出来;ApiError 已是分类后的说明。
      const view=describeFailure(error,'札记请求没有完成，请检查札记的独立 API 设置后重试',NOTES_SETTINGS_PATH);
      notesRun.error=view.message+'已有札记没有被替换。'; notesRun.errorDetail=view.detail;
    }
    notesRun.status=''; notesRun.draft='';
  } finally { if (!own || own===runId) {notesRun.busy=false; controller=undefined; stillCurrent=undefined;} }
}
export function bindNotesLifecycle(): void {
  if (bound) return; const ctx=getContext(); if (!ctx) return; bound=true; loadNotes(); refreshNotesInjection();
  const handlers: Array<[string,(...args:any[])=>void]>=[];
  const on=(name:string,fn:(...args:any[])=>void)=>{const event=ctx.eventTypes[name]; if(event){ctx.eventSource.on(event,fn); handlers.push([event,fn]);}};
  const clearTimer=()=>{if(timer)clearTimeout(timer);timer=undefined;};
  on('CHAT_CHANGED',()=>{clearTimer();cancelNotes();generationBusy=false;notesRun.storyBusy=false;autoAllowed=false;loadNotes();notesRun.status='';notesRun.error='';notesRun.errorDetail='';notesRun.floor=null;refreshNotesInjection();});
  on('GENERATION_STARTED',(type:unknown,_options:unknown,dryRun?:boolean)=>{
    if (dryRun || type==='quiet' || type==='impersonate') return;
    clearTimer();cancelNotes();generationBusy=true;notesRun.storyBusy=true;rendered=false;autoAllowed=type==null || ['normal','regenerate','swipe','continue'].includes(String(type));refreshNotesInjection();
  });
  on('CHARACTER_MESSAGE_RENDERED',(_floor:unknown,type:unknown)=>{if(autoAllowed && type!=='quiet' && type!=='impersonate' && type!=='first_message')rendered=true;});
  on('GENERATION_STOPPED',()=>{clearTimer();generationBusy=false;notesRun.storyBusy=false;autoAllowed=false;rendered=false;});
  on('GENERATION_ENDED',()=>{
    const eligible=autoAllowed && rendered;autoAllowed=false;rendered=false;generationBusy=false;notesRun.storyBusy=false;
    if (!eligible || !notesSettings.enabled || !notesSettings.autoGenerate || !engineActiveHere()) return;
    const source=getContext(); if(!source)return; const chatId=source.getCurrentChatId(), count=source.chat.length, hash=sourceHash(source,count-1);
    clearTimer(); timer=setTimeout(()=>{timer=undefined;if(notesSettings.enabled && notesSettings.autoGenerate && engineActiveHere() && sameChat(source) && getContext()?.getCurrentChatId()===chatId && source.chat.length===count && sourceHash(source,count-1)===hash)void generateNotes();},500);
  });
  for (const e of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SENT']) on(e,()=>{
    // 摘要附加托管旁注或隐藏旧楼，不应打断独立札记；真正来源变化才取消。
    if (!stillCurrent || !stillCurrent()) { if(notesRun.busy)cancelNotes(); notesState.revision++; }
    refreshNotesInjection();
  });
  const stop=watch(()=>[notesSettings.enabled,notesSettings.injectConfirmed,engineActiveHere(),notesState.revision],()=>{if(!notesSettings.enabled)cancelNotes();refreshNotesInjection();});
  dispose=()=>{clearTimer();cancelNotes();stop();for(const [e,fn]of handlers)ctx.eventSource.off?.(e,fn);ctx.setExtensionPrompt?.(NOTES_INJECT_KEY,'',1,0,false,0);bound=false;};
  window.addEventListener('pagehide',unbindNotesLifecycle,{once:true});
}
export function unbindNotesLifecycle(): void {dispose?.();dispose=undefined;window.removeEventListener('pagehide',unbindNotesLifecycle);}
