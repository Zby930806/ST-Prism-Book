import { reactive, watch } from 'vue';
import { requestCompletion } from '@/api/client';
import { getContext } from '@/st/context';
import { engineActiveHere } from '@/api/settings';
import { notesSettings, validateNotesChannel, settingsIssue } from './settings';
import { loadNotes, notesState, addNote, activeDecisions, notesWriteIssue } from './store';
import { sourceHash, sameChat, latestStoryFloor } from './source';
import { noteText, parseQuestions } from './protocol';
import { buildNotesContext } from './context';
export const notesRun = reactive({ busy:false, draft:'', error:'', status:'' });
export const NOTES_INJECT_KEY = 'prism_book_notes_confirmed';
let controller: AbortController | undefined, runId=0;
let stillCurrent: (()=>boolean) | undefined;
let generationBusy=false, autoAllowed=false, rendered=false, bound=false;
let timer: ReturnType<typeof setTimeout> | undefined;
let dispose: (()=>void) | undefined;
export function cancelNotes(): void {
  runId++; stillCurrent=undefined; controller?.abort(); controller=undefined; notesRun.busy=false; notesRun.draft=''; notesRun.status='已取消，已有札记保持不变。';
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
  notesRun.error=''; notesRun.status=''; notesRun.draft='';
  let own=0;
  try {
    if (!notesSettings.enabled) throw new Error('请先启用双子札记。');
    if (!engineActiveHere()) throw new Error('请先启用当前角色的棱镜宝书。');
    if (generationBusy) throw new Error('请等正文生成结束后再生成札记。');
    validateNotesChannel();
    const ctx=getContext(); if (!ctx || !ctx.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
    const storageIssue=notesWriteIssue(); if (storageIssue) throw new Error(storageIssue);
    const floor=latestStoryFloor(ctx); if (floor<0) throw new Error('当前聊天没有可供札记阅读的正文。');
    const hash=sourceHash(ctx,floor), allHash=sourceHash(ctx,ctx.chat.length-1), count=ctx.chat.length, chatId=ctx.getCurrentChatId();
    if (!force && notesState.records.some(r=>r.floor===floor && r.sourceHash===hash)) { notesRun.status='这段正文已有札记；如需另一版，请点重新生成。'; return; }
    const revision=notesState.revision;
    controller=new AbortController(); const ctrl=controller; own=++runId; notesRun.busy=true; notesRun.status='正在使用札记独立 API…';
    const current=()=> own===runId && !ctrl.signal.aborted && sameChat(ctx) && getContext()?.getCurrentChatId()===chatId && ctx.chat.length===count && sourceHash(ctx,count-1)===allHash && notesState.revision===revision && notesSettings.enabled;
    stillCurrent=current;
    const reply=await requestCompletion(JSON.parse(JSON.stringify(notesSettings.channel)),buildNotesContext(ctx),{signal:ctrl.signal,onDelta:(text)=>{ if (current()) notesRun.draft=text.slice(0,80000); }});
    if (!current()) { if (own===runId) {notesRun.draft=''; notesRun.status='聊天或正文已变化，已丢弃这次旧结果。';} return; }
    const text=noteText(reply); if (!text) throw new Error('札记 API 没有返回可用内容。');
    await addNote({id:crypto.randomUUID(),createdAt:Date.now(),floor,swipe:ctx.chat[floor].swipe_id??0,sourceHash:hash,text,questions:parseQuestions(text)});
    if (own===runId && sameChat(ctx)) { notesRun.draft=''; notesRun.status='札记已保存；提案不会自动成为剧情。'; refreshNotesInjection(); }
  } catch (error) {
    if (own && own!==runId) return;
    // 不把可能包含API密钥、请求体或上游日志的网络错误原样展示。
    const message=error instanceof Error?error.message:'';
    notesRun.error = !own ? message : /札记保存失败|札记返回过长|没有返回可用内容|正文已经变化/.test(message) ? message : /超时/.test(message) ? '札记请求超时，可提高独立 API 超时后重试。' : '札记请求未完成，请检查独立 API 地址、模型和密钥；已有札记未替换。';
    notesRun.status=''; notesRun.draft='';
  } finally { if (!own || own===runId) {notesRun.busy=false; controller=undefined; stillCurrent=undefined;} }
}
export function bindNotesLifecycle(): void {
  if (bound) return; const ctx=getContext(); if (!ctx) return; bound=true; loadNotes(); refreshNotesInjection();
  const handlers: Array<[string,(...args:any[])=>void]>=[];
  const on=(name:string,fn:(...args:any[])=>void)=>{const event=ctx.eventTypes[name]; if(event){ctx.eventSource.on(event,fn); handlers.push([event,fn]);}};
  const clearTimer=()=>{if(timer)clearTimeout(timer);timer=undefined;};
  on('CHAT_CHANGED',()=>{clearTimer();cancelNotes();generationBusy=false;autoAllowed=false;loadNotes();notesRun.status='';notesRun.error='';refreshNotesInjection();});
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
