// 点播配置地址判断（utils/vodConfig.ts）：
// vod.json 这类静态 JSON 配置不是 MoonTV 服务器，要走 VOD 模式。
import { DEFAULT_VOD_CONFIG_URL, isVodConfigUrl } from "../vodConfig";

describe("点播配置地址 isVodConfigUrl", () => {
  it("默认点播配置就是用户核对过的 vod.json", () => {
    expect(DEFAULT_VOD_CONFIG_URL).toBe("https://live.ciweihaha.win/vod.json");
  });

  it("vod.json 地址认作点播配置", () => {
    expect(isVodConfigUrl("https://live.ciweihaha.win/vod.json")).toBe(true);
  });

  it("前后空白、大写 .JSON 也认", () => {
    expect(isVodConfigUrl("  https://example.com/config.json  ")).toBe(true);
    expect(isVodConfigUrl("https://example.com/config.JSON")).toBe(true);
  });

  it("MoonTV 服务器地址不是点播配置", () => {
    expect(isVodConfigUrl("https://movie.ciweihaha.win")).toBe(false);
    expect(isVodConfigUrl("https://movie.ciweihaha.win/")).toBe(false);
    expect(isVodConfigUrl("http://192.168.1.10:8080")).toBe(false);
  });

  it("空、null、undefined 都不是", () => {
    expect(isVodConfigUrl("")).toBe(false);
    expect(isVodConfigUrl(null)).toBe(false);
    expect(isVodConfigUrl(undefined)).toBe(false);
  });

  it("带查询串的 .json 暂不认（见 vodConfig.ts 的注释）", () => {
    expect(isVodConfigUrl("https://example.com/vod.json?x=1")).toBe(false);
  });
});
