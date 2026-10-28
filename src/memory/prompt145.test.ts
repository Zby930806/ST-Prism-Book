import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as p from './prompts';

// 1.4.5 按真实模型实测修订的提示词合同:只验证发给模型的规则文字,不代表模型语义通过。
const saved = JSON.stringify(apiSettings);
const args: Parameters<typeof p.buildSummaryPrompt>[0] = { user: '主角', char: '角色', time: '', location: '', protagonist: {}, sceneFocus: null, lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [], openPlans: [], resolvedPlans: [], history: '', content: '输入正文。', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '' };
beforeEach(() => Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' }));
afterEach(() => Object.assign(apiSettings, JSON.parse(saved)));
const system = () => p.buildSummaryPrompt(args).system;
const checklist = () => p.buildSummaryThinking('主角').checklist;

describe('1.4.5 随行角色被留下', () => {
  it('在场核对:随行角色没跟着走必须改成不随行并填地点,「不重报」只适用于定点角色', () => {
    for (const rule of ['同行的角色另标 [随行]', '标 [随行] 的角色本楼没跟主角一起走(被留下、自己留下或分头行动)→ 必须 update follow:false',
      '省略就会一直按同行处理', '这一条只适用于本来就定点、没有 [随行] 的角色',
      '离队(包括主角走时把他留下、他自己留下、分头去了别处)→ update follow:false + location 填他留下或去往的地点',
      '随行的人这次没跟着走须 update follow:false 并写留下的地点']) expect(system()).toContain(rule);
    expect(system()).toContain('主角换景而定点角色未同行、此前打算留守或暂无新消息 → 不重报旧 location');
  });

  it('核查清单的离场同步同样写明,了解清单开启时仍插在这一行之后', () => {
    expect(checklist()).toContain('离场同步 follow/location:标 [随行] 的人本楼没跟着走 → follow:false 并填他留下或去往的地点(不重报只适用于定点角色)');
    expect(p.buildSummaryThinking('主角', true).checklist).toMatch(/ {3}- 离场同步[^\n]*\n {3}- 了解清单:/);
  });

  it('规则里说的 [随行] 与名册里同行角色的标记一致', () => {
    const npc = { name: '同伴甲', important: true, follow: true, presence: 'present' as const };
    const user = p.buildSummaryPrompt({ ...args, npcs: [npc] }).user;
    expect(user).toMatch(/同伴甲[^\n]*\[随行\]/);
  });
});

describe('1.4.5 地点建档只认专有名称', () => {
  it('泛称不建点、不替它起名,只被提起或约好以后去的地方不算到过', () => {
    for (const rule of ['有名字指专有名称,如「望月客栈」「翠湖小区」「云来酒楼」', '「酒馆」「面馆」「渡口」「树林」「路边」这类泛称不算名字',
      '到了这类地方只把原文写进 location,locationPath 退到能确认的上级,不建点,也不替它起名',
      '只被提起、约好以后去、听说某人在那里、远远望见、路过一笔带过的地方都不算到过,不建',
      '到达新的有名地点须 scenes.add（专有名称才算有名，泛称和只被提起的地方不建）']) expect(system()).toContain(rule);
    expect(checklist()).toContain('到了【已知地点】里没有、有专有名称的地点 → scenes.add');
    expect(checklist()).toContain('泛称(酒馆、路边之类)只写进 location、不建点,只被提起或约好以后去的地方不建');
  });
});

describe('1.4.5 预填充', () => {
  it('以核查清单第一项的标签收尾,接着写盘点;不再以「完成后闭合检查块」整句收尾', () => {
    const { prefill } = p.buildSummaryThinking('主角');
    expect(prefill.startsWith('<thinking>\n')).toBe(true);
    expect(prefill.endsWith('\n1. 本楼定位:')).toBe(true);
    expect(checklist()).toContain('\n1. 本楼定位:');
    expect(prefill).toContain('按核查清单逐项盘点');
    expect(prefill).not.toMatch(/完成后闭合检查块，再输出一个完整 JSON 对象。$/);
  });
});
