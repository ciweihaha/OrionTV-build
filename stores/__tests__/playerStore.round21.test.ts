// 第 21 轮 playerStore M-1 回归测试：loadVideo 读取播放记录失败时不钉死假加载屏。
// redis 模式下 /api/playrecords 抖动会让 PlayRecordManager.get() 抛错；旧代码
// 与写 episodes 的 set() 共用一个 try，抛错跳过写 episodes，catch 只清 isLoading，
// 播放页永久钉死在假加载屏（20s 超时不 arm，detail 已就绪所以错误分支也不命中）。
import usePlayerStore from "../playerStore";
import { PlayRecordManager } from "@/services/storage";

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

const mockRecordGet = PlayRecordManager.get as jest.Mock;

describe("playerStore 第 21 轮 M-1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePlayerStore.setState({
      videoPlayer: null,
      playbackRate: 1.0,
      currentEpisodeIndex: 0,
      episodes: [],
      isLoading: true,
      initialPosition: 0,
    });
  });

  it("播放记录读取失败时仍写 episodes、清 isLoading（断点从 0 开始）", async () => {
    mockRecordGet.mockRejectedValue(new Error("Network request failed"));

    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: 0, title: "T" });

    const state = usePlayerStore.getState();
    // 旧代码：get() 抛错跳过写 episodes 的 set()，episodes 为 [] 且 isLoading
    // 被 catch 清掉，播放页钉死在假加载屏上。
    expect(state.episodes).toHaveLength(3);
    expect(state.isLoading).toBe(false);
    expect(state.initialPosition).toBe(0);
    expect(state.playbackRate).toBe(1.0);
    expect(state.currentEpisodeIndex).toBe(0);
  });

  it("播放记录读取成功时仍用记录的断点与倍速（无回归）", async () => {
    mockRecordGet.mockResolvedValue({ play_time: 600, playbackRate: 1.5 });

    await usePlayerStore.getState().loadVideo({ source: "s1", id: "1", episodeIndex: 0, title: "T" });

    const state = usePlayerStore.getState();
    expect(state.episodes).toHaveLength(3);
    expect(state.initialPosition).toBe(600000);
    expect(state.playbackRate).toBe(1.5);
  });
});
