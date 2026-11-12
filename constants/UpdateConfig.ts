export const UPDATE_CONFIG = {
  // 自动检查更新
  AUTO_CHECK: true,

  // 检查更新间隔（毫秒）
  CHECK_INTERVAL: 12 * 60 * 60 * 1000, // 12小时

  // 更新检查URL（2026-10-28：改用自有 Cloudflare 域名，国内电视可直连；
  // 接口自身返回 no-cache，不再用 ?t= 时间戳绕缓存）
  GITHUB_RAW_URL:
    `https://ysp.ciweihaha.win/agg?ac=oriontv-version`,

  // 获取平台特定的下载URL
  // 版本号先校验格式再拼 URL（L5）：版本号来自版本检查的服务端响应，
  // 未校验就插值可能拼出畸形地址；格式为语义化版本，可带 -beta/-rc 等后缀。
  getDownloadUrl(version: string): string {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      throw new Error(`Invalid version format: ${version}`);
    }
    return `https://dl.ciweihaha.win/orionTV.${version}.apk`;
  },

  // 是否显示更新日志
  SHOW_RELEASE_NOTES: true,

  // 是否允许跳过版本
  ALLOW_SKIP_VERSION: true,

  // 是否在WIFI下自动下载
  AUTO_DOWNLOAD_ON_WIFI: false,

  // 更新通知设置
  NOTIFICATION: {
    ENABLED: true,
    TITLE: "OrionTV 更新",
    DOWNLOADING_TEXT: "正在下载新版本...",
    DOWNLOAD_COMPLETE_TEXT: "下载完成，点击安装",
  },
};
