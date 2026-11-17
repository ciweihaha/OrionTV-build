// 组件级复现：筛选界面缺失——筛选数据层是好的（store + agg 接口按条件
// 过滤正确），但首页没有任何筛选入口，用户在电视上根本用不到筛选。
// 修复：CMS 内容加载成功后（cmsFilterAvailable），首页出现“筛选”按钮，
// 点开是 agg 下发的筛选面板（只留服务端可靠的 4 组：地区/年代/语言/排序；
// 类型/评分服务端处理不可靠，不提供、不出现、不做客户端过滤），
// 点选项列表真的按条件变；豆瓣/最近播放分类下不出现。

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import HomeScreen from "@/app/index";
import { api } from "@/services/api";
import { useApiConfig } from "@/hooks/useApiConfig";
import useHomeStore from "@/stores/homeStore";

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

// 服务端下发的筛选组（与 2026-11-17 agg 实测结构一致）。
const MOCK_FILTER_GROUPS = [
  { key: "cate", name: "类型", value: [{ n: "全部", v: "" }, { n: "科幻片", v: "科幻片" }, { n: "动作片", v: "动作片" }] },
  { key: "area", name: "地区", value: [{ n: "全部", v: "" }, { n: "香港", v: "香港" }, { n: "日本", v: "日本" }] },
  { key: "year", name: "年代", value: [{ n: "全部", v: "" }, { n: "2024", v: "2024" }] },
  { key: "lang", name: "语言", value: [{ n: "全部", v: "" }, { n: "日语", v: "日语" }] },
  { key: "score", name: "评分", value: [{ n: "全部", v: "" }, { n: "8分以上", v: "8分以上" }] },
  { key: "order", name: "排序", value: [{ n: "默认", v: "" }, { n: "最新", v: "最新" }] },
];

// 模拟服务端：按 filters 返回不同内容（与 2026-11-12/11-17 实测的服务端行为一致）。
function aggResponse(items: { id: string; name: string; area: string; year: string; vodClass?: string; score?: string }[]) {
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
      vod_class: it.vodClass ?? "",
      vod_douban_score: it.score ?? "",
      type_name: "电影",
    })),
    filters: MOCK_FILTER_GROUPS,
  };
}

const UNFILTERED = aggResponse([
  { id: "u1", name: "未筛影片A", area: "美国", year: "2026", vodClass: "科幻,动作", score: "8.5" },
  { id: "u2", name: "未筛影片B", area: "中国大陆", year: "2025", vodClass: "剧情,爱情", score: "7.2" },
]);
const HK_ONLY = aggResponse([
  { id: "h1", name: "香港影片A", area: "香港", year: "2010", vodClass: "动作", score: "7.5" },
  { id: "h2", name: "香港影片B", area: "中国香港", year: "2009", vodClass: "剧情", score: "6.8" },
]);
const YEAR_2024 = aggResponse([
  { id: "y1", name: "2024影片A", area: "日本", year: "2024", vodClass: "动画", score: "8.0" },
]);
const JP_ONLY = aggResponse([
  { id: "j1", name: "日语影片A", area: "日本", year: "2023", vodClass: "剧情", score: "7.9" },
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

// 面板默认收起；按钮文字是“筛选”或“筛选（已选）”时点它展开；
// 已是“收起筛选”说明已展开，不用点。
function openFilterPanel(root: TestRenderer.ReactTestInstance): boolean {
  if (findButtonByLabel(root, "收起筛选")) return true;
  const btn = findButtonByLabel(root, "筛选") || findButtonByLabel(root, "筛选（已选）");
  if (!btn) return false;
  act(() => {
    (btn.props as any).onPress?.();
  });
  return true;
}

describe("HomeScreen CMS 筛选面板（筛选界面补回）", () => {
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
      if (filters?.lang === "日语") return Promise.resolve(JP_ONLY);
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
    // 跨用例的 store 状态会漏过来（上个用例可能留了筛选值）：直接用 store
    // 重置筛选并收起面板（不走 UI，更可靠）；无筛选时 clearAggFilters
    // 内部直接返回，不会多发请求。
    act(() => {
      useHomeStore.getState().clearAggFilters();
      useHomeStore.getState().setFiltersVisible(false);
    });
    await waitFor(() => visibleTitles(root).includes("未筛影片A"));
    return root;
  }

  it("进电影（CMS 分类）：出现“筛选”按钮，点开展现 4 组筛选，选项齐全", async () => {
    const root = await renderAndOpenMovie();

    expect(findButtonByLabel(root, "筛选")).toBeTruthy();
    // 默认收起：组名还没出现。
    expect(visibleTitles(root)).not.toContain("地区");
    expect(visibleTitles(root)).not.toContain("排序");

    expect(openFilterPanel(root)).toBe(true);
    // 4 组组名都出现（服务端下发，只留可靠的 4 组）。
    for (const name of ["地区", "年代", "语言", "排序"]) {
      expect(visibleTitles(root)).toContain(name);
    }
    // 类型/评分组不出现（服务端对这两项不可靠，不提供）。
    expect(visibleTitles(root)).not.toContain("类型");
    expect(visibleTitles(root)).not.toContain("评分");
    // 各组选项齐全。
    for (const label of ["香港", "日本", "2024", "日语", "最新"]) {
      expect(visibleTitles(root)).toContain(label);
    }
  }, 30000);

  it("点地区=香港：请求带 area=香港，列表变成香港片", async () => {
    const root = await renderAndOpenMovie();
    expect(openFilterPanel(root)).toBe(true);

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
    expect(openFilterPanel(root)).toBe(true);

    expect(pressButtonByLabel(root, "2024")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("2024影片A"));

    expect(visibleTitles(root)).not.toContain("未筛影片A");
    expect(
      getAggMock.mock.calls.some((c) => (c[2] as any)?.year === "2024"),
    ).toBe(true);
  }, 30000);

  it("点语言=日语：请求带 lang=日语，列表变成日语片", async () => {
    const root = await renderAndOpenMovie();
    expect(openFilterPanel(root)).toBe(true);

    expect(pressButtonByLabel(root, "日语")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("日语影片A"));

    expect(visibleTitles(root)).not.toContain("未筛影片A");
    expect(
      getAggMock.mock.calls.some((c) => (c[2] as any)?.lang === "日语"),
    ).toBe(true);
  }, 30000);

  it("点筛选后按钮显示“筛选（已选）”，点“重置筛选”回到未筛列表", async () => {
    const root = await renderAndOpenMovie();
    expect(openFilterPanel(root)).toBe(true);

    expect(pressButtonByLabel(root, "香港")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("香港影片A"));
    // 面板还开着，按钮是“收起筛选”；收起后面板才显示“筛选（已选）”。
    expect(findButtonByLabel(root, "收起筛选")).toBeTruthy();
    expect(pressButtonByLabel(root, "收起筛选")).toBe(true);
    expect(findButtonByLabel(root, "筛选（已选）")).toBeTruthy();

    expect(pressButtonByLabel(root, "重置筛选")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("未筛影片A"));
    expect(findButtonByLabel(root, "筛选")).toBeTruthy();
  }, 30000);

  it("切到豆瓣 Top250（非 CMS）：筛选按钮消失", async () => {
    const root = await renderAndOpenMovie();
    expect(findButtonByLabel(root, "筛选")).toBeTruthy();

    expect(pressButtonByLabel(root, "豆瓣 Top250")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("豆瓣影片A"));

    expect(findButtonByLabel(root, "筛选")).toBeFalsy();
    expect(visibleTitles(root)).not.toContain("地区");
    expect(visibleTitles(root)).not.toContain("评分");
  }, 30000);
});
