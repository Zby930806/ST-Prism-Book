/**
 * 伤势进展提醒:给正文模型的写作参考,不改记录。
 *
 * 摘要模型仍只凭正文证据记录伤情(不因时间流逝清空);这里只在「伤情记录很久没变」时提醒正文模型:
 * 下次写到伤处或相关行动时按伤情轻重和经过的时间写出进展,与本轮无关时不必提及,
 * 避免用户不提、正文就一直写同一处伤,也避免为了回应提醒而每轮硬写伤情。
 * 锚点(conditionTime / conditionFloor)由重放在伤情记录变化时盖上,记录一改,提醒随之重置。
 */
import { calculateRelativeDays } from './timeRel';

/** 故事时间按天数分级;时间未知或无法比较时改按其后的回复楼层数分级。数组下标 = 级别 - 1。 */
export const INJURY_DAY_LEVELS = [1, 7, 30] as const;
export const INJURY_FLOOR_LEVELS = [10, 40, 100] as const;
/** 每次最多提醒的人数(主角在前,其后主要角色、在场、同区域)。 */
export const INJURY_REMINDER_LIMIT = 8;

export interface InjuryReminderSubject {
  name: string;
  condition?: string;
  conditionTime?: string;
  conditionFloor?: number;
}

export interface InjuryElapsed {
  /** 0 = 不提醒;1/2/3 = 越大措辞越重 */
  level: 0 | 1 | 2 | 3;
  days?: number;
  floors?: number;
}

function levelOf(value: number, thresholds: readonly number[]): 0 | 1 | 2 | 3 {
  let level = 0;
  thresholds.forEach((t, i) => { if (value >= t) level = i + 1; });
  return level as 0 | 1 | 2 | 3;
}

/**
 * 记录后经过了多久。两端故事时间都能比较时只看天数(同一天内不提醒,时间倒退也不提醒);
 * 否则看锚点楼层之后的回复楼层数。都不知道时不提醒。
 */
export function injuryElapsed(subject: InjuryReminderSubject, now: string, floorsAfter: (floor: number) => number): InjuryElapsed {
  const days = subject.conditionTime && now ? calculateRelativeDays(subject.conditionTime, now) : null;
  if (days !== null) return days > 0 ? { level: levelOf(days, INJURY_DAY_LEVELS), days } : { level: 0, days };
  if (typeof subject.conditionFloor !== 'number' || subject.conditionFloor < 0) return { level: 0 };
  const floors = floorsAfter(subject.conditionFloor);
  return { level: levelOf(floors, INJURY_FLOOR_LEVELS), floors };
}

function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function daysText(days: number): string {
  if (days >= 365) return `约 ${Math.floor(days / 365)} 年`;
  if (days >= 60) return `约 ${Math.floor(days / 30)} 个月`;
  return `约 ${days} 天`;
}

const LEVEL_NOTE: Record<2 | 3, string> = {
  2: '时间已久,除非正文另有说明,按常理大多应已明显好转或痊愈',
  3: '时间很久,除确属长期伤病或后遗症外应已痊愈,不要再写成新伤',
};

/** 提醒在伤情记录更新前每轮都在,所以要写明「只在相关时体现」,不能让正文为回应提醒而每轮硬写伤情。 */
export const INJURY_REMINDER_TAIL = '下次写到伤处或相关行动时,按轻重和经过的时间体现进展(好转、继续休养、留下后遗症或痊愈);与本轮情节无关时不必提及伤情。不要无限期重复同样的伤情描写,也不要无故加重。这是写作参考,不要在正文中提及这条提醒。';

/** 一行提醒:谁、什么伤、记录于何时、过了多久;级别高时加重措辞。 */
export function fmtInjuryReminderLine(subject: InjuryReminderSubject, elapsed: InjuryElapsed): string {
  const when: string[] = [];
  if (subject.conditionTime && elapsed.days !== undefined) when.push(`记录于 ${oneLine(subject.conditionTime)},已过${daysText(elapsed.days)}`);
  else if (elapsed.floors !== undefined) when.push(`记录后已过 ${elapsed.floors} 个回复楼层,故事时间不明`);
  const note = elapsed.level >= 2 ? `;${LEVEL_NOTE[elapsed.level as 2 | 3]}` : '';
  return `- ${oneLine(subject.name)}:${oneLine(subject.condition)}(${when.join('')})${note}`;
}

/**
 * 组合提醒块;没有到期的记录返回空串。subjects 已按优先顺序排好(主角、主要角色、在场、同区域)。
 * now 为当前故事时间;floorsAfter 返回某楼层之后的回复楼层数。
 */
export function fmtInjuryReminder(subjects: InjuryReminderSubject[], now: string, floorsAfter: (floor: number) => number): string {
  const lines: string[] = [];
  for (const s of subjects) {
    if (!oneLine(s.condition)) continue;
    const elapsed = injuryElapsed(s, now, floorsAfter);
    if (!elapsed.level) continue;
    lines.push(fmtInjuryReminderLine(s, elapsed));
    if (lines.length >= INJURY_REMINDER_LIMIT) break;
  }
  return lines.length ? `[伤势进展提醒]\n${lines.join('\n')}\n${INJURY_REMINDER_TAIL}` : '';
}
