/** 摘要失败的阅读说明：先说哪一楼、为什么，再说怎么办；原始诊断放进可展开的细节。 */
export interface SummaryFailureView {
  title: string;
  help: string;
  details: string;
  detailsLabel: string;
}

export interface SummaryFailureInfo {
  message: string;
  title: string;
  hint: string;
  detail: string;
}

const RECOVERY = '没有摘要的楼层，点上方的「补摘」或在「未摘要楼层」里点楼层号重试；已有摘要想重做，在设置里打开楼层面板，到那一楼重新生成。无需重建整个聊天，反复失败可以换个模型，或展开原因反馈。';

function validationReason(error: string): string {
  if (error.includes('conditionPatch')) {
    return error.includes('evidence')
      ? error.includes('不匹配') ? '伤势/身体状态的引用与正文不一致' : '伤势/身体状态的证据字段格式不完整'
      : '伤势/身体状态的更新格式不符合要求';
  }
  if (error.includes('locationEvidence') || error.includes('定位')) {
    return error.includes('不匹配') ? '角色位置的引用与本楼正文不一致' : '角色位置缺少本楼正文依据';
  }
  const length = error.match(/summary 共 (\d+) 字符，超过 (\d+) 字符上限/);
  if (length) return `摘要超出字数上限（${length[1]} / ${length[2]} 字）`;
  if (error.includes('items.add.qty')) return '物品数量写得不明确';
  if (error.includes('摘要结果必须是根对象')) return '模型没有按要求输出摘要 JSON（可能是拒答，或只写了说明文字）';
  if (error.includes('stateChanges')) return '状态清单与实际写出的更新不一致';
  if (error.includes('同一计划每楼只能')) return '同一条计划在这一楼里更新冲突';
  if (/不是合法操作数组|含无效条目|包含操作数组的对象|并列放在根对象|放在对应 protagonist/.test(error)) return '状态更新的格式不对';
  return '摘要内容没有通过校验';
}

export function summaryErrorPresentation(error: string, failure?: SummaryFailureInfo | null): SummaryFailureView {
  if (failure && failure.message === error) {
    return { title: failure.title, help: failure.hint, details: failure.detail, detailsLabel: '技术细节' };
  }
  const floor = error.match(/楼层 #(\d+) 摘要未保存/);
  if (!floor && !error.includes('conditionPatch')) return { title: error, help: '', details: '', detailsLabel: '' };
  const subject = floor ? `第 #${floor[1]} 楼的摘要没有保存` : '摘要校验未通过';
  return {
    title: `${subject}：${validationReason(error)}。`,
    help: (floor ? '这一楼的结果没有写入，已有记录保持不变。' : '') + RECOVERY,
    details: error,
    detailsLabel: '查看校验原因',
  };
}
