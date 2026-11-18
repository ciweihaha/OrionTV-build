// 回归：v1.7.7 retryLoad 硬重载必须绕过缓存。
// 场景：同一分类已有有效缓存时重试——fetchInitialData 的缓存命中
// 分支会直接返回旧数据而不发请求；错误屏上的重试必须发新请求，
// 哪怕缓存还有效（缓存里的数据可能是旧的、也可能与当前错误无关）。

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

jest.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ apiBaseUrl: "" }),
  },
}));

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
      vod_area: "日本",
      vod_douban_score: "",
      type_name: "电影",
    })),
  };
}

const MOVIE = aggResponse([
  { id: "m1", name: "电影影片A" },
  { id: "m2", name: "电影影片B" },
]);

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("homeStore retryLoad（v1.7.7）", () => {
  let useHomeStore: any;
  let getAggMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const freshApi = require("@/services/api").api;
    getAggMock = freshApi.getAggCategory as jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    useHomeStore = require("../homeStore").default;
  });

  function selectMovie() {
    const store = useHomeStore.getState();
    const movie = store.categories.find((c: any) => c.title === "电影");
    store.selectCategory(movie);
  }

  it("已有有效缓存时重试：不走缓存，一定重新发起 agg 请求", async () => {
    // 先成功加载一次，缓存写好
    getAggMock.mockResolvedValue(MOVIE);
    selectMovie();
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["电影影片A", "电影影片B"]),
    );
    expect(useHomeStore.getState().error).toBeNull();
    const callsAfterFirstLoad = getAggMock.mock.calls.length;

    // 服务端挂了：重试必须发请求（而不是命中缓存直接返回旧数据）
    getAggMock.mockRejectedValue(new Error("Network request failed"));
    await useHomeStore.getState().retryLoad();
    await waitFor(() => useHomeStore.getState().error !== null);

    expect(getAggMock.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad);
    expect(useHomeStore.getState().error).toBe("网络连接失败，请检查网络连接");
    // 原始错误值一并记下来，供错误屏显示
    expect(useHomeStore.getState().errorDetail).toBe("Network request failed");
  });

  it("重试后服务端恢复：内容重新加载出来，错误清掉", async () => {
    getAggMock.mockRejectedValue(new Error("Network request failed"));
    selectMovie();
    await waitFor(() => useHomeStore.getState().error !== null);
    const callsBeforeRetry = getAggMock.mock.calls.length;

    getAggMock.mockResolvedValue(MOVIE);
    await useHomeStore.getState().retryLoad();
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["电影影片A", "电影影片B"]),
    );

    expect(getAggMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(useHomeStore.getState().error).toBeNull();
    expect(useHomeStore.getState().errorDetail).toBeNull();
  });

  it("服务端 filters 是字典对象时：内容仍加载出来，不报 TypeError（v1.7.8 真机复现）", async () => {
    // 线上 filters 是 {"1": [...]} 对象，不是数组。旧代码原样传给
    // filterServerReliableGroups，.filter 在对象上抛
    // TypeError: undefined is not a function，首页永远加载失败。
    // 这里 mock 直接给字典（绕过 api.ts 的归一化），验证 store 层的
    // 防御：非数组直接当空组，列表照常出来。
    const dictResponse = {
      ...MOVIE,
      filters: {
        "1": [{ key: "area", name: "地区", value: [{ n: "全部", v: "" }] }],
      },
    };
    getAggMock.mockResolvedValue(dictResponse);
    selectMovie();
    await waitFor(
      () =>
        JSON.stringify(useHomeStore.getState().contentData.map((i: any) => i.title)) ===
        JSON.stringify(["电影影片A", "电影影片B"]),
    );

    expect(useHomeStore.getState().error).toBeNull();
    expect(useHomeStore.getState().errorDetail).toBeNull();
    expect(useHomeStore.getState().aggFilterGroups).toEqual([]);
  });
});
