---
name: office
description: "当用户需要操作 Doxent / 办公本 / 读写笔记 Office 中心的真实文档或文件夹，包括查看列表、读取文档、创建文件夹、重命名、移动或删除时使用。"
---

# doxent office

## 概览

这个模块只负责真实 Office 中心的文档和文件夹操作。Office 中心与书架、笔记是不同的数据域；用户提到“Office 中心”“Office 文档”或明确要求处理其中的文件夹时进入本模块，不要路由到 `book` 或 `note`。

## 开始前

- 先读 `references/open-model-office-api.md`
- 遵循 `../shared/port-and-health.md`
- 遵循 `../shared/write-and-sync.md`
- **【强制】所有 API 调用必须通过 `../shared/scripts/doxent_api.py` 发送，用法见主 SKILL.md “网络请求规则”**

## 核心流程

1. 通过 `doxent_api.py` 发起请求；脚本会自动检查 Office 服务、唤醒 CLI 并处理端口回退
2. 除根目录新建文件夹外，先用列表接口定位文档和文件夹的真实 `localId`
3. 读取文档时确认下载状态；服务提示未下载完成时等待，不得猜测正文
4. 重命名、移动、删除前展示已定位对象的名称、类型和影响范围
5. 删除文档或文件夹必须得到用户明确确认；文件夹删除会递归删除其中的子文件夹和文档
6. 本轮实际发起过写接口后，按共享规则在整轮结束、最终回复前统一补调一次 `/open-model/sync`

## 接口范围

- `/open-model-office/health`
- `/open-model-office/list`
- `/open-model-office/document/content`
- `/open-model-office/document/rename`
- `/open-model-office/document/move`
- `/open-model-office/document/delete`
- `/open-model-office/folder/create`
- `/open-model-office/folder/rename`
- `/open-model-office/folder/move`
- `/open-model-office/folder/delete`

## 工作规则

- 查找文档或文件夹时，先调用 `list`；未传 `parentId` 表示查询整个 Office 中心，`keyword` 只按名称筛选
- 读取文档传 `localId`。仅 `txt`、`md`、`csv`、`json`、`xml`、`html`、`js`、`ts`、`css` 会返回文本正文；其他已下载文件只能获得文件元数据，不要虚构内容
- 所有文档和文件夹的重命名、移动、删除都必须使用 `list` 返回的真实 `localId`，不要按名称猜测
- 新建根目录文件夹时传 `parentFolderLocalId: "0"`；普通子文件夹传目标父文件夹的 `localId`。旧入口 `"1"` 只由服务端兼容，调用方不要主动使用
- 移动文档或文件夹时，目标根目录传 `parentId: "0"`；目标为子文件夹时传该文件夹的 `localId`
- 文件夹不能移动到自身；根目录不能删除
- 不在最终回复中展示 `localId`、本地路径、同步内部状态或确认令牌

## 响应风格

- `结果`
- `命中项`
- `补充说明`
- `下一步`

删除确认使用主 SKILL.md 的高风险动作确认结构；确认前必须明确说明删除文件夹会同时删除其全部内容。
