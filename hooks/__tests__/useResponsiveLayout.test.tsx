// 第 6 轮 B14：非 TV 设备宽度 ≥1024 时不应判为 tv（大平板横屏/桌面 Web
// 会走固定 160px 卡片、5 列布局，且 nativeControls 被禁用）。
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text, Dimensions, Platform } from "react-native";
import { useResponsiveLayout } from "../useResponsiveLayout";

function Probe() {
  const config = useResponsiveLayout();
  return <Text>{`deviceType:${config.deviceType} columns:${config.columns}`}</Text>;
}

function probeText(root: TestRenderer.ReactTestInstance): string {
  return root.findByType(Text).props.children as string;
}

describe("useResponsiveLayout B14", () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let dimensionsSpy: jest.SpyInstance;

  beforeEach(() => {
    dimensionsSpy = jest.spyOn(Dimensions, "get");
    jest.spyOn(Dimensions, "addEventListener").mockReturnValue({ remove: jest.fn() } as any);
    // 默认非 TV（jest 环境的 Platform.isTV 本来就是 false，显式劫持更稳）
    jest.spyOn(Platform, "isTV", "get").mockReturnValue(false);
  });

  afterEach(() => {
    renderer?.unmount();
    jest.restoreAllMocks();
  });

  it("非 TV 设备宽度 1200 判为 tablet，不判 tv", async () => {
    dimensionsSpy.mockReturnValue({ width: 1200, height: 800, scale: 1, fontScale: 1 });
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("deviceType:tablet");
  });

  it("TV 设备宽度 1200 仍判为 tv", async () => {
    // Platform.isTV 是 getter（无 setter），直接赋值无效，需劫持 getter
    jest.spyOn(Platform, "isTV", "get").mockReturnValue(true);
    dimensionsSpy.mockReturnValue({ width: 1200, height: 800, scale: 1, fontScale: 1 });
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("deviceType:tv");
  });

  it("非 TV 设备宽度 800 判为 tablet（回归）", async () => {
    dimensionsSpy.mockReturnValue({ width: 800, height: 600, scale: 1, fontScale: 1 });
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(probeText(renderer.root)).toContain("deviceType:tablet");
  });
});
