/**
 * 停用棱镜宝书（总开关关闭，或当前角色在排除名单里）后，恢复显示本插件隐藏的楼层。
 *
 * 停用时插件不再注入记忆，但之前按保留窗口隐藏的旧楼层仍是隐藏状态（is_system），
 * 正文模型既看不到它们的原文，也收不到它们的摘要。这里只处理带 extra.bbs_hidden 标记、
 * 仍处于隐藏状态的楼层——用户自己用 /hide 隐藏的楼层没有这个标记，不会动。
 * 先去掉标记再执行酒馆的 /unhide；/unhide 失败或没有生效时直接把 is_system 改回 false，保存并重新载入聊天。
 * 重新启用后，引擎照常按保留窗口隐藏旧楼层。
 */
import { getContext, type STMessage } from '@/st/context';

/** 本插件隐藏、仍处于隐藏状态的楼层号（由小到大）。 */
export function pluginHiddenFloors(chat: readonly STMessage[]): number[] {
  const out: number[] = [];
  chat.forEach((m, i) => {
    if (m?.extra?.bbs_hidden && m.is_system === true) out.push(i);
  });
  return out;
}

/** 把连续的楼层号合并成区间，一个区间执行一次 /unhide。 */
export function floorRanges(floors: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const f of floors) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out;
}

function dropMarker(m: STMessage | undefined): void {
  if (!m?.extra?.bbs_hidden) return;
  const { bbs_hidden: _hidden, ...extra } = m.extra;
  m.extra = extra;
}

export interface RestoreResult {
  /** 恢复显示的楼层数 */
  restored: number;
  /** 是否有区间 /unhide 失败、改为直接写 is_system */
  fallback: boolean;
}

/** 恢复显示当前聊天里本插件隐藏的楼层。 */
export async function restorePluginHiddenFloors(): Promise<RestoreResult> {
  const ctx = getContext();
  if (!ctx) throw new Error('酒馆还没有准备好，请稍后再试。');
  const chat = ctx.chat ?? [];
  const floors = pluginHiddenFloors(chat);
  if (!floors.length) return { restored: 0, fallback: false };
  const exec = ctx.executeSlashCommandsWithOptions;
  let fallback = false;
  for (const [start, end] of floorRanges(floors)) {
    // 先去掉标记:/unhide 会保存聊天,标记随之一起保存
    for (let i = start; i <= end; i++) dropMarker(chat[i]);
    try {
      if (typeof exec !== 'function') throw new Error('当前酒馆没有提供斜杠命令接口');
      await exec(start === end ? `/unhide ${start}` : `/unhide ${start}-${end}`);
    } catch {
      fallback = true;
    }
    // 命令报错，或没报错但楼层仍是隐藏状态（命令解析失败时酒馆只返回错误结果、不抛出）：直接改回显示。
    // 标记已经去掉，这里不改回的话，这些楼层会被当成用户自己隐藏的，之后再也恢复不了。
    for (let i = start; i <= end; i++) {
      if (chat[i]?.is_system) {
        chat[i].is_system = false;
        fallback = true;
      }
    }
  }
  try {
    await ctx.saveChat?.();
    if (fallback) await ctx.reloadCurrentChat?.();
  } catch {
    /* 保存或刷新失败时,改动仍在内存里,酒馆下次保存聊天时写入 */
  }
  return { restored: floors.length, fallback };
}
