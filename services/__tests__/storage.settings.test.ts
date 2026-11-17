// 内置默认直播源（services/storage.ts 的 DEFAULT_M3U_URL）：
// 新装或老版本存的空白 m3uUrl 都应回落到默认地址，打开直播直接可用；
// 用户填过的非空地址不受影响。
import { SettingsManager, DEFAULT_M3U_URL } from "../storage";

const mockStore = new Map<string, string>();
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
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

jest.mock("../api", () => ({
  api: {
    getPlayRecords: jest.fn(),
    savePlayRecord: jest.fn(),
    deletePlayRecord: jest.fn(),
    getFavorites: jest.fn(),
  },
}));

const SETTINGS_KEY = "mytv_settings";

describe("内置默认直播源 DEFAULT_M3U_URL", () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
  });

  it("默认地址就是用户给的直播 M3U", () => {
    expect(DEFAULT_M3U_URL).toBe("https://live.ciweihaha.win/live.m3u");
  });

  it("新装（无已存设置）时 m3uUrl 就是默认地址", async () => {
    const settings = await SettingsManager.get();
    expect(settings.m3uUrl).toBe(DEFAULT_M3U_URL);
  });

  it("老版本存的空白 m3uUrl 回落到默认地址", async () => {
    mockStore.set(SETTINGS_KEY, JSON.stringify({ apiBaseUrl: "", m3uUrl: "" }));
    const settings = await SettingsManager.get();
    expect(settings.m3uUrl).toBe(DEFAULT_M3U_URL);
  });

  it("用户填过的非空地址不受影响", async () => {
    const custom = "https://example.com/custom.m3u";
    mockStore.set(SETTINGS_KEY, JSON.stringify({ apiBaseUrl: "", m3uUrl: custom }));
    const settings = await SettingsManager.get();
    expect(settings.m3uUrl).toBe(custom);
  });

  it("保存后再读：默认地址能正常落盘", async () => {
    const settings = await SettingsManager.get();
    await SettingsManager.save({ m3uUrl: settings.m3uUrl });
    const reloaded = await SettingsManager.get();
    expect(reloaded.m3uUrl).toBe(DEFAULT_M3U_URL);
  });
});
