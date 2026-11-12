import { Logger } from '@/utils/Logger';
import { readTextWithLimit } from './httpBody';
import { EpgCacheManager } from './storage';

const logger = Logger.withTag('EPG');

/**
 * 默认节目单地址：与天光云影的默认节目单（Constants.EPG_XML_URL）同款，
 * 都是 ysp-ticket Worker 每天早上抓取合并的 XMLTV。频道 id 与直播源
 * live.m3u 的 tvg-id 是同一套（55 个台全部对得上）。
 */
export const DEFAULT_EPG_URL = 'https://ysp.ciweihaha.win/epg.xml';

export interface EpgProgramme {
  title: string;
  /** 开始时间戳（毫秒） */
  startAt: number;
  /** 结束时间戳（毫秒） */
  endAt: number;
}

export interface EpgChannel {
  /** XMLTV channel id（如 cctv1），与 m3u 的 tvg-id 对应 */
  id: string;
  /** display-name（如 CCTV-1 综合） */
  name: string;
  /** 按开始时间升序 */
  programmes: EpgProgramme[];
}

export interface EpgData {
  /** key = channel id */
  channels: Record<string, EpgChannel>;
}

export interface CurrentProgrammes {
  now: EpgProgramme | null;
  next: EpgProgramme | null;
}

// EPG 拉取超时（毫秒）：文件约 400KB，15 秒足够
const EPG_FETCH_TIMEOUT_MS = 15_000;
// EPG 最大体积：当前约 400KB，5MB 已足够
const MAX_EPG_BYTES = 5 * 1024 * 1024;

/**
 * XMLTV 时间解析：主格式 `yyyyMMddHHmmss +0800`。
 * 兜底（与天光云影 parseEpgTimeFallback 同款）：时区贴在秒后面
 * （`20261112080000+0800`）、时区带冒号（`20261112080000 +08:00`）、
 * 不写时区（按本地时间）。全失败返回 0，调用方按脏数据跳过。
 */
export function parseEpgTime(time: string): number {
  const trimmed = time.trim();
  if (trimmed.length < 14) return 0;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?$/.exec(trimmed);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, tzH, tzM] = m;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (tzH !== undefined) {
    // 带时区：按 UTC 算再减时区偏移
    const offsetMs = (Number(tzH) * 60 + Number(tzM ?? '0')) * 60 * 1000;
    return Date.UTC(year, month, day, hour, minute, second) - offsetMs;
  }
  // 无时区：XMLTV 没写时区时就是本地时间
  return new Date(year, month, day, hour, minute, second).getTime();
}

/** 节目时间能不能用：开始或结束解析失败、结束早于等于开始的都是脏数据 */
function isUsableProgramme(p: EpgProgramme): boolean {
  return p.startAt > 0 && p.endAt > p.startAt;
}

/** 解 XML 实体：标题里可能出现 &amp; &lt; 等 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

const CHANNEL_RE = /<channel\s+id="([^"]*)">\s*<display-name[^>]*>([^<]*)<\/display-name>/g;
const PROGRAMME_BLOCK_RE = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/;

/**
 * 解析 XMLTV 文本。容错：单条节目解析失败只跳过这一条，不拖垮整个节目单；
 * 没有节目的频道也保留（显示“暂无节目”而不是查不到频道）。
 */
export function parseEpgXml(xml: string): EpgData {
  const channels: Record<string, EpgChannel> = {};

  CHANNEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHANNEL_RE.exec(xml)) !== null) {
    const id = m[1].trim();
    if (!id) continue;
    if (!channels[id]) {
      channels[id] = { id, name: decodeXmlEntities(m[2].trim()), programmes: [] };
    }
  }

  PROGRAMME_BLOCK_RE.lastIndex = 0;
  while ((m = PROGRAMME_BLOCK_RE.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    const channelId = (attrs.channel ?? '').trim();
    const titleMatch = TITLE_RE.exec(m[2]);
    const title = titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : '';
    const programme: EpgProgramme = {
      title,
      startAt: parseEpgTime(attrs.start ?? ''),
      endAt: parseEpgTime(attrs.stop ?? ''),
    };
    if (!channelId || !title || !isUsableProgramme(programme)) continue;
    // 节目单里出现但 <channel> 段没声明的台也收下（名字用 id 兜底）
    if (!channels[channelId]) {
      channels[channelId] = { id: channelId, name: channelId, programmes: [] };
    }
    channels[channelId].programmes.push(programme);
  }

  for (const ch of Object.values(channels)) {
    ch.programmes.sort((x, y) => x.startAt - y.startAt);
  }
  return { channels };
}

/** 频道名归一化（兜底匹配用）：去空白、连字符、下划线，转小写 */
function normalizeChannelName(name: string): string {
  return name.replace(/[\s\-_]/g, '').toLowerCase();
}

/**
 * 找频道的节目单：先按 tvg-id 精确匹配（直播源与节目单是同一套 id，
 * 55 个台全对得上）；没有 tvg-id 或对不上时按归一化后的名字匹配
 * （名字或 display-name 任一对上即可）。
 */
export function findEpgForChannel(
  epg: EpgData | null,
  tvgId: string,
  name: string,
): EpgChannel | null {
  if (!epg) return null;
  if (tvgId && epg.channels[tvgId]) return epg.channels[tvgId];
  const wanted = normalizeChannelName(name);
  if (!wanted) return null;
  for (const ch of Object.values(epg.channels)) {
    if (normalizeChannelName(ch.name) === wanted || normalizeChannelName(ch.id) === wanted) {
      return ch;
    }
  }
  return null;
}

/**
 * 当前节目 / 下一个节目（与天光云影 Epg.currentProgrammes 同款逻辑）：
 * now = 正在播的那条（startAt <= now < endAt）；next = 当前节目结束
 * 后最早开始的那条；当前没节目时 next = 未来最早开始的那条。
 */
export function currentProgrammes(
  channel: EpgChannel | null,
  now: number = Date.now(),
): CurrentProgrammes | null {
  if (!channel || channel.programmes.length === 0) return null;
  const index = channel.programmes.findIndex((p) => p.startAt <= now && now < p.endAt);
  if (index >= 0) {
    const current = channel.programmes[index];
    const next =
      channel.programmes
        .filter((p) => p.startAt >= current.endAt)
        .sort((a, b) => a.startAt - b.startAt)[0] ??
      channel.programmes.filter((p) => p.startAt > now).sort((a, b) => a.startAt - b.startAt)[0] ??
      null;
    return { now: current, next };
  }
  const next =
    channel.programmes.filter((p) => p.startAt > now).sort((a, b) => a.startAt - b.startAt)[0] ??
    null;
  if (!next) return null;
  return { now: null, next };
}

/** 节目播放进度 0..1（未开始 0，已结束 1） */
export function programmeProgress(p: EpgProgramme, now: number = Date.now()): number {
  if (p.endAt <= p.startAt) return 0;
  const ratio = (now - p.startAt) / (p.endAt - p.startAt);
  return Math.min(1, Math.max(0, ratio));
}

// ---------- EPG 拉取与缓存（与 m3u 同款两级缓存：内存 → 磁盘） ----------

const epgMemCache = new Map<string, EpgData>();

async function fetchAndParseEpg(epgUrl: string): Promise<EpgData | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EPG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(epgUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch EPG: ${response.statusText}`);
    }
    // 体读取用共享工具的独立超时 race（M6）：RN 下 response.text() 无法被
    // fetch 的 AbortSignal 中断，慢速滴流的服务端能让调用挂起远超 15 秒
    const text = await readTextWithLimit(response, MAX_EPG_BYTES, EPG_FETCH_TIMEOUT_MS, controller.signal);
    if (text === null) {
      logger.info(`EPG exceeded ${MAX_EPG_BYTES} bytes, rejected: ${epgUrl.substring(0, 80)}`);
      return null;
    }
    return parseEpgXml(text);
  } catch (error) {
    logger.info('Error fetching or parsing EPG:', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 读缓存的节目单：内存 → 磁盘（6 小时有效）。未命中返回 null。 */
export async function getCachedEpg(epgUrl: string): Promise<EpgData | null> {
  const mem = epgMemCache.get(epgUrl);
  if (mem && Object.keys(mem.channels).length > 0) return mem;
  const disk = await EpgCacheManager.get(epgUrl);
  if (disk && Object.keys(disk.data.channels).length > 0) {
    epgMemCache.set(epgUrl, disk.data);
    return disk.data;
  }
  return null;
}

/** 从网络刷新节目单并写入两级缓存；失败返回 null（不覆盖旧缓存）。 */
export async function refreshEpg(epgUrl: string): Promise<EpgData | null> {
  const data = await fetchAndParseEpg(epgUrl);
  if (data && Object.keys(data.channels).length > 0) {
    epgMemCache.set(epgUrl, data);
    await EpgCacheManager.save(epgUrl, data);
    return data;
  }
  return null;
}
