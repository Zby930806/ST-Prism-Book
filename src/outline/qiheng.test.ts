import { describe, expect, it } from 'vitest';
import type { ChatMsg } from '@/api/client';
import { addRefinementContext, DISCUSSION_PROMPT, DISCUSSION_TONE_NOTE } from './discussionContext';
import { OUTLINE_CHARACTER_RULES } from './prompt';
import { QIHENG_GREETING, QIHENG_NAME } from './qiheng';
import { QIHENG_AVATAR, QIHENG_PORTRAIT } from './qihengAvatar';

// 规划讨论由 Qiheng 回答:人设写进系统提示词,只含提炼后的说话方式,不含聊天原文、熟人称呼和现实里的人和事。
describe('规划讨论的角色 Qiheng', () => {
  it('系统提示词以 Qiheng 的身份开头，保留规划讨论的边界和人物原则', () => {
    expect(DISCUSSION_PROMPT.startsWith(`你是 ${QIHENG_NAME}，`)).toBe(true);
    for (const part of ['【说话节奏】', '【用词】', '【语气随关系和场合变】', '【帮忙是正事】', '【讨论边界】', OUTLINE_CHARACTER_RULES]) {
      expect(DISCUSSION_PROMPT).toContain(part);
    }
    expect(DISCUSSION_PROMPT).toContain('不声称已经保存、修改、启用大纲或推进阶段');
    expect(DISCUSSION_PROMPT).toContain('不要编造前情');
    expect(DISCUSSION_PROMPT).toContain('不超过 8000 字符');
  });

  it('粗口、方言和称呼按场合：不定额度、不堆方言、不默认起昵称；对客气的人先收着；严肃时收起玩笑', () => {
    expect(DISCUSSION_PROMPT).toContain('粗口随场景，不定额度');
    expect(DISCUSSION_PROMPT).toContain('整段对话一句粗口都没有很正常');
    expect(DISCUSSION_PROMPT).toContain('不要堆方言');
    expect(DISCUSSION_PROMPT).toContain('不起昵称');
    expect(DISCUSSION_PROMPT).toContain('称呼「您」');
    expect(DISCUSSION_PROMPT).toContain('收起玩笑和粗口');
    // 复杂建议不受短句限制
    expect(DISCUSSION_PROMPT).toContain('不受短句限制');
  });

  it('问候、道谢、夸赞和说累时短回，不拉回规划、不每轮追问；不编自己的日常', () => {
    expect(DISCUSSION_PROMPT).toContain('道谢、夸你、说自己写完了，或者说累了时，自然地回一两行');
    expect(DISCUSSION_PROMPT).toContain('也不把话题拉回规划');
    expect(DISCUSSION_PROMPT).toContain('不用每轮都抛问题');
    // 以前写着「每次回复都要有对规划有用的东西」，和闲聊短回互相矛盾
    expect(DISCUSSION_PROMPT).not.toContain('每次回复都要有');
    expect(DISCUSSION_PROMPT).toContain('不编造自己的现实生活');
    expect(DISCUSSION_PROMPT).toContain('就当是在问办法，直接说办法');
    // 结尾不主动揽活；资料没写的事不说成相反的事实
    expect(DISCUSSION_PROMPT).toContain('也别主动揽活收尾');
    expect(DISCUSSION_PROMPT).toContain('不要把资料没写的事说成相反的事实');
    // 对不上时直接问，不猜原因（试聊里出现过「之前聊的没传过来」这种编出来的原因）
    expect(DISCUSSION_PROMPT).toContain('不解释、也不猜为什么对不上');
    // 聊天样本里没有的笑法只出现在「不用」的说明里
    expect(DISCUSSION_PROMPT).toContain('不用「哈哈哈」「hhh」「笑死」');
  });

  it('不发表情包，也不用文字假装发了图', () => {
    expect(DISCUSSION_PROMPT).toContain('不发表情包');
    expect(DISCUSSION_PROMPT).toContain('[发送表情包]');
  });

  it('不借用别的人设名，不默认起昵称；没有证据的方言词只出现在「不用」的说明里', () => {
    // 聊天样本里的熟人称呼、简称和群名不写进仓库（连测试里也不列），发布前在仓库外单独扫描
    const text = [DISCUSSION_PROMPT, QIHENG_NAME, ...QIHENG_GREETING].join('\n');
    for (const word of ['柏柏', '嘤嘤']) expect(text).not.toContain(word);
    expect(DISCUSSION_PROMPT).toContain('用户给了称呼或明确让你这么叫时再用');
    expect(DISCUSSION_PROMPT).toContain('不用「嘎嘎」「老铁」「杠杠的」这类词');
  });

  it('按讨论生成草稿时注明口吻不带进规划', () => {
    const input: ChatMsg[] = [{ role: 'system', content: '规划提示词' }, { role: 'user', content: '资料' }, { role: 'user', content: '要求' }];
    const out = addRefinementContext(input, {
      reference: null, referenceLabel: '',
      messages: [{ role: 'user', content: '这段咋整' }, { role: 'assistant', content: '我倾向先慢后紧\n\n卧槽这反派太水了' }],
    });
    const record = out.find(m => m.content.startsWith('[大纲讨论记录'))!;
    expect(record.content).toContain(DISCUSSION_TONE_NOTE);
    expect(out.at(-1)).toEqual(input.at(-1));
  });

  it('头像是内嵌的 WebP，不另外打包文件', () => {
    expect(QIHENG_AVATAR.startsWith('data:image/webp;base64,')).toBe(true);
    expect(QIHENG_PORTRAIT.startsWith('data:image/webp;base64,')).toBe(true);
    // 两张合计约 20KB 的图片数据，避免把整张原图塞进插件
    expect(QIHENG_AVATAR.length + QIHENG_PORTRAIT.length).toBeLessThan(40000);
  });
});
