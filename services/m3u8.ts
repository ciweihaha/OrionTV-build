import { Logger } from '@/utils/Logger';
import { utf8ByteLength } from '@/utils/utf8ByteLength';

const logger = Logger.withTag('M3U8');

interface CacheEntry {
  resolution: string | null;
  timestamp: number;
}

const resolutionCache: { [url: string]: CacheEntry } = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
// 缓存上限：防 URL 枚举导致内存无限增长（R13）
const MAX_CACHE_ENTRIES = 500;
// 播放列表最大体积：m3u8 索引文件通常 < 100KB，1MB 已足够（R13）
const MAX_PLAYLIST_BYTES = 1024 * 1024;
// 默认超时（R13）：外部 signal 与超时联动，任一发生都中止，避免服务端挂起时卡住调用方
const DEFAULT_TIMEOUT_MS = 10_000;

const evictCacheIfNeeded = () => {
  const keys = Object.keys(resolutionCache);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    // 删除最旧的 1/4 条目（按 timestamp）
    const sorted = keys
      .map((k) => ({ k, t: resolutionCache[k].timestamp }))
      .sort((a, b) => a.t - b.t);
    const toDelete = Math.ceil(keys.length / 4);
    for (let i = 0; i < toDelete; i++) {
      delete resolutionCache[sorted[i].k];
    }
    logger.info(`[M3U8] Cache evicted ${toDelete} entries, ${keys.length - toDelete} remaining`);
  }
};

export const getResolutionFromM3U8 = async (
  url: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const perfStart = performance.now();
  logger.info(`[PERF] M3U8 resolution detection START - url: ${url.substring(0, 100)}...`);
  
  // 1. Check cache first
  const cachedEntry = resolutionCache[url];
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_DURATION) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection CACHED - took ${(perfEnd - perfStart).toFixed(2)}ms, resolution: ${cachedEntry.resolution}`);
    return cachedEntry.resolution;
  }

  if (!url.toLowerCase().endsWith(".m3u8")) {
    logger.info(`[PERF] M3U8 resolution detection SKIPPED - not M3U8 file`);
    return null;
  }

  // 外部 signal 与默认超时联动：只传 signal 时若服务端挂起，fetch 会一直等，
  // 详情页的 Promise.all 就卡住、详情出不来。超时与调用方取消任一发生都中止。
  const linked = new AbortController();
  const timeoutId = setTimeout(() => linked.abort(), DEFAULT_TIMEOUT_MS);
  const onCallerAbort = () => linked.abort();
  if (signal) {
    if (signal.aborted) {
      linked.abort();
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  // 失败也缓存（负缓存）：挂掉的 m3u8 不缓存的话，每次打开详情页都要
  // 再等一次 10 秒超时；调用方取消不算失败，不缓存（下次打开重测）
  const cacheResult = (resolution: string | null) => {
    evictCacheIfNeeded();
    resolutionCache[url] = { resolution, timestamp: Date.now() };
  };
  try {
    const fetchStart = performance.now();
    const response = await fetch(url, { signal: linked.signal });
    const fetchEnd = performance.now();
    logger.info(`[PERF] M3U8 fetch took ${(fetchEnd - fetchStart).toFixed(2)}ms, status: ${response.status}`);

    if (!response.ok) {
      cacheResult(null);
      return null;
    }

    const parseStart = performance.now();
    // 流式读取并限制体积：防恶意服务端返回超大播放列表占满内存（R13）
    const playlist = await readTextWithLimit(response, MAX_PLAYLIST_BYTES);
    if (playlist === null) {
      logger.info(`[PERF] M3U8 playlist exceeded ${MAX_PLAYLIST_BYTES} bytes, rejected`);
      cacheResult(null);
      return null;
    }
    const lines = playlist.split("\n");
    let highestResolution = 0;
    let resolutionString: string | null = null;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resolutionMatch) {
          const height = parseInt(resolutionMatch[2], 10);
          if (height > highestResolution) {
            highestResolution = height;
            resolutionString = `${height}p`;
          }
        }
      }
    }
    
    const parseEnd = performance.now();
    logger.info(`[PERF] M3U8 parsing took ${(parseEnd - parseStart).toFixed(2)}ms, lines: ${lines.length}`);

    // 2. Store result in cache
    cacheResult(resolutionString);

    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection COMPLETE - took ${(perfEnd - perfStart).toFixed(2)}ms, resolution: ${resolutionString}`);
    
    return resolutionString;
  } catch (error) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection ERROR - took ${(perfEnd - perfStart).toFixed(2)}ms, error: ${error}`);
    // 调用方取消不缓存；超时/网络错误按失败缓存，避免反复等 10 秒
    if (!signal?.aborted) cacheResult(null);
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", onCallerAbort);
    }
  }
};

/**
 * 流式读取响应体文本，超限返回 null（R13）
 */
const readTextWithLimit = async (response: Response, maxBytes: number): Promise<string | null> => {
  const reader = response.body?.getReader();
  if (!reader) {
    // 无 body 流时回退：按 UTF-8 字节判断（text.length 是 UTF-16 码元数，
    // 中文会低估约 3 倍；与 api.ts / m3u.ts 的 OTV-3 保持一致）
    const text = await response.text();
    return utf8ByteLength(text) <= maxBytes ? text : null;
  }
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
};
