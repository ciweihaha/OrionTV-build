// 回归：v1.7.6 平板重测第 2 轮（2026-11-18 13:24–13:29）点“重试”
// 两次都无效，xt_qtaguid 证实 12 秒内零流量——重试根本没发请求。
// v1.7.7 修复：错误屏“重试”改走 store 的 retryLoad 硬重载（绕过
// fetchInitialData 的缓存命中与同内容后台刷新两条提前返回），
// 并在错误屏上显示原始错误值（友好文案看不出是哪一环失败）。

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
  isCancelError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (name === "AbortError") return true;
    if (typeof message === "string" && /abort|cancel/i.test(message)) return true;
    return false;
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

const MOVIE = aggResponse(
  [
    { id: "m1", name: "电影影片A" },
    { id: "m2", name: "电影影片B" },
  ],
  "电影",
);

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

describe("HomeScreen 重试按钮（v1.7.7 平板重试无效回归）", () => {
  const getAggMock = api.getAggCategory as jest.Mock;
  const useApiConfigMock = useApiConfig as jest.Mock;
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    useApiConfigMock.mockReturnValue({
      isConfigured: false,
      isValidating: false,
      isValid: false,
      error: null,
      needsConfiguration: true,
    });
  });

  afterEach(() => {
    renderer?.unmount();
  });

  it("agg 失败出错误屏后，点“重试”必须再次发起 agg 请求", async () => {
    getAggMock.mockRejectedValue(new Error("Network request failed"));
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    const root = renderer.root;

    expect(pressButtonByLabel(root, "电影")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("网络连接失败，请检查网络连接"));
    expect(visibleTitles(root)).toContain("重试");
    const callsBeforeRetry = getAggMock.mock.calls.length;
    expect(callsBeforeRetry).toBeGreaterThan(0);

    // 服务端恢复：重试这次返回正常数据
    getAggMock.mockResolvedValue(MOVIE);
    expect(pressButtonByLabel(root, "重试")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("电影影片A"));

    expect(getAggMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(visibleTitles(root)).toContain("电影影片B");
  }, 30000);

  it("agg 失败时错误屏显示原始错误值，不只显示友好文案", async () => {
    getAggMock.mockRejectedValue(new Error("AGG_INVALID_RESPONSE"));
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    const root = renderer.root;

    // 注意：上一个用例结束时分类停在“电影”，再点“电影”会被
    // selectCategory 判定为同分类而 no-op；这里点“动漫”
    // （同样走 agg，错误映射与原始值记录与电影一致）。
    expect(pressButtonByLabel(root, "动漫")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("加载失败，请重试"));

    // 友好文案之下必须有原始错误值，否则下次还是只能猜是哪一环失败
    expect(visibleTitles(root)).toContain("AGG_INVALID_RESPONSE");
  }, 30000);
});
