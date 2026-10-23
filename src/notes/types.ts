import type { ApiChannel } from '@/api/settings';
export interface NoteQuestion { id: string; label: string; prompt: string; proposal: string }
/**
 * sourceHash：从第 0 楼到札记所在楼的整段指纹（旧记录只有这一项）。
 * floorHash：札记所在楼本身的指纹（页码＋正文），新记录据此判断札记是否失效；更早楼层的改动、原生隐藏和改名不算。
 */
export interface NoteRecord { id: string; createdAt: number; floor: number; swipe: number; sourceHash: string; floorHash?: string; text: string; questions: NoteQuestion[] }
export interface NoteDecision { id: string; noteId: string; questionId: string; text: string; status: 'pending'|'in_progress'|'completed'|'cancelled'|'rejected'; createdAt: number }
export interface NotesData { version: 1; records: NoteRecord[]; decisions: NoteDecision[] }
export interface NotesSettings { enabled: boolean; autoGenerate: boolean; injectConfirmed: boolean; showInChat: boolean; recentFloors: number; memoryChars: number; channel: ApiChannel }
