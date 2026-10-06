# v1.8.5 离线桌面安装器

桌面版复用 `local_web/main.tsx`、`app/page.tsx` 及现有浏览器排版引擎，含六文种、识别、第三步人工确认、原文/编号保护、DOCX 导出、模板和本地预览。Python API/命令行批处理仍保留为源码入口；新桌面应用的网页操作不需要后端 API。安装包自带轻量 Python 标准库主机与全部已编译网页资源，用户不安装 Python/Node，安装和运行不下载运行组件、规则、字体或脚本。

## 安装与使用

| 系统 | 包 | 使用方法 | 兼容范围与限制 |
|---|---|---|---|
| Apple 芯片 Mac | `Munword-1.8.5-macOS-arm64.dmg` | 打开 DMG，将应用拖到 Applications，双击应用 | 构建目标 macOS 11+；不需要 Rosetta |
| Intel Mac | `Munword-1.8.5-macOS-x64.dmg` | 同上 | 构建目标 macOS 11+；每个原生文件的最低版本会检查 |
| 64 位 Windows | `Munword-1.8.5-Windows-x64-Setup.exe` | 双击安装；从桌面快捷方式启动 | Windows 10/11；无管理员提示；不能安装在 32 位系统 |
| 32 位 Windows | `Munword-1.8.5-Windows-x86-Setup.exe` | 同上 | Windows 10 32 位；Windows 7/8 不作为支持目标 |

浏览器要求 Edge/Chrome 111+、Firefox 128+、Safari 16.4+。旧浏览器显示明确说明，避免空白页。Safari 在较旧 macOS 上需更新到该系统能安装的兼容版本；不能用降低版本声明代替网页/系统兼容性。无需独立显卡、AVX2、GPU 加速或联网。大型 DOCX 的内存和预览成本仍取决于文档内容与浏览器，不承诺所有老电脑的处理速度。

程序仅监听 IPv4 回环地址，由系统分配空闲端口；不调用主机名/DNS 解析，避免断网或 macOS 解析器等待造成启动卡住；不会抢占 8000、请求防火墙放行或终止占用端口的其他程序。重复双击复用同一个实例。输出由浏览器保存到用户选择的位置；程序目录不保存原稿。顶部“退出本机程序”安全关闭本机服务，网页关闭后无请求的服务最多保留 30 分钟。没有开机启动、系统服务、遥测或自动联网更新。Windows 卸载入口位于开始菜单/系统应用列表。

macOS 不申请辅助功能、屏幕录制、自动化控制其他应用或全盘访问。应用打开默认浏览器，文稿由用户通过浏览器文件选择器选择。Windows 安装为当前用户，不更改 PowerShell 执行策略、全局 PATH、系统 Python 或防火墙。操作系统和浏览器自身的更新、下载来源检查与证书检查是系统行为；应用内容处理不调用云服务。

## 签名与安全提示

正确 DMG 容器、完整应用复制、原生代码签名校验与 SHA-256 可排除一类真正的打包损坏；临时签名不能替代 Developer ID 或 Apple 公证。没有开发者证书的 DMG 仍可能被 Gatekeeper 拦截，不能保证不出现“未经验证的开发者”等提示。不要删除隔离属性或关闭 Gatekeeper 来宣称通过验收。

`desktop/build.py` 可接收 `MUNWORD_MAC_SIGN_IDENTITY`（构建机钥匙串中的 Developer ID Application）与 `MUNWORD_NOTARY_PROFILE`（已经配置的 notarytool profile），执行签名、公证、staple 与校验。证书/私钥/密码不得写入源码或安装包。CI 默认无证书，因此会明确产出未公证版本。Windows 默认没有 Authenticode 证书，SmartScreen 也可能提示未知发布者；没有伪造签名或声称免安全提示。

## 构建与验收

在对应原生系统上使用 Python 3.12、Node 24 与锁定的 pnpm 11.19.0：

```sh
pnpm install --frozen-lockfile
pnpm build:local-tools
python -m pip install -r desktop/requirements-build.txt
python -m unittest discover -s desktop -p test_launcher.py -v
python desktop/build.py --arch x64
```

Apple 芯片使用 `--arch arm64`；32 位 Windows 需要 32 位 Python 并使用 `--arch x86`。Windows 构建机需 NSIS，Mac 构建机需系统 `hdiutil/codesign/otool`。这些是开发工具，用户安装时不需要它们。Linux 只构建测试主机，不把 Linux 可执行文件重命名为 DMG/EXE。

自动化验证包括源代码回归、安装文件哈希、原生安装/DMG 挂载后复制、中文及空格目录、无系统 Python/Node 的应用 PATH、随机端口、重复启动、认证退出和重启；Windows 额外验收重新安装/升级与卸载。真实浏览器针对七份合成文稿执行六文种及英文决议草案的上传、自动识别、保持第三步人工编辑入口、生成下载、ZIP 回读、原稿与成稿预览及独立模板新建，并阻断/记录外部请求。

GitHub Actions 使用 Windows Server 2022 x64 虚拟机（分别运行 x64/x86 包）、macOS 14 Apple 芯片、macOS 15 Intel 原生运行器，并安排同一 x64 EXE 在 Windows 11 ARM 虚拟机中经系统仿真再验收；这不等价于所有 Windows 10/11、32 位硬件、macOS 11 或真机测试。安装器对最低系统的限制、静态二进制检查、现代浏览器需求和当前运行器验收必须分别报告。Windows 的标准托管运行器默认是管理员且 UAC 关闭，`RequestExecutionLevel user` 的静态检查不应被写成已在标准用户账户验收。

每个作业保存安装包、SHA-256、安装/运行验收 JSON、macOS 二进制最低版本清单和浏览器截图；失败作业不能据此宣称产物已通过。若后续某一工作流因平台授权无法执行，应直接报告未构建/未验收，不用源码检查替代原生系统结果。
