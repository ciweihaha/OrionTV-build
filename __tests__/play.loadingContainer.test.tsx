// 回归：v1.7.10——app/play.tsx 的 LoadingContainer 原来在 render 里调
// logger.info，等待 URL 期间每次重渲染都重复打一条日志（render 副作用）。
// 改成挂载时 useEffect 只打一次：同一实例多次重渲染只记一次，
// 重新挂载（新一次等待）再记一次。

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { LoadingContainer } from "@/app/play";

jest.mock("@/utils/Logger", () => {
  const info = jest.fn();
  const stub = { debug: jest.fn(), info, warn: jest.fn(), error: jest.fn() };
  const mockLogger = { withTag: () => stub };
  (globalThis as any).__mockLoggerInfo = info;
  return { __esModule: true, default: mockLogger, Logger: mockLogger };
});

const mockInfo = () => (globalThis as any).__mockLoggerInfo as jest.Mock;

jest.mock("@/components/VideoLoadingAnimation", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: () => ReactLib.createElement(View, { testID: "loading-animation" }),
  };
});

// play.tsx 还引用了 expo-video / expo-router 等模块：只测 LoadingContainer
// 这一个具名导出，但 import 整个模块会执行顶层代码，相关模块全部 mock 掉。
jest.mock("expo-video", () => ({
  VideoView: () => null,
  useVideoPlayer: jest.fn(() => null),
  isPictureInPictureSupported: jest.fn(() => false),
}));
jest.mock("expo-keep-awake", () => ({ useKeepAwake: jest.fn() }));
jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({})),
  useRouter: jest.fn(() => ({ back: jest.fn() })),
}));
jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}), { virtual: true });

// 只测 LoadingContainer 这一个具名导出，但 import 整个模块会执行顶层代码，
// 播放页的兄弟组件 / store / hook 全部 mock 掉（它们会拉进 lucide 等
// jest 下无法直接 require 的 ESM 模块）。
jest.mock("@/components/PlayerControls", () => ({ PlayerControls: () => null }));
jest.mock("@/components/EpisodeSelectionModal", () => ({ EpisodeSelectionModal: () => null }));
jest.mock("@/components/SourceSelectionModal", () => ({ SourceSelectionModal: () => null }));
jest.mock("@/components/SpeedSelectionModal", () => ({ SpeedSelectionModal: () => null }));
jest.mock("@/components/SeekingBar", () => ({ SeekingBar: () => null }));
jest.mock("@/components/NextEpisodeOverlay", () => ({ NextEpisodeOverlay: () => null }));
jest.mock("@/stores/detailStore", () => ({ __esModule: true, default: jest.fn(() => null) }));
jest.mock("@/stores/playerStore", () => ({
  __esModule: true,
  default: jest.fn(() => null),
  selectCurrentEpisode: jest.fn(() => undefined),
}));
jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: jest.fn(() => false),
}));
jest.mock("@/hooks/useTVRemoteHandler", () => ({
  useTVRemoteHandler: jest.fn(() => ({ onScreenPress: jest.fn() })),
}));
jest.mock("@/hooks/useVideoHandlers", () => ({
  useVideoHandlers: jest.fn(() => ({ videoViewProps: {} })),
}));
jest.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: jest.fn(() => ({ deviceType: "tablet" })),
}));
jest.mock("@/utils/introSkip", () => ({ resolveIntroEndTime: jest.fn(() => 0) }));

describe("LoadingContainer 日志只在挂载时打一次", () => {
  beforeEach(() => {
    mockInfo().mockClear();
  });

  it("同一实例多次重渲染只记一次", () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <LoadingContainer style={{}} currentEpisode={undefined} />
      );
    });
    expect(mockInfo()).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.update(
        <LoadingContainer style={{ flex: 1 }} currentEpisode={undefined} />
      );
    });
    act(() => {
      renderer.update(
        <LoadingContainer style={{}} currentEpisode={{ url: "", title: "x" }} />
      );
    });
    expect(mockInfo()).toHaveBeenCalledTimes(1);
  });

  it("重新挂载再记一次", () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <LoadingContainer style={{}} currentEpisode={undefined} />
      );
    });
    expect(mockInfo()).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
    act(() => {
      renderer = TestRenderer.create(
        <LoadingContainer style={{}} currentEpisode={undefined} />
      );
    });
    expect(mockInfo()).toHaveBeenCalledTimes(2);
  });
});
