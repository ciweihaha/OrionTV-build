import { create } from "zustand";
import Toast from "react-native-toast-message";
import type { VideoPlayer } from "expo-video";
import { PlayRecord, PlayRecordManager, PlayerSettingsManager } from "@/services/storage";
import { useSettingsStore } from "@/stores/settingsStore";
import { resolveIntroEndTime } from "@/utils/introSkip";
import useDetailStore, { episodesSelectorBySource } from "./detailStore";
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('PlayerStore');

/** 播放记录保存节流间隔（毫秒） */
const RECORD_SAVE_THROTTLE_MS = 10_000;

/** 快进/快退后重置 seeking 状态的延迟（毫秒） */
const SEEK_RESET_DELAY_MS = 1_000;

/**
 * loadVideo 并发代次：快速连点两集（或切源时又点集）会起两次 loadVideo，
 * 旧的那次 await 回来后不能覆盖新的——否则播的集数与用户点的对不上。
 * （与第 14 轮 homeStore、第 21 轮 useApiConfig 同一类竞态。）
 */
let loadVideoSeq = 0;

// 上一次 seek 的目标位置（毫秒）：连续快进时以它为基数累积，避免
// status.positionMillis 每 0.5 秒才更新一次、多次 seek 都算在同一个旧位置上
let seekTargetMillis: number | null = null;

/**
 * 正在处理换源的失败 URL：播放器 error 事件和 20s 加载超时可能同时触发，
 * 两次并发会选到同一个备用源、重复 setDetail；只处理第一次。
 * （模块级变量：换源是进程内全局互斥，用 store 字段还要多一次 set 触发订阅。）
 */
let handlingErrorUrl: string | null = null;

interface Episode {
  url: string;
  title: string;
}

/**
 * expo-video adapter status — keeps the same fields the app used from
 * expo-av's AVPlaybackStatus, so PlayerControls / SeekingBar /
 * SourceSelectionModal / live.tsx need no changes. Synthesized from
 * VideoPlayer events in useVideoHandlers (VOD) and LivePlayer (live).
 */
export interface PlaybackStatus {
  isLoaded: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  positionMillis: number;
  durationMillis: number | null;
  didJustFinish: boolean;
  error?: string;
}

interface PlayerState {
  videoPlayer: VideoPlayer | null;
  currentEpisodeIndex: number;
  episodes: Episode[];
  status: PlaybackStatus | null;
  isLoading: boolean;
  showControls: boolean;
  /** 播放控制条里进度条是否正拿到 TV 焦点（拿到时左/右键继续 seek） */
  isProgressBarFocused: boolean;
  showEpisodeModal: boolean;
  showSourceModal: boolean;
  showSpeedModal: boolean;
  showNextEpisodeOverlay: boolean;
  /** 本集是否已自动跳过片头（每集只跳一次，用户手动拉回片头后不再重复跳） */
  introSkipped: boolean;
  /** 用户本集是否已点掉下一集预告（点掉后本集播完不再自动播放下一集） */
  nextEpisodeDismissed: boolean;
  isSeeking: boolean;
  seekPosition: number;
  progressPosition: number;
  initialPosition: number;
  playbackRate: number;
  introEndTime?: number;
  outroStartTime?: number;
  setVideoPlayer: (player: VideoPlayer | null) => void;
  loadVideo: (options: {
    source: string;
    id: string;
    title: string;
    episodeIndex: number;
    position?: number;
  }) => Promise<void>;
  playEpisode: (index: number) => void;
  togglePlayPause: () => void;
  seek: (duration: number) => void;
  handlePlaybackStatusUpdate: (newStatus: PlaybackStatus) => void;
  setLoading: (loading: boolean) => void;
  setShowControls: (show: boolean) => void;
  setProgressBarFocused: (focused: boolean) => void;
  setShowEpisodeModal: (show: boolean) => void;
  setShowSourceModal: (show: boolean) => void;
  setShowSpeedModal: (show: boolean) => void;
  setShowNextEpisodeOverlay: (show: boolean) => void;
  /** 点掉下一集预告：隐藏浮层，且本集播完不再自动播放下一集 */
  dismissNextEpisodeOverlay: () => void;
  setPlaybackRate: (rate: number) => void;
  setIntroEndTime: () => void;
  setOutroStartTime: () => void;
  reset: () => void;
  _seekTimeout?: ReturnType<typeof setTimeout>;
  _isRecordSaveThrottled: boolean;
  // Internal helper
  _savePlayRecord: (updates?: Partial<PlayRecord>, options?: { immediate?: boolean }) => void;
  handleVideoError: (errorType: 'ssl' | 'network' | 'other', failedUrl: string) => Promise<void>;
}

const usePlayerStore = create<PlayerState>((set, get) => ({
  videoPlayer: null,
  episodes: [],
  currentEpisodeIndex: -1,
  status: null,
  isLoading: true,
  showControls: false,
  isProgressBarFocused: false,
  showEpisodeModal: false,
  showSourceModal: false,
  showSpeedModal: false,
  showNextEpisodeOverlay: false,
  introSkipped: false,
  nextEpisodeDismissed: false,
  isSeeking: false,
  seekPosition: 0,
  progressPosition: 0,
  initialPosition: 0,
  playbackRate: 1.0,
  introEndTime: undefined,
  outroStartTime: undefined,
  _seekTimeout: undefined,
  _isRecordSaveThrottled: false,

  setVideoPlayer: (player) => set({ videoPlayer: player }),

  loadVideo: async ({ source, id, episodeIndex, position, title }) => {
    const perfStart = performance.now();
    const seq = ++loadVideoSeq;
    logger.info(`[PERF] PlayerStore.loadVideo START - source: ${source}, id: ${id}, title: ${title}`);
    
    let detail = useDetailStore.getState().detail;
    let episodes: string[] = [];

    // 传入的 source 是用户当前点的源，优先用它拿 episodes；缓存的 detail
    // 可能是上一个视频的同名残留，只在传入源拿不到时才回退到它——
    // 原来反过来优先用缓存 detail 的源，同名视频切源时会播错源的剧集
    episodes = episodesSelectorBySource(source)(useDetailStore.getState());
    if ((!episodes || episodes.length === 0) && detail?.source && detail.source !== source) {
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
    }

    set({
      isLoading: true,
    });

    const needsDetailInit = !detail || !episodes || episodes.length === 0 || detail.title !== title;
    logger.info(`[PERF] Detail check - needsInit: ${needsDetailInit}, hasDetail: ${!!detail}, episodesCount: ${episodes?.length || 0}`);

    if (needsDetailInit) {
      const detailInitStart = performance.now();
      logger.info(`[PERF] DetailStore.init START - ${title}`);
      
      await useDetailStore.getState().init(title, source, id);
      // 已有更新的 loadVideo 在跑：这次的结果作废，不再往下写 store
      if (seq !== loadVideoSeq) {
        logger.info(`[PERF] loadVideo superseded after detail init, ignoring`);
        return;
      }
      
      const detailInitEnd = performance.now();
      logger.info(`[PERF] DetailStore.init END - took ${(detailInitEnd - detailInitStart).toFixed(2)}ms`);
      
      detail = useDetailStore.getState().detail;
      
      if (!detail) {
        logger.error(`[ERROR] Detail not found after initialization for "${title}" (source: ${source}, id: ${id})`);
        
        // 检查DetailStore的错误状态
        const detailStoreState = useDetailStore.getState();
        if (detailStoreState.error) {
          logger.error(`[ERROR] DetailStore error: ${detailStoreState.error}`);
          set({ 
            isLoading: false,
            // 可以选择在这里设置一个错误状态，但playerStore可能没有error字段
          });
        } else {
          logger.error(`[ERROR] DetailStore init completed but no detail found and no error reported`);
          set({ isLoading: false });
        }
        return;
      }
      
      // 使用DetailStore找到的实际source来获取episodes，而不是原始的preferredSource
      logger.info(`[INFO] Using actual source "${detail.source}" instead of preferred source "${source}"`);  
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
      
      if (!episodes || episodes.length === 0) {
        logger.error(`[ERROR] No episodes found for "${title}" from source "${detail.source}" (${detail.source_name})`);
        
        // 尝试从searchResults中直接获取episodes
        const detailStoreState = useDetailStore.getState();
        logger.info(`[INFO] Available sources in searchResults: ${detailStoreState.searchResults.map(r => `${r.source}(${r.episodes?.length || 0} episodes)`).join(', ')}`);
        
        // 如果当前source没有episodes，尝试使用第一个有episodes的source
        const sourceWithEpisodes = detailStoreState.searchResults.find(r => r.episodes && r.episodes.length > 0);
        if (sourceWithEpisodes) {
          logger.info(`[FALLBACK] Using alternative source "${sourceWithEpisodes.source}" with ${sourceWithEpisodes.episodes.length} episodes`);
          episodes = sourceWithEpisodes.episodes;
          // 更新detail为有episodes的source
          detail = sourceWithEpisodes;
        } else {
          logger.error(`[ERROR] No source with episodes found in searchResults`);
          set({ isLoading: false });
          return;
        }
      }
      
      logger.info(`[SUCCESS] Detail and episodes loaded - source: ${detail.source_name}, episodes: ${episodes.length}`);
    } else {
      // 缓存的详情：episodes 上面已经按传入源优先取过，这里不再用缓存
      // detail 的源覆盖（那就是同名切源播错源的 bug）
      logger.info(`[PERF] Skipping DetailStore.init - using cached data`);
    }

    // 最终验证：确保我们有有效的detail和episodes数据
    if (!detail) {
      logger.error(`[ERROR] Final check failed: detail is null`);
      set({ isLoading: false });
      return;
    }
    
    if (!episodes || episodes.length === 0) {
      logger.error(`[ERROR] Final check failed: no episodes available for source "${detail.source}" (${detail.source_name})`);
      set({ isLoading: false });
      return;
    }
    
    logger.info(`[SUCCESS] Final validation passed - detail: ${detail.source_name}, episodes: ${episodes.length}`);

    // 验证后 detail 非空，赋值给常量避免后续非空断言
    const validDetail = detail;

    try {
      const storageStart = performance.now();
      logger.info(`[PERF] Storage operations START`);
      
      // 一次读全后复用：PlayRecordManager.get 内部经 getAll 已把本地播放器
      // 设置合并进记录（含 playbackRate），不再单独调 PlayerSettingsManager.get
      // 把播放器设置重读一遍（L18a）
      const playRecord = await PlayRecordManager.get(validDetail.source, validDetail.id.toString());
      const storageEnd = performance.now();
      logger.info(`[PERF] PlayRecordManager.get took ${(storageEnd - storageStart).toFixed(2)}ms`);
      logger.info(`[PERF] Total storage operations took ${(storageEnd - storageStart).toFixed(2)}ms`);
      // 存储读完才发现已被更新的 loadVideo 超过：不写回旧数据
      if (seq !== loadVideoSeq) {
        logger.info(`[PERF] loadVideo superseded after storage read, ignoring`);
        return;
      }
      
      const initialPositionFromRecord = playRecord?.play_time ? playRecord.play_time * 1000 : 0;
      // playbackRate 不在 PlayRecord 类型里，但 getAll 合并时把它随本地设置
      // 一并 spread 进了记录，值与原来单独读 PlayerSettingsManager.get 相同
      const savedPlaybackRate = (playRecord as (PlayRecord & { playbackRate?: number }) | null)?.playbackRate || 1.0;
      
      const episodesMappingStart = performance.now();
      const mappedEpisodes = episodes.map((ep, index) => ({
        url: ep,
        title: `第 ${index + 1} 集`,
      }));
      // 集数钳制：切源时新源集数可能少于当前集（旧集号越界），不钳制会让
      // selectCurrentEpisode 返回 undefined，播放页卡在假加载屏上。
      const clampedEpisodeIndex = mappedEpisodes.length > 0
        ? Math.min(Math.max(0, episodeIndex), mappedEpisodes.length - 1)
        : episodeIndex;
      const episodesMappingEnd = performance.now();
      logger.info(`[PERF] Episodes mapping (${episodes.length} episodes) took ${(episodesMappingEnd - episodesMappingStart).toFixed(2)}ms`);
      
      set({
        isLoading: false,
        currentEpisodeIndex: clampedEpisodeIndex,
        initialPosition: position ?? initialPositionFromRecord,
        playbackRate: savedPlaybackRate,
        episodes: mappedEpisodes,
        // 合并后的记录已包含本地设置的片头/片尾时间，与原来 playerSettings 的值相同
        introEndTime: playRecord?.introEndTime,
        outroStartTime: playRecord?.outroStartTime,
        introSkipped: false,
        nextEpisodeDismissed: false,
        showNextEpisodeOverlay: false,
      });
      
      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
      
    } catch (error) {
      logger.debug("Failed to load play record", error);
      // 只有当前这次 loadVideo 才清 isLoading，别把新一次的加载状态清掉
      if (seq === loadVideoSeq) {
        set({ isLoading: false });
      }
      
      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo ERROR - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    }
  },

  playEpisode: async (index) => {
    const { episodes, videoPlayer } = get();
    if (index >= 0 && index < episodes.length) {
      set({
        currentEpisodeIndex: index,
        showNextEpisodeOverlay: false,
        introSkipped: false,
        nextEpisodeDismissed: false,
        initialPosition: 0,
        progressPosition: 0,
        seekPosition: 0,
      });
      try {
        videoPlayer?.replay();
      } catch (error) {
        logger.debug("Failed to replay video:", error);
        Toast.show({ type: "error", text1: "播放失败" });
      }
    }
  },

  togglePlayPause: async () => {
    const { status, videoPlayer } = get();
    if (status?.isLoaded) {
      try {
        if (status.isPlaying) {
          videoPlayer?.pause();
        } else {
          videoPlayer?.play();
        }
      } catch (error) {
        logger.debug("Failed to toggle play/pause:", error);
        Toast.show({ type: "error", text1: "操作失败" });
      }
    }
  },

  seek: async (duration) => {
    const { status, videoPlayer } = get();
    if (!status?.isLoaded || !status.durationMillis) return;

    // 连续快进以“上次目标位置”为基数累积：status.positionMillis 每 0.5 秒
    // 才更新一次，直接用它算会把多次 seek 都落在同一个旧位置上，停不准
    const basePosition = seekTargetMillis ?? status.positionMillis;
    const newPosition = Math.max(0, Math.min(basePosition + duration, status.durationMillis));
    seekTargetMillis = newPosition;
    try {
      // expo-video uses seconds
      videoPlayer!.currentTime = newPosition / 1000;
    } catch (error) {
      logger.debug("Failed to seek video:", error);
      Toast.show({ type: "error", text1: "快进/快退失败" });
    }

    // 快进时亮起控制条：进度条 + 当前时间/总时长一直可见，知道跳到哪了
    set({
      isSeeking: true,
      seekPosition: newPosition / status.durationMillis,
      showControls: true,
    });

    if (get()._seekTimeout) {
      clearTimeout(get()._seekTimeout);
    }
    const timeoutId = setTimeout(() => {
      seekTargetMillis = null;
      set({ isSeeking: false });
    }, SEEK_RESET_DELAY_MS);
    set({ _seekTimeout: timeoutId });
  },

  setIntroEndTime: () => {
    const { status, introEndTime: existingIntroEndTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingIntroEndTime) {
      // Clear the time
      set({ introEndTime: undefined });
      get()._savePlayRecord({ introEndTime: undefined }, { immediate: true });
      Toast.show({
        type: "info",
        text1: "已清除片头时间",
      });
    } else {
      // Set the time
      const newIntroEndTime = status.positionMillis;
      set({ introEndTime: newIntroEndTime });
      get()._savePlayRecord({ introEndTime: newIntroEndTime }, { immediate: true });
      Toast.show({
        type: "success",
        text1: "设置成功",
        text2: "片头时间已记录。",
      });
    }
  },

  setOutroStartTime: () => {
    const { status, outroStartTime: existingOutroStartTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingOutroStartTime) {
      // Clear the time
      set({ outroStartTime: undefined });
      get()._savePlayRecord({ outroStartTime: undefined }, { immediate: true });
      Toast.show({
        type: "info",
        text1: "已清除片尾时间",
      });
    } else {
      // Set the time
      if (!status.durationMillis) return;
      const newOutroStartTime = status.durationMillis - status.positionMillis;
      set({ outroStartTime: newOutroStartTime });
      get()._savePlayRecord({ outroStartTime: newOutroStartTime }, { immediate: true });
      Toast.show({
        type: "success",
        text1: "设置成功",
        text2: "片尾时间已记录。",
      });
    }
  },

  _savePlayRecord: (updates = {}, options = {}) => {
    const { immediate = false } = options;
    if (!immediate) {
      if (get()._isRecordSaveThrottled) {
        return;
      }
      set({ _isRecordSaveThrottled: true });
      setTimeout(() => {
        set({ _isRecordSaveThrottled: false });
      }, RECORD_SAVE_THROTTLE_MS);
    }

    const { detail } = useDetailStore.getState();
    const { currentEpisodeIndex, episodes, status, introEndTime, outroStartTime } = get();
    if (detail && status?.isLoaded) {
      const existingRecord = {
        introEndTime,
        outroStartTime,
      };
      PlayRecordManager.save(detail.source, detail.id.toString(), {
        title: detail.title,
        cover: detail.poster || "",
        index: currentEpisodeIndex + 1,
        total_episodes: episodes.length,
        play_time: Math.floor(status.positionMillis / 1000),
        total_time: status.durationMillis ? Math.floor(status.durationMillis / 1000) : 0,
        source_name: detail.source_name,
        year: detail.year || "",
        ...existingRecord,
        ...updates,
      }).catch((error) => {
        // fire-and-forget：API 路径保存失败时只记日志不抛回调用方，
        // 否则 rejected promise 无人处理（L7）
        logger.debug("Failed to save play record", error);
      });
    }
  },

  handlePlaybackStatusUpdate: (newStatus) => {
    if (!newStatus.isLoaded) {
      if (newStatus.error) {
        logger.debug(`Playback Error: ${newStatus.error}`);
      }
      set({ status: newStatus });
      return;
    }

    const { currentEpisodeIndex, episodes, outroStartTime, introEndTime, introSkipped, nextEpisodeDismissed, playEpisode, videoPlayer } = get();
    const detail = useDetailStore.getState().detail;
    const { autoSkipIntro, introSkipSeconds, nextEpisodeOverlayEnabled } = useSettingsStore.getState();
    // 生效的片头结束点：有手动标记用标记值，没标过按设置里的片头时长跳
    const effectiveIntroEnd = resolveIntroEndTime(introEndTime, introSkipSeconds);

    // 片头/片尾标记是按剧保存的（不是按集）：同一部剧里有短集时，
    // 标记可能超过本集片长——片尾剩余时间大于片长时，阈值是负数，
    // 第一帧就触发自动切集，短集根本播不了；片头同理会跳到片长之外。
    // 标记只在本集片长内有效，超出的当作本集没有标记
    if (
      outroStartTime &&
      newStatus.durationMillis &&
      outroStartTime < newStatus.durationMillis &&
      newStatus.positionMillis >= newStatus.durationMillis - outroStartTime
    ) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
        return; // Stop further processing for this update
      }
    }

    // 片头自动跳过：每集只跳一次（开关默认开启，可在设置里关闭）
    if (
      autoSkipIntro &&
      effectiveIntroEnd &&
      effectiveIntroEnd > 0 &&
      newStatus.durationMillis &&
      effectiveIntroEnd < newStatus.durationMillis &&
      newStatus.isPlaying &&
      newStatus.positionMillis < effectiveIntroEnd &&
      !introSkipped
    ) {
      let skipped = false;
      try {
        if (videoPlayer) {
          videoPlayer.currentTime = effectiveIntroEnd / 1000;
          skipped = true;
        }
      } catch (error) {
        logger.debug("Failed to skip intro:", error);
      }
      if (skipped) {
        set({ introSkipped: true });
        Toast.show({ type: "info", text1: "已跳过片头" });
      }
    }

    if (detail && newStatus.durationMillis) {
      get()._savePlayRecord();

      const isNearEnd = newStatus.positionMillis / newStatus.durationMillis > 0.95;
      if (isNearEnd && currentEpisodeIndex < episodes.length - 1 && !outroStartTime && nextEpisodeOverlayEnabled && !nextEpisodeDismissed) {
        set({ showNextEpisodeOverlay: true });
      } else {
        set({ showNextEpisodeOverlay: false });
      }
    }

    if (newStatus.didJustFinish) {
      // 用户点掉预告后，本集播完不再自动播放下一集
      if (currentEpisodeIndex < episodes.length - 1 && !nextEpisodeDismissed) {
        playEpisode(currentEpisodeIndex + 1);
      }
    }

    const progressPosition = newStatus.durationMillis ? newStatus.positionMillis / newStatus.durationMillis : 0;
    set({ status: newStatus, progressPosition });
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setShowControls: (show) => set({ showControls: show }),

  setProgressBarFocused: (focused) => set({ isProgressBarFocused: focused }),
  setShowEpisodeModal: (show) => set({ showEpisodeModal: show }),
  setShowSourceModal: (show) => set({ showSourceModal: show }),
  setShowSpeedModal: (show) => set({ showSpeedModal: show }),
  setShowNextEpisodeOverlay: (show) => set({ showNextEpisodeOverlay: show }),
  dismissNextEpisodeOverlay: () => set({ showNextEpisodeOverlay: false, nextEpisodeDismissed: true }),

  setPlaybackRate: async (rate) => {
    const { videoPlayer } = get();
    const detail = useDetailStore.getState().detail;

    // 先写状态：player 未就绪（videoPlayer 为 null）时旧代码在 videoPlayer!
    // 上抛 TypeError，被 catch 后只记 debug 日志，状态不更新、无提示，
    // 用户以为倍速已改实际未生效；useVideoHandlers 的同步 effect 会在
    // player 就绪后把状态里的倍速应用上去。
    set({ playbackRate: rate });
    try {
      // expo-video: playbackRate is a settable property (seconds-based player)
      if (videoPlayer) {
        videoPlayer.playbackRate = rate;
      }
      
      // Save the playback rate preference
      if (detail) {
        await PlayerSettingsManager.save(detail.source, detail.id.toString(), { playbackRate: rate });
      }
    } catch (error) {
      logger.debug("Failed to set playback rate:", error);
    }
  },

  reset: () => {
    // 上次播放残留的快进定时器一并清掉，别让它在新视频上把 isSeeking 改回去
    const seekTimeout = get()._seekTimeout;
    if (seekTimeout) {
      clearTimeout(seekTimeout);
    }
    seekTargetMillis = null;
    set({
      episodes: [],
      currentEpisodeIndex: 0,
      status: null,
      isLoading: true,
      showControls: false,
      isProgressBarFocused: false,
      showEpisodeModal: false,
      showSourceModal: false,
      showSpeedModal: false,
      showNextEpisodeOverlay: false,
      introSkipped: false,
      nextEpisodeDismissed: false,
      initialPosition: 0,
      playbackRate: 1.0,
      introEndTime: undefined,
      outroStartTime: undefined,
      // 快进状态与断点保存节流标志也要复位：否则退出播放页后 10 秒内
      // 再开一个视频，_savePlayRecord 会被上一个视频的节流挡住，
      // 新视频开头的断点保存全丢；isSeeking 残留则让进度条错显示 1 秒
      isSeeking: false,
      seekPosition: 0,
      _seekTimeout: undefined,
      _isRecordSaveThrottled: false,
    });
  },

  handleVideoError: async (errorType: 'ssl' | 'network' | 'other', failedUrl: string) => {
    const perfStart = performance.now();
    logger.error(`[VIDEO_ERROR] Handling ${errorType} error for URL: ${failedUrl}`);

    // 同一 URL 的错误可能由 error 事件和加载超时同时触发：只处理第一次
    if (handlingErrorUrl === failedUrl) {
      logger.warn(`[VIDEO_ERROR] Duplicate error for URL, already handling: ${failedUrl.substring(0, 100)}`);
      return;
    }
    // 迟到的旧错误（换源后旧播放器又报了一次）：当前集已不是这个 URL，忽略，
    // 否则会把刚换上的新源误判为失败、再换一次
    const currentUrl = selectCurrentEpisode(get())?.url;
    if (currentUrl && currentUrl !== failedUrl) {
      logger.warn(`[VIDEO_ERROR] Stale error for URL ${failedUrl.substring(0, 100)}, current episode is different, ignoring`);
      return;
    }
    handlingErrorUrl = failedUrl;

    const detailStoreState = useDetailStore.getState();
    const { detail } = detailStoreState;
    const { currentEpisodeIndex } = get();

    if (!detail) {
      logger.error(`[VIDEO_ERROR] Cannot fallback - no detail available`);
      set({ isLoading: false });
      handlingErrorUrl = null;
      return;
    }
    
    // 标记当前source为失败
    const currentSource = detail.source;
    const errorReason = `${errorType} error: ${failedUrl.substring(0, 100)}...`;
    useDetailStore.getState().markSourceAsFailed(currentSource, errorReason);
    
    // 获取下一个可用的source
    const fallbackSource = useDetailStore.getState().getNextAvailableSource(currentSource, currentEpisodeIndex);
    
    if (!fallbackSource) {
      logger.error(`[VIDEO_ERROR] No fallback sources available for episode ${currentEpisodeIndex + 1}`);
      Toast.show({ 
        type: "error", 
        text1: "播放失败", 
        text2: "所有播放源都不可用，请稍后重试" 
      });
      set({ isLoading: false });
      handlingErrorUrl = null;
      return;
    }
    
    logger.info(`[VIDEO_ERROR] Switching to fallback source: ${fallbackSource.source} (${fallbackSource.source_name})`);
    
    try {
      // 更新DetailStore的当前detail为fallback source
      await useDetailStore.getState().setDetail(fallbackSource);
      
      // 重新加载当前集数的episodes
      const newEpisodes = fallbackSource.episodes || [];
      if (newEpisodes.length > currentEpisodeIndex) {
        const mappedEpisodes = newEpisodes.map((ep, index) => ({
          url: ep,
          title: `第 ${index + 1} 集`,
        }));
        
        // 换源保进度：新 URL 就绪后 useVideoHandlers 按 initialPosition 跳转，
        // 不更新它会跳回进播放页时的断点（或 0），25 分钟处换源被拉回起点。
        // 同时复位 seekTargetMillis，残留的快进基数会污染后续 seek。
        const currentPosition = get().status?.positionMillis ?? 0;
        seekTargetMillis = null;
        set({
          episodes: mappedEpisodes,
          initialPosition: currentPosition,
          isLoading: false, // 让Video组件重新渲染
        });
        
        const perfEnd = performance.now();
        logger.info(`[VIDEO_ERROR] Successfully switched to fallback source in ${(perfEnd - perfStart).toFixed(2)}ms`);
        logger.info(`[VIDEO_ERROR] New episode URL: ${newEpisodes[currentEpisodeIndex].substring(0, 100)}...`);
        
        Toast.show({ 
          type: "success", 
          text1: "已切换播放源", 
          text2: `正在使用 ${fallbackSource.source_name}` 
        });
      } else {
        logger.error(`[VIDEO_ERROR] Fallback source doesn't have episode ${currentEpisodeIndex + 1}`);
        set({ isLoading: false });
      }
    } catch (error) {
      logger.error(`[VIDEO_ERROR] Failed to switch to fallback source:`, error);
      set({ isLoading: false });
    }
    handlingErrorUrl = null;
  },
}));

export default usePlayerStore;

export const selectCurrentEpisode = (state: PlayerState) => {
  // 增强数据安全性检查
  if (
    state.episodes &&
    Array.isArray(state.episodes) &&
    state.episodes.length > 0 &&
    state.currentEpisodeIndex >= 0 &&
    state.currentEpisodeIndex < state.episodes.length
  ) {
    const episode = state.episodes[state.currentEpisodeIndex];
    // 确保episode有有效的URL
    if (episode && episode.url && episode.url.trim() !== "") {
      return episode;
    } else {
      // 仅在调试模式下打印
      if (__DEV__) {
        logger.debug(`[PERF] selectCurrentEpisode - episode found but invalid URL: ${episode?.url}`);
      }
    }
  } else {
    // 仅在调试模式下打印
    if (__DEV__) {
      logger.debug(`[PERF] selectCurrentEpisode - no valid episode: episodes.length=${state.episodes?.length}, currentIndex=${state.currentEpisodeIndex}`);
    }
  }
  return undefined;
};
