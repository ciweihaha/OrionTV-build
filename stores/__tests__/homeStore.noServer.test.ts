// 复现：1.2.0 测试版“根本连不上网”。
// 根因：新装应用未配服务器（apiBaseUrl 为空）时，CMS 的豆瓣回落
// （走用户服务器的 /api/douban）必抛 API_URL_NOT_SET，把真正的 agg
// 网络错误掩盖成“请配置服务器地址”；agg 空列表时同样回落失败。
// 修复后：无服务器时不回落，agg 失败抛原错，空列表显示空态。
// 同时验证：无服务器时 agg 成功仍能正常出内容（CMS 不依赖用户服务器）。

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
}));

jest.mock("../authStore", () => ({
  __esModule: true,
  default: {
    getState: () => ({
      isLoggedIn: false,
      checkLoginStatus: jest.fn(async () => undefined),
    }),
  },
}));

// 关键：未配服务器（新装应用卸载 1.6.8 后重装的状态）。
jest.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ apiBaseUrl: "" }),
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
const EMPTY = aggResponse([]);
const DOUBAN_FALLBACK = {
  list: [{ title: "豆瓣影片A", cover: "", rate: "", year: "" }],
};

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("homeStore 无服务器场景（1.2.0 连不上网复现）", () => {
  let useHomeStore: any;
  let getAggMock: jest.Mock;
  let getDoubanMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const freshApi = require("@/services/api").api;
    getAggMock = freshApi.getAggCategory as jest.Mock;
    getDoubanMock = freshApi.getDoubanData as jest.Mock;
    getDoubanMock.mockResolvedValue(DOUBAN_FALLBACK);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    useHomeStore = require("../homeStore").default;
  });

  function selectMovie() {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
  }

  it("无服务器时 agg 成功：电影列表正常加载（CMS 不依赖用户服务器）", async () => {
    getAggMock.mockResolvedValue(UNFILTERED);
    selectMovie();
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );
    expect(useHomeStore.getState().error).toBeNull();
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);
    expect(getDoubanMock).not.toHaveBeenCalled();
  });

  it("无服务器时 agg 网络失败：不回落豆瓣，错误是真实网络错误而非“请配置服务器地址”", async () => {
    getAggMock.mockRejectedValue(new Error("Network request failed"));
    selectMovie();
    await waitFor(() => useHomeStore.getState().error !== null);
    expect(getDoubanMock).not.toHaveBeenCalled();
    expect(useHomeStore.getState().error).toBe("网络连接失败，请检查网络连接");
    expect(useHomeStore.getState().error).not.toContain("配置您的服务器地址");
  });

  it("无服务器时 agg 首屏空列表：不回落豆瓣，直接显示空态且无错误", async () => {
    getAggMock.mockResolvedValue(EMPTY);
    selectMovie();
    await waitFor(
      () => !useHomeStore.getState().loading && useHomeStore.getState().aggPage === 1,
    );
    expect(getDoubanMock).not.toHaveBeenCalled();
    expect(useHomeStore.getState().contentData).toEqual([]);
    expect(useHomeStore.getState().hasMore).toBe(false);
    expect(useHomeStore.getState().error).toBeNull();
  });
});
