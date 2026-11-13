// withApkSplits 单元测试：只测 build.gradle 文本变换本身（不跑 prebuild）。
// 完整的 prebuild 验证见 PR 描述（本地跑过，生成的 build.gradle 已核对）。
const { applyApkSplits } = require("../withApkSplits");

const SAMPLE_GRADLE = `android {
    namespace 'com.oriontv'
    defaultConfig {
        applicationId 'com.oriontv'
    }
    buildTypes {
        release {
            minifyEnabled true
        }
    }
}
`;

describe("withApkSplits", () => {
  it("在 buildTypes 之前插入 splits 块", () => {
    const out = applyApkSplits(SAMPLE_GRADLE);
    expect(out).toContain("splits {");
    expect(out).toContain("include 'arm64-v8a', 'armeabi-v7a'");
    expect(out).toContain("universalApk true");
    expect(out.indexOf("splits {")).toBeLessThan(out.indexOf("buildTypes {"));
  });

  it("不改动原有内容", () => {
    const out = applyApkSplits(SAMPLE_GRADLE);
    expect(out).toContain("namespace 'com.oriontv'");
    expect(out).toContain("minifyEnabled true");
  });

  it("已打过补丁时幂等，不重复插入", () => {
    const once = applyApkSplits(SAMPLE_GRADLE);
    const twice = applyApkSplits(once);
    expect(twice).toBe(once);
    expect(twice.match(/splits \{/g)).toHaveLength(1);
  });

  it("已有其他来源的 splits 块时 fail-closed 抛错", () => {
    const withSplits = SAMPLE_GRADLE.replace(
      "    buildTypes {",
      "    splits {\n        abi {\n            enable true\n        }\n    }\n    buildTypes {",
    );
    expect(() => applyApkSplits(withSplits)).toThrow(/already contains a splits block/);
  });

  it("找不到 buildTypes 锚点时 fail-closed 抛错", () => {
    expect(() => applyApkSplits("android {\n}\n")).toThrow(/could not find the buildTypes block/);
  });
});
