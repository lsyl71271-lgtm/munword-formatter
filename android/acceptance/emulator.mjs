// The published APK on a real Android system (an emulator in CI), with the system's own WebView, driven the way a
// user drives it: taps on native dialogs through UI Automator, files through the page's own file input or through
// "open with" / "share" intents, and the result read back from the phone's Download folder.
//
//   node android/acceptance/emulator.mjs <apk> <reference dir> <out dir>
//
// adb must reach exactly one device (ADB to override the binary). The page is driven over the WebView's DevTools
// socket, which the app opens only when `debug.munword.devtools` is set from adb, so this is the APK users install.
//
// WebView 69 or newer (the app runs):
// - every acceptance input: pick the type, choose the file, recognize, check step 03 is there and editable (never
//   filled in), generate; the app's own save dialog must name the file, and the DOCX in Download must have the same
//   parts as the shared page's output in current Chromium (reference dir: desktop/offline-smoke.mjs output);
// - rotating the screen and leaving with Back keep the work; the page loads nothing outside the app;
// - "open with" from a cold start and "share" into the running app hand the document to the page, which keeps it
//   through the type choice and formats it like any other.
// Older WebView (the notice): the notice shows and app.js never loads.
// Both: the save path for a 1.5 MB file (two chunks each way), Android 6–9's storage permission prompt, duplicate
// names, the dialog's 打开 and 分享 (the share sheet must not offer this app itself), and "open with" / "share"
// handing the exact bytes over; no page wider than the screen.
// Also: installed over the APK released before (MUNWORD_PREVIOUS_APK, when given); Android 6–9 refusing the
// permission (the file goes to the app's own folder and can still be shared); WebView 69+: the file picker opens and
// cancels cleanly, and on Android 8+ a crashed page process is replaced without the app closing.
// MUNWORD_DEVICE_PROFILE: "tablet" (1200×1920 at 240 dpi) or "large-dark" (font scale 1.3, dark mode).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { Cdp, PAGE_STATE } from "./cdp.mjs";

const [apk, reference, out] = process.argv.slice(2).map((p) => path.resolve(p));
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ADB = process.env.ADB || "adb";
const PACKAGE = "org.pkunmun.formatter2026";
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FLOOR = 69;
const PORT = 9333;
const CASES = [
  ["立场文件", "01_中文立场文件"], ["立场文件", "02_English_Position_Paper"], ["工作文件", "03_中文工作文件"],
  ["工作文件", "04_English_Working_Paper"], ["指令草案", "05_中文指令草案"], ["指令草案", "06_English_Draft_Directive"],
  ["决议草案", "07_中文决议草案"], ["决议草案", "08_English_Draft_Resolution"], ["友好修正案", "09_中文友好修正案"],
  ["非友好修正案", "10_中文非友好修正案"], ["友好修正案", "11_English_Amendment"],
  ["外交协定", "12_中文外交协定"], ["联合声明", "13_中文联合声明"], ["联合声明", "14_English_Joint_Statement"],
];
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { passed: false, steps: [], cases: [] };
const step = (name, detail = {}) => {
  report.steps.push({ name, ...detail });
  console.log(`  ✓ ${name}${Object.keys(detail).length ? " " + JSON.stringify(detail) : ""}`);
};

// ---- adb ----
const adb = (args, options = {}) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000, maxBuffer: 64 << 20, ...options });
const shell = (command) => adb(["shell", command]).replace(/\r/g, "");
const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const sdk = Number(shell("getprop ro.build.version.sdk").trim());
// The Android 8.0 emulator image's System UI crashes over and over once the permission screen comes up
// (NavigationBarFragment.onKeyguardOccludedChanged), so there the permission is granted from adb beforehand; the
// prompt itself is checked on Android 6.0 and 9.
const PROMPT_UNUSABLE = sdk === 26;
const PROFILE = process.env.MUNWORD_DEVICE_PROFILE || "";
const PREVIOUS_APK = process.env.MUNWORD_PREVIOUS_APK || "";
const screencap = (name) => {
  try {
    writeFileSync(path.join(out, `${name}.png`), execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20, timeout: 60000 }));
  } catch (error) {
    console.log(`  (screenshot ${name} failed: ${error.message})`);
  }
};
const pull = (devicePath) => {
  const local = path.join(out, "pulled", path.basename(devicePath));
  mkdirSync(path.dirname(local), { recursive: true });
  adb(["pull", devicePath, local]);
  return readFileSync(local);
};
// The app's WebView DevTools socket, found by the owning process's command line (pidof and ps differ by version).
function devtoolsSocket() {
  const sockets = [...new Set([...shell("cat /proc/net/unix").matchAll(/webview_devtools_remote_(\d+)/g)].map((m) => m[1]))];
  for (const pid of sockets) {
    const command = (() => { try { return shell(`cat /proc/${pid}/cmdline`); } catch { return ""; } })();
    if (command.replace(/\0/g, " ").trim().startsWith(PACKAGE)) return `webview_devtools_remote_${pid}`;
  }
  return null;
}
function resumedActivity() {
  const output = shell("dumpsys activity activities");
  const match = /(?:mResumedActivity|ResumedActivity|topResumedActivity)[:=]\s*ActivityRecord\{\S+ \S+ (\S+?)[ }]/.exec(output);
  return match ? match[1] : "";
}
async function waitFor(check, timeout, what) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- UI Automator: the native dialogs ----
const entities = (text) => text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let lastDump = "";
function uiNodes() {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // /data/local/tmp: on Android 5 the dump written to /sdcard is not where the shell's /sdcard points.
      shell("rm -f /data/local/tmp/munword-ui.xml");
      lastDump = shell("uiautomator dump /data/local/tmp/munword-ui.xml").trim();
      const xml = adb(["shell", "cat /data/local/tmp/munword-ui.xml"]);
      if (!xml.includes("<hierarchy")) { lastDump += ` | no hierarchy: ${xml.slice(0, 200)}`; continue; }
      return [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map(([, attributes]) => {
        const node = {};
        for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) node[name] = entities(value);
        const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(node.bounds || "");
        node.center = bounds ? [(Number(bounds[1]) + Number(bounds[3])) >> 1, (Number(bounds[2]) + Number(bounds[4])) >> 1] : null;
        return node;
      });
    } catch (error) { lastDump = String(error.stderr || error.message).trim(); /* the screen was still moving: try again */ }
  }
  return [];
}
const findNode = (nodes, test) => nodes.find((node) => node.center && test(node));
// An emulator's own components sometimes crash or stall ("System UI has stopped"), covering the screen; such a
// dialog is closed. One about this app is left alone (and the crash log check at the end fails the run).
function dismissSystemDialog(nodes) {
  const dialog = nodes.some((node) => /^android:id\/aerr_/.test(node["resource-id"] || "")) || nodes.some((node) => /has stopped|isn.t responding|keeps stopping/i.test(node.text || ""));
  if (!dialog || nodes.some((node) => /PKUNMUN|pkunmun/.test(node.text || ""))) return false;
  const close = findNode(nodes, (node) => /^android:id\/aerr_(close|wait)$/.test(node["resource-id"] || "") || /^(close app|wait|ok)$/i.test(node.text || ""));
  if (!close) return false;
  console.log(`  · closed a system dialog: ${nodes.filter((node) => node.text).map((node) => node.text).join(" / ").slice(0, 120)}`);
  tap(close);
  return true;
}
async function waitForNode(test, timeout, what) {
  let nodes = [];
  try {
    return await waitFor(() => { nodes = uiNodes(); if (dismissSystemDialog(nodes)) return null; return findNode(nodes, test); }, timeout, what);
  } catch (error) {
    writeFileSync(path.join(out, `ui-${what.replace(/\W+/g, "-")}.json`), JSON.stringify(nodes.map(({ text, "resource-id": id, class: cls, package: pkg }) => ({ text, id, cls, pkg })), null, 1));
    screencap(`failed-${what.replace(/\W+/g, "-")}`);
    throw error;
  }
}
const tap = (node) => shell(`input tap ${node.center[0]} ${node.center[1]}`);

// Android's dialog buttons by id (Android 5's UI Automator turns Chinese text into "?"): 打开 / 好 are the positive
// button, 完成 the negative, 分享 the neutral one.
const BUTTONS = { 打开: "android:id/button1", 好: "android:id/button1", 完成: "android:id/button2", 分享: "android:id/button3" };
const button = (label) => (node) => node["resource-id"] === BUTTONS[label];

// Waits for the app's save dialog. The file name comes from the app's log: the first "save <n> begins" of this app
// process with a number above the last one seen, then its "saved <name> (<uri>)" line (clearing the log is not
// immediate on every system, so earlier saves are told apart by number). The dialog's message comes from the screen.
let appPid = null, lastSaveId = 0;
function appLog() {
  return adb(["logcat", "-d", "-v", "brief", "-s", "Munword:V"]).replace(/\r/g, "").split("\n")
    .filter((line) => new RegExp(`\\(\\s*${appPid}\\)`).test(line));
}
async function savedDialog(what) {
  const saved = await waitFor(() => {
    const lines = appLog();
    const start = lines.findIndex((line) => { const begun = /: save (\d+) begins: /.exec(line); return begun && Number(begun[1]) > lastSaveId; });
    if (start < 0) return null;
    for (const line of lines.slice(start + 1)) {
      const failed = /: save failed: (.*)/.exec(line);
      if (failed) throw new Error(`the app could not save ${what}: ${failed[1]}`);
      const done = /: saved (.+?) \(((?:content|file):.*)\)$/.exec(line);
      if (done) return { id: Number(/: save (\d+) begins: /.exec(lines[start])[1]), name: done[1], uri: done[2] };
    }
    return null;
  }, 60000, `the app saving ${what}`);
  lastSaveId = saved.id;
  const message = await waitForNode((node) => node["resource-id"] === "android:id/message", 60000, `save dialog (${what})`);
  return { name: saved.name, uri: saved.uri, text: message.text || "" };
}
async function allowStoragePrompt() {
  // Android 6–9 ask once, the first time something is saved. Allow is tapped again while the prompt is still there
  // (a crashing System UI on the Android 8.0 image can swallow the tap), until the app is back in front.
  let tapped = false, nodes = [];
  try {
    await waitFor(() => {
      nodes = uiNodes();
      if (dismissSystemDialog(nodes)) return null;
      const allow = findNode(nodes, (node) => /permission_allow_button$/.test(node["resource-id"] || "") || /^allow$/i.test(node.text || ""));
      if (allow) { tap(allow); tapped = true; return null; }
      return tapped && resumedActivity().startsWith(PACKAGE);
    }, 60000, "storage permission prompt allowed");
  } catch (error) {
    writeFileSync(path.join(out, "ui-storage-permission.json"), JSON.stringify(nodes.map(({ text, "resource-id": id }) => ({ text, id })), null, 1));
    screencap("failed-storage-permission");
    throw error;
  }
  step("storage permission prompt shown and allowed");
}
// Back from another app's screen (a viewer, the share sheet), pressed again if the first press came too early.
// (Never pressed while the app itself is in front: there Back sends it to the background.)
async function backToApp(what) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (resumedActivity().startsWith(PACKAGE)) return true;
    shell("input keyevent 4");
    try { return await waitFor(() => resumedActivity().startsWith(PACKAGE), 8000, what); } catch { /* not yet: press again */ }
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- The page, over the WebView's DevTools socket ----
let cdp;
async function connect() {
  cdp?.close();
  const socket = await waitFor(() => devtoolsSocket(), 60000, "the app's DevTools socket");
  const pid = socket.split("_").pop();
  if (pid !== appPid) { appPid = pid; lastSaveId = 0; } // a new app process numbers its saves from 1 again
  adb(["forward", "--remove-all"]);
  adb(["forward", `tcp:${PORT}`, `localabstract:${socket}`]);
  cdp = await Cdp.open(PORT, { match: (target) => target.url.startsWith("file:///android_asset/site/"), timeout: 60000 });
  return socket;
}
async function launch() {
  shell(`am start -W -n ${ACTIVITY}`);
  await waitFor(() => resumedActivity().startsWith(PACKAGE), 30000, "the app in front");
}

// Older WebViews' DevTools refuse a message over 1 MB (WebView 44: "Too large read data is pending"), so bytes go
// into the page, and text comes back out, in pieces.
const PIECE = 256 * 1024;
async function piecesInPage(bytes) {
  const base64 = Buffer.from(bytes).toString("base64");
  await cdp.eval("window.__pieces = [], true");
  for (let offset = 0; offset < base64.length; offset += PIECE) await cdp.eval(`window.__pieces.push(${JSON.stringify(base64.slice(offset, offset + PIECE))}), true`);
}
async function bytesInPage(bytes) {
  await piecesInPage(bytes);
  // An expression for the bytes as a Uint8Array.
  return `(function () {
    var binary = atob(window.__pieces.join("")), data = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    window.__pieces = null;
    return data;
  })()`;
}
async function textFromPage(expression) {
  const length = await cdp.eval(`(${expression}).length`);
  let text = "";
  for (let offset = 0; offset < length; offset += PIECE) text += await cdp.eval(`(${expression}).slice(${offset}, ${offset + PIECE})`);
  return text;
}

// Hands bytes to the page as a download (what the page does with a finished DOCX) through the real bridge.
// Below the WebView floor the page shows only the update notice and cannot make a file, so there the app's save is
// driven directly through its interface (begin / append / finish, as android/bridge.js calls it): WebView 39's
// FileReader never finishes reading the test's blob, which no user can reach on that WebView anyway.
async function saveThroughBridge(name, bytes) {
  if (report.mode === "notice") {
    await piecesInPage(bytes);
    await cdp.eval(`(function () {
      var bridge = window.MunwordAndroid, data = window.__pieces.join("");
      window.__pieces = null;
      var id = bridge.begin(${JSON.stringify(name)}, ${JSON.stringify(DOCX)}, ${bytes.length});
      for (var offset = 0; offset < data.length; offset += 1048576) bridge.append(id, data.slice(offset, offset + 1048576));
      bridge.finish(id);
      return true;
    })()`);
    return;
  }
  const data = await bytesInPage(bytes);
  await cdp.eval(`(function () {
    var data = ${data};
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([data], { type: ${JSON.stringify(DOCX)} }));
    link.download = ${JSON.stringify(name)};
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    return true;
  })()`);
}
function deviceFile(name) {
  return `/sdcard/Download/${name}`;
}
function mediaStoreId(name) {
  let rows = [];
  try { rows = shell(`content query --uri content://media/external/downloads --projection _id:_display_name`).split("\n"); } catch { /* the shell may not read MediaStore */ }
  for (const row of rows) {
    const match = /_id=(\d+), _display_name=(.*)$/.exec(row.trim());
    if (match && match[2] === name) return match[1];
  }
  return null;
}
// A URI another app would hand over: a plain path on Android 9 and earlier, the MediaStore entry on 10+ (or, on 11+,
// the path, which an app may read for a file it created itself).
function shareUri(name) {
  if (sdk < 29) return `file://${deviceFile(name)}`;
  const id = mediaStoreId(name);
  if (id) return `content://media/external/downloads/${id}`;
  if (sdk >= 30) return `file://${deviceFile(name)}`;
  throw new Error(`${name} is not in MediaStore downloads`);
}
function sendIntent(action, uri) {
  const target = action === "VIEW" ? `-a android.intent.action.VIEW -d ${quote(uri)} -t ${DOCX}` : `-a android.intent.action.SEND -t ${DOCX} --eu android.intent.extra.STREAM ${quote(uri)}`;
  shell(`am start -W ${target} -n ${ACTIVITY}`);
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sameParts(actual, expected) {
  const left = unzipSync(new Uint8Array(actual)), right = unzipSync(new Uint8Array(expected));
  const names = Object.keys(right).sort();
  if (Object.keys(left).sort().join("|") !== names.join("|")) return "part list differs";
  const differing = names.filter((name) => !Buffer.from(left[name]).equals(Buffer.from(right[name])));
  return differing.length ? `parts differ: ${differing.join(", ")}` : "";
}
// 1.5 MB of fixed pseudo-random bytes: two pieces each way through the bridge.
const BIG = (() => {
  const bytes = Buffer.alloc(1536 * 1024);
  let seed = 2026;
  for (let i = 0; i < bytes.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; bytes[i] = seed >>> 24; }
  return bytes;
})();

// The native save path, both modes: saves, the permission prompt, duplicate names, 打开 and 分享.
async function bridgeSaves() {
  shell("rm -f /sdcard/Download/PKUNMUN-bridge-test*.docx");
  await saveThroughBridge("PKUNMUN-bridge-test.docx", BIG);
  if (sdk >= 23 && sdk <= 28 && !PROMPT_UNUSABLE) await allowStoragePrompt();
  const first = await savedDialog("first save");
  if (first.name !== "PKUNMUN-bridge-test.docx") throw new Error(`saved as ${first.name}`);
  // (Android 5's UI Automator shows Chinese as "?", so the wording is checked where it can be read.)
  if (!/\?{3}/.test(first.text) && !first.text.includes("下载")) throw new Error(`dialog does not say Download: ${first.text}`);
  tap(await waitForNode(button("完成"), 10000, "完成 button"));
  const pulled = pull(deviceFile(first.name));
  if (!pulled.equals(BIG)) throw new Error(`Download/${first.name} is ${pulled.length} bytes, sha ${sha(pulled)}; sent ${BIG.length}, sha ${sha(BIG)}`);
  step("1.5 MB file saved to Download, byte for byte", { name: first.name });

  await saveThroughBridge("PKUNMUN-bridge-test.docx", BIG.subarray(0, 4096));
  const second = await savedDialog("second save");
  if (second.name === first.name || !/PKUNMUN-bridge-test.*\(1\)\.docx$/.test(second.name)) throw new Error(`second save named ${second.name}`);
  if (!pull(deviceFile(second.name)).equals(BIG.subarray(0, 4096))) throw new Error(`Download/${second.name} differs`);
  tap(await waitForNode(button("打开"), 10000, "打开 button"));
  // No DOCX viewer on a bare emulator: the app explains which apps to install. If an image has one, it opens.
  const opened = await waitFor(() => {
    const nodes = uiNodes();
    if (findNode(nodes, (node) => (node.text || "").includes("WPS Office"))) return "explained";
    const front = resumedActivity();
    return front && !front.startsWith(PACKAGE) ? front : null;
  }, 30000, "打开 result");
  if (opened === "explained") tap(await waitForNode(button("好"), 10000, "好 button"));
  else await backToApp("back from the viewer");
  step("duplicate name kept apart; 打开 handled", { name: second.name, open: opened });

  await saveThroughBridge("PKUNMUN-bridge-test.docx", BIG.subarray(0, 2048));
  const third = await savedDialog("third save");
  tap(await waitForNode(button("分享"), 10000, "分享 button"));
  const chooser = await waitFor(() => { const front = resumedActivity(); return front && !front.startsWith(PACKAGE) ? front : null; }, 30000, "share sheet");
  await sleep(1500);
  screencap("share-sheet");
  const offered = uiNodes().map((node) => node.text || "").filter(Boolean);
  // The app's own label ("PKUNMUN 排版"; Android 5's UI Automator shows the Chinese as "?"). The file name has no space.
  if (offered.some((text) => /^PKUNMUN (排|\?)/.test(text))) throw new Error(`the share sheet offers this app itself: ${JSON.stringify(offered)}`);
  await backToApp("back from the share sheet");
  step("分享 opens the share sheet", { name: third.name, chooser });
  return first.name;
}

// "Open with" / "share" handing the exact bytes over, read through the bridge's own calls.
async function bridgeOpens(name, bytes) {
  const capture = `window.__munwordReceive = function () {
    var bridge = window.MunwordAndroid, size = bridge.openedSize(), parts = [];
    window.__got = { name: bridge.openedName(), size: size };
    for (var offset = 0; offset < size; offset += 786432) parts.push(bridge.openedChunk(offset, 786432));
    bridge.openedDone();
    window.__got.base64 = parts.join("");
  }; window.__got = null; true`;
  for (const action of ["VIEW", "SEND"]) {
    await cdp.eval(capture);
    sendIntent(action, shareUri(name));
    await cdp.until("!!(window.__got && window.__got.base64 !== undefined)", 30000);
    const got = await cdp.eval("({ name: window.__got.name, size: window.__got.size })");
    const received = Buffer.from(await textFromPage("window.__got.base64"), "base64");
    if (got.name !== name || got.size !== bytes.length || !received.equals(bytes)) throw new Error(`${action}: page got ${got.name}, ${got.size} bytes (sha ${sha(received)})`);
    if (await cdp.eval("window.MunwordAndroid.openedName()") !== "") throw new Error(`${action}: the app kept the file after handing it over`);
    step(`${action === "VIEW" ? "open with" : "share"} into the running app hands the exact bytes over`, { name, bytes: bytes.length });
  }
}

// The page must fit the screen's width at any size and font scale.
async function fitsWidth(where) {
  const sizes = await cdp.eval("({ content: document.documentElement.scrollWidth, screen: window.innerWidth })");
  if (sizes.content > sizes.screen + 1) throw new Error(`${where}: the page is ${sizes.content}px wide on a ${sizes.screen}px screen`);
  return sizes;
}

// Android 6–9 refusing the permission: the file goes to the app's own folder, the dialog says so, it can be shared.
async function refusedStorage() {
  for (const permission of ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"]) shell(`pm revoke ${PACKAGE} android.permission.${permission}`);
  shell(`am force-stop ${PACKAGE}`); // (revoking stops the app on most versions; on the rest, this does)
  await launch();
  await connect();
  await cdp.until(`document.querySelectorAll(".typeCard").length === 8 || (document.body && document.body.innerText.indexOf("WebView）版本太旧") >= 0)`, 90000, PAGE_STATE);
  await saveThroughBridge("PKUNMUN-no-permission.docx", BIG.subarray(0, 3000));
  let tapped = false;
  await waitFor(() => {
    const nodes = uiNodes();
    if (dismissSystemDialog(nodes)) return null;
    const deny = findNode(nodes, (node) => /permission_deny(_and_dont_ask_again)?_button$/.test(node["resource-id"] || "") || /^(deny|don.t allow)$/i.test(node.text || ""));
    if (deny) { tap(deny); tapped = true; return null; }
    return tapped && resumedActivity().startsWith(PACKAGE);
  }, 60000, "storage permission prompt refused");
  const saved = await savedDialog("save without the permission");
  if (!/^content:\/\/org\.pkunmun\.formatter2026\.files\/app\//.test(saved.uri)) throw new Error(`refused, but saved to ${saved.uri}`);
  if (shell(`ls /sdcard/Download/ 2>/dev/null`).includes("PKUNMUN-no-permission")) throw new Error("refused, but the file is in Download");
  if (!/\?{3}/.test(saved.text) && !saved.text.includes("应用自己的文件夹")) throw new Error(`the dialog does not say where: ${saved.text}`);
  tap(await waitForNode(button("分享"), 10000, "分享 button"));
  const chooser = await waitFor(() => { const front = resumedActivity(); return front && !front.startsWith(PACKAGE) ? front : null; }, 30000, "share sheet");
  await backToApp("back from the share sheet");
  step("storage permission refused: saved in the app's own folder, the dialog says so, 分享 works", { uri: saved.uri, chooser });
}

// A finger's tap on a page element: its place on the page, scaled to the screen, inside the WebView's bounds.
// (The page scrolls smoothly: wait until the element has stopped moving before measuring where to tap.)
async function tapElement(selector) {
  const element = `document.querySelector(${JSON.stringify(selector)})`;
  await cdp.eval(`${element}.scrollIntoView({ block: "center", behavior: "instant" }), true`);
  const measure = `(function () { var r = ${element}.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    return { x: x, y: y, scale: window.devicePixelRatio, inside: !!hit && ${element}.contains(hit) }; })()`;
  let box = await cdp.eval(measure);
  for (let still = 0; still < 3; ) {
    await sleep(300);
    const next = await cdp.eval(measure);
    still = Math.abs(next.y - box.y) < 1 ? still + 1 : 0;
    box = next;
  }
  if (!box.inside) throw new Error(`${selector} is covered at its centre`);
  const view = findNode(uiNodes(), (node) => node.class === "android.webkit.WebView");
  const bounds = view && /\[(\d+),(\d+)\]/.exec(view.bounds);
  if (!bounds) throw new Error("the WebView is not on screen");
  await cdp.eval(`window.__taps = []; document.addEventListener("click", function (e) { window.__taps.push((e.target.className || e.target.tagName) + " @" + Math.round(e.clientX) + "," + Math.round(e.clientY)); }, true), true`);
  shell(`input tap ${Math.round(Number(bounds[1]) + box.x * box.scale)} ${Math.round(Number(bounds[2]) + box.y * box.scale)}`);
  return box;
}

// Tapping the upload area opens the system picker; cancelling it leaves the page able to open it again.
async function filePicker() {
  for (const attempt of [1, 2]) {
    await tapElement(".dropzone");
    let picker;
    try {
      picker = await waitFor(() => { const front = resumedActivity(); return front && !front.startsWith(PACKAGE) ? front : null; }, 30000, `the file picker (${attempt})`);
    } catch (error) {
      const taps = await cdp.eval("JSON.stringify(window.__taps || [])").catch(() => "?");
      throw new Error(`${error.message}; the page saw clicks: ${taps}; the app logged: ${JSON.stringify(appLog().filter((line) => /file chooser/.test(line)))}`);
    }
    if (attempt === 1) { await sleep(1500); screencap("file-picker"); }
    await backToApp(`back from the file picker (${attempt})`);
    await cdp.until("document.visibilityState === 'visible'", 20000);
    await sleep(1000);
    report.picker = picker;
  }
  if (!(await cdp.eval(`document.querySelectorAll(".typeCard").length === 8`))) throw new Error("the page changed after the picker was cancelled");
  step("file picker: tapping the upload area opens it, and cancelling leaves the page ready (twice)", { picker: report.picker });
}

// Android 8+: the page's process crashes; the app replaces the page instead of closing.
async function pageProcessCrash() {
  await cdp.send("Page.crash").catch(() => { /* the connection goes down with the page */ });
  await sleep(3000);
  await waitFor(() => resumedActivity().startsWith(PACKAGE), 20000, "the app still in front after the page crashed");
  await connect();
  await cdp.until(`document.querySelectorAll(".typeCard").length === 8`, 90000, PAGE_STATE);
  const log = appLog().join("\n");
  if (!/render process gone, crash=true/.test(log)) throw new Error("the app did not see the page process crash");
  step("crashed page process: the app stays open and loads the page again");
}

const typeCard = (type) => `[].find.call(document.querySelectorAll(".typeCard"), function (c) { return c.querySelector("b").textContent === ${JSON.stringify(type)}; })`;
const clickButton = (label) => `[].find.call(document.querySelectorAll("button"), function (b) { return b.textContent.indexOf(${JSON.stringify(label)}) >= 0; }).click(), true`;
const REVIEW = `[].some.call(document.querySelectorAll("h2"), function (h) { return h.textContent === "确认识别结果"; })`;

// One document through the page, from recognition to the file in Download.
async function recognizeAndGenerate(input, { rotate = false, background = false } = {}) {
  await cdp.eval(clickButton("识别文件结构"));
  await cdp.until(`${REVIEW} || !!document.querySelector(".errorBox")`, 90000, PAGE_STATE);
  const error = await cdp.eval(`(document.querySelector(".errorBox") || {}).textContent || ""`);
  if (error) throw new Error(`${input}: ${error}`);
  if (!(await cdp.eval(`document.querySelectorAll(".reviewSection input").length`))) throw new Error(`${input}: step 03 has no editable fields`);
  if (input.startsWith("07") || input.startsWith("01")) screencap(`review-${input}`);
  await fitsWidth(`${input} review`);
  if (rotate) {
    shell("settings put system accelerometer_rotation 0");
    shell("settings put system user_rotation 1");
    await cdp.until("window.innerWidth > window.innerHeight", 20000);
    await sleep(1000);
    screencap(`landscape-${input}`);
    if (!(await cdp.eval(REVIEW))) throw new Error("rotating lost the recognized document");
    shell("settings put system user_rotation 0");
    await cdp.until("window.innerWidth < window.innerHeight", 20000);
    if (!(await cdp.eval(REVIEW))) throw new Error("rotating back lost the recognized document");
    step("rotation keeps the work", { input });
  }
  if (background) {
    shell("input keyevent 4");
    await waitFor(() => !resumedActivity().startsWith(PACKAGE), 20000, "Back leaving the app");
    await launch();
    if (!(await cdp.eval(REVIEW))) throw new Error("leaving with Back lost the recognized document");
    step("Back leaves the app and keeps the work", { input });
  }
  await cdp.eval(clickButton("生成并下载 DOCX"));
  const saved = await savedDialog(input);
  tap(await waitForNode(button("完成"), 10000, "完成 button"));
  const docx = pull(deviceFile(saved.name));
  const expected = path.join(reference, `${input}.docx`);
  const difference = existsSync(expected) ? sameParts(docx, readFileSync(expected)) : "no reference output";
  if (difference) throw new Error(`${input}: ${saved.name} ${difference}`);
  return { input, saved: saved.name, bytes: docx.length };
}

async function appFlows() {
  report.flexGapFallback = await cdp.eval(`document.documentElement.className.indexOf("no-flex-gap") >= 0`);
  report.width = await fitsWidth("start page");
  await filePicker();
  for (const [index, [type, input]] of CASES.entries()) {
    await cdp.eval("location.reload(), true");
    await sleep(500);
    await cdp.until(`document.querySelectorAll(".typeCard").length === 8`, 60000, PAGE_STATE);
    // As a user does: the type first, then the file (what the system file picker hands the page).
    await cdp.eval(`${typeCard(type)}.click(), true`);
    const bytes = readFileSync(path.join(ROOT, "examples", "acceptance-inputs", `${input}.docx`));
    const data = await bytesInPage(bytes);
    await cdp.eval(`(function () {
      var data = ${data};
      var transfer = new DataTransfer(), input = document.querySelector('input[type="file"]');
      transfer.items.add(new File([data], ${JSON.stringify(input + ".docx")}, { type: ${JSON.stringify(DOCX)} }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await cdp.until(`!!document.querySelector(".dropzone.hasFile") && document.querySelector(".dropzone h3").textContent === ${JSON.stringify(input + ".docx")}`, 20000, PAGE_STATE);
    if (index === 0) screencap("file-chosen");
    const result = await recognizeAndGenerate(input, { rotate: input.startsWith("07"), background: input.startsWith("08") });
    report.cases.push(result);
    step(`${input}: recognized, step 03 editable, saved to Download with the reference's parts`, { saved: result.saved });
  }
  const outside = await cdp.eval(`(performance.getEntriesByType("resource") || []).map(function (e) { return e.name; }).filter(function (n) { return n.indexOf("file:///android_asset/site/") !== 0 && n.indexOf("blob:") !== 0 && n.indexOf("data:") !== 0; })`);
  if (outside.length) throw new Error(`the page loaded ${outside.join(", ")}`);
  step("nothing loaded from outside the app");

  // "Open with" from a cold start: the app starts with the document; it stays through the type choice. The
  // documents are first put in Download by the app itself (under their own names), as another app would hold them.
  const documents = {};
  for (const input of ["07_中文决议草案", "08_English_Draft_Resolution"]) {
    const bytes = readFileSync(path.join(ROOT, "examples", "acceptance-inputs", `${input}.docx`));
    await saveThroughBridge(`${input}.docx`, bytes);
    const kept = await savedDialog(`${input} to open`);
    // A draft resolution's output keeps the uploaded name, so the run above already put one under this name
    // in Download: the system numbers the copy ("… (1).docx").
    if (!new RegExp(`^${input}(?: \\(\\d+\\))?\\.docx$`).test(kept.name)) throw new Error(`${input} kept as ${kept.name}`);
    tap(await waitForNode(button("完成"), 10000, "完成 button"));
    documents[input] = { name: kept.name, bytes };
  }
  // The page keeps the chosen file in its own state and clears its input, so the size it shows is what it holds.
  const arrived = async (name, size) => {
    await cdp.until(`!!document.querySelector(".dropzone.hasFile") && document.querySelector(".dropzone h3").textContent === ${JSON.stringify(name)}`, 60000, PAGE_STATE);
    const shown = await cdp.eval(`document.querySelector(".dropzone.hasFile p").textContent`);
    if (!shown.startsWith(`${(size / 1024).toFixed(1)} KB`)) throw new Error(`${name}: the page shows "${shown}", the file is ${size} bytes`);
  };
  const resolution = `!!document.querySelector(".typeCard.selected") && document.querySelector(".typeCard.selected b").textContent === "决议草案"`;
  shell(`am force-stop ${PACKAGE}`);
  sendIntent("VIEW", shareUri(documents["07_中文决议草案"].name));
  await connect();
  await arrived(documents["07_中文决议草案"].name, documents["07_中文决议草案"].bytes.length);
  screencap("opened-with");
  await cdp.eval(`${typeCard("决议草案")}.click(), true`);
  await cdp.until(resolution, 20000, PAGE_STATE);
  await arrived(documents["07_中文决议草案"].name, documents["07_中文决议草案"].bytes.length);
  const opened = await recognizeAndGenerate("07_中文决议草案");
  step("open with (cold start): the document arrives, stays through the type choice, formats like the reference", { saved: opened.saved });

  // "Share" into the running app replaces the document, as choosing another file does.
  sendIntent("SEND", shareUri(documents["08_English_Draft_Resolution"].name));
  await arrived(documents["08_English_Draft_Resolution"].name, documents["08_English_Draft_Resolution"].bytes.length);
  if (!(await cdp.eval(resolution))) throw new Error("share changed the document type");
  const shared = await recognizeAndGenerate("08_English_Draft_Resolution");
  step("share into the running app: the document arrives and formats like the reference", { saved: shared.saved });
}

async function main() {
  report.device = {
    sdk, release: shell("getprop ro.build.version.release").trim(), abi: shell("getprop ro.product.cpu.abi").trim(),
    model: shell("getprop ro.product.model").trim(),
  };
  console.log(`Android ${report.device.release} (API ${sdk}, ${report.device.abi})`);
  if (PROFILE === "tablet") { shell("wm size 1200x1920"); shell("wm density 240"); }
  if (PROFILE === "large-dark") {
    shell("settings put system font_scale 1.3");
    try { shell("cmd uimode night yes"); } catch { /* Android 10+ only */ }
  }
  if (PROFILE) { report.profile = PROFILE; await sleep(3000); }
  shell("input keyevent 82"); // wake and unlock
  for (const command of ["wm dismiss-keyguard", "locksettings set-disabled true"]) { try { shell(command); } catch { /* not on this version */ } }
  if (PREVIOUS_APK && existsSync(PREVIOUS_APK)) {
    adb(["install", PREVIOUS_APK]);
    report.previous = { versionCode: Number(/versionCode=(\d+)/.exec(shell(`dumpsys package ${PACKAGE}`))?.[1]) };
  }
  adb(["install", "-r", apk]);
  const installed = shell(`dumpsys package ${PACKAGE}`);
  report.installed = { versionName: /versionName=(\S+)/.exec(installed)?.[1], versionCode: /versionCode=(\d+)/.exec(installed)?.[1] };
  if (/android\.permission\.INTERNET/.test(installed)) throw new Error("the app holds the INTERNET permission");
  if (report.previous) {
    if (!(Number(report.installed.versionCode) >= report.previous.versionCode)) throw new Error(`version ${report.installed.versionCode} installed over ${report.previous.versionCode}`);
    step("installed over the APK released before (same signing key)", { from: report.previous.versionCode, to: Number(report.installed.versionCode) });
  }
  step("installed", report.installed);
  shell("setprop debug.munword.devtools 1");
  if (PROMPT_UNUSABLE) {
    for (const permission of ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"]) shell(`pm grant ${PACKAGE} android.permission.${permission}`);
    step("storage permission granted from adb (this image's System UI crashes on the permission screen; the prompt is checked on Android 6.0 and 9)");
  }
  shell("rm -f /sdcard/Download/*.docx");
  await launch();
  await connect();
  await cdp.until(`document.querySelectorAll(".typeCard").length === 8 || (document.body && document.body.innerText.indexOf("WebView）版本太旧") >= 0)`, 90000, PAGE_STATE);
  report.userAgent = await cdp.eval("navigator.userAgent");
  report.webview = Number((/Chrome\/(\d+)/.exec(report.userAgent) || [])[1]);
  report.mode = await cdp.eval(`document.querySelectorAll(".typeCard").length === 8 ? "app" : "notice"`);
  const expected = report.webview >= FLOOR ? "app" : "notice";
  screencap(`start-${report.mode}`);
  if (report.mode !== expected) throw new Error(`WebView ${report.webview} shows the ${report.mode}, expected the ${expected}`);
  if (report.mode === "notice" && (await cdp.eval(`[].some.call(document.scripts, function (s) { return /app\\.js$/.test(s.src); })`))) throw new Error("app.js loaded below the floor");
  step(`WebView ${report.webview}: ${report.mode === "app" ? "the app runs" : "the update notice shows"}`, { userAgent: report.userAgent });

  report.width = await fitsWidth(report.mode === "app" ? "start page" : "update notice");

  const bridgeFile = await bridgeSaves();
  await bridgeOpens(bridgeFile, BIG);
  if (report.mode === "app") await appFlows();
  if (report.mode === "app" && sdk >= 26) await pageProcessCrash();
  if (sdk >= 23 && sdk <= 28 && !PROMPT_UNUSABLE) await refusedStorage();

  let crashes = "";
  try { crashes = shell("logcat -d -b crash"); } catch { crashes = shell("logcat -d -s AndroidRuntime:E"); }
  // The app's own process (a Java or a native crash); the page process crashed on purpose above is the WebView's.
  if (/Process: org\.pkunmun\.formatter2026\b|>>> org\.pkunmun\.formatter2026 <<</.test(crashes)) throw new Error(`the app crashed:\n${crashes}`);
  step("no crash in the log");
  report.passed = true;
}

// What the phone shows and logged, printed into the CI log (the evidence files may not be reachable).
async function diagnose() {
  try {
    const nodes = uiNodes();
    console.log(`  · in front: ${resumedActivity() || "?"}`);
    console.log(`  · on screen: ${JSON.stringify(nodes.filter((node) => node.text).map((node) => node.text.slice(0, 120)).slice(0, 40))}`);
    console.log(`  · uiautomator: ${lastDump.slice(0, 300)}`);
    if (cdp) console.log(`  · page: ${await cdp.eval(`JSON.stringify({ bridge: typeof window.MunwordAndroid, begin: typeof (window.MunwordAndroid || {}).begin, status: window.__munwordBridge || null, title: document.title })`).catch((error) => String(error))}`);
    // The app's own lines (and the system's about it) apart from the rest of the system's noise.
    const log = adb(["logcat", "-d", "-v", "brief", "Munword:V", "AndroidRuntime:E", "ActivityTaskManager:I", "ActivityManager:I", "chromium:W", "*:S"]).replace(/\r/g, "").trim().split("\n");
    const ours = log.filter((line) => /^[A-Z]\/(Munword|chromium)\b/.test(line) || line.includes(PACKAGE) || (appPid && new RegExp(`\\(\\s*${appPid}\\)`).test(line)));
    console.log(`  · app log (last ${Math.min(ours.length, 50)} lines):\n${ours.slice(-50).map((line) => "      " + line).join("\n")}`);
    console.log(`  · system log (last 15 lines):\n${log.slice(-15).map((line) => "      " + line).join("\n")}`);
  } catch (error) {
    console.log(`  · diagnosis failed: ${error.message}`);
  }
}

try {
  await main();
} catch (error) {
  report.error = String(error.stack || error);
  console.log(`FAILED: ${report.error}`);
  screencap("failed");
  await diagnose();
} finally {
  cdp?.close();
  try { writeFileSync(path.join(out, "logcat.txt"), adb(["logcat", "-d", "-v", "time", "Munword:V", "chromium:V", "AndroidRuntime:E", "ActivityManager:I", "*:S"])); } catch { /* no log */ }
  writeFileSync(path.join(out, "emulator.json"), JSON.stringify(report, null, 2));
  console.log(report.passed ? `PASSED: Android API ${sdk}, WebView ${report.webview} (${report.mode})` : "FAILED");
  process.exitCode = report.passed ? 0 : 1;
}
