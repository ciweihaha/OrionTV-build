import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LoginCredentialsManager, parseRecordKey } from "../storage";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

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

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const setItemAsync = SecureStore.setItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;
const removeItem = AsyncStorage.removeItem as jest.Mock;
const setItem = AsyncStorage.setItem as jest.Mock;

const KEY = "mytv_login_credentials";

describe("LoginCredentialsManager（SecureStore 凭据层）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("get：SecureStore 有值时返回解析后的凭据", async () => {
    getItemAsync.mockResolvedValue(JSON.stringify({ username: "u", password: "p" }));
    await expect(LoginCredentialsManager.get()).resolves.toEqual({ username: "u", password: "p" });
    expect(getItemAsync).toHaveBeenCalledWith(KEY);
  });

  it("get：SecureStore 为空时返回 null，不抛错", async () => {
    getItemAsync.mockResolvedValue(null);
    await expect(LoginCredentialsManager.get()).resolves.toBeNull();
  });

  it("get：SecureStore 抛错时吞错返回 null（调用方按无凭据处理）", async () => {
    getItemAsync.mockRejectedValue(new Error("SecureStore unavailable"));
    await expect(LoginCredentialsManager.get()).resolves.toBeNull();
  });

  it("save：写 SecureStore 并清理 AsyncStorage 里的旧版明文残留", async () => {
    await LoginCredentialsManager.save({ username: "u", password: "p" });
    expect(setItemAsync).toHaveBeenCalledWith(KEY, JSON.stringify({ username: "u", password: "p" }));
    expect(removeItem).toHaveBeenCalledWith(KEY);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("clear：删 SecureStore 并删 AsyncStorage 明文残留（退出后不自动重登的关键）", async () => {
    await LoginCredentialsManager.clear();
    expect(deleteItemAsync).toHaveBeenCalledWith(KEY);
    expect(removeItem).toHaveBeenCalledWith(KEY);
  });

  it("clear：SecureStore 抛错时 rethrow（调用方 authStore logout 自有 try/catch，本地退出仍不被阻断）", async () => {
    deleteItemAsync.mockRejectedValue(new Error("SecureStore unavailable"));
    await expect(LoginCredentialsManager.clear()).rejects.toThrow("SecureStore unavailable");
  });

  it("save：SecureStore 抛错时 rethrow（调用方 LoginModal 单独提示，不当登录失败）", async () => {
    setItemAsync.mockRejectedValue(new Error("SecureStore unavailable"));
    await expect(
      LoginCredentialsManager.save({ username: "u", password: "p" }),
    ).rejects.toThrow("SecureStore unavailable");
  });
});

describe("parseRecordKey（记录键编解码，第 5 轮）", () => {
  it("含 + 的 source/id 不碰撞：解析回原值", () => {
    expect(parseRecordKey("a%2Bb+c")).toEqual({ source: "a+b", id: "c" });
    expect(parseRecordKey("a+b%2Bc")).toEqual({ source: "a", id: "b+c" });
    // 两个键不同（旧实现都拼成 a+b+c，后者覆盖前者）
    expect("a%2Bb+c").not.toBe("a+b%2Bc");
  });

  it("不含特殊字符的键与旧格式逐字节相同（存量数据不受影响）", () => {
    expect(parseRecordKey("agg+12345")).toEqual({ source: "agg", id: "12345" });
    expect(parseRecordKey("douban+movie-1")).toEqual({ source: "douban", id: "movie-1" });
  });

  it("无分隔符的旧键返回整个 source、空 id", () => {
    expect(parseRecordKey("legacy-key")).toEqual({ source: "legacy-key", id: "" });
  });
});
