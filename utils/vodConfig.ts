// 点播配置（TVBox 风格的静态 JSON 配置，如 vod.json）：
// 用户 2026-11-18 核对过的影视 App 点播配置
// https://live.ciweihaha.win/vod.json（20 站合一，接口 vod-api/）。
// 它不是 MoonTV 服务器地址——不能拿它去调 /api/server-config、登录，
// 否则校验失败、首页弹“请配置服务器地址”；它只说明“点播走哪个配置”。
// v1.7.11 起新装默认就填它，首页不用配服务器直接出内容。

/** 内置默认点播配置：新装、或老版本存的空白地址都回落到这里。 */
export const DEFAULT_VOD_CONFIG_URL =
  "https://live.ciweihaha.win/vod.json";

/**
 * 判断一个 API 地址是不是点播配置文件地址。
 * 规则：去空白后（不区分大小写）以 .json 结尾。带查询串的 .json 暂不认
 * （预填地址本身不带查询串；用户真贴了带参地址会被当作 MoonTV 地址处理，
 * 校验失败时设置页会提示，属于可发现、可纠正的情形）。
 */
export function isVodConfigUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.trim().toLowerCase().endsWith(".json");
}
