// 第 22 轮 playerStore Low-2 回归测试：loadVideo 缓存详情校验比对 id。
// 同一源上同名不同 id 的两部片（如同名翻拍），只比 title 会走缓存捷径
// 播错片（episodesSelectorBySource 只按源取第一条，缓存的 detail 是另一部片）。
import usePlayerStore from "../playerStore";

// 可变的 detail 缓存：各测试改 detail.id，验证 loadVideo 的 id 比对。
// 工厂只在 getState 被调用时才读它（闭包延迟读取，无 TDZ 问题）。
const mockDetailState: {
  detail: { source: string; source_name: string; title: string; id: number };
  searchResults: unknown[];
  error: null;
  init: jest.Mock;
  setDetail: jest.Mock;
} = {
  detail: { source: "s1", source_name: "s1", title: "T", id: 1 },
  searchResults: [],
  error: null,
  init: jest.fn(async () => undefined),
  setDetail: jest.fn(async () => undefined),
};

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
  default: { getState: () => mockDetailState },
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

describe("playerStore 第 22 轮 Low-2", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetailState.detail = { source: "s1", source_name: "s1", title: "T", id: 1 };
    usePlayerStore.setState({
      videoPlayer: null,
      playbackRate: 1.0,
      currentEpisodeIndex: 0,
      episodes: [],
      isLoading: true,
      initialPosition: 0,
    });
  });

  it("同名同源不同 id 时走 detail 初始化（不走缓存捷径）", async () => {
    mockDetailState.detail = { source: "s1", source_name: "s1", title: "T", id: 2 };

    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: 0, title: "T" });

    // 旧代码：只比 title，needsDetailInit 为 false，init 不调用，直接用
    // 缓存的另一部片（id 2）的剧集播放。
    expect(mockDetailState.init).toHaveBeenCalledWith("T", "s1", "1");
    expect(usePlayerStore.getState().episodes).toHaveLength(3);
    expect(usePlayerStore.getState().isLoading).toBe(false);
  });

  it("同名同源同 id 时仍走缓存捷径（无回归）", async () => {
    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: 0, title: "T" });

    expect(mockDetailState.init).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().episodes).toHaveLength(3);
    expect(usePlayerStore.getState().isLoading).toBe(false);
  });
});
