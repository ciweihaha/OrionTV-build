import { Dimensions, Platform } from "react-native";

export type DeviceType = "mobile" | "tablet" | "tv";

export interface ResponsiveConfig {
  deviceType: DeviceType;
  columns: number;
  cardWidth: number;
  cardHeight: number;
  spacing: number;
  isPortrait: boolean;
  screenWidth: number;
  screenHeight: number;
}

const BREAKPOINTS = {
  mobile: { min: 0, max: 767 },
  tablet: { min: 768, max: 1023 },
  tv: { min: 1024, max: Infinity },
};

export const getDeviceType = (width: number): DeviceType => {
  if (Platform.isTV) return "tv";

  // 非 TV 设备最高只判到 tablet：大平板横屏/桌面 Web 宽度 ≥1024 时，
  // 旧逻辑会判为 tv，走固定 160px 卡片、5 列布局，且 nativeControls
  // （deviceType !== 'tv'）被禁用，触屏设备没了原生控制条。
  if (width >= BREAKPOINTS.tablet.min) return "tablet";
  return "mobile";
};

export const getLayoutConfig = (
  deviceType: DeviceType,
  width: number,
  height: number,
  isPortrait: boolean
): ResponsiveConfig => {
  const spacing = deviceType === "mobile" ? 8 : deviceType === "tablet" ? 12 : 16;

  let columns: number;
  let cardWidth: number;
  let cardHeight: number;

  switch (deviceType) {
    case "mobile":
      columns = isPortrait ? 3 : 4;
      // 使用flex布局，卡片可以更大一些来填充空间
      cardWidth = ((width - spacing) / columns) * 0.85; // 增大到85%
      cardHeight = cardWidth * 1.2; // 5:6 aspect ratio (reduced from 2:3)
      break;

    case "tablet":
      columns = isPortrait ? 3 : 4;
      cardWidth = ((width - spacing) / columns) * 0.85; // 增大到85%
      cardHeight = cardWidth * 1.4; // slightly less tall ratio
      break;

    case "tv":
    default:
      columns = 5;
      cardWidth = 160; // Fixed width for TV
      cardHeight = 240; // Fixed height for TV
      break;
  }

  return {
    deviceType,
    columns,
    cardWidth,
    cardHeight,
    spacing,
    isPortrait,
    screenWidth: width,
    screenHeight: height,
  };
};

/** 从当前窗口尺寸算一份布局配置（纯函数，供 store 初始化与尺寸变化时调用）。 */
export const computeResponsiveConfig = (): ResponsiveConfig => {
  const { width, height } = Dimensions.get("window");
  const isPortrait = height > width;
  return getLayoutConfig(getDeviceType(width), width, height, isPortrait);
};
