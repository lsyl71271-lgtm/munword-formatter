# 文档导航

## 先看这些

| 文档 | 读者 | 内容 |
|---|---|---|
| [../README.md](../README.md) | 所有人 | 是什么、四种用法、下载与开发入口 |
| [安装教程](../downloads/PKUNMUN2026-Install-Guide.txt) | 普通用户 | Mac、Windows 与安卓手机的安装步骤、弹窗处理、旧系统与旧浏览器怎么办 |
| [website-capacity.md](website-capacity.md) | 组织者、维护者 | 网页版能扛多少人、哪里会慢、什么情况下会出问题 |

## 程序是怎么做的

| 文档 | 内容 |
|---|---|
| [IMPLEMENTATION_SPEC.md](IMPLEMENTATION_SPEC.md) | 实现与需求规格：每一处逻辑、界面、本机应用、构建与测试，足以从零复原本程序 |
| [architecture.md](architecture.md) | 模块边界与端到端执行步骤 |
| [adr-0001-shared-daily-interface.md](adr-0001-shared-daily-interface.md) | 决策记录：网页、本机、桌面（以及后来的安卓）共用一套界面和一个浏览器引擎 |
| [migrate-from-local-service.md](migrate-from-local-service.md) | 已装旧版本机服务（Python 后台服务）的用户怎样换到桌面安装包、删除旧版 |
| [handbook-alignment.md](handbook-alignment.md) | 每条排版规则对应学标手册的哪一页 |
| [../desktop/README.md](../desktop/README.md) | 桌面安装包的构建、验收与签名 |
| [../android/README.md](../android/README.md) | 安卓安装包的组成、旧 WebView 兼容层、构建、签名与验收 |
| [../templates/pkunmun2026/README.md](../templates/pkunmun2026/README.md) | 为什么没有 Word 模板文件：规则全部在 `shared/document-policy.json` |

## 版本说明（新 → 旧）

[2.0.0](release-2.0.0.md) · [1.9.0](release-1.9.0.md) · [1.8.5](release-1.8.5.md)：下载页（GitHub Releases）上仍有这三个版本。

[1.6.3](release-1.6.3.md) 保留，因为学标版式规则（`shared/document-policy.json`）引用了其中的渲染测量摘要。

## 历史记录

1.7.0–1.8.4 的版本说明、2026 年 9–10 月的审计与集成记录、首次导入 GitHub 的记录，已在 2026-10-24 整理仓库时移出。需要时可在 git 历史中查看：最后包含它们的提交是 `5b7ca73`。
