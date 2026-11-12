// 复现：PR #16 L18d 重构引入的回归——useApiConfig 的 isValidating
// 在校验完成后永远不复位，非 CMS 分类永久显示“正在验证服务器配置…”
// 转圈，内容被盖住（且 spinner 分支在 error 分支之前，服务器宕机时
// 错误文案也永远显示不出来）。
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import { useApiConfig } from "../useApiConfig";
import { useSettingsStore } from "@/stores/settingsStore";

jest.mock("@/stores/settingsStore", () => ({
  useSettingsStore: jest.fn(),
}));

const settingsMock = useSettingsStore as unknown as jest.Mock;

// 第 10 轮：useApiConfig 改按字段订阅（传 selector），mock 要应用 selector
// 才返回对应字段，否则 apiBaseUrl 会拿到整个 state 对象
function setMockSettings(state: { apiBaseUrl: string; serverConfig: unknown; isLoadingServerConfig: boolean }) {
  settingsMock.mockImplementation((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state,
  );
}

function Probe() {
  const status = useApiConfig();
  return (
    <Text>
      {`validating:${status.isValidating} valid:${status.isValid} error:${status.error ?? ""}`}
    </Text>
  );
}

function probeText(root: TestRenderer.ReactTestInstance): string {
  return root.findByType(Text).props.children as string;
}

describe("useApiConfig isValidating 复位", () => {
  let renderer: TestRenderer.ReactTestRenderer;

  afterEach(() => {
    renderer?.unmount();
    jest.clearAllMocks();
  });

  it("配置加载完成且拿到 serverConfig 后，isValidating 复位为 false", async () => {
    // 阶段 1：正在加载配置
    setMockSettings({
      apiBaseUrl: "https://example.com",
      serverConfig: null,
      isLoadingServerConfig: true,
    });
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("validating:true");

    // 阶段 2：加载完成，拿到配置
    setMockSettings({
      apiBaseUrl: "https://example.com",
      serverConfig: { StorageType: "localstorage" },
      isLoadingServerConfig: false,
    });
    await act(async () => {
      renderer.update(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("validating:false");
    expect(probeText(renderer.root)).toContain("valid:true");
  });

  it("配置加载完成但未拿到 serverConfig 时，isValidating 同样复位并报通用错误", async () => {
    setMockSettings({
      apiBaseUrl: "https://example.com",
      serverConfig: null,
      isLoadingServerConfig: true,
    });
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("validating:true");

    setMockSettings({
      apiBaseUrl: "https://example.com",
      serverConfig: null,
      isLoadingServerConfig: false,
    });
    await act(async () => {
      renderer.update(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("validating:false");
    expect(probeText(renderer.root)).toContain("valid:false");
    expect(probeText(renderer.root)).toContain("无法获取服务器配置");
  });
});
