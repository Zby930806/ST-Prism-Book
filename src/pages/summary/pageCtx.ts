/**
 * 摘要页各区块共用的页面状态：只读保护与旧记忆转换、未摘要楼层、批量补摘，以及「关闭弹窗」「切聊天重置」两类通知。
 * index.vue 调用 createSummaryPage() 后 provide，各区块组件用 useSummaryPage() 取用。
 * 摘要卡片（SummaryNode）另用 ctx.ts 的 SUMMARY_CTX。
 */
import { apiSettings, normalizeBatchFullRecent, normalizeBatchMaxFloors } from '@/api/settings';
import { batchBackfill, batchState, engineState, planBatchBackfill } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { compatibilityState, convertLegacyMemory, derivedMeta, memoryWriteIssue, recomputeDerived } from '@/memory/store';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, inject, onMounted, onUnmounted, ref, watch, type InjectionKey } from 'vue';
import { batchEtaText } from './view';

/** 待补摘楼层达到这个数才提供合并选项；零星缺口逐层补摘即可。 */
const BATCH_MERGE_MIN = 30;

export function createSummaryPage() {
  /* —— 关闭弹窗 / 切聊天重置：各区块登记自己的处理函数 —— */
  const closeHooks = new Set<() => void>();
  const resetHooks = new Set<() => void>();
  function register(set: Set<() => void>, fn: () => void) {
    set.add(fn);
    onUnmounted(() => set.delete(fn));
  }

  /* —— 旧记忆兼容：转换流程与只读保护 ——
     兼容报告是最近一次加载/检查时的快照，不作为实时摘要计数。 */
  const convertConfirmOpen = ref(false);
  const conversionPending = ref(false);
  const conversionError = ref('');
  const conversionBusy = computed(() => conversionPending.value || compatibilityState.converting);
  const editingBlocked = computed(() => compatibilityState.mode !== 'ready' || conversionBusy.value);
  let chatEpoch = 0;
  let pageActive = true;
  function captureChat() {
    const ctx = getContext();
    return { chat: ctx?.chat, metadata: ctx?.chatMetadata, id: ctx?.getCurrentChatId?.(), epoch: chatEpoch };
  }
  type ChatSnapshot = ReturnType<typeof captureChat>;
  let conversionChat: ChatSnapshot | null = null;
  function isSameChat(snapshot: ChatSnapshot): boolean {
    const current = captureChat();
    return pageActive && snapshot.epoch === current.epoch && snapshot.chat === current.chat
      && snapshot.metadata === current.metadata && snapshot.id === current.id;
  }
  function allowMemoryEdit(): boolean {
    const issue = memoryWriteIssue();
    if (!issue && !conversionPending.value) return true;
    toast(issue || '正在转换旧记忆，请等保存完成。', 'warning');
    return false;
  }
  function openConversionConfirm() {
    if (conversionBusy.value || engineState.running) return;
    // 重新核对当前聊天，不能以另一聊天留下的报告打开确认。
    memoryWriteIssue();
    if (compatibilityState.mode !== 'convert') return;
    conversionChat = captureChat();
    conversionError.value = '';
    convertConfirmOpen.value = true;
  }
  async function confirmConversion() {
    if (conversionBusy.value || engineState.running) return;
    const target = conversionChat;
    if (!target || !isSameChat(target)) {
      convertConfirmOpen.value = false;
      toast('聊天已切换，请回到要转换的聊天再确认。', 'warning');
      return;
    }
    conversionPending.value = true;
    conversionError.value = '';
    try {
      await convertLegacyMemory();
      // store 负责原聊天的保存保护；页面不把旧任务结果应用到新聊天。
      if (!isSameChat(target)) return;
      recomputeDerived();
      refreshInjection();
      convertConfirmOpen.value = false;
      toast('旧记忆已转换并保存，原数据另有备份。', 'success');
    } catch (error) {
      if (!isSameChat(target)) return;
      conversionError.value = error instanceof Error ? error.message : String(error);
      toast('转换没有成功：' + conversionError.value + ' 请先导出聊天检查，不要反复转换或重建。', 'error');
      convertConfirmOpen.value = false;
    } finally {
      conversionPending.value = false;
    }
  }

  const hasLeaf = computed(() => derivedMeta.hasLeaf);
  // 触屏判定：用于跳过弹窗自动聚焦（移动端自动聚焦会弹出输入法挡住界面）。
  const isTouch = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches;

  /* —— 未摘要楼层：derivedMeta.pendingFloors = AI 楼且无有效叶子，由旧到新；此处倒序展示（新楼在前）。 —— */
  const pendingFloors = computed(() => [...derivedMeta.pendingFloors].sort((a, b) => b - a));

  /* —— 批量补摘 ——
   * 先弹确认：待补摘较多时可选「较早楼层合并摘要」（最近 N 层逐层完整摘要，更早的几层合并为一次请求，
   * 只写摘要和时间）或「全部逐层摘要」，弹窗里按当前数字算出请求次数。执行中显示进度 + 可取消（当前一步完成后生效）。
   * 运行状态读 engine 的 batchState 单例（非组件本地 ref）：关掉棱镜宝书窗口再重开，进度条与取消按钮能恢复。 */
  const batchConfirmOpen = ref(false);
  // 补摘范围：null 为全部待补摘楼层；「未摘要楼层」里点一段时只补这一段（仍按当前待补摘过滤，已补上的不再重复）。
  const batchScope = ref<number[] | null>(null);
  const batchFloors = computed(() => {
    const all = [...derivedMeta.pendingFloors].sort((a, b) => a - b);
    if (!batchScope.value) return all;
    const scope = new Set(batchScope.value);
    return all.filter(floor => scope.has(floor));
  });
  const batchCanMerge = computed(() => batchFloors.value.length >= BATCH_MERGE_MIN);
  const batchMode = ref<'lite' | 'full'>('lite');
  // 输入框暂时清空时为 ''（v-model.number），按设置里的值计算
  const batchRecentInput = ref<number | ''>(20);
  const batchGroupInput = ref<number | ''>(10);
  const batchRecent = computed(() => normalizeBatchFullRecent(batchRecentInput.value === '' ? apiSettings.batchFullRecent : batchRecentInput.value));
  const batchGroup = computed(() => normalizeBatchMaxFloors(batchGroupInput.value === '' ? apiSettings.batchMaxFloors : batchGroupInput.value));
  const batchPlan = computed(() => {
    if (!batchConfirmOpen.value || !batchCanMerge.value) return null;
    void derivedMeta.rev;
    return planBatchBackfill(getContext()?.chat ?? [], batchFloors.value, { lite: true, fullRecent: batchRecent.value, maxFloors: batchGroup.value });
  });
  const batchLiteText = computed(() => {
    const plan = batchPlan.value;
    if (!plan) return '';
    if (!plan.liteSteps) return '按当前数字没有可合并的较早楼层，将全部逐层摘要。';
    return `较早的 ${plan.liteFloors} 层合并为 ${plan.liteSteps} 次请求，只记录摘要和时间；其余 ${plan.fullFloors} 层逐层摘要并记录状态。共 ${plan.steps.length} 次摘要请求，另按设置合并为总结。`;
  });
  /** floors：只补这些楼层（一段）；不传时补全部。按钮直接绑定时第一个参数是点击事件，不当作楼层。 */
  function openBatchConfirm(floors?: unknown) {
    if (!allowMemoryEdit()) return;
    if (engineState.running || !pendingFloors.value.length) return;
    batchScope.value = Array.isArray(floors) && floors.length ? floors.filter((f): f is number => Number.isInteger(f)) : null;
    if (!batchFloors.value.length) { batchScope.value = null; return; }
    batchMode.value = 'lite';
    batchRecentInput.value = apiSettings.batchFullRecent;
    batchGroupInput.value = apiSettings.batchMaxFloors;
    batchConfirmOpen.value = true;
  }
  function runBatchBackfill() {
    if (!allowMemoryEdit()) return;
    batchConfirmOpen.value = false;
    if (engineState.running) return;
    const lite = batchCanMerge.value && batchMode.value === 'lite';
    if (lite) {
      // 记住这次的数字，下次打开沿用
      apiSettings.batchFullRecent = batchRecent.value;
      apiSettings.batchMaxFloors = batchGroup.value;
    }
    // 不 await：任务在 engine 里跑，状态走 batchState 单例；UI 只读它，不依赖本函数停留
    const floors = batchFloors.value;
    batchScope.value = null;
    if (!floors.length) return;
    void batchBackfill({
      // 由旧到新补（引擎内部也会再过滤排序）
      floors,
      lite,
    });
  }
  // 剩余时间：每完成一步更新一次，按这一次已完成的平均耗时估算；合并请求一步含多层，按「每次请求」说
  const batchEta = computed(() => batchEtaText(
    { done: batchState.stepsDone, total: batchState.steps, startedAt: batchState.startedAt, lastDoneAt: batchState.lastDoneAt },
    batchState.lite ? '每次请求' : '每楼',
  ));

  function closeEditors() {
    batchConfirmOpen.value = false;
    batchScope.value = null;
    for (const fn of closeHooks) fn();
  }
  // 弹窗会 Teleport，不能只依靠外层 fieldset 禁用。
  watch(editingBlocked, blocked => { if (blocked) closeEditors(); });

  // 切聊天：重置临时视图态，避免上个聊天的残留跨聊天带过来。
  function resetViewStates() {
    chatEpoch++;
    convertConfirmOpen.value = false;
    conversionChat = null;
    conversionError.value = '';
    closeEditors();
    for (const fn of resetHooks) fn();
  }
  // 打开摘要页时强制重算一次派生：未摘要楼层等派生缓存只在特定事件刷新，进页先对齐一次，避免列表漏楼。
  onMounted(() => recomputeDerived());
  let offChatChanged: (() => void) | null = null;
  onMounted(() => {
    const ctx = getContext();
    const es = ctx?.eventSource;
    const et = ctx?.eventTypes;
    if (es && et?.CHAT_CHANGED) {
      es.on(et.CHAT_CHANGED, resetViewStates);
      offChatChanged = () => es.off?.(et.CHAT_CHANGED, resetViewStates);
    }
  });
  onUnmounted(() => {
    pageActive = false;
    chatEpoch++;
    offChatChanged?.();
  });

  return {
    editingBlocked, conversionBusy, allowMemoryEdit, hasLeaf, isTouch, pendingFloors,
    conversion: { convertConfirmOpen, conversionError, openConversionConfirm, confirmConversion },
    batch: { batchConfirmOpen, batchScope, batchFloors, batchCanMerge, batchMode, batchRecentInput, batchGroupInput, batchLiteText, batchEta, openBatchConfirm, runBatchBackfill },
    /** 只读保护开启、切换聊天时调用：关闭本区块的弹窗与编辑态。 */
    onCloseEditors: (fn: () => void) => register(closeHooks, fn),
    /** 切换聊天时调用：重置本区块的分页、搜索等临时视图态。 */
    onReset: (fn: () => void) => register(resetHooks, fn),
  };
}

export type SummaryPage = ReturnType<typeof createSummaryPage>;
export const SUMMARY_PAGE: InjectionKey<SummaryPage> = Symbol('summaryPage');

export function useSummaryPage(): SummaryPage {
  const page = inject(SUMMARY_PAGE);
  if (!page) throw new Error('摘要页区块需在摘要页内使用');
  return page;
}
