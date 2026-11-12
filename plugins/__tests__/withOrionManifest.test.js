// withOrionManifest 单元测试：只测 manifest 变换本身（不跑 prebuild）。
// 完整的 prebuild 验证见 PR 描述（本地跑过，生成 manifest 已核对）。
const { applyOrionManifest } = require("../withOrionManifest");

function makeManifest(appAttrs = {}) {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [
        {
          $: {
            "android:name": ".MainApplication",
            "android:label": "@string/app_name",
            ...appAttrs,
          },
        },
      ],
    },
  };
}

describe("withOrionManifest", () => {
  it("给 application 加上 usesCleartextTraffic=true", () => {
    const out = applyOrionManifest(makeManifest());
    expect(out.manifest.application[0].$["android:usesCleartextTraffic"]).toBe("true");
  });

  it("已是 true 时幂等，不抛错", () => {
    const out = applyOrionManifest(makeManifest({ "android:usesCleartextTraffic": "true" }));
    expect(out.manifest.application[0].$["android:usesCleartextTraffic"]).toBe("true");
  });

  it("已被设为 false 时 fail-closed 抛错，不静默覆盖", () => {
    expect(() =>
      applyOrionManifest(makeManifest({ "android:usesCleartextTraffic": "false" })),
    ).toThrow(/refusing to override/);
  });

  it("不碰 application 的其他属性", () => {
    const out = applyOrionManifest(
      makeManifest({ "android:banner": "@drawable/tv_banner", "android:allowBackup": "true" }),
    );
    const attrs = out.manifest.application[0].$;
    expect(attrs["android:banner"]).toBe("@drawable/tv_banner");
    expect(attrs["android:allowBackup"]).toBe("true");
    expect(attrs["android:usesCleartextTraffic"]).toBe("true");
  });
});
