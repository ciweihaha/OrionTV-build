// StyledButton 焦点态测试（选集页问题复现）：
// 遥控移动焦点时，聚焦的按钮必须有清晰可见的高亮，且和选中态（绿底）分得开。
// 焦点高亮 = 3px 白边 + 阴影；选中 = 绿底；两者可叠加（选中+焦点 = 绿底白边）。
import * as React from "react";
import renderer, { act } from "react-test-renderer";
import { StyledButton } from "../StyledButton";

// jest-expo 里 Pressable 被 mock 成宿主 View，style 函数已按 focused=false
// 算好（得到数组）；用带 onFocus 的那个宿主 View 定位它。
// 注意：findAll 会先命中复合组件 Pressable（它的 style 还是函数），要只取
// type 为字符串的宿主节点，才是真正算好样式的 View。
function findButtonView(root: renderer.ReactTestRenderer): any {
  const nodes = root.root.findAll(
    (node) =>
      typeof node.type === "string" &&
      node.props &&
      typeof node.props.onFocus === "function",
  );
  if (nodes.length === 0) throw new Error("找不到带 onFocus 的按钮节点");
  return nodes[0];
}

// 把已算好的 style 数组展平成一个对象方便断言。
function flatStyle(node: any): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const arr = node.props.style;
  const parts = Array.isArray(arr) ? arr : [arr];
  for (const part of parts) {
    if (part && typeof part === "object") Object.assign(flat, part);
  }
  return flat;
}

describe("StyledButton 焦点高亮（选集焦点看不见的回归）", () => {
  it("未聚焦、未选中：没有白边、没有绿底", () => {
    let root!: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<StyledButton text="第 1 集" />);
    });
    const style = flatStyle(findButtonView(root));
    expect(style.borderColor).not.toBe("#ffffff");
    expect(style.backgroundColor).not.toBe("#00bb5e");
  });

  it("遥控把焦点移上来（onFocus）后：3px 白边，背景不变（和绿底选中态分得开）", () => {
    let root!: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<StyledButton text="第 1 集" />);
    });
    act(() => {
      findButtonView(root).props.onFocus({});
    });
    const style = flatStyle(findButtonView(root));
    expect(style.borderColor).toBe("#ffffff");
    expect(style.borderWidth).toBe(3);
    expect(style.backgroundColor).not.toBe("#00bb5e");
  });

  it("选中时：绿底、无白边；选中+聚焦：绿底 + 白边（两种状态都看得见）", () => {
    let root!: renderer.ReactTestRenderer;
    act(() => {
      root = renderer.create(<StyledButton text="第 1 集" isSelected />);
    });
    const unfocused = flatStyle(findButtonView(root));
    expect(unfocused.backgroundColor).toBe("#00bb5e");
    expect(unfocused.borderColor).not.toBe("#ffffff");
    act(() => {
      findButtonView(root).props.onFocus({});
    });
    const focused = flatStyle(findButtonView(root));
    expect(focused.backgroundColor).toBe("#00bb5e");
    expect(focused.borderColor).toBe("#ffffff");
    expect(focused.borderWidth).toBe(3);
  });
});
