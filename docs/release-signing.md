# Release 签名说明

## 背景

2026-11 审查（H1）发现：Expo 生成的 `android/app/build.gradle` 会把 release
buildType 硬编码为 `signingConfig signingConfigs.debug`，而构建工作流没有任何
签名步骤——所以历次 Release 的 APK 都是用公开的 Android debug key
（`android/android`）签名的。任何人都能用同一把公开 key 制作同包名
（`com.oriontv`）的恶意 APK，以“更新”方式覆盖安装到用户电视上。

现在 Release APK 改用项目专用的 release keystore 签名。

## 机制

1. **Config plugin**：`plugins/withReleaseSigning.js`（已在 `app.json` 注册）
   在 prebuild 时向生成的 `app/build.gradle` 注入一个 `release`
   signingConfig，从 Gradle 属性（`ORIONTV_RELEASE_*`）读 keystore 信息，
   并让 release buildType 在属性存在时用它、不存在时回落到 debug key。
   本地没有这些属性时 `expo prebuild` 照常工作；模板变了导致注入锚点失效时
   prebuild 直接抛错，不会静默出 debug 签名包。
2. **工作流**（`build-apk.yml`）：构建前先检查 4 个 Secret 是否齐全（缺失即
   失败）；prebuild 后把 keystore 从 Secret 还原到
   `android/app/release.keystore`，并把 4 个签名属性经
   `ORG_GRADLE_PROJECT_*` 环境变量传给 Gradle（不用写 `gradle.properties`
   文件，避免密码里的特殊字符被 properties 语法误解析）；构建后用
   `keytool -printcert` 验证 APK 证书不是 debug 证书。
3. **Keystore 与密码只存在于 GitHub Secrets 和 runner 临时文件里**，
   不进仓库（`.gitignore` 已加 `*.keystore`）。

## 需要的 4 个 GitHub Secrets（仓库 Settings → Secrets and variables → Actions）

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 的 store 密码 |
| `ANDROID_KEY_ALIAS` | key 别名（当前为 `oriontv-release`） |
| `ANDROID_KEY_PASSWORD` | key 密码 |

## 签名迁移（只影响第一次用新签名的版本）

签名换了之后，已安装旧版（debug 签名）的电视**无法直接覆盖安装**新版，
必须先卸载旧版再装新版（应用内更新也会失败，提示签名不一致）。发版公告里
要写明这一点。之后的新版本之间签名一致，正常更新即可。

## Keystore 备份与轮换

- **Keystore 一旦丢失无法找回**：GitHub Secrets 的值读不回来，只能重建；
  重建等于换签名，所有已安装用户又要卸载重装一次。所以 keystore 文件与两
  个密码必须另存一份在安全位置（密码管理器或加密盘），不要只依赖 Secrets。
- 轮换流程：生成新 keystore → 更新 4 个 Secret → 发版公告提醒用户卸载重装。
  只有在 keystore 泄露或丢失时才轮换。
- 当前 keystore：RSA 2048，别名 `oriontv-release`，有效期 10000 天
  （2026-11 生成，到 2054 年）。
