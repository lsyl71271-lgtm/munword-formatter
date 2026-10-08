// The page inside the Android app: the same interface and engine as the website and the desktop apps, compiled
// for older Android WebViews (Chromium 69, Android 9's original WebView; Android 5 got WebView updates up to 95).
//
//   node android/build-site.mjs        → dist/android/site/
//
// - app.js: local_web/main.tsx bundled by esbuild exactly as scripts/build-local-tools.mjs does, but with
//   target chrome69 (esbuild lowers the syntax), with android/polyfills.js (the missing built-ins) and
//   android/flex-gap.js (flex gap before Chromium 84) in front.
// - styles.css: the shared stylesheet (public/local-styles.css, checked against its build record) made safe for
//   engines without cascade layers, :where()/:is() or ::file-selector-button (legacyCss below).
// - index.html: android/bridge.js (save to Downloads, open-with) and an ES5 loader that starts the app only in a
//   WebView with Chromium 69's built-ins, and otherwise explains how to update the WebView.
// Requires pnpm build:local-tools first (the shared stylesheet and license files).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "android", "site");
const VERSION = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const ANDROID_CSP = "connect-src 'none'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
export const OUTDATED_WEBVIEW_MESSAGE = "手机的网页组件（WebView）版本太旧，无法运行排版系统。";

// Older engines miss a few CSS features the shared stylesheet uses; each gets a fallback that leaves current
// engines exactly as they were:
// - cascade layers (Chromium 99): an engine that does not know them drops the whole @layer block. Layers are
//   unwrapped in place; the page's own rules are unlayered and come after them, so they still win.
// - :where()/:is(), ::file-selector-button, :focus-visible (88–89): one unknown selector drops the whole rule, and
//   Tailwind's reset lists ::file-selector-button beside *. Such selector lists become one rule per selector.
// - inset (87), margin-inline / padding-inline (87), clamp() / min() / max() (79), overflow-wrap: anywhere (80):
//   a plain declaration in front of each.
// - start / end alignment in flex containers (93): flex-start / flex-end.
// Gap in flex containers (84) cannot be rewritten as CSS that matches it (text beside an element, hidden children
// and a child's own margins all need the rendered page): android/flex-gap.js supplies it at run time instead.
export function legacyCss(css, postcss) {
  const root = postcss.parse(css);
  root.walkAtRules("layer", (rule) => {
    if (rule.nodes) rule.replaceWith(rule.nodes);
    else rule.remove();
  });
  const risky = /:where\(|:is\(|::file-selector-button|::backdrop|:focus-visible|::marker|:has\(/;
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    if (rule.selectors.length > 1 && risky.test(rule.selector)) {
      for (const selector of [...rule.selectors].reverse()) rule.cloneAfter({ selector });
      rule.remove();
    }
  });
  const lastArgument = (value) => {
    const inner = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
    let depth = 0, start = 0, last = inner;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "(") depth++;
      else if (inner[i] === ")") depth--;
      else if (inner[i] === "," && depth === 0) { last = inner.slice(i + 1); start = i + 1; }
    }
    return (start ? last : inner).trim();
  };
  root.walkDecls((decl) => {
    const value = decl.value.trim();
    if (decl.prop === "inset" && !/\s/.test(value)) {
      for (const side of ["top", "right", "bottom", "left"]) decl.cloneBefore({ prop: side });
    }
    const logical = /^(margin|padding)-inline$/.exec(decl.prop);
    if (logical) {
      const [start, end = start] = value.split(/\s+/);
      decl.cloneBefore({ prop: `${logical[1]}-left`, value: start });
      decl.cloneBefore({ prop: `${logical[1]}-right`, value: end });
    }
    const clamp = /^clamp\(\s*([^,]+),/.exec(value);
    if (clamp) decl.cloneBefore({ value: clamp[1].trim() });
    if (/^(min|max)\(/.test(value)) decl.cloneBefore({ value: lastArgument(value) });
    if (decl.prop === "overflow-wrap" && value === "anywhere") decl.cloneBefore({ prop: "word-wrap", value: "break-word" });
    // Older engines accept start / end but lay flex items out as if they were the default, so they are replaced:
    // flex-start / flex-end mean the same in a grid, and in a flex container that is not reversed.
    if (/^(justify-content|align-items|align-self|align-content)$/.test(decl.prop) && /^(start|end)$/.test(value)) {
      if (/reverse/.test(css)) throw new Error("the stylesheet reverses a flex container: start / end alignment needs another fallback");
      decl.value = `flex-${value}`;
    }
  });
  return root.toString();
}

// ES5, so even a WebView far too old for the app runs it and shows the notice instead of a blank screen.
const LOADER = `<script>
    (function () {
      var root = document.getElementById("root");
      var box = '<div style="padding:32px 16px"><div style="max-width:560px;margin:0 auto;padding:20px 22px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#1d2939;font:15px/1.75 sans-serif">';
      // Flex gap (Chromium 84): without it, styles.css spaces flex children with margins under html.no-flex-gap.
      var probe = document.createElement("div");
      probe.style.cssText = "display:flex;flex-direction:column;row-gap:1px;position:absolute";
      probe.appendChild(document.createElement("div"));
      probe.appendChild(document.createElement("div"));
      document.body.appendChild(probe);
      if (probe.scrollHeight !== 1) document.documentElement.className += " no-flex-gap";
      document.body.removeChild(probe);
      if (typeof [].flat === "function" && window.CSS && CSS.supports && CSS.supports("display", "grid") && typeof TextDecoder === "function") {
        var script = document.createElement("script");
        script.src = "app.js";
        script.onerror = function () {
          root.innerHTML = box + "<b>程序文件不完整。</b><br>请重新安装本应用。</div></div>";
        };
        document.body.appendChild(script);
        return;
      }
      var match = /Chrome\\/(\\d+)/.exec(navigator.userAgent);
      root.innerHTML = box + "<b>${OUTDATED_WEBVIEW_MESSAGE}</b><br>" +
        (match ? "当前版本：" + match[1] + "，需要 69 或更高。<br>" : "") +
        "请打开手机自带的应用商店，搜索并更新「Android System WebView」（有的手机叫「系统 WebView」「Chrome」或「浏览器内核」），然后重新打开本应用。<br>" +
        "暂时无法更新时，可以改用网页版或电脑版（文件同样只在本机处理）。</div></div>";
    })();
  </script>`;

// Selectors with an "auto" margin, which android/flex-gap.js must leave alone.
export function autoMarginSelectors(css, postcss) {
  const selectors = new Set();
  postcss.parse(css).walkDecls(/^margin/, (decl) => {
    if (/\bauto\b/.test(decl.value) && decl.parent.type === "rule") {
      for (const selector of decl.parent.selectors) if (!selector.includes("::")) selectors.add(selector);
    }
  });
  return [...selectors];
}

export function androidIndex(bridge) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${ANDROID_CSP}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PKUNMUN 2026 文件自动排版系统</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="root"><p>正在加载 PKUNMUN 2026 排版系统…</p></div>
  <noscript>请启用 JavaScript。手机版与网页版使用同一界面，文件只在本机处理。</noscript>
  <script>
${bridge.trim()}
  </script>
  ${LOADER}
</body>
</html>
`;
}

export async function buildAndroidSite(out = OUT) {
  const provenance = JSON.parse(readFileSync(path.join(ROOT, "public", "local-build.json"), "utf8"));
  if (provenance.version !== VERSION) throw new Error(`public/local-build.json is ${provenance.version}, VERSION is ${VERSION}: run pnpm build:local-tools`);
  const sharedCss = readFileSync(path.join(ROOT, "public", "local-styles.css"));
  if (sha256(sharedCss) !== provenance.assets["public/local-styles.css"]) throw new Error("public/local-styles.css does not match its build record: run pnpm build:local-tools");
  const bundle = await build({
    entryPoints: [path.join(ROOT, "local_web", "main.tsx")], bundle: true, minify: true, write: false, charset: "utf8", format: "iife",
    platform: "browser", target: ["chrome69"], jsx: "automatic", legalComments: "inline",
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' },
  });
  const requirePostcss = createRequire(import.meta.resolve("@tailwindcss/postcss"));
  const postcss = requirePostcss("postcss");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const flexGap = readFileSync(path.join(ROOT, "android", "flex-gap.js"), "utf8");
  if (!flexGap.includes("/*AUTO_MARGIN_SELECTORS*/[]")) throw new Error("android/flex-gap.js has lost its selector placeholder");
  const files = {
    "app.js": [
      readFileSync(path.join(ROOT, "android", "polyfills.js"), "utf8"),
      flexGap.replace("/*AUTO_MARGIN_SELECTORS*/[]", JSON.stringify(autoMarginSelectors(sharedCss.toString("utf8"), postcss))),
      bundle.outputFiles[0].text,
    ].join("\n"),
    "styles.css": legacyCss(sharedCss.toString("utf8"), postcss),
    "index.html": androidIndex(readFileSync(path.join(ROOT, "android", "bridge.js"), "utf8")),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(out, name), text);
  cpSync(path.join(ROOT, "public", "favicon.svg"), path.join(out, "favicon.svg"));
  cpSync(path.join(ROOT, "public", "licenses"), path.join(out, "licenses"), { recursive: true });
  const assets = Object.fromEntries(["app.js", "styles.css", "index.html", "favicon.svg"].map((name) => [name, sha256(readFileSync(path.join(out, name)))]));
  writeFileSync(path.join(out, "version.json"), JSON.stringify({ version: VERSION, kind: "android", target: "chrome69", assets }, null, 2) + "\n");
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildAndroidSite();
  console.log(`Android page ${VERSION}: ${out}`);
}
