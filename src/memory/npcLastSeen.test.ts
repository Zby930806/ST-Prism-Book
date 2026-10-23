import { describe, expect, it } from 'vitest';
import { fmtNpcContextBlocks } from './inject';
import { staleLastSeenRelation } from './apply';
import type { MemNpc, MemScene } from './types';

// 位置过期(主角换场景或跨日)但最后确认的地点就是主角所在处:正文模型要知道这个人最后在这里,不能默认消失。
const scene = (path: string[]): MemScene => ({
  id: 'scene:' + path.join('/'), name: path.at(-1)!, path, parentId: path.length > 1 ? 'scene:' + path.slice(0, -1).join('/') : '',
  desc: '', createdAt: 1, updatedAt: 1,
} as MemScene);
const scenes = [scene(['雾港']), scene(['雾港', '灯塔酒馆']), scene(['雾港', '北岸码头']), scene(['远洲']), scene(['远洲', '驿站'])];
const here = '雾港·灯塔酒馆';
const path = ['雾港', '灯塔酒馆'];
const npc = (fields: Partial<MemNpc>): MemNpc => ({ id: 'npc:' + fields.name, name: '', createdAt: 1, updatedAt: 1, ...fields } as MemNpc);
const seen = (place: string, time = '1925/3/2 19:20') => ({ location: place, locationStale: true, follow: false, lastKnownLocation: { place, time, leafId: 'l' } });
const all = (blocks: ReturnType<typeof fmtNpcContextBlocks>) => [blocks.main, blocks.npc, ...blocks.absent].join('\n');

describe('位置过期但最后确认在此处的角色', () => {
  it('过了一夜、主角回到原处：无名酒保按「最后确认在此处」发送，附最后确认时间、外貌和判断说明', () => {
    const blocks = fmtNpcContextBlocks([npc({ name: '酒保A', gender: '男', title: '灯塔酒馆的酒保', desc: '右手背有一道旧疤', ...seen(here) })], scenes, here, path, '1925/3/3 19:00');
    expect(blocks.npc).toContain('最后确认在此处或附近');
    expect(blocks.npc).toContain('不要无缘无故写成不见了');
    expect(blocks.npc).toContain('酒保A(男·灯塔酒馆的酒保)');
    expect(blocks.npc).toContain('[最后确认在此处:雾港·灯塔酒馆（1925/3/2 19:20）,之后未再确认]');
    expect(blocks.npc).toContain('右手背有一道旧疤');
    expect(blocks.absent).toEqual([]);
  });

  it('最后确认在附近的标「附近」且不带外貌；远处的仍按其他已知角色发送', () => {
    const blocks = fmtNpcContextBlocks([
      npc({ name: '码头工老周', desc: '满脸胡茬', ...seen('雾港·北岸码头') }),
      npc({ name: '驿丞', ...seen('远洲·驿站') }),
    ], scenes, here, path, '1925/3/3 19:00');
    expect(blocks.npc).toContain('[最后确认在附近:雾港·北岸码头（1925/3/2 19:20）,之后未再确认]');
    expect(blocks.npc).not.toContain('满脸胡茬');
    expect(blocks.npc).not.toContain('驿丞');
    expect(blocks.absent.join('\n')).toContain('驿丞');
    expect(blocks.absent.join('\n')).toContain('不能据旧地点断言现在的去向');
  });

  it('去向已明确不明（地点被清空）的不算最后在此处', () => {
    const gone = npc({ name: '许曼', locationStale: true, follow: false, lastKnownLocation: { place: here, time: '1925/3/2', leafId: 'l' } });
    expect(staleLastSeenRelation(gone, scenes, here, path)).toBeNull();
    const text = all(fmtNpcContextBlocks([gone], scenes, here, path, '1925/3/3'));
    expect(text).not.toContain('最后确认在此处');
    expect(text).toContain('许曼');
  });

  it('位置没有过期的照常按在场发送，不加提醒；随行的不算', () => {
    const blocks = fmtNpcContextBlocks([
      npc({ name: '酒保A', location: here, locationStale: false, follow: false }),
      npc({ name: '周默', follow: true }),
    ], scenes, here, path, '1925/3/2');
    expect(blocks.npc).toContain('在场:');
    expect(blocks.npc).not.toContain('最后确认在此处');
    expect(staleLastSeenRelation(npc({ name: '周默', follow: true, locationStale: true, location: here }), scenes, here, path)).toBeNull();
  });

  it('主要角色同样标出，并在标题里说明怎样判断', () => {
    const blocks = fmtNpcContextBlocks([npc({ name: '梅芙', important: true, title: '旅店老板', ...seen(here) })], scenes, here, path, '1925/3/3');
    expect(blocks.main).toContain('标「最后确认在此处/附近」的');
    expect(blocks.main).toContain('最后确认在此处:雾港·灯塔酒馆（1925/3/2 19:20）,之后未再确认');
    expect(blocks.main).not.toContain('当前位置未确认');
  });
});
