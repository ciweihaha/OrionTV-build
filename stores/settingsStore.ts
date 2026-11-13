import { create } from "zustand";
import { SettingsManager, LoginCredentialsManager } from "@/services/storage";
import { api, ServerConfig } from "@/services/api";
import { storageConfig } from "@/services/storageConfig";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Logger } from "@/utils/Logger";

const logger = Logger.withTag('SettingsStore');

// 模块级引用：当前正在进行的 fetchServerConfig Promise。
// 供 authStore.checkLoginStatus 直接 await，避免用固定超时轮询导致冷启动误判。
let serverConfigPromise: Promise<void> | null = null;
/** 发起进行中那次 fetch 时的 apiBaseUrl：地址变了就不能复用旧请求，
 * 旧请求回来后也不能再写 store（否则会把旧服务器的配置盖到新地址上）。 */
let serverConfigFetchUrl: string | null = null;

/**
 * 获取当前正在进行的 fetchServerConfig Promise（若没有则返回 null）。
 * 调用方可 await 它以确保 serverConfig 已就绪，而不是用固定超时轮询。
 */
export function getServerConfigPromise(): Promise<void> | null {
  return serverConfigPromise;
}

interface SettingsState {
  apiBaseUrl: string;
  m3uUrl: string;
  remoteInputEnabled: boolean;
  autoSkipIntro: boolean;
  /** 没手动标记过片头时间时默认跳过的片头时长（秒），0 表示只用手动标记 */
  introSkipSeconds: number;
  nextEpisodeOverlayEnabled: boolean;
  incognitoMode: boolean;
  videoSource: {
    enabledAll: boolean;
    sources: {
      [key: string]: boolean;
    };
  };
  isModalVisible: boolean;
  serverConfig: ServerConfig | null;
  isLoadingServerConfig: boolean;
  loadSettings: () => Promise<void>;
  fetchServerConfig: () => Promise<void>;
  setApiBaseUrl: (url: string) => void;
  setM3uUrl: (url: string) => void;
  setRemoteInputEnabled: (enabled: boolean) => void;
  setAutoSkipIntro: (enabled: boolean) => void;
  setIntroSkipSeconds: (seconds: number) => void;
  setNextEpisodeOverlayEnabled: (enabled: boolean) => void;
  setIncognitoMode: (enabled: boolean) => void;
  saveSettings: () => Promise<void>;
  setVideoSource: (config: { enabledAll: boolean; sources: { [key: string]: boolean } }) => void;
  showModal: () => void;
  hideModal: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  apiBaseUrl: "",
  m3uUrl: "",
  remoteInputEnabled: false,
  autoSkipIntro: true,
  introSkipSeconds: 90,
  nextEpisodeOverlayEnabled: true,
  incognitoMode: false,
  isModalVisible: false,
  serverConfig: null,
  isLoadingServerConfig: false,
  videoSource: {
    enabledAll: true,
    sources: {},
  },
  loadSettings: async () => {
    const settings = await SettingsManager.get();
    set({
      apiBaseUrl: settings.apiBaseUrl,
      m3uUrl: settings.m3uUrl,
      remoteInputEnabled: settings.remoteInputEnabled || false,
      autoSkipIntro: settings.autoSkipIntro ?? true,
      introSkipSeconds: settings.introSkipSeconds ?? 90,
      nextEpisodeOverlayEnabled: settings.nextEpisodeOverlayEnabled ?? true,
      incognitoMode: settings.incognitoMode ?? false,
      videoSource: settings.videoSource || {
        enabledAll: true,
        sources: {},
      },
    });
    if (settings.apiBaseUrl) {
      api.setBaseUrl(settings.apiBaseUrl);
      await get().fetchServerConfig();
    }
  },
  fetchServerConfig: () => {
    // 同一地址已有请求在飞：复用它，不再重复发（冷启动时 loadSettings、
    // checkLoginStatus、useApiConfig 可能同时触发）。
    if (serverConfigPromise && serverConfigFetchUrl === api.baseURL) {
      return serverConfigPromise;
    }
    const fetchUrl = api.baseURL;
    const p = (async () => {
      set({ isLoadingServerConfig: true });
      try {
        const config = await api.getServerConfig();
        // 地址已变：这次结果是旧服务器的，丢弃，别盖掉新地址的配置
        if (fetchUrl !== api.baseURL) return;
        if (config) {
          storageConfig.setStorageType(config.StorageType);
          set({ serverConfig: config });
        } else {
          // 服务器没返回可用配置（空响应/非法 JSON）：当作拉取失败，
          // 清掉旧配置，别让上一个服务器的 StorageType 继续生效
          storageConfig.setStorageType(undefined);
          set({ serverConfig: null });
        }
      } catch (error) {
        if (fetchUrl === api.baseURL) {
          // 拉取失败同样清掉旧 StorageType（换服务器后新配置拉不到时，
          // 旧服务器的类型会残留，收藏/记录被写到错误的后端）
          storageConfig.setStorageType(undefined);
          set({ serverConfig: null });
        }
        logger.error("Failed to fetch server config:", error);
      } finally {
        // 旧请求的 finally 不能关新请求的 loading
        if (fetchUrl === api.baseURL) {
          set({ isLoadingServerConfig: false });
        }
      }
    })();
    serverConfigPromise = p;
    serverConfigFetchUrl = fetchUrl;
    // 完成后清掉引用，避免一直捏着一个已完成的 Promise；
    // 只有仍是本次的才清，防止后一次 fetch 刚开始就被前一次的 finally 误清
    p.finally(() => {
      if (serverConfigPromise === p) {
        serverConfigPromise = null;
      }
    });
    return p;
  },
  setApiBaseUrl: (url) => set({ apiBaseUrl: url }),
  setM3uUrl: (url) => set({ m3uUrl: url }),
  setRemoteInputEnabled: (enabled) => set({ remoteInputEnabled: enabled }),
  setAutoSkipIntro: (enabled) => set({ autoSkipIntro: enabled }),
  setIntroSkipSeconds: (seconds) => set({ introSkipSeconds: seconds }),
  setNextEpisodeOverlayEnabled: (enabled) => set({ nextEpisodeOverlayEnabled: enabled }),
  setIncognitoMode: (enabled) => set({ incognitoMode: enabled }),
  setVideoSource: (config) => set({ videoSource: config }),
  saveSettings: async () => {
    const { apiBaseUrl, m3uUrl, remoteInputEnabled, videoSource, autoSkipIntro, introSkipSeconds, nextEpisodeOverlayEnabled, incognitoMode } = get();
    const currentSettings = await SettingsManager.get()
    const currentApiBaseUrl = currentSettings.apiBaseUrl;
    let processedApiBaseUrl = apiBaseUrl.trim();
    if (processedApiBaseUrl.endsWith("/")) {
      processedApiBaseUrl = processedApiBaseUrl.slice(0, -1);
    }

    // 空地址就是“未配置”：别补成 "https://"，那是个非法地址，会让
    // fetchServerConfig 一直失败、登录判断也跟着错
    if (processedApiBaseUrl && !/^https?:\/\//i.test(processedApiBaseUrl)) {
      const hostPart = processedApiBaseUrl.split("/")[0];
      // Simple check for IP address format.
      const isIpAddress = /^((\d{1,3}\.){3}\d{1,3})(:\d+)?$/.test(hostPart);
      // Check if the domain includes a port.
      const hasPort = /:\d+/.test(hostPart);

      if (isIpAddress || hasPort) {
        processedApiBaseUrl = "http://" + processedApiBaseUrl;
      } else {
        processedApiBaseUrl = "https://" + processedApiBaseUrl;
      }
    }

    await SettingsManager.save({
      apiBaseUrl: processedApiBaseUrl,
      m3uUrl,
      remoteInputEnabled,
      videoSource,
      autoSkipIntro,
      introSkipSeconds,
      nextEpisodeOverlayEnabled,
      incognitoMode,
    });
    if ( currentApiBaseUrl !== processedApiBaseUrl) {
      // 标记清除失败不阻断地址切换：SettingsManager.save 已成功（新地址
      // 已落盘），一抛就中止会跳过 api.setBaseUrl/set/fetchServerConfig，
      // 磁盘是新地址、内存是旧地址（与紧邻的凭据清理一致，那里有 try/catch）。
      try {
        await AsyncStorage.setItem('authCookies', '');
      } catch (error) {
        logger.warn('换服务器时清理登录标记失败:', error);
      }
      // 地址变了，旧服务器的保存凭据必须清掉：不清的话新服务器返回 401
      // 时 restoreSession 会把旧用户名/密码发往新地址。isLoggedIn 的短暂
      // 残留由 _layout 的 checkLoginStatus 随后纠正（这里不直接碰 authStore，
      // authStore 已 import settingsStore，反向 import 会成环）。
      try {
        await LoginCredentialsManager.clear();
      } catch (error) {
        logger.warn('换服务器时清理旧登录凭据失败:', error);
      }
    }
    api.setBaseUrl(processedApiBaseUrl);
    // Also update the URL in the state so the input field shows the processed URL
    set({ isModalVisible: false, apiBaseUrl: processedApiBaseUrl });
    await get().fetchServerConfig();
  },
  showModal: () => set({ isModalVisible: true }),
  hideModal: () => set({ isModalVisible: false }),
}));
