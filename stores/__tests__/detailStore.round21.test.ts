// 第 21 轮 detailStore L-1 回归测试：回落/后台分支改用归一化标题比较。
// 第 20 轮只在首选/标准分支用了 normalizeTitleForMatch，回落/后台分支仍是
// 严格 ===：某源标题带尾空格/大小写差异时，回落分支报“未找到”（同一部片
// 走标准分支却能找到），后台分支丢掉该源。
import useDetailStore from "../detailStore";
import { api, type SearchResult } from "@/services/api";

jest.mock("@/services/api", () => ({
  api: {
    searchVideo: jest.fn(),
    searchVideos: jest.fn(),
    getResources: jest.fn(),
  },
  isCancelError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (name === "AbortError") return true;
    if (typeof message === "string" && /abort|cancel/i.test(message)) return true;
    return false;
  },
}));

jest.mock("@/services/m3u8", () => ({
  getResolutionFromM3U8: jest.fn(async () => undefined),
}));

jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ videoSource: { enabledAll: true, sources: {} } }),
  },
}));

jest.mock("@/services/storage", () => ({
  FavoriteManager: { isFavorited: jest.fn(async () => false) },
}));

jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}), { virtual: true });

jest.mock("@/utils/Logger", () => {
  const loggerStub = {
    withTag: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  };
  return { __esModule: true, default: loggerStub, Logger: loggerStub };
});

const mockSearchVideo = api.searchVideo as jest.Mock;
const mockSearchVideos = api.searchVideos as jest.Mock;

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    id: 1,
    title: "庆余年",
    poster: "",
    episodes: ["https://example.com/ep1.m3u8"],
    source: "源A",
    source_name: "源A",
    year: "2019",
    ...overrides,
  };
}

describe("detailStore 第 21 轮 L-1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("回落分支：唯一匹配项标题带尾空格时仍能找到（不报未找到）", async () => {
    mockSearchVideo.mockResolvedValue({ results: [] });
    mockSearchVideos.mockResolvedValue({
      results: [result({ id: 7, title: "庆余年 ", source: "源B", source_name: "源B" })],
    });

    await useDetailStore.getState().init("庆余年", "源A", "1");

    const { searchResults, error } = useDetailStore.getState();
    // 旧代码：严格 === 排除带尾空格的标题，filteredResults 为空，报“未找到”。
    expect(error).toBeNull();
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].source).toBe("源B");
  });

  it("后台分支：其他源标题带尾空格时仍合并进源列表", async () => {
    mockSearchVideo.mockResolvedValue({
      results: [result({ id: 1, title: "庆余年", source: "源A", source_name: "源A" })],
    });
    mockSearchVideos.mockResolvedValue({
      results: [result({ id: 7, title: "庆余年 ", source: "源B", source_name: "源B" })],
    });

    await useDetailStore.getState().init("庆余年", "源A", "1");

    const { searchResults } = useDetailStore.getState();
    // 旧代码：后台分支严格 === 排除带尾空格的源B，列表只有源A。
    expect(searchResults).toHaveLength(2);
    expect(searchResults.map((r) => r.source).sort()).toEqual(["源A", "源B"]);
  });
});
