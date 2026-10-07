/** 棱镜宝书内部版：不访问上游更新源，不从浏览器携带私有仓库凭据。
 * 经授权的维护者分发完整版本后手动替换；保留原有导出供UI兼容。 */
import { reactive } from 'vue';
import { PLUGIN_VERSION } from '@/version';

export const INTERNAL_UPDATE_NOTICE = '内部版采用手动更新，请向维护者获取完整安装包；不会检查或安装原版更新。';
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
