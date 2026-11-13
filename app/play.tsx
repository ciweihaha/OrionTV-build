import React, { useEffect, useCallback, memo, useMemo } from "react";
import { StyleSheet, TouchableOpacity, BackHandler, AppState, AppStateStatus, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useKeepAwake } from "expo-keep-awake";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { PlayerControls } from "@/components/PlayerControls";
import { EpisodeSelectionModal } from "@/components/EpisodeSelectionModal";
import { SourceSelectionModal } from "@/components/SourceSelectionModal";
import { SpeedSelectionModal } from "@/components/SpeedSelectionModal";
import { SeekingBar } from "@/components/SeekingBar";
import { NextEpisodeOverlay } from "@/components/NextEpisodeOverlay";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import useDetailStore from "@/stores/detailStore";
import { useTVRemoteHandler } from "@/hooks/useTVRemoteHandler";
import Toast from "react-native-toast-message";
import usePlayerStore, { selectCurrentEpisode } from "@/stores/playerStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { useVideoHandlers } from "@/hooks/useVideoHandlers";
import { resolveIntroEndTime } from "@/utils/introSkip";
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('PlayScreen');

// 优化的加载动画组件
const LoadingContainer = memo(
  ({ style, currentEpisode }: { style: any; currentEpisode: { url: string; title: string } | undefined }) => {
    logger.info(
      `[PERF] Video component NOT rendered - waiting for valid URL. currentEpisode: ${!!currentEpisode}, url: ${
        currentEpisode?.url ? "exists" : "missing"
      }`
    );
    return (
      <View style={style}>
        <VideoLoadingAnimation showProgressBar />
      </View>
    );
  }
);

LoadingContainer.displayName = "LoadingContainer";

// 移到组件外部避免重复创建
const createResponsiveStyles = (deviceType: string) => {
  const isMobile = deviceType === "mobile";
  const isTablet = deviceType === "tablet";

  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: "black",
      // 移动端和平板端可能需要状态栏处理
      ...(isMobile || isTablet ? { paddingTop: 0 } : {}),
    },
    videoContainer: {
      ...StyleSheet.absoluteFill,
      // 为触摸设备添加更多的交互区域
      ...(isMobile || isTablet ? { zIndex: 1 } : {}),
    },
    videoPlayer: {
      ...StyleSheet.absoluteFill,
    },
    loadingContainer: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0, 0, 0, 0.8)",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 10,
    },
  });
};

export default function PlayScreen() {
  const router = useRouter();
  useKeepAwake();

  // 响应式布局配置
  const { deviceType } = useResponsiveLayout();

  const {
    episodeIndex: episodeIndexStr,
    position: positionStr,
    source: sourceStr,
    id: videoId,
    title: videoTitle,
  } = useLocalSearchParams<{
    episodeIndex: string;
    position?: string;
    source?: string;
    id?: string;
    title?: string;
  }>();
  const rawEpisodeIndex = parseInt(episodeIndexStr || "0", 10);
  // 防御：NaN 或负数时回退到 0，避免后续数组越界
  const episodeIndex = isNaN(rawEpisodeIndex) || rawEpisodeIndex < 0 ? 0 : rawEpisodeIndex;
  const rawPosition = positionStr ? parseInt(positionStr, 10) : undefined;
  const position = rawPosition !== undefined && (isNaN(rawPosition) || rawPosition < 0)
    ? undefined
    : rawPosition;

  const detail = useDetailStore((s) => s.detail);
  const detailError = useDetailStore((s) => s.error);
  const source = sourceStr || detail?.source;
  const id = videoId || detail?.id.toString();
  const title = videoTitle || detail?.title;
  // 按字段订阅：timeUpdate 每 0.5s 写一次 status/progressPosition，
  // 整库订阅会让整个播放页每 0.5s 重渲染一次（VideoView、浮层都跟着跑）。
  // 播放页本身不用 status/progressPosition（进度条在 SeekingBar 里），只订阅用到的字段。
  const isLoading = usePlayerStore((s) => s.isLoading);
  const showControls = usePlayerStore((s) => s.showControls);
  const showEpisodeModal = usePlayerStore((s) => s.showEpisodeModal);
  const showSourceModal = usePlayerStore((s) => s.showSourceModal);
  const showSpeedModal = usePlayerStore((s) => s.showSpeedModal);
  const setShowEpisodeModal = usePlayerStore((s) => s.setShowEpisodeModal);
  const setShowSourceModal = usePlayerStore((s) => s.setShowSourceModal);
  const setShowSpeedModal = usePlayerStore((s) => s.setShowSpeedModal);
  const showNextEpisodeOverlay = usePlayerStore((s) => s.showNextEpisodeOverlay);
  const episodes = usePlayerStore((s) => s.episodes);
  const currentEpisodeIndex = usePlayerStore((s) => s.currentEpisodeIndex);
  const initialPosition = usePlayerStore((s) => s.initialPosition);
  const introEndTime = usePlayerStore((s) => s.introEndTime);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setVideoPlayer = usePlayerStore((s) => s.setVideoPlayer);
  const handlePlaybackStatusUpdate = usePlayerStore((s) => s.handlePlaybackStatusUpdate);
  const setShowControls = usePlayerStore((s) => s.setShowControls);
  const playEpisode = usePlayerStore((s) => s.playEpisode);
  const dismissNextEpisodeOverlay = usePlayerStore((s) => s.dismissNextEpisodeOverlay);
  const reset = usePlayerStore((s) => s.reset);
  const loadVideo = usePlayerStore((s) => s.loadVideo);
  const autoSkipIntro = useSettingsStore((s) => s.autoSkipIntro);
  const introSkipSeconds = useSettingsStore((s) => s.introSkipSeconds);
  const currentEpisode = usePlayerStore(selectCurrentEpisode);

  // expo-video player: source changes auto-replace; setup sets the
  // progress-event cadence the store's record saving relies on.
  const player = useVideoPlayer(currentEpisode?.url ? { uri: currentEpisode.url } : null, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });

  // 使用Video事件处理hook
  // 生效的片头结束点：有手动标记用标记值，没标过按设置里的片头时长跳
  const effectiveIntroEndTime = resolveIntroEndTime(introEndTime, introSkipSeconds);
  const { videoViewProps } = useVideoHandlers({
    player,
    currentEpisode,
    initialPosition,
    introEndTime: effectiveIntroEndTime,
    playbackRate,
    handlePlaybackStatusUpdate,
    deviceType,
    autoSkipIntro,
  });

  // TV遥控器处理 - 总是调用hook，但根据设备类型决定是否使用结果
  const tvRemoteHandler = useTVRemoteHandler();

  // 优化的动态样式 - 使用useMemo避免重复计算
  const dynamicStyles = useMemo(() => createResponsiveStyles(deviceType), [deviceType]);

  // setVideoPlayer 单独 effect：useVideoPlayer 实例会在 replaceAsync 失败
  // 时重建（useVideoHandlers 注释），若 player 留在下面主 effect 的 deps
  // 里，重建会触发 cleanup reset() + loadVideo（路由参数集数），用户已
  // 切到第 5 集会被拉回最初打开的那集。拆开后重建只更新 player 引用，
  // store 状态（集数/进度）保留，useVideoHandlers 的 player 变更 effect
  // 负责新实例的就绪/seek。
  useEffect(() => {
    setVideoPlayer(player);
  }, [player, setVideoPlayer]);

  useEffect(() => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayScreen useEffect START - source: ${source}, id: ${id}, title: ${title}`);

    if (source && id && title) {
      logger.info(`[PERF] Calling loadVideo with episodeIndex: ${episodeIndex}, position: ${position}`);
      loadVideo({ source, id, episodeIndex, position, title });
    } else {
      logger.info(`[PERF] Missing required params - source: ${!!source}, id: ${!!id}, title: ${!!title}`);
    }

    const perfEnd = performance.now();
    logger.info(`[PERF] PlayScreen useEffect END - took ${(perfEnd - perfStart).toFixed(2)}ms`);

    return () => {
      logger.info(`[PERF] PlayScreen unmounting - calling reset()`);
      reset(); // Reset state when component unmounts
    };
  }, [episodeIndex, source, position, reset, loadVideo, id, title]);

  // 优化的屏幕点击处理
  const onScreenPress = useCallback(() => {
    if (deviceType === "tv") {
      tvRemoteHandler.onScreenPress();
    } else {
      setShowControls(!showControls);
    }
  }, [deviceType, tvRemoteHandler, setShowControls, showControls]);

  // 无后台播放/画中画：切后台或失活时一律暂停，不留后台音频。
  // （expo-video 的 supportsBackgroundPlayback / supportsPictureInPicture
  // 在 app.json 里已关，播放服务不会注册；这里是显式兜底。）
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === "background" || nextAppState === "inactive") {
        player.pause();
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    const backAction = () => {
      // 弹窗最先响应返回键：电视端没有触摸，返回键是关弹窗的快捷方式；
      // 之前直接走到隐藏控制条/退出播放，弹窗只能用焦点移到关闭按钮，
      // 按两次返回就直接退出了播放页
      if (showEpisodeModal) {
        setShowEpisodeModal(false);
        return true;
      }
      if (showSourceModal) {
        setShowSourceModal(false);
        return true;
      }
      if (showSpeedModal) {
        setShowSpeedModal(false);
        return true;
      }
      if (showControls) {
        setShowControls(false);
        return true;
      }
      router.back();
      return true;
    };

    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);

    return () => backHandler.remove();
  }, [showControls, showEpisodeModal, showSourceModal, showSpeedModal, setShowControls, setShowEpisodeModal, setShowSourceModal, setShowSpeedModal, router]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // 剧集列表未就绪时重 arm 的次数上限：loadVideo 的详情初始化预算可达
    // 60 秒（SEARCH_TIMEOUT），20 秒就判超时是误报；最多重 arm 3 次
    //（80 秒，覆盖初始化预算 + 余量），之后仍无剧集才判超时
    let rearms = 0;
    const MAX_REARMS = 3;

    const armTimeout = () => {
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        const state = usePlayerStore.getState();
        if (!state.isLoading) return;
        // 20s 还没就绪：当作网络失败走自动换源（与 error 事件共用
        // handleVideoError 的去重保护，不会和随后到的 error 事件重复切换）
        const ep = selectCurrentEpisode(state);
        if (ep?.url) {
          state.handleVideoError('network', ep.url);
        } else if (rearms < MAX_REARMS) {
          // 剧集列表还没就绪：loadVideo 的详情初始化还在跑，20 秒判超时
          // 是误报（随后 loadVideo 照常完成、视频正常播出）。重 arm 一次，
          // 等初始化完成后再判；不是无条件跳过——初始化自身的超时会让
          // loadVideo 抛错清 isLoading，真挂住时重 arm 耗尽后仍会判超时。
          rearms += 1;
          armTimeout();
        } else {
          usePlayerStore.setState({ isLoading: false });
          Toast.show({ type: "error", text1: "播放超时，请重试" });
        }
      }, 20000); // 20 秒（V1.5：60s 太久，黑屏干等体验差）
    };

    if (isLoading) {
      armTimeout();
    }

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isLoading]);

  if (!detail && detailError) {
    // 详情加载失败：之前无条件转圈，续播直达播放页时 detail 为 null、
    // DetailStore 已有 error 也会一直转下去；显示错误文案，返回键已接管退出
    return (
      <ThemedView focusable style={dynamicStyles.container}>
        <View style={dynamicStyles.loadingContainer}>
          <ThemedText type="subtitle" style={{ textAlign: "center" }}>
            {detailError}
          </ThemedText>
          <ThemedText style={{ marginTop: 16, textAlign: "center" }}>
            按返回键退出
          </ThemedText>
        </View>
      </ThemedView>
    );
  }

  if (!detail) {
    return <VideoLoadingAnimation showProgressBar />;
  }

  return (
    <ThemedView focusable style={dynamicStyles.container}>
      <TouchableOpacity
        activeOpacity={1}
        style={dynamicStyles.videoContainer}
        onPress={onScreenPress}
      >
        {/* 条件渲染Video组件：只有在有有效URL时才渲染 */}
        {currentEpisode?.url ? (
          <VideoView style={dynamicStyles.videoPlayer} {...videoViewProps} />
        ) : (
          <LoadingContainer style={dynamicStyles.loadingContainer} currentEpisode={currentEpisode} />
        )}

        {showControls && deviceType === "tv" && (
          <PlayerControls showControls={showControls} setShowControls={setShowControls} />
        )}

        <SeekingBar />

        {/* 只在Video组件存在且正在加载时显示加载动画覆盖层 */}
        {currentEpisode?.url && isLoading && (
          <View style={dynamicStyles.loadingContainer}>
            <VideoLoadingAnimation showProgressBar />
          </View>
        )}

        <NextEpisodeOverlay
          visible={showNextEpisodeOverlay}
          nextTitle={episodes[currentEpisodeIndex + 1]?.title}
          onPlayNext={() => playEpisode(currentEpisodeIndex + 1)}
          onCancel={dismissNextEpisodeOverlay}
        />
      </TouchableOpacity>

      <EpisodeSelectionModal />
      <SourceSelectionModal />
      <SpeedSelectionModal />
    </ThemedView>
  );
}
