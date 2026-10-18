# OpenModel Office 中心接口

所有请求的默认基址为 `http://127.0.0.1:46588`，必须经 `../../shared/scripts/doxent_api.py` 调用。读取接口使用 GET 查询参数；写接口使用 JSON POST body，并按主 SKILL.md 的 `--body-encoded` 规则传递。

## 查询与读取

| 接口 | 方法 | 参数 | 结果与约束 |
| --- | --- | --- | --- |
| `/open-model-office/health` | GET | 无 | 返回 Office 能力是否启用。 |
| `/open-model-office/list` | GET | `parentId?`、`keyword?` | 未传 `parentId` 返回整个 Office 中心；传入子文件夹 `localId` 时只返回其直接内容。返回的文档、文件夹 `id` 是后续调用所需的 `localId`。 |
| `/open-model-office/document/content` | GET | `localId` | 文档尚未下载完成时会失败。文本格式返回 `content`；其他格式只返回 `contentType: "file"` 和文件元数据。 |

## 文档写操作

| 接口 | 方法 | JSON body |
| --- | --- | --- |
| `/open-model-office/document/rename` | POST | `localId`、`name` |
| `/open-model-office/document/move` | POST | `localId`、`parentId` |
| `/open-model-office/document/delete` | POST | `localId` |

## 文件夹写操作

| 接口 | 方法 | JSON body |
| --- | --- | --- |
| `/open-model-office/folder/create` | POST | `name`、`parentFolderLocalId?`；根目录默认值为 `"0"` |
| `/open-model-office/folder/rename` | POST | `localId`、`name` |
| `/open-model-office/folder/move` | POST | `localId`、`parentId` |
| `/open-model-office/folder/delete` | POST | `localId` |

## 标识与根目录

- 列表结果中的 `id` 用作后续请求的 `localId`；它是内部标识，不能在面向用户的最终回复中展示。
- Office 中心真实根目录为 `"0"`。`"1"` 是旧版虚拟入口，服务端兼容但调用方不得主动传递。
- 删除文件夹会递归删除其子文件夹和所有直属文档，执行前必须展示影响范围并取得明确确认。
