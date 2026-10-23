import { reactive } from 'vue';
import { getContext } from '@/st/context';
import type { STContext } from '@/st/context';
import type { NotesData, NoteRecord, NoteDecision } from './types';
import { extractAftertalk, parseQuestions } from './protocol';
import { sourceHash, sameChat, floorHash } from './source';
export const NOTES_DATA_KEY = 'prism_book_notes';
export const notesState = reactive<{ records: NoteRecord[]; decisions: NoteDecision[]; issue: string; revision: number }>({ records: [], decisions: [], issue: '', revision: 0 });
let loadedChat: STContext['chat'] | undefined, loadedId: string | undefined, protectedData = false, saving = false;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const statuses = new Set(['pending','in_progress','completed','cancelled','rejected']);
const str = (v: unknown): v is string => typeof v === 'string';
function validData(v: any): v is NotesData {
  if (!v || v.version !== 1 || !Array.isArray(v.records) || !Array.isArray(v.decisions)) return false;
  const ids = new Set<string>();
  for (const r of v.records) {
    if (!r || !str(r.id) || ids.has(r.id) || !Number.isFinite(r.createdAt) || !Number.isInteger(r.floor) || r.floor<0 || !Number.isInteger(r.swipe) || r.swipe<0 || !str(r.sourceHash) || (r.floorHash!==undefined && !str(r.floorHash)) || !str(r.text) || !Array.isArray(r.questions)) return false;
    ids.add(r.id); const qs = new Set<string>();
    for (const q of r.questions) { if (!q || !str(q.id) || qs.has(q.id) || !str(q.label) || !str(q.prompt) || !str(q.proposal)) return false; qs.add(q.id); }
  }
  const decisionIds = new Set<string>(), pairs = new Set<string>();
  for (const d of v.decisions) {
    const r = v.records.find((r: NoteRecord) => r.id === d?.noteId), pair = d?.noteId+'|'+d?.questionId;
    if (!d || !str(d.id) || decisionIds.has(d.id) || pairs.has(pair) || !r?.questions.some((q: any) => q.id === d.questionId) || !str(d.text) || !statuses.has(d.status) || !Number.isFinite(d.createdAt)) return false;
    decisionIds.add(d.id); pairs.add(pair);
  }
  return true;
}
export function loadNotes(): void {
  const ctx=getContext(); loadedChat=ctx?.chat; loadedId=ctx?.getCurrentChatId(); protectedData=false;
  notesState.records=[]; notesState.decisions=[]; notesState.issue=''; notesState.revision++;
  const raw=ctx?.chatMetadata?.[NOTES_DATA_KEY]; if (raw==null) return;
  if (!validData(raw)) { protectedData=true; notesState.issue='这个聊天的札记数据格式认不出来，已经只读保护，不会覆盖原数据。'; return; }
  notesState.records=clone(raw.records); notesState.decisions=clone(raw.decisions);
}
function context(): STContext {
  const ctx=getContext();
  if (!ctx || !ctx.getCurrentChatId()) throw new Error('请先打开一个已保存的聊天。');
  if (ctx.chat!==loadedChat || ctx.getCurrentChatId()!==loadedId) loadNotes();
  if (protectedData) throw new Error(notesState.issue);
  return ctx;
}
/** 只读格式问题才持续阻断，网络保存错误允许用户直接重试。 */
export function notesWriteIssue(): string {
  try { context(); return ''; } catch (error) { return error instanceof Error ? error.message : '札记暂时没法保存。'; }
}
/** 仅替换自己的 metadata key；保存失败恢复原值，切聊后绝不更新新聊天状态。 */
async function persist(next: NotesData, ctx: STContext): Promise<void> {
  if (saving) throw new Error('札记正在保存，请稍等再试。');
  if (!sameChat(ctx)) throw new Error('聊天已经切换，这次的结果没有保存。');
  const id=ctx.getCurrentChatId(), previous=ctx.chatMetadata[NOTES_DATA_KEY];
  saving=true; ctx.chatMetadata[NOTES_DATA_KEY]=clone(next); const written=ctx.chatMetadata[NOTES_DATA_KEY];
  try {
    await ctx.saveMetadata();
    if (!sameChat(ctx) || getContext()?.getCurrentChatId()!==id) return;
    notesState.records=clone(next.records); notesState.decisions=clone(next.decisions); notesState.issue=''; notesState.revision++;
  } catch {
    if (ctx.chatMetadata[NOTES_DATA_KEY]===written) { if (previous===undefined) delete ctx.chatMetadata[NOTES_DATA_KEY]; else ctx.chatMetadata[NOTES_DATA_KEY]=previous; }
    if (sameChat(ctx)) notesState.issue='札记保存失败，这次操作没有完成，原有札记没有变动。';
    throw new Error('札记保存失败，请重试。');
  } finally { saving=false; }
}
function snapshot(): NotesData { return { version:1, records:clone(notesState.records), decisions:clone(notesState.decisions) }; }
/**
 * 札记依据的正文是否还在：新记录只核对札记所在楼本身（页码＋正文），更早楼层的改动、原生隐藏和改名不算；
 * 旧记录没有 floorHash，仍按从第 0 楼起的整段指纹核对。
 */
export function recordSourceIsCurrent(record: NoteRecord): boolean {
  const ctx=getContext(); if (!ctx || ctx.chat!==loadedChat || ctx.getCurrentChatId()!==loadedId) return false;
  const m=ctx.chat[record.floor];
  if (!m || m.is_user || (m.swipe_id??0)!==record.swipe) return false;
  if (record.floorHash) return floorHash(m)===record.floorHash;
  return (!m.is_system || !!m.extra?.bbs_hidden) && sourceHash(ctx,record.floor)===record.sourceHash;
}
/** 两份札记是否针对同一段正文（同一楼、同一页、正文相同）。 */
export function sameNoteSource(a: Pick<NoteRecord,'floor'|'swipe'|'sourceHash'|'floorHash'>, b: Pick<NoteRecord,'floor'|'swipe'|'sourceHash'|'floorHash'>): boolean {
  return a.floor===b.floor && a.swipe===b.swipe && (a.floorHash && b.floorHash ? a.floorHash===b.floorHash : a.sourceHash===b.sourceHash);
}
export function recordIsCurrent(record: NoteRecord): boolean {
  if (!recordSourceIsCurrent(record)) return false;
  const i=notesState.records.findIndex(r=>r.id===record.id);
  return i>=0 && !notesState.records.slice(i+1).some(r=>sameNoteSource(r,record));
}
/**
 * 仍要落实的安排（待兑现、进行中）。已确认的安排与札记来源解绑：札记所在楼被改写、重抽或删除后照常注入，
 * 页面在安排上标出「依据的正文已改动」，由用户决定是否取消。
 */
export function activeDecisions(): NoteDecision[] {
  return notesState.decisions.filter(d => d.status==='pending' || d.status==='in_progress');
}
/** 安排依据的札记所在楼是否已改动（改写、重抽或删除）。 */
export function decisionSourceChanged(decision: NoteDecision): boolean {
  const record=notesState.records.find(r=>r.id===decision.noteId);
  return !record || !recordSourceIsCurrent(record);
}
export async function addNote(record: NoteRecord): Promise<void> {
  const ctx=context(); if (!recordSourceIsCurrent(record)) throw new Error('正文已经变化，这份札记没有保存。');
  const next=snapshot(); next.records.push(record); await persist(next,ctx);
}
async function decide(noteId: string, questionId: string, text: string, reject: boolean): Promise<void> {
  const ctx=context(), note=notesState.records.find(r=>r.id===noteId);
  if (!note || !recordIsCurrent(note) || !note.questions.some(q=>q.id===questionId)) throw new Error('这份札记已经失效，或者问题不在了；请为当前正文重新生成札记。');
  const content=text.trim(); if (!reject && (!content || content.length>4000)) throw new Error('安排要写 1–4000 字。');
  const next=snapshot(), old=next.decisions.find(d=>d.noteId===noteId && d.questionId===questionId);
  const decision: NoteDecision={ id:old?.id??crypto.randomUUID(), noteId, questionId, text:reject ? (note.questions.find(q=>q.id===questionId)?.proposal || note.questions.find(q=>q.id===questionId)?.prompt || '') : content, status:reject?'rejected':'pending', createdAt:old?.createdAt??Date.now() };
  if (old) Object.assign(old,decision); else next.decisions.push(decision);
  // 明确取消/完成的安排不自动复活；只有再次点击确认才可重新启用。
  await persist(next,ctx);
}
export const confirmQuestion = (noteId: string, questionId: string, text: string) => decide(noteId,questionId,text,false);
export const rejectQuestion = (noteId: string, questionId: string) => decide(noteId,questionId,'',true);
export async function setDecisionStatus(id: string, status: 'pending'|'in_progress'|'completed'|'cancelled'): Promise<void> {
  const ctx=context(), next=snapshot(), d=next.decisions.find(x=>x.id===id);
  if (!d || !['pending','in_progress','completed','cancelled'].includes(status)) throw new Error('找不到这条安排，或者状态不对。');
  // 依据的正文改动后也可以重新启用：安排是用户确认的写作方向，是否继续由用户决定。
  d.status=status; await persist(next,ctx);
}
/** 删除一份札记，连同由它确认的全部安排（安排必须对应存在的札记与问题，见 validData）。 */
export async function deleteNote(noteId: string): Promise<void> {
  const ctx=context(), next=snapshot();
  if (!next.records.some(r=>r.id===noteId)) throw new Error('找不到这份札记，可能已经删除。');
  next.records=next.records.filter(r=>r.id!==noteId);
  next.decisions=next.decisions.filter(d=>d.noteId!==noteId);
  await persist(next,ctx);
}
/** 显式导入只读原文，既不删 aftertalk，也不把其中的“已确认”自动当成用户授权。 */
export async function importLegacyNotes(): Promise<number> {
  const ctx=context(), next=snapshot(); let count=0;
  for (let floor=0;floor<ctx.chat.length;floor++) {
    const m=ctx.chat[floor]; if (m.is_user || (m.is_system && !m.extra?.bbs_hidden) || m.extra?.bbs_internal_notice) continue;
    for (const text of extractAftertalk(m.mes)) {
      if (text.length>80000) continue;
      const hash=sourceHash(ctx,floor), swipe=m.swipe_id??0, fh=floorHash(m);
      if (next.records.some(r=>r.floor===floor && r.swipe===swipe && (r.floorHash ? r.floorHash===fh : r.sourceHash===hash) && r.text===text)) continue;
      next.records.push({id:crypto.randomUUID(),createdAt:Date.now(),floor,swipe,sourceHash:hash,floorHash:fh,text,questions:parseQuestions(text)}); count++;
    }
  }
  if (count) await persist(next,ctx); return count;
}
