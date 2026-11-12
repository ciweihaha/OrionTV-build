import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { VideoPlayer } from 'expo-video';
import { isPictureInPictureSupported } from 'expo-video';
import Toast from 'react-native-toast-message';
import usePlayerStore, { type PlaybackStatus } from '@/stores/playerStore';
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('VideoHandlers');

interface UseVideoHandlersProps {
  player: VideoPlayer | null;
  currentEpisode: { url: string; title: string } | undefined;
  initialPosition: number;
  introEndTime?: number;
  playbackRate: number;
  handlePlaybackStatusUpdate: (status: PlaybackStatus) => void;
  deviceType: string;
  /** 片头自动跳过开关（默认开启）；关闭后就绪时不跳到片头结束处，播放中也不自动跳 */
  autoSkipIntro: boolean;
  /** 后台播放与画中画开关（默认关闭）；关闭时不开启画中画 */
  backgroundPlayback: boolean;
}

/**
 * Bridges expo-video's VideoPlayer events to the store's PlaybackStatus
 * shape (the fields the app used from expo-av's AVPlaybackStatus).
 * Owns: initial seek + autoplay on first ready, error classification
 * (SSL / network / other with source fallback), playback-rate sync.
 */
export const useVideoHandlers = ({
  player,
  currentEpisode,
  initialPosition,
  introEndTime,
  playbackRate,
  handlePlaybackStatusUpdate,
  deviceType,
  autoSkipIntro,
  backgroundPlayback,
}: UseVideoHandlersProps) => {
  // Synthesized status, kept in a ref and emitted on every player event.
  const statusRef = useRef<PlaybackStatus>({
    isLoaded: false,
    isPlaying: false,
    isBuffering: true,
    positionMillis: 0,
    durationMillis: null,
    didJustFinish: false,
  });
  // URL the ready-seek/autoplay already ran for (per source).
  const readyHandledForRef = useRef<string | null>(null);

  // 画中画是否受当前设备支持（不支持时开关只控制后台音频，优雅降级）。
  const pipSupported = useMemo(() => {
    try {
      return isPictureInPictureSupported();
    } catch {
      return false;
    }
  }, []);

  const emit = useCallback(
    (patch: Partial<PlaybackStatus>) => {
      statusRef.current = { ...statusRef.current, ...patch };
      handlePlaybackStatusUpdate(statusRef.current);
    },
    [handlePlaybackStatusUpdate]
  );

  const onError = useCallback(
    (message: string) => {
      if (!currentEpisode?.url) return;

      logger.error(`[ERROR] Video playback error:`, message);

      const errorString = message || '';
      const isSSLError =
        errorString.includes('SSLHandshakeException') ||
        errorString.includes('CertPathValidatorException') ||
        errorString.includes('Trust anchor for certification path not found') ||
        errorString.includes('SSL');
      const isNetworkError =
        errorString.includes('HttpDataSourceException') ||
        errorString.includes('IOException') ||
        errorString.includes('SocketTimeoutException') ||
        errorString.includes('Unable to connect') ||
        errorString.includes('timeout');

      if (isSSLError) {
        logger.error(`[SSL_ERROR] SSL certificate validation failed for URL: ${currentEpisode.url}`);
        Toast.show({
          type: 'error',
          text1: 'SSL证书错误，正在尝试其他播放源...',
          text2: '请稍候',
        });
        usePlayerStore.getState().handleVideoError('ssl', currentEpisode.url);
      } else if (isNetworkError) {
        logger.error(`[NETWORK_ERROR] Network connection failed for URL: ${currentEpisode.url}`);
        Toast.show({
          type: 'error',
          text1: '网络连接失败，正在尝试其他播放源...',
          text2: '请稍候',
        });
        usePlayerStore.getState().handleVideoError('network', currentEpisode.url);
      } else {
        logger.error(`[VIDEO_ERROR] Other video error for URL: ${currentEpisode.url}`);
        Toast.show({
          type: 'error',
          text1: '视频播放失败，正在尝试其他播放源...',
          text2: '请稍候',
        });
        usePlayerStore.getState().handleVideoError('other', currentEpisode.url);
      }
    },
    [currentEpisode?.url]
  );

  // New source starts loading -> reset ready handling + loading state.
  useEffect(() => {
    if (!currentEpisode?.url) return;
    readyHandledForRef.current = null;
    usePlayerStore.setState({ isLoading: true });
    emit({
      isLoaded: false,
      isPlaying: false,
      isBuffering: true,
      positionMillis: 0,
      durationMillis: null,
      didJustFinish: false,
      error: undefined,
    });
    // emit is stable (handlePlaybackStatusUpdate is a zustand action); only re-run per URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisode?.url]);

  // Subscribe to player events. Re-subscribes when the player instance changes
  // (useVideoPlayer recreates it if replaceAsync fails).
  // player 实例重建时复位就绪标记：expo-video 在 replaceAsync 失败时用同一
  // URL 重建实例，URL 不变的 effect 不会跑；不复位的话新实例就绪时
  // readyHandledForRef 仍是旧 URL，整个就绪分支被跳过（不 seek、不自动
  // 播放、isLoading 永久 true，20 秒后被误判为网络失败而换源）。
  useEffect(() => {
    readyHandledForRef.current = null;
  }, [player]);

  useEffect(() => {
    if (!player) return;

    const subs = [
      player.addListener('statusChange', ({ status, error }) => {
        if (status === 'readyToPlay') {
          const url = currentEpisode?.url;
          if (url && readyHandledForRef.current !== url) {
            readyHandledForRef.current = url;
            logger.info(`[PERF] Video readyToPlay - video ready to play`);
            try {
              // 1. 先设置位置（如果需要）：断点优先；无断点且开启自动跳过片头时跳到片头结束处
              // 片长已知时，断点/片头标记超过本集片长不跳：标记是按剧保存的，
              // 短集继承长集的标记后跳到片长之外会直接播完切集；片长未知
              // （直播流）时保持原行为
              const durationMillis = Number.isFinite(player.duration) ? player.duration * 1000 : 0;
              const withinDuration = (ms: number) => !durationMillis || ms < durationMillis;
              const skipIntroOnReady = autoSkipIntro && !initialPosition && introEndTime && withinDuration(introEndTime) ? introEndTime : 0;
              const jumpPosition = initialPosition || skipIntroOnReady || 0;
              if (jumpPosition > 0 && withinDuration(jumpPosition)) {
                logger.info(`[PERF] Setting initial position to ${jumpPosition}ms`);
                player.currentTime = jumpPosition / 1000;
              }
              if (skipIntroOnReady > 0) {
                // 本集片头已在就绪时跳过，播放中不再重复跳（用户可手动拉回片头重看）
                usePlayerStore.setState({ introSkipped: true });
                Toast.show({ type: "info", text1: "已跳过片头" });
              }
              // 2. 显式调用播放以确保自动播放
              logger.info(`[AUTOPLAY] Attempting to start playback after ready`);
              player.play();
              logger.info(`[AUTOPLAY] Auto-play successful after ready`);
            } catch (err) {
              logger.warn(`[AUTOPLAY] Failed to auto-play after ready:`, err);
            }
            usePlayerStore.setState({ isLoading: false });
            logger.info(`[PERF] Video loading complete - isLoading set to false`);
          }
          emit({
            isLoaded: true,
            isBuffering: false,
            isPlaying: player.playing,
            positionMillis: player.currentTime * 1000,
            durationMillis: Number.isFinite(player.duration) ? player.duration * 1000 : null,
            didJustFinish: false,
            error: undefined,
          });
        } else if (status === 'loading') {
          emit({ isLoaded: false, isBuffering: true, isPlaying: false, didJustFinish: false });
        } else if (status === 'error') {
          const message = error?.message || 'Unknown player error';
          emit({ isLoaded: false, isPlaying: false, isBuffering: false, error: message, didJustFinish: false });
          usePlayerStore.setState({ isLoading: false });
          onError(message);
        }
        // 'idle': nothing to emit until a source loads.
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        // 显式带 didJustFinish: false：statusRef 会残留 playToEnd 置的 true，
        // 相邻两集 URL 相同时（单文件源），playEpisode 调 replay() 后
        // playingChange 立即触发，残留的 true 会让 store 再跳一集（连跳两集）。
        emit({
          isPlaying,
          isLoaded: player.status === 'readyToPlay',
          positionMillis: player.currentTime * 1000,
          durationMillis: Number.isFinite(player.duration) ? player.duration * 1000 : null,
          didJustFinish: false,
        });
      }),
      player.addListener('timeUpdate', ({ currentTime }) => {
        emit({
          isLoaded: player.status === 'readyToPlay',
          isPlaying: player.playing,
          isBuffering: false,
          positionMillis: currentTime * 1000,
          durationMillis: Number.isFinite(player.duration) ? player.duration * 1000 : null,
          didJustFinish: false,
        });
      }),
      player.addListener('playToEnd', () => {
        emit({
          isPlaying: false,
          positionMillis: player.currentTime * 1000,
          durationMillis: Number.isFinite(player.duration) ? player.duration * 1000 : null,
          didJustFinish: true,
        });
      }),
    ];

    return () => {
      subs.forEach((s) => s.remove());
    };
  }, [player, emit, onError, currentEpisode?.url, initialPosition, introEndTime, autoSkipIntro]);

  // Keep the player rate in sync with the store's playbackRate.
  useEffect(() => {
    if (player && player.playbackRate !== playbackRate) {
      player.playbackRate = playbackRate;
    }
  }, [player, playbackRate]);

  return {
    videoViewProps: {
      player,
      contentFit: 'contain' as const,
      nativeControls: deviceType !== 'tv',
      // 画中画：仅在开启后台播放且设备支持时生效（Android 12+ / iOS），
      // 不支持的设备上 isPictureInPictureSupported() 返回 false，开关只控制后台音频。
      allowsPictureInPicture: backgroundPlayback && pipSupported,
      startsPictureInPictureAutomatically: backgroundPlayback && pipSupported,
    },
  };
};
