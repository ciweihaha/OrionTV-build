import React, { useMemo, useState } from "react";
import { View, Switch, StyleSheet, Pressable, Platform, TouchableOpacity } from "react-native";
import { isPictureInPictureSupported } from "expo-video";
import { ThemedText } from "@/components/ThemedText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { INTRO_SKIP_OPTIONS } from "@/utils/introSkip";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { Colors } from "@/constants/Colors";

interface PlaybackSectionProps {
  onChanged: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

type PlaybackToggleKey =
  | "nextEpisodeOverlayEnabled"
  | "autoSkipIntro"
  | "incognitoMode"
  | "backgroundPlayback";

/** 除开关外的可聚焦行：片头时长（点按循环切换档位） */
type PlaybackOptionKey = "introSkipSeconds";
type PlaybackFocusKey = PlaybackToggleKey | PlaybackOptionKey;

/**
 * 播放设置：下一集预告 / 自动跳过片头 / 无痕模式 / 后台播放与画中画。
 * 行交互同时兼容触摸与电视遥控：整行是 Pressable（点按即切换），
 * Switch 只做状态展示（pointerEvents="none"，避免与行点按重复触发）；
 * iOS TV 上 Switch 渲染异常，沿用仓库现有做法改用文字状态按钮。
 */
export const PlaybackSection: React.FC<PlaybackSectionProps> = ({ onChanged, onFocus, onBlur }) => {
  const {
    nextEpisodeOverlayEnabled,
    setNextEpisodeOverlayEnabled,
    autoSkipIntro,
    setAutoSkipIntro,
    introSkipSeconds,
    setIntroSkipSeconds,
    incognitoMode,
    setIncognitoMode,
    backgroundPlayback,
    setBackgroundPlayback,
  } = useSettingsStore();
  const [focusedKey, setFocusedKey] = useState<PlaybackFocusKey | null>(null);
  const deviceType = useResponsiveLayout().deviceType;

  // 画中画是否受当前设备支持（不支持时开关只控制后台音频，优雅降级）。
  const pipSupported = useMemo(() => {
    try {
      return isPictureInPictureSupported();
    } catch {
      return false;
    }
  }, []);

  const toggles: {
    key: PlaybackToggleKey;
    name: string;
    description: string;
    value: boolean;
    setValue: (enabled: boolean) => void;
  }[] = [
    {
      key: "nextEpisodeOverlayEnabled",
      name: "下一集预告",
      description: "播到片尾附近时弹出下一集预告，可立即播放或关闭",
      value: nextEpisodeOverlayEnabled,
      setValue: setNextEpisodeOverlayEnabled,
    },
    {
      key: "autoSkipIntro",
      name: "自动跳过片头",
      description: "播放到片头结束处自动跳过；没标过片头时间时按下面“片头时长”跳",
      value: autoSkipIntro,
      setValue: setAutoSkipIntro,
    },
    {
      key: "incognitoMode",
      name: "无痕模式",
      description: "开启后不保存播放记录与断点，收藏不受影响",
      value: incognitoMode,
      setValue: setIncognitoMode,
    },
    {
      key: "backgroundPlayback",
      name: "后台播放与画中画",
      description: pipSupported
        ? "切到后台时自动进入画中画并继续播放音频"
        : "当前设备不支持画中画，开启后切到后台仍可继续播放音频",
      value: backgroundPlayback,
      setValue: setBackgroundPlayback,
    },
  ];

  const handleToggle = (key: PlaybackToggleKey) => {
    const toggle = toggles.find((t) => t.key === key);
    if (!toggle) return;
    toggle.setValue(!toggle.value);
    onChanged();
  };

  // 片头时长：点按循环切换档位（0=不跳，只用手动标记的片头时间）
  const handleIntroSkipSeconds = () => {
    const idx = INTRO_SKIP_OPTIONS.indexOf(introSkipSeconds as (typeof INTRO_SKIP_OPTIONS)[number]);
    const next = INTRO_SKIP_OPTIONS[(idx + 1) % INTRO_SKIP_OPTIONS.length];
    setIntroSkipSeconds(next);
    onChanged();
  };
  const introSkipLabel = introSkipSeconds === 0 ? "不跳过" : `${introSkipSeconds}秒`;

  // TV 下外层 SettingsSection 不可聚焦：外层 Pressable 一旦可聚焦就会抢走焦点，
  // 内层 4 行开关永远拿不到焦点、onPress 永远不触发（第 58 轮远程输入行同款问题），
  // 电视上后台播放/画中画就点不动。非 TV 保持原样（触摸不走焦点）。
  // 行聚焦时同步通知页面（外层不再聚焦，section 级 onFocus 在 TV 下不会触发）。
  return (
    <SettingsSection focusable={deviceType !== "tv"} onFocus={onFocus} onBlur={onBlur}>
      <ThemedText style={styles.sectionTitle}>播放设置</ThemedText>

      {toggles.map((toggle) => {
        const isFocused = focusedKey === toggle.key;
        return (
          <Pressable
            key={toggle.key}
            style={[styles.settingItem, isFocused && styles.settingItemFocused]}
            onFocus={() => { setFocusedKey(toggle.key); onFocus?.(); }}
            onBlur={() => setFocusedKey(null)}
            onPress={() => handleToggle(toggle.key)}
          >
            <View style={styles.settingInfo}>
              <ThemedText style={styles.settingName}>{toggle.name}</ThemedText>
              <ThemedText style={styles.settingDescription}>{toggle.description}</ThemedText>
            </View>
            {Platform.OS === "ios" && Platform.isTV ? (
              <TouchableOpacity activeOpacity={0.8} onPress={() => handleToggle(toggle.key)} style={styles.statusLabel}>
                <ThemedText style={styles.statusValue}>{toggle.value ? "已启用" : "已禁用"}</ThemedText>
              </TouchableOpacity>
            ) : (
              <Switch
                value={toggle.value}
                onValueChange={() => {}} // 禁用Switch的直接交互，由整行点按切换
                trackColor={{ false: "#767577", true: Colors.dark.primary }}
                thumbColor={toggle.value ? "#ffffff" : "#f4f3f4"}
                pointerEvents="none"
              />
            )}
          </Pressable>
        );
      })}
      {/* 片头时长：没标过片头时间时按这个时长跳；0=不跳，只认手动标记 */}
      <Pressable
        onFocus={() => { setFocusedKey("introSkipSeconds"); onFocus?.(); }}
        onBlur={() => setFocusedKey(null)}
        onPress={handleIntroSkipSeconds}
        style={[styles.settingItem, focusedKey === "introSkipSeconds" && styles.settingItemFocused]}
      >
        <View style={styles.settingInfo}>
          <ThemedText style={styles.settingName}>片头时长</ThemedText>
          <ThemedText style={styles.settingDescription}>
            没标过片头时间时，按这个时长跳过片头
          </ThemedText>
        </View>
        <ThemedText style={styles.introSkipValue}>{introSkipLabel}</ThemedText>
      </Pressable>
    </SettingsSection>
  );
};

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 8,
  },
  settingItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  settingItemFocused: {
    backgroundColor: "#3a3a3c",
    borderColor: Colors.dark.primary,
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingName: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 14,
    color: "#888",
  },
  statusLabel: {
    paddingVertical: 4,
  },
  statusValue: {
    fontSize: 14,
  },
  introSkipValue: {
    fontSize: 16,
    color: Colors.dark.primary,
    fontWeight: "600",
  },
});
