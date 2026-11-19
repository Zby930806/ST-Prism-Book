/**
 * 测试环境的统一起点(vite.config.ts 的 test.setupFiles)。
 *
 * 三项默认值在 1.4.17、1.4.18 改过或新加,而此前写的测试核对的是改之前的文本和请求次数,所以每个测试开始前先调回去:
 *  - 内置提示词版本:默认是精简版(1.4.18 起);这里切到旧版。核对精简版的测试(promptStyle.test.ts 等)在各自的 beforeEach 里再切换。
 *  - 亲密记录:默认关闭(1.4.17 起可选);这里打开。导出的提示词常量(SUMMARY_PROMPT 等)是开启时的文本,测试拿实际请求与它们逐字比较。
 *    核对关闭状态的测试(npcIntimacy.test.ts 的开关一组)在用例里自行关闭。
 *  - 总结写完后核对:默认开启(1.4.18 新加),每次合并多发一个请求;这里关闭,原有的总结测试照旧按「一次合并一个请求」核对。
 *    核对这一步的测试(summarySelfCheck.test.ts)在自己的 beforeEach 里打开。
 * 三项的默认值本身由 promptStyle.test.ts、npcIntimacy.test.ts、summarySelfCheck.test.ts 通过 normalizeApiSettings 核对,不受这里影响。
 */
import { beforeEach } from 'vitest';
import { apiSettings } from '@/api/settings';

beforeEach(() => {
  apiSettings.promptStyle = 'classic';
  apiSettings.injection.intimacy = true;
  apiSettings.resummarySelfCheck = false;
});
