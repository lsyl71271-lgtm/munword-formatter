# 安卓安装包

`downloads/PKUNMUN2026-Formatter-Android.apk`：约 0.4 MB，Android 5.0（API 21）及以上，目标 API 34。

和网页版、桌面版是**同一个界面、同一个排版引擎**：`local_web/main.tsx` 挂载的 `app/page.tsx` 与 `app/docx-browser.ts`，只是换了一个 WebView 外壳。处理结果与电脑上逐部件相同。

## 组成

| 文件 | 作用 |
|---|---|
| `src/org/pkunmun/formatter2026/MainActivity.java` | 唯一的界面：一个 WebView，加上 WebView 自己做不到的事（保存到「下载」、系统文件选择器、「打开方式 / 分享」传入） |
| `src/org/pkunmun/formatter2026/SavedFiles.java` | 把已保存的文件交给 WPS / Word / 分享面板（只读、不导出；只认本应用存进 Download 的文件：Android 10+ 转读自己的 MediaStore 条目，更早的读 Download 或应用自己的文件夹） |
| `AndroidManifest.xml`、`res/` | 无联网权限；存储权限只到 Android 9；`VIEW` / `SEND` 接收 DOCX；自适应图标（矢量）与旧版 PNG 图标 |
| `bridge.js` | 页面一侧的桥（ES5，内联进页面）：把下载链接交给原生保存；把「打开方式」传来的文件交给页面自己的文件输入框 |
| `build-site.mjs` | 手机版页面：同一份源码按 Chromium 69 编译，补样式降级，写入加载器 |
| `polyfills.js`、`flex-gap.js` | 旧 WebView 缺的内置函数；Chromium 84 以前 flex 布局的 `gap` |
| `build-apk.mjs` | 打包、对齐、签名，`--publish` 写入 `downloads/` |
| `make-icons.mjs` | 从 `public/favicon.svg` 渲染旧版 PNG 图标 |
| `stubs/` | 只供编译用的 API 26 类（`RenderProcessGoneDetail`），不进 APK |
| `acceptance/` | 验收脚本（见下文） |

### 原生部分做什么

- **保存**：页面生成 DOCX 后照常“点击下载链接”。`bridge.js` 拦下这个点击，用 `FileReader` 读出字节，分块（每块 1 MB 的 base64）交给 `MunwordAndroid.begin / append / finish`。原生侧先写到缓存，校验字节数，然后：
  - Android 10+：写入 MediaStore 的 Downloads（不需要权限，重名由系统自动加「(1)」）；
  - Android 6–9：第一次保存时请求存储权限（读、写两项一起请求，只弹一次；Android 8.0 只授予请求的那一项，只有写权限时拒绝写入 Download），允许后写入公共 Download 并通知媒体库；拒绝则写入应用自己的文件夹；
  - Android 5：安装时已授予权限，直接写入 Download；
  - 任何版本上 Download 写不进去（没有插 SD 卡、存储已满或损坏）时，改存到应用自己的文件夹，弹窗说明原因，「打开」「分享」照常可用。
  
  保存后弹窗显示文件名和位置，可以「打开」（WPS / Word；没有能打开的应用时说明装哪个）或「分享」。本应用自己也能打开 DOCX（用来排版），所以「打开」只交给其他应用（Android 11+ 靠清单里的 `<queries>` 才能看到它们），只有一个时直接打开，多个时让用户选；分享面板里也不列本应用（Android 7+ 由系统排除，Android 5–6 改为逐个列出其他应用）。两者都经 `SavedFiles` 授权读取：各版本 Android 是否允许把 MediaStore 的 Downloads 条目授权给别的应用并不一致，自己的提供者在所有版本上都可靠。
- **选择文件**：页面的文件输入框打开系统文件选择器（`ACTION_GET_CONTENT`，DOCX 及来源不明的文件）。
- **打开方式 / 分享传入**：从微信、QQ、文件管理等对 DOCX 选「其他应用打开」或「分享」，原生侧读出文件（上限 25 MB，页面本身拒收 20 MB 以上），页面加载好后调用 `window.__munwordReceive()`，`bridge.js` 分块读回，放进页面自己的文件输入框，和用户亲手选择完全一样。页面在切换文书类型时会清空文件，所以传入的文件会在用户点选类型后自动放回，直到用户自己选了别的文件。识别、第 03 步和生成仍然由用户操作。
- **其他**：返回键回到桌面但保留进度；旋转屏幕、调整字号不重建页面；页面进程被系统回收（Android 8+）时重新打开页面而不是闪退；WebView 只加载应用自带的文件，其余请求一律拦截，并关闭 WebView 的使用统计和安全浏览查询。
- **远程调试**：只有在电脑上执行 `adb shell setprop debug.munword.devtools 1` 后才打开 WebView 调试。自动化测试借此驱动用户安装的同一个 APK；普通用户的手机上始终关闭。

### 旧 WebView 兼容层

Android 5、6 的 WebView 最高到 95 版，7 以上可更新到最新；国内不带 Google 服务的手机常见厂商自带的较旧版本。手机版页面以 **WebView 69**（Android 9 出厂版本）为门槛：

| 新特性（Chromium 版本） | 处理 |
|---|---|
| 新语法（`?.`、`??`、类字段等） | esbuild 按 `chrome69` 编译 |
| `Array#at/findLast`、`Object.hasOwn/fromEntries`、`String#replaceAll`、`Promise.allSettled`、`Blob#arrayBuffer`、`replaceChildren` 等 | `polyfills.js`，只在缺少时定义，不可枚举 |
| CSS 级联层 `@layer`（99） | 原地展开（页面自己的规则本来就在层外，优先级不变） |
| `:where()` / `:is()` / `::file-selector-button` / `:focus-visible`（88–89） | 拆成一条选择器一条规则，避免整条规则被丢弃 |
| `inset`、`margin-inline`、`clamp()`、`min()`、`overflow-wrap: anywhere`（79–87） | 在前面加一条旧写法 |
| flex 里的 `start` / `end` 对齐（93） | 换成 `flex-start` / `flex-end`（网格里含义相同） |
| flex 布局的 `gap`（84） | 加载器探测；不支持时 `flex-gap.js` 在每次渲染后用外边距补上（处理文字节点、隐藏和绝对定位的子元素、子元素自己的外边距） |

当前的 WebView 不受影响：手机版页面在最新 Chromium 里与桌面页面的截图逐像素相同。WebView 低于 69 时，ES5 写的加载器不加载程序，显示当前版本号和更新「Android System WebView」的办法。

## 构建

```sh
sudo apt-get install aapt dalvik-exchange zipalign apksigner libandroid-23-java openjdk-21-jdk-headless
pnpm build:local-tools                 # 共享样式（或 pnpm build:static / node desktop/build-desktop.mjs --only site）
node android/build-apk.mjs             # → dist/android/PKUNMUN2026-Formatter-Android-unsigned.apk
```

不需要 Gradle、Android Studio 或 Google 的 SDK 下载：`aapt2` 编译资源和清单（链接 API 23 的 `android.jar`，`--min-sdk-version 21 --target-sdk-version 34`），`javac -source 8 -target 8` 编译（不用 lambda，Debian 的 dx 才能转换），`dx` 生成 `classes.dex`，再按固定顺序、固定日期（2008-01-01）写 ZIP，`resources.arsc` 不压缩，`zipalign -p 4` 对齐。工具路径可用 `AAPT2`、`DX`、`ZIPALIGN`、`APKSIGNER`、`JAVAC`、`ANDROID_JAR` 覆盖。

同一份源码在任何 Ubuntu 24.04 上得到相同的 APK 内容（条目与字节）；签名块和压缩字节不参与比较。

### 签名

```sh
MUNWORD_ANDROID_KEYSTORE=/path/munword-release.jks \
MUNWORD_ANDROID_KEYSTORE_PASSWORD=… MUNWORD_ANDROID_KEY_ALIAS=munword \
node android/build-apk.mjs --publish
```

- v1（Android 5–6）+ v2 + v3 签名，RSA 3072，证书有效期 100 年。
- **签名密钥不在仓库里。** 证书的 SHA-256 指纹登记在 `signing-cert.sha256`，构建和 CI 都会核对。
- 以后发布的新版本必须用同一把密钥签名，用户才能直接覆盖安装；换密钥意味着用户要先卸载旧版。请把密钥文件和密码分开妥善保存（例如密码管理器 + 离线备份）。
- `--publish` 复制到 `downloads/` 并只更新 `SHA256SUMS.txt` 里 APK 那一行；安装教程里的 APK 校验值需要同步更新（`tests/desktop.test.mjs` 会检查）。

## 验收

| 检查 | 在哪里 | 内容 |
|---|---|---|
| 单元测试 | `node --test tests/android.test.mjs`（CI：`source-checks`；不放进 `test:unit`，因为 `package.json` 记录在桌面安装包的构建记录里） | 样式降级、内置函数补丁、桥与加载器是 ES5、清单承诺、校验值行 |
| 重建比对 | `acceptance/verify-apk.mjs`（CI） | 从源码重建，与发布的 APK 逐条目比对内容；v1/v2/v3 签名与证书指纹；用 `aapt` 读回包名、版本、SDK、权限；校验值与安装教程 |
| 旧引擎 | `acceptance/webview-floor.mjs`（CI） | 手机版页面在 Chromium 67（必须显示说明、不加载程序）和 69、79、83、88、95、99、109、最新版里，以“打开方式”的路径传入文件、先传文件后选类型，跑完 14 份原稿；成品与共享页面在最新 Chromium 里的输出逐部件相同 |
| 真机系统 | `acceptance/emulator.mjs`（CI，模拟器） | Android 5.0、5.1、6.0、7.0、7.1、8.0、8.1、9、10、11、12、12L（平板尺寸屏幕）、13（字体 1.3 倍、深色模式）、14、15、16，各用系统自带、未更新的 WebView；见下 |

模拟器上的检查（UI Automator 点原生弹窗，DevTools 驱动页面，`adb pull` 读回「下载」里的文件）：

- 安装后确认没有联网权限；WebView 版本决定应看到程序还是更新说明，两者必须一致。
- 两种情况都检查：1.5 MB 文件经桥保存（双向各两块）、逐字节一致（程序能运行时走页面真实的下载链接；低于门槛时页面只显示说明、做不出文件，直接调用应用的保存接口检查原生部分）；Android 6–9 的存储权限弹窗（Android 8.0 模拟器镜像的系统界面一遇到权限弹窗就反复崩溃，那里改由 adb 预先授权，弹窗本身在 6.0 和 9 上检查）；重名自动编号；弹窗的「打开」「分享」；「打开方式」「分享」传入的字节完全一致，传完后原生侧不再保留。
- 程序能运行时：14 份原稿逐份选类型、选文件、识别、确认第 03 步可编辑（不代填）、生成，弹窗报出的文件在「下载」里，与参考输出逐部件相同；旋转屏幕、按返回键离开再回来，进度都在；页面没有加载应用以外的任何资源；冷启动「打开方式」和运行中「分享」传入的文件经过类型选择仍在，排版结果与参考相同。
- 安装前先装上一次发布的 APK，再覆盖安装（同一签名、版本号不降低）。
- Android 6–9 另外撤销权限后再保存一次并点「拒绝」：文件存进应用自己的文件夹，弹窗说明位置，「分享」照常可用。
- 程序能运行时：在屏幕上点上传区域（真实触摸）打开系统文件选择器，取消后页面照常，再点一次仍能打开；Android 8+ 让页面进程崩溃，应用不关闭并重新载入页面。
- 每个页面（首页、更新说明、每份原稿的第 03 步）都不超出屏幕宽度；分享面板里没有本应用。
- Android 12L 用平板尺寸屏幕（1200×1920，240 dpi），Android 13 把字体放大到 1.3 倍并打开深色模式。
- 最后检查系统崩溃日志里没有本应用的进程。

模拟器镜像里的 WebView 是出厂版本（Android 9 及以前低于 69），所以这些系统上验证的是更新说明和原生保存 / 传入路径；程序本身在 69 以上各版本引擎中的表现由“旧引擎”一项覆盖。

## 已知限制

- 需要 WebView 69 以上；无法更新 WebView 的旧手机请用网页版或电脑版。
- 鸿蒙 HarmonyOS NEXT 不能安装 APK；iPhone / iPad 没有安装包。
- 没有上架应用商店，安装时系统会提示「未知来源」，部分品牌还有额外的风险提示（安装教程里有处理办法）。
- 打开 DOCX 需要手机上有 WPS Office、Microsoft Word 等应用；没有时文件仍保存在「下载」里，可以分享出去。
