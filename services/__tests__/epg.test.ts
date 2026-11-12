import {
  parseEpgXml,
  parseEpgTime,
  findEpgForChannel,
  currentProgrammes,
  programmeProgress,
} from '../epg';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
<channel id="cctv1"><display-name>CCTV-1 综合</display-name></channel>
<channel id="cctv13"><display-name>CCTV-13 新闻</display-name></channel>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800">
    <title lang="zh">朝闻天下</title>
  </programme>
<programme channel="cctv1" start="20261112090000 +0800" stop="20261112100000 +0800">
    <title lang="zh">新闻直播间 &amp; 特别节目</title>
  </programme>
<programme channel="cctv1" start="20261112100000 +0800" stop="20261112103000 +0800">
    <title lang="zh">午间节目</title>
  </programme>
<programme channel="cctv13" start="20261112080000 +0800" stop="20261112083000 +0800">
    <title lang="zh">新闻30分</title>
  </programme>
</tv>`;

// 2026-11-12 08:30:00 +0800 = 2026-11-12T00:30:00Z
const T_0830 = Date.UTC(2026, 10, 12, 0, 30, 0);

describe('parseEpgTime', () => {
  it('解析主格式 yyyyMMddHHmmss +0800', () => {
    expect(parseEpgTime('20261112080000 +0800')).toBe(Date.UTC(2026, 10, 12, 0, 0, 0));
  });

  it('解析贴时区格式', () => {
    expect(parseEpgTime('20261112080000+0800')).toBe(Date.UTC(2026, 10, 12, 0, 0, 0));
  });

  it('解析冒号时区格式', () => {
    expect(parseEpgTime('20261112080000 +08:00')).toBe(Date.UTC(2026, 10, 12, 0, 0, 0));
  });

  it('解析无时区格式（按本地时间）', () => {
    const local = new Date(2026, 10, 12, 8, 0, 0).getTime();
    expect(parseEpgTime('20261112080000')).toBe(local);
  });

  it('非法时间返回 0', () => {
    expect(parseEpgTime('')).toBe(0);
    expect(parseEpgTime('not-a-time')).toBe(0);
    expect(parseEpgTime('20261112')).toBe(0);
  });
});

describe('parseEpgXml', () => {
  it('解析频道与节目', () => {
    const data = parseEpgXml(SAMPLE_XML);
    expect(Object.keys(data.channels).sort()).toEqual(['cctv1', 'cctv13']);
    expect(data.channels.cctv1.name).toBe('CCTV-1 综合');
    expect(data.channels.cctv1.programmes).toHaveLength(3);
    expect(data.channels.cctv1.programmes[0].title).toBe('朝闻天下');
    expect(data.channels.cctv1.programmes[0].startAt).toBe(Date.UTC(2026, 10, 12, 0, 0, 0));
    expect(data.channels.cctv1.programmes[0].endAt).toBe(Date.UTC(2026, 10, 12, 1, 0, 0));
  });

  it('解 XML 实体', () => {
    const data = parseEpgXml(SAMPLE_XML);
    expect(data.channels.cctv1.programmes[1].title).toBe('新闻直播间 & 特别节目');
  });

  it('跳过脏节目（时间解析失败 / 结束早于开始），不拖垮整个节目单', () => {
    const dirty = `<tv>
<channel id="cctv1"><display-name>CCTV-1 综合</display-name></channel>
<programme channel="cctv1" start="bad" stop="20261112090000 +0800"><title>坏时间</title></programme>
<programme channel="cctv1" start="20261112090000 +0800" stop="20261112090000 +0800"><title>零时长</title></programme>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800"><title>好节目</title></programme>
</tv>`;
    const data = parseEpgXml(dirty);
    expect(data.channels.cctv1.programmes).toHaveLength(1);
    expect(data.channels.cctv1.programmes[0].title).toBe('好节目');
  });

  it('节目按开始时间排序', () => {
    const reversed = `<tv>
<channel id="cctv1"><display-name>CCTV-1 综合</display-name></channel>
<programme channel="cctv1" start="20261112100000 +0800" stop="20261112110000 +0800"><title>后</title></programme>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800"><title>前</title></programme>
</tv>`;
    const data = parseEpgXml(reversed);
    expect(data.channels.cctv1.programmes.map((p) => p.title)).toEqual(['前', '后']);
  });

  it('display-name 带 lang 属性也能解析', () => {
    const xml = `<tv>
<channel id="cctv1"><display-name lang="zh">CCTV-1 综合</display-name></channel>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800"><title>朝闻天下</title></programme>
</tv>`;
    const data = parseEpgXml(xml);
    expect(data.channels.cctv1.name).toBe('CCTV-1 综合');
    expect(data.channels.cctv1.programmes).toHaveLength(1);
  });

  it('空 XML 返回空节目单，不抛错', () => {
    expect(parseEpgXml('')).toEqual({ channels: {} });
    expect(parseEpgXml('<tv></tv>')).toEqual({ channels: {} });
  });
});

describe('findEpgForChannel', () => {
  const data = parseEpgXml(SAMPLE_XML);

  it('tvg-id 精确匹配（直播源名与节目单名写法不同也能对上）', () => {
    // 直播源叫“CCTV综合”，节目单叫“CCTV-1 综合”，靠 tvg-id 对上
    expect(findEpgForChannel(data, 'cctv1', 'CCTV综合')?.id).toBe('cctv1');
  });

  it('无 tvg-id 时按名字兜底匹配', () => {
    expect(findEpgForChannel(data, '', 'CCTV-1 综合')?.id).toBe('cctv1');
    expect(findEpgForChannel(data, '', 'CCTV-1综合')?.id).toBe('cctv1');
  });

  it('对不上返回 null', () => {
    expect(findEpgForChannel(data, 'not-exist', '不存在的台')).toBeNull();
    expect(findEpgForChannel(null, 'cctv1', 'CCTV综合')).toBeNull();
  });
});

describe('currentProgrammes', () => {
  const data = parseEpgXml(SAMPLE_XML);
  const cctv1 = data.channels.cctv1;

  it('返回正在播与下一个节目', () => {
    const cur = currentProgrammes(cctv1, T_0830);
    expect(cur?.now?.title).toBe('朝闻天下');
    expect(cur?.next?.title).toBe('新闻直播间 & 特别节目');
  });

  it('节目交界点算下一条在播', () => {
    const at0900 = Date.UTC(2026, 10, 12, 1, 0, 0);
    const cur = currentProgrammes(cctv1, at0900);
    expect(cur?.now?.title).toBe('新闻直播间 & 特别节目');
    expect(cur?.next?.title).toBe('午间节目');
  });

  it('第一条节目开始前：now 为空，next 是第一条', () => {
    const before = Date.UTC(2026, 10, 11, 23, 0, 0);
    const cur = currentProgrammes(cctv1, before);
    expect(cur?.now).toBeNull();
    expect(cur?.next?.title).toBe('朝闻天下');
  });

  it('最后一条结束后返回 null', () => {
    const after = Date.UTC(2026, 10, 12, 3, 0, 0);
    expect(currentProgrammes(cctv1, after)).toBeNull();
  });

  it('空频道返回 null', () => {
    expect(currentProgrammes(null, T_0830)).toBeNull();
    expect(currentProgrammes({ id: 'x', name: 'x', programmes: [] }, T_0830)).toBeNull();
  });
});

describe('programmeProgress', () => {
  const p = { title: 't', startAt: 1000, endAt: 2000 };

  it('未开始 0、过半 0.5、结束 1', () => {
    expect(programmeProgress(p, 500)).toBe(0);
    expect(programmeProgress(p, 1500)).toBe(0.5);
    expect(programmeProgress(p, 2000)).toBe(1);
    expect(programmeProgress(p, 3000)).toBe(1);
  });

  it('脏节目返回 0', () => {
    expect(programmeProgress({ title: 't', startAt: 2000, endAt: 1000 }, 1500)).toBe(0);
  });
});

describe('parseEpgTime 负时区带分钟（第 5 轮）', () => {
  it('-0530 是 -5.5 小时，不是 -4.5 小时', () => {
    // 2026-11-12 08:00:00 -0530 = 2026-11-12T13:30:00Z
    expect(parseEpgTime('20261112080000 -0530')).toBe(Date.UTC(2026, 10, 12, 13, 30, 0));
  });

  it('+0530 是 +5.5 小时（正时区不受影响）', () => {
    // 2026-11-12 08:00:00 +0530 = 2026-11-12T02:30:00Z
    expect(parseEpgTime('20261112080000 +0530')).toBe(Date.UTC(2026, 10, 12, 2, 30, 0));
  });
});

describe('parseEpgXml CDATA 与 icon-first 频道（第 5 轮）', () => {
  it('CDATA 标题不被丢弃', () => {
    const xml = `<?xml version="1.0"?><tv>
<channel id="cctv1"><display-name>CCTV-1</display-name></channel>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800">
  <title><![CDATA[新闻联播]]></title>
</programme>
</tv>`;
    const data = parseEpgXml(xml);
    expect(data.channels.cctv1.programmes).toHaveLength(1);
    expect(data.channels.cctv1.programmes[0].title).toBe('新闻联播');
  });

  it('CDATA 里的实体不解码（字面量）', () => {
    const xml = `<?xml version="1.0"?><tv>
<channel id="cctv1"><display-name>CCTV-1</display-name></channel>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800">
  <title><![CDATA[A &amp; B]]></title>
</programme>
</tv>`;
    const data = parseEpgXml(xml);
    expect(data.channels.cctv1.programmes[0].title).toBe('A &amp; B');
  });

  it('<icon> 在前的频道不丢名字', () => {
    const xml = `<?xml version="1.0"?><tv>
<channel id="cctv1"><icon src="https://example.test/cctv1.png"/><display-name>CCTV-1 综合</display-name></channel>
</tv>`;
    const data = parseEpgXml(xml);
    expect(data.channels.cctv1.name).toBe('CCTV-1 综合');
  });

  it('display-name 在 CDATA 里也能解析', () => {
    const xml = `<?xml version="1.0"?><tv>
<channel id="cctv1"><display-name><![CDATA[CCTV-1 综合]]></display-name></channel>
</tv>`;
    const data = parseEpgXml(xml);
    expect(data.channels.cctv1.name).toBe('CCTV-1 综合');
  });

  it('数字字符引用超出 BMP 时用 fromCodePoint（emoji 不乱码）', () => {
    const xml = `<?xml version="1.0"?><tv>
<channel id="cctv1"><display-name>CCTV-1</display-name></channel>
<programme channel="cctv1" start="20261112080000 +0800" stop="20261112090000 +0800">
  <title>节目 &#128512;</title>
</programme>
</tv>`;
    const data = parseEpgXml(xml);
    expect(data.channels.cctv1.programmes[0].title).toBe('节目 \u{1F600}');
  });
});
