import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { api, PlayRecord as ApiPlayRecord, Favorite as ApiFavorite } from "./api";
import { storageConfig } from "./storageConfig";
import { Logger } from '@/utils/Logger';
import { utf8ByteLength } from '../utils/utf8ByteLength';
import type { EpgData } from "./epg";

const logger = Logger.withTag('Storage');

// --- Storage Keys ---
const STORAGE_KEYS = {
  SETTINGS: "mytv_settings",
  PLAYER_SETTINGS: "mytv_player_settings",
  FAVORITES: "mytv_favorites",
  PLAY_RECORDS: "mytv_play_records",
  SEARCH_HISTORY: "mytv_search_history",
  LOGIN_CREDENTIALS: "mytv_login_credentials",
  M3U_CACHE_PREFIX: "mytv_m3u_cache_",
  EPG_CACHE_PREFIX: "mytv_epg_cache_",
  LIVE_LAST_CHANNEL: "mytv_live_last_channel",
  LIVE_FAV_CHANNELS: "mytv_live_fav_channels",
} as const;

// --- Type Definitions (aligned with api.ts) ---
// Re-exporting for consistency, though they are now primarily API types
export type PlayRecord = ApiPlayRecord & {
  introEndTime?: number;
  outroStartTime?: number;
};
export type Favorite = ApiFavorite;

export interface PlayerSettings {
  introEndTime?: number;
  outroStartTime?: number;
  playbackRate?: number;
}

export interface AppSettings {
  apiBaseUrl: string;
  remoteInputEnabled: boolean;
  videoSource: {
    enabledAll: boolean;
    sources: {
      [key: string]: boolean;
    };
  };
  m3uUrl: string;
  /** 播到片头时自动跳到片头结束处（默认开启） */
  autoSkipIntro?: boolean;
  /** 没手动标记过片头时间时，默认跳过的片头时长（秒）；0 表示不用默认时长、只用手动标记 */
  introSkipSeconds?: number;
  /** 播到片尾附近时弹出下一集预告（默认开启） */
  nextEpisodeOverlayEnabled?: boolean;
  /** 无痕模式：开启后不写入播放记录（默认关闭） */
  incognitoMode?: boolean;
  /** 后台播放与画中画：切到后台继续播放音频，支持的设备自动进画中画（默认关闭） */
  backgroundPlayback?: boolean;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

// --- Helper ---
// 记录键：`${source}+${id}`。source/id 里若含 '+'，直接拼接会碰撞——
// (source="a+b", id="c") 与 (source="a", id="b+c") 拼出同一个键，后者
// 会覆盖前者的记录。转义只针对分隔符 '+' 与转义符 '%' 本身，不含这两
// 者的键与旧格式逐字节相同（存量数据不受影响）。
const escapeKeyPart = (s: string) => s.replace(/%/g, "%25").replace(/\+/g, "%2B");
const unescapeKeyPart = (s: string) => s.replace(/%2B/g, "+").replace(/%25/g, "%");
const generateKey = (source: string, id: string) => `${escapeKeyPart(source)}+${escapeKeyPart(id)}`;

/** 解析记录键：按最后一个 '+' 切分后反转义（与 generateKey 配对） */
export function parseRecordKey(key: string): { source: string; id: string } {
  const sep = key.lastIndexOf("+");
  if (sep < 0) return { source: unescapeKeyPart(key), id: "" };
  return {
    source: unescapeKeyPart(key.slice(0, sep)),
    id: unescapeKeyPart(key.slice(sep + 1)),
  };
}

// 本地写序列化：AsyncStorage 读-改-写不是原子的，并发写会互相覆盖
// （播放记录节流保存与切集/标记片头同时写时，旧快照会盖掉新位置；
// 连续点两次收藏时，两次 toggle 可能读到同一个旧快照）。
// 一条 promise 链把本地写操作排队；链本身不断（任务抛错也不影响后续任务），
// 但调用方仍能拿到自己任务的抛错。
let localWriteChain: Promise<void> = Promise.resolve();
const enqueueLocalWrite = <T>(task: () => Promise<T>): Promise<T> => {
  const run = localWriteChain.then(task, task);
  localWriteChain = run.then(
    () => {},
    () => {},
  );
  return run;
};

// 服务端收藏切换也串行：API 路径的 toggle 是“先查后改”两次请求，连续点两次
// 收藏并发时都会读到同一个旧状态，结果是收藏两次还是收藏（应为取消收藏）
// ——与本地路径同类的竞态（第 15 轮只修了本地路径）
let apiToggleChain: Promise<void> = Promise.resolve();
const enqueueApiToggle = <T>(task: () => Promise<T>): Promise<T> => {
  const run = apiToggleChain.then(task, task);
  apiToggleChain = run.then(
    () => {},
    () => {},
  );
  return run;
};

// --- PlayerSettingsManager (Uses AsyncStorage) ---
/** 播放器个性化设置上限（仅用户自定义过片头/片尾/倍速的条目才会写入） */
const MAX_PLAYER_SETTINGS = 200;

export class PlayerSettingsManager {
  static async getAll(): Promise<Record<string, PlayerSettings>> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.PLAYER_SETTINGS);
      return data ? JSON.parse(data) : {};
    } catch (error) {
      logger.info("Failed to get all player settings:", error);
      return {};
    }
  }

  static async get(source: string, id: string): Promise<PlayerSettings | null> {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayerSettingsManager.get START - source: ${source}, id: ${id}`);
    
    const allSettings = await this.getAll();
    const result = allSettings[generateKey(source, id)] || null;
    
    const perfEnd = performance.now();
    logger.info(`[PERF] PlayerSettingsManager.get END - took ${(perfEnd - perfStart).toFixed(2)}ms, found: ${!!result}`);
    
    return result;
  }

  static async save(source: string, id: string, settings: PlayerSettings): Promise<void> {
    return enqueueLocalWrite(async () => {
      const allSettings = await this.getAll();
      const key = generateKey(source, id);
      // Only save if there are actual values to save
      if (settings.introEndTime !== undefined || settings.outroStartTime !== undefined || settings.playbackRate !== undefined) {
        allSettings[key] = { ...allSettings[key], ...settings };
        // 超限时按插入顺序淘汰最旧条目（字符串 key 保持插入序）
        const keys = Object.keys(allSettings);
        if (keys.length > MAX_PLAYER_SETTINGS) {
          keys.slice(0, keys.length - MAX_PLAYER_SETTINGS).forEach((k) => delete allSettings[k]);
        }
      } else {
        // If all are undefined, remove the key
        delete allSettings[key];
      }
      await AsyncStorage.setItem(STORAGE_KEYS.PLAYER_SETTINGS, JSON.stringify(allSettings));
    });
  }

  static async remove(source: string, id: string): Promise<void> {
    return enqueueLocalWrite(async () => {
      const allSettings = await this.getAll();
      delete allSettings[generateKey(source, id)];
      await AsyncStorage.setItem(STORAGE_KEYS.PLAYER_SETTINGS, JSON.stringify(allSettings));
    });
  }

  static async clearAll(): Promise<void> {
    return enqueueLocalWrite(async () => {
      await AsyncStorage.removeItem(STORAGE_KEYS.PLAYER_SETTINGS);
    });
  }
}

// --- FavoriteManager (Dynamic: API or LocalStorage) ---
export class FavoriteManager {
  private static getStorageType() {
    return storageConfig.getStorageType();
  }

  static async getAll(): Promise<Record<string, Favorite>> {
    if (this.getStorageType() === "localstorage") {
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEYS.FAVORITES);
        return data ? JSON.parse(data) : {};
      } catch (error) {
        logger.info("Failed to get all local favorites:", error);
        return {};
      }
    }
    // 服务端空收藏可能返回 null：直接返回会让调用方 Object.entries(null) 抛错，
    // 收藏页变错误态；空对象才是“无收藏”的正确表示。
    const data = await api.getFavorites();
    return (data as Record<string, Favorite> | null) ?? {};
  }

  static async save(source: string, id: string, item: Favorite): Promise<void> {
    const key = generateKey(source, id);
    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        const allFavorites = await this.getAll();
        allFavorites[key] = { ...item, save_time: Date.now() };
        await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(allFavorites));
      });
    }
    await api.addFavorite(key, item);
  }

  static async remove(source: string, id: string): Promise<void> {
    const key = generateKey(source, id);
    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        const allFavorites = await this.getAll();
        delete allFavorites[key];
        await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(allFavorites));
      });
    }
    await api.deleteFavorite(key);
  }

  static async isFavorited(source: string, id: string): Promise<boolean> {
    const key = generateKey(source, id);
    if (this.getStorageType() === "localstorage") {
      const allFavorites = await this.getAll();
      return !!allFavorites[key];
    }
    const favorite = await api.getFavorites(key);
    return favorite !== null;
  }

  static async toggle(source: string, id: string, item: Favorite): Promise<boolean> {
    // 整段“查-改”放进同一个写任务：否则连续点两次收藏，两次都会读到同一个旧快照，
    // 结果是收藏两次还是收藏（应为取消收藏）。
    // 注意：任务里直接读写，不调本类的 save/remove（它们自己也会进队，会死锁）。
    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        const key = generateKey(source, id);
        const allFavorites = await this.getAll();
        if (allFavorites[key]) {
          delete allFavorites[key];
          await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(allFavorites));
          return false;
        }
        allFavorites[key] = { ...item, save_time: Date.now() };
        await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(allFavorites));
        return true;
      });
    }
    // 服务端路径也要串行（enqueueApiToggle）：两次 toggle 并发时都会读到
    // 同一个旧状态，收藏两次还是收藏（应为取消收藏）
    return enqueueApiToggle(async () => {
      const isFav = await this.isFavorited(source, id);
      if (isFav) {
        await this.remove(source, id);
        return false;
      } else {
        await this.save(source, id, item);
        return true;
      }
    });
  }

  static async clearAll(): Promise<void> {
    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        await AsyncStorage.removeItem(STORAGE_KEYS.FAVORITES);
      });
    }
    await api.deleteFavorite();
  }
}

// --- PlayRecordManager (Dynamic: API or LocalStorage) ---
/** 本地播放记录上限：防止 AsyncStorage 无限增长（Android 单 key 约 6MB 上限） */
const MAX_PLAY_RECORDS = 200;

export class PlayRecordManager {
  private static getStorageType() {
    return storageConfig.getStorageType();
  }

  static async getAll(): Promise<Record<string, PlayRecord>> {
    const perfStart = performance.now();
    const storageType = this.getStorageType();
    logger.info(`[PERF] PlayRecordManager.getAll START - storageType: ${storageType}`);
    
    let apiRecords: Record<string, PlayRecord> = {};
    if (storageType === "localstorage") {
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEYS.PLAY_RECORDS);
        apiRecords = data ? JSON.parse(data) : {};
      } catch (error) {
        logger.info("Failed to get all local play records:", error);
        return {};
      }
    } else {
      const apiStart = performance.now();
      logger.info(`[PERF] API getPlayRecords START`);
      
      apiRecords = (await api.getPlayRecords()) ?? {};
      
      const apiEnd = performance.now();
      logger.info(`[PERF] API getPlayRecords END - took ${(apiEnd - apiStart).toFixed(2)}ms, records: ${Object.keys(apiRecords).length}`);
    }

    const localSettings = await PlayerSettingsManager.getAll();
    const mergedRecords: Record<string, PlayRecord> = {};
    for (const key in apiRecords) {
      mergedRecords[key] = {
        ...apiRecords[key],
        ...localSettings[key],
      };
    }
    
    const perfEnd = performance.now();
    logger.info(`[PERF] PlayRecordManager.getAll END - took ${(perfEnd - perfStart).toFixed(2)}ms, total records: ${Object.keys(mergedRecords).length}`);
    
    return mergedRecords;
  }

  static async save(source: string, id: string, record: Omit<PlayRecord, "save_time">): Promise<void> {
    const key = generateKey(source, id);
    const { introEndTime, outroStartTime, ...apiRecord } = record;

    // Player settings are always saved locally
    await PlayerSettingsManager.save(source, id, { introEndTime, outroStartTime });

    // 无痕模式：只拦截播放记录（最近播放/断点续播）写入，片头片尾标记等
    // 播放器个性化设置不受影响，收藏也不受影响。
    const { incognitoMode } = await SettingsManager.get();
    if (incognitoMode) {
      logger.info("[INCOGNITO] Skip saving play record");
      return;
    }

    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        const allRecords = await this.getAll();
        const fullRecord = { ...apiRecord, save_time: Date.now() };
        allRecords[key] = { ...allRecords[key], ...fullRecord };
        // 超限时按 save_time 淘汰最旧的记录
        const keys = Object.keys(allRecords);
        if (keys.length > MAX_PLAY_RECORDS) {
          keys
            .sort((a, b) => (allRecords[a].save_time || 0) - (allRecords[b].save_time || 0))
            .slice(0, keys.length - MAX_PLAY_RECORDS)
            .forEach((k) => delete allRecords[k]);
        }
        await AsyncStorage.setItem(STORAGE_KEYS.PLAY_RECORDS, JSON.stringify(allRecords));
      });
    } else {
      await api.savePlayRecord(key, apiRecord);
    }
  }

  static async get(source: string, id: string): Promise<PlayRecord | null> {
    const perfStart = performance.now();
    const key = generateKey(source, id);
    const storageType = this.getStorageType();
    logger.info(`[PERF] PlayRecordManager.get START - source: ${source}, id: ${id}, storageType: ${storageType}`);
    
    const records = await this.getAll();
    const result = records[key] || null;
    
    const perfEnd = performance.now();
    logger.info(`[PERF] PlayRecordManager.get END - took ${(perfEnd - perfStart).toFixed(2)}ms, found: ${!!result}`);
    
    return result;
  }

  static async remove(source: string, id: string): Promise<void> {
    const key = generateKey(source, id);
    await PlayerSettingsManager.remove(source, id); // Always remove local settings

    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        const allRecords = await this.getAll();
        delete allRecords[key];
        await AsyncStorage.setItem(STORAGE_KEYS.PLAY_RECORDS, JSON.stringify(allRecords));
      });
    } else {
      await api.deletePlayRecord(key);
    }
  }

  static async clearAll(): Promise<void> {
    await PlayerSettingsManager.clearAll(); // Always clear local settings

    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        await AsyncStorage.removeItem(STORAGE_KEYS.PLAY_RECORDS);
      });
    } else {
      await api.deletePlayRecord();
    }
  }
}

// --- SearchHistoryManager (Dynamic: API or LocalStorage) ---
export class SearchHistoryManager {
  private static getStorageType() {
    return storageConfig.getStorageType();
  }

  static async get(): Promise<string[]> {
    if (this.getStorageType() === "localstorage") {
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEYS.SEARCH_HISTORY);
        return data ? JSON.parse(data) : [];
      } catch (error) {
        logger.info("Failed to get local search history:", error);
        return [];
      }
    }
    // 服务端空历史可能返回 null：直接返回会让调用方 setSearchHistory(null)，
    // 搜索页渲染 searchHistory.map 时白屏；空数组才是“无历史”的正确表示。
    return (await api.getSearchHistory()) ?? [];
  }

  static async add(keyword: string): Promise<void> {
    const trimmed = keyword.trim();
    if (!trimmed) return;

    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        let history = await this.get();
        history = [trimmed, ...history.filter((k) => k !== trimmed)].slice(0, 20); // Keep latest 20
        await AsyncStorage.setItem(STORAGE_KEYS.SEARCH_HISTORY, JSON.stringify(history));
      });
    }
    await api.addSearchHistory(trimmed);
  }

  static async clear(): Promise<void> {
    if (this.getStorageType() === "localstorage") {
      return enqueueLocalWrite(async () => {
        await AsyncStorage.removeItem(STORAGE_KEYS.SEARCH_HISTORY);
      });
    }
    await api.deleteSearchHistory();
  }
}

// --- M3U 列表缓存（V1.5：直播页秒进） ---
/** m3u 磁盘缓存有效期（毫秒）：7 天内直接用缓存，后台刷新成功后更新 */
const M3U_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存 JSON 体积上限：超大列表不落盘（AsyncStorage 单 key 6MB 上限的一半，留安全余量） */
const MAX_M3U_CACHE_BYTES = 3 * 1024 * 1024;

export interface M3uCacheEntry {
  ts: number;
  channels: { id: string; name: string; url: string; logo: string; group: string; tvgId: string; urls: string[] }[];
}

export class M3uCacheManager {
  static async get(m3uUrl: string): Promise<M3uCacheEntry | null> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.M3U_CACHE_PREFIX + m3uUrl);
      if (!data) return null;
      // 体积预检：按 UTF-8 字节算（中文列表用 data.length 会少算约 3 倍，
      // 与 m3u8.ts 的 R16 修复同类问题）；超限视为不可用
      if (utf8ByteLength(data) > MAX_M3U_CACHE_BYTES) return null;
      const entry = JSON.parse(data) as M3uCacheEntry;
      if (!entry || !Array.isArray(entry.channels)) return null;
      // ts 缺失/非数字时当作过期：否则 NaN 比较永远为 false，
      // 一条损坏的缓存会当成永不过期的新鲜缓存
      if (typeof entry.ts !== "number" || Date.now() - entry.ts > M3U_CACHE_TTL_MS) return null; // 过期视为未命中
      return entry;
    } catch (error) {
      logger.info("Failed to get m3u cache:", error);
      return null;
    }
  }

  static async save(m3uUrl: string, channels: M3uCacheEntry["channels"]): Promise<void> {
    try {
      const entry: M3uCacheEntry = { ts: Date.now(), channels };
      const json = JSON.stringify(entry);
      if (utf8ByteLength(json) > MAX_M3U_CACHE_BYTES) {
        logger.info(`m3u cache skipped (too large): ${utf8ByteLength(json)} bytes`);
        return;
      }
      await AsyncStorage.setItem(STORAGE_KEYS.M3U_CACHE_PREFIX + m3uUrl, json);
    } catch (error) {
      logger.info("Failed to save m3u cache:", error);
    }
  }

  static async clear(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const m3uKeys = keys.filter((k) => k.startsWith(STORAGE_KEYS.M3U_CACHE_PREFIX));
      // AsyncStorage 3.x 已移除 multiRemove，改用 removeItem 逐个删除
      if (m3uKeys.length > 0) await Promise.all(m3uKeys.map((k) => AsyncStorage.removeItem(k)));
    } catch (error) {
      logger.info("Failed to clear m3u cache:", error);
    }
  }
}

// --- EPG 节目单缓存（直播面板节目单秒显，与 M3U 缓存同款模式） ---
/** EPG 磁盘缓存有效期（毫秒）：节目单每天凌晨更新，6 小时内直接用缓存 */
const EPG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface EpgCacheEntry {
  ts: number;
  data: EpgData;
}

export class EpgCacheManager {
  static async get(epgUrl: string): Promise<EpgCacheEntry | null> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.EPG_CACHE_PREFIX + epgUrl);
      if (!data) return null;
      if (utf8ByteLength(data) > MAX_M3U_CACHE_BYTES) return null;
      const entry = JSON.parse(data) as EpgCacheEntry;
      if (!entry || !entry.data || !entry.data.channels || typeof entry.data.channels !== 'object') return null;
      if (typeof entry.ts !== 'number' || Date.now() - entry.ts > EPG_CACHE_TTL_MS) return null; // 过期视为未命中
      return entry;
    } catch (error) {
      logger.info('Failed to get epg cache:', error);
      return null;
    }
  }

  static async save(epgUrl: string, data: EpgData): Promise<void> {
    try {
      const entry: EpgCacheEntry = { ts: Date.now(), data };
      const json = JSON.stringify(entry);
      if (utf8ByteLength(json) > MAX_M3U_CACHE_BYTES) {
        logger.info(`epg cache skipped (too large): ${utf8ByteLength(json)} bytes`);
        return;
      }
      await AsyncStorage.setItem(STORAGE_KEYS.EPG_CACHE_PREFIX + epgUrl, json);
    } catch (error) {
      logger.info('Failed to save epg cache:', error);
    }
  }

  static async clear(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const epgKeys = keys.filter((k) => k.startsWith(STORAGE_KEYS.EPG_CACHE_PREFIX));
      if (epgKeys.length > 0) await Promise.all(epgKeys.map((k) => AsyncStorage.removeItem(k)));
    } catch (error) {
      logger.info('Failed to clear epg cache:', error);
    }
  }
}

// --- 直播频道偏好（V1.5：上次频道 + 频道收藏） ---
export interface LiveLastChannel {
  url: string;
  name: string;
}

export class LiveChannelPrefsManager {
  /** 记住上次观看的直播频道（按 url 恢复，列表刷新后仍能定位） */
  static async getLastChannel(): Promise<LiveLastChannel | null> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.LIVE_LAST_CHANNEL);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.info("Failed to get last live channel:", error);
      return null;
    }
  }

  static async saveLastChannel(channel: LiveLastChannel): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.LIVE_LAST_CHANNEL, JSON.stringify(channel));
    } catch (error) {
      logger.info("Failed to save last live channel:", error);
    }
  }

  /** 收藏的直播频道（本地存储，不进点播收藏体系；上限 100 防无限增长） */
  static async getFavChannels(): Promise<LiveLastChannel[]> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.LIVE_FAV_CHANNELS);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      logger.info("Failed to get favorite live channels:", error);
      return [];
    }
  }

  static async toggleFavChannel(channel: LiveLastChannel): Promise<boolean> {
    // 整段“查-改”放进同一个写任务：否则连点两次菜单键，两次都会读到同一个旧列表
    return enqueueLocalWrite(async () => {
      const favs = await this.getFavChannels();
      const idx = favs.findIndex((c) => c.url === channel.url);
      if (idx >= 0) {
        favs.splice(idx, 1);
        await AsyncStorage.setItem(STORAGE_KEYS.LIVE_FAV_CHANNELS, JSON.stringify(favs));
        return false; // 已取消收藏
      }
      favs.unshift({ url: channel.url, name: channel.name });
      if (favs.length > 100) favs.length = 100;
      await AsyncStorage.setItem(STORAGE_KEYS.LIVE_FAV_CHANNELS, JSON.stringify(favs));
      return true; // 已收藏
    });
  }

  static isFavChannels(favs: LiveLastChannel[], url: string): boolean {
    return favs.some((c) => c.url === url);
  }
}

// --- SettingsManager (Uses AsyncStorage) ---
export class SettingsManager {
  static async get(): Promise<AppSettings> {
    const defaultSettings: AppSettings = {
      apiBaseUrl: "",
      remoteInputEnabled: true,
      videoSource: {
        enabledAll: true,
        sources: {},
      },
      m3uUrl: "",
      autoSkipIntro: true,
      introSkipSeconds: 90,
      nextEpisodeOverlayEnabled: true,
      incognitoMode: false,
      backgroundPlayback: false,
    };
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (!data) return defaultSettings;
      const parsed = JSON.parse(data);
      const merged: AppSettings = { ...defaultSettings, ...(parsed && typeof parsed === "object" ? parsed : {}) };
      // videoSource 深合并：已存的部分 videoSource（如旧版本缺 sources）不能
      // 整体覆盖默认值，否则 detailStore 访问 videoSource.sources[r.key] 抛 TypeError
      const savedVideoSource = (parsed as Partial<AppSettings>)?.videoSource;
      merged.videoSource = {
        ...defaultSettings.videoSource,
        ...(savedVideoSource && typeof savedVideoSource === "object" ? savedVideoSource : {}),
      };
      if (!merged.videoSource.sources || typeof merged.videoSource.sources !== "object" || Array.isArray(merged.videoSource.sources)) {
        merged.videoSource.sources = {};
      }
      return merged;
    } catch (error) {
      logger.info("Failed to get settings:", error);
      return defaultSettings;
    }
  }

  static async save(settings: Partial<AppSettings>): Promise<void> {
    return enqueueLocalWrite(async () => {
      const currentSettings = await this.get();
      const updatedSettings = { ...currentSettings, ...settings };
      await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updatedSettings));
    });
  }

  static async reset(): Promise<void> {
    // 必须走写队列：直接 removeItem 会绕过队列，若有 save 在排队/在途，
    // remove 先执行、save 后写入，设置就“复活”了。
    return enqueueLocalWrite(async () => {
      await AsyncStorage.removeItem(STORAGE_KEYS.SETTINGS);
    });
  }
}

// --- LoginCredentialsManager (Uses expo-secure-store) ---
// 安全说明：登录凭据必须存放在系统级安全存储（iOS Keychain / Android Keystore），
// 而不是 AsyncStorage（明文）。SecureStore 在设备锁定时加密，卸载 App 后由系统清理。
export class LoginCredentialsManager {
  static async get(): Promise<LoginCredentials | null> {
    try {
      const data = await SecureStore.getItemAsync(STORAGE_KEYS.LOGIN_CREDENTIALS);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.info("Failed to get login credentials:", error);
      return null;
    }
  }

  static async save(credentials: LoginCredentials): Promise<void> {
    try {
      await SecureStore.setItemAsync(
        STORAGE_KEYS.LOGIN_CREDENTIALS,
        JSON.stringify(credentials)
      );
      // 兼容：清理旧版存在 AsyncStorage 里的明文凭据
      await AsyncStorage.removeItem(STORAGE_KEYS.LOGIN_CREDENTIALS);
    } catch (error) {
      // 记日志后必须 rethrow：静默吞掉会让调用方以为保存成功，下次
      // 启动自动登录时才发现凭据不在（LoginModal 会据此提示用户）。
      logger.error("Failed to save login credentials:", error);
      throw error;
    }
  }

  static async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEYS.LOGIN_CREDENTIALS);
      // 兼容：同时清理旧版明文残留
      await AsyncStorage.removeItem(STORAGE_KEYS.LOGIN_CREDENTIALS);
    } catch (error) {
      // 同 save：调用方（authStore logout）已有 try/catch，会记日志并
      // 继续退出流程；这里 rethrow 是为了让调用方知道清理没成功。
      logger.error("Failed to clear login credentials:", error);
      throw error;
    }
  }
}
