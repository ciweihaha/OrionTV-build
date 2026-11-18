// 电视端内置拼音键盘的组件测试：按键 → 缓冲/候选/上屏/搜索 的接线。
// StyledButton 用桩替换（只保留 text + onPress，方便按文本找到并按下）；
// 真实 StyledButton 的焦点样式由 StyledButton-focus.test.tsx 覆盖。
import * as React from "react";
import renderer, { act } from "react-test-renderer";
import { PinyinKeyboard } from "../PinyinKeyboard";

jest.mock("../StyledButton", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  return {
    StyledButton: (props: any) => (
      <View testID={`kb-${props.text}`} onPress={props.onPress} />
    ),
  };
});

// 找到某个文本的键并按下（先触发 onPress）。
function pressKey(root: renderer.ReactTestRenderer, text: string) {
  const node = root.root.findByProps({ testID: `kb-${text}` });
  act(() => {
    (node.props as any).onPress();
  });
}

function renderKeyboard(initialKeyword = "") {
  let keyword = initialKeyword;
  const onKeywordChange = jest.fn((kw: string) => {
    keyword = kw;
  });
  let buffer = "";
  const onBufferChange = jest.fn((b: string) => {
    buffer = b;
  });
  const onSearch = jest.fn();
  let root!: renderer.ReactTestRenderer;
  const render = () => {
    const element = (
      <PinyinKeyboard
        keyword={keyword}
        onKeywordChange={onKeywordChange}
        buffer={buffer}
        onBufferChange={onBufferChange}
        onSearch={onSearch}
      />
    );
    act(() => {
      // 用 root.update 重渲染（保留组件内部状态：中/英、123 切换）；
      // 重新 create 会挂一个全新实例、把切换状态清掉。
      if (!root) root = renderer.create(element);
      else root.update(element);
    });
  };
  render();
  return {
    root: () => root,
    keyword: () => keyword,
    buffer: () => buffer,
    onSearch,
    onKeywordChange,
    rerender: render,
  };
}

describe("PinyinKeyboard（电视内置拼音输入）", () => {
  it("输拼音 jie，候选里出现 接；点候选上屏到关键词", () => {
    const kb = renderKeyboard();
    for (const k of ["J", "I", "E"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    expect(kb.buffer()).toBe("jie");
    // 候选“接”出现了
    expect(() => kb.root().root.findByProps({ testID: "kb-接" })).not.toThrow();
    pressKey(kb.root(), "接");
    kb.rerender();
    expect(kb.keyword()).toBe("接");
    expect(kb.buffer()).toBe("");
  });

  it("连续拼词：打 zhong 再打 g，中的首选字自动上屏，再拼 guo", () => {
    const kb = renderKeyboard();
    for (const k of ["Z", "H", "O", "N", "G"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    expect(kb.buffer()).toBe("zhong");
    pressKey(kb.root(), "G");
    kb.rerender();
    expect(kb.keyword()).toBe("中");
    expect(kb.buffer()).toBe("g");
    for (const k of ["U", "O"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    expect(kb.buffer()).toBe("guo");
    pressKey(kb.root(), "国");
    kb.rerender();
    expect(kb.keyword()).toBe("中国");
  });

  it("中/英切换：点“英文”段进英文模式，字母直接上屏，不出候选", () => {
    const kb = renderKeyboard();
    pressKey(kb.root(), "英文");
    kb.rerender();
    for (const k of ["A", "B", "C"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    expect(kb.keyword()).toBe("ABC");
    expect(kb.buffer()).toBe("");
    // 英文模式没有候选按钮
    expect(() =>
      kb.root().root.findByProps({ testID: "kb-接" }),
    ).toThrow();
  });

  it("中/英两段始终同时可见（v1.7.11：单按钮只显当前模式，用户看不出能切）", () => {
    const kb = renderKeyboard();
    // 中文模式下两段都在
    expect(() => kb.root().root.findByProps({ testID: "kb-中文" })).not.toThrow();
    expect(() => kb.root().root.findByProps({ testID: "kb-英文" })).not.toThrow();
    // 切到英文后两段也都在
    pressKey(kb.root(), "英文");
    kb.rerender();
    expect(() => kb.root().root.findByProps({ testID: "kb-中文" })).not.toThrow();
    expect(() => kb.root().root.findByProps({ testID: "kb-英文" })).not.toThrow();
  });

  it("点已选中的段不清空拼音缓冲", () => {
    const kb = renderKeyboard();
    for (const k of ["J", "I", "E"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    expect(kb.buffer()).toBe("jie");
    // 已在中文模式，再点“中文”段：不切换、不清空缓冲
    pressKey(kb.root(), "中文");
    kb.rerender();
    expect(kb.buffer()).toBe("jie");
    expect(kb.keyword()).toBe("");
  });

  it("删除键：先删拼音缓冲，缓冲空了再删关键词", () => {
    const kb = renderKeyboard("借");
    for (const k of ["Q", "I"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    expect(kb.buffer()).toBe("qi");
    pressKey(kb.root(), "⌫");
    kb.rerender();
    expect(kb.buffer()).toBe("q");
    pressKey(kb.root(), "⌫");
    kb.rerender();
    expect(kb.buffer()).toBe("");
    expect(kb.keyword()).toBe("借");
    pressKey(kb.root(), "⌫");
    kb.rerender();
    expect(kb.keyword()).toBe("");
  });

  it("搜索键：有未上屏的合法拼音时先把首选字上屏再搜", () => {
    const kb = renderKeyboard();
    for (const k of ["J", "I", "E"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    pressKey(kb.root(), "搜索");
    kb.rerender();
    expect(kb.keyword()).toBe("接");
    expect(kb.onSearch).toHaveBeenCalledWith("接");
  });

  it("123 切换：数字键直接上屏；ABC 切回字母", () => {
    const kb = renderKeyboard();
    pressKey(kb.root(), "123");
    kb.rerender();
    pressKey(kb.root(), "2");
    kb.rerender();
    pressKey(kb.root(), "0");
    kb.rerender();
    expect(kb.keyword()).toBe("20");
    pressKey(kb.root(), "ABC");
    kb.rerender();
    pressKey(kb.root(), "J");
    kb.rerender();
    expect(kb.buffer()).toBe("j");
  });

  it("空格键：有合法拼音时选首选字，否则加空格", () => {
    const kb = renderKeyboard();
    for (const k of ["J", "I", "E"]) {
      pressKey(kb.root(), k);
      kb.rerender();
    }
    pressKey(kb.root(), "空格");
    kb.rerender();
    expect(kb.keyword()).toBe("接");
    expect(kb.buffer()).toBe("");
    pressKey(kb.root(), "空格");
    kb.rerender();
    expect(kb.keyword()).toBe("接 ");
  });
});
