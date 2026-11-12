import React, { useState, useRef, useImperativeHandle, forwardRef } from "react";
import { View, TextInput, StyleSheet, Animated , useTVEventHandler } from "react-native";
import type { TextInputInstance } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import { useButtonAnimation } from "@/hooks/useAnimation";
import { Colors } from "@/constants/Colors";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface APIConfigSectionProps {
  onChanged: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPress?: () => void;
  hideDescription?: boolean;
}

export interface APIConfigSectionRef {
  setInputValue: (value: string) => void;
}

export const APIConfigSection = forwardRef<APIConfigSectionRef, APIConfigSectionProps>(
  ({ onChanged, onFocus, onBlur, onPress, hideDescription = false }, ref) => {
    const { apiBaseUrl, setApiBaseUrl, remoteInputEnabled } = useSettingsStore();
    const { serverUrl } = useRemoteControlStore();
    const [isInputFocused, setIsInputFocused] = useState(false);
    const [isSectionFocused, setIsSectionFocused] = useState(false);
    const inputRef = useRef<TextInputInstance>(null);
    const inputAnimationStyle = useButtonAnimation(isSectionFocused, 1.01);
    const deviceType = useResponsiveLayout().deviceType;

    const handleUrlChange = (url: string) => {
      setApiBaseUrl(url);
      onChanged();
    };

    // 光标只用命令式 setNativeProps 移（focus 时与远程输入后）：受控的
    // selection prop 会和 Android 输入法组词打架（IME 设组词区、React 又
    // 把旧 selection 写回去，组词断裂/光标乱跳），所以不挂 selection prop。
    const moveCursorToEnd = (length: number) => {
      // 等一帧让文本先渲染上去再移光标
      setTimeout(() => {
        inputRef.current?.setNativeProps({ selection: { start: length, end: length } });
      }, 0);
    };

    useImperativeHandle(ref, () => ({
      setInputValue: (value: string) => {
        setApiBaseUrl(value);
        // 远程输入是整串替换：光标会留在旧位置，之后在电视上接着打字
        // 会插到文本中间——直接移到末尾
        moveCursorToEnd(value.length);
        onChanged();
      },
    }));

    const handleSectionFocus = () => {
      setIsSectionFocused(true);
      onFocus?.();
    };

    const handleSectionBlur = () => {
      setIsSectionFocused(false);
      onBlur?.();
    };

    // TV遥控器事件处理
    const handleTVEvent = React.useCallback(
      (event: any) => {
        if (isSectionFocused && event.eventType === "select") {
          inputRef.current?.focus();
        }
      },
      [isSectionFocused]
    );

    const handlePress = () => {
      inputRef.current?.focus();
      onPress?.();
    }

    useTVEventHandler(handleTVEvent);

    return (
      <SettingsSection focusable onFocus={handleSectionFocus} onBlur={handleSectionBlur}
        {...deviceType === 'tv' ? undefined : { onPress: handlePress }}
      >
        <View style={styles.inputContainer}>
          <View style={styles.titleContainer}>
            <ThemedText style={styles.sectionTitle}>API 地址</ThemedText>
            {!hideDescription && remoteInputEnabled && serverUrl && (
              <ThemedText style={styles.subtitle}>用手机访问 {serverUrl}，可远程输入</ThemedText>
            )}
          </View>
          <Animated.View style={inputAnimationStyle}>
            <TextInput
              ref={inputRef}
              style={[styles.input, isInputFocused && styles.inputFocused]}
              value={apiBaseUrl}
              onChangeText={handleUrlChange}
              placeholder="输入服务器地址"
              placeholderTextColor="#888"
              autoCapitalize="none"
              autoCorrect={false}
              onFocus={() => {
                setIsInputFocused(true);
                // 将光标移动到文本末尾（命令式，不挂受控 selection，见上）
                moveCursorToEnd(apiBaseUrl.length);
              }}
              onBlur={() => setIsInputFocused(false)}
            />
          </Animated.View>
        </View>
      </SettingsSection>
    );
  }
);

APIConfigSection.displayName = "APIConfigSection";

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginRight: 12,
  },
  subtitle: {
    fontSize: 12,
    color: "#888",
    fontStyle: "italic",
  },
  inputContainer: {
    marginBottom: 12,
  },
  label: {
    fontSize: 16,
    marginBottom: 8,
    color: "#ccc",
  },
  input: {
    height: 50,
    borderWidth: 2,
    borderRadius: 8,
    paddingHorizontal: 15,
    fontSize: 16,
    backgroundColor: "#3a3a3c",
    color: "white",
    borderColor: "transparent",
  },
  inputFocused: {
    borderColor: Colors.dark.primary,
    shadowColor: Colors.dark.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    elevation: 5,
  },
});
