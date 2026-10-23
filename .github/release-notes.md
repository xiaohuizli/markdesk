MarkDesk v1.5.0：Markdown 文档工作台。

- Paper Search 正式更名为 MarkDesk，统一软件名称、菜单、仓库与安装包名称。
- 保留 macOS 原有工作区和窗口设置；Windows 可读取旧版工作区设置。
- 修复 macOS 窗口难以拖动：恢复独立的原生标题栏，网页内容不再延伸到窗口拖动区域。
- 正文仍可正常选择和复制，顶部功能按钮仍可点击。
- 保留白底、薄荷绿放大镜极简图标。
- macOS Apple Silicon：下载 `MarkDesk-mac-arm64.dmg`。
- macOS Intel：下载 `MarkDesk-mac-x64.dmg`。
- Windows 64 位：下载 `MarkDesk-1.5.0-win-x64-setup.exe`，支持选择安装位置、桌面和开始菜单快捷方式。
- 所有安装包均内置搜索运行时，无需单独安装 Node.js。

自动构建会验证原生/桌面窗口启动、前端桥接和真实 ripgrep 搜索，macOS 额外校验独立原生标题栏与可移动配置。macOS 为 ad-hoc 签名，未进行 Apple 公证；Windows 安装包未配置发行者签名。
