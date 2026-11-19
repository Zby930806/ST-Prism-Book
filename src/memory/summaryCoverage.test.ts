import { describe, expect, it } from 'vitest';
import { uncoveredInputs, unrelatedToInputs } from './summaryCoverage';

// 总结写完后核对每条输入有没有被写到。这里的输入和总结都是虚构的短例,只核对判断本身,不代表真实模型的输出。
const inputs = [
  '三月初七傍晚，阿青把借来的灯笼还给云来酒楼的掌柜。掌柜托他带一封信给临水镇的周账房，说信里是今年的茶钱账目，要亲手交到；阿青答应十日内送到，掌柜先付了他三钱银子的脚力，余下的回来再结。临走时掌柜叮嘱他别走北边的山路，那一带近来不太平。',
  '三月初九，阿青搭的货船在柳林渡口被巡检拦下验路引，同船一个卖布的客商拿不出文书，全船耽搁了半日。阿青替船家补交了二两银子的过渡钱才放行，船家抱怨误了潮水，答应到了临水镇把这二两还给他，还另送他一包晒干的鱼。',
  '三月十五日，周账房从乡下收账回到临水镇，阿青在码头边的茶棚里把信交给他。周账房看完信说账目对得上，托阿青带回一包账册和一张收条，要他月底前交给掌柜；又说自己四月要去省城，之后的信改寄到他侄子周小满那里。',
  '三月二十日，阿青回到云来酒楼，掌柜清点账册时发现少了去年冬天的一本，让他回临水镇再问一趟周账房。阿青说来回要六天，掌柜答应再加五钱银子，并把那张收条锁进了柜台下面的铁盒里，钥匙只有掌柜自己有。',
];
const WROTE = [
  '三月初七傍晚，阿青把借来的灯笼还给云来酒楼的掌柜，掌柜托他带一封信给临水镇的周账房，阿青答应十日内送到，掌柜先付了三钱银子的脚力，叮嘱他别走北边的山路。',
  '三月初九，货船在柳林渡口被巡检拦下验路引，耽搁了半日，阿青替船家补交了二两银子的过渡钱才放行，船家答应到了临水镇把这二两还给他。',
  '三月十五日，周账房回到临水镇，阿青在码头边的茶棚里把信交给他；周账房托阿青带回一包账册和一张收条，要他月底前交给掌柜，又说之后的信改寄到他侄子周小满那里。',
  '三月二十日，阿青回到云来酒楼，掌柜清点账册时发现少了去年冬天的一本，让他回临水镇再问一趟周账房，答应再加五钱银子，并把那张收条锁进了柜台下面的铁盒里。',
];
const FULL = WROTE.join('');
const NOTICE = '本次任务未收到可整理的材料：输入中只有任务说明、核对步骤与输出格式，缺少按时间排列的楼层摘要正文，无法据此生成总结，请重新发送完整的材料后再试。';

describe('每条输入有没有被写到', () => {
  it('都写到了：换了说法、删了细节也算', () => {
    expect(uncoveredInputs(inputs, FULL)).toEqual([]);
    expect(uncoveredInputs(inputs, inputs.join(''))).toEqual([]);
  });

  it('漏掉中间一条', () => {
    expect(uncoveredInputs(inputs, WROTE[0] + WROTE[2] + WROTE[3])).toEqual([1]);
  });

  it('写到一半就停：后面的输入都没写到', () => {
    expect(uncoveredInputs(inputs, WROTE[0])).toEqual([1, 2, 3]);
    expect(uncoveredInputs(inputs, inputs[0])).toEqual([1, 2, 3]);
  });

  it('只沾到一两个片段不算写到；一句话带过的算写到', () => {
    // 第二条只剩「柳林渡口被」这一小截(两个独有片段),事情本身没有写
    expect(uncoveredInputs(inputs, WROTE[0] + WROTE[2] + WROTE[3] + '掌柜后来提过柳林渡口被拦的事。')).toEqual([1]);
    // 写得比别的几条简略得多,但这件事在
    expect(uncoveredInputs(inputs, WROTE[0] + '三月初九，货船在柳林渡口被巡检拦下，阿青补交了二两银子。' + WROTE[2] + WROTE[3])).toEqual([]);
  });

  it('按同一次合并里写得最全的那条来比：整篇都改写得多、原样出现的片段少时，不判断', () => {
    // 第二条没有写,但其余三条也都是换了说法写的,原样出现的片段很少:看不出来,不冤枉
    const rewritten = '三月初七阿青归还灯笼并接下送信的差事，脚力先收三钱；三月十五日他见到周账房交了信，带回账本与凭据，月底前要交差；三月二十日酒楼查出账本缺一册，阿青得再跑一趟临水镇。';
    expect(uncoveredInputs(inputs, rewritten)).toEqual([]);
    // 很长的输入只出现零星几个片段(别的输入写得很全):按比例算,三个片段也不算写到
    const long = [inputs.join(''), '四月初二，阿青在省城的客栈里遇见周小满，把掌柜的第二封信交给了他；周小满请他吃了一顿羊肉汤饼，托他给临水镇的叔父捎去两匹青布和一坛桂花酒，约好端午前后在柳林渡口碰头。'];
    expect(uncoveredInputs(long, long[1] + '此前阿青回到云来，又过了些日子。')).toEqual([0]);
    expect(uncoveredInputs(long, long[1] + '此前' + WROTE[3])).toEqual([]);
  });

  it('太短的输入、和别的输入内容相同的输入不判断', () => {
    expect(uncoveredInputs([...inputs, '三月二十一日无事。'], FULL)).toEqual([]);
    // 两条一模一样:各自没有独有的片段,无从判断
    expect(uncoveredInputs([inputs[0], inputs[0]], '别的内容')).toEqual([]);
    expect(uncoveredInputs([], FULL)).toEqual([]);
  });

  it('标点、空白和引号的写法不影响判断', () => {
    const summary = (WROTE[0] + WROTE[2] + WROTE[3]).replace(/，/g, ', ').replace(/。/g, '.\n');
    expect(uncoveredInputs(inputs, summary)).toEqual([1]);
    expect(uncoveredInputs(inputs, FULL.replace(/，/g, ', ').replace(/。/g, '.\n'))).toEqual([]);
  });
});

describe('总结和输入对不上', () => {
  it('交回的是说明文字：没有一处出自输入', () => {
    expect(unrelatedToInputs(inputs, NOTICE)).toBe(true);
    // 这种情况逐条看不出是哪一条没写(没有一条可以作参照),由这一项单独判断
    expect(uncoveredInputs(inputs, NOTICE)).toEqual([]);
  });

  it('正常的总结、改写得多的总结都不算', () => {
    expect(unrelatedToInputs(inputs, FULL)).toBe(false);
    expect(unrelatedToInputs(inputs, WROTE[0])).toBe(false);
    expect(unrelatedToInputs(inputs, '三月初七阿青归还灯笼并接下送信的差事，脚力先收三钱；三月十五日他见到周账房交了信，带回账本与凭据，月底前要交差；三月二十日酒楼查出账本缺一册，阿青得再跑一趟临水镇。')).toBe(false);
  });

  it('输入太少、总结太短，或两边不是同一种文字时不判断', () => {
    expect(unrelatedToInputs(inputs.slice(0, 1), NOTICE)).toBe(false);
    expect(unrelatedToInputs(inputs, '没有收到材料。')).toBe(false);
    const english = Array.from({ length: 4 }, (_, i) => `On day ${i + 1}, Aqing carried the ledger across the river and handed it to the bookkeeper at the old tea stall, who promised to send the receipt back before the end of the month and paid him three coins for the trouble.`);
    expect(unrelatedToInputs(english, FULL)).toBe(false);
    expect(unrelatedToInputs(inputs, english.join(' '))).toBe(false);
  });
});
