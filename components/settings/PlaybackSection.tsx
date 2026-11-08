import React, { useMemo, useState } from "react";
import { View, Switch, StyleSheet, Pressable, Platform, TouchableOpacity } from "react-native";
import { isPictureInPictureSupported } from "expo-video";
import { ThemedText } from "@/components/ThemedText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
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
    incognitoMode,
    setIncognitoMode,
    backgroundPlayback,
    setBackgroundPlayback,
  } = useSettingsStore();
  const [focusedKey, setFocusedKey] = useState<PlaybackToggleKey | null>(null);

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
      description: "播放到片头结束处自动跳过",
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

  return (
    <SettingsSection focusable onFocus={onFocus} onBlur={onBlur}>
      <ThemedText style={styles.sectionTitle}>播放设置</ThemedText>

      {toggles.map((toggle) => {
        const isFocused = focusedKey === toggle.key;
        return (
          <Pressable
            key={toggle.key}
            hasTVPreferredFocus={isFocused}
            style={[styles.settingItem, isFocused && styles.settingItemFocused]}
            onFocus={() => setFocusedKey(toggle.key)}
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
});
