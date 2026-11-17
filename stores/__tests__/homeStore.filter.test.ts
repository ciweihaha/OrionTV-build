// 复现：用户报筛选不管用——不管怎么筛都是同样的页面。
// 模拟电视上的真实操作：进电影分类（CMS）→ 点地区=香港 → 点年代=2024，
// 验证每次 agg 请求都带对参数、列表内容随之变化。
// 2026-11-18：筛选全部以服务端为准，只提供服务端可靠的 4 组
// （地区/年代/语言/排序）；cate（类型）/score（评分）服务端处理不可靠，
// 不作为筛选选项提供、不拼参数、不做客户端过滤——服务端有的就筛，没有就算了。
// 面板按服务端下发的 filters 渲染，但只留可靠的 4 组。

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
const HK_2024 = aggResponse([
  { id: "hy1", name: "香港2024影片", area: "香港", year: "2024", vodClass: "动作", score: "8.1" },
]);
const JP_ONLY = aggResponse([
  { id: "j1", name: "日语影片A", area: "日本", year: "2023", vodClass: "剧情", score: "7.9" },
]);
// 排序=最新：同一批片换了顺序（服务端按时间重排）。
const LATEST = aggResponse([
  { id: "u2", name: "未筛影片B", area: "中国大陆", year: "2025", vodClass: "剧情,爱情", score: "7.2" },
  { id: "u1", name: "未筛影片A", area: "美国", year: "2026", vodClass: "科幻,动作", score: "8.5" },
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

  function titles(): string[] {
    return useHomeStore.getState().contentData.map((i: any) => i.title);
  }

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
      if (filters?.lang === "日语") return Promise.resolve(JP_ONLY);
      if (filters?.order === "最新") return Promise.resolve(LATEST);
      return Promise.resolve(UNFILTERED);
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    useHomeStore = require("../homeStore").default;
  });

  async function enterMovie() {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["未筛影片A", "未筛影片B"]),
    );
  }

  it("进电影分类先加载未筛列表，点地区=香港后请求带 area、列表变成香港片", async () => {
    await enterMovie();

    // 点地区=香港
    useHomeStore.getState().setAggFilter("area", "香港");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港影片A", "香港影片B"]),
    );

    const calls = getAggMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toEqual({ area: "香港", year: "", lang: "", order: "" });
  });

  it("地区=香港后再点年代=2024，请求同时带 area 和 year", async () => {
    await enterMovie();

    useHomeStore.getState().setAggFilter("area", "香港");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港影片A", "香港影片B"]),
    );
    useHomeStore.getState().setAggFilter("year", "2024");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港2024影片"]),
    );

    const calls = getAggMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toEqual({ area: "香港", year: "2024", lang: "", order: "" });
  });

  it("点回地区=全部后，列表回到未筛内容（命中首屏缓存，不再发请求）", async () => {
    await enterMovie();

    useHomeStore.getState().setAggFilter("area", "香港");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港影片A", "香港影片B"]),
    );
    const callsAfterHK = getAggMock.mock.calls.length;
    useHomeStore.getState().setAggFilter("area", "");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["未筛影片A", "未筛影片B"]),
    );

    // 全部对应首屏缓存键，命中缓存不再发 agg 请求
    expect(getAggMock.mock.calls.length).toBe(callsAfterHK);
  });

  it("点筛选触发重载时，筛选面板不卸载（cmsFilterAvailable 保持 true，直到新数据回来）", async () => {
    await enterMovie();
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);

    // 把 agg 请求挂住，模拟网络在飞：此时加载中，但筛选面板必须还在。
    let resolveAgg: (v: any) => void = () => undefined;
    getAggMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAgg = resolve; }),
    );
    useHomeStore.getState().setAggFilter("area", "香港");
    await waitFor(() => useHomeStore.getState().loading === true);
    // 加载中：筛选面板没被卸掉，电视焦点还留在刚点的选项上。
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);

    resolveAgg(HK_ONLY);
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港影片A", "香港影片B"]),
    );
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);
  });

  it("切分类时筛选面板仍会先隐藏（只有筛选触发的重载才保留）", async () => {
    await enterMovie();
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);

    // 切到电视剧：把 agg 请求挂住，加载中时筛选面板应已隐藏。
    let resolveAgg: (v: any) => void = () => undefined;
    getAggMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAgg = resolve; }),
    );
    const store = useHomeStore.getState();
    const tv = store.categories.find((c: any) => c.title === "电视剧");
    useHomeStore.getState().selectCategory(tv);
    await waitFor(() => useHomeStore.getState().loading === true);
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(false);

    resolveAgg(UNFILTERED);
    await waitFor(() => useHomeStore.getState().loading === false);
    expect(useHomeStore.getState().cmsFilterAvailable).toBe(true);
  });

  it("筛选后 agg 首屏返回空列表：不回落豆瓣，显示空列表、筛选面板保留", async () => {
    await enterMovie();

    // 点地区=英国：服务端该筛选首屏 0 条（实测窄组合行为），是合法结果。
    const callsBefore = getAggMock.mock.calls.length;
    useHomeStore.getState().setAggFilter("area", "英国");
    await waitFor(() => getAggMock.mock.calls.length > callsBefore);
    await waitFor(() => useHomeStore.getState().loading === false);

    const state = useHomeStore.getState();
    expect(state.contentData).toEqual([]);
    expect(state.hasMore).toBe(false);
    expect(state.error).toBeNull();
    // 筛选面板还在，用户可直接改筛选；没有回落豆瓣。
    expect(state.cmsFilterAvailable).toBe(true);
    expect(getDoubanMock).not.toHaveBeenCalled();
  });

  it("筛选后 agg 请求失败：不回落豆瓣，显示错误、筛选面板保留", async () => {
    await enterMovie();

    getAggMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Network request failed")),
    );
    const callsBefore = getAggMock.mock.calls.length;
    useHomeStore.getState().setAggFilter("area", "香港");
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
      () => JSON.stringify(titles()) === JSON.stringify(["豆瓣影片A"]),
    );

    const state = useHomeStore.getState();
    expect(state.cmsFilterAvailable).toBe(false);
    expect(getDoubanMock).toHaveBeenCalled();
  });

  it("点语言=日语：请求带 lang 参数、列表变成日语片", async () => {
    await enterMovie();

    useHomeStore.getState().setAggFilter("lang", "日语");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["日语影片A"]),
    );

    const calls = getAggMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toEqual({ area: "", year: "", lang: "日语", order: "" });
  });

  it("点排序=最新：请求带 order 参数、列表顺序随之变化", async () => {
    await enterMovie();

    useHomeStore.getState().setAggFilter("order", "最新");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["未筛影片B", "未筛影片A"]),
    );

    const calls = getAggMock.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toEqual({ area: "", year: "", lang: "", order: "最新" });
  });

  it("加载成功后服务端下发的筛选组存入 aggFilterGroups（面板按它渲染）", async () => {
    await enterMovie();

    const groups = useHomeStore.getState().aggFilterGroups;
    // 服务端下发 6 组，store 只存服务端可靠的 4 组。
    expect(groups.map((g: any) => g.key)).toEqual(["area", "year", "lang", "order"]);
    expect(groups.find((g: any) => g.key === "area").name).toBe("地区");
    expect(groups.find((g: any) => g.key === "area").value.map((o: any) => o.n)).toContain("香港");
  });

  it("服务端下发的类型/评分组不进入 aggFilterGroups（面板不出现这两组）", async () => {
    await enterMovie();

    const groups = useHomeStore.getState().aggFilterGroups;
    // mock 服务端明明下发了 cate/score 组（见 MOCK_FILTER_GROUPS），
    // 但面板只应出现服务端可靠的 4 组。
    expect(groups.map((g: any) => g.key)).not.toContain("cate");
    expect(groups.map((g: any) => g.key)).not.toContain("score");
    expect(groups.map((g: any) => g.name)).not.toContain("类型");
    expect(groups.map((g: any) => g.name)).not.toContain("评分");
  });

  it("重置筛选：全部筛选回到空，列表回到未筛内容", async () => {
    await enterMovie();

    useHomeStore.getState().setAggFilter("area", "香港");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港影片A", "香港影片B"]),
    );
    useHomeStore.getState().clearAggFilters();
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["未筛影片A", "未筛影片B"]),
    );
    expect(useHomeStore.getState().aggFilters).toEqual({ area: "", year: "", lang: "", order: "" });
  });

  it("筛选面板开关：toggleFilters 翻转、setFiltersVisible 直接设置", async () => {
    await enterMovie();
    const state = useHomeStore.getState();
    expect(state.filtersVisible).toBe(false);

    useHomeStore.getState().toggleFilters();
    expect(useHomeStore.getState().filtersVisible).toBe(true);
    useHomeStore.getState().toggleFilters();
    expect(useHomeStore.getState().filtersVisible).toBe(false);
    useHomeStore.getState().setFiltersVisible(true);
    expect(useHomeStore.getState().filtersVisible).toBe(true);
  });

  it("切分类时筛选全部重置、面板收起", async () => {
    await enterMovie();

    useHomeStore.getState().setAggFilter("area", "香港");
    await waitFor(
      () => JSON.stringify(titles()) === JSON.stringify(["香港影片A", "香港影片B"]),
    );
    useHomeStore.getState().setFiltersVisible(true);
    expect(useHomeStore.getState().filtersVisible).toBe(true);

    const store = useHomeStore.getState();
    const tv = store.categories.find((c: any) => c.title === "电视剧");
    useHomeStore.getState().selectCategory(tv);
    // 切分类立即重置（不等人加载完）。
    expect(useHomeStore.getState().aggFilters).toEqual({ area: "", year: "", lang: "", order: "" });
    expect(useHomeStore.getState().filtersVisible).toBe(false);
  });
});
