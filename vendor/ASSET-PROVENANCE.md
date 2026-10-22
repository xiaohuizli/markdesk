# 本地界面重建资源来源

`public/assets/github.css`、Open Sans woff2、typora-icon、Ionicons、Font Awesome 资源来自用户提供的 Typora 1.14.10 安装包。GitHub 主题只重写本地字体 URL；三个搜索 SVG 直接提取原 index.html 的 symbol，未绘制替代图标。来源原始文件和摘要见 `docs/ui-source-evidence.md`。这是供用户本地分析与重建验证的资源来源记录，不宣称这些原始资源由本项目原创。

`public/assets/markdown-it.min.js` 来自 npm `markdown-it@14.3.3`，许可证见 `vendor/licenses/markdown-it-LICENSE`。它用于禁用原始 HTML 的文档预览。Node 与 ripgrep 的许可证随应用 Resources/Licenses 和依赖一并保留。

`docs/ui-reference/` 中的三张图片来自 Typora 官方 Search 文档（2022截图），仅为界面对照证据，不作为产品页面资源。
