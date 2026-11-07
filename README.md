# 圆梦同行 桌面客户端（Electron 在线壳）

> **实现方式说明**
> 本仓库 `master` 分支是「网页轻壳」：Electron 加载 https://8811.info/app/ ，
> 与网页版功能完全一致、随网页发版自动更新，三端安装包由 GitHub Actions 构建并发布 Release。
>
> 早期的官方原生桌面端（Electron + Vue3 + TS，v2.1.2）已存档在
> 分支 `legacy/native-vue` 与 tag `native-vue-final-2.1.2`。


把 PC 网页版 https://8811.info/app/ 打包成桌面应用程序。

技术栈：Electron 33 + electron-builder 25。**在线壳**模式——加载线上地址，
网页版一发版，桌面端下次打开就是最新版，不需要重新分发安装包。

## 目录

```
beaver-desktop/
├── package.json          # 依赖 + electron-builder 配置（三平台打包参数）
├── build/icon.png        # 应用图标（取自 App 的 logo，1000x1000）
├── src/
│   ├── main.js           # 主进程：窗口、权限、外链、兜底页、单实例、菜单
│   ├── preload.js        # 只暴露 window.beaverDesktop（无 Node 能力）
│   ├── fallback.html     # 断网/加载失败时的兜底页
│   └── fallback.js
└── dist/                 # 打包产物
```

## 开发 / 运行

```bash
npm install                 # 首次
npm start                   # 打开桌面客户端
npm run smoke               # 无头冒烟：加载页面 + 截图，用于 CI/服务器验证
```

`smoke` 会输出一行 JSON：`{"ok":true,"title":"圆梦同行","url":"...","screenshot":"/tmp/electron-smoke.png"}`。

## 打包

```bash
npm run dist:linux          # AppImage + tar.gz
npm run dist:win            # NSIS 安装包（需在 Windows 上执行）
npm run dist:mac            # dmg（需在 macOS 上执行）
```

> Windows / macOS 必须在对应系统（或对应 CI runner）上构建；
> macOS 还需要开发者证书做签名 + notarize，否则用户首次打开会被 Gatekeeper 拦。
> mac 图标请提供 1024×1024 的 `build/icon.png`（当前是 1000×1000，建议先放大）。

## 针对这个项目的处理

| 问题 | 处理 |
| --- | --- |
| 桌面双栏布局需要宽度 ≥1000 | `BrowserWindow.minWidth = 1000`，低于此值网页会退回手机单列 |
| 语音/视频通话需要麦克风摄像头 | `setPermissionRequestHandler` 只对 `8811.info/app` 放行 `media/notifications/clipboard/display-capture` 等 |
| 外链会跑出应用壳 | `will-navigate` + `setWindowOpenHandler` 一律交给系统浏览器 |
| 断网白屏 | `did-fail-load` → 本地兜底页，可一键重试 |
| 多开 | 单实例锁，第二次启动聚焦已有窗口 |
| 渲染进程崩溃 | `render-process-gone` 自动重新加载一次 |
| 安全 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，preload 不暴露任何 Node API |
| 未读数/标题 | `page-title-updated` 同步到窗口标题（任务栏可显示） |

## 已验证

- 1280×860 窗口加载线上应用，隐私同意页「同意并继续」可见可点；
- 走完 隐私同意 → 登录 → 会话列表，桌面双栏外壳正常；
- 打包后的 AppImage / tar.gz 里的二进制可正常运行（本机缺 libfuse2，
  AppImage 需 `--appimage-extract` 后运行；装有 FUSE 的桌面可直接双击）。

## 托盘 / 未读角标 / 开机自启（已实现）

- **关闭窗口 = 收进托盘**，托盘菜单可「显示主窗口 / 开机自启 / 退出」；托盘提示显示未读数。
- **未读角标**：macOS 用 Dock 角标、Windows 用任务栏覆盖图标、Linux 用启动器角标。
  数据来源两条：
  1. 页面标题形如 `(3) 圆梦同行` 时自动解析；
  2. 网页端主动调用 `window.beaverDesktop.setUnread(3)` 上报（推荐，preload 已暴露）。

  **已完成接入**：`lib/core/desktop/unread_reporter.dart` 包在 MaterialApp builder 里，
  监听 `ChatStore.totalUnreadCount + FriendVerifyStore.unreadCount + NotificationStore.momentUnread`，
  变化时同时调用 `setUnread(total)` 且把标题写成 `(n) 圆梦同行`。
  实测外壳日志：`[unread] 0` / `[unread] 3` / `[unread] 0`（手动 setUnread 验证清理也正常）。
- **开机自启**：Windows/macOS 走 `setLoginItemSettings`，Linux 写
  `~/.config/autostart/beaver-desktop.desktop`；自启时以 `--hidden` 启动（只在托盘）。

## 三端 CI

`.github/workflows/build-desktop.yml`：手动触发或打 `desktop-v*` tag，
在 ubuntu/windows/macos 上分别产出 AppImage+tar.gz / exe / dmg 并作为 artifact 上传。
macOS 签名公证需配置 secrets（见 workflow 内注释）。

## 还没做（按需）

- 自动更新（electron-updater）——在线壳模式一般不需要；
- Windows/macOS 代码签名与分发渠道。
