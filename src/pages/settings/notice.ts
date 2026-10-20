import { ApiError } from '@/api/client';
import { describeFailure } from '@/api/errors';

/** 测试、拉取模型等操作的结果；tone 决定提示条的颜色。 */
export type Notice = { tone: 'busy' | 'ok' | 'warn' | 'error'; text: string; detail?: string };
export const TONE_CLASS: Record<Notice['tone'], string> = { busy: '', ok: 'is-success', warn: 'is-warning', error: 'is-danger' };

/** 向量、迁移等模块抛出的是写好的中文说明，原样显示；网络异常等没分类的错误换成可读的说明。 */
export function readableError(e: unknown, fallback: string): string {
  return e instanceof ApiError || e instanceof TypeError || !(e instanceof Error) ? describeFailure(e, fallback).message : e.message;
}
