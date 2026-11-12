// 第 20 轮 detailStore M1 回归测试：首选源/标准分支的搜索结果过滤 + 按源去重。
// searchVideo 只做子串匹配：搜“庆余年”会带回“庆余年第二季”，不过滤就原样
// 写入，详情页会出现同源两条结果（重复 key、episodesSelectorBySource 的 .find
// 只按源、永远取第一条，播错片）。
import useDetailStore from "../detailStore";
import { api, type SearchResult, type ApiSite } from "@/services/api";

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
const mockGetResources = api.getResources as jest.Mock;

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

function site(key: string, name: string): ApiSite {
  return { key, api: `https://example.com/${key}`, name };
}

describe("detailStore 第 20 轮 M1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchVideos.mockResolvedValue({ results: [] });
  });

  it("首选源分支：按 id 精确命中，只留 id 对应的那部影片", async () => {
    mockSearchVideo.mockResolvedValue({
      results: [
        result({ id: 1, title: "庆余年" }),
        result({ id: 2, title: "庆余年第二季" }),
      ],
    });
    await useDetailStore.getState().init("庆余年", "源A", "1");
    const { searchResults, detail } = useDetailStore.getState();
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].id).toBe(1);
    expect(searchResults[0].title).toBe("庆余年");
    expect(detail?.id).toBe(1);
  });

  it("首选源分支：id 对不上时退到精确标题（续集被排除，顺序无关）", async () => {
    mockSearchVideo.mockResolvedValue({
      results: [
        result({ id: 2, title: "庆余年第二季" }),
        result({ id: 3, title: "庆余年" }),
      ],
    });
    await useDetailStore.getState().init("庆余年", "源A", "999");
    const { searchResults } = useDetailStore.getState();
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].id).toBe(3);
    expect(searchResults[0].title).toBe("庆余年");
  });

  it("首选源分支：id 与标题都对不上时不丢源，但同源去重只留第一条", async () => {
    mockSearchVideo.mockResolvedValue({
      results: [
        result({ id: 2, title: "庆余年第二季" }),
        result({ id: 3, title: "庆余年第三季" }),
      ],
    });
    await useDetailStore.getState().init("庆余年", "源A", "999");
    const { searchResults } = useDetailStore.getState();
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].title).toBe("庆余年第二季");
  });

  it("标准分支：只留精确标题匹配，无精确匹配的源不贡献结果", async () => {
    mockGetResources.mockResolvedValue([site("源A", "源A"), site("源B", "源B")]);
    mockSearchVideo.mockImplementation(async (_q: string, key: string) => {
      if (key === "源A") {
        return {
          results: [
            result({ id: 1, title: "庆余年", source: "源A", source_name: "源A" }),
            result({ id: 2, title: "庆余年第二季", source: "源A", source_name: "源A" }),
          ],
        };
      }
      return {
        results: [result({ id: 5, title: "庆余年第二季", source: "源B", source_name: "源B" })],
      };
    });
    await useDetailStore.getState().init("庆余年");
    const { searchResults, error } = useDetailStore.getState();
    expect(error).toBeNull();
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].source).toBe("源A");
    expect(searchResults[0].title).toBe("庆余年");
  });

  it("标准分支合并路径：同一源两条精确标题重复结果去重只留一条", async () => {
    mockGetResources.mockResolvedValue([site("源A", "源A")]);
    mockSearchVideo.mockResolvedValue({
      results: [
        result({ id: 1, title: "庆余年" }),
        result({ id: 1, title: "庆余年" }),
      ],
    });
    await useDetailStore.getState().init("庆余年");
    const { searchResults } = useDetailStore.getState();
    expect(searchResults).toHaveLength(1);
  });
});
