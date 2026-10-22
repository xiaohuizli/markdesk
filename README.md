# Paper Search

本地 Markdown / 文本搜索与阅读工具，支持 macOS 与 Windows 64 位。使用白底薄荷绿放大镜图标。

源码：[xiaohuizli/paper-search](https://github.com/xiaohuizli/paper-search) · [下载安装包](https://github.com/xiaohuizli/paper-search/releases) · [构建记录](https://github.com/xiaohuizli/paper-search/actions)

## 安装

- Apple Silicon Mac：下载 `Paper Search-mac-arm64.dmg`，将应用拖入 Applications。
- Intel Mac：下载 `Paper Search-mac-x64.dmg`。
- Windows 64 位：下载 `Paper-Search-1.4.0-win-x64-setup.exe`，跟随向导安装。可选择安装目录，并创建桌面和开始菜单快捷方式。

安装包内置运行时与 ripgrep，无需单独安装 Node.js。macOS 最低 13；Windows 面向 Windows 10/11 x64。macOS 使用 ad-hoc 签名，未完成 Apple 公证；Windows 未配置发行者签名。

## 使用

打开文件或文件夹，搜索 Markdown / 文本内容和文件名。支持大小写、整词、正则、隐藏/忽略文件选项；结果流式呈现，点击匹配行可定位原文。支持文内查找、快速打开、文件树、大纲、源码模式、拖放打开文件和 JSON 搜索记录导出。软件提供搜索与阅读，不提供文档编辑或保存。

macOS 使用 Command，Windows 使用 Ctrl：O 打开文件，Alt+O 打开文件夹，Shift+O 快速打开，F 文内查找，Shift+F 文件夹搜索。

## 从源码构建

需要 Node.js 22.12+；CI 使用 Node.js 24。

```sh
npm ci
npm run check
npm test
```

macOS 需要 Xcode Command Line Tools：

```sh
npm run desktop:build
npm run smoke:mac
npm start
```

Windows：

```sh
npm run desktop:build:win
npm run smoke:win
```

Windows 开发窗口：`npm run desktop:dev:win`。仅调试前端：`npm run web:dev`。

macOS 保留 Swift AppKit / WKWebView 原生宿主；Windows 使用 Electron 宿主。两者复用本地 HTTP/SSE 服务、前端和真实 ripgrep 搜索。服务只监听 127.0.0.1，接口校验页面会话令牌，桌面宿主限制页面导航与原生桥接来源。

## 自动发布

推送 main 或手动运行 Build installers，会生成 Actions artifacts。推送版本标签会在 macOS 两种架构与 Windows x64 验证成功后发布安装包。详见 [GitHub 构建与发布](docs/github-releases.md)。

源码在 main 分支，文档在 docs 分支。第三方界面资源来自先前本地重建，不声明为本项目原创；见 [资源来源](vendor/ASSET-PROVENANCE.md)。

## 限制

支持 md、markdown、mdx、mdown、mkd、txt、text、rmd、qmd，文本按 UTF-8 解码。每个正文文件最多 2 MiB、21 个匹配行，每次查询最多 200 个文件、1000 个匹配行。不跟随符号链接；拒绝读取工作区外的文件。文件列表最多载入 10000 项，侧栏展示前 500 项。文档预览禁用原始 HTML 和远程图片。Windows 自动验收会启动打包的应用并执行真实搜索，未声称完成人工交互式安装向导验收。
