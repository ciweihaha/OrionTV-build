// 组件级复现：1.2.0 测试版“根本连不上网”。
// 根因：新装应用未配服务器时，首页内容区被服务器配置提示/错误盖住，
// 即便 CMS（agg 直连，不依赖用户服务器）的内容已加载成功：
// 动漫/综艺无 tags，shouldShowApiConfig 为真，永远显示“请配置服务器地址”；
// 服务器配置拉取失败时 apiConfigStatus.error 分支同样盖住全部内容。
// 修复后：CMS 分类下配置提示、校验中、配置错误三条分支都不再挡内容。

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import HomeScreen from "@/app/index";
import { api } from "@/services/api";
import { useApiConfig } from "@/hooks/useApiConfig";

jest.mock("@/services/api", () => ({
  api: {
    getAggCategory: jest.fn(),
    getDoubanData: jest.fn(),
    getServerConfig: jest.fn(async () => ({})),
    login: jest.fn(),
    logout: jest.fn(),
    setSessionRestorer: jest.fn(),
  },
}));

jest.mock("@/services/storage", () => ({
  PlayRecordManager: { getAll: jest.fn(async () => ({})) },
}));

jest.mock("@/stores/authStore", () => {
  const state = {
    isLoggedIn: false,
    logout: jest.fn(),
    checkLoginStatus: jest.fn(async () => undefined),
  };
  const hook: any = () => state;
  hook.getState = () => state;
  return { __esModule: true, default: hook };
});

// 未配服务器：apiBaseUrl 为空（新装应用卸载 1.6.8 后重装的状态）。
jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: Object.assign(jest.fn(() => ({ apiBaseUrl: "" })), {
    getState: () => ({
      apiBaseUrl: "",
      serverConfig: null,
      isLoadingServerConfig: false,
      fetchServerConfig: jest.fn(async () => undefined),
    }),
  }),
  getServerConfigPromise: jest.fn(() => null),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === "function" ? cleanup : undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: () => ({
    deviceType: "tv",
    columns: 5,
    cardWidth: 200,
    cardHeight: 280,
    spacing: 16,
    isPortrait: false,
    screenWidth: 1920,
    screenHeight: 1080,
  }),
}));

jest.mock("@/utils/ResponsiveStyles", () => ({
  getCommonResponsiveStyles: () => ({ container: {}, center: {} }),
}));

// useApiConfig 做成可变的 jest.fn：每条用例在渲染前设定当时的配置状态。
jest.mock("@/hooks/useApiConfig", () => ({
  useApiConfig: jest.fn(),
  getApiConfigErrorMessage: (status: any) => {
    if (status.needsConfiguration) return "请点击右上角设置按钮，配置您的服务器地址";
    if (status.error) return status.error;
    if (status.isValidating) return "正在验证服务器配置...";
    if (status.isValid === false) return "服务器配置验证失败，请检查设置";
    return "加载失败，请重试";
  },
}));

jest.mock("lucide-react-native", () => ({
  Search: () => null,
  Settings: () => null,
  LogOut: () => null,
  Heart: () => null,
}));

jest.mock("@/components/ThemedView", () => ({
  ThemedView: (props: any) => {
    const { View } = // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("react-native");
    return <View {...props} />;
  },
}));

jest.mock("@/components/ThemedText", () => ({
  ThemedText: (props: any) => {
    const { Text } = // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("react-native");
    return <Text {...props}>{props.children}</Text>;
  },
}));

jest.mock("@/components/VideoCard", () => ({
  __esModule: true,
  default: (props: any) => {
    const { View, Text } = // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("react-native");
    return (
      <View testID={`card-${props.title}`}>
        <Text>{props.title}</Text>
      </View>
    );
  },
}));

jest.mock("@/components/navigation/ResponsiveNavigation", () => ({
  __esModule: true,
  default: (props: any) => {
    const { View } = // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("react-native");
    return <View {...props} />;
  },
}));

function aggResponse(items: { id: string; name: string }[], typeName: string) {
  return {
    code: 1,
    page: 1,
    pagecount: 100,
    total: items.length,
    list: items.map((it) => ({
      vod_id: it.id,
      vod_name: it.name,
      vod_pic: "",
      vod_year: "2026",
      vod_area: "日本",
      vod_douban_score: "",
      type_name: typeName,
    })),
  };
}

const ANIME = aggResponse(
  [
    { id: "a1", name: "动漫影片A" },
    { id: "a2", name: "动漫影片B" },
  ],
  "动漫",
);
const VARIETY = aggResponse([{ id: "v1", name: "综艺影片A" }], "综艺");

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function findButtonByLabel(root: TestRenderer.ReactTestInstance, label: string) {
  const pressables = root.findAll(
    (node) => typeof (node.props as any)?.onPress === "function",
  );
  return pressables.find((p) =>
    p.findAllByType(Text).some((t) => t.props.children === label),
  );
}

function pressButtonByLabel(root: TestRenderer.ReactTestInstance, label: string) {
  const button = findButtonByLabel(root, label);
  if (!button) return false;
  act(() => {
    (button.props as any).onPress?.();
  });
  return true;
}

function visibleTitles(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .map((t) => t.props.children)
    .filter((c) => typeof c === "string");
}

describe("HomeScreen 无服务器场景（1.2.0 连不上网复现）", () => {
  const getAggMock = api.getAggCategory as jest.Mock;
  const useApiConfigMock = useApiConfig as jest.Mock;
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    getAggMock.mockImplementation((t: number) => {
      if (t === 3) return Promise.resolve(ANIME);
      if (t === 4) return Promise.resolve(VARIETY);
      return Promise.resolve(ANIME);
    });
  });

  afterEach(() => {
    renderer?.unmount();
  });

  it("未配服务器时点动漫（无 tags 的 CMS 分类）：agg 内容照常显示，不出现配置提示", async () => {
    useApiConfigMock.mockReturnValue({
      isConfigured: false,
      isValidating: false,
      isValid: false,
      error: null,
      needsConfiguration: true,
    });
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    const root = renderer.root;

    expect(pressButtonByLabel(root, "动漫")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("动漫影片A"));

    expect(visibleTitles(root)).toContain("动漫影片B");
    expect(visibleTitles(root)).not.toContain("请点击右上角设置按钮，配置您的服务器地址");
  }, 30000);

  it("服务器配置拉取失败时点综艺：agg 内容照常显示，不出现配置错误", async () => {
    useApiConfigMock.mockReturnValue({
      isConfigured: true,
      isValidating: false,
      isValid: false,
      error: "无法获取服务器配置",
      needsConfiguration: false,
    });
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    const root = renderer.root;

    expect(pressButtonByLabel(root, "综艺")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("综艺影片A"));

    expect(visibleTitles(root)).not.toContain("无法获取服务器配置");
  }, 30000);
});
