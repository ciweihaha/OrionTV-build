// 第 6 轮 playerStore 修复的回归测试：B13 player 未就绪时倍速先写状态。
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

jest.mock("../detailStore", () => ({
  __esModule: true,
  default: {
    getState: () => ({ detail: null }),
  },
  episodesSelectorBySource: () => () => [],
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

describe("playerStore 第 6 轮", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePlayerStore.setState({ videoPlayer: null, playbackRate: 1.0 });
  });

  it("B13：videoPlayer 为 null 时 setPlaybackRate 仍写状态（不静默丢弃）", async () => {
    await usePlayerStore.getState().setPlaybackRate(1.5);
    // 旧代码在 videoPlayer! 上抛 TypeError 被 catch 吞掉，状态不更新
    expect(usePlayerStore.getState().playbackRate).toBe(1.5);
  });

  it("B13：videoPlayer 就绪时同时写 player 属性与状态", async () => {
    const fakePlayer = { playbackRate: 1.0 };
    usePlayerStore.setState({ videoPlayer: fakePlayer as any });
    await usePlayerStore.getState().setPlaybackRate(2.0);
    expect(fakePlayer.playbackRate).toBe(2.0);
    expect(usePlayerStore.getState().playbackRate).toBe(2.0);
  });
});
