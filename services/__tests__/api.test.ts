import { API } from "../api";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("@react-native-async-storage/async-storage", () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
}));

const BASE = "https://example.test";

function makeResponse(status: number, body: any = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: undefined,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function abortError() {
  const err = new Error("The user aborted a request.");
  err.name = "AbortError";
  return err;
}

/** fetch 替身：挂起不返回，直到传入的 signal 中止才以 AbortError 拒绝（模拟真实 fetch 的取消行为） */
function pendingUntilAbort(_url: any, opts: any) {
  return new Promise((_resolve, reject) => {
    const signal: AbortSignal | undefined = opts?.signal;
    if (!signal) return; // 无 signal 时永不返回
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(2);
  }
}

describe("API._fetch 取消与 401 重试语义", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    api.setSessionRestorer(null);
    jest.clearAllMocks();
  });

  it("① 首次请求阶段取消：请求以中止语义结束，且绝不重试", async () => {
    const restorer = jest.fn(async () => true);
    api.setSessionRestorer(restorer);
    fetchMock.mockImplementation(pendingUntilAbort);

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 5000);
    await waitFor(() => fetchMock.mock.calls.length === 1);

    caller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(restorer).not.toHaveBeenCalled();
  });

  it("② 会话恢复等待期间取消：恢复成功也不再发起重试", async () => {
    let resolveRestorer: ((v: boolean) => void) | undefined;
    const restorer = jest.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveRestorer = res;
        })
    );
    api.setSessionRestorer(restorer);
    fetchMock.mockResolvedValue(makeResponse(401));

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 5000);
    await waitFor(() => restorer.mock.calls.length === 1);

    // 恢复尚在等待时用户取消，随后恢复返回成功
    caller.abort();
    resolveRestorer!(true);

    await expect(promise).rejects.toThrow("The user aborted a request.");
    // 关键断言：取消后绝无第二次 fetch 发出
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("③ 重试阶段取消（复用首次 signal）：在途重试被立即中止，且无第三次请求", async () => {
    api.setSessionRestorer(jest.fn(async () => true));
    fetchMock.mockResolvedValueOnce(makeResponse(401)).mockImplementationOnce(pendingUntilAbort);

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 5000);
    await waitFor(() => fetchMock.mock.calls.length === 2);

    caller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retrySignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(retrySignal.aborted).toBe(true);
  });

  it("③b 重试阶段取消（超时后换新 signal）：新信号同样受调用方取消联动", async () => {
    // 恢复等待 60ms > 超时 30ms，重试必然走"换新组合 signal"分支
    api.setSessionRestorer(
      jest.fn(async () => {
        await sleep(60);
        return true;
      })
    );
    fetchMock.mockResolvedValueOnce(makeResponse(401)).mockImplementationOnce(pendingUntilAbort);

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 30);
    await waitFor(() => fetchMock.mock.calls.length === 2);

    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const retrySignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(retrySignal).not.toBe(firstSignal);
    expect(firstSignal.aborted).toBe(true); // 因超时中止
    expect(retrySignal.aborted).toBe(false);

    caller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retrySignal.aborted).toBe(true); // 调用方取消联动到了新信号
  });

  it("④ 超时（非取消）后 401 恢复重试仍可成功，防把正常重试修死", async () => {
    // 恢复等待 60ms > 超时 30ms：首次 signal 被超时中止，但调用方从未取消
    api.setSessionRestorer(
      jest.fn(async () => {
        await sleep(60);
        return true;
      })
    );
    fetchMock
      .mockResolvedValueOnce(makeResponse(401))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const caller = new AbortController();
    const response = await (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 30);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const retrySignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true); // 超时导致
    expect(retrySignal).not.toBe(firstSignal); // 重试换了新信号
    expect(retrySignal.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
  });

  it("④b 401 且恢复失败：抛 UNAUTHORIZED，不重试", async () => {
    api.setSessionRestorer(jest.fn(async () => false));
    fetchMock.mockResolvedValue(makeResponse(401));

    await expect((api as any)._fetch("/api/search?q=x", {}, 5000)).rejects.toThrow("UNAUTHORIZED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("④c OTV-4 超时（无调用方取消）仍走 REQUEST_TIMEOUT", async () => {
    // pendingUntilAbort 监听 _fetch 组合的超时信号：超时中止后 fetch 以 AbortError
    // 拒绝，调用方未取消时 _fetch 将其转为 REQUEST_TIMEOUT，与调用方取消区分。
    fetchMock.mockImplementation(pendingUntilAbort);
    const promise = (api as any)._fetch("/api/search?q=x", {}, 30);
    await expect(promise).rejects.toThrow(/^REQUEST_TIMEOUT/);
  });
});

describe("API.searchVideos 取消", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("调用方取消时以 AbortError 拒绝，不走超时分支", async () => {
    fetchMock.mockImplementation(pendingUntilAbort);
    const caller = new AbortController();
    const promise = api.searchVideos("test", caller.signal);
    await waitFor(() => fetchMock.mock.calls.length === 1);
    caller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("不传 signal 时正常返回结果", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { results: [{ id: "1", title: "t" }] }));
    const res = await api.searchVideos("test");
    expect(res.results).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/search?q=test");
  });
});

describe("API.searchVideo 缺 results 字段（第 44 轮）", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("服务端返回不含 results 的对象时返回空结果，不抛 TypeError", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { error: "no results" }));
    const res = await api.searchVideo("蜘蛛侠", "res1");
    expect(res).toEqual({ results: [] });
  });

  it("results 为非数组时同样返回空结果", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { results: "oops" }));
    const res = await api.searchVideo("蜘蛛侠", "res1");
    expect(res).toEqual({ results: [] });
  });
});

describe("API URL 参数编码", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn(async () => makeResponse(200, { success: true }));
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("⑤ deleteSearchHistory 对含 &、#、空格、中文的 keyword 正确编码", async () => {
    const keyword = "a&b#c 中文 x";
    await api.deleteSearchHistory(keyword);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/searchhistory?keyword=${encodeURIComponent(keyword)}`
    );
    // 裸拼会把 & 变成第二个参数、# 变成片段，这里确保两者都已被转义
    expect(fetchMock.mock.calls[0][0]).toContain("keyword=a%26b%23c%20");
  });

  it("⑤ getVideoDetail 对含 &、#、空格、中文的 source/id 正确编码", async () => {
    const source = "src&1";
    const id = "id #2 中文";
    await api.getVideoDetail(source, id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`
    );
    expect(fetchMock.mock.calls[0][0]).toContain("source=src%261");
    expect(fetchMock.mock.calls[0][0]).toContain("id=id%20%232%20");
  });
});

describe("API.getAggCategory 重试语义（第 29 轮）", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("4xx 不重试：一次 404 直接抛错，不多发请求、不多等退避", async () => {
    fetchMock.mockResolvedValue(makeResponse(404, { code: 0, list: [] }));
    await expect(api.getAggCategory(1, 1)).rejects.toThrow("HTTP error! status: 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx 重试：两次 500 后 200 成功，共发 3 次请求", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(500, {}))
      .mockResolvedValueOnce(makeResponse(500, {}))
      .mockResolvedValueOnce(makeResponse(200, { code: 1, list: [{ id: "1" }] }));
    const res = await api.getAggCategory(1, 1);
    expect(res.code).toBe(1);
    expect(res.list).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10000);
});

describe("API.logout 登录标记清理（第 30 轮）", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("远程登出失败（断网）也清掉 authCookies 标记，不留着下次自动登录", async () => {
    fetchMock.mockRejectedValue(new Error("Network request failed"));
    await expect(api.logout()).rejects.toThrow("Network request failed");
    expect(AsyncStorage.setItem).toHaveBeenCalledWith("authCookies", "");
  });

  it("远程登出成功时清标记并返回结果", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { ok: true }));
    const res = await api.logout();
    expect(res.ok).toBe(true);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith("authCookies", "");
  });
});

describe("API.getAggCategory 地区 / 年代筛选", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const aggOk = () => makeResponse(200, { code: 1, list: [{ vod_id: "1" }] });

  it("不传 filters 时 URL 与原来一致，不含 area/year 参数", async () => {
    fetchMock.mockResolvedValue(aggOk());
    await api.getAggCategory(1, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://ysp.ciweihaha.win/agg?ac=videolist&t=1&pg=1");
  });

  it("传 area 时 URL 带编码后的 area 参数", async () => {
    fetchMock.mockResolvedValue(aggOk());
    await api.getAggCategory(1, 1, { area: "中国大陆" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`area=${encodeURIComponent("中国大陆")}`);
    expect(url).not.toContain("year=");
  });

  it("传 year 时 URL 带 year 参数", async () => {
    fetchMock.mockResolvedValue(aggOk());
    await api.getAggCategory(2, 3, { year: "2024" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("t=2&pg=3&year=2024");
    expect(url).not.toContain("area=");
  });

  it("area 与 year 组合时两个参数都有", async () => {
    fetchMock.mockResolvedValue(aggOk());
    await api.getAggCategory(1, 1, { area: "美国", year: "2024" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`area=${encodeURIComponent("美国")}`);
    expect(url).toContain("year=2024");
  });

  it("filters 为空对象时与不传一致", async () => {
    fetchMock.mockResolvedValue(aggOk());
    await api.getAggCategory(1, 1, {});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://ysp.ciweihaha.win/agg?ac=videolist&t=1&pg=1");
  });
});
