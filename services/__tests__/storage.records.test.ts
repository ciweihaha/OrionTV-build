import { PlayRecordManager } from "../storage";
import { storageConfig } from "../storageConfig";

// 内存 AsyncStorage：get/set 往返，测 blob 内容
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

// 本地模式不应调 api；mock 仅为让 storage.ts 的 import 可解析
jest.mock("../api", () => ({
  api: {
    getPlayRecords: jest.fn(),
    savePlayRecord: jest.fn(),
    deletePlayRecord: jest.fn(),
    getFavorites: jest.fn(),
  },
}));

const PLAY_RECORDS = "mytv_play_records";
const PLAYER_SETTINGS = "mytv_player_settings";

describe("PlayRecordManager 本地模式（第 13 轮 M2）", () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
    storageConfig.setStorageType("localstorage");
  });

  afterEach(() => {
    storageConfig.setStorageType(undefined);
  });

  it("save 不把片头/片尾标记写进 PLAY_RECORDS blob（只进 PLAYER_SETTINGS）", async () => {
    await PlayRecordManager.save("src1", "id1", {
      title: "剧A",
      cover: "",
      index: 1,
      total_episodes: 10,
      play_time: 1000,
      source_name: "源1",
      introEndTime: 90,
      outroStartTime: 2400,
    } as any);

    const blob = JSON.parse(mockStore.get(PLAY_RECORDS)!);
    const key = Object.keys(blob)[0];
    expect(blob[key].introEndTime).toBeUndefined();
    expect(blob[key].outroStartTime).toBeUndefined();
    expect(blob[key].title).toBe("剧A");

    const settings = JSON.parse(mockStore.get(PLAYER_SETTINGS)!);
    expect(settings[key].introEndTime).toBe(90);
    expect(settings[key].outroStartTime).toBe(2400);
  });

  it("清除标记后 getAll 不再返回旧标记（旧 bug 会从 blob 里复活）", async () => {
    await PlayRecordManager.save("src1", "id1", {
      title: "剧A", cover: "", index: 1, total_episodes: 10,
      play_time: 1000, source_name: "源1", introEndTime: 90,
    } as any);
    // 清除：introEndTime 传 undefined（playerStore.setIntroEndTime 的清除分支）
    await PlayRecordManager.save("src1", "id1", {
      title: "剧A", cover: "", index: 1, total_episodes: 10,
      play_time: 2000, source_name: "源1", introEndTime: undefined,
    } as any);

    const all = await PlayRecordManager.getAll();
    const key = Object.keys(all)[0];
    expect(all[key].introEndTime).toBeUndefined();
    // blob 里也没有残留
    const blob = JSON.parse(mockStore.get(PLAY_RECORDS)!);
    expect(blob[key].introEndTime).toBeUndefined();
  });

  it("getAll 剥离历史 blob 里已污染的标记字段", async () => {
    // 模拟旧 bug 污染过的 blob：标记值直接写在记录里
    mockStore.set(PLAY_RECORDS, JSON.stringify({
      "src1+id1": { title: "剧A", cover: "", index: 1, total_episodes: 10, play_time: 1000, source_name: "源1", introEndTime: 90, save_time: 1 },
    }));
    const all = await PlayRecordManager.getAll();
    expect(all["src1+id1"].introEndTime).toBeUndefined();
    expect(all["src1+id1"].title).toBe("剧A");
  });

  it("remove 写回时也剥离设置字段", async () => {
    mockStore.set(PLAY_RECORDS, JSON.stringify({
      "src1+id1": { title: "剧A", cover: "", index: 1, total_episodes: 10, play_time: 1000, source_name: "源1", introEndTime: 90, save_time: 1 },
      "src1+id2": { title: "剧B", cover: "", index: 1, total_episodes: 10, play_time: 1000, source_name: "源1", introEndTime: 60, save_time: 2 },
    }));
    await PlayRecordManager.remove("src1", "id1");
    const blob = JSON.parse(mockStore.get(PLAY_RECORDS)!);
    expect(blob["src1+id1"]).toBeUndefined();
    expect(blob["src1+id2"].introEndTime).toBeUndefined();
  });
});

describe("storageConfig（第 13 轮 M3）", () => {
  afterEach(() => {
    storageConfig.setStorageType(undefined);
  });

  it("未配置时 getStorageType 回落 localstorage（而非 undefined）", () => {
    storageConfig.setStorageType(undefined);
    expect(storageConfig.getStorageType()).toBe("localstorage");
  });

  it("配置为 redis 时返回 redis", () => {
    storageConfig.setStorageType("redis");
    expect(storageConfig.getStorageType()).toBe("redis");
  });
});
