/**
 * 摘要页各区块共用的页面状态：只读保护与旧记忆转换、未摘要楼层、批量补摘，以及「关闭弹窗」「切聊天重置」两类通知。
 * index.vue 调用 createSummaryPage() 后 provide，各区块组件用 useSummaryPage() 取用。
 * 摘要卡片（SummaryNode）另用 ctx.ts 的 SUMMARY_CTX。
 */
import { apiSettings, normalizeBatchFullRecent, normalizeBatchMaxFloors } from '@/api/settings';
import { batchBackfill, batchState, continueRebuild, discardRebuildRun, engineState, planBatchBackfill, rebuildPlanFloors, rebuildProgress, rebuildRunState, startRebuild } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { hasHoraeData } from '@/memory/migrate';
import { compatibilityState, convertLegacyMemory, derivedMeta, LegacyBackupConflictError, memoryWriteIssue, recomputeDerived, repairBrokenSummaries } from '@/memory/store';
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
  /** 上次转换留下的备份与当前旧记录不同:要用户导出核对后确认替换 */
  const backupConflict = ref(false);
  const replaceBackupConfirmOpen = ref(false);
  /** 只读保护里可清理的残缺总结:先导出,再确认清理 */
  const repairConfirmOpen = ref(false);
  const repairPending = ref(false);
  const conversionBusy = computed(() => conversionPending.value || repairPending.value || compatibilityState.converting);
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
    backupConflict.value = false;
    convertConfirmOpen.value = true;
  }
  async function runConversion(replaceBackup: boolean) {
    if (conversionBusy.value || engineState.running) return;
    const target = conversionChat;
    if (!target || !isSameChat(target)) {
      convertConfirmOpen.value = false;
      replaceBackupConfirmOpen.value = false;
      toast('聊天已切换，请回到要转换的聊天再确认。', 'warning');
      return;
    }
    conversionPending.value = true;
    conversionError.value = '';
    try {
      await convertLegacyMemory({ replaceBackup });
      // store 负责原聊天的保存保护；页面不把旧任务结果应用到新聊天。
      if (!isSameChat(target)) return;
      recomputeDerived();
      refreshInjection();
      convertConfirmOpen.value = false;
      replaceBackupConfirmOpen.value = false;
      backupConflict.value = false;
      toast('旧记忆已转换并保存，原数据另有备份。', 'success');
    } catch (error) {
      if (!isSameChat(target)) return;
      conversionError.value = error instanceof Error ? error.message : String(error);
      backupConflict.value = error instanceof LegacyBackupConflictError;
      toast(backupConflict.value
        ? '没有转换：' + conversionError.value
        : '转换没有成功：' + conversionError.value + ' 可重新载入聊天后再试；仍失败时先导出聊天检查，不要全部重新摘要。', 'error');
      convertConfirmOpen.value = false;
      replaceBackupConfirmOpen.value = false;
    } finally {
      conversionPending.value = false;
    }
  }
  function confirmConversion() { return runConversion(false); }
  /** 已有一份不同的旧格式备份:用户导出核对后,用当前旧记录替换那份备份再转换。 */
  function openReplaceBackupConfirm() {
    if (conversionBusy.value || engineState.running || !backupConflict.value) return;
    memoryWriteIssue();
    if (compatibilityState.mode !== 'convert') return;
    conversionChat = captureChat();
    replaceBackupConfirmOpen.value = true;
  }
  function confirmReplaceBackup() { return runConversion(true); }

  /* —— 只读保护:清理引用了缺失楼层的残缺总结(先导出,再确认) —— */
  let repairChat: ChatSnapshot | null = null;
  function openRepairConfirm() {
    if (conversionBusy.value || engineState.running) return;
    memoryWriteIssue();
    if (compatibilityState.mode !== 'protected' || !compatibilityState.repairable.length) return;
    repairChat = captureChat();
    repairConfirmOpen.value = true;
  }
  async function confirmRepair() {
    if (conversionBusy.value || engineState.running) return;
    const target = repairChat;
    if (!target || !isSameChat(target)) {
      repairConfirmOpen.value = false;
      toast('聊天已切换，请回到要清理的聊天再确认。', 'warning');
      return;
    }
    repairPending.value = true;
    try {
      const removed = await repairBrokenSummaries();
      if (!isSameChat(target)) return;
      repairConfirmOpen.value = false;
      refreshInjection();
      toast(removed ? `已清理 ${removed} 条残缺的总结；逐楼摘要保留，之后会按设置重新合并。` : '没有需要清理的总结。', removed ? 'success' : 'info');
    } catch (error) {
      if (!isSameChat(target)) return;
      repairConfirmOpen.value = false;
      toast('清理没有完成：' + (error instanceof Error ? error.message : String(error)), 'error');
    } finally {
      repairPending.value = false;
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

  /* —— 全部重新摘要 ——
   * 按楼层顺序重新摘要 AI 楼层（还没有摘要的一并摘要），替换摘要和模型记录的状态，手动修改保留。开始时在聊天元数据记一条运行记录，
   * 每层完成后在叶子上标记；取消、失败、切换聊天或刷新后可以从停下的楼层继续。有未完成的记录时先问继续还是重新开始。 */
  const rebuildOpen = ref(false);
  /** resume：有未完成的记录，先选继续或重新开始；fresh：新开一次（可选起始楼层） */
  const rebuildStep = ref<'resume' | 'fresh'>('fresh');
  // 输入框为空时从第一个可处理的楼层开始（v-model.number 清空时为 ''）
  const rebuildFromInput = ref<number | ''>('');
  const rebuildHasHorae = ref(false);
  // 运行记录在聊天元数据里，不是响应式数据：用叶子变化、记录变化和批量进度触发重算
  const rebuildProgressView = computed(() => {
    void derivedMeta.rev;
    void rebuildRunState.rev;
    void batchState.running;
    void batchState.done;
    return editingBlocked.value ? null : rebuildProgress();
  });
  const rebuildAll = computed(() => {
    void derivedMeta.rev;
    return rebuildOpen.value ? rebuildPlanFloors() : [];
  });
  const rebuildFloors = computed(() => {
    const from = rebuildFromInput.value;
    return from === '' || !Number.isFinite(from) ? rebuildAll.value : rebuildAll.value.filter(f => f >= from);
  });
  function openRebuild() {
    if (!allowMemoryEdit()) return;
    if (engineState.running || batchState.running) return;
    const progress = rebuildProgress();
    rebuildStep.value = progress && progress.next !== null ? 'resume' : 'fresh';
    rebuildFromInput.value = '';
    rebuildHasHorae.value = hasHoraeData(getContext()?.chat ?? []);
    rebuildOpen.value = true;
  }
  /** 有未完成的记录时选「重新开始」：转到新开一次的说明和起始楼层 */
  function chooseRebuildRestart() {
    rebuildStep.value = 'fresh';
  }
  function runRebuild() {
    if (!allowMemoryEdit()) return;
    // 先取楼层再关窗：rebuildAll 只在弹窗打开时计算
    const floors = rebuildFloors.value;
    rebuildOpen.value = false;
    if (engineState.running || batchState.running || !floors.length) return;
    // 不 await：任务在 engine 里跑，进度走 batchState 单例
    void startRebuild(floors[0]);
  }
  function resumeRebuild() {
    if (!allowMemoryEdit()) return;
    rebuildOpen.value = false;
    if (engineState.running || batchState.running) return;
    void continueRebuild();
  }
  function endRebuild() {
    if (!allowMemoryEdit()) return;
    if (!discardRebuildRun()) toast('正在生成摘要，暂时不能结束全部重新摘要。请等当前摘要完成后再试。', 'warning');
  }

  function closeEditors() {
    batchConfirmOpen.value = false;
    batchScope.value = null;
    rebuildOpen.value = false;
    for (const fn of closeHooks) fn();
  }
  // 弹窗会 Teleport，不能只依靠外层 fieldset 禁用。
  watch(editingBlocked, blocked => { if (blocked) closeEditors(); });

  // 切聊天：重置临时视图态，避免上个聊天的残留跨聊天带过来。
  function resetViewStates() {
    chatEpoch++;
    convertConfirmOpen.value = false;
    replaceBackupConfirmOpen.value = false;
    repairConfirmOpen.value = false;
    conversionChat = null;
    repairChat = null;
    conversionError.value = '';
    backupConflict.value = false;
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
    conversion: {
      convertConfirmOpen, conversionError, openConversionConfirm, confirmConversion,
      backupConflict, replaceBackupConfirmOpen, openReplaceBackupConfirm, confirmReplaceBackup,
      repairConfirmOpen, repairPending, openRepairConfirm, confirmRepair,
    },
    batch: { batchConfirmOpen, batchScope, batchFloors, batchCanMerge, batchMode, batchRecentInput, batchGroupInput, batchLiteText, batchEta, openBatchConfirm, runBatchBackfill },
    rebuild: { rebuildOpen, rebuildStep, rebuildFromInput, rebuildHasHorae, rebuildProgressView, rebuildAll, rebuildFloors, openRebuild, chooseRebuildRestart, runRebuild, resumeRebuild, endRebuild },
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
