# GitHub 构建与发布

仓库：https://github.com/xiaohuizli/markdesk

源码和首页 README 在 `main` 分支，补充说明文档在 `docs` 分支。主分支推送和手动运行 `Build installers` 会构建安装包并保存在 Actions artifacts；推送版本标签（例如 `v1.5.0`）会在全部验证成功后自动生成 GitHub Release。

## 图标

`desktop/assets/icon.png` 是白底薄荷绿放大镜图标的唯一设计源文件。macOS 构建通过 sips/iconutil 生成多分辨率 ICNS；Windows electron-builder 从同一 PNG 生成图标并写入应用和安装程序。`desktop/assets/AppIcon.icns` 保留已安装 macOS 图标的交付文件。旧 Swift 绘图脚本已经移除。

## 构建

需要 Node.js 22.12 或更高版本，CI 使用 Node.js 24。

macOS：`npm ci && npm run desktop:build && npm run smoke:mac`。保持 Swift AppKit / WKWebView 宿主，分别在 Apple Silicon 与 Intel runner 上生成 DMG 和 app ZIP。v1.4.1 恢复独立的原生标题栏，网页位于标题栏下方，可直接拖动标题栏移动窗口。

Windows x64：`npm ci`、`npm run desktop:build:win`、`npm run smoke:win`。Electron 宿主复用原有 HTTP 服务、前端和 ripgrep 搜索，提供原生文件/文件夹选择、记录导出、菜单和拖放打开。NSIS 安装程序位于 `dist/windows/`。Windows 默认以每用户方式安装，支持更改安装目录，包含卸载入口。

## 验证范围

Linux 执行 Node.js 测试；macOS 两种架构和 Windows x64 分别运行打包后的真实桌面程序，验证界面启动、原生桥接及真实搜索；macOS 额外验证独立原生标题栏、可移动配置与非零标题栏高度。Windows 验证启动的是 NSIS 生成时的 `win-unpacked` 应用；不声称已经通过人工交互式安装向导验收。

macOS 使用 ad-hoc 签名，未进行 Apple 公证；Windows 未配置发行者签名。自动发布使用 GitHub Actions 临时令牌，不在仓库保存个人令牌或签名密钥。原始第三方界面资源来源记录见 `vendor/ASSET-PROVENANCE.md`，不将这些资源声明为本项目原创。

## MarkDesk 更名兼容

v1.5.0 将 Paper Search 统一更名为 MarkDesk，应用、菜单、仓库简介、README 和三个平台安装包使用同一名称。macOS 保留原有 bundle identifier 与窗口偏好键，以沿用工作区书签和窗口设置；Windows 首次运行可读取旧版用户目录中的 workspace.json。内部桥接协议和环境变量保留原有名称，以维持兼容。
