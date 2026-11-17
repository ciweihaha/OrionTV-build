// 组件级复现：筛选界面缺失——筛选数据层是好的（store + agg 接口按条件
// 过滤正确），但首页没有任何筛选入口，用户在电视上根本用不到筛选。
// 修复：CMS 内容加载成功后（cmsFilterAvailable），首页出现地区 / 年代两行
// 筛选（用现成的 REGION_OPTIONS / getYearOptions / setRegionFilter /
// setYearFilter），点选项列表真的按条件变；豆瓣/最近播放分类下不出现。

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

// 模拟服务端：按 filters 返回不同内容（与 2026-11-12 实测的服务端行为一致）。
function aggResponse(items: { id: string; name: string; area: string; year: string }[]) {
  return {
    code: 1,
    page: 1,
    pagecount: 100,
    total: items.length,
    list: items.map((it) => ({
      vod_id: it.id,
      vod_name: it.name,
      vod_pic: "",
      vod_year: it.year,
      vod_area: it.area,
      vod_douban_score: "",
      type_name: "电影",
    })),
  };
}

const UNFILTERED = aggResponse([
  { id: "u1", name: "未筛影片A", area: "美国", year: "2026" },
  { id: "u2", name: "未筛影片B", area: "中国大陆", year: "2025" },
]);
const HK_ONLY = aggResponse([
  { id: "h1", name: "香港影片A", area: "香港", year: "2010" },
  { id: "h2", name: "香港影片B", area: "中国香港", year: "2009" },
]);
const YEAR_2024 = aggResponse([
  { id: "y1", name: "2024影片A", area: "日本", year: "2024" },
]);
// 豆瓣回落返回的内容：豆瓣分类下显示它。
const DOUBAN_FALLBACK = {
  list: [{ title: "豆瓣影片A", cover: "", rate: "", year: "" }],
};

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

function findButtonsByLabel(root: TestRenderer.ReactTestInstance, label: string) {
  const pressables = root.findAll(
    (node) => typeof (node.props as any)?.onPress === "function",
  );
  return pressables.filter((p) =>
    p.findAllByType(Text).some((t) => t.props.children === label),
  );
}

function findButtonByLabel(root: TestRenderer.ReactTestInstance, label: string) {
  return findButtonsByLabel(root, label)[0];
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

describe("HomeScreen CMS 筛选行（筛选界面补回）", () => {
  const getAggMock = api.getAggCategory as jest.Mock;
  const getDoubanMock = api.getDoubanData as jest.Mock;
  const useApiConfigMock = useApiConfig as jest.Mock;
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    getDoubanMock.mockResolvedValue(DOUBAN_FALLBACK);
    getAggMock.mockImplementation((_t: number, _pg: number, filters?: any) => {
      if (filters?.area === "香港") return Promise.resolve(HK_ONLY);
      if (filters?.year === "2024") return Promise.resolve(YEAR_2024);
      return Promise.resolve(UNFILTERED);
    });
    useApiConfigMock.mockReturnValue({
      isConfigured: true,
      isValidating: false,
      isValid: true,
      error: null,
      needsConfiguration: false,
    });
  });

  afterEach(() => {
    renderer?.unmount();
  });

  async function renderAndOpenMovie() {
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    const root = renderer.root;
    expect(pressButtonByLabel(root, "电影")).toBe(true);
    // 跨用例的 store 状态会漏过来（上个用例可能留了筛选值）：先把两行都点回
    // “全部”再等未筛列表。值已是全部时 store 内部不做事，点两次也无害。
    // 注意：首个用例里筛选行还没出现（CMS 未加载完），这里找不到按钮，
    // 本来就是未筛状态，等未筛列表即可。
    for (const button of findButtonsByLabel(root, "全部")) {
      act(() => {
        (button.props as any).onPress?.();
      });
    }
    await waitFor(() => visibleTitles(root).includes("未筛影片A"));
    return root;
  }

  it("进电影（CMS 分类）：出现地区 / 年代两行筛选，选项齐全", async () => {
    const root = await renderAndOpenMovie();

    expect(visibleTitles(root)).toContain("地区");
    expect(visibleTitles(root)).toContain("年代");
    // 地区选项：全部 + 7 个地区
    for (const label of ["全部", "中国大陆", "香港", "台湾", "美国", "韩国", "日本", "英国"]) {
      expect(visibleTitles(root)).toContain(label);
    }
    // 年代选项：全部 + 当前年份往回 6 年（2026 年跑测试时含 2024）
    expect(visibleTitles(root)).toContain("2024");
  }, 30000);

  it("点地区=香港：请求带 area=香港，列表变成香港片", async () => {
    const root = await renderAndOpenMovie();

    expect(pressButtonByLabel(root, "香港")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("香港影片A"));

    expect(visibleTitles(root)).toContain("香港影片B");
    expect(visibleTitles(root)).not.toContain("未筛影片A");
    expect(
      getAggMock.mock.calls.some((c) => (c[2] as any)?.area === "香港"),
    ).toBe(true);
  }, 30000);

  it("点年代=2024：请求带 year=2024，列表变成 2024 年的片", async () => {
    const root = await renderAndOpenMovie();

    expect(pressButtonByLabel(root, "2024")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("2024影片A"));

    expect(visibleTitles(root)).not.toContain("未筛影片A");
    expect(
      getAggMock.mock.calls.some((c) => (c[2] as any)?.year === "2024"),
    ).toBe(true);
  }, 30000);

  it("切到豆瓣 Top250（非 CMS）：筛选行消失", async () => {
    const root = await renderAndOpenMovie();
    expect(visibleTitles(root)).toContain("地区");

    expect(pressButtonByLabel(root, "豆瓣 Top250")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("豆瓣影片A"));

    expect(visibleTitles(root)).not.toContain("地区");
    expect(visibleTitles(root)).not.toContain("年代");
  }, 30000);
});
