// 组件级复现：渲染真实的 HomeScreen（app/index.tsx），模拟电视上的点按：
// 进电影分类 → 点地区=香港，验证 store 收到筛选、列表变成香港片。
// store 层单测已过（homeStore.filter.test.ts），本测试验证组件接线
// （FlatList 渲染行、onPress 回调、cmsFilterAvailable 门控）没有断。
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text } from "react-native";
import HomeScreen from "@/app/index";
import { api } from "@/services/api";
import { Colors } from "@/constants/Colors";

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
    isLoggedIn: true,
    logout: jest.fn(),
    checkLoginStatus: jest.fn(async () => undefined),
  };
  const hook: any = () => state;
  hook.getState = () => state;
  return { __esModule: true, default: hook };
});

jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: Object.assign(jest.fn(() => ({ apiBaseUrl: "https://example.com" })), {
    getState: () => ({
      apiBaseUrl: "https://example.com",
      serverConfig: { StorageType: "localstorage" },
      isLoadingServerConfig: false,
      fetchServerConfig: jest.fn(async () => undefined),
    }),
  }),
  getServerConfigPromise: jest.fn(() => null),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    // 测试里直接跑一次 focus 回调（等价于进入首页）
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
  useApiConfig: () => ({
    isConfigured: true,
    isValidating: false,
    isValid: true,
    error: null,
    needsConfiguration: false,
  }),
  getApiConfigErrorMessage: () => "",
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

// VideoCard 只渲染标题文本，便于断言网格内容
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

/** 在渲染树里找文字为 label 的按钮的内层 Pressable 节点（style 是函数那个， */
/** 不是外层 StyledButton 组件实例），用于解析最终样式。 */
function findButtonStyleNode(root: TestRenderer.ReactTestInstance, label: string) {
  const pressables = root.findAll(
    (node) =>
      typeof (node.props as any)?.onPress === "function" &&
      typeof (node.props as any)?.style === "function",
  );
  return pressables.find((p) =>
    p.findAllByType(Text).some((t) => t.props.children === label),
  );
}

/** 在渲染树里找文字为 label 的可按压节点（带 onPress 属性）。 */
function findButtonByLabel(root: TestRenderer.ReactTestInstance, label: string) {
  const pressables = root.findAll(
    (node) => typeof (node.props as any)?.onPress === "function",
  );
  return pressables.find((p) =>
    p.findAllByType(Text).some((t) => t.props.children === label),
  );
}

/** 在渲染树里找文字为 label 的可按压节点，调用其 onPress。 */
function pressButtonByLabel(root: TestRenderer.ReactTestInstance, label: string) {
  const button = findButtonByLabel(root, label);
  if (!button) return false;
  act(() => {
    (button.props as any).onPress?.();
  });
  return true;
}

/** 把按钮的 style 函数按“不聚焦、不按下”算出来，展平后返回。 */
function resolveButtonStyle(button: TestRenderer.ReactTestInstance) {
  const style = (button.props as any).style;
  const resolved =
    typeof style === "function" ? style({ focused: false, pressed: false }) : style;
  return StyleSheet.flatten(resolved) as Record<string, unknown>;
}

function visibleTitles(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .map((t) => t.props.children)
    .filter((c) => typeof c === "string");
}

describe("HomeScreen 筛选接线（组件级）", () => {
  const getAggMock = api.getAggCategory as jest.Mock;
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    getAggMock.mockImplementation((_t: number, _pg: number, filters?: any) => {
      if (filters?.area === "香港") return Promise.resolve(HK_ONLY);
      return Promise.resolve(UNFILTERED);
    });
  });

  afterEach(() => {
    renderer?.unmount();
  });

  it("点电影分类 → 点地区=香港：agg 请求带 area，网格变成香港片，选中态看得见", async () => {
    await act(async () => {
      renderer = TestRenderer.create(<HomeScreen />);
    });
    const root = renderer.root;

    // 点“电影”分类
    expect(pressButtonByLabel(root, "电影")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("未筛影片A"));
    // 筛选行应出现
    expect(visibleTitles(root)).toContain("地区");
    expect(visibleTitles(root)).toContain("香港");

    // 点地区=香港
    expect(pressButtonByLabel(root, "香港")).toBe(true);
    await waitFor(() => visibleTitles(root).includes("香港影片A"));

    const calls = getAggMock.mock.calls;
    expect(calls[calls.length - 1][2]).toEqual({ area: "香港" });
    expect(visibleTitles(root)).toContain("香港影片B");
    expect(visibleTitles(root)).not.toContain("未筛影片A");

    // 选中态必须看得见：选中的“香港”按钮是绿底（primary），
    // 没选中的“全部”是透明底。原来 ghost 变体的选中样式是空对象，
    // 选了哪个在电视上完全看不出来。
    const hkButton = findButtonStyleNode(root, "香港");
    expect(hkButton).toBeDefined();
    expect(resolveButtonStyle(hkButton!).backgroundColor).toBe(Colors.dark.primary);
    const allButton = findButtonStyleNode(root, "全部");
    expect(allButton).toBeDefined();
    expect(resolveButtonStyle(allButton!).backgroundColor).toBe("transparent");
  }, 30000);
});
