// 第 7 轮 playerStore 修复的回归测试：B2 loadVideo 集号越界钳制。
import usePlayerStore from "../playerStore";

jest.mock("@/services/storage", () => ({
  PlayRecordManager: {
    get: jest.fn(async () => null),
    getAll: jest.fn(async () => ({})),
    save: jest.fn(async () => undefined),
  },
  PlayerSettingsManager: {
    get: jest.fn(async () => null),
    save: jest.fn(async () => undefined),
  },
  parseRecordKey: (key: string) => {
    const sep = key.lastIndexOf("+");
    return sep >= 0
      ? { source: key.slice(0, sep), id: key.slice(sep + 1) }
      : { source: key, id: "" };
  },
}));

// detail 里 3 集（u1/u2/u3），标题与 loadVideo 传入的一致，
// 让 needsDetailInit 为 false，不走 init 分支。
jest.mock("../detailStore", () => ({
  __esModule: true,
  default: {
    getState: () => ({ detail: { source: "s1", title: "T", id: 1 } }),
  },
  episodesSelectorBySource: () => () => ["u1", "u2", "u3"],
}));

jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ apiBaseUrl: "https://example.com" }),
  },
}));

jest.mock("@/utils/introSkip", () => ({
  resolveIntroEndTime: jest.fn(() => 0),
}));

jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}), { virtual: true });

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

describe("playerStore 第 7 轮 B2", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePlayerStore.setState({ videoPlayer: null, playbackRate: 1.0, currentEpisodeIndex: 0, episodes: [] });
  });

  it("切到只有 3 集的源、当前集号 10 时钳制到第 3 集（索引 2）", async () => {
    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: 10, title: "T" });
    // 旧代码直接写 10，selectCurrentEpisode 返回 undefined，播放页卡假加载
    expect(usePlayerStore.getState().currentEpisodeIndex).toBe(2);
    expect(usePlayerStore.getState().episodes).toHaveLength(3);
  });

  it("负集号钳制到 0", async () => {
    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: -1, title: "T" });
    expect(usePlayerStore.getState().currentEpisodeIndex).toBe(0);
  });

  it("集号在范围内时不改动", async () => {
    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: 1, title: "T" });
    expect(usePlayerStore.getState().currentEpisodeIndex).toBe(1);
  });
});
