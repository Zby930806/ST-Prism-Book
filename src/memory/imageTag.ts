const BAI_BAI_IMAGE_TAG = /(?:\r\n|\n|\r)?<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>/gi;

/** 删除柏宝绘生图标签；独占行标签连同前置换行一起删，恢复插入前的正文换行。 */
export function stripBaiBaiImageTags(mes: string): string {
  return String(mes ?? '').replace(BAI_BAI_IMAGE_TAG, '');
}
