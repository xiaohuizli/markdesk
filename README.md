<p align="center">
  <img src="desktop/assets/icon.png" width="96" height="96" alt="Paper Search 图标">
</p>

# Paper Search

一款在本机搜索、阅读 Markdown 和文本文件的桌面工具，支持 macOS 与 Windows 64 位。

打开一个文件夹，即可同时搜索文件内容和文件名。点击匹配结果，直接跳转到文档对应行。安装包内置运行时和 ripgrep，无需额外安装 Node.js。

[下载安装包](https://github.com/xiaohuizli/paper-search/releases/latest) · [构建与验证](https://github.com/xiaohuizli/paper-search/actions/workflows/build-installers.yml) · [发布流程说明](https://github.com/xiaohuizli/paper-search/blob/docs/docs/github-releases.md)

## 下载与安装

当前版本：**v1.4.1**。

此版本修复 macOS 窗口拖动问题：顶部保留独立的原生标题栏，可直接拖动标题栏移动窗口。

| 系统 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS · Apple Silicon（M 系列） | [下载 ARM64 DMG](https://github.com/xiaohuizli/paper-search/releases/download/v1.4.1/Paper.Search-mac-arm64.dmg) | 打开 DMG，将 Paper Search 拖入 Applications |
| macOS · Intel | [下载 x64 DMG](https://github.com/xiaohuizli/paper-search/releases/download/v1.4.1/Paper.Search-mac-x64.dmg) | 打开 DMG，将 Paper Search 拖入 Applications |
| Windows · 64 位 | [下载 x64 安装程序](https://github.com/xiaohuizli/paper-search/releases/download/v1.4.1/Paper-Search-1.4.1-win-x64-setup.exe) | 运行安装向导，选择安装位置和快捷方式 |

macOS 最低版本为 13。Windows 安装程序支持按用户安装，并提供卸载入口。

macOS 安装包采用 ad-hoc 签名，尚未完成 Apple 公证；Windows 安装包尚未配置发行者签名。

## 主要功能

- **文件夹搜索**：同时搜索正文和文件名，输入后自动搜索，结果流式显示。
- **搜索选项**：大小写敏感、Unicode 整词、正则表达式，以及隐藏文件和忽略规则开关。
- **匹配定位**：点击结果打开原文、滚动到目标行并高亮匹配内容。
- **文档阅读**：Markdown 排版预览、源码模式、文内查找和标题大纲。
- **文件导航**：文件树、文件列表、快速打开、原生文件/文件夹选择和拖放打开文件。
- **记录导出**：将当前搜索链路记录保存为本地 JSON，便于排查搜索与定位问题。

软件用于搜索与阅读，当前不提供文档编辑或保存功能。

## 快速上手

1. 启动 Paper Search，默认可阅读内置示例文档。
2. 从“文件 → 打开文件夹…”选择要搜索的目录；也可以打开单个 Markdown 或文本文件。
3. 打开“文件夹搜索”，输入关键词，按需切换大小写、整词或正则选项。
4. 点击结果中的匹配行，查看文档并定位原文。
5. 使用文内查找定位当前文档中的其他内容，或通过快速打开切换文件。

打开单个文件后，搜索范围切换为该文件所在目录。取消选择或读取失败时保留原工作区。

### 常用快捷键

| 操作 | macOS | Windows |
| --- | --- | --- |
| 打开文件 | `⌘ O` | `Ctrl O` |
| 打开文件夹 | `⌥ ⌘ O` | `Ctrl Alt O` |
| 快速打开 | `⇧ ⌘ O` | `Ctrl Shift O` |
| 文件夹搜索 | `⇧ ⌘ F` | `Ctrl Shift F` |
| 文内查找 | `⌘ F` | `Ctrl F` |
| 切换源码模式 | `⌘ /` | `Ctrl /` |
| 显示/隐藏侧边栏 | `⇧ ⌘ L` | `Ctrl Shift L` |
| 导出搜索记录 | `⇧ ⌘ E` | `Ctrl Shift E` |

## 从源码运行与构建

需要 **Node.js 22.12 或更高版本**，建议使用 CI 同系列的 Node.js 24。macOS 原生应用构建还需要 Xcode Command Line Tools。

```sh
git clone https://github.com/xiaohuizli/paper-search.git
cd paper-search
npm ci
```

### macOS

```sh
npm run desktop:build
npm run smoke:mac
npm start
```

构建产物位于 `dist/`，包括当前机器架构对应的 DMG、应用 ZIP 和构建清单。`npm start` 挂载已构建的 DMG 并启动桌面应用。

构建脚本默认下载官方 Node.js 24.19.0 并校验 SHA-256；支持通过 `PAPER_NODE_BINARY` 指定同版本、同架构的独立 Node.js 运行时。

### Windows x64

```sh
npm run desktop:dev:win
```

以上命令启动开发窗口。生成安装程序并验证打包后的应用：

```sh
npm run desktop:build:win
npm run smoke:win
```

NSIS 安装程序位于 `dist/windows/`。

### 前端调试与检查

```sh
npm run web:dev
```

`web:dev` 启动本地网页调试服务，默认地址为 `http://127.0.0.1:4318`。代码检查与测试单独执行：

```sh
npm run check
npm test
```

自动化测试包含真实 ripgrep 搜索、流式结果、匹配定位、路径边界、进程取消和 Markdown 渲染；完整测试套件在 Linux/macOS 运行，Windows 在 CI 中验证打包后的桌面应用。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `desktop/Main.swift` | macOS AppKit / WKWebView 原生宿主 |
| `desktop/electron/` | Windows Electron 宿主与原生桥接 |
| `desktop/assets/` | 两个平台共用的极简图标 |
| `src/` | 本地 HTTP/SSE 服务与 ripgrep 搜索进程管理 |
| `public/` | 搜索界面、文件导航与 Markdown 阅读 |
| `scripts/` | 构建、启动和桌面验证脚本 |
| `test/` | Node.js 自动化测试 |
| `demo/` | 内置示例文档 |
| `.github/workflows/` | GitHub Actions 构建与发布 |

macOS 与 Windows 复用相同的前端和搜索服务。服务仅监听 `127.0.0.1`，接口校验页面会话令牌；桌面宿主限制导航和原生桥接来源。文档预览禁用原始 HTML，远程图片不加载。

## 自动构建与发布

推送 `main` 或手动运行 **Build installers**，会在 GitHub Actions 中生成安装包。推送 `v*` 版本标签后，会在全部验证成功后创建 GitHub Release，并上传 macOS 两种架构与 Windows x64 安装包。

CI 执行代码检查与自动化测试，并在三个目标平台启动打包后的应用，验证界面、原生桥接和真实搜索。Windows 验证对象是打包目录内的应用，不等同于人工交互式安装向导验收。

首页 README 与源码在 `main` 分支，补充文档在 [`docs` 分支](https://github.com/xiaohuizli/paper-search/tree/docs)。

## 支持范围与限制

- 支持 `md / markdown / mdx / mdown / mkd / txt / text / rmd / qmd`，扩展名不区分大小写，文本按 UTF-8 解码。
- 正文搜索每个文件最多 2 MiB、21 个匹配行；每次查询最多 200 个文件、1000 个匹配行，达到上限会提示截断。
- 文件列表最多载入 10000 项，侧栏展示前 500 项。
- 不跟随符号链接；文档读取拒绝越出当前工作区的路径。
- 默认排除隐藏文件并遵守 ripgrep 忽略规则；可以单独切换选项，`.git` 元数据始终排除。
- 跨文件正则使用 ripgrep 默认引擎；文内查找使用 JavaScript 单行正则，两者支持的语法不同。

## 第三方资源

搜索使用 ripgrep，Markdown 渲染使用 markdown-it；相关许可证随依赖或应用分发。部分界面资源来自先前的本地重建，不声明为本项目原创。详见 [资源来源记录](vendor/ASSET-PROVENANCE.md) 与 [随附许可证](vendor/licenses/)。
