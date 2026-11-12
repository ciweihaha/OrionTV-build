// 第 6 轮 stores 修复的回归测试：B2 登录检查不拖内容加载、B6 切分类复位
// loadingMore、B12 播放进度 clamp。
import useHomeStore from "../homeStore";
import { api } from "@/services/api";
import { PlayRecordManager } from "@/services/storage";

jest.mock("@/services/api", () => ({
  api: {
    getAggCategory: jest.fn(),
    getDoubanData: jest.fn(),
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
  parseRecordKey: (key: string) => {
    const sep = key.lastIndexOf("+");
    return sep >= 0
      ? { source: key.slice(0, sep), id: key.slice(sep + 1) }
      : { source: key, id: "" };
  },
}));

const mockCheckLoginStatus = jest.fn() as jest.Mock;
let mockIsLoggedIn = false;
jest.mock("../authStore", () => ({
  __esModule: true,
  default: {
    getState: () => ({
      get isLoggedIn() {
        return mockIsLoggedIn;
      },
      checkLoginStatus: mockCheckLoginStatus,
    }),
  },
}));

jest.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ apiBaseUrl: "https://example.com" }),
  },
}));

const getAggCategoryMock = api.getAggCategory as jest.Mock;
const getAllMock = PlayRecordManager.getAll as jest.Mock;

function aggResponse(items: { id: string; name: string }[]) {
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
      vod_area: "美国",
      vod_douban_score: "",
      type_name: "电影",
    })),
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("homeStore 第 6 轮", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLoggedIn = false;
    mockCheckLoginStatus.mockImplementation(async () => undefined);
    getAllMock.mockResolvedValue({});
    useHomeStore.setState({
      selectedCategory: useHomeStore.getState().categories[0],
      contentData: [],
      loading: true,
      loadingMore: false,
      pageStart: 0,
      aggPage: 0,
      hasMore: true,
      error: null,
    });
  });

  it("B2：CMS 分类加载不等登录检查（登录检查慢 500ms 时内容仍立即加载）", async () => {
    // 登录检查故意慢 500ms（模拟服务器不可达时的重试）
    mockCheckLoginStatus.mockImplementation(
      () => new Promise<void>((r) => setTimeout(r, 500))
    );
    getAggCategoryMock.mockResolvedValue(
      aggResponse([{ id: "1", name: "影片A" }])
    );

    // 切到动漫（CMS 分类）
    const anime = useHomeStore
      .getState()
      .categories.find((c) => c.title === "动漫")!;
    useHomeStore.getState().selectCategory(anime);

    const start = Date.now();
    await waitFor(() => useHomeStore.getState().contentData.length === 1);
    const elapsed = Date.now() - start;
    // 旧代码串行等 500ms 登录检查；新代码不等待，内容应在 300ms 内出现
    expect(elapsed).toBeLessThan(300);
    expect(useHomeStore.getState().contentData[0].title).toBe("影片A");
    // 登录检查仍被触发了（只是不阻塞）
    expect(mockCheckLoginStatus).toHaveBeenCalled();
  }, 10000);

  it("B6：切分类时 loadingMore 复位（旧分类的翻页还在飞）", async () => {
    // 模拟旧分类的 loadMore 还在飞
    useHomeStore.setState({ loadingMore: true });
    const anime = useHomeStore
      .getState()
      .categories.find((c) => c.title === "动漫")!;
    // 切分类的首置 set 是同步的，立即断言
    useHomeStore.getState().selectCategory(anime);
    expect(useHomeStore.getState().loadingMore).toBe(false);
  });

  it("B12：play_time 超过 total_time 时 progress 钳制为 1，不溢出", async () => {
    mockIsLoggedIn = true;
    getAllMock.mockResolvedValue({
      "agg+vid1": {
        play_time: 9999,
        total_time: 100,
        cover: "",
        source_name: "agg",
        index: 0,
        total_episodes: 1,
        save_time: 1000,
      },
    });
    // beforeEach 已选最近播放（record），直接调 fetchInitialData 加载
    await useHomeStore.getState().fetchInitialData();
    await waitFor(() => useHomeStore.getState().contentData.length === 1);
    expect(useHomeStore.getState().contentData[0].progress).toBe(1);
  });
});
