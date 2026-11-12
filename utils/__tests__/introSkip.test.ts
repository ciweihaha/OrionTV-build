import {
  DEFAULT_INTRO_SKIP_SECONDS,
  INTRO_SKIP_OPTIONS,
  resolveIntroEndTime,
} from "../introSkip";

describe("resolveIntroEndTime（自动跳过片头的片头结束时间）", () => {
  it("手动标记过时优先用标记值，不用默认时长", () => {
    expect(resolveIntroEndTime(45000, 90)).toBe(45000);
  });

  it("没标记过时用默认片头时长兜底（90 秒）", () => {
    expect(resolveIntroEndTime(undefined, DEFAULT_INTRO_SKIP_SECONDS)).toBe(90000);
  });

  it("没标记、默认时长为 0 时不跳", () => {
    expect(resolveIntroEndTime(undefined, 0)).toBeUndefined();
  });

  it("标记值为 0 或负数时当作没标记，走默认时长", () => {
    expect(resolveIntroEndTime(0, 60)).toBe(60000);
    expect(resolveIntroEndTime(-1000, 60)).toBe(60000);
  });

  it("可选档位包含关闭项与常用时长", () => {
    expect([...INTRO_SKIP_OPTIONS]).toEqual([0, 30, 60, 90, 120]);
    expect(DEFAULT_INTRO_SKIP_SECONDS).toBe(90);
  });
});
