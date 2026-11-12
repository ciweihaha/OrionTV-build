# xml/ 目录说明

本目录的文件由 `yarn copy-config`（见 package.json）在 prebuild 之后复制进
原生工程。复制命令是逐文件显式写的，不要改回通配符。

- `AndroidManifest.xml` → `android/app/src/main/AndroidManifest.xml`
  （自定义 manifest：补权限、leanback 入口、明文策略等；prebuild 生成的
  默认 manifest 会被它覆盖。）

将来若要加 res 资源（如 `res/xml/network_security_config.xml`），必须在
copy-config 里单独加一行显式复制到 `android/app/src/main/res/xml/`，并先
`mkdir -p` 目标目录。旧命令 `cp -r xml/* android/app/src/*` 有两个毛病
（2026-11 审查 L14）：`android/app/src/*` 一旦展开为多个目录（如 prebuild
未来生成 `src/debug`）cp 语义即出错；且 res 文件会被放到 `src/main/` 根目录
而非 `res/xml/` 下。
