import useAuthStore from "../authStore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "@/services/api";
import { LoginCredentialsManager } from "@/services/storage";

jest.mock("@/services/api", () => ({
  api: {
    logout: jest.fn(),
    login: jest.fn(),
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
  LoginCredentialsManager: {
    get: jest.fn(async () => null),
    clear: jest.fn(async () => undefined),
  },
}));

jest.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      serverConfig: null,
      isLoadingServerConfig: false,
      fetchServerConfig: jest.fn(async () => undefined),
    }),
  },
  getServerConfigPromise: jest.fn(() => null),
}));

jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}), { virtual: true });

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

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

const apiLoginMock = api.login as jest.Mock;
const apiLogoutMock = api.logout as jest.Mock;
const credsGetMock = LoginCredentialsManager.get as jest.Mock;
const asyncRemoveMock = AsyncStorage.removeItem as jest.Mock;

describe("authStore.restoreSession（401 自动恢复的登录端）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ isLoggedIn: false, isLoginModalVisible: false });
  });

  it("无保存凭据：不调登录接口，直接弹登录框", async () => {
    credsGetMock.mockResolvedValue(null);

    await useAuthStore.getState().restoreSession();

    expect(apiLoginMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("有凭据且自动登录成功：用保存的用户名/密码登录，状态为已登录且不弹框", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockResolvedValue({ ok: true });

    await useAuthStore.getState().restoreSession();

    expect(apiLoginMock).toHaveBeenCalledWith("u", "p");
    expect(apiLoginMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });

  it("自动登录返回非 ok：视为失败，清除会话标记并弹登录框", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockResolvedValue({ ok: false });

    await useAuthStore.getState().restoreSession();

    expect(asyncRemoveMock).toHaveBeenCalledWith("authCookies");
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("自动登录抛错：不向外抛，清除会话标记并弹登录框（401 链路不因恢复失败而二次炸开）", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockRejectedValue(new Error("Network request failed"));

    await expect(useAuthStore.getState().restoreSession()).resolves.toBeUndefined();

    expect(asyncRemoveMock).toHaveBeenCalledWith("authCookies");
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("并发去重：两次同时触发只登录一次（多个 401 并发时不重复重登）", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    let release!: () => void;
    apiLoginMock.mockImplementation(
      () =>
        new Promise((res) => {
          release = () => res({ ok: true });
        })
    );

    const p1 = useAuthStore.getState().restoreSession();
    const p2 = useAuthStore.getState().restoreSession();
    // restoreSession 先 await 取凭据，登录是异步触发的：必须先放空任务队列，
    // 等登录 mock 真被调用（release 已赋值）再放行，否则 release 还是 undefined
    //（此前 CI 失败就是在这里直接调 release 抛 TypeError）。
    for (let i = 0; i < 50 && apiLoginMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
    expect(apiLoginMock).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([p1, p2]);

    expect(apiLoginMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it("退出竞态：restoreSession 在飞时用户点退出，登录完成也不把已退出的用户重新登入", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    let release!: (v: { ok: boolean }) => void;
    apiLoginMock.mockImplementation(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          release = res;
        })
    );
    (api.logout as jest.Mock).mockResolvedValue(undefined);

    const restoreP = useAuthStore.getState().restoreSession();
    // 等登录 mock 真被调用（release 已赋值）再点退出
    for (let i = 0; i < 50 && apiLoginMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
    expect(apiLoginMock).toHaveBeenCalledTimes(1);

    // 登录还在飞时点退出
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().isLoggedIn).toBe(false);

    // 登录完成（成功）：代次已变，不写登录态
    release({ ok: true });
    await restoreP;
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
  });

  it("第 21 轮 L-2：自动登录失败且标记清除也失败时，仍弹登录框且不向外抛", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockRejectedValue(new Error("Network request failed"));
    asyncRemoveMock.mockRejectedValue(new Error("Storage full"));

    await expect(useAuthStore.getState().restoreSession()).resolves.toBeUndefined();

    // 旧代码：removeItem 一抛，后面的 set 不执行，登录框弹不出，用户处于
    // “已登出但无入口重登”状态直到冷启动。
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("第 22 轮 Low-1：退出竞态下在飞登录成功后撤销副作用（再调一次 logout 清标记）", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    let release!: (v: { ok: boolean }) => void;
    apiLoginMock.mockImplementation(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          release = res;
        }),
    );
    apiLogoutMock.mockResolvedValue(undefined);

    const restoreP = useAuthStore.getState().restoreSession();
    // 等登录 mock 真被调用（release 已赋值）再点退出
    for (let i = 0; i < 50 && apiLoginMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
    expect(apiLoginMock).toHaveBeenCalledTimes(1);

    // 登录还在飞时点退出（logout 调一次 api.logout 清标记）
    await useAuthStore.getState().logout();
    expect(apiLogoutMock).toHaveBeenCalledTimes(1);

    // 在飞的登录成功返回：代次已变，不写登录态，且再调一次 logout 撤销副作用
    //（api.login 已重写 authCookies 标记，只拦 set 的话下次冷启动又自动登录）。
    release({ ok: true });
    await restoreP;
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(apiLogoutMock).toHaveBeenCalledTimes(2);
  });
});
