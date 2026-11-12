import { parseM3U, normalizeChannel } from '../m3u';

const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV综合" group-title="央视频道",CCTV综合
https://example.test/ysp/cctv1.m3u8
#EXTINF:-1 tvg-id="cctv2" tvg-name="CCTV财经" group-title="央视频道",CCTV财经
https://example.test/ysp/cctv2.m3u8
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV综合" group-title="央视频道",CCTV综合
https://example.test/backup/cctv1.m3u8
#EXTINF:-1 group-title="卫视频道",湖南卫视
https://example.test/ws/hunan.m3u8
`;

describe('parseM3U', () => {
  it('解析 tvg-id、分组与台名', () => {
    const channels = parseM3U(SAMPLE_M3U);
    const cctv1 = channels.find((c) => c.name === 'CCTV综合');
    expect(cctv1?.tvgId).toBe('cctv1');
    expect(cctv1?.group).toBe('央视频道');
    expect(cctv1?.url).toBe('https://example.test/ysp/cctv1.m3u8');
  });

  it('无 tvg-id 时记空串，不影响其他字段', () => {
    const channels = parseM3U(SAMPLE_M3U);
    const hunan = channels.find((c) => c.name === '湖南卫视');
    expect(hunan?.tvgId).toBe('');
    expect(hunan?.group).toBe('卫视频道');
  });

  it('同名频道合并多线路：只留一条，地址并进 urls', () => {
    const channels = parseM3U(SAMPLE_M3U);
    // CCTV综合出现两次，应合并成一条；共 3 个频道
    expect(channels).toHaveLength(3);
    const cctv1 = channels.find((c) => c.name === 'CCTV综合');
    expect(cctv1?.urls).toEqual([
      'https://example.test/ysp/cctv1.m3u8',
      'https://example.test/backup/cctv1.m3u8',
    ]);
    expect(cctv1?.url).toBe('https://example.test/ysp/cctv1.m3u8');
    expect(cctv1?.id).toBe('https://example.test/ysp/cctv1.m3u8');
  });

  it('重复地址仍只留第一条（不产生重复频道）', () => {
    const dup = `#EXTM3U
#EXTINF:-1 tvg-id="a" group-title="G",台A
https://example.test/a.m3u8
#EXTINF:-1 tvg-id="a" group-title="G",台A
https://example.test/a.m3u8
`;
    const channels = parseM3U(dup);
    expect(channels).toHaveLength(1);
    expect(channels[0].urls).toEqual(['https://example.test/a.m3u8']);
  });

  it('台名带逗号不截断', () => {
    const comma = `#EXTM3U
#EXTINF:-1 tvg-id="x" group-title="G",CCTV-1,高清
https://example.test/x.m3u8
`;
    expect(parseM3U(comma)[0].name).toBe('CCTV-1,高清');
  });
});

describe('normalizeChannel', () => {
  it('旧版缓存缺字段时补默认值', () => {
    const ch = normalizeChannel({ url: 'https://example.test/a.m3u8', name: '台A' });
    expect(ch.id).toBe('https://example.test/a.m3u8');
    expect(ch.tvgId).toBe('');
    expect(ch.urls).toEqual(['https://example.test/a.m3u8']);
    expect(ch.logo).toBe('');
    expect(ch.group).toBe('Default');
  });

  it('新版缓存原样保留', () => {
    const ch = normalizeChannel({
      id: 'id1',
      url: 'https://example.test/a.m3u8',
      name: '台A',
      logo: 'logo.png',
      group: 'G',
      tvgId: 'a',
      urls: ['https://example.test/a.m3u8', 'https://example.test/b.m3u8'],
    });
    expect(ch.urls).toHaveLength(2);
    expect(ch.tvgId).toBe('a');
  });
});

describe('parseM3U 无名频道不合并（第 5 轮）', () => {
  it('两个无名频道各留一条，不并成一个 Unknown', () => {
    const unnamed = `#EXTM3U
#EXTINF:-1,
https://example.test/a.m3u8
#EXTINF:-1,
https://example.test/b.m3u8
`;
    const channels = parseM3U(unnamed);
    expect(channels).toHaveLength(2);
    expect(channels[0].name).toBe('Unknown');
    expect(channels[1].name).toBe('Unknown');
    expect(channels[0].urls).toEqual(['https://example.test/a.m3u8']);
    expect(channels[1].urls).toEqual(['https://example.test/b.m3u8']);
  });

  it('有名称的同名频道仍合并（回归）', () => {
    const named = `#EXTM3U
#EXTINF:-1,台A
https://example.test/a.m3u8
#EXTINF:-1,台A
https://example.test/a2.m3u8
`;
    const channels = parseM3U(named);
    expect(channels).toHaveLength(1);
    expect(channels[0].urls).toEqual(['https://example.test/a.m3u8', 'https://example.test/a2.m3u8']);
  });
});
