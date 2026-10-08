/** 仅将明确的校验错误转为阅读提示，保留诊断原文，不隐藏网络等其他故障。 */
export function summaryErrorPresentation(error: string): { title: string; help: string; details: string } {
  if (!error.includes('conditionPatch')) return { title: error, help: '', details: '' };
  const floor = error.match(/楼层 #(\d+) 摘要未保存/);
  const subject = floor ? '第 #' + floor[1] + ' 楼的' : '';
  const reason = error.includes('evidence')
    ? error.includes('不匹配') ? '伤势/身体状态的引用与正文不一致' : '伤势/身体状态的证据字段格式不完整'
    : '伤势/身体状态的更新格式不符合要求';
  return {
    title: subject + '摘要校验未通过：' + reason + '。',
    help: (floor ? '该楼本次结果未写入，已有记录保持不变。' : '') + '请对缺失楼层使用“补录摘要（AI）”，已有摘要则对该楼重新摘要，无需重建整个聊天。重试仍失败时，请展开原因反馈。',
    details: error,
  };
}
