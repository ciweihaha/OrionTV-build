import { Logger } from '@/utils/Logger';
import { M3uCacheManager } from './storage';
import { readTextWithLimit } from './httpBody';

const logger = Logger.withTag('M3U');

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
}

const parseM3U = (m3uText: string): Channel[] => {
  const parsedChannels: Channel[] = [];
  // 同一个流地址在列表里出现多次时只留第一条：重复行会让直播列表出现
  // 完全相同的两个频道（数字换台、收藏比对都按 URL 来，也会跟着错乱）
  const seenUrls = new Set<string>();
  const lines = m3uText.split('\n');
  let currentChannelInfo: Partial<Channel> | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('#EXTINF:')) {
      currentChannelInfo = {}; // Start a new channel
      // 台名前的逗号：属性值里可能有逗号（group-title="A,B"），台名里也可能有
      // （"CCTV-1,高清"）——取第一个不在双引号内的逗号；原来用 lastIndexOf，
      // 台名带逗号时会被截成后半截
      let commaIndex = -1;
      let inQuotes = false;
      for (let i = 8; i < trimmedLine.length; i++) {
        const ch = trimmedLine[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) {
          commaIndex = i;
          break;
        }
      }
      if (commaIndex !== -1) {
        currentChannelInfo.name = trimmedLine.substring(commaIndex + 1).trim();
        const attributesPart = trimmedLine.substring(8, commaIndex);
        const logoMatch = attributesPart.match(/tvg-logo="([^"]*)"/i);
        if (logoMatch && logoMatch[1]) {
          currentChannelInfo.logo = logoMatch[1];
        }
        const groupMatch = attributesPart.match(/group-title="([^"]*)"/i);
        if (groupMatch && groupMatch[1]) {
          currentChannelInfo.group = groupMatch[1];
        }
      } else {
        // 没有分隔逗号：后面那段是时长/属性不是台名，留空走 'Unknown' 兜底
        currentChannelInfo.name = '';
      }
    } else if (currentChannelInfo && trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('://')) {
      currentChannelInfo.url = trimmedLine;
      if (seenUrls.has(currentChannelInfo.url)) {
        currentChannelInfo = null; // 重复地址：丢弃这一条
        continue;
      }
      seenUrls.add(currentChannelInfo.url);
      currentChannelInfo.id = currentChannelInfo.url; // Use URL as ID
      
      // Ensure all required fields are present, providing defaults if necessary
      const finalChannel: Channel = {
        id: currentChannelInfo.id,
        url: currentChannelInfo.url,
        name: currentChannelInfo.name || 'Unknown',
        logo: currentChannelInfo.logo || '',
        group: currentChannelInfo.group || 'Default',
      };
      
      parsedChannels.push(finalChannel);
      currentChannelInfo = null; // Reset for the next channel
    }
  }
  return parsedChannels;
};

// M3U 拉取超时（毫秒）
const M3U_FETCH_TIMEOUT_MS = 15_000;
// M3U 播放列表最大体积：频道列表通常 < 1MB，5MB 已足够（R13）
const MAX_M3U_BYTES = 5 * 1024 * 1024;

export const fetchAndParseM3u = async (m3uUrl: string): Promise<Channel[]> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), M3U_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(m3uUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    }
    // 流式读取并限制体积：防超大列表占满内存（R13）。体读取用共享工具的
    // 独立超时 race（M6）：RN 下 response.text() 无法被 fetch 的 AbortSignal
    // 中断，只靠上面的定时器，慢速滴流的服务端能让调用挂起远超 15 秒。
    const m3uText = await readTextWithLimit(response, MAX_M3U_BYTES, M3U_FETCH_TIMEOUT_MS, controller.signal);
    if (m3uText === null) {
      logger.info(`M3U playlist exceeded ${MAX_M3U_BYTES} bytes, rejected: ${m3uUrl.substring(0, 80)}`);
      return [];
    }
    return parseM3U(m3uText);
  } catch (error) {
    logger.info("Error fetching or parsing M3U:", error);
    return []; // Return empty array on error
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getPlayableUrl = (originalUrl: string | null): string | null => {
  if (!originalUrl) {
    return null;
  }
  // 直播流地址直接播放（历史代理方案已下线）。
  return originalUrl;
};

// ---------- V1.5：直播列表缓存（秒进直播页） ----------
// 内存缓存：会话内复用解析结果，避免重复解析大列表
const m3uMemCache = new Map<string, Channel[]>();

/**
 * 读取缓存的频道列表：内存 → 磁盘（7 天有效）。未命中返回空数组。
 * 配合 refreshM3u 使用：先用缓存即时渲染，再拉网络更新。
 */
export const getCachedM3u = async (m3uUrl: string): Promise<Channel[]> => {
  const mem = m3uMemCache.get(m3uUrl);
  if (mem && mem.length > 0) return mem;
  const disk = await M3uCacheManager.get(m3uUrl);
  if (disk && disk.channels.length > 0) {
    m3uMemCache.set(m3uUrl, disk.channels);
    return disk.channels;
  }
  return [];
};

/**
 * 从网络刷新频道列表并写入两级缓存；失败或空列表返回空数组（不覆盖旧缓存）。
 */
export const refreshM3u = async (m3uUrl: string): Promise<Channel[]> => {
  const channels = await fetchAndParseM3u(m3uUrl);
  if (channels.length > 0) {
    m3uMemCache.set(m3uUrl, channels);
    await M3uCacheManager.save(m3uUrl, channels);
  }
  return channels;
};

