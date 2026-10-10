// The loader that starts the page's program only in a browser new enough for it, shared by the website (and the
// local Python page), which loads /app.js, and the desktop apps, which load app.js from beside the page under
// file://. Each passes its own wording for a program file that fails to load; the browser check and the
// outdated-browser explanation are the same. (The Android page has its own loader: its floor is WebView 69,
// reached with polyfills, android/build-site.mjs.)
//
// Oldest browsers that run the bundle and its styles: Array.prototype.findLast (Chrome/Edge 97, Safari 15.4,
// Firefox 104) and CSS cascade layers (Chrome/Edge 99, Safari 15.4, Firefox 97). An older browser (IE, Chrome
// on an unpatched Windows 7, Safari on macOS 10.14) would show a blank or unstyled page, so this ES3 loader
// explains which browser to install instead of loading the program.
export const OUTDATED_BROWSER_MESSAGE = "这个浏览器版本太旧，无法运行排版系统。";

export function compatLoader({ src, missing, reopen }) {
  return `<script>
    (function () {
      var root = document.getElementById("root");
      var box = '<div style="max-width:560px;margin:48px auto;padding:24px 28px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#1d2939;font:15px/1.75 sans-serif">';
      if (typeof Array.prototype.findLast === "function" && typeof window.CSSLayerBlockRule !== "undefined") {
        var script = document.createElement("script");
        script.src = "${src}";
        script.onerror = function () {
          root.innerHTML = box + "${missing}</div>";
        };
        document.body.appendChild(script);
        return;
      }
      root.innerHTML = box + "<b>${OUTDATED_BROWSER_MESSAGE}</b><br>" +
        "请安装或更新以下任一浏览器，${reopen}：<br>" +
        "· Windows 10 / 11：Microsoft Edge 或 Google Chrome 最新版<br>" +
        "· Windows 7 / 8.1：Google Chrome 109 或 Firefox ESR 115<br>" +
        "· macOS 10.15 及以上：系统更新后的 Safari（15.4 或更高）<br>" +
        "· macOS 10.11–10.14：Google Chrome 或 Firefox</div>";
    })();
  </script>`;
}

// The website's copy, written into local_web/index.html (tests/desktop.test.mjs checks that it matches).
export const WEB_LOADER = compatLoader({
  src: "/app.js",
  missing: "<b>页面的程序文件没有加载成功。</b><br>请刷新页面再试；网络不稳定时，可以改用离线安装包（断网也能用）。",
  reopen: "然后重新打开本网页（排版在浏览器里完成，文件不会上传）",
});

// The desktop apps' copy (desktop/build-desktop.mjs puts it in place of the website's).
export const DESKTOP_LOADER = compatLoader({
  src: "app.js",
  missing: "<b>程序文件不完整。</b><br>请重新运行安装程序（macOS 请重新把程序拖进「应用程序」）。",
  reopen: "然后重新打开本程序（程序本身不联网，排版仍在本机完成）",
});
