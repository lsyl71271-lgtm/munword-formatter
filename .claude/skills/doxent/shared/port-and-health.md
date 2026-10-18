# 端口与健康检查规则

## 默认入口与端口回退

- 默认基址：`http://127.0.0.1:46588`
- 宿主执行工具支持选择沙箱模式时，调用 `doxent_api.py` 及 CLI 生命周期命令必须使用非沙箱环境。若默认执行因沙箱隔离而失败，按主 `SKILL.md` 的“命令执行环境”规则在非沙箱环境中重试；写请求结果不明时先查状态，不得直接重放。
- `doxent_api.py` 先检查请求 URL 的默认端口；默认端口不可达时，再读取 `%APPDATA%/doxent/open_model_config.json` 及跨平台等价路径中的 `port` 重试。
- Windows 下还会隐藏查询当前用户的 `doxent-cli.js --doxent-cli-daemon --port ...` 进程参数，用于兼容旧 CLI 没有把实际端口写回配置的情况；该检查不会弹出 PowerShell 窗口。
- 不要无条件把默认 URL 改写成配置端口：配置可能过期，而默认端口上的当前服务仍可能可用。

## CLI 地址身份

- Skill 的业务地址唯一来源是 `doxent-cli --doxent-cli-endpoint` 控制通道响应；响应必须明确 `runtime=cli`、`coreState=running`、回环 `baseUrl` 和匹配端口。
- 默认端口、`open_model_config.json`、Electron health 和任意候选端口只能作为历史兼容信息，不能作为 CLI 服务地址，也不能触发业务请求。
- CLI 更新、Core 重启、会话失效或旧地址连接失败后必须重新查询 endpoint；控制通道无法确认时失败关闭。

## 自动启动与登录

CLI 远端区块必须恰好包含一个可见的 `页面类型：登录` 或 `页面类型：设置`，这是选择 `SKILL.md` 对应回复模板的唯一分流依据。不得根据命令名、URL 路径、查询参数或二维码内容猜测类型，也不得在展示前执行 `--cli-action login-status` 预判页面类型；区块起止注释只表示传输边界。类型字段缺失、重复或非法时，对原动作最多重试一次，仍不合法则明确报告 CLI 远端页面输出异常，不套用登录或设置模板。

- 数据调用前检查登录状态；任何阶段检测到未登录，都必须遵循主 `SKILL.md` 的“检测到未登录必须直接给出登录地址”：暂停数据调用，展示本次工具输出中完整有效的登录入口；没有入口时立即执行 `--cli-action login` 获取并展示真实的可点击链接，无需另行询问用户。不能只提示未登录或让用户自行寻找地址；获取失败按入口完整性规则重试，仍失败则报告具体原因，不编造链接。
- API 请求发现本地服务不可用时，由 `doxent_api.py` 自动查找并启动当前 Doxent CLI；默认优先使用 `DOXENT_CLI_PATH`，其次查找 Doxent CoreCLI 安装目录。
- Doxent CLI 无参数启动后台 Core；首次无会话启动会获取服务端远端 URL，由 CLI 本地生成二维码，把 1-bit PNG 写入本机缓存并输出 `file://` URI，同时输出无语言标签的 TUI 字符二维码兜底 Markdown，不主动打开浏览器；CLI 同时在后台轮询登录状态，已有会话直接复用。
- Windows/macOS/Linux 下，`doxent_api.py` 自动发现显式 `DOXENT_NODE`、系统 PATH 或 Codex 缓存中的 Node 运行时并注入 CLI 子进程，不要求用户手工配置。OpenHarmony 的内置/外部运行时分流见“鸿蒙安装与诊断”。
- skill 启动 CLI、登录、帮助和停止命令时使用隐藏控制台模式，不打开终端窗口。普通 `--cli-action login` 原样接收 CLI 远端输出；外部 agent 必须先按唯一 `页面类型` 选择 `SKILL.md` 的登录或设置回复模板，仅展示真实链接和操作提示。只有用户明确要求本机界面时才使用 `--cli-action login-browser` 打开 `127.0.0.1` 页面，远端失败不得自动回退。
- 普通 `--cli-action settings` 原样接收 CLI 远端输出，不主动打开浏览器或本机回环设置页；外部 agent 同样必须按唯一 `页面类型` 选择“远端登录回复模板”或“远端设置回复模板”，不能因动作名是 `settings` 就跳过登录类型。最终回复仅展示真实链接和操作提示，不整体转发含二维码的原始区块。
- 用户完成远端登录后使用 `--cli-action login-status` 查询；它只返回“已登录”或“未登录”，不启动 CLI daemon、不访问 OpenModel health，也不申请新票据。活动登录期间再次执行 `login` 只复用原地址和轮询，不会停止原任务或签发新地址。
- 不要手动拼接 `npm run core:cli`、`--background-open-model` 或 Electron 启动命令；安装后的 skill 不应依赖源码仓库。
- 关闭终端不会停止 CLI daemon。仅在用户明确要求停止时运行 `--cli-action stop`。
- 每次真实数据脚本先确保 CLI daemon 已启动，脚本完成后保持其运行，不自动发送停止命令。
- 如果启动后 15 秒内未提供本地服务，或随后出现本地连接失败等数据查询错误，先由 `doxent_api.py` 无副作用执行一次 `--cli-action login-status` 等价的会话复核。结果为未登录时，必须继续获取并展示登录地址，不能停在脚本的错误提示；已登录时再提示本地服务启动失败。不得仅凭启动超时猜测原因，也不得用健康接口代替登录状态查询。复核失败时如实提示无法确认，不判定为未登录。
- 如果找不到 CLI，先按平台/架构自动下载：Windows 安装到用户级 `Doxent/CoreCLI`，macOS/Linux 将发布文件重命名为 `~/.local/bin/doxent-cli`、赋执行权限并持久化 PATH 与 `DOXENT_CLI_PATH`；下载失败时报告实际错误，必要时运行 `--cli-action help` 查看当前版本命令。登录未完成或会话失效时按上方规则展示登录地址，不能用帮助提示替代。
- 即使本地服务已健康，也先检查云端 `ETag`、`Last-Modified` 和缓存摘要；版本更高或同版本文件摘要变化时，自动停止旧 daemon、替换用户级 CLI 并重新启动。

登录与设置统一遵守 `SKILL.md` 的“远端入口输出完整性”：只检查远端区块、唯一合法页面类型和对应真实链接的完整性，保留原始 URL 的查询参数和编码。CLI 原始输出可保留 PNG 文件 URI 和字符二维码，但模型不读取、验证或展示二维码；不因二维码缺失、生成失败或显示失败重试。工具明确报告整体输出截断、远端入口获取失败，或区块、类型、链接缺失或不完整时，原动作最多重试一次，页面类型不得改变重试动作；仍异常时如实报告，只可保留已经完整返回的真实链接，不套用正常模板，不自动打开浏览器。

## 鸿蒙安装与诊断

- 鸿蒙系统（HarmonyOS/OpenHarmony）按 CPU 架构选包：ARM64/aarch64 使用 ARM64 包，x64/x86_64/AMD64 使用 x64 包；选包不限制 HarmonyOS 版本或芯片型号。现有 ARM 包为 64 位，不支持 32 位 ARM。Agent 需要 Python 3.8+（含 ssl/gzip/tarfile/subprocess/fcntl）、可写且可执行的用户目录，以及与 CLI 共享的文件系统和回环网络。不同应用沙箱不自动满足这些条件。
- `arm64/aarch64` 下载 `https://download.iflyink.com/apk/doxent-cli-openharmony-arm64.tar.gz?attname=doxent-cli.tar.gz`；`x64/x86_64/AMD64` 下载 `https://download.iflyink.com/apk/doxent-cli-openharmony-x64.tar.gz?attname=doxent-cli.tar.gz`。原 ARM64 内置包携带 Node 24.20.0；当前 x64 包为 `nodeRuntime: external`，需要本机 `DOXENT_NODE` 或 PATH 提供 OpenHarmony x64 Node 18+。所有 external 包均校验 Node 平台、版本与包/宿主架构一致，不使用 Codex 缓存中的普通 Node，也不自动下载额外运行时。转译环境若宿主架构与 Node 不一致会明确拒绝，不能仅凭包可下载断言能运行。
- 只识别明确的 Python 鸿蒙平台标识，普通 Linux 不额外探测 Node。如果已知宿主是鸿蒙而 Python 只报告 Linux，调用前在当前执行环境设置 `DOXENT_CLI_PLATFORM=openharmony`；macOS/Windows 不受该变量影响。该变量不会绕过鸿蒙安装时的架构或执行能力检查。
- 下载地址优先级：`DOXENT_CLI_DOWNLOAD_URL` → 当前架构的 `DOXENT_OPENHARMONY_ARM64_CLI_DOWNLOAD_URL` 或 `DOXENT_OPENHARMONY_X64_CLI_DOWNLOAD_URL` → 默认地址；通用覆盖仍直接返回 URL，实际安装会校验包架构。CDN 同 URL 更新需要发布方刷新缓存，客户端不能保证绕过所有 CDN 缓存。
- 稳定入口默认在 `~/.local/bin/doxent-cli`，`DOXENT_CLI_INSTALL_DIR` 可修改 bin 目录。完整发行资源默认在 `${XDG_DATA_HOME:-~/.local/share}/doxent/cli/openharmony-arm64` 或 `openharmony-x64`，默认版本目录与缓存按架构隔离；`DOXENT_CLI_DATA_DIR` 仍可覆盖该根目录，不要在不同架构间共享同一覆盖目录。不要把 tar.gz 重命名成可执行文件，也不要将包内启动器单独复制或软链接到 bin。
- Windows 构建的归档可能带 CRLF 或缺少 shell 执行位。安装器仅对已校验的 `#!/bin/sh` 启动器统一 LF 并赋予 0755 权限，其他资源保持原字节；归档摘要仍取原下载文件，收据记录安装后的入口摘要。
- 安装器按归档摘要保留完整版本，通过 `current` 原子切换；入口在执行前解析实际版本目录。版本目录损坏时另建修复副本，不覆盖正在使用的资源。旧版本保留用于恢复，本版不自动清理历史 release；有空间压力时应先停止 CLI，再由维护者处理明确不再使用的版本，Agent 不自行扫描业务缓存。
- 鸿蒙配置端口仍查找 `HOME/doxent/open_model_config.json` 及已有跨平台候选；不要强制改为 Linux 的 XDG 配置路径。环境变量持久化沿用 `.profile`，不读取该文件的 Agent 仍通过绝对入口路径调用。
- 更新前先完成候选包校验和运行时诊断，再停止旧 daemon；通过同用户 TCP hello 或旧版 Unix 控制端点确认状态。并发安装使用文件锁，中断事务在下一次安装/更新时恢复。重启失败会恢复旧发行入口并尝试重启原服务；恢复未完成时停止本次操作，保留错误信息，不绕过事务继续取数。跨版本数据库迁移的兼容性仍由 CLI 发行方负责。
- 仅检查运行时使用：

```sh
PYTHON_BIN="${DOXENT_PYTHON:-python3}"
"$PYTHON_BIN" "$DOXENT_SKILL_ROOT/shared/scripts/doxent_api.py" --cli-action check-runtime
```

该动作不安装、不更新、不登录、不启动 daemon，也不访问业务 health。未安装时明确返回未安装；首次安装使用既有 `--cli-action help` 或用户实际需要的 CLI 动作。诊断失败时原样保留检查结果与执行错误；WASM 文件存在不代表 SQLite 已完成初始化。

普通登录使用远端页面，鸿蒙不假定存在 `xdg-open`。HiShell/TUI 同样按主 Skill 模板仅展示真实链接和操作提示。Python 平台识别、Node 签名与可执行目录、SQLite 持久化、登录/同步、后台驻留及真实数据操作仍需在目标设备验收。

## 健康检查映射

- notes → 检查 `/open-model-note/health`
- Office 中心文档与文件夹 → 检查 `/open-model-office/health`
- books → 检查 `/open-model-book/health`
- schedules/tasks → 检查 `/open-model-schedule/health`

健康检查由 `doxent_api.py` 在请求前自动完成；业务模块不应重复检查，也不应把 health 当成写操作成功的证明。

## 首次同步补批协调

- `/sync/status` 只用于读取同步阶段，轮询本身永远不触发下一批，也不改变 `nextInitialSyncAt`。
- 只有 `partial_idle` 门禁明确放行的白名单 GET，在业务响应完整读取并关闭后，脚本才通过既有 CLI daemon 控制通道发送内部补批通知；不新增 Core HTTP 协调接口。
- `/sync/status`、写操作、未知路径和其它同步阶段都不发送通知；重复或过时通知不会改变补批计划。
- 协调请求只把既有唯一 10 分钟兜底 timer 提前到当前时刻，并复用同步单飞入口；写操作、未知路径、其它阶段和重复竞争请求会被忽略。
- 协调调用失败不改变业务响应或退出码，CLI 继续按原 10 分钟计划补批。

## 取数边界

遵守 `SKILL.md` 的“数据访问边界”：真实数据只通过 `doxent_api.py` 调用 CLI 命令或 CLI daemon 接口获取。Agent 禁止自行扫描缓存目录、直读数据库或会话文件，也不得在 CLI 失败时以缓存兜底；登录和设置回复不读取二维码文件，也不能搜索二维码缓存寻找替代文件。

图形客户端、终端 TUI 和界面能力未知的宿主统一使用主 Skill 的仅链接模板，暂不展示 PNG 或字符二维码；不判断图片能力，也不因图片未显示切换字符码。
