import type { ApiChannel } from '@/api/settings';
export interface NoteQuestion { id: string; label: string; prompt: string; proposal: string }
export interface NoteRecord { id: string; createdAt: number; floor: number; swipe: number; sourceHash: string; text: string; questions: NoteQuestion[] }
export interface NoteDecision { id: string; noteId: string; questionId: string; text: string; status: 'pending'|'in_progress'|'completed'|'cancelled'|'rejected'; createdAt: number }
export interface NotesData { version: 1; records: NoteRecord[]; decisions: NoteDecision[] }
export interface NotesSettings { enabled: boolean; autoGenerate: boolean; injectConfirmed: boolean; recentFloors: number; memoryChars: number; channel: ApiChannel }
