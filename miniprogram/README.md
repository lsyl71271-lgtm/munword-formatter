# 模联助手 · 微信小程序（排版部分）

网页版的四步排版移植成了微信小程序：

1. 选择文件类型
2. 从聊天里选原稿
3. 确认识别结果（这一步始终可以手动修改）
4. 生成 DOCX，然后预览、发回聊天或保存

另外有「从规范模板新建」和「关于与隐私」两页。

排版引擎就是网页版用的那一份（`app/` 下的 TypeScript），没有另写，也没有改动。文件只在手机上处理，小程序不发任何网络请求，所以也不需要配置服务器域名。

## 用微信开发者工具打开

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（稳定版）。
2. 选「导入项目」，目录选**本文件夹**（`miniprogram/`），不要选仓库根目录。
3. AppID：
   - `project.config.json` 里的 `touristappid` 是占位值，只能在模拟器里看界面。
   - 要真机预览、发体验版，请换成你自己的 AppID。
   - 在[微信公众平台](https://mp.weixin.qq.com/)注册小程序即可获得，个人主体就能用这一部分功能。
4. 点「编译」：模拟器里选一个 .docx，就能走完四步。
5. 点「预览」用手机扫码，在真机上试。

## 发布前要在小程序后台做的事

- **用户隐私保护指引**：
  - 在「设置 → 服务内容声明 → 用户隐私保护指引」里声明使用了「选择文件（用户选中的文件）」。
  - 不声明的话，`wx.chooseMessageFile` 会被微信直接拒绝。
  - 用途可以写：选择需要排版的模联文件，文件只在本机处理，不上传。
- **服务类目**：排版功能可选「工具 → 办公」一类。以后加 AI 问答，要另按深度合成类目和主体要求办理，见方案文档。
- **基础库**：`project.config.json` 里设的是 2.33.0；后台「最低基础库版本」建议也设为 2.33.0 左右。

## 目录

| 路径 | 内容 |
| --- | --- |
| `app.js` / `app.json` / `app.wxss` | 入口、页面列表、公共样式 |
| `pages/index/` | 四步排版主页 |
| `pages/template/` | 从规范模板新建文件 |
| `pages/about/` | 版本、UNTERM 核对日期、隐私说明 |
| `utils/flow.js` | 和网页一致的规则：文件类型、第 03 步字段、文件名选项、提示文字。不依赖 `wx`，方便测试 |
| `utils/files.js` | 选文件、读写、预览、发回聊天、保存（只写小程序自己的目录） |
| `lib/munword-engine.js` | **生成文件，不要手改**。由 `miniprogram-engine/build.mjs` 把 `app/` 的引擎打包成一个 CommonJS 文件 |

仓库根目录下和小程序有关的文件：

| 路径 | 内容 |
| --- | --- |
| `miniprogram-engine/entry.js` | 打包入口：引擎对外的函数 |
| `miniprogram-engine/runtime.js` | 小程序没有的浏览器对象的替身：`DOMParser`、`XMLSerializer`（基于 docxtemplater 已依赖的 @xmldom/xmldom）、`TextEncoder`、`TextDecoder`、`Blob`；还有 iOS 16.4 以前不支持的正则后行断言的替代实现 |
| `miniprogram-engine/build.mjs` | 打包脚本 |
| `tests/miniprogram.test.mjs` | 引擎打包后与网页引擎逐个比对 |
| `tests/miniprogram-pages.test.mjs` | 页面在模拟的微信环境里走完全部流程 |

## 改了引擎之后

`app/` 里的排版代码改了以后，要重新打包，再跑测试：

```bash
node miniprogram-engine/build.mjs
node --test tests/miniprogram.test.mjs tests/miniprogram-pages.test.mjs
```

CI（`source-checks`）会运行 `node miniprogram-engine/build.mjs --check`。如果 `lib/munword-engine.js` 没有跟着重新打包，这一步会失败。

## 已经验证的

- **引擎一致**：在一个没有 DOM、没有 Blob/TextEncoder/Buffer 的纯 JavaScript 环境里加载打包后的引擎，结果与网页引擎相同。比对范围：
  - 仓库里 14 份样例 × 8 种文件类型的识别结果、校验结果、文件名和输出的每一个文件部件
  - 第 03 步修改后的输出
  - 8 种类型 × 中英文的模板
- **老 iOS**：模拟不支持后行断言的环境（iOS 16.4 以前），外交协定和联合声明的结果仍与网页一致。
- **原有测试**：网页版 249 个单元测试，换成小程序的替身对象后仍然全部通过。
- **页面**：在模拟的微信逻辑层里，用 14 份样例点完四步。写出的 DOCX、文件名、校验列表都和网页版相同。还覆盖了：
  - 第 03 步改字段
  - 生成过程中改字段（旧结果作废）
  - 选错文件类型、超过 20 MB、取消选择
  - 模板页的全部类型和语言
  - 预览、发回聊天、保存的调用
- **静态检查**：
  - WXML 绑定的每个事件和数据都存在
  - 输入框没有 140 字上限
  - 样式没用老版本微信不支持的 `gap`
  - 主包小于 2 MB（目前约 0.55 MB）
- **原有功能**：网页、桌面安装包、安卓的代码和构建记录都没有改动。

## 还需要你在开发者工具和真机上确认的

这台云端机器是 Linux，装不了微信开发者工具，下面这些只能由你来看：

- 界面在不同尺寸手机上的样子，深色模式。
- 真机上 `chooseMessageFile`、`openDocument` 预览、`shareFileMessage` 发回聊天是否正常。电脑版微信上是 `saveFileToDisk` 保存。
- 低端安卓机上大文件的识别和生成耗时。引擎是同步运行的，处理时会显示「正在识别…/正在生成…」遮罩。
- 预览里的字体和分页以 Word / WPS 为准，微信内置预览只作参考。
