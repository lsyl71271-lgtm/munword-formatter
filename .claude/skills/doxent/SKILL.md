---
name: doxent
display_name: 讯飞办公本
display_name_en: Doxent Workspace Assistant
description: "当用户要读取或操作 Doxent / 办公本 / 读写笔记中的真实数据时使用：搜索、读取、创建、重命名、移动或删除笔记和文件夹；读取、重命名、移动或删除 Office 中心文档与文件夹；导入或上传书籍；查看、创建、修改、删除、完成或移动日程、提醒、待办和任务。也用于安装、启动、登录、停止或更新 Doxent CLI。覆盖“读取 Office 中心合同”“把 Office 文档移到项目文件夹”“写笔记并保存到办公本”“上周创建了哪些笔记”“明天提醒我开会”等表达。不要用于仅生成聊天文本、编辑本地文档或操作其他应用数据，除非用户明确要求保存到 Doxent。"
description_zh: "读取和操作办公本/读写笔记中的真实笔记、Office 文档、书籍、日程、提醒、待办与任务，并管理 Doxent CLI。"
description_en: "Read and manage real notes, Office documents, books, schedules, reminders, to-dos, and tasks in Doxent, and manage the Doxent CLI."
category: productivity
version: 1.3.8
author: 讯飞读写
---

# doxent

统一的 Doxent skill，当前支持：**note**、**office**、**book**、**schedule**。

## 概览

这个 skill 是 Doxent / 读写笔记真实数据操作的统一入口。
当用户目标涉及真实笔记、Office 中心文档、书架文件、日程或任务时，先命中 `doxent`，再按意图路由到具体模块。

## 路由优先级

- 只要一句话里同时出现“时间表达” + “事项/动作”，默认优先路由到 `schedule`。
- 这里的时间表达包括但不限于：`今天`、`明天`、`后天`、`今晚`、`明早`、`下午`、`9点`、`3:30`、`下周一`、`周五前`、`月底`。
- 这里的事项/动作包括但不限于：`开会`、`约`、`提醒`、`安排`、`改到`、`延期`、`提前`、`完成`、`提交`、`处理`。
- 即使用户没有说“日程 / 任务 / 提醒 / event / task”，也不要优先理解成 `note`。
- 只有当用户明确说“写笔记”“记一条笔记”“写会议纪要”“生成摘要”“记录这段内容”时，才优先路由到 `note`。

## 环境说明

> 运行时依赖见 `meta.json`。

鸿蒙系统（HarmonyOS/OpenHarmony）按 CPU 架构选择独立目录包：ARM64/aarch64 使用 ARM64 包，x64/x86_64/AMD64 使用 x64 包；选包不限制 HarmonyOS 版本或芯片型号。宿主需提供 Python 3.8+，并满足对应包的运行时要求。鸿蒙安装、运行时排障或平台误识别时，读取 [鸿蒙安装与诊断](shared/port-and-health.md#鸿蒙安装与诊断)。

## CLI 业务地址发现

真实数据请求必须先通过 `doxent-cli --doxent-cli-endpoint` 查询当前 CLI daemon 的控制通道。仅当响应中的 `data.runtime=cli`、`data.coreState=running`、`data.baseUrl` 为本机回环地址且端口字段一致时，Skill 才能向 OpenModel 业务接口发请求。不得再把默认端口、共享 `open_model_config.json`、Electron health 或任意本地端口作为 CLI 地址；CLI 更新、重启、连接失败或端口变化后必须重新查询 endpoint。

## CLI 生命周期与登录

**远端页面先按显式类型分流**：CLI 的远端区块必须恰好包含一个可见的 `页面类型：登录` 或 `页面类型：设置`。该字段是选择“远端登录回复模板”或“远端设置回复模板”的唯一分流依据；`<!-- doxent-cli-remote-login:start -->` 与 `<!-- doxent-cli-remote-login:end -->` 起止标记只用于界定区块，不代表登录页面。不得根据命令名、URL 路径、查询参数或二维码内容猜测类型，也不得在展示前执行 `--cli-action login-status` 预判页面类型。类型字段缺失、重复或非法时，对本次调用的原动作最多重试一次；仍不合法则明确报告 CLI 远端页面输出异常，不套用登录或设置模板、不改跑其他动作。

**远端入口统一仅展示链接**：图形客户端、终端 TUI 和界面能力未知的宿主均使用下方同一套登录或设置模板，只展示 CLI 返回的真实链接和操作提示，暂不展示 PNG 或字符二维码；不再判断图片能力或切换二维码载体。

**检测到未登录必须直接给出登录地址**：适用于所有模块，包括调用前检查、查询失败后的会话复核，以及用户确认登录后复查仍未登录。暂停数据调用；若本次工具输出已包含完整有效的远端登录入口，直接按下方模板展示；否则立即执行 `--cli-action login` 获取入口，按唯一 `页面类型` 和“远端入口输出完整性”规则展示真实的可点击链接，再等待用户完成操作。获取登录入口不需要另行征求用户同意，不能只回复“尚未登录”“请先登录后重试”，也不能让用户自己查找登录地址。仅在获取入口失败且按规则重试后仍无法取得完整链接时，才说明具体失败原因；不得编造登录地址。

所有 API 请求都通过 `shared/scripts/doxent_api.py`。脚本按 `DOXENT_CLI_PATH`、用户级 CLI 目录、`app_launch.json` 和 Doxent 安装目录的顺序查找 CLI；入口缺失时按当前系统与 CPU 架构自动下载。Windows 保存为 `%LOCALAPPDATA%\Doxent\CoreCLI\doxent-cli.exe`；macOS/Linux 下载各自发布文件后统一重命名为 `~/.local/bin/doxent-cli`、赋予执行权限，并把该目录和 `DOXENT_CLI_PATH` 幂等写入登录 shell 环境。OpenHarmony 完整解包到用户数据目录，通过同名 `~/.local/bin/doxent-cli` 包装入口调用包内启动器。无论平台，后续命令都使用 `doxent-cli xxxx` 语义。即使本地服务已经健康，也要先完成一次轻量版本指纹检查，不能跳过更新判断。

- Windows EXE 仅用于解压安装；脚本按包摘要缓存 runtime + JS，日常命令直接运行 Node，并设置资源目录环境变量，确保登录输出能被捕获。不要改回通过 EXE/BAT 转发业务命令。
- Doxent CLI 无参数即可启动后台 Core；不要传 Ainote 专用的 `--background-open-model`。
- Windows/macOS/Linux 启动时自动复用 `DOXENT_NODE`、系统 PATH 或 Codex 自带的 Node 18+ 运行时，并把路径注入隐藏子进程，不要求用户手工配置。OpenHarmony 内置包使用包内 Node；external 包只接受平台与包架构一致的 OpenHarmony Node 18+（ARM64 或 x64），环境缺失时报告依赖要求，不能注入普通 Linux 或 Codex Node。
- 通过 skill 启动、登录、帮助、停止或打开设置页时必须使用隐藏控制台模式，不要弹出新的终端窗口。普通登录和设置只展示 CLI 返回的远端入口；仅用户明确要求本机浏览器入口时使用 `login-browser`。
- 首次启动或 CLI 会话失效时，按 CLI 返回的登录入口引导用户完成登录，不要把账号密码写入命令、日志或请求体。
- 数据接口调用前先用 `--cli-action login-status` 检查登录状态；未登录则按上方“检测到未登录必须直接给出登录地址”规则处理；查询失败不等于未登录。
- 数据接口调用若出现“启动后 15 秒内未提供本地服务”、本地连接失败或同类查询失败，先由脚本无副作用复核一次 CLI 登录状态；若结果为未登录，按上方规则获取并展示登录地址，不能停在脚本的错误提示；若已登录，再提示本地服务启动失败并建议稍后重试。不能仅凭启动超时判断为服务故障，也不能用 health 请求替代登录状态复核。
- 已有 CLI 会话会被复用；可使用 `$PYTHON_BIN shared/scripts/doxent_api.py --cli-action login` 打开账号管理页，或使用 `--cli-action logout` 清除 CLI 会话。
- 当 CLI 输出上述远端页面区块时，先按唯一 `页面类型` 选择对应回复模板，再按“远端入口输出完整性”检查真实链接。最终回复仅展示地址和操作提示，不整体转发含二维码的原始区块；二维码缺失或显示失败不触发重试。
- 当用户要求打开或配置“数据查询设置页”“笔记查询时间范围”时，使用 `$PYTHON_BIN shared/scripts/doxent_api.py --cli-action settings`。该命令原样接收既有 `doxent-cli --settings` 的输出，不主动打开浏览器；大模型依据返回的唯一 `页面类型` 选择“远端登录回复模板”或“远端设置回复模板”，仅展示真实链接和操作提示。未登录时该动作可能返回登录页面，不能按动作名强制套用设置模板；用户进入设置页后可设置笔记查询范围，不要直接读写账号设置文件。
- 只有用户明确表达“上传日志”“提交日志”“发送日志”等上传意图时，才运行 `$PYTHON_BIN "$DOXENT_SKILL_ROOT/shared/scripts/doxent_api.py" --cli-action upload-logs`。该动作由 CLI 收集自己的日志目录、压缩并关联当前登录用户提交，不要求账号是手机号，也不提交手机号或 `address` 字段，Skill 必须原样返回最终成功或失败提示。若 CLI 返回远端页面区块，先按唯一 `页面类型` 选择对应的仅链接模板；仅当类型为登录时，等待用户确认完成登录后再执行 `--cli-action login-status`，结果为“已登录”时才重新执行一次 `--cli-action upload-logs`。不得把登录成功猜测为上传成功。用户只是要求“查看日志”“分析日志”“排查问题”时不得自动上传，也不要改用 OpenModel API、手工查找日志或自行拼上传接口。
- Doxent CLI 按常驻后台 daemon 方式运行；鸿蒙宿主关闭终端后的驻留能力需真机验收。只有用户明确要求停止时，才执行 `--cli-action stop`。
- CLI 参数以当前安装版本的 `doxent-cli --help` 为准。安装 skill 后首次排障或发现参数不兼容时先运行 `--cli-action help`，不要自行假设存在 `--version`。
- CLI 自动安装不需要管理员权限；下载采用临时文件、平台格式、最小体积和 SHA-256 校验后再原子落盘。Windows 校验 PE 文件头，macOS/Linux 校验带内嵌 payload 标记的 POSIX 单文件。云端 `ETag`、`Last-Modified` 或文件摘要发生变化时，即使语义版本号未变化，也要停止旧 daemon、替换用户级 CLI 并自动重新启动。CLI 重新构建后必须重新上传该平台/架构地址对应的文件。
- CLI 启动后立即执行一次增量同步；首次笔记尚未全量完成时保持每批 50 条、严格串行，并在每批结算 10 分钟后补下一批，完成后恢复每 30 分钟全领域增量同步。共享 API 客户端最长等待 5 分钟并轮询本机 `/sync/status`：批次运行中必须等待；批次已结算且处于 `partial_idle` 时，按 `shared/scripts/doxent_api.py` 中的读写白名单放行。列表、搜索、正文等白名单 GET 必须原样保留提示“首次全量同步尚未完成，当前查询仅基于已同步到本地的部分数据，结果可能缺失或不是最新；CLI 将继续分批同步。”已知业务写接口统一以 POST 调用，白名单覆盖 note、office、schedule、book 的创建、修改、移动、重命名、删除、任务操作和上传，必须原样保留提示“首次全量同步尚未完成，本次写操作将基于已同步到本地的数据执行；CLI 将继续分批同步。”部分读取完整消费并关闭响应后，客户端通过既有 CLI daemon 控制通道 best-effort 请求尽快执行下一批，失败只保留 10 分钟兜底，不覆盖业务结果。单次业务写请求不触发该补批通知；一整轮用户请求中实际发起过增删改等写接口后，必须按 `shared/write-and-sync.md` 在整轮操作结束、最终回复前统一调用一次 `POST /open-model/sync`，不要逐条补调。该同步接口也在 POST 白名单内，首次部分空闲时允许调用，但不发送只读补批通知；未知路径和不匹配的方法仍不放行。`/sync/status` 轮询和非部分空闲状态也不得触发补批。首次全量完成后恢复严格等待当前同步结算；若最近一轮存在部分同步异常，继续查询但必须提示“结果可能不完整”。旧 CLI 缺少部分状态字段、状态异常、接口不可用或超时时一律失败关闭，不能猜测本地缓存可用。
- 如果同步等待超时，必须停止本次业务请求并提示用户稍后重试，不能降级为返回可能过期的数据。

## 模块路由

| 用户意图 | 模块 | 读取 |
| --- | --- | --- |
| 搜索笔记、读取正文、创建/移动/重命名/删除笔记或文件夹 | note | `note/MODULE.md` |
| 查看、读取、重命名、移动或删除 Office 中心文档；创建、重命名、移动或删除 Office 中心文件夹 | office | `office/MODULE.md` |
| 上传书籍、本地文件导入、远程 URL 导入书架 | book | `book/MODULE.md` |
| 查看日程、创建/修改/删除事件、提醒、待办或任务，以及任何用自然语言表达的时间安排请求（如“明天早上9点开晨会”） | schedule | `schedule/MODULE.md` |

## 共享规则

- 端口与健康检查：`shared/port-and-health.md`
- 写操作与同步：`shared/write-and-sync.md`


## 数据访问边界（强制）

- 获取 Doxent 真实数据必须通过 Doxent CLI：使用当前 skill 的 `shared/scripts/doxent_api.py` 调用 CLI 命令或 CLI daemon 提供的接口。登录状态、笔记、Office 文档、书籍、日程、任务和设置均遵守此规则。
- 禁止 Agent 自行扫描、遍历、搜索或读取 Doxent 缓存目录、数据库、索引、会话文件或账号配置来获取、补全或推断数据；不得通过 shell、Python、SQLite 或其他工具绕过 CLI。
- CLI 未登录、返回空结果、失败、超时或数据尚未同步时，只能按 CLI 返回结果处理；不得以排障、兜底或加速为由改查本地缓存。CLI 未提供所需能力时，应如实说明，不能自行拼接缓存路径。
- 登录和设置回复不读取、验证或展示 CLI 返回的二维码文件或字符矩阵，也不扫描二维码缓存目录、寻找历史二维码。
- 上述限制针对 Agent 自行取数；既有 `doxent_api.py` 和 CLI 内部的运行时发现、安装、同步及缓存管理仍由程序执行，不由 Agent 手工复刻。

## 网络请求规则

**强制，无例外**：所有 Doxent API 调用必须通过 `shared/scripts/doxent_api.py` 发送，禁止直接使用 `Invoke-RestMethod` 或 `curl`。
**强制，无例外**：不要裸调用 `python`。优先使用环境变量 `DOXENT_PYTHON`；如果为空，在 macOS / Linux / OpenHarmony / zsh / bash 下使用 `python3`，在 Windows 下使用 `py -3` 或 `python3`。
**强制，无例外**：先把当前已加载 `SKILL.md` 所在目录解析为 `DOXENT_SKILL_ROOT`，再调用其中的脚本；不得假设项目内存在固定的 Skill 副本，也不得要求用户查找或输入 Skill 安装路径。

### 命令执行环境（强制）

- 调用 `doxent_api.py` 及其 CLI 生命周期命令时，只要宿主执行工具支持选择执行权限或沙箱模式，就必须显式选择**非沙箱环境**；本机回环端口、用户级 CLI、登录会话、应用配置和后台进程在沙箱中可能不可见，不能把沙箱内的失败直接判定为 Doxent 不可用。
- 如果无法预先选择非沙箱环境，允许先按宿主默认模式执行；当失败明确表现为沙箱权限、网络隔离、本机端口不可达、用户目录或 CLI 不可见、子进程无法启动时，必须保持原命令和参数不变，在非沙箱环境中重试一次，再判断最终结果。
- 对只读请求和明确未发出的写请求，可按上一条直接重试。若写请求可能已经送达但返回结果不明，不得盲目重放；应先通过 CLI 查询目标状态，确认未生效后再在非沙箱环境中重试，避免重复创建、移动、重命名或删除。
- 如果宿主不提供非沙箱执行能力或拒绝提升执行权限，应如实报告该环境限制，不得改用缓存、数据库、`curl` 或其他路径绕过 CLI。

> **原因**：PowerShell 5.1 在两个环节都会静默损坏中文：① 请求 Body 从 UTF-8 重编码为 GBK；② 命令行参数传递给外部进程时同样如此。因此 `--body '...'` 字符串参数在 Windows 下**不安全**，必须改用文件。

### GET 请求

```bash
PYTHON_BIN="${DOXENT_PYTHON:-python3}"
"$PYTHON_BIN" "$DOXENT_SKILL_ROOT/shared/scripts/doxent_api.py" \
    --url "http://127.0.0.1:46588/open-model-schedule/health" \
    --token "$TOKEN"
```

### POST / PUT 请求（必须使用 --body-encoded）

```bash
# 1. 构建 JSON
PYTHON_BIN="${DOXENT_PYTHON:-python3}"
body='{"type":"event","title":"标题","startTime":1234567890}'

# 2. URL percent-encode（输出纯 ASCII，彻底绕过所有编码层）
encodedBody=$("$PYTHON_BIN" -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$body")

# 3. 通过 --body-encoded 传给脚本
"$PYTHON_BIN" "$DOXENT_SKILL_ROOT/shared/scripts/doxent_api.py" \
    --url "http://127.0.0.1:46588/open-model-schedule/create" \
    --method POST \
    --body-encoded "$encodedBody" \
    --token "$TOKEN"
```

> **为什么 URL 编码最安全**：URL percent-encode 会把所有非 ASCII 字符（含中文）转为 `%E6%99%A8` 这样的纯 ASCII 序列。ASCII 不受任何编码层影响，Python 收到后 `unquote` 还原为正确 Unicode，再 encode('utf-8') 发送。
>
> ❌ **绝对不要这样写**（中文必乱码）：
> ```powershell
> python doxent_api.py --body '{"title":"标题"}' ...
> ```

脚本执行真实数据请求时会先确保 CLI daemon 已启动，完成请求后保持 daemon 运行，不会主动停止；调用方不要重复手写端口探测、启动或停止逻辑。只有用户明确要求停止时才使用 `--cli-action stop`。


## 响应风格

默认输出结构：
- `结果`
- `命中项`
- `补充说明`
- `下一步`

高风险动作确认结构：
- `待操作对象`
- `定位依据`
- `风险提示`
- `等待确认`

特殊格式要求：
当需要输出展示笔记标题或列表，日程标题或列表时，务必使用以下格式
- 笔记来源：按 `📝[标题](doxent://note/id)` 格式输出
- 日程来源：按 `📅[标题](doxent://schedule/id)` 格式输出

## 示例

- “帮我搜一下周报并读正文” → 进入 `note/MODULE.md`
- “总结本周笔记要点” → 进入 `note/MODULE.md`
- “读取 Office 中心里的项目合同” → 进入 `office/MODULE.md`
- “把 Office 中心的方案移到归档文件夹” → 进入 `office/MODULE.md`
- “把这个 pdf 传到书架” → 进入 `book/MODULE.md`
- “帮我新建明天下午两点的提醒” → 进入 `schedule/MODULE.md`
- “明天早上9点开晨会” → 进入 `schedule/MODULE.md`
- “提醒我今晚八点交周报” → 进入 `schedule/MODULE.md`
- “加个待办，周五前提交方案” → 进入 `schedule/MODULE.md`
- “把今天下午的会议改到4点” → 进入 `schedule/MODULE.md`
- “上传日志” → 运行 `--cli-action upload-logs` 并原样返回 CLI 的最终结果

## 远端入口输出完整性（强制）

登录和设置只做转发层检查：确认远端区块完整、恰好包含一个合法的可见页面类型，以及对应的真实链接存在且完整。链接必须使用本次 CLI 返回的原始地址，保留查询参数和编码，不自行拼造、缩短或重新编码 URL。

CLI 原始输出可继续包含 PNG 文件 URI 和字符二维码，脚本保持原样转发；这些内容不属于最终回复，也不作为入口完整性的检查条件。模型不读取、验证或展示二维码，不因二维码缺失、生成失败或显示失败重试。若工具明确报告整体输出截断、远端入口获取失败，或区块、页面类型、真实链接缺失或不完整，则重新执行本次调用的原始动作，且原动作最多重试一次。

页面类型不得改变重试动作，例如 `--cli-action login` 返回设置页时仍重试 `login`，`--cli-action settings` 返回登录页时仍重试 `settings`。仍不完整时明确报告 CLI 远端页面输出异常，只可保留已经完整返回的真实链接，不套用正常模板，不自动打开浏览器，也不声称已完成登录。

所有界面统一使用下方模板，不询问界面类型，不输出页面类型字段、区块标记或模板标题。模板中的代码围栏仅用于说明，实际回复不复制围栏。发送前确认占位符已替换为真实链接，回复只含地址和对应操作提示，没有二维码标题、图片引用、字符矩阵或二维码占位符。

## 远端登录回复模板（强制）

仅当远端区块恰好包含一个 `页面类型：登录`，并通过“远端入口输出完整性”检查时使用本节模板；不能因为执行了 `login`、`settings` 或 `upload-logs` 就自行判定。

```markdown
登录地址：[打开登录页面]({LOGIN_URL})

完成登录后请告诉我，我会继续确认 CLI 登录状态。
```

用户确认完成登录后，执行 `--cli-action login-status` 确认实际状态，再继续原任务；展示链接不代表已登录。

## 远端设置回复模板（强制）

仅当远端区块恰好包含一个 `页面类型：设置`，并通过“远端入口输出完整性”检查时使用本节模板；即使动作是 `--cli-action login`，已登录 CLI 也可能实际返回设置页面。

```markdown
设置地址：[打开设置页面]({SETTINGS_URL})

请在打开的页面中完成办公本数据权限设置。
```
