# Windows 本地编译打包指南

本文记录在本机（Windows）把 Termany 从源码编译成 NSIS 安装包（`*-setup.exe`）的完整流程，
以及实际操作中踩过的坑和绕法。macOS 的对应流程见 `scripts/package-mac-local.sh`。

## 前置条件

| 工具 | 说明 |
| --- | --- |
| Node.js | v22+（开发运行时的版本；打包进 App 的 Node 由脚本单独下载 v24） |
| pnpm / npm | 仓库用 pnpm workspace 管理，根目录已 `npm install` 过即可 |
| Rust 工具链 | `cargo` / `rustc`（rustup 安装，stable 即可） |
| Tauri CLI | 不用单独装，是 `apps/desktop` 的 devDependency（`@tauri-apps/cli`） |
| Git Bash / curl / tar | 下载和解压 Node 运行时要用 |

首次构建前在仓库根目录安装依赖：

```bash
npm install
```

## 打包三步

App 由三部分组装：web 前端、内嵌的 Node PTY 服务器、Tauri 原生壳。
`tauri.conf.json` 里没有配 `beforeBuildCommand`，所以前两步要手动先跑。

### 1. 构建 web 前端

```bash
npm run build:web
```

产物：`apps/web/dist/`（`tauri.conf.json` 的 `frontendDist` 指向这里）。

### 2. 打包 Node 服务端

```bash
npm run bundle:server
```

产物：`apps/desktop/src-tauri/resources/server/`，包含：

- `node.exe` —— 从 nodejs.org 下载的 Node v24.0.0 运行时（Windows 版）
- `server.cjs` —— esbuild 打包的服务端单文件（node-pty 保持 external）
- `node_modules/node-pty/` —— 原生 PTY 组件，只保留 `prebuilds/win32-x64`

### 3. Tauri 构建安装包

```bash
npm -w @termany/desktop run tauri -- build \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Tauri 会自动合并 `src-tauri/tauri.windows.conf.json`（里面声明了 NSIS target、
resources 目录、当前用户安装模式），产出：

```
apps/desktop/src-tauri/target/release/bundle/nsis/Termany_0.1.29_x64-setup.exe
```

`createUpdaterArtifacts:false` 是必须的：自动更新包需要用 updater 私钥签名，
本地没有这把钥匙，不关会直接构建失败。代价是装出来的版本**收不到自动更新**。

## 踩坑记录

### nodejs.org 下载极慢

`bundle:server` 要从 nodejs.org 拉约 30 MB 的 Node zip，国内网络可能只有几 KB/s。
替代方案：用 npmmirror 镜像手动完成这一步（先 `Ctrl+C` 终止脚本）：

```bash
cd apps/desktop/src-tauri/resources/server
curl -fsSL -o node.zip "https://registry.npmmirror.com/-/binary/node/v24.0.0/node-v24.0.0-win-x64.zip"
# 注意用 Windows 自带的 bsdtar 解压 zip；Git Bash 的 GNU tar 不认 zip 格式
/c/Windows/System32/tar.exe -xf node.zip --strip-components=1 -C . "node-v24.0.0-win-x64/node.exe"
rm -f node.zip
./node.exe --version   # 应输出 v24.0.0
```

前提是上一步失败前 `server.cjs` 和 `node_modules/node-pty` 已经生成
（脚本的执行顺序是 esbuild → node-pty → 下载 Node，失败的只是最后一步）。

### `failed to remove file ... target\release\app.exe, Access is denied`

有一个从 `target/release/app.exe` 启动的 Termany 实例还在运行，文件被占用，
链接器无法覆盖。关掉那个窗口再重跑即可（编译缓存都在，重跑只要几分钟）。
注意别用 `taskkill` 强杀：App 退出时会顺带停掉它持有的 PTY 服务器，
强杀可能让里面正在跑的 agent 会话意外终止。

## 安装说明

- 安装包是**未签名**的（本地没有代码签名证书），SmartScreen 会提示
  "Windows 已保护你的电脑" → "更多信息" → "仍要运行"。
- 安装模式是 `currentUser`，不需要管理员权限。
- 卸载/覆盖安装互不影响，数据（工作区布局、滚动历史）在
  `%LOCALAPPDATA%\ai.termany.desktop\` 下，不随卸载删除。

## 正式发版（参考）

本地打包只适合自用。正式发版走 GitHub Actions（`.github/workflows/build.yml`），
一次产出四个平台的安装包（mac 签名+公证、Windows NSIS、Linux AppImage/deb）：

```bash
# 1.  bump 版本号（根 package.json + src-tauri/tauri.conf.json）
# 2.  打 tag 推送，CI 自动构建并生成 draft release
git tag v0.1.30 && git push origin v0.1.30
```
