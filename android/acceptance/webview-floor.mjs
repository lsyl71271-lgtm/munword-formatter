// The Android page (dist/android/site) in old Chromium builds, standing in for old Android WebViews.
// For each build: phone-sized viewport, a stand-in for the activity's window.MunwordAndroid bridge, then every
// acceptance input through the whole flow. The file arrives the way "open with" delivers it (the bridge's
// __munwordReceive → the page's own file input). Recognize, check step 03 is there and editable (never filled in),
// generate; the bridge must receive a DOCX whose parts are identical to the shared page's output in current Chromium.
// A build below the floor must show the update notice and never load app.js.
//
//   node android/acceptance/webview-floor.mjs <site dir> <reference dir> <out dir> [<milestone>=<chrome binary or snapshot position>...]
//
// Without builds it uses BUILDS below, downloading each Chromium snapshot (Linux x64) into <out dir>/chromium, plus
// the current Chromium given by MUNWORD_CHROMIUM_EXECUTABLE when set. The reference dir holds the shared page's
// outputs in current Chromium (desktop/offline-smoke.mjs writes them to output/desktop-smoke).
// Uses only the DevTools protocol over Node's built-in WebSocket (./cdp.mjs), so it works with Chromium 66 as well as today's.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { Cdp, PAGE_STATE } from "./cdp.mjs";

const [site, reference, out, ...given] = process.argv.slice(2);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FLOOR = 69;
// Below the floor; the floor (Android 9's first WebView); before flex gap (84), clamp()/min() (79) and :is()/inset
// (87–88); the last for Android 5–6 (95); cascade layers (99); the last for Windows 7 (109).
const BUILDS = [[67, 550422], [69, 576753], [79, 706915], [83, 756066], [88, 827102], [95, 920005], [99, 961612], [109, 1070002]];
const builds = given.length ? given : [
  ...BUILDS.map(([milestone, position]) => `${milestone}=${position}`),
  ...(process.env.MUNWORD_CHROMIUM_EXECUTABLE ? [`current=${process.env.MUNWORD_CHROMIUM_EXECUTABLE}`] : []),
];
function chromiumBinary(value) {
  if (!/^\d+$/.test(value)) return value;
  const dir = path.join(out, "chromium", value), binary = path.join(dir, "chrome-linux", "chrome");
  if (!existsSync(binary)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("curl", ["-sSfL", "--retry", "3", "-o", path.join(dir, "chrome-linux.zip"), `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${value}/chrome-linux.zip`]);
    execFileSync("unzip", ["-q", "-o", "chrome-linux.zip"], { cwd: dir });
  }
  return binary;
}
const CASES = [
  ["立场文件", "01_中文立场文件"], ["立场文件", "02_English_Position_Paper"], ["工作文件", "03_中文工作文件"],
  ["工作文件", "04_English_Working_Paper"], ["指令草案", "05_中文指令草案"], ["指令草案", "06_English_Draft_Directive"],
  ["决议草案", "07_中文决议草案"], ["决议草案", "08_English_Draft_Resolution"], ["友好修正案", "09_中文友好修正案"],
  ["非友好修正案", "10_中文非友好修正案"], ["友好修正案", "11_English_Amendment"],
  ["外交协定", "12_中文外交协定"], ["联合声明", "13_中文联合声明"], ["联合声明", "14_English_Joint_Statement"],
];
mkdirSync(out, { recursive: true });

// The activity's JavaScript interface, recorded instead of saved.
const FAKE_BRIDGE = `(() => {
  const saves = {}; let next = 1;
  window.__saved = [];
  window.MunwordAndroid = {
    begin(name, mime, size) { const id = next++; saves[id] = { name, mime, size, data: "" }; return id; },
    append(id, chunk) { saves[id].data += chunk; },
    finish(id) { window.__saved.push(saves[id]); delete saves[id]; },
    failed(name, message) { window.__saved.push({ name, error: message }); },
    openedName() { return window.__opened ? window.__opened.name : ""; },
    openedSize() { return window.__opened.size; },
    openedChunk(offset, length) { return btoa(window.__opened.binary.slice(offset, offset + length)); },
    openedDone() { window.__opened = null; },
  };
})();`;

const parts = (bytes) => unzipSync(bytes);
const sameParts = (a, b) => {
  const left = parts(a), right = parts(b);
  const names = Object.keys(left).sort();
  if (names.join("|") !== Object.keys(right).sort().join("|")) return `part list differs`;
  const differing = names.filter((name) => Buffer.compare(Buffer.from(left[name]), Buffer.from(right[name])) !== 0);
  return differing.length ? `parts differ: ${differing.join(", ")}` : "";
};

const results = [];
let failed = false;
for (const [index, spec] of builds.entries()) {
  const label = spec.split("=")[0];
  const binary = chromiumBinary(spec.slice(spec.indexOf("=") + 1));
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  const milestone = label === "current" ? Number(/(\d+)\./.exec(version)[1]) : Number(label);
  const port = 9700 + index;
  const profile = path.join(out, "chromium", `profile-${milestone}`); // out/chromium: downloads and profiles, not evidence
  const child = spawn(binary, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore", env: { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" } });
  const result = { milestone, version, expect: milestone >= FLOOR ? "flow" : "notice", cases: [], errors: [] };
  try {
    const cdp = await Cdp.open(port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_BRIDGE });
    const url = pathToFileURL(path.join(site, "index.html")).href;
    if (result.expect === "notice") {
      await cdp.send("Page.navigate", { url });
      await cdp.until(`document.body && document.body.innerText.includes("WebView）版本太旧")`, 30000);
      result.userAgent = await cdp.eval("navigator.userAgent");
      result.appLoaded = await cdp.eval(`[].some.call(document.scripts, s => /app\\.js$/.test(s.src))`);
      if (result.appLoaded) throw new Error("app.js was loaded below the floor");
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(out, `m${milestone}-notice.png`), Buffer.from(shot.data, "base64"));
    } else {
      for (const [type, input] of CASES) {
        await cdp.send("Page.navigate", { url });
        await cdp.until(`document.querySelectorAll(".typeCard").length === 8`, 60000, PAGE_STATE);
        result.userAgent ??= await cdp.eval("navigator.userAgent");
        const bytes = readFileSync(path.join(ROOT, "examples", "acceptance-inputs", `${input}.docx`));
        // As "open with" does: the file arrives first, then the user picks the document type; the file must stay.
        await cdp.eval(`(() => {
          window.__opened = { name: ${JSON.stringify(input + ".docx")}, size: ${bytes.length}, binary: atob(${JSON.stringify(bytes.toString("base64"))}) };
          window.__munwordReceive();
          return true;
        })()`);
        await cdp.until(`document.querySelector(".dropzone.hasFile") !== null`, 15000, PAGE_STATE);
        await cdp.eval(`[...document.querySelectorAll(".typeCard")].find(c => c.querySelector("b").textContent === ${JSON.stringify(type)}).click(), true`);
        await cdp.until(`(() => { const card = document.querySelector(".typeCard.selected"); return !!card && card.querySelector("b").textContent === ${JSON.stringify(type)} && !!document.querySelector(".dropzone.hasFile") && document.querySelector(".dropzone h3").textContent === ${JSON.stringify(input + ".docx")}; })()`, 15000, PAGE_STATE);
        await cdp.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("识别文件结构")).click(), true`);
        await cdp.until(`[...document.querySelectorAll("h2")].some(h => h.textContent === "确认识别结果") || !!document.querySelector(".errorBox")`, 60000, PAGE_STATE);
        const error = await cdp.eval(`(document.querySelector(".errorBox") || {}).textContent || ""`);
        if (error) throw new Error(`${input}: ${error}`);
        // Step 03 stays the user's: present and editable, never filled in by this test.
        if (!(await cdp.eval(`document.querySelectorAll(".reviewSection input").length`))) throw new Error(`${input}: step 03 has no editable fields`);
        if (input.startsWith("07") || (input.startsWith("01") && milestone === FLOOR)) {
          const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(path.join(out, `m${milestone}-${input}-review.png`), Buffer.from(shot.data, "base64"));
        }
        await cdp.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("生成并下载 DOCX")).click(), true`);
        await cdp.until(`window.__saved.length > 0 || !!document.querySelector(".errorBox")`, 60000, PAGE_STATE);
        const saved = await cdp.eval(`window.__saved[0] || null`);
        if (!saved || saved.error) throw new Error(`${input}: ${saved ? saved.error : await cdp.eval(`document.querySelector(".errorBox").textContent`)}`);
        const docx = Buffer.from(saved.data, "base64");
        if (docx.length !== saved.size) throw new Error(`${input}: bridge received ${docx.length} of ${saved.size} bytes`);
        writeFileSync(path.join(out, `m${milestone}-${input}.docx`), docx);
        const difference = sameParts(new Uint8Array(docx), new Uint8Array(readFileSync(path.join(reference, `${input}.docx`))));
        if (difference) throw new Error(`${input}: output differs from the shared page in current Chromium (${difference})`);
        result.cases.push({ input, name: saved.name, bytes: docx.length });
      }
    }
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.errors.push(String(error.message || error));
    failed = true;
  } finally {
    child.kill("SIGKILL");
  }
  console.log(`Chromium ${milestone}: ${result.passed ? "passed" : "FAILED"} (${result.expect}${result.cases.length ? `, ${result.cases.length} documents` : ""})${result.errors.length ? " " + result.errors.join("; ") : ""}`);
  results.push(result);
}
writeFileSync(path.join(out, "webview-floor.json"), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
