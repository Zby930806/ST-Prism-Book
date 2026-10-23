/**
 * 角色页各区块是否随正文发送给正文模型，与注入（memory/inject.ts 的 buildStateInjectionText）的条件一致：
 * - 开启「仅注入剧情摘要」时都不发送；
 * - 主角看「主角信息」；
 * - 主要角色和 NPC 看「NPC 名册」，且名册依赖「场景信息」判断在场；
 * - 信息差依赖名册，还要开启「信息差」；
 * - 生活档案看「生活档案」。
 * 只决定界面上的说明，不改记录：不发送时照常记录、照常在棱镜宝书里显示。
 */
import { apiSettings } from '@/api/settings';

export type SendBlock = 'protagonist' | 'npcs' | 'secrets' | 'lifeDetails';

export function blockSent(block: SendBlock): boolean {
  if (apiSettings.summaryOnlyMode) return false;
  const inj = apiSettings.injection;
  const npcsOn = inj.npcs && inj.scenes;
  switch (block) {
    case 'protagonist': return inj.protagonist;
    case 'npcs': return npcsOn;
    case 'secrets': return npcsOn && inj.secrets;
    case 'lifeDetails': return inj.lifeDetails;
  }
}

/** 区块不发送时的说明（警告色显示）；发送时返回 undefined。 */
export function blockLocalNote(block: SendBlock): string | undefined {
  if (blockSent(block)) return undefined;
  return apiSettings.summaryOnlyMode ? '仅供棱镜宝书记录，不发送给主对话 AI' : '注入设置中已关闭，不发送给正文模型';
}
