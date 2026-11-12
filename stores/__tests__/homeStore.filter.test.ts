// 复现：用户报筛选不管用——不管怎么筛都是同样的页面。
// 模拟电视上的真实操作：进电影分类（CMS）→ 点地区=香港 → 点年代=2024，
// 验证每次 agg 请求都带对参数、列表内容随之变化。

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
      isLoggedIn: true,
      checkLoginStatus: jest.fn(async () => undefined),
    }),
  },
}));

jest.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ apiBaseUrl: "https://example.com" }),
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
const HK_2024 = aggResponse([
  { id: "hy1", name: "香港2024影片", area: "香港", year: "2024" },
]);
// 窄筛选组合首屏 0 条（2026-11-12 实测：area=英国&year=2020 返回空列表）。
const EMPTY = aggResponse([]);
// 豆瓣回落返回的内容：无筛选时 agg 空列表应回落到它。
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

describe("homeStore 筛选流程复现（用户报：怎么筛都是同样的页面）", () => {
  let useHomeStore: any;
  let getAggMock: jest.Mock;
  let getDoubanMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // 每次用全新模块实例：homeStore 的 dataCache 是模块级变量，必须刷新才隔离。
    // resetModules 后 mock 也要重新拿，否则拿到的是旧注册表的实例。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const freshApi = require("@/services/api").api;
    getAggMock = freshApi.getAggCategory as jest.Mock;
    getDoubanMock = freshApi.getDoubanData as jest.Mock;
    getDoubanMock.mockResolvedValue(DOUBAN_FALLBACK);
    getAggMock.mockImplementation((_t: number, _pg: number, filters?: any) => {
      if (filters?.area === "香港" && filters?.year === "2024") return Promise.resolve(HK_2024);
      if (filters?.area === "香港") return Promise.resolve(HK_ONLY);
      if (filters?.year === "2024") return Promise.resolve(YEAR_2024);
      if (filters?.area === "英国") return Promise.resolve(EMPTY);
      return Promise.resolve(UNFILTERED);
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    useHomeStore = require("../homeStore").default;
  });

  it("进电影分类先加载未筛列表，点地区=香港后请求带 area、列表变成香港片", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    // 点地区=香港
    useHomeStore.getState().setRegionFilter("香港");
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["香港影片A", "香港影片B"]),
    );

    const calls = getAggMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toEqual({ area: "香港" });
  });

  it("地区=香港后再点年代=2024，请求同时带 area 和 year", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    useHomeStore.getState().setRegionFilter("香港");
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["香港影片A", "香港影片B"]),
    );
    useHomeStore.getState().setYearFilter("2024");
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["香港2024影片"]),
    );

    const calls = getAggMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toEqual({ area: "香港", year: "2024" });
  });

  it("点回地区=全部后，列表回到未筛内容（命中首屏缓存，不再发请求）", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    useHomeStore.getState().setRegionFilter("香港");
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["香港影片A", "香港影片B"]),
    );
    const callsAfterHK = getAggMock.mock.calls.length;
    useHomeStore.getState().setRegionFilter(null);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    // 全部对应首屏缓存键，命中缓存不再发 agg 请求
    expect(getAggMock.mock.calls.length).toBe(callsAfterHK);
  });

  it("点筛选触发重载时，筛选行不卸载（cmsFilterAvailable 保持 true，直到新数据回来）", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);

    // 把 agg 请求挂住，模拟网络在飞：此时加载中，但筛选行必须还在。
    let resolveAgg: (v: any) => void = () => undefined;
    getAggMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAgg = resolve; }),
    );
    useHomeStore.getState().setRegionFilter("香港");
    await waitFor(() => useHomeStore.getState().loading === true);
    // 加载中：筛选行没被卸掉，电视焦点还留在刚点的选项上。
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);

    resolveAgg(HK_ONLY);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["香港影片A", "香港影片B"]),
    );
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);
  });

  it("切分类时筛选行仍会先隐藏（只有筛选触发的重载才保留）", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);

    // 切到电视剧：把 agg 请求挂住，加载中时筛选行应已隐藏。
    let resolveAgg: (v: any) => void = () => undefined;
    getAggMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAgg = resolve; }),
    );
    const tv = store.categories.find((c: any) => c.title === "电视剧");
    useHomeStore.getState().selectCategory(tv);
    await waitFor(() => useHomeStore.getState().loading === true);
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(false);

    resolveAgg(UNFILTERED);
    await waitFor(() => useHomeStore.getState().loading === false);
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);
  });

  it("筛选后 agg 首屏返回空列表：不回落豆瓣，显示空列表、筛选行保留", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    // 点地区=英国：服务端该筛选首屏 0 条（实测窄组合行为），是合法结果。
    const callsBefore = getAggMock.mock.calls.length;
    useHomeStore.getState().setRegionFilter("英国");
    await waitFor(() => getAggMock.mock.calls.length > callsBefore);
    await waitFor(() => useHomeStore.getState().loading === false);

    const state = useHomeStore.getState();
    expect(state.contentData).toEqual([]);
    expect(state.hasMore).toBe(false);
    expect(state.error).toBeNull();
    // 筛选行还在，用户可直接改筛选；没有回落豆瓣。
    expect(state.cmsFilterAvailable).toBe(true);
    expect(getDoubanMock).not.toHaveBeenCalled();
  });

  it("筛选后 agg 请求失败：不回落豆瓣，显示错误、筛选行保留", async () => {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    getAggMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Network request failed")),
    );
    const callsBefore = getAggMock.mock.calls.length;
    useHomeStore.getState().setRegionFilter("香港");
    await waitFor(() => getAggMock.mock.calls.length > callsBefore);
    await waitFor(() => useHomeStore.getState().loading === false);

    const state = useHomeStore.getState();
    expect(state.error).toBe("网络连接失败，请检查网络连接");
    expect(state.cmsFilterAvailable).toBe(true);
    expect(getDoubanMock).not.toHaveBeenCalled();
  });

  it("无筛选时 agg 首屏空列表：仍回落豆瓣（回归，现有行为不变）", async () => {
    // 首次进分类即空列表：无筛选，空列表仍按异常处理，走豆瓣回落。
    getAggMock.mockImplementationOnce(() => Promise.resolve(EMPTY));
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["豆瓣影片A"]),
    );

    const state = useHomeStore.getState();
    expect(state.cmsFilterAvailable).toBe(false);
    expect(getDoubanMock).toHaveBeenCalled();
  });
});
