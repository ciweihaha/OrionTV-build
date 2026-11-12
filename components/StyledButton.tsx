import React, { forwardRef } from "react";
import { Animated, Pressable, StyleSheet, StyleProp, ViewStyle, PressableProps, TextStyle } from "react-native";
import type { ViewInstance } from "react-native";
import { ThemedText } from "./ThemedText";
import { Colors } from "@/constants/Colors";
import { useButtonAnimation } from "@/hooks/useAnimation";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface StyledButtonProps extends PressableProps {
  children?: React.ReactNode;
  text?: string;
  variant?: "default" | "primary" | "ghost";
  isSelected?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

// 样式只依赖静态的 Colors.dark：提到模块级，别每个按钮每次渲染都
// StyleSheet.create 两次（首页一个网格几十个按钮，滚动时反复渲染，
// 白白分配还让 style 数组每次都是新身份）
const colors = Colors.dark;

const variantStyles = {
  default: StyleSheet.create({
    button: {
      backgroundColor: colors.border,
    },
    text: {
      color: colors.text,
    },
    selectedButton: {
      backgroundColor: colors.primary,
    },
    focusedButton: {
      borderColor: colors.primary,
    },
    selectedText: {
      color: Colors.dark.text,
    },
  }),
  primary: StyleSheet.create({
    button: {
      backgroundColor: "transparent",
    },
    text: {
      color: colors.text,
    },
    focusedButton: {
      backgroundColor: colors.primary,
      borderColor: colors.background,
    },
    selectedButton: {
      backgroundColor: colors.primary,
    },
    selectedText: {
      color: colors.link,
    },
  }),
  ghost: StyleSheet.create({
    button: {
      backgroundColor: "transparent",
    },
    text: {
      color: colors.text,
    },
    focusedButton: {
      backgroundColor: "rgba(119, 119, 119, 0.2)",
      borderColor: colors.primary,
    },
    // 选中态必须看得见：原来这里是两个空对象 {}，?? 回退不会触发
    // （{} 不是 null/undefined），选中和没选中长得一模一样，用户在
    // 电视上点筛选后完全看不出选了哪个。改成与 default 一致的绿底。
    selectedButton: {
      backgroundColor: colors.primary,
    },
    selectedText: {
      color: Colors.dark.text,
    },
  }),
};

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  focusedButton: {
    backgroundColor: colors.link,
    borderColor: colors.background,
    elevation: 5,
    shadowColor: colors.link,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 15,
  },
  selectedButton: {
    backgroundColor: colors.tint,
  },
  text: {
    fontSize: 16,
    fontWeight: "500",
    color: colors.text,
  },
  selectedText: {
    color: Colors.dark.text,
  },
});

export const StyledButton = forwardRef<ViewInstance, StyledButtonProps>(
  ({ children, text, variant = "default", isSelected = false, style, textStyle, ...rest }, ref) => {
    const [isFocused, setIsFocused] = React.useState(false);
    const animationStyle = useButtonAnimation(isFocused);
    const deviceType = useResponsiveLayout().deviceType;

    return (
      <Animated.View style={[animationStyle, style]}>
        <Pressable
          android_ripple={deviceType === 'tv' ? { color: 'transparent' } : { color: Colors.dark.link }}
          ref={ref}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          style={({ focused }) => [
            styles.button,
            variantStyles[variant].button,
            isSelected && (variantStyles[variant].selectedButton ?? styles.selectedButton),
            focused && (variantStyles[variant].focusedButton ?? styles.focusedButton),
          ]}
          {...rest}
        >
          {text ? (
            <ThemedText
              style={[
                styles.text,
                variantStyles[variant].text,
                isSelected && (variantStyles[variant].selectedText ?? styles.selectedText),
                textStyle,
              ]}
            >
              {text}
            </ThemedText>
          ) : (
            children
          )}
        </Pressable>
      </Animated.View>
    );
  }
);

StyledButton.displayName = "StyledButton";
