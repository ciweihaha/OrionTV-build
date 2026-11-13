// withAbiSplits 单元测试：只测 build.gradle 文本变换本身（不跑 prebuild）。
// 完整的 prebuild 验证见 PR 描述（本地跑过，生成的 build.gradle 已核对）。
const { applyAbiSplits } = require("../withAbiSplits");

const SAMPLE_GRADLE = `apply plugin: "com.android.application"

android {
    ndkVersion rootProject.ext.ndkVersion
    namespace "com.oriontv"
    defaultConfig {
        applicationId "com.oriontv"
        versionCode 10700
    }
}
`;

describe("withAbiSplits", () => {
  it("在 defaultConfig 之前插入 splits 块", () => {
    const out = applyAbiSplits(SAMPLE_GRADLE);
    expect(out).toContain("splits {");
    expect(out).toContain("include 'arm64-v8a', 'armeabi-v7a'");
    expect(out).toContain("universalApk true");
    expect(out.indexOf("splits {")).toBeLessThan(out.indexOf("defaultConfig {"));
    expect(out).toContain("defaultConfig {");
  });

  it("已注入时幂等，不重复插入", () => {
    const once = applyAbiSplits(SAMPLE_GRADLE);
    const twice = applyAbiSplits(once);
    expect(twice).toBe(once);
    expect(twice.split("splits {").length - 1).toBe(1);
  });

  it("找不到 defaultConfig 锚点时抛错", () => {
    expect(() => applyAbiSplits("android {\n}\n")).toThrow("defaultConfig");
  });
});
