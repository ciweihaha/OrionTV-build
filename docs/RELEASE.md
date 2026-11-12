# 发版说明（记录现状，不改流程）

> 本文件只记录当前实际走的发版步骤，供下次发版照着做。改流程要另外讨论，不要顺手改 workflow。

## 版本号

- 唯一版本来源：`package.json` 的 `version` 字段。
- 升版时同时改三处并提交：`package.json` 的 `version`、`app.json` 的
  `expo.version`、`app.json` 的 `expo.android.versionCode`（规则：
  major×10000 + minor×100 + patch，如 1.6.8 → 10608）。提交信息注明轮次与
  改动（如“第113轮：版本号升到 1.6.8”）。
- CI 会校验三处一致（`yarn check-version`，见 `scripts/sync-version.js`），
  漂移即失败。构建工作流还会再从 `package.json` 派生一次作为兜底，所以即使
  忘了同步，出的 APK 版本号也是对的。
- 曾经漂移过一次：`app.json` 停留在 1.6.1 而 `package.json` 到了 1.6.8，
  且 `versionCode` 从未设置过（所有 APK 都是 versionCode 1），2026-11 审查
  M1 修好。

## 签名

- Release APK 用项目专用的 release keystore 签名（2026-11 审查 H1 之前用的是
  公开 debug key）。机制与 4 个 Secret 见 `docs/release-signing.md`。
- **第一次用新签名的版本**：已装旧版的用户必须先卸载再安装，无法直接覆盖
  更新，发版公告要写明。之后版本之间签名一致，正常更新即可。

## 构建与 Release

- 工作流：`.github/workflows/build-apk.yml`（Build Android APK），在 GitHub Actions 里手动触发（workflow_dispatch）。
- 构建成功后自动创建 Release，附件为 `orionTV.<版本>.apk` 与 `.sha256` 校验文件。
- 每次构建前先确认最新 master 的 CI（`ci.yml`，Typecheck & Lint）是绿的。

## R2 与版本接口

- APK 传到 R2（`dl.ciweihaha.win`），直链形如 `https://dl.ciweihaha.win/orionTV.<版本>.apk`。
- 版本接口由 okys-agg 提供，两条路由都要返回新版本：
  - `https://ysp.ciweihaha.win/agg?ac=oriontv-version`
  - `https://ysp.ciweihaha.win/agg/oriontv-version.json`
- 传 R2 与翻版本接口需要 Cloudflare 凭据，由持凭据的人操作。

## 给用户的链接

- 直链有 4 小时缓存，给用户一律用带版本号参数的链接：`https://dl.ciweihaha.win/orionTV.<版本>.apk?v=<版本>`。
- 发完后核对三项：两条版本接口返回新版本、直链能下载、下载文件的 SHA-256 与 Release 附件一致。

## 完成标准

- 服务端发完 + 用户在电视上验过版本号与修复项，才算发版完成。只验服务端必须说“只验了服务端”。
- 电视端“检查更新”走 GitHub，不受 R2 直链缓存影响。
