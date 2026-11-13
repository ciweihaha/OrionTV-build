import { useEffect } from "react";
import useLayoutStore, { syncLayoutFromDimensions } from "@/stores/layoutStore";

// 类型仍从这里 re-export：全仓 20+ 处 import { ResponsiveConfig, DeviceType }
// from "@/hooks/useResponsiveLayout"，不动调用方
export type { DeviceType, ResponsiveConfig } from "@/utils/responsiveLayout";

/**
 * 布局配置 hook：现在只读全局 layoutStore，不再每调用一次就挂一个
 * Dimensions 监听。配置对象只在尺寸/方向变化时才换身份，下游的
 * getCommonResponsiveStyles / StyleSheet.create / 各 useMemo 不会跟着重算。
 * 首挂时用当前 Dimensions 校验一次（见 layoutStore.syncLayoutFromDimensions），
 * 配置没变时不写 store、不触发重渲染。
 */
export const useResponsiveLayout = () => {
  const config = useLayoutStore((s) => s.config);
  useEffect(() => {
    syncLayoutFromDimensions();
  }, []);
  return config;
};

// Utility hook for responsive styles
export const useResponsiveStyles = () => {
  const config = useResponsiveLayout();

  return {
    // Common responsive styles
    container: {
      paddingHorizontal: config.spacing,
    },

    // Card styles
    cardContainer: {
      width: config.cardWidth,
      height: config.cardHeight,
      marginBottom: config.spacing,
    },

    // Grid styles
    gridContainer: {
      paddingHorizontal: config.spacing / 2,
    },

    // Typography
    titleFontSize: config.deviceType === "mobile" ? 18 : config.deviceType === "tablet" ? 22 : 28,
    bodyFontSize: config.deviceType === "mobile" ? 14 : config.deviceType === "tablet" ? 16 : 18,

    // Spacing
    sectionSpacing: config.deviceType === "mobile" ? 16 : config.deviceType === "tablet" ? 20 : 24,
    itemSpacing: config.spacing,
  };
};
