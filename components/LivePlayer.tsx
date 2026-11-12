import React, { useState, useEffect, useRef } from "react";
import { View, StyleSheet, Text, ActivityIndicator } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { useKeepAwake } from "expo-keep-awake";
import type { PlaybackStatus } from "@/stores/playerStore";
import { StyledButton } from "@/components/StyledButton";

interface LivePlayerProps {
  streamUrl: string | null;
  onPlaybackStatusUpdate: (status: PlaybackStatus) => void;
  /** V1.5：流加载失败/超时回调（每个 streamUrl 最多触发一次），供上层自动跳台 */
  onPlaybackError?: () => void;
  /** 失败页手动重试：上层重选当前频道（同台时换 key 重挂播放器） */
  onRetry?: () => void;
}

const PLAYBACK_TIMEOUT = 15000; // 15 seconds

export default function LivePlayer({ streamUrl, onPlaybackStatusUpdate, onPlaybackError, onRetry }: LivePlayerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isTimeout, setIsTimeout] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // V1.5：每个 streamUrl 只上报一次错误，避免上层重复跳台
  const errorReportedForRef = useRef<string | null>(null);
  useKeepAwake();

  // expo-video player: source changes auto-replace via replaceAsync.
  const player = useVideoPlayer(streamUrl ? { uri: streamUrl } : null);

  const reportErrorOnce = (url: string | null) => {
    if (!url || errorReportedForRef.current === url) return;
    errorReportedForRef.current = url;
    onPlaybackError?.();
  };

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // 换台后重置“已上报”标记：同一个 URL 再次切回来失败时也要重新上报，
    // 否则切回之前坏过的台会卡在“加载失败”且不再自动跳台
    errorReportedForRef.current = null;

    if (streamUrl) {
      setIsLoading(true);
      setIsTimeout(false);
      timeoutRef.current = setTimeout(() => {
        setIsTimeout(true);
        setIsLoading(false);
        reportErrorOnce(streamUrl); // V1.5：加载超时也算坏源，交由上层跳台
      }, PLAYBACK_TIMEOUT);
    } else {
      setIsLoading(false);
      setIsTimeout(false);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
    // reportErrorOnce 仅读 ref 与 prop，语义上随 streamUrl 变化即可，无需入列（每次变化重置一次）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl]);

  // Bridge expo-video player events to the PlaybackStatus shape the
  // parent expects (same fields expo-av's AVPlaybackStatus carried).
  useEffect(() => {
    const emit = (patch: Partial<PlaybackStatus>) => {
      onPlaybackStatusUpdate({
        isLoaded: player.status === 'readyToPlay',
        isPlaying: player.playing,
        isBuffering: player.status === 'loading',
        positionMillis: player.currentTime * 1000,
        durationMillis: Number.isFinite(player.duration) ? player.duration * 1000 : null,
        didJustFinish: false,
        ...patch,
      });
    };

    const subs = [
      player.addListener('statusChange', ({ status, error }) => {
        if (status === 'readyToPlay') {
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
          setIsLoading(false);
          setIsTimeout(false);
          // Autoplay live streams.
          player.play();
          emit({ isLoaded: true, isPlaying: player.playing, isBuffering: false, error: undefined });
        } else if (status === 'loading') {
          setIsLoading(true);
          // 中途卡顿也会回到 loading：重新计时 15 秒，卡住超时同样算坏源、
          // 交由上层跳台；否则直播中途断流只会一直转圈，永远不报错不跳台
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
          timeoutRef.current = setTimeout(() => {
            setIsTimeout(true);
            setIsLoading(false);
            reportErrorOnce(streamUrl);
          }, PLAYBACK_TIMEOUT);
          emit({ isLoaded: false, isBuffering: true });
        } else if (status === 'error') {
          setIsLoading(false);
          setIsTimeout(true);
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
          emit({ isLoaded: false, isPlaying: false, isBuffering: false, error: error?.message });
          reportErrorOnce(streamUrl); // V1.5：播放错误交由上层跳台
        }
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        if (isPlaying) {
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
          setIsLoading(false);
          setIsTimeout(false);
        }
        emit({ isPlaying });
      }),
    ];

    return () => {
      subs.forEach((s) => s.remove());
    };
    // onPlaybackStatusUpdate is a stable parent callback; re-subscribe per player/stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, streamUrl]);

  if (!streamUrl) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>按 OK 键选择频道</Text>
      </View>
    );
  }

  if (isTimeout) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>加载失败，请重试</Text>
        {/* 之前只有一句“请重试”，没有任何可点的重试入口：自动跳台耗尽后
            只能凭提示 toast 摸索左右键换台；给一个可聚焦的重试按钮 */}
        {onRetry && (
          <StyledButton
            text="重试"
            onPress={onRetry}
            style={styles.retryButton}
            // 电视上失败页打开时把焦点拉到重试按钮：否则焦点无处落，OK 按不到
            hasTVPreferredFocus
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <VideoView
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
      />
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.messageText}>加载中...</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  video: {
    flex: 1,
    alignSelf: "stretch",
  },
  messageText: {
    color: "#fff",
    fontSize: 16,
    marginTop: 10,
  },
  retryButton: {
    marginTop: 24,
    minWidth: 160,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
});
