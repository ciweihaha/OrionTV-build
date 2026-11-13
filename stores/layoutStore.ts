import { create } from "zustand";
import { Dimensions } from "react-native";
import type { ScaledSize } from "react-native";
import {
  computeResponsiveConfig,
  getDeviceType,
  getLayoutConfig,
  type ResponsiveConfig,
} from "@/utils/responsiveLayout";

interface LayoutState {
  config: ResponsiveConfig;
}

const useLayoutStore = create<LayoutState>(() => ({
  config: computeResponsiveConfig(),
}));

// 布局配置是全局不变的：原来 useResponsiveLayout 每次调用都各挂一个
// Dimensions 监听 + 一份 state，首页 100 张卡 = 100 个监听器 + 100 份
// state，旋转时 100 次 setState。现在根部只订阅一次，变化时写 store，
// 各组件只读 store 值。
// 监听在模块首次 import 时挂一次（store 是单例，整个应用只会 import 一次）。
Dimensions.addEventListener("change", ({ window }: { window: ScaledSize }) => {
  const { width, height } = window;
  const isPortrait = height > width;
  // 与初始化同一条纯函数路径算新配置，避免两处逻辑漂移
  useLayoutStore.setState({
    config: getLayoutConfig(getDeviceType(width), width, height, isPortrait),
  });
});

export default useLayoutStore;
