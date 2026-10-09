import { reactive, watch } from 'vue';
import { requestCompletion } from '@/api/client';
import { describeFailure, partialReply, type ApiError } from '@/api/errors';
import { getContext } from '@/st/context';
import { engineActiveHere } from '@/api/settings';
import { notesSettings, validateNotesChannel, settingsIssue } from './settings';
import { loadNotes, notesState, addNote, activeDecisions, notesWriteIssue } from './store';
import { sourceHash, sameChat, latestStoryFloor } from './source';
import { noteText, parseQuestions } from './protocol';
import { stripThinkBlocks } from '@/memory/timeTag';
import { buildNotesContext } from './context';
export const notesRun = reactive({ busy:false, draft:'', error:'', errorDetail:'', status:'' });
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
  runId++; stillCurrent=undefined; controller?.abort(); controller=undefined; notesRun.busy=false; notesRun.draft=''; notesRun.status='已取消，原有札记没有变动。';
}
export function buildConfirmedInjection(): string {
  if (!notesSettings.enabled || !notesSettings.injectConfirmed || settingsIssue.value || !engineActiveHere()) return '';
  const list=activeDecisions(); if (!list.length) return '';
  const lines=list.map(d=>'['+(d.status==='in_progress'?'进行中':'未动笔')+'] '+d.text);
  // 不静默丢掉一半决策，不生成畸形协议；超限时要求用户清理后再注入。
  if (lines.join('\n').length>16000) { notesRun.status='未完成安排超过注入预算，请先完成或取消一部分；本轮未注入清单。'; return ''; }
  return '[戏外已确认的后续创作安排，不是已发生的剧情事实]\n仅下列用户已确认安排可逐步落实；按当前节奏每轮推进一小步，不一次写完。角色不知道这份清单。未确认札记提案不可提前兑现；不要模仿输出札记、清单或aftertalk标签。摘要只记录正文真正发生的事件，不把这些安排登记为已完成。\n'+lines.join('\n')+'\n[戏外安排结束]';
}
export function refreshNotesInjection(): void {
  getContext()?.setExtensionPrompt?.(NOTES_INJECT_KEY,buildConfirmedInjection(),1,0,false,0);
}
export async function generateNotes(force=false): Promise<void> {
  if (notesRun.busy) return;
  notesRun.error=''; notesRun.errorDetail=''; notesRun.status=''; notesRun.draft='';
  let own=0;
  try {
    if (!notesSettings.enabled) throw new Error('请先打开「启用双子札记」。');
    if (!engineActiveHere()) throw new Error('当前角色没有启用棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再生成札记。');
    validateNotesChannel();
    const ctx=getContext(); if (!ctx || !ctx.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const storageIssue=notesWriteIssue(); if (storageIssue) throw new Error(storageIssue);
    const floor=latestStoryFloor(ctx); if (floor<0) throw new Error('当前聊天还没有可以写札记的正文。');
    const hash=sourceHash(ctx,floor), allHash=sourceHash(ctx,ctx.chat.length-1), count=ctx.chat.length, chatId=ctx.getCurrentChatId();
    if (!force && notesState.records.some(r=>r.floor===floor && r.sourceHash===hash)) { notesRun.status='这段正文已经有札记了；想要另一版请点「重新生成」。'; return; }
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
    const text=cut ? body+cutNotice(cut) : body;
    await addNote({id:crypto.randomUUID(),createdAt:Date.now(),floor,swipe:ctx.chat[floor].swipe_id??0,sourceHash:hash,text,questions:parseQuestions(text)});
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
  on('CHAT_CHANGED',()=>{clearTimer();cancelNotes();generationBusy=false;autoAllowed=false;loadNotes();notesRun.status='';notesRun.error='';notesRun.errorDetail='';refreshNotesInjection();});
  on('GENERATION_STARTED',(type:unknown,_options:unknown,dryRun?:boolean)=>{
    if (dryRun || type==='quiet' || type==='impersonate') return;
    clearTimer();cancelNotes();generationBusy=true;rendered=false;autoAllowed=type==null || ['normal','regenerate','swipe','continue'].includes(String(type));refreshNotesInjection();
  });
  on('CHARACTER_MESSAGE_RENDERED',(_floor:unknown,type:unknown)=>{if(autoAllowed && type!=='quiet' && type!=='impersonate' && type!=='first_message')rendered=true;});
  on('GENERATION_STOPPED',()=>{clearTimer();generationBusy=false;autoAllowed=false;rendered=false;});
  on('GENERATION_ENDED',()=>{
    const eligible=autoAllowed && rendered;autoAllowed=false;rendered=false;generationBusy=false;
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
