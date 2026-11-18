// 远程输入落点（v1.7.11 修“手机扫码打字、app 毫无反应”）：
// 旧逻辑只认设置分区 Pressable 的 onFocus 记下的 currentSection，
// 平板上点输入框时分区 onFocus 不可靠，消息被静默丢掉（手机端还显示成功）。
// 新逻辑：输入框 onFocus 记下的 inputTarget 优先，当前分区次之，
// 都没记下时默认进 API 地址栏——永不静默丢弃。
// （jest.mock 由 babel 提升到 import 之前，写在 import 下面也可以。）
import {
  useRemoteControlStore,
  resolveRemoteInputTarget,
} from "@/stores/remoteControlStore";

jest.mock("@/services/remoteControlService", () => ({
  remoteControlService: {
    init: jest.fn(),
    startServer: jest.fn(async () => "http://192.168.1.23:12346"),
    stopServer: jest.fn(),
    getPairingCode: jest.fn(() => "0000"),
  },
}));

jest.mock("@/utils/Logger", () => {
  const stub = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const mockLogger = { withTag: () => stub };
  return { __esModule: true, default: mockLogger, Logger: mockLogger };
});

describe("resolveRemoteInputTarget（远程输入落点）", () => {
  it("输入框记下的目标优先于当前分区", () => {
    expect(resolveRemoteInputTarget("livestream", "api")).toBe("livestream");
    expect(resolveRemoteInputTarget("api", "livestream")).toBe("api");
  });

  it("没记下目标时按当前分区", () => {
    expect(resolveRemoteInputTarget(null, "api")).toBe("api");
    expect(resolveRemoteInputTarget(null, "livestream")).toBe("livestream");
  });

  it("都没记下时默认进 API 地址栏，不丢消息（旧 bug 的复现点）", () => {
    // 旧逻辑：currentSection 既不是 api 也不是 livestream → handleRemoteInput
    // 什么都不做，clearMessage 照样清掉，手机端显示成功、app 里没字。
    expect(resolveRemoteInputTarget(null, null)).toBe("api");
  });
});

describe("remoteControlStore.inputTarget", () => {
  it("输入框 onFocus 记下的目标能存取", () => {
    const store = useRemoteControlStore.getState();
    store.setInputTarget("livestream");
    expect(useRemoteControlStore.getState().inputTarget).toBe("livestream");
    store.setInputTarget("api");
    expect(useRemoteControlStore.getState().inputTarget).toBe("api");
    store.setInputTarget(null);
    expect(useRemoteControlStore.getState().inputTarget).toBeNull();
  });
});
