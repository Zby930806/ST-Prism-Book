/** 棱镜宝书不访问上游更新源，也不自行检查更新；更新由酒馆的「管理扩展」完成。
 * 保留原有导出供界面兼容。 */
import { reactive } from 'vue';
import { PLUGIN_VERSION } from '@/version';

export const INTERNAL_UPDATE_NOTICE = '在酒馆的「管理扩展」里更新本扩展；打开酒馆扩展面板中的「在扩展更新时通知」后，有新版本时酒馆会提示。插件自己不检查更新，也不会装上原版柏宝书的更新。';
export const updateState = reactive({
  current: PLUGIN_VERSION, latest: '', available: false, checking: false, updating: false,
});

export async function checkForUpdate(_force = false): Promise<void> {
  updateState.latest = '';
  updateState.available = false;
  updateState.checking = false;
}

export async function performUpdate(): Promise<void> {
  throw new Error(INTERNAL_UPDATE_NOTICE);
}
